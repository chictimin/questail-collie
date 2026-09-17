import { extractJsonPayload } from '@questail/core';
import { TOOL_SELECT_SYSTEM } from '../prompts.js';
import type {
  CollieDeps,
  EvidenceChunk,
  QueryCategory,
  ToolCall,
  ToolName,
} from '../types.js';
import { executeTool, type SelectedCall } from './tools.js';

const KNOWN_TOOLS: readonly ToolName[] = [
  'lookup_library',
  'get_game_note',
  'get_taste_profile',
  'search_docs',
];

const MAX_CALLS = 4;

export interface AssembledContext {
  evidence: EvidenceChunk[];
  toolCalls: ToolCall[];
}

/** 질문에서 2자 이상 토큰을 뽑는다. DATA_OPS 폴백용. */
function keywordsFrom(question: string): string[] {
  const out: string[] = [];
  for (const tok of question.split(/[^\p{L}\p{N}]+/gu)) {
    if (tok.length >= 2 && !out.includes(tok)) out.push(tok);
    if (out.length >= 8) break;
  }
  return out;
}

/** LLM 선택이 비면 카테고리 기본 도구 1개로 폴백한다. */
function fallbackCalls(category: QueryCategory, question: string): SelectedCall[] {
  switch (category) {
    case 'HISTORY':
      return [{ tool: 'lookup_library', args: { titleOrKeyword: question } }];
    case 'TASTE':
      return [{ tool: 'get_taste_profile', args: {} }];
    case 'SUBJECTIVE':
      return [{ tool: 'get_game_note', args: { titleOrAppid: question } }];
    case 'DATA_OPS':
      return [{ tool: 'search_docs', args: { keywords: keywordsFrom(question) } }];
    case 'OUT_OF_SCOPE':
      return [];
  }
}

function sanitizeCalls(raw: unknown): SelectedCall[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const rec = raw as Record<string, unknown>;
  if (!Array.isArray(rec.calls)) return [];
  const out: SelectedCall[] = [];
  for (const item of rec.calls.slice(0, MAX_CALLS)) {
    if (typeof item !== 'object' || item === null) continue;
    const { tool, args } = item as Record<string, unknown>;
    if (typeof tool !== 'string') continue;
    if (!(KNOWN_TOOLS as readonly string[]).includes(tool)) continue;
    out.push({
      tool: tool as ToolName,
      args: typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {},
    });
  }
  return out;
}

/**
 * LLM이 도구+인자를 정한다. 카테고리는 힌트용. 선택은 1회만 하고
 * 파싱 실패·빈 결과면 카테고리 기본값으로 폴백한다 (재시도·루프 없음).
 */
export async function selectToolCalls(
  question: string,
  category: QueryCategory,
  deps: CollieDeps,
): Promise<SelectedCall[]> {
  try {
    const raw = await deps.callLlm(
      `분류 힌트: ${category}\n질문: ${question}`,
      TOOL_SELECT_SYSTEM,
    );
    const parsed: unknown = JSON.parse(extractJsonPayload(raw));
    const calls = sanitizeCalls(parsed);
    return calls.length > 0 ? calls : fallbackCalls(category, question);
  } catch {
    return fallbackCalls(category, question);
  }
}

/**
 * 선택된 도구만 실행하고, 실행한 것만 ToolCall로 기록한다.
 * OUT_OF_SCOPE는 근거를 조립하지 않는다 (escalate 경로).
 */
export async function assembleContext(
  question: string,
  category: QueryCategory,
  deps: CollieDeps,
): Promise<AssembledContext> {
  if (category === 'OUT_OF_SCOPE') return { evidence: [], toolCalls: [] };
  const calls = await selectToolCalls(question, category, deps);
  const evidence: EvidenceChunk[] = [];
  const toolCalls: ToolCall[] = [];
  for (const c of calls) {
    const chunks = await executeTool(c.tool, c.args, deps, category);
    evidence.push(...chunks);
    toolCalls.push({ tool: c.tool, args: c.args, chunkIds: chunks.map((e) => e.id) });
  }
  return { evidence, toolCalls };
}
