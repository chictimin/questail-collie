/**
 * 오프라인 드라이런 하네스 (워커 B).
 *
 * 계약 '드라이런 하네스 스펙' + v3(게임명 정규화) 구현이다.
 * - 기본 실행(`npx tsx src/dryrun.ts`): `data/classify_cache.json`에서 ClassifyResult를
 *   복원해 `routeQuestion`에 넘긴다. LLM을 한 번도 부르지 않는다 — 라우터만 잰다.
 *   분류기가 틀린 문항은 캐시에도 틀린 채로 들어가 드라이런에 그대로 드러난다.
 * - 캐시 생성(`npx tsx src/dryrun.ts --refresh-classify`): classify 30회(LLM)로
 *   캐시를 만든다. 이때만 LLM을 부른다. 라우터는 안 돈다.
 * - 출력: 총점 N/27, 카테고리별 집계, 틀린 문항별 기대 vs 실제 한 줄씩.
 *   틀린 문항이 있으면 exit 1.
 *
 * 주의 1: `src/nodes/router.ts`는 워커 A 소유다. 이 파일은 계약의 시그니처에 맞춰
 *   쓰고 로직을 복제하지 않는다.
 * 주의 2: 채점 규칙은 `src/evaluate.ts`의 `toolScoreFor`를 import해서 쓴다.
 *   evaluate.ts에는 entry 가드(IS_ENTRY)가 있어 import만으로는 본측정이 돌지 않는다.
 * 주의 3: 캐시 키는 문항 id가 아니라 질문 문자열이다. 질문이 바뀌면 해당 키가
 *   없어져 에러가 나고, `--refresh-classify`로 다시 뽑는다.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDeps } from './context.js';
import { toolScoreFor } from './evaluate.js';
import { classifyQuestion } from './nodes/classify.js';
import { routeQuestion } from './nodes/router.js';
import { CATEGORIES, type ClassifyResult, type QueryCategory, type ToolName } from './types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_PATH = join(ROOT, 'data', 'classify_cache.json');

/** 계약 ToolName union (9 + escalate). types.ts 갱신 전에도 파싱된다. */
const CONTRACT_TOOLS: readonly string[] = [
  'lookup_library',
  'get_game_note',
  'get_taste_profile',
  'search_docs',
  'get_achievement_stats',
  'get_wishlist',
  'find_rating_playtime_gaps',
  'get_field_coverage',
  'describe_schema',
  'escalate',
];

function isToolName(value: string): value is ToolName {
  return CONTRACT_TOOLS.includes(value);
}

function assertTool(value: string, qaId: string): ToolName {
  if (!isToolName(value)) throw new Error(`[dryrun] ${qaId}: 알 수 없는 도구명 "${value}"`);
  return value;
}

/** JSON 배열 셀 우선, 아니면 '|' (또는 ';') 구분 폴백 (evaluate.ts의 parseTools와 같은 순서). */
function parseTools(cell: string, qaId: string): ToolName[] {
  const t = cell.trim();
  if (t === '') return [];
  try {
    const v: unknown = JSON.parse(t);
    if (Array.isArray(v)) return v.map((s) => assertTool(String(s), qaId));
  } catch {
    /* 폴백으로 내려간다 */
  }
  return t
    .split(/[|;]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => assertTool(s, qaId));
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      continue;
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

function isCategory(v: unknown): v is QueryCategory {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
}

interface DryItem {
  qaId: string;
  category: QueryCategory;
  split: string;
  question: string;
  expected: ToolName[];
}

async function loadItems(path: string): Promise<DryItem[]> {
  const text = await readFile(path, 'utf-8');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error(`[dryrun] 평가셋에 데이터 행이 없다: ${path}`);
  const header = rows[0].map((h) => h.trim());
  const idx = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`[dryrun] 컬럼 누락 "${name}"`);
    return i;
  };
  const c = {
    qaId: idx('qaId'),
    category: idx('category'),
    split: idx('split'),
    question: idx('question'),
    expectedTools: idx('expectedTools'),
  };
  return rows.slice(1).map((r, n) => {
    // 질문에 따옴표 없는 쉼표가 있으면 필드가 밀린다. 앞 3개와 뒤 2개는
    // 쉼표를 포함할 수 없으니 앵커로 고정하고 가운데를 질문으로 합친다.
    let f = r;
    if (r.length > 6) {
      f = [r[0], r[1], r[2], r.slice(3, r.length - 2).join(','), r[r.length - 2], r[r.length - 1]];
    }
    if (f.length < 6) throw new Error(`[dryrun] 컬럼 부족 (row${n + 2})`);
    const qaId = (f[c.qaId] ?? '').trim() || `row${n + 2}`;
    const category = (f[c.category] ?? '').trim();
    if (!isCategory(category)) throw new Error(`[dryrun] ${qaId}: category 오류 "${category}"`);
    return {
      qaId,
      category,
      split: (f[c.split] ?? '').trim(),
      question: f[c.question] ?? '',
      expected: parseTools(f[c.expectedTools] ?? '', qaId),
    };
  });
}

