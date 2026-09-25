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
 * Provider projections omit a few derived components that actual stat lines carry.
 * Fill them in only when absent so a source that already supplies them is never double-counted.
 */
export function completeStats(stats: Stats, pos: Pos): Stats {
  let out = stats;
  if (pos === 'TE' && stats.rec && stats.bonus_rec_te === undefined) out = { ...out, bonus_rec_te: stats.rec };
  if (pos === 'K' && stats.fgmiss === undefined && stats.fga !== undefined && stats.fgm !== undefined) {
    out = { ...out, fgmiss: Math.max(0, stats.fga - stats.fgm) };
  }
  if (pos === 'K' && stats.xpmiss === undefined && stats.xpa !== undefined && stats.xpm !== undefined) {
    out = { ...out, xpmiss: Math.max(0, stats.xpa - stats.xpm) };
  }
  return out;
}

export type ScoreCategory = 'passing' | 'rushing' | 'receiving' | 'tackles' | 'big plays' | 'kicking' | 'other';

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
export const categoryOf = (key: string): ScoreCategory => CATEGORY[key] ?? 'other';

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
