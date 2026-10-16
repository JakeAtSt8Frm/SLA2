/**
 * Builds the in-memory analysis "core" for a league: every relevant player's forecast for
 * each remaining week, lineups, values, results and schedule. Endpoints are thin views over it.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MINUTE, refreshesSettled } from './cache.ts';
import {
  applyInjuryTags, lineSignature, linesSignature, nflGames, sleeper, sleeperSchedule, weekProjections, weekStats,
  type SleeperLeague, type SleeperMatchup, type SleeperRoster, type SleeperTransaction, type SleeperUser, type WeekLine,
} from './sleeper.ts';
import { sourceFor, type LeagueExtras, type Platform } from './source.ts';
import { defenseRows, fitDefenseModel, type DefenseModel } from '../engine/dst.ts';
import { FeatureState } from '../engine/features.ts';
import { pregameForecast, replayForecast, withLiveState, type ForecastEnv, type PregamePoint, type WeekForecast } from '../engine/forecast.ts';
import { adviseLineup, bestLineup, startable, type LineupAdvice, type TeamLineup } from '../engine/lineup.ts';
import { ProjectionModel, type ModelFile } from '../engine/model.ts';
import { starterSlots } from '../engine/positions.ts';
import { buildTeamWeeks, summarizeSeason, type SeasonSummary, type TeamWeek } from '../engine/recap.ts';
import { compileScoring, didPlay, hasForecast } from '../engine/scoring.ts';
import { computeValues, type PlayerValue } from '../engine/values.ts';
import { readSnapshots } from './snapshots.ts';
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
  /**
   * What the model forecast before kickoff (expected points): saved at kickoff when this server
   * was running (data/snapshots), otherwise replayed from the games before that week. Later
   * weeks get the current forecast. `season` defaults to the league's season (last season: replay only).
   */
  pregame: (id: string, week: number, season?: number) => number | null;
  /** The current week's forecasts as they stand before the live overlay. */
  currentPregame: ReadonlyMap<string, WeekForecast>;
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
  allGames: NflGame[];
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
  /** Identifies the NFL schedule and betting lines in use (shared by every forecast). */
  gamesTag: number;
  /** Content signatures of this season's completed weeks (stats, projections). */
  pastSignatures: string;
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
  const pastSignatures = [...curStats, ...curProj].map(linesSignature).join(',');
  const fingerprint = [
    tagOf(players), tagOf(allGames),
    JSON.stringify([league.week, league.lastScoredWeek, league.status, league.scoring, league.rosterPositions, league.name]),
    JSON.stringify(rosters), JSON.stringify(users),
    JSON.stringify(schedule.map(ms => ms.map(m => [m.rosterId, m.matchupId, m.points, m.starters]))),
    pastSignatures, [...futureProj, liveStats].map(linesSignature).join(','),
    JSON.stringify(liveSchedule.filter(g => g.week === week)), kickedOff,
    transactions.length ? `${transactions.length}:${transactions[0].created}` : '0',
  ].join('|');

  return {
    platform: src.platform, extras, state, league, users, rosters, players, games, allGames, week, lastScored, lastRegular, last, horizon, seasonOver, pastWeeks, prevWeeks,
    prevStats, prevProj, curStats, curProj, futureProj, liveStats, schedule, trending, liveSchedule, transactions, warnings, fingerprint,
    gamesTag: tagOf(allGames), pastSignatures,
  };
}

/**
 * Everything learned from completed games: the feature state, the D/ST residual model and each
 * completed week's replayed pregame forecast (keyed `${season}:${week}`).
 */
interface History { key: string; state: FeatureState; defense: DefenseModel | null; pregame: Map<string, Map<string, PregamePoint>> }
const histories = new Map<string, History>();

interface PregameMemo { context: string; weeks: Map<number, Map<string, { key: string; forecast: WeekForecast }>> }
const pregameMemo = new Map<string, PregameMemo>();

/**
 * Replays last season and this season's completed weeks into a FeatureState. Only a stat
 * correction, a newly final week or a new player catalogue changes it, so it is kept between
 * rebuilds. (Last season's weeks are immutable, cached-forever objects: identity is enough.)
 */
