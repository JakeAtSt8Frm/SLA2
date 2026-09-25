/**
 * Builds the in-memory analysis "core" for a league: every relevant player's forecast for
 * each remaining week, lineups, values, results and schedule. Endpoints are thin views over it.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MINUTE } from './cache.ts';
import {
  linesSignature, nflGames, sleeper, sleeperSchedule, weekProjections, weekStats,
  type SleeperLeague, type SleeperMatchup, type SleeperRoster, type SleeperTransaction, type SleeperUser, type WeekLine,
} from './sleeper.ts';
import { sourceFor, type LeagueExtras, type Platform } from './source.ts';
import { defenseRows, fitDefenseModel, type DefenseModel } from '../engine/dst.ts';
import { FeatureState } from '../engine/features.ts';
import { forecastPlayer, type ForecastEnv, type WeekForecast } from '../engine/forecast.ts';
import { adviseLineup, bestLineup, startable, type LineupAdvice, type TeamLineup } from '../engine/lineup.ts';
import { ProjectionModel, type ModelFile } from '../engine/model.ts';
import { starterSlots } from '../engine/positions.ts';
import { buildTeamWeeks, summarizeSeason, type SeasonSummary, type TeamWeek } from '../engine/recap.ts';
import { compileScoring, didPlay, hasForecast } from '../engine/scoring.ts';
import { computeValues, type PlayerValue } from '../engine/values.ts';
import type { NflGame, PlayerInfo, Stats } from '../engine/types.ts';

export const MODEL_DIR = path.resolve(import.meta.dirname, '..', 'model');

/**
 * Each league scores differently, so each gets a model trained on its own scoring when one
 * exists (model/model-<key>.json); otherwise the default model (trained on the Sleeper league).
 */
export function modelKey(leagueId: string): string {
  return /^espn-\d+/.exec(leagueId)?.[0] ?? 'default';
}
const modelFiles = (key: string) => key === 'default'
  ? { model: path.join(MODEL_DIR, 'model.json'), report: path.join(MODEL_DIR, 'report.json') }
  : { model: path.join(MODEL_DIR, `model-${key}.json`), report: path.join(MODEL_DIR, `report-${key}.json`) };
const models = new Map<string, ProjectionModel>();
export function modelFor(leagueId: string): { key: string; model: ProjectionModel; reportFile: string } {
  let key = modelKey(leagueId);
  if (!existsSync(modelFiles(key).model)) key = 'default';
  let m = models.get(key);
  if (!m) {
    m = new ProjectionModel(JSON.parse(readFileSync(modelFiles(key).model, 'utf8')) as ModelFile);
    models.set(key, m);
  }
  return { key, model: m, reportFile: modelFiles(key).report };
}
export const model = modelFor('default').model;

export interface TeamInfo {
  rosterId: number;
  name: string;
  owner: string;
  ownerId: string | null;
  avatar: string | null;
  roster: SleeperRoster;
}

export interface LeagueCore {
  id: string;
  platform: Platform;
  /** Which trained model serves this league. */
  modelKey: string;
  league: SleeperLeague;
  /** Roster owned by the configured login (ESPN), if known. */
  myRosterId: number | null;
  outlooks: Map<string, string>;
  defenseModel: DefenseModel | null;
  users: SleeperUser[];
  teams: TeamInfo[];
  season: number;
  /** Week being analysed (the league's current week), or null once the season is over. */
  week: number | null;
  lastScored: number;
  lastRegularWeek: number;
  lastWeek: number;
  horizon: number[];
  slots: string[];
  players: Record<string, PlayerInfo>;
  relevant: string[];
  forecasts: Map<number, Map<string, WeekForecast>>;
  env: ForecastEnv;
  ownerOf: Map<string, number>;
  taxiOrIr: Set<string>;
  schedule: Map<number, SleeperMatchup[]>;
  results: TeamWeek[][];
  summaries: Map<number, SeasonSummary>;
  values: Map<string, PlayerValue>;
  advice: Map<number, LineupAdvice>;
  bestByWeek: Map<string, TeamLineup>;
  transactions: SleeperTransaction[];
  trending: Map<string, number>;
  statsByWeek: Map<number, Map<string, WeekLine>>;
  prevStatsByWeek: Map<number, Map<string, WeekLine>>;
  projectionsByWeek: Map<number, Map<string, WeekLine>>;
  games: NflGame[];
  gameFor: (team: string, week: number) => NflGame | undefined;
  isLocked: (id: string) => boolean;
  generatedAt: string;
  warnings: string[];
}

const weeksIn = (season: number) => (season <= 2020 ? 17 : 18);

