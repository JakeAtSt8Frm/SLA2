/**
 * Turns the trained model into per-player, per-week forecasts:
 *   expected = P(plays) × E[points | plays], with a calibrated outcome distribution.
 */
import { FEATURE_NAMES, gameContext, type FeatureState } from './features.ts';
import { mixtureQuantile, type Outcome } from './distribution.ts';
import type { DefenseModel } from './dst.ts';
import type { ProjectionModel } from './model.ts';
import { completeStats, hasForecast, scoreStatsExact } from './scoring.ts';
import type { NflGame, PlayerInfo, Stats } from './types.ts';

export interface WeekForecast {
  id: string;
  week: number;
  /** E[points | plays] from the model. */
  mean: number;
  /** P(plays) from injury designation and roster status (lineup planning: the bench covers later injuries). */
  play: number;
  /** P(plays) including the chance of getting hurt or benched before that week: what season-long value uses. */
  rosPlay: number;
  /** play × mean — what lineup decisions optimise. */
  expected: number;
  /** Provider (Sleeper/Rotowire) projection rescored with league settings. */
  provider: number | null;
  floor: number;
  median: number;
  ceiling: number;
  opponent: string | null;
  home: boolean | null;
  kickoff: number | null;
  bye: boolean;
  residuals: number[];
  /** Live state for the current week. */
  live: { status: 'pre_game' | 'in_game' | 'complete'; points: number } | null;
}

export interface ForecastEnv {
  model: ProjectionModel;
  state: FeatureState;
  season: number;
  currentWeek: number;
  players: Record<string, PlayerInfo>;
  scoring: readonly [string, number][];
  gameFor: (team: string, week: number) => NflGame | undefined;
  projections: (week: number) => ReadonlyMap<string, { team: string | null; stats: Stats }> | undefined;
  /** Live stat lines and game status for the current week. */
  liveStats?: ReadonlyMap<string, Stats>;
  gameStatus?: (team: string, week: number) => 'pre_game' | 'in_game' | 'complete' | undefined;
  /** Team defenses (leagues with a D/ST slot). */
  defense?: DefenseModel | null;
  now: number;
}

const FEATURE_INDEX: Record<string, number> = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, i]));

/**
 * Chance of playing k weeks from now. Sleeper gives no return dates, so these are stated
 * assumptions: IR/PUP ≈ out a month, Out ≈ likely back within two weeks, Questionable recovers.
 */
export function futurePlayProbability(base: number, status: string | null, weeksAhead: number): number {
  if (weeksAhead <= 0) return base;
  switch (status) {
    case 'IR': case 'PUP': case 'NFI': return weeksAhead <= 3 ? 0 : base * 0.55;
    case 'Out': return weeksAhead === 1 ? base * 0.45 : base * 0.88;
    case 'Sus': case 'Suspended': return weeksAhead <= 1 ? 0 : base * 0.7;
    case 'Doubtful': return weeksAhead === 1 ? base * 0.8 : base * 0.97;
    case 'Questionable': return base * 0.97;
    case 'DNR': case 'NA': case 'COV': case 'Inactive': return weeksAhead <= 1 ? 0 : base * 0.5;
    default: return base;
  }
}

/** Position groups of the weeks-ahead availability curve. */
export const aheadGroup = (pos: string) => (pos === 'DL' || pos === 'LB' || pos === 'DB' ? 'IDP' : pos);

const SNAP_L4 = FEATURE_NAMES.indexOf('snap_l4');
const N_L16 = FEATURE_NAMES.indexOf('n_l16');
/**
 * A starter (≥50% of snaps over his last four games; kickers with a recent game) listed
 * Questionable plays far more often than a reserve with the same tag.
 */
export function roleOf(pos: string, x: Float64Array): 'starter' | 'reserve' {
  if (pos === 'K') return x[N_L16] > 0 ? 'starter' : 'reserve';
  return x[SNAP_L4] >= 0.5 ? 'starter' : 'reserve';
}

/** Players with no provider projection mid-week are usually inactive or buried on the depth chart. */
export const NO_PROJECTION_PLAY_FACTOR = 0.35;

export function forecastPlayer(env: ForecastEnv, id: string, week: number): WeekForecast {
  return withLiveState(env, pregameForecast(env, id, week));
}

function finish(f: Omit<WeekForecast, 'expected' | 'floor' | 'median' | 'ceiling'>): WeekForecast {
  const outcome: Outcome = { mean: f.mean, play: f.play, residuals: f.residuals };
  return {
    ...f, expected: f.play * f.mean,
    floor: Math.max(-5, mixtureQuantile(outcome, 0.1)), median: mixtureQuantile(outcome, 0.5), ceiling: mixtureQuantile(outcome, 0.9),
  };
}

/**
 * The forecast as it stands before kickoff. It depends only on the player's history, the week's
 * projection and game, and his status, so the server can reuse it across rebuilds while live
 * scores tick (see withLiveState).
 */
