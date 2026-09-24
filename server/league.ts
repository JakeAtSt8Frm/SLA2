/**
 * Builds the in-memory analysis "core" for a league: every relevant player's forecast for
 * each remaining week, lineups, values, results and schedule. Endpoints are thin views over it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MINUTE } from './cache.ts';
import {
  nflGames, sleeper, sleeperSchedule, weekProjections, weekStats,
  type SleeperLeague, type SleeperMatchup, type SleeperRoster, type SleeperTransaction, type SleeperUser, type WeekLine,
} from './sleeper.ts';
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
const modelFile = JSON.parse(readFileSync(path.join(MODEL_DIR, 'model.json'), 'utf8')) as ModelFile;
export const model = new ProjectionModel(modelFile);

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
  league: SleeperLeague;
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

async function buildCore(id: string): Promise<LeagueCore> {
  const warnings: string[] = [];
  const [state, league] = await Promise.all([sleeper.state(), sleeper.league(id)]);
  const [users, rosters, players, allGames] = await Promise.all([sleeper.users(id), sleeper.rosters(id), sleeper.players(), nflGames()]);
  const season = league.season;
  const scoring = compileScoring(league.scoring);
  const slots = starterSlots(league.rosterPositions);
  const { lastRegular, last } = lastFantasyWeek(league);
  const seasonOver = season < state.season || league.status === 'complete';
  const preseason = league.status === 'pre_draft' || league.status === 'drafting';
  const week = seasonOver ? null : preseason ? 1 : Math.min(Math.max(1, league.week), last);
  const lastScored = seasonOver ? last : Math.min(league.lastScoredWeek, (week ?? 1) - 1);
  const horizon = week === null ? [] : Array.from({ length: last - week + 1 }, (_, i) => week + i);

  const fresh = (s: number, w: number) => ({ season: s, week: w, currentSeason: state.season, currentWeek: state.season === season ? state.week : 99 });
  const games = allGames.filter(g => g.season === season);
  const gameIndex = new Map<string, NflGame>();
  for (const g of games) { gameIndex.set(`${g.week}:${g.home}`, g); gameIndex.set(`${g.week}:${g.away}`, g); }
  const gameFor = (team: string, w: number) => gameIndex.get(`${w}:${team}`);
  if (!games.length) warnings.push('NFL schedule unavailable: kickoff locks and byes cannot be verified.');

  // Completed weeks this season + all of last season feed the feature state.
  const pastWeeks = Array.from({ length: Math.max(0, (week ?? last + 1) - 1) }, (_, i) => i + 1);
  const prevWeeks = Array.from({ length: weeksIn(season - 1) }, (_, i) => i + 1);
  const [prevStats, prevProj, curStats, curProj, futureProj, liveStats, schedule, trendingAdds] = await Promise.all([
    Promise.all(prevWeeks.map(w => weekStats(fresh(season - 1, w)).catch(() => [] as WeekLine[]))),
    Promise.all(prevWeeks.map(w => weekProjections(fresh(season - 1, w)).catch(() => [] as WeekLine[]))),
    Promise.all(pastWeeks.map(w => weekStats(fresh(season, w)).catch(() => { warnings.push(`Week ${w} stats unavailable.`); return [] as WeekLine[]; }))),
    Promise.all(pastWeeks.map(w => weekProjections(fresh(season, w)).catch(() => [] as WeekLine[]))),
    Promise.all(horizon.map(w => weekProjections(fresh(season, w)).catch(() => { warnings.push(`Week ${w} projections unavailable; forecasts fall back to form.`); return [] as WeekLine[]; }))),
    week !== null ? weekStats(fresh(season, week)).catch(() => [] as WeekLine[]) : Promise.resolve([] as WeekLine[]),
    Promise.all(Array.from({ length: lastRegular }, (_, i) => sleeper.matchups(id, i + 1, seasonOver).catch(() => [] as SleeperMatchup[]))),
    sleeper.trending('add').catch(() => []),
  ]);
  const liveSchedule = week !== null ? await sleeperSchedule(season).catch(() => []) : [];

  const fs = new FeatureState(scoring, pid => {
    const p = players[pid];
    return p ? { pos: p.pos, birthDate: p.birthDate, yearsExp: p.yearsExp } : undefined;
  });
  const toMap = (lines: WeekLine[]) => new Map(lines.map(l => [l.id, l]));
  const projStatsMap = (lines: WeekLine[]) => new Map(lines.filter(l => hasForecast(l.stats)).map(l => [l.id, l.stats]));
  fs.startSeason(season - 1);
  prevWeeks.forEach((w, i) => fs.ingestWeek(season - 1, w, prevStats[i], projStatsMap(prevProj[i])));
  fs.startSeason(season);
  pastWeeks.forEach((w, i) => fs.ingestWeek(season, w, curStats[i], projStatsMap(curProj[i])));
  fs.clearAverages();

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
    const s = g.status === 'complete' ? 'complete' : g.status === 'in_game' ? 'in_game' : 'pre_game';
    statusIndex.set(`${g.week}:${g.home}`, s);
    statusIndex.set(`${g.week}:${g.away}`, s);
  }
  const now = Date.now();
  const gameStatus = (team: string, w: number) => {
    const s = statusIndex.get(`${w}:${team}`);
    const kickoff = gameFor(team, w)?.kickoff;
    // Sleeper's status can lag kickoff by a few minutes; the published kickoff time is authoritative for locks.
    if ((!s || s === 'pre_game') && kickoff && kickoff <= now) return 'in_game' as const;
    return s;
  };
  const liveMap = new Map<string, Stats>(liveStats.map(l => [l.id, l.stats]));

  const env: ForecastEnv = {
    model, state: fs, season, currentWeek: week ?? last + 1, players, scoring, gameFor,
    projections: w => projectionsByWeek.get(w), liveStats: liveMap, gameStatus, now,
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
    return p && p.pos !== 'DEF' && startable(slots, p) && (ownerOf.has(pid) || fs.history(pid).length > 0 || projectionsByWeek.get(horizon[0] ?? -1)?.has(pid));
  });

  const forecasts = new Map<number, Map<string, WeekForecast>>();
  for (const w of horizon) {
    const m = new Map<string, WeekForecast>();
    for (const pid of relevant) m.set(pid, forecastPlayer(env, pid, w));
    forecasts.set(w, m);
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
  }

  const results: TeamWeek[][] = [];
  for (let w = 1; w <= Math.min(lastScored, lastRegular); w++) {
    const ms = schedule[w - 1];
    if (ms?.length) results.push(buildTeamWeeks(w, ms, slots, players));
  }
  const summaries = summarizeSeason(results, teams.map(t => t.rosterId));

  const values = computeValues({ ids: relevant, players, weeks: horizon, forecasts, rostered: new Set(ownerOf.keys()) });

  const txWeeks = Array.from({ length: Math.max(1, week ?? last) }, (_, i) => i + 1);
  const transactions = (await Promise.all(txWeeks.map(w => sleeper.transactions(id, w, seasonOver || (week !== null && w < week - 1)).catch(() => [])))).flat()
    .filter(t => t.status === 'complete').sort((a, b) => b.created - a.created);

  if (week !== null && !projectionsByWeek.get(week)?.size) warnings.push('No provider projections for this week yet; forecasts rely on recent form only.');

  return {
    id, league, users, teams, season, week, lastScored, lastRegularWeek: lastRegular, lastWeek: last, horizon, slots, players, relevant,
    forecasts, env, ownerOf, taxiOrIr, schedule: new Map(schedule.map((m, i) => [i + 1, m])), results, summaries, values, advice, bestByWeek,
    transactions, trending: new Map(trendingAdds.map(t => [t.id, t.count])), statsByWeek, prevStatsByWeek, projectionsByWeek,
    games, gameFor, isLocked, generatedAt: new Date(now).toISOString(), warnings,
  };
}

const cores = new Map<string, { core: LeagueCore; at: number }>();
const rebuilding = new Map<string, Promise<LeagueCore>>();
const FRESH = 1.5 * MINUTE;
const USABLE = 15 * MINUTE;

function rebuild(id: string): Promise<LeagueCore> {
  let p = rebuilding.get(id);
  if (!p) {
    p = buildCore(id).then(core => {
      cores.set(id, { core, at: Date.now() });
      if (cores.size > 20) cores.delete(cores.keys().next().value!);
      return core;
    }).finally(() => rebuilding.delete(id));
    rebuilding.set(id, p);
  }
  return p;
}

/**
 * Stale-while-revalidate: a core younger than 90 s is served as is; an older one (up to 15 min)
 * is served instantly while a fresh build runs in the background. Live games stay within ~90 s.
 */
export function getCore(id: string): Promise<LeagueCore> {
  const hit = cores.get(id);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < FRESH) return Promise.resolve(hit.core);
  if (hit && age < USABLE) {
    void rebuild(id).catch(error => console.warn(`[core] refresh failed for ${id}:`, (error as Error).message));
    return Promise.resolve(hit.core);
  }
  return rebuild(id);
}
