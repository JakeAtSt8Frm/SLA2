/**
 * ESPN leagues, adapted onto the same shapes as Sleeper leagues so every engine and view
 * works unchanged. League structure, rosters, lineups and official scores come from ESPN;
 * player stats, projections and injuries still come from Sleeper (joined on ESPN player id),
 * scored with the ESPN league's own rules translated onto Sleeper stat keys.
 *
 * League ids: `espn-<leagueId>` is the current season, `espn-<leagueId>-<season>` a past one.
 * Credentials are server-side only (config/espn.json, or ESPN_SWID / ESPN_S2).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cached, FOREVER, HOUR, MINUTE } from './cache.ts';
import { sleeper, type SleeperLeague, type SleeperMatchup, type SleeperRoster, type SleeperTransaction, type SleeperUser } from './sleeper.ts';
import { normalizeTeam } from '../engine/positions.ts';
import type { ScoringSettings } from '../engine/scoring.ts';
import type { PlayerInfo, Pos } from '../engine/types.ts';

// ─── Config ──────────────────────────────────────────────────────────────────

interface EspnConfig { swid: string; espnS2: string; leagues: { id: string; name: string }[] }

function loadConfig(): EspnConfig {
  let file: { swid?: string; espn_s2?: string; leagues?: { id: string; name: string }[] } = {};
  try {
    file = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', 'config', 'espn.json'), 'utf8'));
  } catch { /* no ESPN leagues configured */ }
  return {
    // An unset CI secret arrives as an empty string: fall back to the file then too.
    swid: process.env.ESPN_SWID || file.swid || '',
    espnS2: process.env.ESPN_S2 || file.espn_s2 || '',
    leagues: file.leagues ?? [],
  };
}
const config = loadConfig();

/** Leagues listed in config, for the league switcher. Names only; no credentials. */
export const configuredEspnLeagues = () => config.leagues.map(l => ({ id: `espn-${l.id}`, name: l.name, platform: 'espn' as const }));

export const isEspnId = (id: string) => id.startsWith('espn-');
const ID_PATTERN = /^espn-(\d{4,12})(?:-(\d{4}))?$/;
/**
 * Only leagues in config (and their past seasons): the saved login can read every private
 * league it belongs to, and this server shouldn't open those to anyone who guesses an id.
 */
export const validEspnId = (id: string) => {
  const m = ID_PATTERN.exec(id);
  return !!m && config.leagues.some(l => l.id === m[1]);
};

