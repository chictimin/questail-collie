/**
 * 실제 실행되는 도구 4개. 전부 CollieDeps 주입 데이터에서 조회하며 외부 I/O는
 * 게임 노트 스캔(디스크 1회 캐시)뿐이다. 호출되지 않은 도구는 기록에 남지 않는다.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { extractSubjectiveFields, parseGameNote } from '@questail/core';
import type {
  CollieDeps,
  DocId,
  EvidenceChunk,
  LibraryIndex,
  NormalizedGame,
  QueryCategory,
  TasteProfile,
  ToolName,
} from '../types.js';

export interface SelectedCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

/** 공백 제거·소문자 정규화. "엘든링"과 "엘든 링"을 같은 것으로 본다. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** 질문 속에 게임명이 그대로 들어 있어도 매칭되게 양방향 부분일치. */
function titleMatches(title: string, keyword: string): boolean {
  const t = norm(title);
  const k = norm(keyword);
  if (t === '' || k === '') return false;
  return t.includes(k) || k.includes(t);
}

function renderRow(g: NormalizedGame): string {
  const parts = [`${g.title} (${g.platform}/${g.id})`, `플레이타임 ${g.playtimeMinutes}분`];
  if (g.achievementPercent !== undefined) parts.push(`업적 ${g.achievementPercent}%`);
  if (g.genres && g.genres.length > 0) parts.push(`장르 ${g.genres.join(', ')}`);
  if (g.lastPlayedAt !== undefined) {
    // lastPlayedAt 정본은 초 단위(Unix timestamp). 2100년을 넘는 값만
    // 밀리초 오기입으로 보고 예외 처리한다. 표시는 YYYY-MM-DD로 통일.
    const ms = g.lastPlayedAt > 4102444800 ? g.lastPlayedAt : g.lastPlayedAt * 1000;
    parts.push(`마지막 플레이 ${new Date(ms).toISOString().slice(0, 10)}`);
  }
  return parts.join(' | ');
}

// ── lookup_library ──────────────────────────────────────────────────────────

export interface LookupArgs {
  titleOrKeyword?: string;
  genre?: string;
  emptyGenre?: boolean;
  topByPlaytime?: number;
}

function parseLookupArgs(args: Record<string, unknown>): LookupArgs {
  const out: LookupArgs = {};
  const kw = strArg(args, 'titleOrKeyword');
  if (kw) out.titleOrKeyword = kw;
  const genre = strArg(args, 'genre');
  if (genre) out.genre = genre;
  if (args.emptyGenre === true) out.emptyGenre = true;
  const top = args.topByPlaytime;
  if (typeof top === 'number' && Number.isFinite(top) && top > 0) {
    out.topByPlaytime = Math.min(50, Math.floor(top));
  }
  return out;
}

/**
 * 매칭된 행만 반환한다. 필터가 하나도 없으면 빈 결과를 낸다
 * (전체 테이블 반환 금지).
 */
export function runLookupLibrary(
  rawArgs: Record<string, unknown>,
  library: LibraryIndex,
  category: QueryCategory,
): EvidenceChunk[] {
  const args = parseLookupArgs(rawArgs);
  let rows = library.games;
  if (args.titleOrKeyword) {
    rows = rows.filter((g) => titleMatches(g.title, args.titleOrKeyword as string));
  }
  if (args.genre) {
    const ng = norm(args.genre);
    rows = rows.filter((g) => (g.genres ?? []).some((x) => {
      const nx = norm(x);
      return nx.includes(ng) || ng.includes(nx);
    }));
  }
  if (args.emptyGenre) {
    rows = rows.filter((g) => !g.genres || g.genres.length === 0);
  }
  if (args.topByPlaytime !== undefined) {
    rows = [...rows].sort((a, b) => b.playtimeMinutes - a.playtimeMinutes).slice(0, args.topByPlaytime);
  }
  const id = (i: number): string => `D-A#lookup:${i}`;
  if (rows.length === 0) {
    return [{
      id: id(0),
      docId: 'D-A' as DocId,
      categories: [category],
      heading: '라이브러리 조회 결과 없음',
      text: `lookup_library: 조건에 맞는 게임이 없다 (${JSON.stringify(args)})`,
    }];
  }
  const capped = rows.slice(0, 20);
  const more = rows.length > capped.length ? `\n외 ${rows.length - capped.length}건 생략` : '';
  return [{
    id: id(0),
    docId: 'D-A' as DocId,
    categories: [category],
    heading: `라이브러리 조회 ${rows.length}건`,
    text: capped.map(renderRow).join('\n') + more,
  }];
}

// ── get_game_note ───────────────────────────────────────────────────────────

interface NoteEntry {
  title: string;
  gameId: string;
  rating?: number;
  status?: string;
  note?: string;
  dislikeReasons?: string[];
}

let noteCache: NoteEntry[] | null = null;

function gamesDir(): string {
  return resolve('data', 'mock', 'games');
}