function lastFantasyWeek(league: SleeperLeague): { lastRegular: number; last: number } {
  const lastRegular = league.playoffWeekStart - 1;
  const rounds = Math.ceil(Math.log2(Math.max(2, league.playoffTeams)));
  const roundWeeks = league.playoffRoundType === 2 ? 2 : 1;
  const finalWeeks = league.playoffRoundType >= 1 ? 2 : 1;
  const last = Math.min(18, league.playoffWeekStart + (rounds - 1) * roundWeeks + finalWeeks - 1);
  return { lastRegular, last };
}

export function playoffShape(league: SleeperLeague) {
  return {
    roundWeeks: league.playoffRoundType === 2 ? 2 : 1,
    finalWeeks: league.playoffRoundType >= 1 ? 2 : 1,
  };
}

/** Yield to the event loop so requests keep flowing while a rebuild runs on a small CPU. */
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

const objectTags = new WeakMap<object, number>();
let nextTag = 1;
/** Stable id per object instance (changes when a cached value is replaced). */
function tagOf(value: object): number {
  let t = objectTags.get(value);
  if (!t) { t = nextTag++; objectTags.set(value, t); }
  return t;
}

interface Inputs {
  platform: Platform;
  extras: LeagueExtras;
  state: Awaited<ReturnType<typeof sleeper.state>>;
  league: SleeperLeague;
  users: SleeperUser[];
  rosters: SleeperRoster[];
  players: Record<string, PlayerInfo>;
  games: NflGame[];
  week: number | null;
  lastScored: number;
  lastRegular: number;
  last: number;
  horizon: number[];
  seasonOver: boolean;
  pastWeeks: number[];
  prevWeeks: number[];
  prevStats: WeekLine[][];
  prevProj: WeekLine[][];
  curStats: WeekLine[][];
  curProj: WeekLine[][];
  futureProj: WeekLine[][];
  liveStats: WeekLine[];
  schedule: SleeperMatchup[][];
  trending: { id: string; count: number }[];
  liveSchedule: Awaited<ReturnType<typeof sleeperSchedule>>;
  transactions: SleeperTransaction[];
  warnings: string[];
  fingerprint: string;
}

async function loadInputs(id: string): Promise<Inputs> {
  const warnings: string[] = [];
  const src = sourceFor(id);
  const [state, league] = await Promise.all([sleeper.state(), src.league()]);
  const [users, rosters, players, allGames, extras] = await Promise.all([src.users(), src.rosters(), sleeper.players(), nflGames(), src.extras()]);
  const season = league.season;
  const { lastRegular, last } = lastFantasyWeek(league);
  const seasonOver = season < state.season || league.status === 'complete';
  const preseason = league.status === 'pre_draft' || league.status === 'drafting';
  const week = seasonOver ? null : preseason ? 1 : Math.min(Math.max(1, league.week), last);
  const lastScored = seasonOver ? last : Math.min(league.lastScoredWeek, (week ?? 1) - 1);
  const horizon = week === null ? [] : Array.from({ length: last - week + 1 }, (_, i) => week + i);
  const fresh = (s: number, w: number) => ({ season: s, week: w, currentSeason: state.season, currentWeek: state.season === season ? state.week : 99 });
  const pastWeeks = Array.from({ length: Math.max(0, (week ?? last + 1) - 1) }, (_, i) => i + 1);
  const prevWeeks = Array.from({ length: weeksIn(season - 1) }, (_, i) => i + 1);
  const none = () => [] as WeekLine[];
  const txWeeks = Array.from({ length: Math.max(1, week ?? last) }, (_, i) => i + 1);
  const [prevStats, prevProj, curStats, curProj, futureProj, liveStats, schedule, trending, liveSchedule, txLists] = await Promise.all([
    Promise.all(prevWeeks.map(w => weekStats(fresh(season - 1, w)).catch(none))),
    Promise.all(prevWeeks.map(w => weekProjections(fresh(season - 1, w)).catch(none))),
    Promise.all(pastWeeks.map(w => weekStats(fresh(season, w)).catch(none))),
    Promise.all(pastWeeks.map(w => weekProjections(fresh(season, w)).catch(none))),
    Promise.all(horizon.map(w => weekProjections(fresh(season, w)).catch(none))),
    week !== null ? weekStats(fresh(season, week)).catch(none) : Promise.resolve(none()),
    Promise.all(Array.from({ length: lastRegular }, (_, i) => src.matchups(i + 1, seasonOver).catch(() => [] as SleeperMatchup[]))),
    sleeper.trending('add').catch(() => []),
    week !== null ? sleeperSchedule(season).catch(() => []) : Promise.resolve([]),
    Promise.all(txWeeks.map(w => src.transactions(w, seasonOver || (week !== null && w < week - 1)).catch(() => []))),
  ]);
  const games = allGames.filter(g => g.season === season);
  if (!games.length) warnings.push('NFL schedule unavailable: kickoff locks and byes cannot be verified.');
  const transactions = txLists.flat().filter(t => t.status === 'complete').sort((a, b) => b.created - a.created);

  // Everything that can change a number on screen. Unchanged fingerprint → reuse the last core.
  const now = Date.now();
  const kickedOff = week === null ? 0 : games.filter(g => g.week === week && g.kickoff !== null && g.kickoff <= now).length;
  const fingerprint = [
    tagOf(players), tagOf(allGames),
    JSON.stringify([league.week, league.lastScoredWeek, league.status, league.scoring, league.rosterPositions, league.name]),
    JSON.stringify(rosters), JSON.stringify(users),
    JSON.stringify(schedule.map(ms => ms.map(m => [m.rosterId, m.matchupId, m.points, m.starters]))),
    [...curStats, ...curProj, ...futureProj, liveStats].map(linesSignature).join(','),
    JSON.stringify(liveSchedule.filter(g => g.week === week)), kickedOff,
    transactions.length ? `${transactions.length}:${transactions[0].created}` : '0',
  ].join('|');

  return {
    platform: src.platform, extras, state, league, users, rosters, players, games, week, lastScored, lastRegular, last, horizon, seasonOver, pastWeeks, prevWeeks,
    prevStats, prevProj, curStats, curProj, futureProj, liveStats, schedule, trending, liveSchedule, transactions, warnings, fingerprint,
  };
}