export async function resolve(id: string): Promise<{ leagueId: string; season: number; current: boolean }> {
  const m = ID_PATTERN.exec(id);
  if (!m) throw Object.assign(new Error(`Bad ESPN league id ${id}`), { status: 404, permanent: true });
  const state = await sleeper.state();
  const season = m[2] ? Number(m[2]) : state.season;
  return { leagueId: m[1], season, current: season >= state.season };
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

const HOST = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

/** `filter` narrows player lists (ESPN's X-Fantasy-Filter header). */
export async function espnJson(route: string, filter?: unknown): Promise<unknown> {
  if (!config.swid || !config.espnS2) throw Object.assign(new Error('ESPN credentials are not configured.'), { status: 503, permanent: true });
  const headers = {
    Cookie: `SWID=${config.swid}; espn_s2=${config.espnS2}`,
    Accept: 'application/json',
    // ESPN serves a smaller payload to clients it doesn't recognise.
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    ...(filter === undefined ? {} : { 'X-Fantasy-Filter': JSON.stringify(filter) }),
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${HOST}${route}`, { headers, signal: AbortSignal.timeout(45_000) });
      if (res.ok) return await res.json();
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`ESPN rejected the saved login (${res.status}); espn_s2 may have expired.`), { status: res.status, permanent: true });
      if (res.status === 404) throw Object.assign(new Error(`404 ESPN ${route}`), { status: 404, permanent: true });
      lastError = new Error(`ESPN ${res.status}`);
    } catch (error) {
      if ((error as { permanent?: boolean }).permanent) throw error;
      lastError = error;
    }
    await new Promise(r => setTimeout(r, 400 * 2 ** attempt + Math.random() * 200));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const WRITE_HOST = 'https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl';

/**
 * One POST to ESPN's write host (roster moves; see server/espn-moves.ts). Never retried: a request
 * that timed out may still have executed, so callers re-read the league instead.
 */
export async function espnWrite(route: string, body: Raw): Promise<{ status: number; body: unknown }> {
  if (!config.swid || !config.espnS2) throw Object.assign(new Error('ESPN credentials are not configured.'), { status: 503, permanent: true });
  const res = await fetch(`${WRITE_HOST}${route}`, {
    method: 'POST',
    headers: {
      Cookie: `SWID=${config.swid}; espn_s2=${config.espnS2}`,
      Accept: 'application/json', 'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'X-Fantasy-Source': 'kona', 'X-Fantasy-Platform': 'kona-PROD',
    },
    body: JSON.stringify({ ...body, memberId: config.swid }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* ESPN error pages aren't always JSON */ }
  return { status: res.status, body: parsed };
}

/** The saved login's own team. A commissioner's login can edit any team, so moves must check this. */
export const ownsTeam = (team: unknown) => arr(obj(team).owners).includes(config.swid);

/** Current seasons use the seasons route; older ones are only served from leagueHistory. */
async function leagueRaw(leagueId: string, season: number, views: string[], extra = ''): Promise<Raw> {
  const q = views.map(v => `view=${v}`).join('&') + extra;
  try {
    return obj(await espnJson(`/seasons/${season}/segments/0/leagues/${leagueId}?${q}`));
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 401 && status !== 404) throw error;
    const history = arr(await espnJson(`/leagueHistory/${leagueId}?seasonId=${season}&${q}`));
    if (!history.length) throw error;
    return obj(history[0]);
  }
}

// ─── Tables ──────────────────────────────────────────────────────────────────

/** ESPN pro team id → Sleeper team code. */
export const PRO_TEAMS: Record<number, string> = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC',
  13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT',
  24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
};
export const POSITIONS: Record<number, Pos> = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF', 9: 'DL', 10: 'DL', 11: 'LB', 12: 'DB', 13: 'DB', 14: 'DL', 15: 'LB' };

/** ESPN lineup slot → Sleeper slot name. */
const SLOT_NAMES: Record<number, string> = {
  0: 'QB', 1: 'QB', 2: 'RB', 3: 'WRRB_FLEX', 4: 'WR', 5: 'REC_FLEX', 6: 'TE', 7: 'SUPER_FLEX', 8: 'DL', 9: 'DL', 10: 'LB', 11: 'DL',
  12: 'DB', 13: 'DB', 14: 'DB', 15: 'IDP_FLEX', 16: 'DEF', 17: 'K', 23: 'FLEX',
};
/** Display order of starting slots (ESPN's own order). */
const SLOT_ORDER = [0, 1, 2, 4, 6, 23, 3, 5, 7, 16, 17, 8, 9, 11, 10, 12, 13, 14, 15];
const BENCH = 20, IR = 21;

/**
 * ESPN stat id → Sleeper stat key, for players (base points) and for D/ST (slot-16 overrides).
 * Kicking and D/ST ladders use the `x_` keys derived in engine/derived.ts.
 * Stat ids pinned by the ESPN-app research (kicking buckets run longest-first; D/ST ids
 * verified against observed frequencies) and re-checked here against ESPN's own box scores.
 */
const PLAYER_KEYS: Record<number, string> = {
  0: 'pass_att', 1: 'pass_cmp', 2: 'pass_inc', 3: 'pass_yd', 4: 'pass_td', 19: 'pass_2pt', 20: 'pass_int', 64: 'pass_sack',
  23: 'rush_att', 24: 'rush_yd', 25: 'rush_td', 26: 'rush_2pt',
  42: 'rec_yd', 43: 'rec_td', 44: 'rec_2pt', 53: 'rec', 58: 'rec_tgt',
  63: 'fum_rec_td', 68: 'fum', 72: 'fum_lost', 73: 'fum',
  74: 'x_fgm_50p', 76: 'x_fgmiss_50p', 77: 'x_fgm_40_49', 79: 'x_fgmiss_40_49', 80: 'x_fgm_0_39', 82: 'x_fgmiss_0_39',
  83: 'fgm', 84: 'fga', 85: 'x_fgmiss', 86: 'xpm', 87: 'xpa', 88: 'x_xpmiss',
  198: 'x_fgm_50_59', 200: 'x_fgmiss_50_59', 201: 'x_fgm_60p', 203: 'x_fgmiss_60p',
  // Individual kick/punt return touchdowns.
  101: 'x_ret_td', 102: 'x_ret_td',
};
const DST_KEYS: Record<number, string> = {
  89: 'x_pa_0', 90: 'x_pa_1_6', 91: 'x_pa_7_13', 92: 'x_pa_14_17', 121: 'x_pa_18_21', 122: 'x_pa_22_27', 123: 'x_pa_28_34', 124: 'x_pa_35_45', 125: 'x_pa_46p',
  128: 'x_ya_0_99', 129: 'x_ya_100_199', 130: 'x_ya_200_299', 131: 'x_ya_300_349', 132: 'x_ya_350_399', 133: 'x_ya_400_449', 134: 'x_ya_450_499', 135: 'x_ya_500_549', 136: 'x_ya_550p',
  120: 'x_dst_pa', 127: 'x_dst_ya',
  95: 'x_dst_int', 96: 'x_dst_fum_rec', 97: 'x_dst_blk', 98: 'x_dst_safe', 99: 'x_dst_sack', 106: 'x_dst_to',
  93: 'x_dst_td', 101: 'x_dst_td', 102: 'x_dst_td', 103: 'x_dst_td', 104: 'x_dst_td',
  206: 'x_dst_2pt',
};

export interface EspnScoring { scoring: ScoringSettings; unsupported: number[] }

/** Translate ESPN scoring items onto stat keys. Keys are position-disjoint, so one flat table serves every slot. */
export function translateScoring(items: unknown[]): EspnScoring {
  const scoring: ScoringSettings = {};
  const unsupported: number[] = [];
  for (const item of items) {
    const it = obj(item);
    const id = num(it.statId, -1);
    const base = num(it.points);
    const dst = obj(it.pointsOverrides)['16'];
    const dstPoints = typeof dst === 'number' ? dst : base;
    let used = false;
    if (base && PLAYER_KEYS[id]) { scoring[PLAYER_KEYS[id]] = base; used = true; }
    if (dstPoints && DST_KEYS[id]) { scoring[DST_KEYS[id]] = dstPoints; used = true; }
    // 1-pt safeties and similar oddities have no stat source; ignoring them is the only option.
    if (!used && (base || dstPoints) && id !== 209) unsupported.push(id);
  }
  return { scoring, unsupported };
}

// ─── Player mapping (ESPN → Sleeper ids) ─────────────────────────────────────

interface Index { byEspn: Map<string, string>; byName: Map<string, string[]>; byLast: Map<string, string[]> }
const indexes = new WeakMap<object, Index>();
const normName = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');

function indexOf(players: Record<string, PlayerInfo>): Index {
  let idx = indexes.get(players);
  if (idx) return idx;
  idx = { byEspn: new Map(), byName: new Map(), byLast: new Map() };
  const add = (map: Map<string, string[]>, key: string, id: string) => {
    const list = map.get(key);
    if (list) list.push(id); else map.set(key, [id]);
  };
  for (const p of Object.values(players)) {
    if (p.espnId) idx.byEspn.set(p.espnId, p.id);
    if (p.pos === 'DEF') continue;
    add(idx.byName, normName(p.name), p.id);
    add(idx.byLast, normName(p.name.split(' ').slice(1).join(' ')), p.id);
  }
  indexes.set(players, idx);
  return idx;
}

interface EspnPlayerRef { espnId: number; name: string; pos: Pos | null; team: string | null; injury: string | null }

function playerRef(entry: Raw): EspnPlayerRef {
  const p = obj(obj(entry.playerPoolEntry).player);
  const pos = POSITIONS[num(p.defaultPositionId)] ?? null;
  return {
    espnId: num(entry.playerId, num(p.id)),
    name: str(p.fullName) ?? `ESPN ${num(entry.playerId)}`,
    pos,
    team: PRO_TEAMS[num(p.proTeamId)] ?? null,
    injury: str(entry.injuryStatus) ?? str(p.injuryStatus),
  };
}

/** Sleeper id for an ESPN player; D/ST joins on team, everyone else on ESPN id, then name + position. */
function mapPlayer(ref: EspnPlayerRef, players: Record<string, PlayerInfo>, extra: Record<string, PlayerInfo>): string {
  const known = extra[`espn:${ref.espnId}`];
  if (known) return known.id;
  if (ref.pos === 'DEF') {
    const team = ref.team ?? normalizeTeam(PRO_TEAMS[-ref.espnId - 16000] ?? null);
    if (team && players[team]) return team;
  }
  const idx = indexOf(players);
  const direct = idx.byEspn.get(String(ref.espnId));
  if (direct) return direct;
  if (ref.pos && ref.name) {
    // Same name and an eligible position (two-way players carry both); then same surname, position and team (nicknames).
    const fits = (c: string) => players[c].pos === ref.pos || players[c].eligible.includes(ref.pos!);
    const named = (idx.byName.get(normName(ref.name)) ?? []).filter(fits);
    const pick = named.find(c => players[c].team === ref.team) ?? (named.length === 1 ? named[0] : undefined);
    if (pick) return pick;
    const last = (idx.byLast.get(normName(ref.name.split(' ').slice(1).join(' '))) ?? []).filter(fits);
    const sameTeam = last.filter(c => players[c].team === ref.team);
    if (sameTeam.length === 1) return sameTeam[0];
    if (last.length === 1) return last[0];
  }
  const id = `espn:${ref.espnId}`;
  if (!ref.name) return id;
  extra[id] ??= {
    id, name: ref.name, pos: ref.pos ?? 'WR', eligible: [ref.pos ?? 'WR'], team: ref.team, age: null, birthDate: null, yearsExp: null,
    injuryStatus: null, injuryBodyPart: null, injuryNotes: null, status: 'Active', depthOrder: null, searchRank: null, number: null,
    college: null, newsUpdated: null, espnId: String(ref.espnId),
  };
  return id;
}

// ─── Parsed league ───────────────────────────────────────────────────────────

/** NFL week containing a timestamp. Week 1 starts the Tuesday after Labor Day (first Monday of September). */
export function nflWeekOf(ts: number, season: number): number {
  const dow = new Date(Date.UTC(season, 8, 1)).getUTCDay();
  const laborDay = 1 + ((1 - dow + 7) % 7);
  const start = Date.UTC(season, 8, laborDay + 1);
  return Math.floor((ts - start) / (7 * 86_400_000)) + 1;
}

export interface EspnLeague {
  league: SleeperLeague;
  users: SleeperUser[];
  rosters: SleeperRoster[];
  /** Regular-season and playoff pairings by week (points only; per-player detail comes from box scores). */
  pairings: Map<number, { matchupId: number; home: number; away: number | null; homePts: number; awayPts: number; playoff: boolean }[]>;
  /** Final placing by team, once the season is over. */
  finalPlaces: Map<number, number>;
  /** Players ESPN rosters that Sleeper doesn't know (rare). */
  extraPlayers: Record<string, PlayerInfo>;
  /** Which roster the configured ESPN login owns. */
  myRosterId: number | null;
  unsupportedScoring: number[];
  /** ESPN's weekly outlook blurbs, by Sleeper id. */
  outlooks: Map<string, string>;
  playoffTiers: string[];
}

const LEAGUE_VIEWS = ['mSettings', 'mTeam', 'mRoster', 'mMatchup', 'mStatus'];

function parseEspnLeague(id: string, raw: Raw, season: number, current: boolean, players: Record<string, PlayerInfo>): EspnLeague {
  const settings = obj(raw.settings);
  const status = obj(raw.status);
  const sched = obj(settings.scheduleSettings);
  const rosterSettings = obj(settings.rosterSettings);
  const acq = obj(settings.acquisitionSettings);
  const trade = obj(settings.tradeSettings);
  const extra: Record<string, PlayerInfo> = {};

  // Roster positions in ESPN display order.
  const counts = obj(rosterSettings.lineupSlotCounts);
  const rosterPositions: string[] = [];
  for (const slot of SLOT_ORDER) for (let i = 0; i < num(counts[String(slot)]); i++) rosterPositions.push(SLOT_NAMES[slot]);
  const slotIds: number[] = [];
  for (const slot of SLOT_ORDER) for (let i = 0; i < num(counts[String(slot)]); i++) slotIds.push(slot);
  for (let i = 0; i < num(counts[String(BENCH)]); i++) rosterPositions.push('BN');
  const irSlots = num(counts[String(IR)]);
  for (let i = 0; i < irSlots; i++) rosterPositions.push('IR');

  const { scoring, unsupported } = translateScoring(arr(obj(settings.scoringSettings).scoringItems));
  const regularWeeks = num(sched.matchupPeriodCount, 14);
  const periodLength = Math.max(1, num(sched.matchupPeriodLength, 1));
  const playoffLength = Math.max(1, num(sched.playoffMatchupPeriodLength, 1));
  const firstPeriod = num(status.firstScoringPeriod, 1);
  const playoffWeekStart = firstPeriod + regularWeeks * periodLength;
  const finalPeriod = num(status.finalScoringPeriod, 17);
  const scoringPeriod = num(raw.scoringPeriodId, finalPeriod);
  const seasonOver = !current || (status.isActive === false) || scoringPeriod > finalPeriod;
  const deadline = num(trade.deadlineDate);

  const members = new Map(arr(raw.members).map(m => [str(obj(m).id) ?? '', obj(m)]));
  const teams = arr(raw.teams).map(obj);
  const myTeam = teams.find(t => arr(t.owners).includes(config.swid));

  const users: SleeperUser[] = [];
  const outlooks = new Map<string, string>();
  const rosters: SleeperRoster[] = teams.map(t => {
    const teamId = num(t.id);
    const ownerId = str(t.primaryOwner) ?? (str(arr(t.owners)[0]) as string | null) ?? `team-${teamId}`;
    const m = members.get(ownerId);
    const person = m ? [str(m.firstName), str(m.lastName)].filter(Boolean).join(' ') : '';
    const teamName = str(t.name) ?? ([str(t.location), str(t.nickname)].filter(Boolean).join(' ') || `Team ${teamId}`);
    // ESPN hands out handles like "ESPNFAN4959722663"; a real name reads better when there is one.
    const handle = m ? str(m.displayName) : null;
    const generated = !handle || /^espn(fan)?\d+$/i.test(handle);
    users.push({ userId: ownerId, displayName: (generated ? person || handle : handle) || teamName, teamName, avatar: str(t.logo) });
    const entries = arr(obj(t.roster).entries).map(obj);
    const bySlot = new Map<number, string[]>();
    const all: string[] = [];
    const reserve: string[] = [];
    for (const e of entries) {
      const ref = playerRef(e);
      const pid = mapPlayer(ref, players, extra);
      all.push(pid);
      const slot = num(e.lineupSlotId, BENCH);
      if (slot === IR) reserve.push(pid);
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot)!.push(pid);
      const outlook = str(obj(obj(obj(obj(e.playerPoolEntry).player).outlooks).outlooksByWeek)[String(scoringPeriod)]);
      if (outlook) outlooks.set(pid, outlook);
    }
    const taken = new Map<number, number>();
    const starters = slotIds.map(slot => {
      const i = taken.get(slot) ?? 0;
      taken.set(slot, i + 1);
      return bySlot.get(slot)?.[i] ?? '0';
    });
    const overall = obj(obj(t.record).overall);
    const streak = num(overall.streakLength);
    return {
      rosterId: teamId, ownerId, coOwners: arr(t.owners).map(String).filter(o => o !== ownerId),
      players: all, starters, reserve, taxi: [],
      wins: num(overall.wins), losses: num(overall.losses), ties: num(overall.ties),
      pointsFor: num(overall.pointsFor), pointsAgainst: num(overall.pointsAgainst), potentialPoints: 0,
      faabUsed: num(obj(t.transactionCounter).acquisitionBudgetSpent), waiverPosition: num(t.waiverRank),
      record: streak ? (str(overall.streakType) === 'WIN' ? 'W' : str(overall.streakType) === 'LOSS' ? 'L' : 'T').repeat(streak) : '',
    };
  }).sort((a, b) => a.rosterId - b.rosterId);

  const pairings: EspnLeague['pairings'] = new Map();
  const tiers = new Set<string>();
  for (const g of arr(raw.schedule).map(obj)) {
    const period = num(g.matchupPeriodId);
    const week = period <= regularWeeks ? firstPeriod + (period - 1) * periodLength : playoffWeekStart + (period - regularWeeks - 1) * playoffLength;
    const home = obj(g.home), away = g.away ? obj(g.away) : null;
    const tier = str(g.playoffTierType) ?? 'NONE';
    tiers.add(tier);
    // Consolation games carry no information about the title race; keep winners' bracket and regular season only.
    if (tier !== 'NONE' && tier !== 'WINNERS_BRACKET') continue;
    const list = pairings.get(week) ?? [];
    list.push({ matchupId: num(g.id), home: num(home.teamId), away: away ? num(away.teamId) : null, homePts: num(home.totalPoints), awayPts: away ? num(away.totalPoints) : 0, playoff: tier !== 'NONE' });
    pairings.set(week, list);
  }

  const finalPlaces = new Map<number, number>();
  if (seasonOver) for (const t of teams) if (num(t.rankCalculatedFinal)) finalPlaces.set(num(t.id), num(t.rankCalculatedFinal));

  const tradeDeadline = deadline ? Math.max(0, Math.min(18, nflWeekOf(deadline, season))) : 0;

  const champion = [...finalPlaces].find(([, place]) => place === 1)?.[0] ?? null;
  const league: SleeperLeague = {
    id, name: str(settings.name) ?? 'ESPN league', season, status: seasonOver ? 'complete' : 'in_season', sport: 'nfl',
    week: seasonOver ? finalPeriod : Math.max(1, scoringPeriod),
    lastScoredWeek: seasonOver ? finalPeriod : Math.max(0, scoringPeriod - 1),
    totalRosters: rosters.length, rosterPositions, scoring,
    previousId: null,
    playoffWeekStart, playoffTeams: num(sched.playoffTeamCount, 4), playoffRoundType: playoffLength === 2 ? 2 : 0,
    waiverBudget: acq.isUsingAcquisitionBudget ? num(acq.acquisitionBudget, 100) : 0, tradeDeadline,
    avatar: null, draftId: null, isDynasty: false, lastChampionRosterId: champion, reserveSlots: irSlots, taxiSlots: 0,
  };
  const previous = arr(status.previousSeasons).map(x => num(x)).filter(s => s < season && s >= 2004).sort((a, b) => b - a)[0];
  const base = /^espn-\d+/.exec(id)![0];
  if (previous) league.previousId = `${base}-${previous}`;
  else if (!current && season > 2004) league.previousId = null;

  return {
    league, users, rosters, pairings, finalPlaces, extraPlayers: extra, myRosterId: myTeam ? num(myTeam.id) : null,
    unsupportedScoring: unsupported, outlooks, playoffTiers: [...tiers],
  };
}

const parsedCache = new WeakMap<object, Map<object, EspnLeague>>();

export async function espnLeague(id: string): Promise<EspnLeague> {
  const { leagueId, season, current } = await resolve(id);
  const [raw, players] = await Promise.all([
    cached(`espn:league:${leagueId}:${season}`, current ? MINUTE : FOREVER, () => leagueRaw(leagueId, season, LEAGUE_VIEWS).then(slimLeague), { disk: true, swr: !current }),
    sleeper.players(),
  ]);
  let byPlayers = parsedCache.get(raw);
  if (!byPlayers) { byPlayers = new Map(); parsedCache.set(raw, byPlayers); }
  let parsed = byPlayers.get(players);
  if (!parsed) {
    parsed = parseEspnLeague(id, raw, season, current, players);
    // Past seasons: previousSeasons is only reported on the current one; chain from the season before.
    if (!current && !parsed.league.previousId && season > 2004) {
      const base = /^espn-\d+/.exec(id)![0];
      const known = await knownSeasons(leagueId);
      const prior = known.filter(s => s < season).sort((a, b) => b - a)[0];
      if (prior) parsed.league.previousId = `${base}-${prior}`;
    }
    byPlayers.set(players, parsed);
  }
  return parsed;
}

async function knownSeasons(leagueId: string): Promise<number[]> {
  const state = await sleeper.state();
  const raw = await cached(`espn:league:${leagueId}:${state.season}`, MINUTE, () => leagueRaw(leagueId, state.season, LEAGUE_VIEWS).then(slimLeague), { disk: true });
  return arr(obj(raw.status).previousSeasons).map(x => num(x));
}

/** Keep only what the parser reads; ESPN's full roster payload carries rankings and outlooks for every player (~2.5 MB). */
function slimLeague(raw: Raw): Raw {
  const teams = arr(raw.teams).map(obj).map(t => ({
    ...t,
    valuesByStat: undefined,
    roster: {
      entries: arr(obj(t.roster).entries).map(obj).map(e => {
        const pool = obj(e.playerPoolEntry);
        const p = obj(pool.player);
        return {
          playerId: e.playerId, lineupSlotId: e.lineupSlotId, injuryStatus: e.injuryStatus, acquisitionType: e.acquisitionType,
          playerPoolEntry: { player: { id: p.id, fullName: p.fullName, defaultPositionId: p.defaultPositionId, proTeamId: p.proTeamId, injuryStatus: p.injuryStatus, outlooks: { outlooksByWeek: { [String(raw.scoringPeriodId)]: obj(obj(p.outlooks).outlooksByWeek)[String(raw.scoringPeriodId)] } } } },
        };
      }),
    },
  }));
  const schedule = arr(raw.schedule).map(obj).map(g => {
    const side = (s: unknown) => (s ? { teamId: obj(s).teamId, totalPoints: obj(s).totalPoints } : undefined);
    return { id: g.id, matchupPeriodId: g.matchupPeriodId, playoffTierType: g.playoffTierType, winner: g.winner, home: side(g.home), away: side(g.away) };
  });
  const members = arr(raw.members).map(obj).map(m => ({ id: m.id, displayName: m.displayName, firstName: m.firstName, lastName: m.lastName }));
  return { id: raw.id, seasonId: raw.seasonId, scoringPeriodId: raw.scoringPeriodId, settings: raw.settings, status: raw.status, members, teams, schedule };
}

// ─── Weekly box scores → Sleeper-style matchups ──────────────────────────────

interface BoxTeam { teamId: number; total: number; entries: { ref: EspnPlayerRef; slot: number; points: number }[] }

async function box(leagueId: string, season: number, week: number, ttl: number): Promise<BoxTeam[]> {
  return cached(`espn:box:${leagueId}:${season}:${week}`, ttl, async () => {
    const raw = await leagueRaw(leagueId, season, ['mBoxscore', 'mMatchupScore'], `&scoringPeriodId=${week}`);
    const out: BoxTeam[] = [];
    for (const g of arr(raw.schedule).map(obj)) {
      for (const side of [g.home, g.away]) {
        if (!side) continue;
        const s = obj(side);
        const roster = obj(s.rosterForCurrentScoringPeriod);
        const entries = arr(roster.entries).map(obj);
        if (!entries.length) continue;
        out.push({
          teamId: num(s.teamId),
          total: num(roster.appliedStatTotal, num(obj(s.pointsByScoringPeriod)[String(week)], num(s.totalPoints))),
          entries: entries.map(e => ({ ref: playerRef(e), slot: num(e.lineupSlotId, BENCH), points: Math.round(num(obj(e.playerPoolEntry).appliedStatTotal) * 100) / 100 })),
        });
      }
    }
    return out;
  }, { disk: ttl === FOREVER || ttl >= HOUR });
}

/** Sleeper-shaped matchups for one week: official ESPN points, lineups and per-player points. */
export async function espnMatchups(id: string, week: number, detail = false): Promise<SleeperMatchup[]> {
  const [{ leagueId, season, current }, parsed, players] = await Promise.all([resolve(id), espnLeague(id), sleeper.players()]);
  const pairs = parsed.pairings.get(week) ?? [];
  if (!pairs.length) return [];
  const cur = parsed.league.week;
  // Past seasons only need scores (history); the schedule already has them.
  const played = detail || (current && week <= cur);
  const ttl = !current || week < cur - 1 ? FOREVER : week < cur ? HOUR : MINUTE;
  const boxes = played ? await box(leagueId, season, week, ttl).catch(() => [] as BoxTeam[]) : [];
  const byTeam = new Map(boxes.map(b => [b.teamId, b]));
  const slotIds: number[] = [];
  const counts = new Map<string, number>();
  for (const name of parsed.league.rosterPositions) counts.set(name, (counts.get(name) ?? 0) + 1);
  // Rebuild the ordered slot ids the same way the league parser did.
  for (const slot of SLOT_ORDER) {
    const name = SLOT_NAMES[slot];
    const n = counts.get(name) ?? 0;
    if (!n) continue;
    for (let i = 0; i < n; i++) slotIds.push(slot);
    counts.set(name, 0);
  }
  const out: SleeperMatchup[] = [];
  const roster = (teamId: number, pts: number, matchupId: number) => {
    const b = byTeam.get(teamId);
    if (!b) {
      const r = parsed.rosters.find(x => x.rosterId === teamId);
      // Future weeks: pairing only; the current lineup stands in for starters.
      out.push({ rosterId: teamId, matchupId, points: pts, customPoints: null, players: r?.players ?? [], starters: week === cur && r ? r.starters : [], playersPoints: {}, startersPoints: [] });
      return;
    }
    const bySlot = new Map<number, string[]>();
    const pp: Record<string, number> = {};
    const all: string[] = [];
    for (const e of b.entries) {
      const pid = mapPlayer(e.ref, players, parsed.extraPlayers);
      all.push(pid);
      pp[pid] = e.points;
      if (!bySlot.has(e.slot)) bySlot.set(e.slot, []);
      bySlot.get(e.slot)!.push(pid);
    }
    const taken = new Map<number, number>();
    const starters = slotIds.map(slot => {
      const i = taken.get(slot) ?? 0;
      taken.set(slot, i + 1);
      return bySlot.get(slot)?.[i] ?? '0';
    });
    out.push({ rosterId: teamId, matchupId, points: Math.round(b.total * 100) / 100, customPoints: null, players: all, starters, playersPoints: pp, startersPoints: starters.map(s => pp[s] ?? 0) });
  };
  for (const p of pairs) {
    roster(p.home, p.homePts, p.matchupId);
    if (p.away !== null) roster(p.away, p.awayPts, p.matchupId);
  }
  return out;
}

// ─── Player directory (names for ids that arrive without one) ───────────────

/** Every active ESPN player's name, position and team — transaction items carry only an id. */
export function directory(season: number): Promise<Record<string, [name: string, pos: number, team: number]>> {
  return cached(`espn:players:${season}`, 12 * HOUR, async () => {
    const res = await fetch(`${HOST}/seasons/${season}/players?scoringPeriodId=0&view=players_wl`, {
      headers: {
        Cookie: `SWID=${config.swid}; espn_s2=${config.espnS2}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0',
        'X-Fantasy-Filter': JSON.stringify({ filterActive: { value: true } }),
      },
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`ESPN players ${res.status}`);
    const out: Record<string, [string, number, number]> = {};
    for (const p of arr(await res.json()).map(obj)) out[String(num(p.id))] = [str(p.fullName) ?? '', num(p.defaultPositionId), num(p.proTeamId)];
    return out;
  }, { disk: true, swr: true });
}

