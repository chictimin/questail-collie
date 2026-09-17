/**
 * 평가 하네스 (채점기).
 *
 * 문항 설계는 오케스트레이터 몫이다. 이 파일은 문항을 지어내지 않는다.
 * 입력: data/eval_set.csv (EvalItem 컬럼) + data/answer_gold.json (AnswerGold[])
 * 실행: pnpm eval [--eval PATH] [--gold PATH] | pnpm eval --self-test
 *
 * 의존성 주입(CollieDeps)은 src/context.ts의 `getDeps()`를 쓴다.
 * --self-test는 context/data 없이 돌아간다 (채점기 자체 검증용).
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { extractJsonPayload } from '@questail/core';
import { runCollie } from './graph.js';
import { createCallLlm } from './llm.js';
import {
  CATEGORIES,
  type AnswerGold,
  type CollieDeps,
  type EvalItem,
  type EvalSplit,
  type Provenance,
  type QueryCategory,
  type ScoreRow,
  type ToolName,
} from './types.js';

const TOOL_NAMES: readonly ToolName[] = [
  'lookup_library',
  'get_game_note',
  'get_taste_profile',
  'search_docs',
  'escalate',
];

const JUDGE_SYSTEM = `너는 답변 채점기다. 아래 JSON만 출력한다 (설명·코드펜스 금지):
{"included": [true/false, ...], "violated": [true/false, ...]}
included는 "반드시 포함해야 할 사실" 목록 순서대로, 그 사실을 답변이 담았는지다.
violated는 "금칙" 목록 순서대로, 그 금칙을 답변이 어겼는지다.
판정 기준: 표현이 아니라 사실을 보라. 같은 사실을 다른 말로 표현했으면 담은 것으로 친다. 단 숫자는 값이 같아야 한다.`;

// ── CSV ─────────────────────────────────────────────────────────────────────

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

function assertTool(value: string, qaId: string): ToolName {
  if ((TOOL_NAMES as readonly string[]).includes(value)) return value as ToolName;
  throw new Error(`[eval] ${qaId}: 알 수 없는 도구명 "${value}"`);
}

/** JSON 배열 셀 우선, 아니면 '|' (또는 ';') 구분 폴백. */
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

function isCategory(v: string): v is QueryCategory {
  return (CATEGORIES as readonly string[]).includes(v);
}

function isSplit(v: string): v is EvalSplit {
  return v === 'eval' || v === 'fewshot' || v === 'outscope';
}

function isProvenance(v: string): v is Provenance {
  return v === '실측' || v === '합성';
}

async function loadEvalSet(path: string): Promise<EvalItem[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    throw new Error(`[eval] 평가셋이 없다: ${path} (오케스트레이터가 설계 중)`);
  }
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error(`[eval] 평가셋에 데이터 행이 없다: ${path}`);
  const header = rows[0].map((h) => h.trim());
  const idx = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`[eval] 컬럼 누락 "${name}" (실제: ${header.join(',')})`);
    return i;
  };
  const c = {
    qaId: idx('qaId'),
    category: idx('category'),
    split: idx('split'),
    question: idx('question'),
    expectedTools: idx('expectedTools'),
    provenance: idx('provenance'),
  };
  return rows.slice(1).map((r, n) => {
    // C2-04/C2-05처럼 질문에 따옴표 없는 쉼표가 있으면 필드가 밀린다.
    // 앞 3개(qaId·category·split)와 뒤 2개(expectedTools·provenance)는
    // 쉼표를 포함할 수 없으니 앵커로 고정하고 가운데를 질문으로 합친다.
    let f = r;
    if (r.length > 6) {
      f = [r[0], r[1], r[2], r.slice(3, r.length - 2).join(','), r[r.length - 2], r[r.length - 1]];
    }
    if (f.length < 6) throw new Error(`[eval] 컬럼 부족 (row${n + 2})`);
    const qaId = (f[c.qaId] ?? '').trim() || `row${n + 2}`;
    const category = (f[c.category] ?? '').trim();
    const split = (f[c.split] ?? '').trim();
    const provenance = (f[c.provenance] ?? '').trim();
    if (!isCategory(category)) throw new Error(`[eval] ${qaId}: category 오류 "${category}"`);
    if (!isSplit(split)) throw new Error(`[eval] ${qaId}: split 오류 "${split}"`);
    if (!isProvenance(provenance)) throw new Error(`[eval] ${qaId}: provenance 오류 "${provenance}"`);
    return {
      qaId,
      category,
      split,
      question: f[c.question] ?? '',
      expectedTools: parseTools(f[c.expectedTools] ?? '', qaId),
      provenance,
    };
  });
}

async function loadGold(path: string): Promise<Map<string, AnswerGold>> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    throw new Error(`[eval] 정답지가 없다: ${path} (오케스트레이터가 설계 중)`);
  }
  const arr = JSON.parse(text) as AnswerGold[];
  return new Map(arr.map((g) => [g.qaId, g]));
}

// ── 채점 ────────────────────────────────────────────────────────────────────

