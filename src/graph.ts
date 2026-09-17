/**
 * classify -> (저신뢰) escalate -> end
 *          -> assemble_context -> answer -> verify -> (통과) end
 *                                              -> (탈락·재생성 0회) answer로 1회 복귀
 *                                              -> (탈락·재생성済) 그대로 end (실패 기록 유지)
 *
 * postie src/graph.ts 패턴을 가져온다: StateGraph(Annotation) → addNode →
 * 조건 분기 → compile → invoke. 재생성 루프는 그래프 조건 분기로 건다.
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { answerQuestion } from './nodes/answer.js';
import { assembleContext } from './nodes/assemble.js';
import { classifyQuestion } from './nodes/classify.js';
import { buildEscalationAnswer } from './nodes/escalate.js';
import { verifyAnswer } from './nodes/verify.js';
import type {
  AgentState,
  AgentStep,
  ClassifyResult,
  CollieDeps,
  EvidenceChunk,
  RunCollie,
  RunResult,
  ToolCall,
  VerifyResult,
} from './types.js';

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const MAX_REGENERATIONS = 1;

/**
 * 노드 진입 알림 (데모 진행 표시용). onStep이 없으면(평가 하네스) 아무 일도 없다.
 * 표시 때문에 그래프가 죽으면 안 되므로 콜백 예외는 삼킨다.
 */
function emitStep(deps: CollieDeps, step: AgentStep): void {
  try {
    deps.onStep?.(step);
  } catch {
    /* 진행 표시 실패는 답변에 영향 주지 않는다 */
  }
}

const CollieState = Annotation.Root({
  question: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  classify: Annotation<ClassifyResult | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  toolCalls: Annotation<ToolCall[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  evidence: Annotation<EvidenceChunk[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  answer: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  verify: Annotation<VerifyResult | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  escalated: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  regenerated: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
});

type CollieSnapshot = Omit<AgentState, 'question'> & { question: string };

export const runCollie: RunCollie = async (question, deps) => {
  const started = Date.now();
  const threshold = deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  // 노드 이름은 상태 채널(classify·answer·verify)과 같으면 안 된다
  // (langgraph가 채널명과 노드명 충돌을 런타임에 거부한다).
  const graph = new StateGraph(CollieState)
    .addNode('classify_step', async (state) => {
      emitStep(deps, 'classify');
      const classify = await classifyQuestion(state.question, deps.callLlm);
      return { classify };
    })
    .addNode('escalate', (state) => {
      emitStep(deps, 'escalate');
      const classify = state.classify ?? {
        category: 'OUT_OF_SCOPE' as const,
        confidence: 0,
        reason: '분류 없음',
      };
      // 이관도 측정 정본에 남긴다 — outscope 문항의 toolsUsed가 빈 채로 나오지 않게 한다.
      const toolCalls: ToolCall[] = [
        { tool: 'escalate', args: { category: classify.category }, chunkIds: [] },
      ];
      return { answer: buildEscalationAnswer(classify), escalated: true, toolCalls };
    })
    .addNode('assemble_context', async (state) => {
      emitStep(deps, 'assemble');
      const category = state.classify?.category ?? 'OUT_OF_SCOPE';
      const { evidence, toolCalls } = await assembleContext(state.question, category, deps);
      return { evidence, toolCalls };
    })
    .addNode('answer_step', async (state) => {
      // 재생성 판정은 regenerated 카운터가 아니라 verify 실패 여부로 한다.
      // 카운터는 이 노드 종료 시점에 올라가므로, 재생성 진입 시점에는 아직 0이다.
      const retrying = state.verify !== undefined && !state.verify.passed;
      emitStep(deps, retrying ? 'regenerate' : 'answer');
      const category = state.classify?.category ?? 'OUT_OF_SCOPE';
      const answer = await answerQuestion(
        state.question,
        category,
        state.evidence,
        deps.callLlm,
        retrying && state.answer
          ? { previousAnswer: state.answer, violations: state.verify?.violations ?? [] }
          : undefined,
      );
      return {
        answer,
        regenerated: retrying ? state.regenerated + 1 : state.regenerated,
      };
    })
    .addNode('verify_step', (state) => {
      emitStep(deps, 'verify');
      const verify = verifyAnswer(
        state.answer ?? '',
        state.classify?.category ?? 'OUT_OF_SCOPE',
        state.evidence,
        deps.library,
      );
      return { verify };
    })
    .addEdge(START, 'classify_step')
    .addConditionalEdges('classify_step', (state) => {
      // OUT_OF_SCOPE는 신뢰도와 무관하게 이관한다 — 범위 밖은 답하지 않는다.
      if (state.classify?.category === 'OUT_OF_SCOPE') return 'escalate';
      if (state.classify && state.classify.confidence < threshold) return 'escalate';
      return 'assemble_context';
    })
    .addEdge('escalate', END)
    .addEdge('assemble_context', 'answer_step')
    .addEdge('answer_step', 'verify_step')
    .addConditionalEdges('verify_step', (state) => {
      if (state.verify && !state.verify.passed && state.regenerated < MAX_REGENERATIONS) {
        return 'answer_step';
      }
      return END;
    })
    .compile();

  const final = (await graph.invoke({
    question,
    classify: undefined,
    toolCalls: [],
    evidence: [],
    answer: undefined,
    verify: undefined,
    escalated: false,
    regenerated: 0,
  })) as CollieSnapshot;

  const toolsUsed = [...new Set(final.toolCalls.map((t) => t.tool))];
  // evidence 본문과 evidenceIds는 같은 배열에서 나온다 (id 역조회 금지 — 동적 청크는 chunks에 없다).
  const evidence = final.evidence;
  return {
    question,
    category: final.classify?.category ?? 'OUT_OF_SCOPE',
    confidence: final.classify?.confidence ?? 0,
    answer: final.answer ?? '',
    escalated: final.escalated,
    toolsUsed,
    evidenceIds: evidence.map((e) => e.id),
    evidence,
    verify: final.verify ?? { passed: true, violations: [] },
    elapsedMs: Date.now() - started,
  } satisfies RunResult;
};
