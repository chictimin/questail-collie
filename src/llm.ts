/**
 * OpenAI 호환 엔드포인트 호출.
 * 실제 HTTP 호출은 @questail/core의 llm 헬퍼(callLlm)에 위임한다
 * (타임아웃·재시도·thinking 제거·JSON 추출 중복 구현 금지).
 * 이 파일은 환경 해석 + CollieDeps.callLlm 시그니처 적응만 담당한다.
 */

import { config as loadDotenv } from 'dotenv';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callLlm as coreCallLlm, getLlmOptions } from '@questail/core';
import type { CollieDeps } from './types.js';

/** 로컬 Ollama 기본값 (과제 지정). */
export const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_MODEL = 'qwen3:8b';

let envLoaded = false;

/** 전역 ~/.config/questail/.env 먼저, 로컬 .env를 덮어쓰기로 읽는다. */
export function loadLlmEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  loadDotenv({ path: join(homedir(), '.config', 'questail', '.env') });
  loadDotenv({ path: '.env', override: true });
}

export interface LlmEndpoint {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** QUESTAIL_LLM_* 환경변수 → 없으면 로컬 Ollama 기본값. */
export function resolveLlmEndpoint(): LlmEndpoint {
  loadLlmEnv();
  const q = getLlmOptions();
  const baseUrl = q.baseUrl?.trim() || DEFAULT_BASE_URL;
  const model = q.model?.trim() || DEFAULT_MODEL;
  return { baseUrl, apiKey: q.apiKey, model };
}

/**
 * CollieDeps.callLlm 어댑터. core callLlm에는 system 인자가 없어
 * system 프롬프트는 본문 앞에 이어붙인다.
 */
export function createCallLlm(): CollieDeps['callLlm'] {
  const endpoint = resolveLlmEndpoint();
  return (prompt: string, system?: string): Promise<string> =>
    coreCallLlm(endpoint, system ? `${system}\n\n${prompt}` : prompt);
}
