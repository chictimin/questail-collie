/**
 * questail-collie — 데모 서버 (오케스트레이터 배정 파일)
 *
 * Hono + @hono/node-server. 의존성 조립은 ./context.js 의 getDeps()가 담당한다.
 */
import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentStep, RunResult } from './types.js';
import { runCollie } from './graph.js';
import { getDeps } from './context.js';
import { resolveLlmEndpoint } from './llm.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'public', 'index.html');

const app = new Hono();

app.get('/', async (c) => {
  const html = await readFile(INDEX, 'utf-8');
  return c.html(html);
});

app.post('/api/ask', async (c) => {
  const body = await c.req
    .json<{ question?: unknown }>()
    .catch((): { question?: unknown } => ({}));
  if (typeof body.question !== 'string' || body.question.trim() === '') {
    return c.json({ error: 'question(문자열)이 필요합니다.' }, 400);
  }
  let deps;
  try {
    deps = await getDeps();
  } catch (err) {
    // data/mock 미생성 등 의존성 조립 실패 — 메시지를 그대로 돌려준다.
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
  const result: RunResult = await runCollie(body.question, deps);
  // 근거 본문은 RunResult.evidence에 들어 있다 (id 역조회 금지 — 동적 청크는 chunks에 없다).
  return c.json(result);
});

/**
 * 스트리밍 질의. Server-Sent Events로 실제 노드 진입 시점의 단계와 최종 결과를 보낸다.
 * - {"type":"step","step":"classify"|...} — onStep 콜백이 불릴 때마다
 * - {"type":"done","result":{...}} — 기존 /api/ask가 주던 JSON 그대로
 * - {"type":"error","message":"..."} — 실패 시
 * getDeps() 캐시 객체를 변형하지 않고 스프레드로 복사해 onStep만 얹는다.
 */
app.post('/api/ask/stream', async (c) => {
  const body = await c.req
    .json<{ question?: unknown }>()
    .catch((): { question?: unknown } => ({}));
  if (typeof body.question !== 'string' || body.question.trim() === '') {
    return c.json({ error: 'question(문자열)이 필요합니다.' }, 400);
  }
  const question = body.question;
  let baseDeps;
  try {
    baseDeps = await getDeps();
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown): void => {
      // onStep은 동기 콜백이라 await할 수 없다. 전송 실패(클라이언트 이탈 등)는 무시한다.
      stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
    };
    try {
      const result: RunResult = await runCollie(question, {
        ...baseDeps,
        onStep: (step: AgentStep) => send('step', { type: 'step', step }),
      });
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ type: 'done', result }) });
    } catch (err) {
      await stream
        .writeSSE({
          event: 'error',
          data: JSON.stringify({ type: 'error', message: String(err instanceof Error ? err.message : err) }),
        })
        .catch(() => {});
    }
  });
});

/**
 * 읽기 전용 연결 정보. 실제로 쓰는 엔드포인트·모델만 돌려준다.
 * API 키는 절대 반환하지 않는다 — 두 필드를 명시적으로 뽑는다.
 */
app.get('/api/meta', (c) => {
  const endpoint = resolveLlmEndpoint();
  return c.json({ baseUrl: endpoint.baseUrl, model: endpoint.model });
});

const PORT = Number(process.env['PORT'] ?? 3000);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`collie demo: http://localhost:${info.port}`);
});
