import { ANSWER_RULES } from '../prompts.js';
import type {
  CollieDeps,
  EvidenceChunk,
  QueryCategory,
  Violation,
} from '../types.js';

export function formatEvidence(evidence: EvidenceChunk[]): string {
  if (evidence.length === 0) return '(조립된 근거 없음)';
  return evidence.map((e) => `[${e.id}] ${e.heading}\n${e.text}`).join('\n\n');
}

export interface RetryFeedback {
  previousAnswer: string;
  violations: Violation[];
}

/**
 * 조립된 근거만으로 한국어 답변을 만든다.
 * 재생성(verify 탈락 후) 호출이면 위반 사항만 고치도록 피드백을 덧붙인다.
 */
export async function answerQuestion(
  question: string,
  category: QueryCategory,
  evidence: EvidenceChunk[],
  callLlm: CollieDeps['callLlm'],
  retry?: RetryFeedback,
): Promise<string> {
  const parts = [
    `분류: ${category}`,
    `근거:\n${formatEvidence(evidence)}`,
    `질문: ${question}`,
  ];
  if (retry) {
    parts.push(
      '이전 답변은 검수에서 탈락했다. 아래 위반 사항만 고쳐 다시 답하라 (근거 추가 금지):\n' +
        retry.violations.map((v) => `- ${v.rule}: ${v.detail}`).join('\n') +
        `\n이전 답변:\n${retry.previousAnswer}`,
    );
  }
  return callLlm(parts.join('\n\n'), ANSWER_RULES);
}
