#!/usr/bin/env node
/**
 * questail-collie 목데이터 생성기.
 *
 * - 외부 의존성 없음 (node 내장 모듈만). `node scripts/gen-mock.mjs` 로 바로 실행.
 * - 난수 seed 고정: 몇 번을 돌려도 바이트 단위로 같은 결과가 나온다.
 * - 출력 형식은 @questail/core 의 renderLibraryMarkdown / serializeGameNote +
 *   formatFrontmatter 출력을 그대로 재현한다 (파서 왕복 보장).
 *   단, core 를 import 하지 않는다 (pnpm install 없이도 돌아가야 하므로).
 *   형식 검증은 별도 단계에서 설치된 @questail/core 파서로 수행한다.
 * - 값 정책: 게임명·appid·장르만 실제 Steam 공개 정보를 쓰고,
 *   플레이타임·별점·상태·기피사유·일시 등 나머지 모든 값은 합성이다.
 *   실사용자 데이터는 이 저장소에 절대 들어오지 않는다.
 *
 * 출력:
 *   data/mock/library.md            보유 120건 (객관 정본)
 *   data/mock/games/*.md            보유 120건 + 위시 51건 = 171개 노트
 *   data/mock/taste-profile.json    라이브러리로부터 계산 (손 상수 없음)
 *   data/mock/META.md               생성 기록·오차·함정 위치·합성 고지
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 고정 상수
/** 난수 seed — 바꾸면 전체 산출물이 달라지므로 고정. */
const SEED = 20260917;
/**
 * library.md generated_at 고정값 (2026-08-17T00:00:00.000Z).
 * Date.now() 를 쓰면 실행마다 바이트가 달라져 재현성이 깨지므로 상수로 둔다.
 * 실제 실행 시각은 META.md 에 별도 기록한다.
 */
const GENERATED_AT = 1786924800000;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_DIR = join(ROOT, 'data', 'mock');
const GAMES_DIR = join(MOCK_DIR, 'games');

// 목표 분포 (실측 참고값)
const TARGET_Q1 = 163;
const TARGET_MEDIAN = 1170;
const TARGET_Q3 = 3837;
const TARGET_TOP20_SHARE = 0.668;
const TARGET_GENRES = {
  '액션': 0.217,
  '어드벤처': 0.189,
  'RPG': 0.182,
  '인디': 0.160,
  '전략': 0.093,
  '시뮬레이션': 0.060,
  '캐주얼': 0.050,
  '대규모 멀티플레이어': 0.022,
  '레이싱': 0.015,
  '스포츠': 0.012,
};

