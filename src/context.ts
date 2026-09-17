/**
 * questail-collie — CollieDeps 조립 (오케스트레이터 배정 파일)
 *
 * - 청크: docs/_mapping.md 매핑표 + docs 정책 산문 3종을 ## 단위로 쪼개 EvidenceChunk[]로 만든다.
 * - 데이터: core 파서(parseLibraryMarkdown·parseGameNote)를 재사용한다. md 파서를 새로 짜지 않는다.
 * - callLlm: src/llm.ts의 createCallLlm을 주입한다. 직접 구현하지 않는다.
 * - data/mock이 비어 있으면(다른 워커 생성 중) ENOENT를 그대로 던지지 않고
 *   "데이터 미생성" 상태가 드러나는 명확한 메시지로 던진다. 목데이터를 대신 만들지 않는다.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGameNote, parseLibraryMarkdown } from '@questail/core';
import type { LibraryIndex, TasteProfile } from '@questail/core';
import type { CollieDeps, DocId, EvidenceChunk, QueryCategory } from './types.js';
import { createCallLlm } from './llm.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(ROOT, 'docs');
const MOCK_DIR = join(ROOT, 'data', 'mock');

const POLICY_FILE: Record<string, string> = {
  'D-D': 'policy-collection.md',
  'D-E': 'policy-rating.md',
  'D-F': 'glossary-genre.md',
};

const KNOWN_CATEGORIES: readonly string[] = [
  'HISTORY',
  'TASTE',
  'SUBJECTIVE',
  'DATA_OPS',
  'OUT_OF_SCOPE',
];

interface MappingEntry {
  id: string;
  docId: string;
  heading: string;
  categories: QueryCategory[];
}

/** 매핑표 제목("policy-collection 1. 데이터 계층")에서 ##見出し 부분만 떼낸다. */
function mappingTitleToHeading(title: string): string {
  const dot = title.indexOf('. ');
  const raw = dot >= 0 ? title.slice(dot + 2) : title;
  return raw.trim();
}

/** 문서 ##見出し("1. 데이터 계층")에서 앞 번호를 떼어 매칭 키로 만든다. */
function headingKey(heading: string): string {
  return heading.replace(/^\d+\.\s*/, '').trim();
}

