import { extractJsonPayload } from '@questail/core';
import { CLASSIFY_SYSTEM } from '../prompts.js';
import {
  CATEGORIES,
  type ClassifyResult,
  type CollieDeps,
  type QueryCategory,
} from '../types.js';

function isCategory(value: unknown): value is QueryCategory {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

function toConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * 질문을 QueryCategory 하나로 판정한다.
 * 분류만 하고 이관 판단은 하지 않는다 — 임계값 비교는 그래프의 조건 분기가 맡는다.
 * 파싱 실패 시 fail-safe로 confidence 0을 내어 이관 경로로 보낸다.
 */
export async function classifyQuestion(
  question: string,
  callLlm: CollieDeps['callLlm'],
): Promise<ClassifyResult> {
  try {
    const raw = await callLlm(`질문: ${question}`, CLASSIFY_SYSTEM);
    const parsed: unknown = JSON.parse(extractJsonPayload(raw));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('JSON 객체 아님');
    const rec = parsed as Record<string, unknown>;
    if (!isCategory(rec.category)) {
      return { category: 'OUT_OF_SCOPE', confidence: 0, reason: '분류값 파싱 실패' };
    }
    const reason = typeof rec.reason === 'string' ? rec.reason : '';
    return { category: rec.category, confidence: toConfidence(rec.confidence), reason };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { category: 'OUT_OF_SCOPE', confidence: 0, reason: `분류 실패: ${detail}` };
  }
}
