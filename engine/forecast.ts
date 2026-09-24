/**
 * Turns the trained model into per-player, per-week forecasts:
 *   expected = P(plays) × E[points | plays], with a calibrated outcome distribution.
 */
import { FEATURE_NAMES, gameContext, type FeatureState } from './features.ts';
import { mixtureQuantile, type Outcome } from './distribution.ts';
import type { ProjectionModel } from './model.ts';
import { completeStats, hasForecast, scoreStatsExact } from './scoring.ts';
import type { NflGame, PlayerInfo, Stats } from './types.ts';

export interface WeekForecast {
  id: string;
  week: number;
  /** E[points | plays] from the model. */
  mean: number;
  /** P(plays) from injury designation and roster status. */
  play: number;
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
  now: number;
}

const FEATURE_INDEX: Record<string, number> = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, i]));

const SIDELINED = new Set(['IR', 'PUP', 'NFI', 'Out', 'Sus', 'Suspended', 'DNR', 'NA', 'COV', 'Inactive']);

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

/** Players with no provider projection mid-week are usually inactive or buried on the depth chart. */
export const NO_PROJECTION_PLAY_FACTOR = 0.35;

export function forecastPlayer(env: ForecastEnv, id: string, week: number): WeekForecast {
  const p = env.players[id];
  const empty = (extra: Partial<WeekForecast> = {}): WeekForecast => ({
    id, week, mean: 0, play: 0, expected: 0, provider: null, floor: 0, median: 0, ceiling: 0,
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
  const x = env.state.features(id, env.season, week, stats, ctx, team);
  const mean = Math.max(0, env.model.predict(x));
  const provider = stats ? scoreStatsExact(completeStats(stats, p.pos), env.scoring) : null;

  const baseNone = env.model.playProbability(null, true);
  let play: number;
  if (!p.team) play = 0;
  else if (week === env.currentWeek) play = env.model.playProbability(p.injuryStatus, true);
  else play = SIDELINED.has(p.injuryStatus ?? '') || p.injuryStatus ? futurePlayProbability(baseNone, p.injuryStatus, week - env.currentWeek) : baseNone;
  if (!stats) play *= NO_PROJECTION_PLAY_FACTOR;

  let residuals = env.model.quantiles(p.pos, mean);
  let outcomeMean = mean;
  let live: WeekForecast['live'] = null;
  if (week === env.currentWeek && env.gameStatus) {
    const status = env.gameStatus(team, week) ?? ((game.kickoff ?? Infinity) <= env.now ? 'in_game' : 'pre_game');
    const line = env.liveStats?.get(id);
    const points = line ? scoreStatsExact(line, env.scoring) : 0;
    if (status === 'complete') {
      live = { status, points };
      play = 1;
      outcomeMean = points;
      residuals = new Array(21).fill(0);
    } else if (status === 'in_game') {
      live = { status, points };
      // Without a game clock, assume roughly half the game remains.
      const remaining = 0.5;
      const playing = line ? 1 : play;
      play = 1;
      outcomeMean = points + mean * remaining * playing;
      residuals = residuals.map(r => r * Math.sqrt(remaining) * playing);
    } else live = { status: 'pre_game', points: 0 };
  }

  const outcome: Outcome = { mean: outcomeMean, play, residuals };
  return {
    id, week, mean: outcomeMean, play, expected: play * outcomeMean, provider,
    floor: Math.max(-5, mixtureQuantile(outcome, 0.1)), median: mixtureQuantile(outcome, 0.5), ceiling: mixtureQuantile(outcome, 0.9),
    opponent: ctx.opponent, home: ctx.home, kickoff: game.kickoff, bye: false, residuals, live,
  };
}

export const outcomeOf = (f: WeekForecast): Outcome => ({ mean: f.mean, play: f.play, residuals: f.residuals });

/** Model inputs for one player-week, labelled — used to explain a forecast. */
export function explainInputs(env: ForecastEnv, id: string, week: number): Record<string, number | null> {
  const p = env.players[id];
  if (!p) return {};
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