/** docs/_mapping.md의 청크 매핑표를 파싱한다. */
export async function loadMapping(): Promise<MappingEntry[]> {
  const md = await readFile(join(DOCS_DIR, '_mapping.md'), 'utf-8');
  const entries: MappingEntry[] = [];
  for (const line of md.split('\n')) {
    const m = /^\|\s*(D-[DEF]#[^\s|]+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (!m) continue;
    const id = m[1] as string;
    const title = m[2] as string;
    const cats = m[3] as string;
    const categories: QueryCategory[] = [];
    for (const tok of cats
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      if ((KNOWN_CATEGORIES as readonly string[]).includes(tok)) {
        categories.push(tok as QueryCategory);
      } else {
        console.warn(`[context] _mapping.md: 알 수 없는 카테고리 '${tok}' (청크 ${id}) — 무시합니다.`);
      }
    }
    entries.push({ id, docId: id.slice(0, 3), heading: mappingTitleToHeading(title), categories });
  }
  return entries;
}

interface DocSection {
  heading: string;
  text: string;
}

/** md를 ## 단위 섹션으로 쪼갠다. 첫 ## 이전 서문은 청크가 아니므로 버린다. */
function splitSections(md: string): DocSection[] {
  const sections: DocSection[] = [];
  let heading: string | null = null;
  let buf: string[] = [];
  for (const line of md.split('\n')) {
    const h = /^##\s+(.*\S)\s*$/.exec(line);
    if (h) {
      if (heading !== null) sections.push({ heading, text: buf.join('\n').trim() });
      heading = h[1] as string;
      buf = [];
    } else if (heading !== null) {
      buf.push(line);
    }
  }
  if (heading !== null) sections.push({ heading, text: buf.join('\n').trim() });
  return sections;
}

/** 매핑표 기준으로 정책 산문 3종을 EvidenceChunk[]로 만든다. */
export async function loadChunks(): Promise<EvidenceChunk[]> {
  const mapping = await loadMapping();
  const byDoc = new Map<string, MappingEntry[]>();
  for (const e of mapping) {
    const arr = byDoc.get(e.docId) ?? [];
    arr.push(e);
    byDoc.set(e.docId, arr);
  }
  const chunks: EvidenceChunk[] = [];
  for (const [docId, file] of Object.entries(POLICY_FILE)) {
    const md = await readFile(join(DOCS_DIR, file), 'utf-8');
    const sections = splitSections(md);
    const byKey = new Map(sections.map((s) => [headingKey(s.heading), s]));
    const wanted = byDoc.get(docId) ?? [];
    for (const e of wanted) {
      const sec = byKey.get(e.heading);
      if (!sec) {
        console.warn(
          `[context] _mapping.md의 '${e.id}'에 대응하는 ## 섹션이 ${file}에 없습니다 — 제외합니다.`,
        );
        continue;
      }
      chunks.push({
        id: e.id,
        docId: docId as DocId,
        heading: sec.heading,
        text: sec.text,
        categories: e.categories,
      });
    }
    for (const s of sections) {
      if (!wanted.some((e) => e.heading === headingKey(s.heading))) {
        console.warn(`[context] ${file}의 ## '${s.heading}'이 _mapping.md에 없습니다 — 제외합니다.`);
      }
    }
  }
  return chunks;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function loadData(): Promise<{ library: LibraryIndex; profile: TasteProfile }> {
  const libraryPath = join(MOCK_DIR, 'library.md');
  const profilePath = join(MOCK_DIR, 'taste-profile.json');
  const gamesDir = join(MOCK_DIR, 'games');
  const missing: string[] = [];
  if (!(await exists(libraryPath))) missing.push('data/mock/library.md');
  if (!(await exists(profilePath))) missing.push('data/mock/taste-profile.json');
  let gameFiles: string[] = [];
  if (await exists(gamesDir)) {
    gameFiles = (await readdir(gamesDir)).filter((f) => f.endsWith('.md'));
    if (gameFiles.length === 0) missing.push('data/mock/games/*.md (디렉터리만 있고 md 없음)');
  } else {
    missing.push('data/mock/games/');
  }
  if (missing.length > 0) {
    throw new Error(
      `[questail-collie] 데이터 미생성 — 다음이 없습니다: ${missing.join(', ')}. ` +
        `data/mock은 다른 워커가 만드는 중이므로 여기서 만들지 않습니다.`,
    );
  }
  const library = parseLibraryMarkdown(await readFile(libraryPath, 'utf-8'));
  // 게임 노트는 core 파서로 읽어 파싱 가능 여부만 검증한다. 개별 조회는 get_game_note 도구가 담당한다.
  let ok = 0;
  for (const f of gameFiles) {
    try {
      parseGameNote(await readFile(join(gamesDir, f), 'utf-8'));
      ok++;
    } catch (err) {
      console.warn(`[context] 게임 노트 파싱 실패: ${f} — ${String(err)}`);
    }
  }
  console.log(`[context] 게임 노트 ${ok}/${gameFiles.length}건 파싱 확인.`);
  const profile = JSON.parse(await readFile(profilePath, 'utf-8')) as TasteProfile;
  return { library, profile };
}

async function loadDeps(): Promise<CollieDeps> {
  const chunks = await loadChunks();
  const { library, profile } = await loadData();
  return { library, profile, chunks, callLlm: createCallLlm() };
}

let cached: CollieDeps | null = null;

/**
 * CollieDeps를 돌려준다.初回에만 디스크에서 읽고 이후에는 캐시를 쓴다.
 * data/mock이 아직 없으면 여기서 "데이터 미생성" 메시지로 실패한다 — import 시점에는 던지지 않는다.
 */
export async function getDeps(): Promise<CollieDeps> {
  if (!cached) cached = await loadDeps();
  return cached;
}
