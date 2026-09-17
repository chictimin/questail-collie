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
import type { RunResult } from './types.js';
import { runCollie } from './graph.js';
import { getDeps } from './context.js';

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
  // RunResult 필드는 그대로 두고, 화면이 요구하는 근거 텍스트만 evidence 로 덧붙인다.
  const evidence = deps.chunks
    .filter((ch) => result.evidenceIds.includes(ch.id))
    .map((ch) => ({
      id: ch.id,
      docId: ch.docId,
      heading: ch.heading,
      text: ch.text,
    }));
  return c.json({ ...result, evidence });
});

const PORT = Number(process.env['PORT'] ?? 3000);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`collie demo: http://localhost:${info.port}`);
});