async function computeCore(id: string, input: Inputs): Promise<LeagueCore> {
  const { league, users, rosters, games, week, lastScored, lastRegular, last, horizon, pastWeeks, prevWeeks,
    prevStats, prevProj, curStats, curProj, futureProj, liveStats, schedule, liveSchedule, warnings } = input;
  const season = league.season;
  const scoring = compileScoring(league.scoring);
  const slots = starterSlots(league.rosterPositions);

  // Injury tags ride along with the (frequently refreshed) projection rows; prefer whichever is newer.
  const players: Record<string, PlayerInfo> = Object.create(input.players) as Record<string, PlayerInfo>;
  Object.assign(players, input.extras.players);
  for (const line of [...(futureProj[0] ?? []), ...liveStats]) {
    const base = input.players[line.id];
    if (!base || !line.injury) continue;
    const newer = (line.injury.at ?? 0) >= (base.newsUpdated ?? 0);
    if (newer && line.injury.status !== base.injuryStatus) players[line.id] = { ...base, injuryStatus: line.injury.status, newsUpdated: line.injury.at ?? base.newsUpdated };
  }

  const gameIndex = new Map<string, NflGame>();
  for (const g of games) { gameIndex.set(`${g.week}:${g.home}`, g); gameIndex.set(`${g.week}:${g.away}`, g); }
  const gameFor = (team: string, w: number) => gameIndex.get(`${w}:${team}`);

  const fs = new FeatureState(scoring, pid => {
    const p = players[pid];
    return p ? { pos: p.pos, birthDate: p.birthDate, yearsExp: p.yearsExp } : undefined;
  });
  const toMap = (lines: WeekLine[]) => new Map(lines.map(l => [l.id, l]));
  const projStatsMap = (lines: WeekLine[]) => new Map(lines.filter(l => hasForecast(l.stats)).map(l => [l.id, l.stats]));
  fs.startSeason(season - 1);
  for (let i = 0; i < prevWeeks.length; i++) {
    fs.ingestWeek(season - 1, prevWeeks[i], prevStats[i], projStatsMap(prevProj[i]));
    if (i % 3 === 2) await tick();
  }
  fs.startSeason(season);
  for (let i = 0; i < pastWeeks.length; i++) fs.ingestWeek(season, pastWeeks[i], curStats[i], projStatsMap(curProj[i]));
  fs.clearAverages();
  await tick();

  const projectionsByWeek = new Map<number, Map<string, WeekLine>>();
  horizon.forEach((w, i) => projectionsByWeek.set(w, toMap(futureProj[i])));
  pastWeeks.forEach((w, i) => projectionsByWeek.set(w, toMap(curProj[i])));
  const statsByWeek = new Map<number, Map<string, WeekLine>>();
  pastWeeks.forEach((w, i) => statsByWeek.set(w, toMap(curStats[i])));
  if (week !== null && liveStats.length) statsByWeek.set(week, toMap(liveStats));
  const prevStatsByWeek = new Map<number, Map<string, WeekLine>>();
  prevWeeks.forEach((w, i) => prevStatsByWeek.set(w, toMap(prevStats[i])));

  const statusIndex = new Map<string, 'pre_game' | 'in_game' | 'complete'>();
  for (const g of liveSchedule) {
    const st = g.status === 'complete' ? 'complete' : g.status === 'in_game' ? 'in_game' : 'pre_game';
    statusIndex.set(`${g.week}:${g.home}`, st);
    statusIndex.set(`${g.week}:${g.away}`, st);
  }
  const now = Date.now();
  const gameStatus = (team: string, w: number) => {
    const st = statusIndex.get(`${w}:${team}`);
    const kickoff = gameFor(team, w)?.kickoff;
    // Sleeper's status can lag kickoff by a few minutes; the published kickoff time is authoritative for locks.
    if ((!st || st === 'pre_game') && kickoff && kickoff <= now) return 'in_game' as const;
    return st;
  };
  const liveMap = new Map<string, Stats>(liveStats.map(l => [l.id, l.stats]));
  const { model, key: modelKeyUsed } = modelFor(id);
  // Team defenses: residual spread from every D/ST game on record (last season plus this one so far).
  const hasDefense = slots.includes('DEF');
  const defenseModel = hasDefense ? fitDefenseModel(defenseRows(
    [...prevWeeks.map((_, i) => ({ stats: prevStats[i], projections: projStatsMap(prevProj[i]) })), ...pastWeeks.map((_, i) => ({ stats: curStats[i], projections: projStatsMap(curProj[i]) }))],
    pid => input.players[pid]?.pos === 'DEF', scoring,
  )) : null;
  const env: ForecastEnv = {
    model, state: fs, season, currentWeek: week ?? last + 1, players, scoring, gameFor,
    projections: w => projectionsByWeek.get(w), liveStats: liveMap, gameStatus, defense: defenseModel, now,
  };

  // Relevant universe: rostered players, anyone with a forecast soon, anyone with a real track record.
  const ownerOf = new Map<string, number>();
  const taxiOrIr = new Set<string>();
  for (const r of rosters) {
    for (const pid of r.players) ownerOf.set(pid, r.rosterId);
    for (const pid of [...r.reserve, ...r.taxi]) taxiOrIr.add(pid);
  }
  const relevantSet = new Set<string>(ownerOf.keys());
  for (const w of horizon.slice(0, 3)) for (const [pid, line] of projectionsByWeek.get(w) ?? []) if (hasForecast(line.stats)) relevantSet.add(pid);
  for (const lines of [...curStats, ...prevStats.slice(-8)]) for (const l of lines) if (didPlay(l.stats)) relevantSet.add(l.id);
  const relevant = [...relevantSet].filter(pid => {
    const p = players[pid];
    if (!p || !startable(slots, p)) return false;
    if (p.pos === 'DEF') return hasDefense && !!p.team;
    return ownerOf.has(pid) || fs.history(pid).length > 0 || projectionsByWeek.get(horizon[0] ?? -1)?.has(pid);
  });

  // Everyone gets the next two weeks; later weeks only for players who could matter to a lineup.
  const forecasts = new Map<number, Map<string, WeekForecast>>();
  let longHorizon = relevant;
  for (let i = 0; i < horizon.length; i++) {
    const w = horizon[i];
    if (i === 2) {
      longHorizon = relevant.filter(pid => ownerOf.has(pid) || Math.max(forecasts.get(horizon[0])?.get(pid)?.expected ?? 0, forecasts.get(horizon[1])?.get(pid)?.expected ?? 0) >= 1.5);
    }
    const m = new Map<string, WeekForecast>();
    const ids = i < 2 ? relevant : longHorizon;
    for (let k = 0; k < ids.length; k++) {
      m.set(ids[k], forecastPlayer(env, ids[k], w));
      if (k % 400 === 399) await tick();
    }
    forecasts.set(w, m);
    await tick();
  }

  const isLocked = (pid: string) => {
    if (week === null) return true;
    const f = forecasts.get(week)?.get(pid);
    return !!f?.live && f.live.status !== 'pre_game';
  };

  const teams: TeamInfo[] = rosters.map(r => {
    const u = users.find(x => x.userId === r.ownerId);
    return { rosterId: r.rosterId, name: u?.teamName ?? u?.displayName ?? `Team ${r.rosterId}`, owner: u?.displayName ?? 'Open team', ownerId: r.ownerId, avatar: u?.avatar ?? null, roster: r };
  });

  // Lineups: current-week advice (with locks) and best lineup every remaining week.
  const advice = new Map<number, LineupAdvice>();
  const bestByWeek = new Map<string, TeamLineup>();
  for (const t of teams) {
    const active = t.roster.players.filter(pid => !taxiOrIr.has(pid));
    if (week !== null) {
      const current = forecasts.get(week)!;
      const liveStarters = schedule[week - 1]?.find(m => m.rosterId === t.rosterId)?.starters;
      const starters = liveStarters?.length ? liveStarters : t.roster.starters;
      advice.set(t.rosterId, adviseLineup(slots, starters, active, players, current, isLocked));
    }
    for (const w of horizon) {
      if (w === week) { bestByWeek.set(`${t.rosterId}:${w}`, advice.get(t.rosterId)!.optimal); continue; }
      bestByWeek.set(`${t.rosterId}:${w}`, bestLineup(slots, active, players, forecasts.get(w)!));
    }
    await tick();
  }

  const results: TeamWeek[][] = [];
  for (let w = 1; w <= Math.min(lastScored, lastRegular); w++) {
    const ms = schedule[w - 1];
    if (ms?.length) results.push(buildTeamWeeks(w, ms, slots, players));
  }
  const summaries = summarizeSeason(results, teams.map(t => t.rosterId));
  await tick();
  const values = computeValues({ ids: relevant, players, weeks: horizon, forecasts, rostered: new Set(ownerOf.keys()), dynasty: league.isDynasty });

  return {
    id, platform: input.platform, modelKey: modelKeyUsed, myRosterId: input.extras.myRosterId, outlooks: input.extras.outlooks, defenseModel,
    league, users, teams, season, week, lastScored, lastRegularWeek: lastRegular, lastWeek: last, horizon, slots, players, relevant,
    forecasts, env, ownerOf, taxiOrIr, schedule: new Map(schedule.map((m, i) => [i + 1, m])), results, summaries, values, advice, bestByWeek,
    transactions: input.transactions, trending: new Map(input.trending.map(t => [t.id, t.count])), statsByWeek, prevStatsByWeek, projectionsByWeek,
    games, gameFor, isLocked, generatedAt: new Date(now).toISOString(), warnings,
  };
}

