import { deriveDefense, deriveKicking } from './derived.ts';
import type { Pos, Stats } from './types.ts';

export type ScoringSettings = Record<string, number>;

export const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

/** Only nonzero, finite multipliers matter; compiling once keeps hot loops tight. */
export function compileScoring(settings: ScoringSettings): [string, number][] {
  return Object.entries(settings).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v !== 0);
}

/**
 * League points for a raw stat line: sum(stat × multiplier). This reproduces Sleeper's
 * `players_points` exactly for this league (verified against official matchups).
 */
export function scoreStats(stats: Stats, scoring: readonly [string, number][]): number {
  return round(scoreStatsExact(stats, scoring));
}

const lookups = new WeakMap<readonly [string, number][], Map<string, number>>();

/** Same as scoreStats but unrounded, for expected values built from fractional projections. */
export function scoreStatsExact(stats: Stats, scoring: readonly [string, number][]): number {
  let total = 0;
  if (scoring.length <= 12) {
    for (const [key, multiplier] of scoring) {
      const value = stats[key];
      if (value) total += value * multiplier;
    }
    return total;
  }
  // Large rule sets: walk the (smaller) stat line and look multipliers up.
  let lookup = lookups.get(scoring);
  if (!lookup) { lookup = new Map(scoring); lookups.set(scoring, lookup); }
  for (const key in stats) {
    const multiplier = lookup.get(key);
    if (multiplier !== undefined) total += stats[key] * multiplier;
  }
  return total;
}

/**
 * Prepare a raw stat line for scoring. Provider projections omit a few components actual
 * lines carry (TE reception bonus, missed kicks), and kickers/defenses get the derived ladder
 * keys ESPN scoring needs (see derived.ts). Components a source already supplies are never
 * double-counted. `projection` switches defenses from exact buckets to bucket probabilities.
 */
export function completeStats(stats: Stats, pos: Pos, projection = false): Stats {
  if (pos === 'K') return deriveKicking(stats, projection);
  if (pos === 'DEF') return deriveDefense(stats, projection);
  let out = stats;
  if (pos === 'TE' && stats.rec && stats.bonus_rec_te === undefined) out = { ...out, bonus_rec_te: stats.rec };
  // Individual return touchdowns, under the key ESPN scoring translates onto.
  if (stats.st_td && stats.x_ret_td === undefined) out = { ...out, x_ret_td: stats.st_td };
  return out;
}

export type ScoreCategory = 'passing' | 'rushing' | 'receiving' | 'tackles' | 'big plays' | 'kicking' | 'team defense' | 'other';

const CATEGORY: Record<string, ScoreCategory> = {
  pass_yd: 'passing', pass_td: 'passing', pass_int: 'passing', pass_2pt: 'passing', pass_int_td: 'passing',
  rush_yd: 'rushing', rush_td: 'rushing', rush_2pt: 'rushing',
  rec: 'receiving', rec_yd: 'receiving', rec_td: 'receiving', rec_2pt: 'receiving', bonus_rec_te: 'receiving',
  idp_tkl_solo: 'tackles', idp_tkl_ast: 'tackles',
  idp_sack: 'big plays', idp_int: 'big plays', idp_pass_def: 'big plays', idp_ff: 'big plays', idp_fum_rec: 'big plays',
  idp_tkl_loss: 'big plays', idp_qb_hit: 'big plays', idp_def_td: 'big plays', idp_safe: 'big plays', idp_blk_kick: 'big plays',
  fgm_0_19: 'kicking', fgm_20_29: 'kicking', fgm_30_39: 'kicking', fgm_40_49: 'kicking', fgm_50p: 'kicking',
  fgmiss: 'kicking', xpm: 'kicking', xpmiss: 'kicking',
};
export const categoryOf = (key: string): ScoreCategory =>
  CATEGORY[key] ?? (key.startsWith('x_fg') || key === 'x_xpmiss' ? 'kicking' : key.startsWith('x_pa_') || key.startsWith('x_ya_') || key.startsWith('x_dst_') ? 'team defense' : 'other');

