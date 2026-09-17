import type {
  ClassifyResult,
  CollieDeps,
  EvidenceChunk,
  QueryCategory,
  ToolCall,
  ToolName,
} from '../types.js';
import { keywordsFrom, routeQuestion } from './router.js';
import { executeTool, type SelectedCall } from './tools.js';

const KNOWN_TOOLS: readonly ToolName[] = [
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

const MAX_CALLS = 4;

export interface AssembledContext {
  evidence: EvidenceChunk[];
  toolCalls: ToolCall[];
}

/** LLM 선택이 비면 카테고리 기본 도구 1개로 폴백한다 (라우터 예외 시 최후 수단). */
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
  if (!Array.isArray(raw)) return [];
  const out: SelectedCall[] = [];
  for (const item of raw.slice(0, MAX_CALLS)) {
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
 * 결정적 라우터에 위임한다. LLM을 부르지 않는다.
 * 라우터가 던지면(데이터 미생성 등) 카테고리 기본값으로 폴백한다.
 */
export async function selectToolCalls(
  question: string,
  classify: ClassifyResult,
  deps: CollieDeps,
): Promise<SelectedCall[]> {
  try {
    const calls = sanitizeCalls(await routeQuestion(question, classify, deps));
    return calls.length > 0 ? calls : fallbackCalls(classify.category, question);
  } catch {
    return fallbackCalls(classify.category, question);
  }
}

/**
 * 선택된 도구만 실행하고, 실행한 것만 ToolCall로 기록한다.
 * OUT_OF_SCOPE는 근거를 조립하지 않는다 (escalate 경로).
 */
export async function assembleContext(
  question: string,
  classify: ClassifyResult,
  deps: CollieDeps,
): Promise<AssembledContext> {
  if (classify.category === 'OUT_OF_SCOPE') return { evidence: [], toolCalls: [] };
  const calls = await selectToolCalls(question, classify, deps);
  const evidence: EvidenceChunk[] = [];
  const toolCalls: ToolCall[] = [];
  for (const c of calls) {
    if (c.tool === 'escalate') {
      toolCalls.push({ tool: c.tool, args: c.args, chunkIds: [] });
      continue;
    }
    const chunks = await executeTool(c.tool, c.args, deps, classify.category);
    evidence.push(...chunks);
    toolCalls.push({ tool: c.tool, args: c.args, chunkIds: chunks.map((e) => e.id) });
  }
  return { evidence, toolCalls };
}
