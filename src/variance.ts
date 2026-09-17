/**
 * variance.ts — 동일 평가셋 반복 실행 결과 JSON들의 점수 변동 폭 집계.
 *
 * M2.5a-2 T1 "측정 신뢰성 확보"용. 같은 조건 반복 실행이 얼마나 흔들리는지 본다.
 * 읽기 전용: 결과 JSON들을 읽어 콘솔에 출력만 한다. 어떤 파일도 수정하지 않는다.
 *
 * 사용법:
 *   npx tsx src/variance.ts --runs data/results/a.json,data/results/b.json,data/results/c.json
 */

import { readFileSync } from 'node:fs';

// ── 입력 스키마 (실측 확인됨. 구버전엔 status 없음, 신버전에만 toolsUsed 있음) ──

interface ResultRow {
  qaId: string;
  category: string;
  toolScore: 0 | 1;
  answerScore: 0 | 1;
  expectedTools?: unknown;
  /** 구버전 파일에는 없음 → 없으면 "ok"로 취급 */
  status?: string;
  /** 구버전+신버전 모두 있음. 없으면 toolsUsed로 폴백 */
  actualTools?: string[];
  /** 신버전에만 있음 */
  toolsUsed?: string[];
}

interface ResultFile {
  timestamp?: string;
  evalFile?: string;
  goldFile?: string;
  /** 곧 추가 예정. 없으면 무시 */
  runLabel?: string;
  /** 곧 추가 예정. 없으면 무시 */
  concurrency?: number;
  /** 곧 추가 예정. 없으면 무시 */
  temperature?: number | null;
  rows: ResultRow[];
}

interface LoadedRun {
  path: string;
  label: string;
  runLabel?: string;
  concurrency?: number;
  temperature?: number | null;
  /** qaId → 행 (첫 등장 우선, 중복은 경고) */
  byId: Map<string, ResultRow>;
  /** status가 ok(또는 필드 없음)인 행의 qaId 집합 */
  okIds: Set<string>;
  /** status가 ok가 아닌 행 */
  errorRows: { qaId: string; status: string }[];
  toolMean: number | null;
  answerMean: number | null;
}

function fail(msg: string): never {
  console.error(`[variance] 오류: ${msg}`);
  process.exit(1);
}

function printUsage(): void {
  console.log(`사용법:
  npx tsx src/variance.ts --runs <file1.json>,<file2.json>[,<file3.json>...]

  --runs 는 필수다 (data/results/ 전체 자동 읽기는 하지 않는다.
  스모크·부분 실행 파일이 섞이는 것을 막기 위해서다).
  비교를 위해 결과 파일이 2개 이상 필요하다.`);
}

function parseRunsArg(argv: string[]): string[] | null {
  const idx = argv.indexOf('--runs');
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val.startsWith('--')) return [];
  return val
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isOk(row: ResultRow): boolean {
  return row.status === undefined || row.status === 'ok';
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function fmtMean(n: number | null): string {
  return n === null ? '-' : n.toFixed(3);
}

function loadRun(path: string): LoadedRun {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    fail(`파일을 읽을 수 없다: ${path}`);
  }
  let data: ResultFile;
  try {
    data = JSON.parse(raw!) as ResultFile;
  } catch {
    fail(`JSON 파싱 실패: ${path}`);
  }
  if (!Array.isArray(data.rows)) {
    fail(`rows 배열이 없다: ${path}`);
  }
  const byId = new Map<string, ResultRow>();
  const seen = new Set<string>();
  const errorRows: { qaId: string; status: string }[] = [];
  for (const row of data.rows) {
    if (typeof row.qaId !== 'string') {
      fail(`qaId가 없는 행이 있다: ${path}`);
    }
    if (seen.has(row.qaId)) {
      console.warn(`[variance] 경고: ${path} 에 qaId 중복 (${row.qaId}). 첫 행을 쓴다.`);
      continue;
    }
    seen.add(row.qaId);
    byId.set(row.qaId, row);
    if (!isOk(row)) errorRows.push({ qaId: row.qaId, status: String(row.status) });
  }
  const okRows = [...byId.values()].filter(isOk);
  const runLabel = typeof data.runLabel === 'string' ? data.runLabel : undefined;
  const label = `${data.timestamp ?? path}${runLabel ? ` (${runLabel})` : ''}`;
  return {
    path,
    label,
    runLabel,
    concurrency: typeof data.concurrency === 'number' ? data.concurrency : undefined,
    temperature:
      typeof data.temperature === 'number' || data.temperature === null
        ? (data.temperature as number | null)
        : undefined,
    byId,
    okIds: new Set(okRows.map((r) => r.qaId)),
    errorRows,
    toolMean: mean(okRows.map((r) => r.toolScore)),
    answerMean: mean(okRows.map((r) => r.answerScore)),
  };
}