// ── classify 캐시 ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toCachedClassify(qaId: string, value: unknown): ClassifyResult {
  const refresh = 'npx tsx src/dryrun.ts --refresh-classify 로 다시 생성해라';
  if (!isRecord(value)) {
    throw new Error(`[dryrun] 캐시 손상: ${qaId} 항목이 객체가 아니다 — ${refresh}`);
  }
  const rec = value;
  if (!isCategory(rec.category)) throw new Error(`[dryrun] 캐시 손상: ${qaId} category 오류 — ${refresh}`);
  if (typeof rec.confidence !== 'number' || !Number.isFinite(rec.confidence)) {
    throw new Error(`[dryrun] 캐시 손상: ${qaId} confidence 오류 — ${refresh}`);
  }
  if (typeof rec.reason !== 'string') throw new Error(`[dryrun] 캐시 손상: ${qaId} reason 오류 — ${refresh}`);
  if (!Array.isArray(rec.gameTitles) || !rec.gameTitles.every((t) => typeof t === 'string')) {
    throw new Error(`[dryrun] 캐시 손상: ${qaId} gameTitles 오류 — ${refresh}`);
  }
  return {
    category: rec.category,
    confidence: rec.confidence,
    reason: rec.reason,
    gameTitles: rec.gameTitles,
  };
}

async function loadCache(path: string): Promise<Map<string, ClassifyResult>> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    throw new Error(`[dryrun] 캐시가 없다: ${path} — npx tsx src/dryrun.ts --refresh-classify 로 먼저 생성해라`);
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('[dryrun] 캐시 손상: JSON 객체 아님');
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.entries !== 'object' || rec.entries === null) throw new Error('[dryrun] 캐시 손상: entries 없음');
  const out = new Map<string, ClassifyResult>();
  for (const [question, value] of Object.entries(rec.entries)) {
    out.set(question, toCachedClassify(`질문 "${question.slice(0, 20)}…"`, value));
  }
  return out;
}

/**
 * 캐시 생성 전용. 이때만 LLM을 부른다 (문항당 classify 1회).
 * fewshot 포함 전 문항을 뽑는다. 라우터는 안 돈다.
 */