async function loadNoteEntries(): Promise<NoteEntry[]> {
  if (noteCache) return noteCache;
  const dir = gamesDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
  } catch {
    throw new Error(`[tools] 게임 노트 디렉터리가 없다: ${dir}`);
  }
  const entries: NoteEntry[] = [];
  for (const f of files) {
    try {
      const parsed = parseGameNote(await readFile(join(dir, f), 'utf-8'));
      const fm = parsed.frontmatter;
      const sub = extractSubjectiveFields(parsed);
      entries.push({
        title: typeof fm.title === 'string' ? fm.title : '',
        gameId: typeof fm.game_id === 'string' ? fm.game_id : '',
        rating: sub.rating,
        status: sub.status,
        note: sub.note,
        dislikeReasons: sub.dislikeReasons,
      });
    } catch {
      continue;
    }
  }
  noteCache = entries;
  return entries;
}

/** 해당 게임 1건의 주관 필드만 반환. 없으면 "노트 없음". */
export async function runGameNote(
  rawArgs: Record<string, unknown>,
  category: QueryCategory,
): Promise<EvidenceChunk[]> {
  const q = strArg(rawArgs, 'titleOrAppid') ?? '';
  const entries = await loadNoteEntries();
  const hit = entries.find(
    (e) =>
      (e.gameId !== '' && e.gameId === q) ||
      (e.title !== '' && titleMatches(e.title, q)),
  );
  const mk = (heading: string, text: string): EvidenceChunk => ({
    id: `D-B#note:${norm(hit?.title ?? q) || 'unknown'}`,
    docId: 'D-B' as DocId,
    categories: [category],
    heading,
    text,
  });
  if (!hit) return [mk('노트 없음', `get_game_note: "${q}"에 해당하는 게임 노트가 없다`)];
  const lines = [`${hit.title} 노트`];
  if (hit.rating !== undefined) lines.push(`별점: ${hit.rating}`);
  if (hit.status !== undefined) lines.push(`상태: ${hit.status}`);
  if (hit.note !== undefined) lines.push(`한줄평: ${hit.note}`);
  if (hit.dislikeReasons !== undefined) lines.push(`기피 사유: ${hit.dislikeReasons.join(', ')}`);
  if (lines.length === 1) lines.push('주관 기록 없음');
  return [mk(`${hit.title} 주관 기록`, lines.join('\n'))];
}

// ── get_taste_profile ───────────────────────────────────────────────────────

export function runTasteProfile(profile: TasteProfile, category: QueryCategory): EvidenceChunk[] {
  const lines = ['취향 프로필 요약'];
  lines.push(`상위 장르: ${profile.topGenres.slice(0, 5).map((g) => `${g.genre} ${g.weight}`).join(', ')}`);
  const d = profile.playtimeDistribution;
  lines.push(`플레이타임 분포(분): 최소 ${d.min} · Q1 ${d.q1} · 중앙 ${d.median} · Q3 ${d.q3} · 최대 ${d.max}`);
  lines.push(`위시리스트: ${profile.wishlistAppIds?.length ?? 0}건`);
  if (profile.dislikedGenres && profile.dislikedGenres.length > 0) {
    lines.push(`기피 장르: ${profile.dislikedGenres.join(', ')}`);
  }
  if (profile.ratingPlaytimeGaps && profile.ratingPlaytimeGaps.length > 0) {
    lines.push(
      `별점-플레이 갭 상위: ${profile.ratingPlaytimeGaps.slice(0, 3).map((g) => `${g.gameId} ${g.gap}`).join(', ')}`,
    );
  }
  return [{
    id: 'D-C#profile',
    docId: 'D-C' as DocId,
    categories: [category],
    heading: '취향 프로필',
    text: lines.join('\n'),
  }];
}

// ── search_docs ─────────────────────────────────────────────────────────────

function parseKeywords(rawArgs: Record<string, unknown>): string[] {
  const v = rawArgs.keywords;
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const k of v) {
    if (typeof k === 'string' && k.trim() !== '' && !out.includes(k.trim())) out.push(k.trim());
    if (out.length >= 8) break;
  }
  return out;
}

/** 카테고리 1차 필터 후 키워드 점수 상위 3청크만. 카테고리 전체 투입 금지. */
export function runSearchDocs(
  rawArgs: Record<string, unknown>,
  deps: CollieDeps,
  category: QueryCategory,
): EvidenceChunk[] {
  const keywords = parseKeywords(rawArgs).map((k) => k.toLowerCase());
  if (keywords.length === 0) return [];
  const scored = deps.chunks
    .filter((c) => c.categories.includes(category))
    .map((c) => {
      const hay = `${c.heading}\n${c.text}`.toLowerCase();
      let score = 0;
      for (const k of keywords) {
        let i = hay.indexOf(k);
        while (i >= 0) {
          score++;
          i = hay.indexOf(k, i + k.length);
        }
      }
      return { c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return scored.map((s) => s.c);
}

// ── 실행기 ──────────────────────────────────────────────────────────────────

export async function executeTool(
  tool: ToolName,
  args: Record<string, unknown>,
  deps: CollieDeps,
  category: QueryCategory,
): Promise<EvidenceChunk[]> {
  switch (tool) {
    case 'lookup_library':
      return runLookupLibrary(args, deps.library, category);
    case 'get_game_note':
      return runGameNote(args, category);
    case 'get_taste_profile':
      return runTasteProfile(deps.profile, category);
    case 'search_docs':
      return runSearchDocs(args, deps, category);
    case 'escalate':
      return [];
  }
}