function main(): void {
  const files = parseRunsArg(process.argv.slice(2));
  if (files === null) {
    printUsage();
    process.exit(1);
  }
  if (files.length < 2) {
    printUsage();
    fail('--runs 에 결과 JSON 파일을 2개 이상 지정해야 한다.');
  }

  const runs = files.map(loadRun);

  // ── 비교 대상: 모든 회차에 공통으로 존재하는 qaId ──
  const counts = new Map<string, number>();
  for (const run of runs) {
    for (const qaId of run.byId.keys()) {
      counts.set(qaId, (counts.get(qaId) ?? 0) + 1);
    }
  }
  const commonAll = [...counts.entries()]
    .filter(([, c]) => c === runs.length)
    .map(([qaId]) => qaId)
    .sort();
  const nonCommon = [...counts.entries()]
    .filter(([, c]) => c < runs.length)
    .map(([qaId]) => qaId)
    .sort();

  // 공통이지만 어느 회차에서라도 에러 → 점수 비교에서 제외, 따로 집계
  const errorExcluded = commonAll.filter((qaId) => !runs.every((r) => r.okIds.has(qaId)));
  const comparable = commonAll.filter((qaId) => runs.every((r) => r.okIds.has(qaId)));

  // ── 1) 회차별 전체 지표와 변동 폭 ──
  // comparable에 든 qaId는 전 회차 ok이므로, 공통 기준 분모는 전 회차 동일하다.
  const commonN = comparable.length;
  const hitsOver = (run: LoadedRun, qaIds: string[], key: 'toolScore' | 'answerScore'): number =>
    qaIds.reduce((s, qaId) => s + run.byId.get(qaId)![key], 0);
  const commonMean = (run: LoadedRun, key: 'toolScore' | 'answerScore'): number | null =>
    commonN === 0 ? null : hitsOver(run, comparable, key) / commonN;

  console.log('== 1) 회차별 전체 지표와 변동 폭 ==');
  console.log(`공통 문항 ${commonN}건 (전 회차 공통 ${commonAll.length}건 중 에러 제외 ${errorExcluded.length}건)`);
  console.log('회차 간 비교는 [공통 기준]으로 한다 (분모가 같아야 변동 폭이 의미를 가진다). [자기 기준]은 그 회차 ok행 평균으로 참고용이다.');
  for (const run of runs) {
    const extras: string[] = [];
    if (run.concurrency !== undefined) extras.push(`concurrency=${run.concurrency}`);
    if (run.temperature !== undefined) extras.push(`temperature=${run.temperature}`);
    const selfIds = [...run.okIds];
    const selfToolHits = hitsOver(run, selfIds, 'toolScore');
    const selfAnswerHits = hitsOver(run, selfIds, 'answerScore');
    const commonToolHits = hitsOver(run, comparable, 'toolScore');
    const commonAnswerHits = hitsOver(run, comparable, 'answerScore');
    console.log(
      `- ${run.label}: [자기 기준] tool ${selfToolHits}/${selfIds.length}=${fmtMean(run.toolMean)}` +
        ` / answer ${selfAnswerHits}/${selfIds.length}=${fmtMean(run.answerMean)}` +
        ` | [공통 ${commonN}문항 기준] tool ${commonToolHits}/${commonN}=${fmtMean(commonMean(run, 'toolScore'))}` +
        ` / answer ${commonAnswerHits}/${commonN}=${fmtMean(commonMean(run, 'answerScore'))}` +
        `${run.errorRows.length > 0 ? ` (에러 ${run.errorRows.length}건 제외)` : ''}${extras.length > 0 ? ` [${extras.join(', ')}]` : ''} [${run.path}]`,
    );
  }
  const printRange = (tag: string, kind: string, vals: (number | null)[]): void => {
    const nums = vals.filter((v): v is number => v !== null);
    if (nums.length === 0) {
      console.log(`  [${tag}] ${kind}: 비교할 평균이 없다`);
      return;
    }
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    console.log(`  [${tag}] ${kind}: 최소 ${lo.toFixed(3)} / 최대 ${hi.toFixed(3)} / 범위 ${(hi - lo).toFixed(3)}`);
  };
  for (const key of ['tool', 'answer'] as const) {
    const scoreKey = key === 'tool' ? 'toolScore' : 'answerScore';
    printRange('공통 기준·정본', key, runs.map((r) => commonMean(r, scoreKey)));
  }
  for (const key of ['toolMean', 'answerMean'] as const) {
    printRange('자기 기준·참고', key === 'toolMean' ? 'tool' : 'answer', runs.map((r) => r[key]));
  }
  console.log();

  // 공통이 아닌 qaId 경고 (조용히 빠뜨리지 않는다)
  if (nonCommon.length > 0) {
    console.log(`[경고] ${nonCommon.length}개 qaId가 일부 회차에만 있어 비교에서 빠진다: ${nonCommon.join(', ')}`);
    for (const run of runs) {
      const missing = nonCommon.filter((qaId) => !run.byId.has(qaId));
      if (missing.length > 0) console.log(`  - ${run.label} 에 없음: ${missing.join(', ')}`);
    }
    console.log();
  }

  // 에러로 제외된 행 집계
  const totalErrors = runs.reduce((s, r) => s + r.errorRows.length, 0);
  if (totalErrors > 0 || errorExcluded.length > 0) {
    console.log(`[에러로 제외됨] 전 회차 합계 ${totalErrors}행 (평균에 0점으로 넣지 않음):`);
    for (const run of runs) {
      if (run.errorRows.length > 0) {
        console.log(
          `  - ${run.label}: ${run.errorRows.map((e) => `${e.qaId}(status=${e.status})`).join(', ')}`,
        );
      }
    }
    if (errorExcluded.length > 0) {
      console.log(`  비교 제외(공통이지만 어느 회차에서 에러): ${errorExcluded.join(', ')}`);
    }
    console.log();
  }

  if (comparable.length === 0) {
    console.log('비교 가능한 문항이 없다 (전 회차 공통이면서 전 회차 ok인 qaId가 0건).');
    return;
  }

  const categoryOf = (qaId: string): string => String(runs[0].byId.get(qaId)?.category ?? '?');
  const toolVec = (qaId: string): number[] => runs.map((r) => r.byId.get(qaId)!.toolScore);
  const answerVec = (qaId: string): number[] => runs.map((r) => r.byId.get(qaId)!.answerScore);

  // ── 2) 문항별 판정 벡터 ──
  console.log('== 2) 문항별 판정 벡터 (qaId 오름차순) ==');
  for (const qaId of comparable) {
    console.log(
      `${qaId} [${categoryOf(qaId)}]  tool ${toolVec(qaId).join(',')}   answer ${answerVec(qaId).join(',')}`,
    );
  }
  console.log();

  // ── 3) 뒤집힌 문항 수 ──
  const flippedTool = comparable.filter((qaId) => new Set(toolVec(qaId)).size > 1);
  const flippedAnswer = comparable.filter((qaId) => new Set(answerVec(qaId)).size > 1);
  console.log('== 3) 뒤집힌 문항 수 (핵심 산출물) ==');
  console.log(
    `tool: ${flippedTool.length}/${comparable.length} 문항이 회차 간 점수가 전부 같지 않다` +
      (flippedTool.length > 0 ? ` — ${flippedTool.join(', ')}` : ''),
  );
  console.log(
    `answer: ${flippedAnswer.length}/${comparable.length} 문항이 회차 간 점수가 전부 같지 않다` +
      (flippedAnswer.length > 0 ? ` — ${flippedAnswer.join(', ')}` : ''),
  );
  console.log();

  // ── 4) 3분류 ──
  console.log('== 4) 3분류 ==');
  for (const kind of ['tool', 'answer'] as const) {
    const vec = kind === 'tool' ? toolVec : answerVec;
    const stablePass = comparable.filter((qaId) => vec(qaId).every((s) => s === 1));
    const stableFail = comparable.filter((qaId) => vec(qaId).every((s) => s === 0));
    const unstable = comparable.filter(
      (qaId) => !(vec(qaId).every((s) => s === 1) || vec(qaId).every((s) => s === 0)),
    );
    console.log(`${kind}:`);
    console.log(`  안정 성공(전 회차 1): ${stablePass.length}건${stablePass.length > 0 ? ` — ${stablePass.join(', ')}` : ''}`);
    console.log(`  안정 실패(전 회차 0): ${stableFail.length}건${stableFail.length > 0 ? ` — ${stableFail.join(', ')}` : ''}`);
    console.log(`  불안정(섞임): ${unstable.length}건${unstable.length > 0 ? ` — ${unstable.join(', ')}` : ''}`);
  }
}

main();