// ---------------------------------------------------------------- RNG (mulberry32)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 원천 목록
// [제목, appid(문자열), 장르]. 장르 순서는 대표 장르가 먼저 오게 둔다.
// genres 가 빈 배열이면 "메타 누락" 함정 케이스 (4건으로 고정).
const OWNED = [
  ['Counter-Strike 2', '730', ['액션']],
  ['Team Fortress 2', '440', ['액션']],
  ['Left 4 Dead 2', '550', ['액션']],
  ['PUBG: BATTLEGROUNDS', '578080', ['액션', '어드벤처', '대규모 멀티플레이어']],
  ['Apex Legends', '1172470', ['액션']],
  ['Titanfall 2', '1237970', ['액션']],
  ['DOOM Eternal', '782330', ['액션']],
  ['Devil May Cry 5', '601150', ['액션']],
  ['Hades', '1145360', ['액션', '인디', 'RPG']],
  ['Dead Cells', '588650', ['액션', '인디']],
  ['Hollow Knight', '367520', ['액션', '어드벤처', '인디']],
  ['Celeste', '504230', ['액션', '인디']],
  ['Katana ZERO', '956510', ['액션', '인디']],
  ['Hotline Miami', '219150', ['액션', '인디']],
  ['Grand Theft Auto V', '271590', ['액션', '어드벤처']],
  ['Red Dead Redemption 2', '1174180', ['액션', '어드벤처']],
  ['God of War', '1593500', ['액션', '어드벤처']],
  ['Horizon Zero Dawn Complete Edition', '1151640', ['액션', '어드벤처', 'RPG']],
  ["Ghost of Tsushima DIRECTOR'S CUT", '2215430', ['액션', '어드벤처']],
  ['Control Ultimate Edition', '870780', ['액션', '어드벤처']],
  ['Resident Evil 4', '2050650', ['액션', '어드벤처']],
  ['Resident Evil 2', '883710', ['액션', '어드벤처']],
  ['Dead Space', '1693980', ['액션', '어드벤처']],
  ['Sekiro: Shadows Die Twice', '814380', ['액션', '어드벤처']],
  ['Monster Hunter: World', '582010', ['액션', 'RPG']],
  ['ELDEN RING', '1245620', ['액션', 'RPG']],
  ['Dark Souls III', '374320', ['액션', 'RPG']],
  ['Black Myth: Wukong', '2358720', ['액션', 'RPG']],
  ['Remnant II', '1282100', ['액션', 'RPG']],
  ['Warframe', '230410', ['액션', 'RPG', '대규모 멀티플레이어']],
  ['Destiny 2', '1085660', ['액션', '어드벤처', '대규모 멀티플레이어']],
  ['Borderlands 3', '397540', ['액션', 'RPG']],
  ['Deep Rock Galactic', '548430', ['액션']],
  ['HELLDIVERS 2', '553850', ['액션']],
  ['Vampire Survivors', '1794680', ['액션', '캐주얼', '인디', 'RPG']],
  ['Brotato', '1942280', ['액션', '인디']],
  ['Risk of Rain 2', '632360', ['액션', '인디']],
  ['Enter the Gungeon', '311690', ['액션', '인디']],
  ['Cuphead', '268910', ['액션', '인디']],
  ['Ori and the Will of the Wisps', '1057090', ['액션', '어드벤처']],
  ['Metal Gear Solid V: The Phantom Pain', '287700', ['액션', '어드벤처']],
  ['HITMAN World of Assassination', '1659040', ['액션', '어드벤처']],
  ['Dishonored 2', '403640', ['액션', '어드벤처']],
  ['Dying Light', '239140', ['액션', '어드벤처', 'RPG']],
  ['Far Cry 5', '552520', ['액션', '어드벤처']],
  ["Assassin's Creed Odyssey", '812140', ['액션', '어드벤처', 'RPG']],
  ['Terraria', '105600', ['액션', '어드벤처', '인디', 'RPG']],
  ['Portal 2', '620', ['액션', '어드벤처']],
  ['It Takes Two', '1426210', ['액션', '어드벤처']],
  ['The Witcher 3: Wild Hunt', '292030', ['어드벤처', 'RPG']],
  ['Cyberpunk 2077', '1091500', ['RPG']],
  ["Baldur's Gate 3", '1086940', ['어드벤처', 'RPG', '전략']],
  ['Divinity: Original Sin 2', '435150', ['어드벤처', 'RPG', '전략']],
  ['Disco Elysium', '632470', ['RPG']],
  ['Pillars of Eternity', '291650', ['RPG']],
  ['Fallout: New Vegas', '22380', ['RPG']],
  ['Fallout 4', '377160', ['RPG']],
  ['The Elder Scrolls V: Skyrim Special Edition', '489830', ['어드벤처', 'RPG']],
  ['Mass Effect Legendary Edition', '1328670', ['RPG']],
  ['Persona 5 Royal', '1687950', ['RPG']],
  ['Sea of Stars', '1244090', ['어드벤처', '인디', 'RPG']],
  ['Chained Echoes', '1574090', ['인디', 'RPG']],
  ['Undertale', '391540', ['인디', 'RPG']],
  ['OMORI', '1150690', ['RPG']],
  ['Stardew Valley', '413150', ['인디', 'RPG', '시뮬레이션']],
  ["Don't Starve Together", '322330', ['어드벤처', '인디']],
  ['Subnautica', '264710', ['어드벤처', '인디']],
  ['Subnautica: Below Zero', '848450', ['어드벤처', '인디']],
  ['Outer Wilds', '753640', ['어드벤처', '인디']],
  ['The Sims 4', '1222670', ['캐주얼', '시뮬레이션']],
  ['Life is Strange', '319630', ['어드벤처']],
  ['The Outer Worlds', '578650', ['어드벤처', 'RPG']],
  ['South Park: The Stick of Truth', '213670', ['어드벤처', 'RPG']],
  ['XCOM 2', '268500', ['전략']],
  ["Sid Meier's Civilization VI", '289070', ['전략']],
  ['Crusader Kings III', '1158310', ['RPG', '전략']],
  ['Europa Universalis IV', '236850', ['시뮬레이션', '전략']],
  ['Stellaris', '281990', ['시뮬레이션', '전략']],
  ['Total War: WARHAMMER III', '1142710', ['전략']],
  ['Age of Empires IV: Anniversary Edition', '1466860', ['전략']],
  ['Trackmania', '2225070', ['레이싱', '스포츠']],
  ['Slay the Spire', '646570', ['인디', '전략']],
  ['Darkest Dungeon', '262060', ['인디', 'RPG', '전략']],
  ['RimWorld', '294100', ['인디', '시뮬레이션', '전략']],
  ['Factorio', '427520', ['인디', '전략']],
  ['Oxygen Not Included', '457140', ['인디', '시뮬레이션']],
  ['Cities: Skylines', '255710', ['시뮬레이션', '전략']],
  ['Planet Zoo', '703080', ['시뮬레이션', '전략']],
  ['Two Point Hospital', '535930', ['시뮬레이션', '전략']],
  ['Frostpunk', '323190', ['시뮬레이션', '전략']],
  ['Against the Storm', '1336490', ['인디', '전략']],
  ['Fall Guys', '1097150', ['캐주얼', '대규모 멀티플레이어', '스포츠']],
  ['FTL: Faster Than Light', '212680', ['인디', '전략']],
  ['Papers, Please', '239030', ['어드벤처', '인디']],
  ['Return of the Obra Dinn', '653530', ['어드벤처', '인디']],
  ['DAVE THE DIVER', '1868140', ['어드벤처', '캐주얼', 'RPG']],
  ['Dredge', '1562430', ['어드벤처', '인디', 'RPG']],
  ['Balatro', '2379780', ['인디', '전략']],
  ['Unpacking', '1135690', ['캐주얼', '인디', '시뮬레이션']],
  ['PowerWash Simulator', '1290000', ['캐주얼', '인디', '시뮬레이션']],
  ['Euro Truck Simulator 2', '227300', ['인디', '시뮬레이션']],
  ['Microsoft Flight Simulator', '1250410', ['시뮬레이션']],
  ['Forza Horizon 5', '1551360', ['레이싱']],
  ['DiRT Rally 2.0', '690790', ['레이싱', '스포츠']],
  ['Football Manager 2024', '2252570', ['스포츠', '전략']],
  ['Cozy Grove', '1458100', ['어드벤처', '캐주얼', '인디', '시뮬레이션']],
  ['Among Us', '945360', ['캐주얼', '인디']],
  ['Pummel Party', '880940', ['캐주얼', '인디']],
  ['Persona 3 Reload', '2161700', ['RPG']],
  ['Metaphor: ReFantazio', '2679460', ['RPG']],
  ['DRAGON QUEST XI S', '1295510', ['RPG']],
  ['Stray', '1332010', ['어드벤처', '인디']],
  ['Cocoon', '1497440', ['어드벤처', '인디']],
  ['Jusant', '1977170', ['어드벤처']],
  ['Viewfinder', '1382070', ['어드벤처', '캐주얼', '인디']],
  ['PlateUp!', '1599600', ['캐주얼', '인디', '시뮬레이션']],
  // 함정 1: 장르 비어 있음 (메타 누락 상태) — 4건
  ['Muck', '1706830', []],
  ['Crab Game', '1782210', []],
  ['3DMark', '223850', []],
  ['Wallpaper Engine', '431960', []],
];

