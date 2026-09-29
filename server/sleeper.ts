import { cached, FOREVER, HOUR, MINUTE } from './cache.ts';
import { normalizePosition, normalizeTeam } from '../engine/positions.ts';
import type { NflGame, PlayerInfo, Pos, Stats } from '../engine/types.ts';
import type { ScoringSettings } from '../engine/scoring.ts';

const HOSTS = ['https://api.sleeper.app', 'https://api.sleeper.com'];
const NFLVERSE_GAMES = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';

// ─── HTTP ────────────────────────────────────────────────────────────────────

let active = 0;
const queue: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 6) await new Promise<void>(resolve => queue.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

async function fetchText(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await withSlot(() => fetch(url, { signal: AbortSignal.timeout(60_000), headers: { Accept: 'application/json, text/csv' } }));
      if (response.status === 404) throw Object.assign(new Error(`404 ${url}`), { permanent: true, status: 404 });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if ((error as { permanent?: boolean }).permanent) break;
      await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Sleeper's undocumented stats/projection routes live on both hosts; try each. */
async function sleeperJson(route: string): Promise<unknown> {
  let lastError: unknown;
  for (const host of HOSTS) {
    try {
      const text = await fetchText(`${host}${route}`);
      return text === '' || text === 'null' ? null : JSON.parse(text);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ─── Parsing helpers ─────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const ids = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string' && x !== '0' && x.length > 0);

/** Drop provider-precomputed totals, ADP and rank fields — they are never this league's score. */
function cleanStats(raw: unknown): Stats {
  const out: Stats = {};
  for (const [key, value] of Object.entries(obj(raw))) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) continue;
    if (key.startsWith('adp') || key.startsWith('pos_adp') || key.startsWith('pos_rank') || key.startsWith('rank_')) continue;
    if (key.startsWith('pts_') && !key.startsWith('pts_allow')) continue;
    out[key] = value;
  }
  return out;
}

// ─── League endpoints ────────────────────────────────────────────────────────

export interface SleeperLeague {
  id: string;
  name: string;
  season: number;
  status: string;
  sport: string;
  week: number;
  lastScoredWeek: number;
  totalRosters: number;
  rosterPositions: string[];
  scoring: ScoringSettings;
  previousId: string | null;
  playoffWeekStart: number;
  playoffTeams: number;
  playoffRoundType: number;
  waiverBudget: number;
  tradeDeadline: number;
  avatar: string | null;
  draftId: string | null;
  isDynasty: boolean;
  lastChampionRosterId: number | null;
  reserveSlots: number;
  taxiSlots: number;
}

export function parseLeague(value: unknown): SleeperLeague {
  const raw = obj(value);
  const settings = obj(raw.settings);
  const metadata = obj(raw.metadata);
  const id = str(raw.league_id);
  if (!id) throw new Error('League not found. Check the Sleeper league ID.');
  if (raw.sport !== 'nfl') throw new Error('Only NFL leagues are supported.');
  const scoring: ScoringSettings = {};
  for (const [key, v] of Object.entries(obj(raw.scoring_settings))) if (typeof v === 'number' && Number.isFinite(v)) scoring[key] = v;
  return {
    id,
    name: str(raw.name) ?? 'Sleeper league',
    season: num(raw.season),
    status: str(raw.status) ?? 'unknown',
    sport: 'nfl',
    week: Math.max(1, num(settings.leg, 1)),
    lastScoredWeek: num(settings.last_scored_leg, 0),
    totalRosters: num(raw.total_rosters, num(settings.num_teams)),
    rosterPositions: arr(raw.roster_positions).filter((x): x is string => typeof x === 'string'),
    scoring,
    previousId: str(raw.previous_league_id) && raw.previous_league_id !== '0' ? (raw.previous_league_id as string) : null,
    playoffWeekStart: num(settings.playoff_week_start, 15),
    playoffTeams: num(settings.playoff_teams, 4),
    playoffRoundType: num(settings.playoff_round_type, 0),
    waiverBudget: num(settings.waiver_budget, 100),
    tradeDeadline: num(settings.trade_deadline, 0),
    avatar: str(raw.avatar),
    draftId: str(raw.draft_id),
    isDynasty: num(settings.type) === 2,
    lastChampionRosterId: numOrNull(metadata.latest_league_winner_roster_id),
    reserveSlots: num(settings.reserve_slots),
    taxiSlots: num(settings.taxi_slots),
  };
}

export interface SleeperRoster {
  rosterId: number;
  ownerId: string | null;
  coOwners: string[];
  players: string[];
  starters: string[];
  reserve: string[];
  taxi: string[];
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  potentialPoints: number;
  faabUsed: number;
  waiverPosition: number;
  record: string;
}

export function parseRosters(value: unknown): SleeperRoster[] {
  return arr(value).map(item => {
    const row = obj(item);
    const s = obj(row.settings);
    return {
      rosterId: num(row.roster_id),
      ownerId: str(row.owner_id),
      coOwners: ids(row.co_owners),
      players: ids(row.players),
      starters: arr(row.starters).map(x => (typeof x === 'string' ? x : '0')),
      reserve: ids(row.reserve),
      taxi: ids(row.taxi),
      wins: num(s.wins),
      losses: num(s.losses),
      ties: num(s.ties),
      pointsFor: num(s.fpts) + num(s.fpts_decimal) / 100,
      pointsAgainst: num(s.fpts_against) + num(s.fpts_against_decimal) / 100,
      potentialPoints: num(s.ppts) + num(s.ppts_decimal) / 100,
      faabUsed: num(s.waiver_budget_used),
      waiverPosition: num(s.waiver_position),
      record: str(obj(row.metadata).record) ?? '',
    };
  }).sort((a, b) => a.rosterId - b.rosterId);
}

export interface SleeperUser { userId: string; displayName: string; teamName: string | null; avatar: string | null }
export function parseUsers(value: unknown): SleeperUser[] {
  return arr(value).map(item => {
    const row = obj(item);
    return {
      userId: str(row.user_id) ?? '',
      displayName: str(row.display_name) ?? 'Unknown manager',
      teamName: str(obj(row.metadata).team_name),
      avatar: str(obj(row.metadata).avatar) ?? (str(row.avatar) ? `https://sleepercdn.com/avatars/thumbs/${row.avatar}` : null),
    };
  });
}

export interface SleeperMatchup {
  rosterId: number;
  matchupId: number | null;
  points: number;
  customPoints: number | null;
  players: string[];
  starters: string[];
  playersPoints: Record<string, number>;
  startersPoints: number[];
}

export function parseMatchups(value: unknown): SleeperMatchup[] {
  return arr(value).map(item => {
    const row = obj(item);
    const pp: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj(row.players_points))) if (typeof v === 'number') pp[k] = v;
    return {
      rosterId: num(row.roster_id),
      matchupId: numOrNull(row.matchup_id),
      points: num(row.points),
      customPoints: numOrNull(row.custom_points),
      players: ids(row.players),
      starters: arr(row.starters).map(x => (typeof x === 'string' ? x : '0')),
      playersPoints: pp,
      startersPoints: arr(row.starters_points).map(x => num(x)),
    };
  });
}

export interface SleeperTransaction {
  id: string;
  type: string;
  status: string;
  week: number;
  created: number;
  rosterIds: number[];
  adds: Record<string, number>;
  drops: Record<string, number>;
  faab: number | null;
  picks: { season: string; round: number; ownerId: number; previousOwnerId: number; rosterId: number }[];
  budget: { sender: number; receiver: number; amount: number }[];
}

export function parseTransactions(value: unknown): SleeperTransaction[] {
  return arr(value).map(item => {
    const row = obj(item);
    const adds: Record<string, number> = {};
    const drops: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj(row.adds))) adds[k] = num(v);
    for (const [k, v] of Object.entries(obj(row.drops))) drops[k] = num(v);
    return {
      id: str(row.transaction_id) ?? '',
      type: str(row.type) ?? 'unknown',
      status: str(row.status) ?? '',
      week: num(row.leg),
      created: num(row.created),
      rosterIds: arr(row.roster_ids).map(x => num(x)),
      adds,
      drops,
      faab: numOrNull(obj(row.settings).waiver_bid),
      picks: arr(row.draft_picks).map(p => {
        const pick = obj(p);
        return { season: String(pick.season ?? ''), round: num(pick.round), ownerId: num(pick.owner_id), previousOwnerId: num(pick.previous_owner_id), rosterId: num(pick.roster_id) };
      }),
      budget: arr(row.waiver_budget).map(b => {
        const x = obj(b);
        return { sender: num(x.sender), receiver: num(x.receiver), amount: num(x.amount) };
      }),
    };
  });
}