async function refreshClassify(items: DryItem[]): Promise<void> {
  // getDeps는 디스크 + LLM 클로저 조립뿐이며 호출은 아래 classify에서만 일어난다.
  const deps = await getDeps();
  const libraryTitles = deps.library.games.map((g) => g.title);
  const entries: Record<string, ClassifyResult> = {};
  // classify 호출은 서로 독립이라 최대 3개씩 병렬로 뽑는다 (평가 하네스의 --concurrency와 같은 방식).
  const CONCURRENCY = 3;
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      const r = await classifyQuestion(item.question, deps.callLlm, libraryTitles);
      if (r.reason === '분류값 파싱 실패' || r.reason.startsWith('분류 실패:')) {
        throw new Error(`[dryrun] ${item.qaId}: classify 실패(${r.reason}) — 캐시 중단. 다시 실행해라`);
      }
      if (Object.hasOwn(entries, item.question)) throw new Error(`[dryrun] 중복 질문 문자열: ${item.qaId}`);
      entries[item.question] = {
        category: r.category,
        confidence: r.confidence,
        reason: r.reason,
        gameTitles: [...r.gameTitles],
      };
      done++;
      console.log(
        `[dryrun] 캐시 ${done}/${items.length} ${item.qaId}: ${r.category} [${r.gameTitles.join(', ') || '게임 없음'}]`,
      );
    }
  };
  const pool = Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker());
  await Promise.all(pool);
  const file = {
    _meta: {
      generatedAt: new Date().toISOString(),
      note: '이 캐시는 드라이런 전용이며 본측정에는 쓰이지 않는다.',
      count: items.length,
    },
    entries,
  };
  await writeFile(CACHE_PATH, JSON.stringify(file, null, 2) + '\n', 'utf-8');
  console.log(`[dryrun] 캐시 저장: ${CACHE_PATH} (${items.length}건)`);
}

// ── 실행 ────────────────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

const items = await loadItems(join(ROOT, 'data', 'eval_set.csv'));

if (process.argv.includes('--refresh-classify')) {
  await refreshClassify(items);
} else {
  const cache = await loadCache(CACHE_PATH);
  // fewshot은 라우터 측정 대상이 아니다 (evaluate.ts의 runEval도 제외한다).
  const targets = items.filter((i) => i.split !== 'fewshot');
  if (targets.length === 0) throw new Error('[dryrun] 대상 문항이 0건이다');
  // getDeps는 디스크에서 읽을 뿐 LLM을 부르지 않는다. routeQuestion도 LLM 없이 돈다.
  const deps = await getDeps();

  let correct = 0;
  const byCat = new Map<string, { n: number; ok: number }>();
  const wrong: string[] = [];
  for (const t of [...targets].sort((a, b) => (a.qaId < b.qaId ? -1 : 1))) {
    // 분류기 성능을 섞지 않는다 — 캐시에서 ClassifyResult를 복원해 넘긴다.
    // eval_set.csv의 category 컬럼은 여기서 쓰지 않는다.
    const classify = cache.get(t.question);
    if (!classify) {
      throw new Error(
        `[dryrun] 캐시에 없음: ${t.qaId} — 질문이 바뀌었으면 npx tsx src/dryrun.ts --refresh-classify 로 다시 생성해라`,
      );
    }
    const calls = await routeQuestion(t.question, classify, deps);
    // graph.ts의 toolsUsed와 같은 집합화 (중복 제거, 순서 무관).
    const actual: ToolName[] = [];
    for (const c of calls) {
      const name = String(c.tool);
      if (isToolName(name) && !actual.includes(name)) actual.push(name);
    }
    const score = toolScoreFor(actual, t.expected);
    correct += score;
    const agg = byCat.get(classify.category) ?? { n: 0, ok: 0 };
    agg.n++;
    agg.ok += score;
    byCat.set(classify.category, agg);
    if (score === 0) {
      wrong.push(
        `- ${t.qaId} [${classify.category}] 기대 ${t.expected.join('+') || '(없음)'} vs 실제 ${actual.join('+') || '(없음)'}`,
      );
    }
  }

  console.log(`[dryrun] 총점 ${correct}/${targets.length} (tool)`);
  for (const [cat, agg] of [...byCat.entries()].sort()) {
    console.log(`[dryrun] ${pad(cat, 12)}${agg.ok}/${agg.n}`);
  }
  if (wrong.length === 0) {
    console.log('[dryrun] 틀린 문항 없음');
  } else {
    console.log('[dryrun] 틀린 문항:');
    for (const line of wrong) console.log(line);
  }
  process.exitCode = wrong.length === 0 ? 0 : 1;
}
