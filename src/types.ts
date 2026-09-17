/**
 * questail-collie — 타입 계약 (오케스트레이터 전속 파일)
 *
 * 워커는 이 파일을 수정하지 않는다. 계약이 부족하면 직접 고치지 말고 먼저 물어볼 것.
 * 근거: questail `.agents/WORKFLOW.md` 「소유권 규칙」
 */

import type { LibraryIndex, NormalizedGame, TasteProfile } from '@questail/core';

export type { LibraryIndex, NormalizedGame, TasteProfile };

// ── 카테고리 ────────────────────────────────────────────────────────────────
// 분류 근거: 근거의 "출처 계층"이 서로 다르다.
// 객관 데이터 / 계산 산출물 / 주관 정본 / 정책 산문 / 근거 없음.
export type QueryCategory =
  | 'HISTORY' // C1 보유·플레이타임·마지막 플레이·업적률
  | 'TASTE' // C2 상위 장르·플레이타임 분포·위시 경향
  | 'SUBJECTIVE' // C3 내가 준 별점·상태·기피 사유
  | 'DATA_OPS' // C4 왜 비었나·언제 갱신됐나·자동/수기 구분
  | 'OUT_OF_SCOPE'; // C5 공략·시세·미보유 게임 평가·PSN/Xbox

export const CATEGORIES: readonly QueryCategory[] = [
  'HISTORY',
  'TASTE',
  'SUBJECTIVE',
  'DATA_OPS',
  'OUT_OF_SCOPE',
] as const;

// ── 근거 문서 ───────────────────────────────────────────────────────────────
export type DocId =
  | 'D-A' // data/mock/library.md        객관 인덱스
  | 'D-B' // data/mock/games/*.md        게임별 노트(주관 필드 포함)
  | 'D-C' // data/mock/taste-profile.json 계산 산출물
  | 'D-D' // docs/policy-collection.md   수집 정책
  | 'D-E' // docs/policy-rating.md       별점·상태 기준
  | 'D-F'; // docs/glossary-genre.md     장르 택소노미

export interface EvidenceChunk {
  /** 안정적인 인용 키. 예: 'D-D#업적-데이터' */
  id: string;
  docId: DocId;
  /** 이 청크를 근거로 쓰는 카테고리(복수 가능) */
  categories: QueryCategory[];
  heading: string;
  text: string;
}

// ── 도구 ────────────────────────────────────────────────────────────────────
export type ToolName =
  | 'lookup_library'
  | 'get_game_note'
  | 'get_taste_profile'
  | 'search_docs'
  | 'escalate';

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
  /** 이 호출이 실제로 끌어온 근거 청크 id 목록 */
  chunkIds: string[];
}

// ── 노드 산출물 ─────────────────────────────────────────────────────────────
export interface ClassifyResult {
  category: QueryCategory;
  /** 0~1. 임계값 미만이면 escalate 로 간다 — 분류와 이관 판단은 분리한다 */
  confidence: number;
  reason: string;
}

export type ViolationRule =
  | 'UNGROUNDED_NUMBER' // 근거 스니펫에 없는 숫자를 답변이 주장
  | 'UNKNOWN_GAME' // library 에 없는 게임명을 사실처럼 언급
  | 'CITED_WHILE_OUT_OF_SCOPE'; // OUT_OF_SCOPE 인데 근거를 인용

export interface Violation {
  rule: ViolationRule;
  detail: string;
}

export interface VerifyResult {
  passed: boolean;
  violations: Violation[];
}

// ── 그래프 상태 ─────────────────────────────────────────────────────────────
export interface AgentState {
  question: string;
  classify?: ClassifyResult;
  toolCalls: ToolCall[];
  evidence: EvidenceChunk[];
  answer?: string;
  verify?: VerifyResult;
  escalated: boolean;
  /** verify 실패 후 재생성 횟수. 상한 1 */
  regenerated: number;
}

export interface RunResult {
  question: string;
  category: QueryCategory;
  confidence: number;
  answer: string;
  escalated: boolean;
  /** 측정의 "실제 호출한 도구 집합" */
  toolsUsed: ToolName[];
  evidenceIds: string[];
  verify: VerifyResult;
  elapsedMs: number;
}

// ── 의존성 주입 (테스트·평가에서 갈아끼운다) ────────────────────────────────
export interface CollieDeps {
  library: LibraryIndex;
  profile: TasteProfile;
  /** docs/ + data/mock 을 청킹한 전체 근거 집합 */
  chunks: EvidenceChunk[];
  /** 분류·답변에 쓰는 LLM. 로컬 Ollama(OpenAI 호환)를 기본으로 한다 */
  callLlm: (prompt: string, system?: string) => Promise<string>;
  /** 이관 임계값. 기본 0.6 */
  confidenceThreshold?: number;
}

export type RunCollie = (question: string, deps: CollieDeps) => Promise<RunResult>;

// ── 평가 ────────────────────────────────────────────────────────────────────
export type EvalSplit = 'eval' | 'fewshot' | 'outscope';
export type Provenance = '실측' | '합성';

export interface EvalItem {
  qaId: string;
  category: QueryCategory;
  split: EvalSplit;
  question: string;
  /** 기대 도구 집합. 정확히 일치해야 1점 */
  expectedTools: ToolName[];
  provenance: Provenance;
}

export interface AnswerGold {
  qaId: string;
  /** 전부 담아야 1점. 표현이 아니라 사실로 채점한다 */
  mustInclude: string[];
  /** 하나라도 어기면 0점 */
  mustNotSay: string[];
}

export interface ScoreRow {
  qaId: string;
  toolScore: 0 | 1;
  answerScore: 0 | 1;
  actualTools: ToolName[];
  missedFacts: string[];
  violatedTaboos: string[];
}