export interface BracketMatch { round: number; match: number; t1: number | null; t2: number | null; winner: number | null; loser: number | null; place: number | null; t1From: Raw | null; t2From: Raw | null }
export function parseBracket(value: unknown): BracketMatch[] {
  return arr(value).map(item => {
    const row = obj(item);
    return {
      round: num(row.r), match: num(row.m), t1: numOrNull(row.t1), t2: numOrNull(row.t2), winner: numOrNull(row.w), loser: numOrNull(row.l),
      place: numOrNull(row.p), t1From: row.t1_from ? obj(row.t1_from) : null, t2From: row.t2_from ? obj(row.t2_from) : null,
    };
  });
}

export interface NflState { season: number; week: number; seasonType: string; displayWeek: number; leagueSeason: number }

export const sleeper = {
  state: () => cached('state', 5 * MINUTE, async () => {
    const raw = obj(await sleeperJson('/v1/state/nfl'));
    return { season: num(raw.season), week: num(raw.week), seasonType: str(raw.season_type) ?? 'regular', displayWeek: num(raw.display_week), leagueSeason: num(raw.league_season) } satisfies NflState;
  }),
  league: (id: string) => cached(`league:${id}`, 2 * MINUTE, async () => parseLeague(await sleeperJson(`/v1/league/${id}`)), { disk: true }),
  rosters: (id: string) => cached(`rosters:${id}`, MINUTE, async () => parseRosters(await sleeperJson(`/v1/league/${id}/rosters`))),
  users: (id: string) => cached(`users:${id}`, 30 * MINUTE, async () => parseUsers(await sleeperJson(`/v1/league/${id}/users`)), { disk: true }),
  /** Completed weeks of finished seasons never change; everything else refreshes. */
  matchups: (id: string, week: number, final = false) =>
    cached(`matchups:${id}:${week}`, final ? FOREVER : MINUTE, async () => parseMatchups(await sleeperJson(`/v1/league/${id}/matchups/${week}`)), { disk: final }),
  transactions: (id: string, week: number, final = false) =>
    cached(`tx:${id}:${week}`, final ? FOREVER : 5 * MINUTE, async () => parseTransactions(await sleeperJson(`/v1/league/${id}/transactions/${week}`)), { disk: final }),
  winnersBracket: (id: string, final = false) => cached(`wb:${id}`, final ? FOREVER : 10 * MINUTE, async () => parseBracket(await sleeperJson(`/v1/league/${id}/winners_bracket`)), { disk: final }),
  losersBracket: (id: string, final = false) => cached(`lb:${id}`, final ? FOREVER : 10 * MINUTE, async () => parseBracket(await sleeperJson(`/v1/league/${id}/losers_bracket`)), { disk: final }),
  trending: (type: 'add' | 'drop') => cached(`trending:${type}`, 15 * MINUTE, async () =>
    arr(await sleeperJson(`/v1/players/nfl/trending/${type}?lookback_hours=48&limit=100`)).map(x => ({ id: str(obj(x).player_id) ?? '', count: num(obj(x).count) }))),
  players: () => cached('players-v2', 12 * HOUR, loadPlayers, { disk: true, swr: true }),
};