export const STAT_LABELS: Record<string, string> = {
  pass_yd: 'Pass yds', pass_td: 'Pass TD', pass_int: 'INT thrown', pass_2pt: 'Pass 2PT',
  rush_yd: 'Rush yds', rush_td: 'Rush TD', rush_2pt: 'Rush 2PT',
  rec: 'Receptions', rec_yd: 'Rec yds', rec_td: 'Rec TD', rec_2pt: 'Rec 2PT', bonus_rec_te: 'TE rec bonus',
  fum_lost: 'Fumble lost', fum_rec_td: 'Fumble rec TD',
  idp_tkl_solo: 'Solo tackles', idp_tkl_ast: 'Assisted tackles', idp_sack: 'Sacks', idp_qb_hit: 'QB hits',
  idp_tkl_loss: 'TFL', idp_int: 'Interceptions', idp_pass_def: 'Pass defended', idp_ff: 'Forced fumbles',
  idp_fum_rec: 'Fumble recoveries', idp_def_td: 'Defensive TD', idp_safe: 'Safety', idp_blk_kick: 'Blocked kick',
  fgm_0_19: 'FG 0–19', fgm_20_29: 'FG 20–29', fgm_30_39: 'FG 30–39', fgm_40_49: 'FG 40–49', fgm_50p: 'FG 50+',
  fgmiss: 'FG missed', xpm: 'XP made', xpmiss: 'XP missed', st_td: 'Special teams TD', def_st_td: 'Return TD',
  // Derived keys (engine/derived.ts) that ESPN scoring translates onto.
  x_fgm_0_39: 'FG 0–39', x_fgm_40_49: 'FG 40–49', x_fgm_50p: 'FG 50+', x_fgm_50_59: 'FG 50–59', x_fgm_60p: 'FG 60+',
  x_fgmiss: 'FG missed', x_fgmiss_0_39: 'FG missed 0–39', x_fgmiss_40_49: 'FG missed 40–49', x_fgmiss_50p: 'FG missed 50+',
  x_fgmiss_50_59: 'FG missed 50–59', x_fgmiss_60p: 'FG missed 60+', x_xpmiss: 'XP missed', x_ret_td: 'Return TD',
  x_pa_0: 'Shutout', x_pa_1_6: 'Pts allowed 1–6', x_pa_7_13: 'Pts allowed 7–13', x_pa_14_17: 'Pts allowed 14–17', x_pa_18_21: 'Pts allowed 18–21',
  x_pa_22_27: 'Pts allowed 22–27', x_pa_28_34: 'Pts allowed 28–34', x_pa_35_45: 'Pts allowed 35–45', x_pa_46p: 'Pts allowed 46+',
  x_ya_0_99: 'Yds allowed <100', x_ya_100_199: 'Yds allowed 100–199', x_ya_200_299: 'Yds allowed 200–299', x_ya_300_349: 'Yds allowed 300–349',
  x_ya_350_399: 'Yds allowed 350–399', x_ya_400_449: 'Yds allowed 400–449', x_ya_450_499: 'Yds allowed 450–499', x_ya_500_549: 'Yds allowed 500–549', x_ya_550p: 'Yds allowed 550+',
  x_dst_td: 'Defensive/return TD', x_dst_int: 'Interceptions', x_dst_fum_rec: 'Fumble recoveries', x_dst_sack: 'Sacks', x_dst_safe: 'Safeties',
  x_dst_blk: 'Blocked kicks', x_dst_2pt: '2-pt return', x_dst_pa: 'Points allowed', x_dst_ya: 'Yards allowed',
  pts_allow_0: 'Shutout', pts_allow_1_6: 'Pts allowed 1–6', pts_allow_7_13: 'Pts allowed 7–13', pts_allow_14_20: 'Pts allowed 14–20',
  pts_allow_21_27: 'Pts allowed 21–27', pts_allow_28_34: 'Pts allowed 28–34', pts_allow_35p: 'Pts allowed 35+',
  sack: 'Sacks', int: 'Interceptions', fum_rec: 'Fumble recoveries', safe: 'Safeties', def_td: 'Defensive TD', blk_kick: 'Blocked kicks',
};

export interface BreakdownLine { key: string; label: string; stat: number; multiplier: number; points: number; category: ScoreCategory }

export function scoreBreakdown(stats: Stats, scoring: readonly [string, number][]): BreakdownLine[] {
  const lines: BreakdownLine[] = [];
  for (const [key, multiplier] of scoring) {
    const stat = stats[key];
    if (!stat) continue;
    lines.push({ key, label: STAT_LABELS[key] ?? key, stat: round(stat, 2), multiplier, points: round(stat * multiplier), category: categoryOf(key) });
  }
  return lines.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
}

/** Points by category, used for "where do the points come from" explanations. */
export function categoryPoints(stats: Stats, scoring: readonly [string, number][]): Partial<Record<ScoreCategory, number>> {
  const out: Partial<Record<ScoreCategory, number>> = {};
  for (const [key, multiplier] of scoring) {
    const stat = stats[key];
    if (!stat) continue;
    const category = categoryOf(key);
    out[category] = (out[category] ?? 0) + stat * multiplier;
  }
  return out;
}

/** A played game: any snap or recorded game appearance. */
export function didPlay(stats: Stats | undefined): boolean {
  if (!stats) return false;
  return (stats.gp ?? 0) > 0 || (stats.off_snp ?? 0) > 0 || (stats.def_snp ?? 0) > 0 || (stats.st_snp ?? 0) > 0;
}

/** A projection row with a genuine forecast rather than an ADP-only stub. */
export function hasForecast(stats: Stats | undefined): boolean {
  if (!stats || !((stats.gp ?? 0) > 0)) return false;
  for (const key in stats) {
    if (key === 'gp' || key.startsWith('adp') || key.startsWith('pos_adp') || key.startsWith('pts_') || key.startsWith('pos_rank')) continue;
    if (stats[key]) return true;
  }
  return false;
}

/** Drop provider-precomputed totals, ADP and rank fields: they are never this league's score. */
export function cleanProviderStats(raw: unknown): Stats {
  const out: Stats = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) continue;
    if (key.startsWith('adp') || key.startsWith('pos_adp') || key.startsWith('pos_rank') || key.startsWith('rank_')) continue;
    if (key.startsWith('pts_') && !key.startsWith('pts_allow')) continue;
    out[key] = value;
  }
  return out;
}
