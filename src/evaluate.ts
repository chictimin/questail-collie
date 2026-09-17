/**
 * 평가 하네스 (채점기).
 *
 * 문항 설계는 오케스트레이터 몫이다. 이 파일은 문항을 지어내지 않는다.
 * 입력: data/eval_set.csv (EvalItem 컬럼) + data/answer_gold.json (AnswerGold[])
 * 실행: pnpm eval [--eval PATH] [--gold PATH] [--only C1,C2] [--limit N] [--concurrency N] [--run-label STR] | pnpm eval --self-test
 * --only는 qaId 완전일치 또는 접두사 일치(쉼표 구분), --limit은 앞 N문항만 실행한다.
 * --concurrency는 동시 실행 상한 (기본값 2), --run-label은 결과 JSON의 runLabel이 된다.
 *
 * 의존성 주입(CollieDeps)은 src/context.ts의 `getDeps()`를 쓴다.
 * --self-test는 context/data 없이 돌아간다 (채점기 자체 검증용).
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJsonPayload } from '@questail/core';
import { runCollie } from './graph.js';
import { createCallLlm, LLM_TEMPERATURE } from './llm.js';
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
  'get_achievement_stats',
  'get_wishlist',
  'find_rating_playtime_gaps',
  'get_field_coverage',
  'describe_schema',
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
 * 문항별 진행률 한 줄 (병렬 실행용 — 완료 건수 기준).
 * 예: [eval] (3/27) C4-02: tool=1 answer=0 (46.1s) | 누적 tool 0.67 answer 0.33 | 경과 2m18s · 잔여 ~11m
 * done은 지금까지 완료된 행(완료 순서), doneCount는 완료 건수다.
 * 누적은 done 중 status=ok인 행만의 평균 (0건이면 "누적 -").
 * 잔여는 남은 건수 × done 전체 평균 소요시간으로 추정한다.
 */
function formatProgress(
  done: ExtendedRow[],
  doneCount: number,
  total: number,
  loopStart: number,
  qaId: string,
  score: string,
  elapsedMs: number,
): string {
  const ok = done.filter((r) => r.status === 'ok');
  const cumulative =
    ok.length === 0
      ? '누적 -'
      : `누적 tool ${mean(ok, 'toolScore').toFixed(2)} answer ${mean(ok, 'answerScore').toFixed(2)}`;
  const elapsedSec = (Date.now() - loopStart) / 1000;
  const avgMs = done.length === 0 ? 0 : done.reduce((sum, r) => sum + r.elapsedMs, 0) / done.length;
  const remainSec = ((total - doneCount) * avgMs) / 1000;
  return `[eval] (${doneCount}/${total}) ${qaId}: ${score} (${(elapsedMs / 1000).toFixed(1)}s) | ${cumulative} | 경과 ${formatDur(elapsedSec)} · 잔여 ${formatEta(remainSec)}`;
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

/** 저장소 루트 (src/의 부모). 결과 JSON에 절대경로(사용자명 노출)를 남기지 않기 위함. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 결과 JSON 기록용 경로. 루트 안이면 루트 기준 상대경로(data/eval_set.csv 형태),
 * 루트 밖이면 홈 경로가 섞여 있을 때만 basename, 그 외는 원래 값 그대로.
 */
export function repoRelative(p: string): string {
  const abs = resolve(p);
  const rel = relative(REPO_ROOT, abs);
  if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    return rel.split(sep).join('/');
  }
  if (abs.startsWith(homedir() + sep)) return basename(abs);
  return p;
}

/**
 * 문항 1건 실행 → ExtendedRow 1행. 실패는 throw하지 않고 status=error 행으로 돌린다
 * (0점으로 삼키지 않고 평균에서 제외한다). allSettled 수집의 rejected 분기는
 * 행 구성 코드 자체의 결함 같은 예외적 상황용 폴백이다.
 */
async function runOne(
  item: EvalItem,
  g: AnswerGold,
  deps: CollieDeps,
  callLlm: CollieDeps['callLlm'],
): Promise<ExtendedRow> {
  const t0 = Date.now();
  try {
    const res = await runCollie(item.question, deps);
    const toolScore = toolScoreFor(res.toolsUsed, item.expectedTools);
    const judged = await scoreWithJudge(callLlm, item.question, res.answer, g.mustInclude, g.mustNotSay);
    const elapsedMs = Date.now() - t0;
    return {
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
    };
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    return {
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
    };
  }
}

/** 행 구성 코드 자체가 throw한 경우의 폴백 error 행 (정상 경로에서는 쓰이지 않는다). */
function fallbackErrorRow(item: EvalItem, reason: unknown): ExtendedRow {
  const msg = reason instanceof Error ? reason.message : String(reason);
  return {
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
    error: `[harness] ${msg}`,
    answer: '',
    predictedCategory: item.category,
    confidence: 0,
    escalated: false,
    toolsUsed: [],
    evidenceIds: [],
    elapsedMs: 0,
    retried: false,
  };
}

/**
 * 외부 의존성 없는 동시성 제한기. tasks를 최대 limit개씩 동시에 돌리고
 * Promise.allSettled 기반으로 수집한다. 한 문항의 실패가 나머지를 멈추지 않는다.
 * 결과는 입력 순서대로 반환한다 (호출부가 qaId 정렬로 확정 순서를 만든다).
 */
async function runWithLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  const pool = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, () => worker());
  await Promise.allSettled(pool);
  return results;
}