// ─── Players ─────────────────────────────────────────────────────────────────

function ageFrom(birthDate: string | null, fallback: number | null): number | null {
  if (!birthDate) return fallback;
  const born = Date.parse(birthDate);
  if (!Number.isFinite(born)) return fallback;
  return Math.floor(((Date.now() - born) / (365.25 * 24 * 3600 * 1000)) * 10) / 10;
}

async function loadPlayers(): Promise<Record<string, PlayerInfo>> {
  const raw = obj(await sleeperJson('/v1/players/nfl'));
  const out: Record<string, PlayerInfo> = {};
  for (const [id, value] of Object.entries(raw)) {
    const row = obj(value);
    const pos = normalizePosition(str(row.position));
    if (!pos) continue;
    const eligible = new Set<Pos>([pos]);
    for (const fp of arr(row.fantasy_positions)) {
      const p = normalizePosition(typeof fp === 'string' ? fp : null);
      if (p) eligible.add(p);
    }
    const birthDate = str(row.birth_date);
    out[id] = {
      id,
      name: str(row.full_name) ?? (`${str(row.first_name) ?? ''} ${str(row.last_name) ?? ''}`.trim() || id),
      pos,
      eligible: [...eligible],
      team: normalizeTeam(str(row.team)),
      age: ageFrom(birthDate, numOrNull(row.age)),
      birthDate,
      yearsExp: numOrNull(row.years_exp),
      injuryStatus: str(row.injury_status),
      injuryBodyPart: str(row.injury_body_part),
      injuryNotes: str(row.injury_notes),
      status: str(row.status),
      depthOrder: numOrNull(row.depth_chart_order),
      searchRank: numOrNull(row.search_rank),
      number: numOrNull(row.number),
      college: str(row.college),
      newsUpdated: numOrNull(row.news_updated),
      espnId: row.espn_id === null || row.espn_id === undefined ? null : String(row.espn_id),
    };
  }
  return out;
}