/** 순서 무시 집합 비교. 정확히 일치만 1점, 부분 점수 없음. */
export function toolScoreFor(actual: ToolName[], expected: ToolName[]): 0 | 1 {
  if (actual.length !== expected.length) return 0;
  const set = new Set(actual);
  return expected.every((t) => set.has(t)) ? 1 : 0;
}

export interface JudgeResult {
  answerScore: 0 | 1;
  missedFacts: string[];
  violatedTaboos: string[];
}

async function judgeOnce(
  callLlm: CollieDeps['callLlm'],
  question: string,
  answer: string,
  mustInclude: string[],
  mustNotSay: string[],
): Promise<{ included: boolean[]; violated: boolean[] }> {
  const prompt = [
    `질문: ${question}`,
    `답변: ${answer}`,
    `반드시 포함해야 할 사실:\n${mustInclude.map((f, i) => `${i + 1}. ${f}`).join('\n') || '(없음)'}`,
    `금칙:\n${mustNotSay.map((f, i) => `${i + 1}. ${f}`).join('\n') || '(없음)'}`,
  ].join('\n\n');
  const raw = await callLlm(prompt, JUDGE_SYSTEM);
  const parsed: unknown = JSON.parse(extractJsonPayload(raw));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('채점 JSON 아님');
  const rec = parsed as Record<string, unknown>;
  if (!Array.isArray(rec.included) || !Array.isArray(rec.violated)) {
    throw new Error('채점 필드 누락');
  }
  if (rec.included.length !== mustInclude.length || rec.violated.length !== mustNotSay.length) {
    throw new Error('채점 배열 길이 불일치');
  }
  return {
    included: rec.included.map(Boolean),
    violated: rec.violated.map(Boolean),
  };
}

/** LLM 판정. 파싱 실패 시 1회 재시도 후에도 안 되면 0점 + 사유 기록하고 계속한다. */
export async function scoreWithJudge(
  callLlm: CollieDeps['callLlm'],
  question: string,
  answer: string,
  mustInclude: string[],
  mustNotSay: string[],
): Promise<JudgeResult> {
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { included, violated } = await judgeOnce(callLlm, question, answer, mustInclude, mustNotSay);
      const missedFacts = mustInclude.filter((_, i) => !included[i]);
      const violatedTaboos = mustNotSay.filter((_, i) => violated[i]);
      const answerScore: 0 | 1 = missedFacts.length === 0 && violatedTaboos.length === 0 ? 1 : 0;
      return { answerScore, missedFacts, violatedTaboos };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  return { answerScore: 0, missedFacts: [`채점 응답 파싱 실패: ${lastErr}`], violatedTaboos: [] };
}

// ── 셀프테스트 (채점기 테스트용 fixtures — 평가셋 문항이 아니다) ────────────

const SELFTEST_FACTS = ['엘든 링의 플레이타임은 1200분이다', '장르는 소울라이크다'];
const SELFTEST_TABOOS = ['미보유 게임 스타필드를 추천한다'];
const SELFTEST_QUESTION = '엘든 링 플레이타임과 장르는?';

const SELFTEST_MODEL = '엘든 링의 플레이타임은 1200분이며 장르는 소울라이크다.';
const SELFTEST_MISSING = '엘든 링의 플레이타임은 1200분이다.';
const SELFTEST_TABOO = '엘든 링의 플레이타임은 1200분이며 장르는 소울라이크다. 미보유 게임 스타필드를 추천한다.';

async function selfTest(): Promise<number> {
  let fails = 0;
  const check = (name: string, got: unknown, want: unknown): void => {
    const ok = got === want;
    if (!ok) fails++;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  };

  check('toolScore 정확히 일치', toolScoreFor(['lookup_library'], ['lookup_library']), 1);
  check('toolScore 순서 무시', toolScoreFor(['search_docs', 'lookup_library'], ['lookup_library', 'search_docs']), 1);
  check('toolScore 부분집합은 0', toolScoreFor(['lookup_library'], ['lookup_library', 'search_docs']), 0);
  check('toolScore 빈집합 일치', toolScoreFor([], []), 1);

  const callLlm = createCallLlm();
  const a = await scoreWithJudge(callLlm, SELFTEST_QUESTION, SELFTEST_MODEL, SELFTEST_FACTS, SELFTEST_TABOOS);
  check('(a) 모범 답안 answerScore', a.answerScore, 1);
  const b = await scoreWithJudge(callLlm, SELFTEST_QUESTION, SELFTEST_MISSING, SELFTEST_FACTS, SELFTEST_TABOOS);
  check('(b) 사실 빠뜨림 answerScore', b.answerScore, 0);
  const c = await scoreWithJudge(callLlm, SELFTEST_QUESTION, SELFTEST_TABOO, SELFTEST_FACTS, SELFTEST_TABOOS);
  check('(c) 금칙 위반 answerScore', c.answerScore, 0);

  console.log(fails === 0 ? '[self-test] 전부 통과' : `[self-test] ${fails}건 실패`);
  return fails;
}

