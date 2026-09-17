import type { ClassifyResult } from '../types.js';

/** 저신뢰 분류의 이관 답변. 고정 문구 — LLM을 거치지 않는다. */
export function buildEscalationAnswer(classify: ClassifyResult): string {
  return (
    `이 질문에는 확실하게 답하기 어려워 이관한다. ` +
    `(분류: ${classify.category}, 신뢰도: ${classify.confidence})`
  );
}