// ─── Weekly stats & projections ──────────────────────────────────────────────

export interface WeekLine {
  id: string;
  team: string | null;
  opponent: string | null;
  gameId: string | null;
  stats: Stats;
  /** Injury tag embedded in the row (fresher than the daily player catalogue), with its news time. */
  injury?: { status: string | null; at: number | null };
}

function parseWeekLines(value: unknown): WeekLine[] {
  const out: WeekLine[] = [];
  for (const item of arr(value)) {
    const row = obj(item);
    const id = str(row.player_id);
    if (!id) continue;
    const stats = cleanStats(row.stats);
    if (!Object.keys(stats).length) continue;
    const player = row.player ? obj(row.player) : null;
    const line: WeekLine = { id, team: normalizeTeam(str(row.team)), opponent: normalizeTeam(str(row.opponent)), gameId: str(row.game_id), stats };
    if (player) line.injury = { status: str(player.injury_status), at: numOrNull(player.news_updated) };
    out.push(line);
  }
  return out;
}

const lineSignatures = new WeakMap<WeekLine, number>();
/** Content signature of one row (team, every stat key and value), memoised per row object. */
export function lineSignature(line: WeekLine): number {
  let h = lineSignatures.get(line);
  if (h !== undefined) return h;
  h = 17;
  const mix = (text: string) => { for (let i = 0; i < text.length; i++) h = (Math.imul(h!, 31) + text.charCodeAt(i)) | 0; };
  mix(line.team ?? '-');
  for (const k in line.stats) {
    mix(k);
    h = (Math.imul(h, 31) + Math.round(line.stats[k] * 1000)) | 0;
  }
  h >>>= 0;
  lineSignatures.set(line, h);
  return h;
}