// 보유와 교집합이 0이어야 하는 위시리스트 51건.
const WISHLIST = [
  ['Hollow Knight: Silksong', '1030300', ['액션', '어드벤처', '인디']],
  ['Starfield', '1716740', ['어드벤처', 'RPG']],
  ['Diablo IV', '2344520', ['액션', 'RPG']],
  ['Overwatch 2', '2357570', ['액션']],
  ['Lethal Company', '1966720', ['액션', '어드벤처', '인디']],
  ['Palworld', '1623730', ['액션', '어드벤처', '인디', 'RPG']],
  ['Hades II', '1145350', ['액션', '인디', 'RPG']],
  ['STALKER 2: Heart of Chornobyl', '1643320', ['액션', '어드벤처', 'RPG']],
  ['Kingdom Come: Deliverance II', '1771300', ['액션', '어드벤처', 'RPG']],
  ['ELDEN RING NIGHTREIGN', '2622380', ['액션', 'RPG']],
  ['Monster Hunter Wilds', '2246340', ['액션', 'RPG']],
  ['Split Fiction', '2001120', ['액션', '어드벤처']],
  ['Clair Obscur: Expedition 33', '1903340', ['어드벤처', 'RPG']],
  ['Blue Prince', '1569580', ['어드벤처', '인디', '전략']],
  ['Schedule I', '3164500', ['어드벤처', '인디', '시뮬레이션']],
  ['R.E.P.O.', '3241660', ['액션', '어드벤처', '인디']],
  ['PEAK', '3527290', ['어드벤처', '인디']],
  ['Content Warning', '2881650', ['액션', '어드벤처', '인디']],
  ['Path of Exile 2', '2694490', ['액션', 'RPG']],
  ['Last Epoch', '899770', ['액션', '인디', 'RPG']],
  ['Grim Dawn', '219990', ['액션', 'RPG']],
  ['Frostpunk 2', '1601580', ['시뮬레이션', '전략']],
  ['Manor Lords', '1363080', ['시뮬레이션', '전략']],
  ['Age of Mythology: Retold', '1934680', ['전략']],
  ['Ara: History Untold', '2022950', ['전략']],
  ['Indiana Jones and the Great Circle', '2677660', ['액션', '어드벤처']],
  ['Star Wars Outlaws', '2842040', ['액션', '어드벤처']],
  ["Assassin's Creed Shadows", '3159335', ['액션', '어드벤처', 'RPG']],
  ['Avowed', '2457220', ['어드벤처', 'RPG']],
  ['DOOM: The Dark Ages', '3017860', ['액션']],
  ['Borderlands 4', '1285190', ['액션', 'RPG']],
  ['Battlefield 6', '2807960', ['액션']],
  ['SILENT HILL 2', '2124490', ['액션', '어드벤처']],
  ['Resident Evil Requiem', '3764200', ['액션', '어드벤처']],
  ['Slay the Spire 2', '2868840', ['인디', '전략']],
  ['Deadlock', '1046930', ['액션', '전략']],
  ['The First Descendant', '2074920', ['액션', 'RPG']],
  ['Once Human', '2139460', ['액션', '어드벤처', 'RPG']],
  ['Dune: Awakening', '1172710', ['액션', '어드벤처', '대규모 멀티플레이어']],
  ['ARC Raiders', '1808500', ['액션']],
  ['FragPunk', '2943650', ['액션']],
  ['Marvel Rivals', '2767030', ['액션']],
  ['Delta Force', '2507950', ['액션']],
  ['Mecha BREAK', '2452280', ['액션']],
  ['Honkai: Star Rail', '2870310', ['어드벤처', 'RPG']],
  ['Zenless Zone Zero', '3015110', ['액션', 'RPG']],
  ['Lost Ark', '1599340', ['액션', '어드벤처', 'RPG', '대규모 멀티플레이어']],
  ['THRONE AND LIBERTY', '2429640', ['RPG', '대규모 멀티플레이어']],
  ['New World: Aeternum', '1063730', ['액션', '어드벤처', 'RPG', '대규모 멀티플레이어']],
  ['FINAL FANTASY XVI', '2162800', ['RPG']],
  ["Dragon's Dogma 2", '2054970', ['액션', 'RPG']],
];

// 합성 한줄평 풀 — 상태·별점대별로 분리 (정합성 규칙 4). 전부 합성 문장이다.
const PLAYING_NOTES = [
  '주말마다 조금씩 하는 중',
  '2회차 진행 중',
  '친구와 합방용으로 산 게임',
  '가끔 생각날 때 켜는 게임',
  '확장팩 기다리는 중',
  'OST 들으려고 켤 때도 있음',
  '조작감이 손에 잘 붙음',
];
const COMPLETED_NOTES = [
  '스토리 엔딩까지 봄',
  'DLC까지 포함해 완주',
  '짧지만 강렬했음',
  '초반은 별로였는데 뒤로 갈수록 재밌어짐',
  '사운드트랙이 좋아서 계속 켜게 됨',
  '아트 스타일이 취향에 맞음',
  '킬링타임용으로 최고',
  '난이도는 높은데 중독성이 있음',
];
const DROPPED_NOTES = [
  '기대와 달랐음',
  '내 취향은 아니었음',
  '시간이 아까워서 접음',
];
const CRITICAL_NOTES = [ // 별점 2.0 이하 전용 (칭찬 문구 금지)
  '기대 이하의 완성도였음',
  '시스템이 불친절하게 느껴짐',
  '완주는 했지만 추천하기는 어려움',
];

// 합성 기피 사유 풀 (중도 하차 게임에 배정) — 전부 합성 문장이다.
const NOT_STARTED_REASON = '구매만 하고 실행하지 못함'; // 0분 게임 전용
const DISLIKE_POOL = [
  '전투 템포가 취향과 안 맞음',
  '스토리에 몰입하지 못함',
  '멀미가 심함',
  '반복 플레이에 피로감을 느낌',
  '난이도 장벽을 넘지 못함',
  '매칭 대기 시간이 김',
  '최적화 문제로 플레이 중단',
  '아트 스타일이 취향과 다름',
  NOT_STARTED_REASON,
];