async function runEval(
  evalPath: string,
  goldPath: string,
  onlyTokens: string[],
  limit: number | undefined,
  concurrency: number,
  runLabel: string,
): Promise<void> {
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
  // 진행률 누적용 (완료 순서 — 평균·ETA 계산에만 쓰고 출력 순서는 아래 정렬이 정한다).
  const done: ExtendedRow[] = [];
  let doneCount = 0;
  const loopStart = Date.now();
  const tasks = targets.map((item) => {
    const g = gold.get(item.qaId) as AnswerGold;
    return async (): Promise<ExtendedRow> => {
      const row = await runOne(item, g, deps, callLlm);
      doneCount++;
      done.push(row);
      const score =
        row.status === 'ok' ? `tool=${row.toolScore} answer=${row.answerScore}` : `ERROR ${row.error}`;
      console.log(formatProgress(done, doneCount, targets.length, loopStart, item.qaId, score, row.elapsedMs));
      return row;
    };
  });
  const settled = await runWithLimit(tasks, concurrency);
  settled.forEach((s, i) => {
    rows.push(s.status === 'fulfilled' ? s.value : fallbackErrorRow(targets[i], s.reason));
  });
  // 병렬 완료 순서는 실행마다 달라진다. 회차 간 비교를 위해 qaId 오름차순으로 고정한다.
  rows.sort((a, b) => (a.qaId < b.qaId ? -1 : a.qaId > b.qaId ? 1 : 0));
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
        evalFile: repoRelative(evalPath),
        goldFile: repoRelative(goldPath),
        runLabel,
        concurrency,
        temperature: LLM_TEMPERATURE,
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

// 이 파일을 직접 실행했을 때만 측정을 돌린다.
// dryrun.ts 등이 toolScoreFor를 import할 때 본측정이 함께 도는 것을 막는다.
/**
 * 측정 중복 실행 방지 락.
 *
 * 두 측정이 겹쳐 돌면 실제 동시성이 배가 되어 문항별 지연이 달라지고, 그 차이가
 * 회차 간 변동 폭에 섞인다(T1 에서 확인. 겹친 회차에서 에러 1건이 발생했다).
 * "프로세스가 안 보인다"는 관측은 죽었다는 근거가 못 된다 — 출력 버퍼링이나
 * 프로세스 가시성 문제로 실제로는 돌고 있는데 없어 보일 수 있다. 그래서 재실행
 * 판단을 사람이나 에이전트의 규율에 맡기지 않고 여기서 막는다.
 */
const LOCK_PATH = resolve('data', 'results', '.eval.lock');

interface EvalLock {
  pid: number;
  startedAt: string;
  label: string;
}

/** 신호 0 은 프로세스를 건드리지 않고 존재 여부만 확인한다. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireEvalLock(label: string): void {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });

  if (existsSync(LOCK_PATH)) {
    let prev: EvalLock | undefined;
    try {
      prev = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as EvalLock;
    } catch {
      prev = undefined; // 깨진 락은 stale 로 본다
    }

    if (prev && isAlive(prev.pid)) {
      throw new Error(
        `[eval] 이미 측정이 돌고 있다 — pid ${prev.pid} · 시작 ${prev.startedAt} · 라벨 "${prev.label}"\n` +
          '       두 측정이 겹치면 실제 동시성이 배가 되어 지연이 달라지고 회차 간 비교가 오염된다.\n' +
          '       진행 상황은 그 프로세스의 로그에서 확인한다. 프로세스 목록에 안 보인다는 것은\n' +
          '       죽었다는 근거가 아니다.\n' +
          `       정말 중단하려면: kill ${prev.pid} && rm ${LOCK_PATH}`,
      );
    }

    if (prev) console.warn(`[eval] stale 락 회수 (pid ${prev.pid} 종료됨)`);
    unlinkSync(LOCK_PATH);
  }

  const lock: EvalLock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    label: label || '(무라벨)',
  };
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2));
  console.log(`[eval] 락 획득 (pid ${process.pid})`);
}

/** 내 락일 때만 지운다. stale 회수 뒤 다른 프로세스가 잡은 락을 뺏지 않는다. */
function releaseEvalLock(): void {
  try {
    if (!existsSync(LOCK_PATH)) return;
    const cur = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as EvalLock;
    if (cur.pid === process.pid) unlinkSync(LOCK_PATH);
  } catch {
    // 락 해제 실패로 측정 결과를 잃지 않는다
  }
}

const IS_ENTRY =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_ENTRY) {
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
      const concurrencyRaw = flagValue(argv, '--concurrency');
      let concurrency = 2;
      if (concurrencyRaw !== undefined) {
        concurrency = Number(concurrencyRaw);
        if (!Number.isInteger(concurrency) || concurrency <= 0)
          throw new Error(`[eval] --concurrency 값 오류 "${concurrencyRaw}" (1 이상 정수)`);
      }
      const runLabel = flagValue(argv, '--run-label') ?? '';
      acquireEvalLock(runLabel);
      process.on('exit', releaseEvalLock);
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.on(sig, () => {
          releaseEvalLock();
          process.exit(130);
        });
      }
      await runEval(
        resolve(flagValue(argv, '--eval') ?? join('data', 'eval_set.csv')),
        resolve(flagValue(argv, '--gold') ?? join('data', 'answer_gold.json')),
        onlyTokens,
        limit,
        concurrency,
        runLabel,
      );
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