export function pregameForecast(env: ForecastEnv, id: string, week: number): WeekForecast {
  const p = env.players[id];
  const empty = (extra: Partial<WeekForecast> = {}): WeekForecast => ({
    id, week, mean: 0, play: 0, rosPlay: 0, expected: 0, provider: null, floor: 0, median: 0, ceiling: 0,
    opponent: null, home: null, kickoff: null, bye: false, residuals: new Array(21).fill(0), live: null, ...extra,
  });
  if (!p) return empty();
  const projection = env.projections(week)?.get(id);
  const team = projection?.team ?? p.team;
  if (!team) return empty();
  const game = env.gameFor(team, week);
  if (!game) return empty({ bye: true });
  const ctx = gameContext(game, team);
  const stats = projection && hasForecast(projection.stats) ? projection.stats : undefined;
  const provider = stats ? scoreStatsExact(completeStats(stats, p.pos, true), env.scoring) : null;
  const defense = p.pos === 'DEF';
  // A team defense always takes the field; its forecast is the rescored projection (engine/dst.ts).
  const x = defense ? null : env.state.features(id, env.season, week, stats, ctx, team);
  const mean = x ? Math.max(0, env.model.predict(x)) : provider ?? env.defense?.fallback ?? 0;

  const ahead = week - env.currentWeek;
  const baseNone = env.model.playProbability(null, true);
  let play: number, rosPlay: number;
  if (defense) play = rosPlay = 1;
  else if (!p.team) play = rosPlay = 0;
  else if (ahead <= 0) play = rosPlay = env.model.playProbability(p.injuryStatus, true, x ? roleOf(p.pos, x) : undefined);
  else {
    play = p.injuryStatus ? futurePlayProbability(baseNone, p.injuryStatus, ahead) : baseNone;
    const healthy = env.model.healthyAhead(aheadGroup(p.pos), ahead);
    rosPlay = p.injuryStatus ? futurePlayProbability(healthy, p.injuryStatus, ahead) : healthy;
  }
  if (!stats && !defense) { play *= NO_PROJECTION_PLAY_FACTOR; rosPlay *= NO_PROJECTION_PLAY_FACTOR; }

  const residuals = defense ? env.defense?.residuals ?? new Array(21).fill(0) : env.model.quantiles(p.pos, mean);
  return finish({ id, week, mean, play, rosPlay, provider, opponent: ctx.opponent, home: ctx.home, kickoff: game.kickoff, bye: false, residuals, live: null });
}

/**
 * The current week's live overlay: a finished game is what happened; a game in progress is
 * points so far plus the forecast for the time that's left.
 */
export function withLiveState(env: ForecastEnv, f: WeekForecast): WeekForecast {
  if (f.week !== env.currentWeek || !env.gameStatus || f.bye) return f;
  const p = env.players[f.id];
  const team = p ? env.projections(f.week)?.get(f.id)?.team ?? p.team : null;
  const game = team ? env.gameFor(team, f.week) : undefined;
  if (!p || !team || !game) return f;
  const status = env.gameStatus(team, f.week) ?? ((game.kickoff ?? Infinity) <= env.now ? 'in_game' : 'pre_game');
  if (status === 'pre_game') return { ...f, live: { status, points: 0 } };
  const line = env.liveStats?.get(f.id);
  const points = line ? scoreStatsExact(completeStats(line, p.pos), env.scoring) : 0;
  if (status === 'complete') return finish({ ...f, play: 1, rosPlay: 1, mean: points, residuals: new Array(21).fill(0), live: { status, points } });
  // No game clock in the feed: estimate what's left from wall-clock time (a broadcast runs ≈185 min).
  const elapsed = game.kickoff ? (env.now - game.kickoff) / 60_000 : 90;
  const remaining = Math.min(1, Math.max(0.03, 1 - elapsed / 185));
  const playing = line ? 1 : f.play;
  return finish({
    ...f, play: 1, rosPlay: 1, mean: points + f.mean * remaining * playing,
    residuals: f.residuals.map(r => r * Math.sqrt(remaining) * playing), live: { status, points },
  });
}

export const outcomeOf = (f: WeekForecast): Outcome => ({ mean: f.mean, play: f.play, residuals: f.residuals });

/** Model inputs for one player-week, labelled — used to explain a forecast. */
export function explainInputs(env: ForecastEnv, id: string, week: number): Record<string, number | null> {
  const p = env.players[id];
  if (!p || p.pos === 'DEF') return {};
  const projection = env.projections(week)?.get(id);
  const team = projection?.team ?? p.team;
  const game = team ? env.gameFor(team, week) : undefined;
  if (!team || !game) return {};
  const stats = projection && hasForecast(projection.stats) ? projection.stats : undefined;
  const x = env.state.features(id, env.season, week, stats, gameContext(game, team), team);
  const pick = ['proj_pts', 'mean_cur', 'ewma', 'mean_l4', 'mean_prev', 'snap_l4', 'snap_trend', 'opps_l4', 'tkl_l4', 'big_rate', 'exp_big_pts', 'proj_resid', 'opp_ratio', 'opp_plays_ratio', 'implied', 'spread', 'weeks_since', 'age'];
  const out: Record<string, number | null> = {};
  for (const name of pick) {
    const i = FEATURE_INDEX[name];
    const v = x[i];
    out[name] = Number.isNaN(v) ? null : Math.round(v * 1000) / 1000;
  }
  return out;
}