// 플레이타임이 몰리는 대표 장르 — 상위 플레이타임을 이 그룹에 먼저 배정한다.
const HIGH_ENGAGEMENT = new Set(['RPG', '전략', '시뮬레이션', '대규모 멀티플레이어']);

// ---------------------------------------------------------------- 통계 유틸
function quantile(sortedAsc, p) {
  const n = sortedAsc.length;
  const pos = (n - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}
function fiveNumber(values) {
  const s = [...values].sort((a, b) => a - b);
  return { min: s[0], q1: quantile(s, 0.25), median: quantile(s, 0.5), q3: quantile(s, 0.75), max: s[s.length - 1] };
}
function errPct(actual, target) {
  return ((actual - target) / target) * 100;
}

// ---------------------------------------------------------------- core 형식 재현
// 아래 4개 함수는 @questail/core dist/storage 의
// toSlug / formatScalar+formatFrontmatter / renderLibraryMarkdown /
// serializeGameNote+formatNote 와 바이트 동일 출력을 목표로 한다.
function toSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
function needsQuoting(s) {
  if (s === '') return true;
  if (/^\s|\s$/.test(s)) return true;
  if (/[\n\r]/.test(s)) return true;
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return true;
  if (s === 'true' || s === 'false' || s === 'null' || s === '~') return true;
  if (/^['"]/.test(s)) return true;
  return false;
}
function formatScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return String(value);
  return needsQuoting(value) ? JSON.stringify(value) : value;
}
function formatFrontmatter(frontmatter) {
  const lines = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${formatScalar(item)}`);
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

const LIB_COLUMNS = [
  'title', 'game_id', 'platform', 'source', 'playtime_minutes',
  'achievement_pct', 'last_played', 'genres', 'developers',
  'publishers', 'release_date', 'wishlisted',
];
function escapeCell(value) {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}
function libCell(game, col) {
  switch (col) {
    case 'title': return escapeCell(game.title);
    case 'game_id': return escapeCell(game.id);
    case 'platform': return game.platform;
    case 'source': return game.source;
    case 'playtime_minutes': return String(game.playtimeMinutes);
    case 'achievement_pct': return game.achievementPercent !== undefined ? String(game.achievementPercent) : '';
    case 'last_played': return game.lastPlayedAt !== undefined ? String(game.lastPlayedAt) : '';
    case 'genres': return game.genres?.length ? escapeCell(JSON.stringify(game.genres)) : '';
    case 'developers': return game.developers?.length ? escapeCell(JSON.stringify(game.developers)) : '';
    case 'publishers': return game.publishers?.length ? escapeCell(JSON.stringify(game.publishers)) : '';
    case 'release_date': return game.releaseDate ? escapeCell(game.releaseDate) : '';
    case 'wishlisted': return game.wishlisted !== undefined ? String(game.wishlisted) : '';
    default: return '';
  }
}
function renderLibraryMarkdown(index) {
  const frontmatter = formatFrontmatter({ generated_at: index.generatedAt, game_count: index.games.length });
  const header = `| ${LIB_COLUMNS.join(' | ')} |`;
  const separator = `| ${LIB_COLUMNS.map(() => '---').join(' | ')} |`;
  const rows = index.games.map((g) => `| ${LIB_COLUMNS.map((c) => libCell(g, c)).join(' | ')} |`);
  const body = ['# QuestTail Library', '', header, separator, ...rows, ''].join('\n');
  return `${frontmatter}\n${body}`;
}

function serializeGameNote(game, prevSubjective) {
  const frontmatter = {
    title: game.title,
    // 숫자형 id 는 bare number 로 쓴다 (core 와 동일 규칙).
    game_id: /^\d+$/.test(game.id) && Number.isSafeInteger(Number(game.id)) ? Number(game.id) : game.id,
    platform: game.platform,
    source: game.source,
    playtime_minutes: game.playtimeMinutes,
  };
  if (game.achievementPercent !== undefined) frontmatter.achievement_pct = game.achievementPercent;
  if (game.lastPlayedAt !== undefined) frontmatter.last_played = game.lastPlayedAt;
  if (game.imageUrl !== undefined) frontmatter.image = game.imageUrl;
  if (game.genres !== undefined && game.genres.length > 0) frontmatter.genres = game.genres;
  if (game.developers !== undefined && game.developers.length > 0) frontmatter.developers = game.developers;
  if (game.publishers !== undefined && game.publishers.length > 0) frontmatter.publishers = game.publishers;
  if (game.releaseDate !== undefined) frontmatter.release_date = game.releaseDate;
  if (game.wishlisted !== undefined) frontmatter.wishlisted = game.wishlisted;
  if (prevSubjective) {
    if (prevSubjective.rating !== undefined) frontmatter.rating = prevSubjective.rating;
    if (prevSubjective.note !== undefined) frontmatter.note = prevSubjective.note;
    if (prevSubjective.dislikeReasons !== undefined && prevSubjective.dislikeReasons.length > 0) {
      frontmatter.dislike_reasons = prevSubjective.dislikeReasons;
    }
    if (prevSubjective.status !== undefined) frontmatter.status = prevSubjective.status;
  }
  const body = game.source === 'auto'
    ? '> Steam에서 자동 가져온 게임 데이터입니다.\n'
    : '> 수동으로 추가된 게임입니다.\n';
  return { frontmatter, body };
}
function formatNote(note) {
  return `${formatFrontmatter(note.frontmatter)}\n${note.body}`;
}

// ---------------------------------------------------------------- 생성 파이프라인
function assert(cond, msg) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
}

/** 목표 사분위수를 맞추는 단조 기준 곡선 (오름차순 120개). */
function basePlaytimeCurve(n) {
  const lerp = (a, b, t) => a + (b - a) * t;
  const at = (p) => {
    if (p < 0.25) return TARGET_Q1 * Math.pow(p / 0.25, 1.6);
    if (p <= 0.5) return Math.exp(lerp(Math.log(TARGET_Q1), Math.log(TARGET_MEDIAN), (p - 0.25) / 0.25));
    if (p <= 0.75) return Math.exp(lerp(Math.log(TARGET_MEDIAN), Math.log(TARGET_Q3), (p - 0.5) / 0.25));
    return TARGET_Q3 * Math.exp(6.0 * (p - 0.75));
  };
  const out = [];
  for (let i = 0; i < n; i++) out.push(at((i + 0.5) / n));
  return out;
}

function main() {
  const rng = mulberry32(SEED);

  // ---- 개수·교집합 검증
  assert(OWNED.length === 120, `보유 게임 수 ${OWNED.length} (120이어야 함)`);
  assert(WISHLIST.length === 51, `위시 게임 수 ${WISHLIST.length} (51이어야 함)`);
  const ownedIds = new Set(OWNED.map((g) => g[1]));
  const wishIds = new Set(WISHLIST.map((g) => g[1]));
  assert(ownedIds.size === 120, '보유 appid 중복 존재');
  assert(wishIds.size === 51, '위시 appid 중복 존재');
  for (const id of wishIds) assert(!ownedIds.has(id), `위시/보유 교집합 존재: ${id}`);

  // ---- 플레이타임 합성 (다중집합을 먼저 만들고 게임에 배정)
  const curve = basePlaytimeCurve(120);
  curve[0] = 0; curve[1] = 0; curve[2] = 0; // 미플레이 3건 (하위 사분위수에 영향 없음)
  const total = curve.reduce((a, b) => a + b, 0);
  const top20sum = curve.slice(100).reduce((a, b) => a + b, 0);
  // 상위 20개 점유율을 목표치에 정확히 맞추는 스케일 (상위권 내부 순서·하위 순위 불변)
  const k = TARGET_TOP20_SHARE * (total - top20sum) / (top20sum * (1 - TARGET_TOP20_SHARE));
  assert(k >= 1, `상위 스케일 k=${k} (1 이상이어야 순서 보존)`);
  const playtimes = curve.map((v, i) => (i >= 100 ? Math.round(v * k) : Math.round(v)));
  assert(playtimes[100] > playtimes[99], '상위 스케일 후 순서 역전');
  const stats = fiveNumber(playtimes);
  assert(Math.abs(errPct(stats.q1, TARGET_Q1)) <= 10, `Q1 오차 초과: ${stats.q1}`);
  assert(Math.abs(errPct(stats.median, TARGET_MEDIAN)) <= 10, `중앙값 오차 초과: ${stats.median}`);
  assert(Math.abs(errPct(stats.q3, TARGET_Q3)) <= 10, `Q3 오차 초과: ${stats.q3}`);
  const top20share = playtimes.slice().sort((a, b) => b - a).slice(0, 20)
    .reduce((a, b) => a + b, 0) / playtimes.reduce((a, b) => a + b, 0);

  // ---- 게임에 배정: 대표 장르가 고몰입군이면 상위 플레이타임 우선
  const shuffled = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const desc = [...playtimes].sort((a, b) => b - a);
  const hiIdx = shuffled(OWNED.map((g, i) => i).filter((i) => HIGH_ENGAGEMENT.has(OWNED[i][2][0])));
  const loIdx = shuffled(OWNED.map((g, i) => i).filter((i) => !HIGH_ENGAGEMENT.has(OWNED[i][2][0])));
  const order = [...hiIdx, ...loIdx];
  const playByIdx = new Array(120);
  order.forEach((gameIdx, rank) => { playByIdx[gameIdx] = desc[rank]; });

  // ---- NormalizedGame 조립 (achievementPercent 는 전 게임 미설정 — 함정 2)
  const THREE_YEARS_MS = 3 * 365.25 * 24 * 3600 * 1000;
  const games = OWNED.map(([title, id, genres], i) => {
    const pt = playByIdx[i];
    const g = {
      id, platform: 'steam', title, source: 'auto', playtimeMinutes: pt,
      imageUrl: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`,
    };
    if (genres.length > 0) g.genres = [...genres];
    // 단위 주의: lastPlayedAt 은 초 단위다. core 가 Steam rtime_last_played 를
    // 그대로 담으므로(dist/normalize/index.js) 목도 같은 단위를 쓴다.
    // generated_at(밀리초, Date.now 계열)과 단위가 다르며 의도된 설계다.
    // 시각 자체는 바꾸지 않는다 — 밀리초 값을 1000 으로 나눠 내림한다.
    if (pt > 0) {
      g.lastPlayedAt = Math.floor((GENERATED_AT - Math.floor(Math.pow(rng(), 2) * THREE_YEARS_MS)) / 1000);
    }
    return g;
  });

  // ---- 주관 필드 합성: 상태·기피사유·별점·한줄평 (레코드 정합성 규칙 적용)
  const asc = games.map((g, i) => i).sort((a, b) => games[a].playtimeMinutes - games[b].playtimeMinutes);
  const droppedSet = new Set(asc.slice(3, 11)); // 최하위 8건 (0분 3건 제외)
  const topSet = new Set([...games.keys()].sort((a, b) => games[b].playtimeMinutes - games[a].playtimeMinutes).slice(0, 15));
  const activeDislikes = DISLIKE_POOL.filter((r) => r !== NOT_STARTED_REASON);
  const subjective = games.map((g, i) => {
    // 규칙 1: 0분 게임은 playing/completed 불가 → 미시작 하차로만 기록
    if (g.playtimeMinutes === 0) return { status: 'dropped', dislikeReasons: [NOT_STARTED_REASON] };
    if (droppedSet.has(i)) {
      const r1 = activeDislikes[Math.floor(rng() * activeDislikes.length)];
      const reasons = [r1];
      if (rng() < 0.4) {
        const r2 = activeDislikes[Math.floor(rng() * activeDislikes.length)];
        if (r2 !== r1) reasons.push(r2);
      }
      return { status: 'dropped', dislikeReasons: reasons };
    }
    if (topSet.has(i)) return { status: 'playing' };
    return { status: 'completed' };
  });
  // 규칙 3: completed 는 같은 대표 장르 게임들의 중앙값 이상만 유지, 미달은 playing 으로 강등
  const primaryOf = (g) => (g.genres && g.genres.length > 0 ? g.genres[0] : null);
  const genrePts = {};
  games.forEach((g) => {
    const key = primaryOf(g) ?? '__all__';
    (genrePts[key] ??= []).push(g.playtimeMinutes);
  });
  const genreMed = {};
  for (const [k, v] of Object.entries(genrePts)) genreMed[k] = quantile([...v].sort((a, b) => a - b), 0.5);
  const globalMed = quantile(games.map((g) => g.playtimeMinutes).sort((a, b) => a - b), 0.5);
  games.forEach((g, i) => {
    if (subjective[i].status !== 'completed') return;
    const th = genreMed[primaryOf(g) ?? '__all__'] ?? globalMed;
    if (g.playtimeMinutes < th) subjective[i].status = 'playing'; // 분량 부족 → 진행 중으로 강등
  });
  // 함정 3: 평점은 0분 제외 뒤 4개 중 1개꼴로 정확히 30건만 입력 (규칙 6: rating → pt > 0)
  const eligible = games.map((_, i) => i).filter((i) => games[i].playtimeMinutes > 0);
  assert(eligible.length === 117, `0분 제외 후보 ${eligible.length} (117이어야 함)`);
  const ratedIdx = eligible.filter((_, pos) => pos % 4 === 0);
  assert(ratedIdx.length === 30, `평점 입력 수 ${ratedIdx.length} (30이어야 함)`);
  const rankOf = new Map([...games.keys()].sort((a, b) => games[a].playtimeMinutes - games[b].playtimeMinutes)
    .map((gi, rank) => [gi, rank]));
  for (const i of ratedIdx) {
    const ptile = rankOf.get(i) / (games.length - 1);
    const v = 2 + 3 * ptile + (rng() - 0.5) * 1.5;
    const clamped = Math.min(5, Math.max(0.5, v));
    const rating = Math.round(clamped * 2) / 2;
    subjective[i].rating = rating;
    // 규칙 4: 상태·별점대별 문구 풀에서 선택 (의도된 rating-플레이타임 갭은 허용)
    const st = subjective[i].status;
    const pool = rating <= 2.0 ? CRITICAL_NOTES
      : st === 'completed' ? COMPLETED_NOTES
      : st === 'playing' ? PLAYING_NOTES : DROPPED_NOTES;
    subjective[i].note = pool[i % pool.length];
  }

  // ---- 레코드 정합성 assert (규칙 1~6 — 위반 1건도 허용 안 함)
  const violations = [];
  games.forEach((g, i) => {
    const s = subjective[i];
    if (g.playtimeMinutes === 0 && (s.status === 'playing' || s.status === 'completed')) {
      violations.push(`규칙1 위반: ${g.id} 0분인데 status=${s.status}`);
    }
    if ((s.status === 'playing' || s.status === 'completed') && g.playtimeMinutes <= 0) {
      violations.push(`규칙2 위반: ${g.id} status=${s.status}인데 0분`);
    }
    if (s.status === 'completed') {
      const th = genreMed[primaryOf(g) ?? '__all__'] ?? globalMed;
      if (g.playtimeMinutes < th) violations.push(`규칙3 위반: ${g.id} completed인데 ${g.playtimeMinutes}분 < 대표장르 중앙값 ${th}`);
    }
    if (s.note !== undefined) {
      const low = s.rating !== undefined && s.rating <= 2.0;
      const okPool = low ? CRITICAL_NOTES
        : s.status === 'completed' ? COMPLETED_NOTES
        : s.status === 'playing' ? PLAYING_NOTES : DROPPED_NOTES;
      if (!okPool.includes(s.note)) violations.push(`규칙4 위반: ${g.id} status=${s.status} rating=${s.rating} 문구풀 불일치`);
    }
    if (s.status === 'dropped' && (!s.dislikeReasons || s.dislikeReasons.length < 1)) {
      violations.push(`규칙5 위반: ${g.id} dropped인데 사유 없음`);
    }
    if (s.rating !== undefined && g.playtimeMinutes <= 0) {
      violations.push(`규칙6 위반: ${g.id} 0분인데 rating=${s.rating}`);
    }
  });
  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exit(1);
  }
  const statusCounts = { playing: 0, completed: 0, dropped: 0 };
  subjective.forEach((s) => { statusCounts[s.status]++; });

  // ---- 장르 가중치 (태그 발생 점유율 — 목표 분포와 같은 정의)
  const tagCounts = {};
  let tagTotal = 0;
  for (const g of games) {
    for (const t of (g.genres ?? [])) {
      tagCounts[t] = (tagCounts[t] ?? 0) + 1;
      tagTotal++;
    }
  }
  const genreWeights = Object.entries(tagCounts)
    .map(([genre, c]) => ({ genre, weight: c / tagTotal }))
    .sort((a, b) => b.weight - a.weight);

  // ---- taste-profile 계산 (라이브러리로부터 도출 — 손 상수 없음)
  const droppedGenres = {};
  let droppedTagTotal = 0;
  games.forEach((g, i) => {
    if (subjective[i].status !== 'dropped') return;
    for (const t of (g.genres ?? [])) {
      droppedGenres[t] = (droppedGenres[t] ?? 0) + 1;
      droppedTagTotal++;
    }
  });
  const dislikedGenres = Object.entries(droppedGenres)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);
  const maxPt = Math.max(...games.map((g) => g.playtimeMinutes));
  const gaps = ratedIdx.map((i) => {
    const norm = Math.log(1 + games[i].playtimeMinutes) / Math.log(1 + maxPt);
    return { gameId: games[i].id, gap: Math.round((subjective[i].rating / 5 - norm) * 1000) / 1000 };
  }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 10);
  const tasteProfile = {
    topGenres: genreWeights.map((w) => ({ genre: w.genre, weight: Math.round(w.weight * 1000) / 1000 })),
    dislikedGenres,
    playtimeDistribution: {
      min: stats.min,
      q1: Math.round(stats.q1 * 10) / 10,
      median: Math.round(stats.median * 10) / 10,
      q3: Math.round(stats.q3 * 10) / 10,
      max: stats.max,
    },
    wishlistAppIds: WISHLIST.map((w) => w[1]),
    ratingPlaytimeGaps: gaps,
  };

  // ---- 파일 쓰기
  rmSync(GAMES_DIR, { recursive: true, force: true });
  mkdirSync(GAMES_DIR, { recursive: true });
  const libSorted = [...games].sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);
  writeFileSync(join(MOCK_DIR, 'library.md'), renderLibraryMarkdown({ generatedAt: GENERATED_AT, games: libSorted }), 'utf-8');
  games.forEach((g, i) => {
    const note = serializeGameNote(g, subjective[i]);
    writeFileSync(join(GAMES_DIR, `${g.id}-${toSlug(g.title)}.md`), formatNote(note), 'utf-8');
  });
  WISHLIST.forEach(([title, id, genres]) => {
    const g = {
      id, platform: 'steam', title, source: 'manual', playtimeMinutes: 0,
      imageUrl: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`,
      wishlisted: true,
    };
    if (genres.length > 0) g.genres = [...genres];
    const note = serializeGameNote(g, { status: 'wishlist' });
    writeFileSync(join(GAMES_DIR, `${g.id}-${toSlug(g.title)}.md`), formatNote(note), 'utf-8');
  });
  writeFileSync(join(MOCK_DIR, 'taste-profile.json'), `${JSON.stringify(tasteProfile, null, 2)}\n`, 'utf-8');

  // ---- META.md (생성 기록 — 실제 산출값 자동 기입)
  const emptyGenreGames = games.filter((g) => !g.genres);
  assert(emptyGenreGames.length >= 3 && emptyGenreGames.length <= 5, '장르 누락 함정 건수 범위 이탈');
  assert(games.every((g) => g.achievementPercent === undefined), 'achievementPct 설정됨 (전 게임 null이어야 함)');
  const ratedIds = ratedIdx.map((i) => games[i].id);
  const droppedIds = games.map((_, i) => i).filter((i) => subjective[i].status === 'dropped')
    .map((i) => games[i].id).sort();
  const descRank = new Map([...games.keys()]
    .sort((a, b) => games[b].playtimeMinutes - games[a].playtimeMinutes)
    .map((gi, r) => [gi, r + 1]));
  const totalPt = games.reduce((a, g) => a + g.playtimeMinutes, 0);
  const emptyPt = emptyGenreGames.reduce((a, g) => a + g.playtimeMinutes, 0);
  const emptyLines = emptyGenreGames.map((g) => {
    const rank = descRank.get(games.indexOf(g));
    return `   - game_id ${g.id} (${g.title}): ${g.playtimeMinutes}분, 전체 ${games.length}건 중 ${rank}위`;
  }).join('\n');
  const genreRow = (genre, target) => {
    const actual = (tagCounts[genre] ?? 0) / tagTotal;
    return `| ${genre} | ${actual.toFixed(3)} | ${target.toFixed(3)} | ${errPct(actual, target).toFixed(1)}% |`;
  };
  const meta = `# Mock Data META

> **고지: 이 디렉토리(data/mock)의 모든 값은 합성 목데이터이며 실제 사용자 데이터가 아니다.**
> 게임명·appid·장르만 실제 Steam 공개 정보를 차용했고,
> 플레이타임·별점·상태·기피사유·한줄평·일시 등 나머지 모든 값은
> seed 고정 난수로 생성한 합성값이다. 실데이터는 스키마·분포 참고용으로만 읽었고,
> 저장소에 복사하지 않았다.

- 생성 시각: ${new Date().toISOString()}
- seed: ${SEED} (코드 상수 — 변경 시 전체 산출물이 달라진다)
- 데이터 고정 시각(generated_at): ${GENERATED_AT} (${new Date(GENERATED_AT).toISOString()})
  - 재현성을 위해 Date.now() 대신 상수를 쓴다. 몇 번을 돌려도 바이트 동일 결과가 나온다.
  - 단위 주의: generated_at 은 밀리초(Date.now 계열, core dist/storage/library.js writeLibraryIndex),
    last_played 는 초(Steam rtime_last_played 를 그대로 담음, core dist/normalize/index.js).
    두 필드의 단위가 다르며 의도된 설계다. 헷갈려도 generated_at 을 초로 바꾸지 마라.
- 보유 게임: ${games.length}건 / 위시리스트: ${WISHLIST.length}건 / 노트 파일: ${games.length + WISHLIST.length}개
- 형식: @questail/core 의 renderLibraryMarkdown / serializeGameNote + formatFrontmatter
  출력과 바이트 동일 형식을 재현했다 (core import 없이 재구현).
  생성 직후 설치된 core 의 parseLibraryMarkdown / parseGameNote 로 왕복 검증한다.
- 실행: \`node scripts/gen-mock.mjs\` (외부 의존성 없음, node 내장 모듈만 사용)

## 플레이타임 분포 (보유 120건, 단위: 분)

| 지표 | 실제 산출 | 목표 | 오차 |
| --- | --- | --- | --- |
| min | ${stats.min} | - | - |
| Q1 | ${stats.q1.toFixed(1)} | ${TARGET_Q1} | ${errPct(stats.q1, TARGET_Q1).toFixed(1)}% |
| 중앙값 | ${stats.median.toFixed(1)} | ${TARGET_MEDIAN} | ${errPct(stats.median, TARGET_MEDIAN).toFixed(1)}% |
| Q3 | ${stats.q3.toFixed(1)} | ${TARGET_Q3} | ${errPct(stats.q3, TARGET_Q3).toFixed(1)}% |
| max | ${stats.max} | - | - |
| 상위 20개 점유율 | ${(top20share * 100).toFixed(1)}% | ${(TARGET_TOP20_SHARE * 100).toFixed(1)}% | ${errPct(top20share, TARGET_TOP20_SHARE).toFixed(1)}% |

- 합성 방법: 목표 사분위수를 지나는 단조 기준 곡선에서 순위별 값을 취한 뒤,
  하위 3건을 0분(미플레이)으로 두고 상위 20건을 스케일해 점유율을 맞췄다.
  게임 배정은 대표 장르가 고몰입군(RPG/전략/시뮬레이션/대규모 멀티플레이어)인
  게임에 상위 플레이타임을 우선 배정했다. lastPlayedAt 은 고정 시각 기준
  과거 3년 범위에서 플레이타임과 무관한 합성 분포로 찍었다(상세 무작위).
- taste-profile.json 의 playtimeDistribution 은 위 5수 요약과 같은 값이다.

## 장르 가중치 (태그 발생 점유율)

| 장르 | 실제 산출 | 목표 | 오차 |
| --- | --- | --- | --- |
${Object.entries(TARGET_GENRES).map(([genre, target]) => genreRow(genre, target)).join('\n')}

- 가중치 정의: 장르 태그 1개 = 1표로 센 발생 점유율 (장르 누락 4건은 0표).
  총 태그 수: ${tagTotal}.
- taste-profile.json 의 topGenres 는 위와 같은 계산값이다 (손 상수 없음).

## 위시리스트

- ${WISHLIST.length}건, 보유 120건과 교집합 0건 (생성 시 assert로 확인).
- 위시 노트는 source manual + wishlisted true + status wishlist 로 기록했고,
  library.md(보유 정본)에는 포함하지 않았다. appid 목록은 taste-profile.json 의
  wishlistAppIds 를 따른다.

## 의도적 함정 4개 (평가셋 근거)

1. 장르 비어 있음 (메타 누락, 노트에 genres 키 자체가 없음) — ${emptyGenreGames.length}건:
${emptyGenreGames.map((g) => `   - game_id ${g.id} (${g.title})`).join('\n')}
2. achievementPct 전 게임 null — library.md 의 achievement_pct 열 전체가 비어 있고,
   전 게임 노트에 achievement_pct 키가 없다. 이유(docs/policy-collection.md 제9조):
   Steam 프로필의 "게임 세부정보" 공개 설정이 꺼져 있으면 GetPlayerAchievements 가
   403(Profile is not public)으로 전량 실패하므로, gather 는 업적 없이 계속 진행했다.
   (데이터에는 없고 이 문서에만 기록한다.)
3. rating 일부 게임만 입력 — ${ratedIds.length}건만 값이 있고 나머지는 미입력이다.
   입력: 0분 3건 제외 뒤 4개 중 1개꼴 (정확히 30건). 미입력 케이스도 함께 존재한다.
   입력된 game_id: ${ratedIds.join(', ')}
4. 위시 ∩ 보유 = 0 — 위 "위시리스트" 절과 동일 (생성 시 교집합 assert 통과).
   중도 하차(dropped) ${droppedIds.length}건의 game_id: ${droppedIds.join(', ')}

## 레코드 정합성 (생성 시 전건 assert — 위반 0건)

- status 분포 (보유 120건): playing ${statusCounts.playing} / completed ${statusCounts.completed} / dropped ${statusCounts.dropped}. 위시 51건은 전부 wishlist.
- 강제 규칙:
  1. 0분이면 playing/completed 불가 (미시작 하차로만 기록, 사유 "구매만 하고 실행하지 못함")
  2. playing/completed 이면 0분 초과
  3. completed 는 대표 장르 게임들의 중앙값 이상 (미달은 playing 으로 강등)
  4. 한줄평은 상태·별점대별 풀에서 선택 (별점 2.0 이하는 비판 풀, completed 에 "하는 중" 문구 금지)
  5. dropped 는 기피사유 1개 이상
  6. rating 입력은 0분 초과 게임에만
- 의도된 예외 (금지하지 않음): "길게 했는데 별점 낮음" / "짧게 했는데 별점 높음" —
  core 의 ratingPlaytimeGaps 가 노리는 신호이므로 허용한다.

## 장르 누락 참고 (함정이므로 의도적 유지)

- 장르가 비어 있는 4건도 플레이타임은 정상 배정받았다. 유틸리티성이라 길 수 있다:
${emptyLines}
- 장르 누락 게임의 플레이타임 합 ${emptyPt}분 (전체 ${totalPt}분의 ${(emptyPt / totalPt * 100).toFixed(1)}%)은
  장르 가중치 계산에서 어느 장르에도 귀속되지 않고 빠진다. 결함이 아니라 평가용 함정이다.

## 값 출처 구분

- 실제 Steam 공개 정보 차용: 게임명·appid·장르, 스팀 CDN 헤더 이미지 URL 패턴.
- 합성: playtime_minutes, last_played, rating, note, dislike_reasons, status,
  wishlisted 배정, taste-profile.json 의 모든 계산 입력이 되는 위 값들.
- 생략 (합성하지도 차용하지도 않음): developers / publishers / release_date.
  공개 메타 복원을 생략했으므로 전 게임 비어 있다.
`;
  writeFileSync(join(MOCK_DIR, 'META.md'), meta, 'utf-8');

  // ---- 콘솔 요약 (보고용)
  console.log(JSON.stringify({
    seed: SEED,
    owned: games.length,
    wishlist: WISHLIST.length,
    fiveNumber: tasteProfile.playtimeDistribution,
    top20share: Math.round(top20share * 1000) / 1000,
    genreWeights: Object.fromEntries(genreWeights.map((w) => [w.genre, Math.round(w.weight * 1000) / 1000])),
    rated: ratedIds.length,
    emptyGenres: emptyGenreGames.map((g) => g.id),
    dropped: droppedIds,
    statusCounts,
    consistencyViolations: 0,
  }, null, 2));
}

main();