async function historyFor(id: string, input: Inputs, scoring: [string, number][], slots: string[]): Promise<History> {
  const { league, prevWeeks, pastWeeks, prevStats, prevProj, curStats, curProj, extras } = input;
  const season = league.season;
  const hasDefense = slots.includes('DEF');
  const { model, key: modelKeyUsed } = modelFor(id);
  const key = [
    season, slots.join(','), modelKeyUsed, input.gamesTag, tagOf(input.players), JSON.stringify(scoring), input.pastSignatures,
    prevStats.map(tagOf).join(','), prevProj.map(tagOf).join(','),
    JSON.stringify(Object.values(extras.players).map(p => [p.id, p.pos, p.birthDate, p.yearsExp])),
  ].join('|');
  const hit = histories.get(id);
  if (hit?.key === key) return hit;

  const meta = (pid: string) => {
    const p = extras.players[pid] ?? input.players[pid];
    return p ? { pos: p.pos, birthDate: p.birthDate, yearsExp: p.yearsExp } : undefined;
  };
  const projStatsMap = (lines: WeekLine[]) => new Map(lines.filter(l => hasForecast(l.stats)).map(l => [l.id, l.stats]));
  const state = new FeatureState(scoring, meta);
  const players: Record<string, PlayerInfo> = { ...input.players, ...extras.players };
  const gameIndex = new Map<string, NflGame>();
  for (const g of input.allGames) if (g.season >= season - 1) { gameIndex.set(`${g.season}:${g.week}:${g.home}`, g); gameIndex.set(`${g.season}:${g.week}:${g.away}`, g); }
  const pregame = new Map<string, Map<string, PregamePoint>>();
  // Before each completed week goes in, forecast it from the games before it: the pregame record.
  const replay = (s: number, w: number, stats: WeekLine[], proj: WeekLine[]) => {
    state.clearAverages();
    const byId = new Map<string, WeekLine>(proj.filter(l => hasForecast(l.stats)).map(l => [l.id, l]));
    const env: ForecastEnv = {
      model, state, season: s, currentWeek: w, players, scoring, gameFor: (team, wk) => gameIndex.get(`${s}:${wk}:${team}`),
      projections: wk => (wk === w ? byId : undefined), defense: null, now: 0,
    };
    const teamOf = new Map<string, string | null>();
    for (const l of stats) if (didPlay(l.stats)) teamOf.set(l.id, l.team);
    for (const l of byId.values()) teamOf.set(l.id, l.team ?? teamOf.get(l.id) ?? null);
    const out = new Map<string, PregamePoint>();
    for (const [pid, team] of teamOf) {
      const p = players[pid];
      if (!p || !startable(slots, p) || (p.pos === 'DEF' && !hasDefense)) continue;
      const f = replayForecast(env, pid, w, team);
      if (f) out.set(pid, f);
    }
    pregame.set(`${s}:${w}`, out);
  };
  state.startSeason(season - 1);
  for (let i = 0; i < prevWeeks.length; i++) {
    replay(season - 1, prevWeeks[i], prevStats[i], prevProj[i]);
    state.ingestWeek(season - 1, prevWeeks[i], prevStats[i], projStatsMap(prevProj[i]));
    await tick();
  }
  state.startSeason(season);
  for (let i = 0; i < pastWeeks.length; i++) {
    replay(season, pastWeeks[i], curStats[i], curProj[i]);
    state.ingestWeek(season, pastWeeks[i], curStats[i], projStatsMap(curProj[i]));
    await tick();
  }
  state.clearAverages();
  await tick();
  // Team defenses: residual spread from every D/ST game on record (last season plus this one so far).
  const defense = hasDefense ? fitDefenseModel(defenseRows(
    [...prevWeeks.map((_, i) => ({ stats: prevStats[i], projections: projStatsMap(prevProj[i]) })), ...pastWeeks.map((_, i) => ({ stats: curStats[i], projections: projStatsMap(curProj[i]) }))],
    pid => input.players[pid]?.pos === 'DEF', scoring,
  )) : null;
  const history = { key, state, defense, pregame };
  histories.set(id, history);
  return history;
}