// ─── Transactions ────────────────────────────────────────────────────────────

export async function espnTransactions(id: string, week: number, final: boolean): Promise<SleeperTransaction[]> {
  const [{ leagueId, season }, players, parsed] = await Promise.all([resolve(id), sleeper.players(), espnLeague(id)]);
  const dir = await directory(season).catch(() => ({} as Record<string, [string, number, number]>));
  const raw = await cached(`espn:tx:${leagueId}:${season}:${week}`, final ? FOREVER : 5 * MINUTE, async () => {
    const r = await leagueRaw(leagueId, season, ['mTransactions2'], `&scoringPeriodId=${week}`);
    return arr(r.transactions).map(obj).filter(t => t.status === 'EXECUTED' && ['WAIVER', 'FREEAGENT', 'TRADE_PROPOSAL', 'TRADE_UPHOLD'].includes(String(t.type)))
      .map(t => ({ id: t.id, type: t.type, teamId: t.teamId, bid: t.bidAmount, at: num(t.processDate, num(t.proposedDate)), items: arr(t.items).map(obj).filter(i => i.type === 'ADD' || i.type === 'DROP' || i.type === 'TRADE').map(i => ({ type: i.type, playerId: i.playerId, from: i.fromTeamId, to: i.toTeamId })) }));
  }, { disk: final });
  const out: SleeperTransaction[] = [];
  for (const t of raw as { id: string; type: string; teamId: number; bid: number; at: number; items: { type: string; playerId: number; from: number; to: number }[] }[]) {
    const adds: Record<string, number> = {}, drops: Record<string, number> = {};
    const teamIds = new Set<number>();
    for (const i of t.items) {
      // Transaction items carry only the id; D/ST ids encode the team.
      const known = dir[String(i.playerId)];
      const ref: EspnPlayerRef = i.playerId < 0
        ? { espnId: i.playerId, name: '', pos: 'DEF', team: PRO_TEAMS[-i.playerId - 16000] ?? null, injury: null }
        : { espnId: i.playerId, name: known?.[0] ?? '', pos: known ? POSITIONS[known[1]] ?? null : null, team: known ? PRO_TEAMS[known[2]] ?? null : null, injury: null };
      const pid = mapPlayer(ref, players, parsed.extraPlayers);
      if (i.type === 'ADD' || (i.type === 'TRADE' && i.to)) { adds[pid] = i.to; teamIds.add(i.to); }
      if (i.type === 'DROP' || (i.type === 'TRADE' && i.from)) { drops[pid] = i.from; teamIds.add(i.from); }
    }
    if (!Object.keys(adds).length && !Object.keys(drops).length) continue;
    out.push({
      id: t.id, type: t.type === 'WAIVER' ? 'waiver' : t.type === 'FREEAGENT' ? 'free_agent' : 'trade', status: 'complete', week, created: t.at,
      rosterIds: [...teamIds].filter(Boolean), adds, drops, faab: t.type === 'WAIVER' && parsed.league.waiverBudget ? t.bid : null, picks: [], budget: [],
    });
  }
  return out;
}
