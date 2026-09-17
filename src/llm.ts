/**
 * OpenAI 호환 엔드포인트 호출.
 * 실제 HTTP 호출은 @questail/core의 llm 헬퍼(callLlm)에 위임한다
 * (타임아웃·재시도·thinking 제거·JSON 추출 중복 구현 금지).
 * 이 파일은 환경 해석 + CollieDeps.callLlm 시그니처 적응만 담당한다.
 */

import { config as loadDotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callLlm as coreCallLlm, getLlmOptions, isLocalhostUrl } from '@questail/core';
import type { CollieDeps } from './types.js';

/**
 * OpenCode Go 기본값 (일반 zen `/zen/v1`이 아니다 — 그쪽은 크레딧 기반).
 * QUESTAIL_LLM_BASE_URL / QUESTAIL_LLM_MODEL 환경변수로 덮어쓸 수 있다.
 * 로컬 Ollama 대체 경로(채점자용): QUESTAIL_LLM_BASE_URL=http://localhost:11434/v1,
 * QUESTAIL_LLM_MODEL=qwen3:8b 로 두면 키 없이도 동작한다.
 */
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_MODEL = 'mimo-v2.5';

/** Go 게이트웨이 필수 식별 헤더값 (표준 SDK 이름이 아닌 자체 식별자). */
export const LLM_USER_AGENT = 'questail-collie/0.1';

/**
 * 프로세스 1회 실행 동안 안정적인 세션 ID 하나.
 * 매 호출 새로 만들면 라우팅·프롬프트 캐싱 이점이 사라지므로
 * 모듈 로드 시 1회만 생성한다.
 */
const SESSION_ID = randomUUID();

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

/** QUESTAIL_LLM_* 환경변수 → 없으면 OpenCode Go 기본값. */
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
 * Go 게이트웨이 필수 헤더 2개를 core headers 옵션으로 넘긴다.
 * API 키는 환경변수(QUESTAIL_LLM_API_KEY)로만 받는다 — 코드에 넣지 않는다.
 * 로컬호스트 대체 경로(Ollama)는 키 없이도 통과한다.
 */
export function createCallLlm(): CollieDeps['callLlm'] {
  const endpoint = resolveLlmEndpoint();
  if (!endpoint.apiKey && !isLocalhostUrl(endpoint.baseUrl)) {
    throw new Error(
      'LLM API 키가 없습니다. QUESTAIL_LLM_API_KEY 환경변수(전역 ~/.config/questail/.env 또는 저장소 .env)에 설정하십시오.',
    );
  }
  return (prompt: string, system?: string): Promise<string> =>
    coreCallLlm(
      {
        ...endpoint,
        headers: {
          'x-opencode-session': SESSION_ID,
          'User-Agent': LLM_USER_AGENT,
        },
      },
      system ? `${system}\n\n${prompt}` : prompt,
    );
}
