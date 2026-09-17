/**
 * 평가 하네스 (채점기).
 *
 * 문항 설계는 오케스트레이터 몫이다. 이 파일은 문항을 지어내지 않는다.
 * 입력: data/eval_set.csv (EvalItem 컬럼) + data/answer_gold.json (AnswerGold[])
 * 실행: pnpm eval [--eval PATH] [--gold PATH] [--only C1,C2] [--limit N] | pnpm eval --self-test
 * --only는 qaId 완전일치 또는 접두사 일치(쉼표 구분), --limit은 앞 N문항만 실행한다.
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
  /** 파싱 실패로 재시도한 호출이었는가 */
  retried: boolean;
}

/** scoreWithJudge가 던지는 실패. 재시도 시도 여부를 함께 전달한다. */
export class JudgeFailedError extends Error {
  retried: boolean;
  constructor(message: string, retried: boolean) {
    super(message);
    this.name = 'JudgeFailedError';
    this.retried = retried;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildJudgePrompt(question: string, answer: string, mustInclude: string[], mustNotSay: string[]): string {
  return [
    `질문: ${question}`,
    `답변: ${answer}`,
    `반드시 포함해야 할 사실:\n${mustInclude.map((f, i) => `${i + 1}. ${f}`).join('\n') || '(없음)'}`,
    `금칙:\n${mustNotSay.map((f, i) => `${i + 1}. ${f}`).join('\n') || '(없음)'}`,
  ].join('\n\n');
}

function parseJudgeResponse(
  raw: string,
  mustInclude: string[],
  mustNotSay: string[],
): { included: boolean[]; violated: boolean[] } {
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

function toJudgeResult(
  mustInclude: string[],
  mustNotSay: string[],
  included: boolean[],
  violated: boolean[],
  retried: boolean,
): JudgeResult {
  const missedFacts = mustInclude.filter((_, i) => !included[i]);
  const violatedTaboos = mustNotSay.filter((_, i) => violated[i]);
  const answerScore: 0 | 1 = missedFacts.length === 0 && violatedTaboos.length === 0 ? 1 : 0;
  return { answerScore, missedFacts, violatedTaboos, retried };
}

/**
 * LLM 판정 — 문항당 기본 1회 호출. mustInclude 전부와 mustNotSay 전부를
 * 한 프롬프트에 넣고 항목별 boolean 배열을 JSON 하나로 받는다.
 * 재시도는 JSON 파싱 실패(코드펜스·reasoning 잔재 등)에만 정확히 1회 허용하고,
 * 호출 실패·타임아웃에는 적용하지 않는다. 재시도 후에도 실패하면 throw하고,
 * 호출부(runEval)가 그 문항을 error 행으로 기록한다 (0점으로 삼키지 않는다).
 */
export async function scoreWithJudge(
  callLlm: CollieDeps['callLlm'],
  question: string,
  answer: string,
  mustInclude: string[],
  mustNotSay: string[],
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(question, answer, mustInclude, mustNotSay);
  // 호출 실패·타임아웃은 재시도 없이 그대로 실패로 올린다.
  let raw: string;
  try {
    raw = await callLlm(prompt, JUDGE_SYSTEM);
  } catch (err) {
    throw new JudgeFailedError(errMsg(err), false);
  }
  try {
    const { included, violated } = parseJudgeResponse(raw, mustInclude, mustNotSay);
    return toJudgeResult(mustInclude, mustNotSay, included, violated, false);
  } catch {
    /* 파싱 실패만 1회 재시도한다 */
  }
  let retryRaw: string;
  try {
    retryRaw = await callLlm(prompt, JUDGE_SYSTEM);
  } catch (err) {
    throw new JudgeFailedError(errMsg(err), true);
  }
  try {
    const { included, violated } = parseJudgeResponse(retryRaw, mustInclude, mustNotSay);
    return toJudgeResult(mustInclude, mustNotSay, included, violated, true);
  } catch (err) {
    throw new JudgeFailedError(errMsg(err), true);
  }
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
  /** ok=정상 채점, error=LLM 호출 실패·타임아웃·파싱 실패 (평균에서 제외) */
  status: 'ok' | 'error';
  /** status가 error일 때 실패 사유 */
  error?: string;
  // ── 오답 분석용 (runCollie 결과 그대로) ──
  /** 답변 본문 전문 */
  answer: string;
  predictedCategory: QueryCategory;
  confidence: number;
  escalated: boolean;
  /** 실제 호출한 도구 집합 */
  toolsUsed: ToolName[];
  /** 근거로 쓴 청크 id */
  evidenceIds: string[];
  /** 문항별 소요 시간 (runCollie + 채점, ms) */
  elapsedMs: number;
  /** 채점 파싱 실패로 재시도한 문항인가 */
  retried: boolean;
}

function mean(rows: ExtendedRow[], key: 'toolScore' | 'answerScore'): number {
  if (rows.length === 0) return 0;
  return rows.reduce((s, r) => s + r[key], 0) / rows.length;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** 경과 표기. 60초 미만이면 "45s", 이상이면 "2m18s". */
function formatDur(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/** 잔여 추정 표기. "~" + 분 단위 반올림 (예: ~11m, 1분 미만이면 ~45s). */
function formatEta(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s < 60) return `~${s}s`;
  return `~${Math.round(s / 60)}m`;
}

/**
 * 문항별 진행률 한 줄.
 * 예: [eval] (3/27) C4-02: tool=1 answer=0 (46.1s) | 누적 tool 0.67 answer 0.33 | 경과 2m18s · 잔여 ~11m
 * 누적은 지금까지 status=ok인 행만의 평균 (0건이면 "누적 -").
 * 잔여는 남은 건수 × 지금까지 ok/error 포함 전체 평균 소요시간으로 추정한다.
 */
function formatProgress(
  rows: ExtendedRow[],
  qaId: string,
  loopStart: number,
  total: number,
  score: string,
  elapsedMs: number,
): string {
  const n = rows.length;
  const ok = rows.filter((r) => r.status === 'ok');
  const cumulative =
    ok.length === 0
      ? '누적 -'
      : `누적 tool ${mean(ok, 'toolScore').toFixed(2)} answer ${mean(ok, 'answerScore').toFixed(2)}`;
  const elapsedSec = (Date.now() - loopStart) / 1000;
  const avgMs = rows.reduce((sum, r) => sum + r.elapsedMs, 0) / rows.length;
  const remainSec = ((total - n) * avgMs) / 1000;
  return `[eval] (${n}/${total}) ${qaId}: ${score} (${(elapsedMs / 1000).toFixed(1)}s) | ${cumulative} | 경과 ${formatDur(elapsedSec)} · 잔여 ${formatEta(remainSec)}`;
}

function printReport(rows: ExtendedRow[], fewshotSkipped: number): void {
  const ok = rows.filter((r) => r.status === 'ok');
  const errors = rows.filter((r) => r.status === 'error');
  const errRate = rows.length === 0 ? 0 : (errors.length / rows.length) * 100;
  console.log(`[eval] ${rows.length}건 시도 (fewshot ${fewshotSkipped}건 제외)`);
  console.log(`[eval] 에러 ${errors.length}/${rows.length}건 (${errRate.toFixed(1)}%) — 평균에서 제외`);
  const cats = [...new Set(ok.map((r) => r.category))].sort();
  console.log('=== 집계 (에러 제외) ===');
  console.log(`${pad('category', 12)}${pad('n', 5)}${pad('tool', 8)}answer`);
  for (const c of cats) {
    const sub = ok.filter((r) => r.category === c);
    console.log(`${pad(c, 12)}${pad(String(sub.length), 5)}${pad(mean(sub, 'toolScore').toFixed(2), 8)}${mean(sub, 'answerScore').toFixed(2)}`);
  }
  console.log(`${pad('ALL', 12)}${pad(String(ok.length), 5)}${pad(mean(ok, 'toolScore').toFixed(2), 8)}${mean(ok, 'answerScore').toFixed(2)}`);
  console.log(`[eval] 평균은 에러 제외 ${ok.length}건 기준 (에러 ${errors.length}건 제외, 0점으로 세지 않음)`);
  const wrong = rows.filter((r) => r.status === 'error' || r.toolScore === 0 || r.answerScore === 0);
  console.log('=== 틀린 문항 ===');
  if (wrong.length === 0) {
    console.log('(없음)');
    return;
  }
  for (const r of wrong) {
    if (r.status === 'error') {
      console.log(`- ${r.qaId} [${r.category}/${r.split}] ERROR: ${r.error} (${(r.elapsedMs / 1000).toFixed(1)}s)`);
      continue;
    }
    console.log(`- ${r.qaId} [${r.category}/${r.split}] tool=${r.toolScore} (기대 ${r.expectedTools.join('+') || '(없음)'} vs 실제 ${r.actualTools.join('+') || '(없음)'}) answer=${r.answerScore}`);
    for (const f of r.missedFacts) console.log(`    빠뜨린 사실: ${f}`);
    for (const t of r.violatedTaboos) console.log(`    어긴 금칙: ${t}`);
  }
}

async function runEval(evalPath: string, goldPath: string, onlyTokens: string[], limit: number | undefined): Promise<void> {
  const items = await loadEvalSet(evalPath);
  const gold = await loadGold(goldPath);
  let targets = items.filter((i) => i.split !== 'fewshot');
  const fewshotSkipped = items.length - targets.length;
  if (onlyTokens.length > 0) {
    targets = targets.filter((t) => onlyTokens.some((tok) => t.qaId === tok || t.qaId.startsWith(tok)));
  }
  if (limit !== undefined) {
    targets = targets.slice(0, limit);
  }
  if (targets.length === 0) {
    throw new Error('[eval] 대상 문항이 0건이다 (--only/--limit 조건 확인)');
  }
  const missingGold = targets.filter((t) => !gold.has(t.qaId));
  if (missingGold.length > 0) {
    throw new Error(`[eval] 정답지 누락: ${missingGold.map((t) => t.qaId).join(', ')}`);
  }
  // context.ts 소유 모듈에서 주입. data/mock 미생성이면 그쪽 에러가 그대로 올라온다.
  const { getDeps } = await import('./context.js');
  const deps: CollieDeps = await getDeps();
  const callLlm = deps.callLlm;
  const rows: ExtendedRow[] = [];
  const loopStart = Date.now();
  for (const item of targets) {
    const g = gold.get(item.qaId) as AnswerGold;
    const t0 = Date.now();
    try {
      const res = await runCollie(item.question, deps);
      const toolScore = toolScoreFor(res.toolsUsed, item.expectedTools);
      const judged = await scoreWithJudge(callLlm, item.question, res.answer, g.mustInclude, g.mustNotSay);
      const elapsedMs = Date.now() - t0;
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
        status: 'ok',
        answer: res.answer,
        predictedCategory: res.category,
        confidence: res.confidence,
        escalated: res.escalated,
        toolsUsed: res.toolsUsed,
        evidenceIds: res.evidenceIds,
        elapsedMs,
        retried: judged.retried,
      });
      console.log(
        formatProgress(rows, item.qaId, loopStart, targets.length, `tool=${toolScore} answer=${judged.answerScore}`, elapsedMs),
      );
    } catch (err) {
      const elapsedMs = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      rows.push({
        qaId: item.qaId,
        toolScore: 0,
        answerScore: 0,
        actualTools: [],
        missedFacts: [],
        violatedTaboos: [],
        category: item.category,
        split: item.split,
        expectedTools: item.expectedTools,
        question: item.question,
        status: 'error',
        error: msg,
        answer: '',
        predictedCategory: item.category,
        confidence: 0,
        escalated: false,
        toolsUsed: [],
        evidenceIds: [],
        elapsedMs,
        retried: err instanceof JudgeFailedError ? err.retried : false,
      });
      console.log(formatProgress(rows, item.qaId, loopStart, targets.length, `ERROR ${msg}`, elapsedMs));
    }
  }
  printReport(rows, fewshotSkipped);
  const ok = rows.filter((r) => r.status === 'ok');
  const errorCount = rows.length - ok.length;
  const errorRate = errorCount / rows.length;
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const outDir = resolve('data', 'results');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${ts}.json`);
  const byCategory: Record<string, { n: number; tool: number; answer: number }> = {};
  for (const c of new Set(ok.map((r) => r.category))) {
    const sub = ok.filter((r) => r.category === c);
    byCategory[c] = { n: sub.length, tool: mean(sub, 'toolScore'), answer: mean(sub, 'answerScore') };
  }
  await writeFile(
    outPath,
    JSON.stringify(
      {
        timestamp: ts,
        evalFile: evalPath,
        goldFile: goldPath,
        totals: {
          attempted: rows.length,
          scored: ok.length,
          errors: errorCount,
          errorRate,
          meanExcludesErrors: true,
          tool: mean(ok, 'toolScore'),
          answer: mean(ok, 'answerScore'),
        },
        byCategory,
        rows,
      },
      null,
      2,
    ),
  );
  console.log(`[eval] 결과 저장: ${outPath}`);
  if (errorRate > 0.2) {
    console.log(`[eval] 에러율 ${(errorRate * 100).toFixed(1)}%가 20%를 초과 — 이 실행은 측정으로 쓸 수 없다 (exit 1)`);
    process.exitCode = 1;
  }
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
    const onlyRaw = flagValue(argv, '--only');
    const onlyTokens = onlyRaw === undefined ? [] : onlyRaw.split(',').map((s) => s.trim()).filter((s) => s !== '');
    const limitRaw = flagValue(argv, '--limit');
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error(`[eval] --limit 값 오류 "${limitRaw}" (1 이상 정수)`);
    }
    await runEval(
      resolve(flagValue(argv, '--eval') ?? join('data', 'eval_set.csv')),
      resolve(flagValue(argv, '--gold') ?? join('data', 'answer_gold.json')),
      onlyTokens,
      limit,
    );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