/** Cheap content signature so unchanged refreshes don't trigger recomputation. */
export function linesSignature(lines: readonly WeekLine[]): number {
  let h = lines.length | 0;
  for (const l of lines) {
    for (let i = 0; i < l.id.length; i++) h = (Math.imul(h, 31) + l.id.charCodeAt(i)) | 0;
    for (const k in l.stats) h = (Math.imul(h, 31) + Math.round(l.stats[k] * 100)) | 0;
    const inj = l.injury?.status;
    if (inj) for (let i = 0; i < inj.length; i++) h = (Math.imul(h, 31) + inj.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export interface WeekFreshness { season: number; week: number; currentSeason: number; currentWeek: number }

/** Final weeks of past seasons are immutable; the in-progress season gets stat corrections for days. */
function statsTtl(f: WeekFreshness): number {
  if (f.season < f.currentSeason) return FOREVER;
  if (f.week < f.currentWeek - 1) return 12 * HOUR;
  if (f.week < f.currentWeek) return HOUR;
  return 2 * MINUTE;
}

export function weekStats(f: WeekFreshness): Promise<WeekLine[]> {
  const ttl = statsTtl(f);
  return cached(`stats:${f.season}:${f.week}`, ttl, async () => parseWeekLines(await sleeperJson(`/stats/nfl/${f.season}/${f.week}?season_type=regular`)), { disk: true, swr: ttl !== FOREVER });
}

export function weekProjections(f: WeekFreshness): Promise<WeekLine[]> {
  const ttl = f.season < f.currentSeason || f.week < f.currentWeek ? FOREVER : 20 * MINUTE;
  return cached(`proj:${f.season}:${f.week}`, ttl, async () => parseWeekLines(await sleeperJson(`/projections/nfl/${f.season}/${f.week}?season_type=regular`)), { disk: true, swr: ttl !== FOREVER });
}

// ─── NFL schedule (nflverse: kickoff times and betting lines) ────────────────

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

/** Convert an America/New_York wall-clock time to epoch ms, honouring DST. */
export function easternToEpoch(date: string, time: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match || !t) return null;
  const guess = Date.UTC(+match[1], +match[2] - 1, +match[3], +t[1], +t[2]);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const asEastern = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return guess + (guess - asEastern);
}

export function parseGames(text: string): NflGame[] {
  return parseCsv(text).filter(r => r.game_type === 'REG').map(r => ({
    id: r.game_id,
    season: Number(r.season),
    week: Number(r.week),
    home: normalizeTeam(r.home_team) ?? r.home_team,
    away: normalizeTeam(r.away_team) ?? r.away_team,
    kickoff: easternToEpoch(r.gameday, r.gametime),
    spreadLine: numOrNull(r.spread_line),
    totalLine: numOrNull(r.total_line),
    homeScore: numOrNull(r.home_score),
    awayScore: numOrNull(r.away_score),
    roof: r.roof || null,
    homeRest: numOrNull(r.home_rest),
    awayRest: numOrNull(r.away_rest),
    divGame: r.div_game === '1',
  }));
}

export const nflGames = () => cached('nflverse:games', 3 * HOUR, async () => parseGames(await fetchText(NFLVERSE_GAMES)), { disk: true, swr: true });

/** Sleeper's live game status (pre_game / in_game / complete) for lock detection. */
export const sleeperSchedule = (season: number) => cached(`schedule:${season}`, 5 * MINUTE, async () =>
  arr(await sleeperJson(`/schedule/nfl/regular/${season}`)).map(x => {
    const row = obj(x);
    return { week: num(row.week), home: normalizeTeam(str(row.home)) ?? '', away: normalizeTeam(str(row.away)) ?? '', status: str(row.status) ?? 'pre_game', date: str(row.date) };
  }));

/** Look up a Sleeper user's NFL leagues for the current (and previous) season. */
export async function findLeagues(username: string) {
  const user = obj(await sleeperJson(`/v1/user/${encodeURIComponent(username)}`));
  const userId = str(user.user_id);
  if (!userId) throw Object.assign(new Error('League not found. Check the Sleeper username.'), { status: 404 });
  const state = await sleeper.state();
  const seasons = [state.leagueSeason || state.season, (state.leagueSeason || state.season) - 1];
  const lists = await Promise.all(seasons.map(s => sleeperJson(`/v1/user/${userId}/leagues/nfl/${s}`).catch(() => [])));
  const leagues = lists.flatMap(list => arr(list).map(x => {
    const row = obj(x);
    return { id: str(row.league_id) ?? '', name: str(row.name) ?? 'League', season: num(row.season), teams: num(row.total_rosters), avatar: str(row.avatar) ? `https://sleepercdn.com/avatars/thumbs/${row.avatar}` : null, status: str(row.status) ?? '' };
  })).filter(l => l.id);
  return { user: { id: userId, name: str(user.display_name) ?? username, avatar: str(user.avatar) ? `https://sleepercdn.com/avatars/thumbs/${user.avatar}` : null }, leagues };
}