// ── 실행 ────────────────────────────────────────────────────────────────────

export interface ExtendedRow extends ScoreRow {
  category: QueryCategory;
  split: EvalSplit;
  expectedTools: ToolName[];
  question: string;
}

function mean(rows: ExtendedRow[], key: 'toolScore' | 'answerScore'): number {
  if (rows.length === 0) return 0;
  return rows.reduce((s, r) => s + r[key], 0) / rows.length;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function printReport(rows: ExtendedRow[], fewshotSkipped: number): void {
  const cats = [...new Set(rows.map((r) => r.category))].sort();
  console.log(`[eval] ${rows.length}건 채점 (fewshot ${fewshotSkipped}건 제외)`);
  console.log('=== 집계 ===');
  console.log(`${pad('category', 12)}${pad('n', 5)}${pad('tool', 8)}answer`);
  for (const c of cats) {
    const sub = rows.filter((r) => r.category === c);
    console.log(`${pad(c, 12)}${pad(String(sub.length), 5)}${pad(mean(sub, 'toolScore').toFixed(2), 8)}${mean(sub, 'answerScore').toFixed(2)}`);
  }
  console.log(`${pad('ALL', 12)}${pad(String(rows.length), 5)}${pad(mean(rows, 'toolScore').toFixed(2), 8)}${mean(rows, 'answerScore').toFixed(2)}`);
  const wrong = rows.filter((r) => r.toolScore === 0 || r.answerScore === 0);
  console.log('=== 틀린 문항 ===');
  if (wrong.length === 0) {
    console.log('(없음)');
    return;
  }
  for (const r of wrong) {
    console.log(`- ${r.qaId} [${r.category}/${r.split}] tool=${r.toolScore} (기대 ${r.expectedTools.join('+') || '(없음)'} vs 실제 ${r.actualTools.join('+') || '(없음)'}) answer=${r.answerScore}`);
    for (const f of r.missedFacts) console.log(`    빠뜨린 사실: ${f}`);
    for (const t of r.violatedTaboos) console.log(`    어긴 금칙: ${t}`);
  }
}

async function runEval(evalPath: string, goldPath: string): Promise<void> {
  const items = await loadEvalSet(evalPath);
  const gold = await loadGold(goldPath);
  const targets = items.filter((i) => i.split !== 'fewshot');
  const fewshotSkipped = items.length - targets.length;
  const missingGold = targets.filter((t) => !gold.has(t.qaId));
  if (missingGold.length > 0) {
    throw new Error(`[eval] 정답지 누락: ${missingGold.map((t) => t.qaId).join(', ')}`);
  }
  // context.ts 소유 모듈에서 주입. data/mock 미생성이면 그쪽 에러가 그대로 올라온다.
  const { getDeps } = await import('./context.js');
  const deps: CollieDeps = await getDeps();
  const callLlm = deps.callLlm;
  const rows: ExtendedRow[] = [];
  for (const item of targets) {
    const g = gold.get(item.qaId) as AnswerGold;
    const res = await runCollie(item.question, deps);
    const toolScore = toolScoreFor(res.toolsUsed, item.expectedTools);
    const judged = await scoreWithJudge(callLlm, item.question, res.answer, g.mustInclude, g.mustNotSay);
    rows.push({
      qaId: item.qaId,
      toolScore,
      answerScore: judged.answerScore,
      actualTools: res.toolsUsed,
      missedFacts: judged.missedFacts,
      violatedTaboos: judged.violatedTaboos,
      category: item.category,
      split: item.split,
      expectedTools: item.expectedTools,
      question: item.question,
    });
    console.log(`[eval] ${item.qaId}: tool=${toolScore} answer=${judged.answerScore}`);
  }
  printReport(rows, fewshotSkipped);
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const outDir = resolve('data', 'results');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${ts}.json`);
  const byCategory: Record<string, { n: number; tool: number; answer: number }> = {};
  for (const c of new Set(rows.map((r) => r.category))) {
    const sub = rows.filter((r) => r.category === c);
    byCategory[c] = { n: sub.length, tool: mean(sub, 'toolScore'), answer: mean(sub, 'answerScore') };
  }
  await writeFile(
    outPath,
    JSON.stringify(
      {
        timestamp: ts,
        evalFile: evalPath,
        goldFile: goldPath,
        totals: { n: rows.length, tool: mean(rows, 'toolScore'), answer: mean(rows, 'answerScore') },
        byCategory,
        rows,
      },
      null,
      2,
    ),
  );
  console.log(`[eval] 결과 저장: ${outPath}`);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const argv = process.argv.slice(2);
try {
  if (argv.includes('--self-test')) {
    const fails = await selfTest();
    process.exitCode = fails === 0 ? 0 : 1;
  } else {
    await runEval(
      resolve(flagValue(argv, '--eval') ?? join('data', 'eval_set.csv')),
      resolve(flagValue(argv, '--gold') ?? join('data', 'answer_gold.json')),
    );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