async function computeCore(id: string, input: Inputs): Promise<LeagueCore> {
  const { league, users, rosters, games, week, lastScored, lastRegular, last, horizon, pastWeeks, prevWeeks,
    prevStats, curStats, curProj, futureProj, liveStats, schedule, liveSchedule, warnings } = input;
  const season = league.season;
  const scoring = compileScoring(league.scoring);
  const slots = starterSlots(league.rosterPositions);

  // Injury tags ride along with the (frequently refreshed) projection and stat rows.
  const players: Record<string, PlayerInfo> = Object.create(input.players) as Record<string, PlayerInfo>;
  Object.assign(players, input.extras.players);
  applyInjuryTags(input.players, players, [...(futureProj[0] ?? []), ...liveStats]);

  const gameIndex = new Map<string, NflGame>();
  for (const g of games) { gameIndex.set(`${g.week}:${g.home}`, g); gameIndex.set(`${g.week}:${g.away}`, g); }
  const gameFor = (team: string, w: number) => gameIndex.get(`${w}:${team}`);

  const toMap = (lines: WeekLine[]) => new Map(lines.map(l => [l.id, l]));
  const hasDefense = slots.includes('DEF');
  const history = await historyFor(id, input, scoring, slots);
  const snapshots = await readSnapshots(id, season, week === null ? pastWeeks : [...pastWeeks, week]);

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
  const fs = history.state;
  const defenseModel = history.defense;
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
  // A player's pregame forecast is reused from the last rebuild unless one of its inputs changed,
  // so live scoring updates on game days only redo the (cheap) in-game overlay.
  const memoContext = `${history.key}|${input.gamesTag}|${week}|${modelKeyUsed}`;
  const previous = pregameMemo.get(id);
  const reuse = previous?.context === memoContext ? previous.weeks : null;
  const memo: PregameMemo = { context: memoContext, weeks: new Map() };
  const forecasts = new Map<number, Map<string, WeekForecast>>();
  /** This week's forecasts before the live overlay. */
  let currentPre = new Map<string, WeekForecast>();
  let longHorizon = relevant;
  let computed = 0;
  for (let i = 0; i < horizon.length; i++) {
    const w = horizon[i];
    if (i === 2) {
      longHorizon = relevant.filter(pid => ownerOf.has(pid) || Math.max(forecasts.get(horizon[0])?.get(pid)?.expected ?? 0, forecasts.get(horizon[1])?.get(pid)?.expected ?? 0) >= 1.5);
    }
    const m = new Map<string, WeekForecast>();
    const kept = new Map<string, { key: string; forecast: WeekForecast }>();
    const before = reuse?.get(w);
    const projections = projectionsByWeek.get(w);
    const ids = i < 2 ? relevant : longHorizon;
    for (let k = 0; k < ids.length; k++) {
      const pid = ids[k];
      const p = players[pid];
      const line = projections?.get(pid);
      const key = `${p.pos}|${p.team}|${p.injuryStatus}|${line ? lineSignature(line) : '-'}`;
      const hit = before?.get(pid);
      let pre: WeekForecast;
      if (hit && hit.key === key) pre = hit.forecast;
      else {
        pre = pregameForecast(env, pid, w);
        if (++computed % 400 === 0) await tick();
      }
      kept.set(pid, { key, forecast: pre });
      m.set(pid, w === week ? withLiveState(env, pre) : pre);
    }
    if (w === week) currentPre = new Map([...kept].map(([pid, e]) => [pid, e.forecast]));
    memo.weeks.set(w, kept);
    forecasts.set(w, m);
  }
  pregameMemo.set(id, memo);
  await tick();

  const isLocked = (pid: string) => {
    if (week === null) return true;
    const f = forecasts.get(week)?.get(pid);
    return !!f?.live && f.live.status !== 'pre_game';
  };
  const pregame = (pid: string, w: number, s = season): number | null => {
    if (s !== season) return history.pregame.get(`${s}:${w}`)?.get(pid)?.exp ?? null;
    const saved = snapshots.get(w)?.[pid]?.exp;
    if (week !== null && w > week) return forecasts.get(w)?.get(pid)?.expected ?? null;
    // The saved copy is frozen at kickoff; before kickoff the current forecast is the pregame one.
    if (w === week) return isLocked(pid) && saved !== undefined ? saved : currentPre.get(pid)?.expected ?? saved ?? null;
    return saved ?? history.pregame.get(`${s}:${w}`)?.get(pid)?.exp ?? null;
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
    games, gameFor, isLocked, pregame, currentPregame: currentPre, generatedAt: new Date(now).toISOString(), warnings,
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

/** How long a build that nobody can be shown an older core for waits on stale inputs to refresh. */
const STALE_INPUT_WAIT = 15_000;

/** True if `task` settles within `ms`. */
function settlesWithin(task: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>(resolve => { timer = setTimeout(resolve, ms, false); });
  return Promise.race([task.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

function rebuild(id: string, followUp = true): Promise<LeagueCore> {
  let p = rebuilding.get(id);
  if (!p) {
    let settled: Promise<void> | null = null;
    p = (async () => {
      // After a restart there is no core to show while this one builds.
      const before = cores.get(id);
      const blocking = !before || Date.now() - before.at >= USABLE;
      let input = await loadInputs(id);
      // Some inputs may have been served stale (e.g. a disk cache from hours ago) while fresh copies download.
      settled = followUp ? refreshesSettled() : null;
      // The caller is waiting anyway: give the fresh copies a moment rather than open on old injury tags.
      if (settled && blocking && await settlesWithin(settled, STALE_INPUT_WAIT)) {
        input = await loadInputs(id);
        settled = refreshesSettled();
      }
      const hit = cores.get(id);
      // Nothing changed upstream: keep the existing core (and every view already computed from it).
      if (hit && hit.fingerprint === input.fingerprint) {
        hit.at = Date.now();
        return hit.core;
      }
      const core = await computeCore(id, input);
      cores.set(id, { core, at: Date.now(), fingerprint: input.fingerprint });
      if (cores.size > 20) {
        const evicted = cores.keys().next().value!;
        cores.delete(evicted);
        histories.delete(evicted);
        pregameMemo.delete(evicted);
      }
      for (const l of listeners) { try { l(core); } catch { /* warming is best-effort */ } }
      return core;
    })().finally(() => rebuilding.delete(id));
    rebuilding.set(id, p);
    // Any still on their way: rebuild once more when they land, rather than when the freshness window runs out.
    void p.then(async () => {
      if (!settled) return;
      await settled;
      await rebuild(id, false);
    }, () => undefined).catch(error => console.warn(`[core] follow-up refresh failed for ${id}:`, (error as Error).message));
  }
  return p;
}

/** Re-check inputs now, bypassing the freshness window (scripts and benchmarks). */
export function refreshCore(id: string): Promise<LeagueCore> {
  return rebuild(id);
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