interface CoreEntry { core: LeagueCore; at: number; fingerprint: string }
const cores = new Map<string, CoreEntry>();
const rebuilding = new Map<string, Promise<LeagueCore>>();
const listeners: ((core: LeagueCore) => void)[] = [];
/** Refresh check interval: tighter while games are being played. */
const FRESH_IDLE = 5 * MINUTE;
const FRESH_LIVE = 1.5 * MINUTE;
/** An older core is still shown instantly (with its timestamp) while a fresh one builds. */
const USABLE = 12 * 60 * MINUTE;

/** Run after every new core (e.g. to precompute the heaviest views in the background). */
export function onCoreBuilt(listener: (core: LeagueCore) => void) {
  listeners.push(listener);
}

function rebuild(id: string): Promise<LeagueCore> {
  let p = rebuilding.get(id);
  if (!p) {
    p = (async () => {
      const input = await loadInputs(id);
      const hit = cores.get(id);
      // Nothing changed upstream: keep the existing core (and every view already computed from it).
      if (hit && hit.fingerprint === input.fingerprint) {
        hit.at = Date.now();
        return hit.core;
      }
      const core = await computeCore(id, input);
      cores.set(id, { core, at: Date.now(), fingerprint: input.fingerprint });
      if (cores.size > 20) cores.delete(cores.keys().next().value!);
      for (const l of listeners) { try { l(core); } catch { /* warming is best-effort */ } }
      return core;
    })().finally(() => rebuilding.delete(id));
    rebuilding.set(id, p);
  }
  return p;
}

function isLive(core: LeagueCore): boolean {
  if (core.week === null) return false;
  const now = Date.now();
  return core.games.some(g => g.week === core.week && g.kickoff !== null && g.kickoff <= now && now - g.kickoff < 4.5 * 60 * MINUTE);
}

/**
 * Stale-while-revalidate. A recent core is served as is; an older one (up to 12 h) is served
 * instantly while inputs are re-checked in the background and the core is rebuilt only if they changed.
 */
export function getCore(id: string): Promise<LeagueCore> {
  const hit = cores.get(id);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < (isLive(hit.core) ? FRESH_LIVE : FRESH_IDLE)) return Promise.resolve(hit.core);
  if (hit && age < USABLE) {
    void rebuild(id).catch(error => console.warn(`[core] refresh failed for ${id}:`, (error as Error).message));
    return Promise.resolve(hit.core);
  }
  return rebuild(id);
}
