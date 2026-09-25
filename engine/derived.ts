/**
 * Derived stat keys for kickers and team defenses.
 *
 * ESPN scores kicking and D/ST on ladders that Sleeper's raw lines don't carry directly
 * (field goals 0–39 as one bucket; points allowed 14–17 / 18–21 / 22–27 …), so the
 * ladders are computed from the raw numbers under stable `x_` keys that ESPN scoring
 * translates onto. Sleeper-scored leagues ignore the `x_` keys.
 *
 * A projection only has an *average* points/yards allowed. Flagging the single bucket
 * that average falls in (what the provider does) is wrong for a nonlinear ladder, so
 * projections get the probability of each bucket instead, from the spread of real
 * outcomes around the projection (measured on 2023–25 D/ST lines).
 */
import { normalCdf } from './distribution.ts';
import type { Stats } from './types.ts';

/** Residual spread of actual vs projected points / yards allowed, 2023–25. */
export const DST_POINTS_SD = 9.6;
export const DST_YARDS_SD = 68;

type Ladder = [key: string, lo: number, hi: number][];

const ESPN_PA: Ladder = [
  ['x_pa_0', 0, 0], ['x_pa_1_6', 1, 6], ['x_pa_7_13', 7, 13], ['x_pa_14_17', 14, 17], ['x_pa_18_21', 18, 21],
  ['x_pa_22_27', 22, 27], ['x_pa_28_34', 28, 34], ['x_pa_35_45', 35, 45], ['x_pa_46p', 46, Infinity],
];
const ESPN_YA: Ladder = [
  ['x_ya_0_99', 0, 99], ['x_ya_100_199', 100, 199], ['x_ya_200_299', 200, 299], ['x_ya_300_349', 300, 349], ['x_ya_350_399', 350, 399],
  ['x_ya_400_449', 400, 449], ['x_ya_450_499', 450, 499], ['x_ya_500_549', 500, 549], ['x_ya_550p', 550, Infinity],
];
const SLEEPER_PA: Ladder = [
  ['pts_allow_0', 0, 0], ['pts_allow_1_6', 1, 6], ['pts_allow_7_13', 7, 13], ['pts_allow_14_20', 14, 20],
  ['pts_allow_21_27', 21, 27], ['pts_allow_28_34', 28, 34], ['pts_allow_35p', 35, Infinity],
];
const SLEEPER_YA: Ladder = [
  ['yds_allow_0_100', 0, 100], ['yds_allow_100_199', 101, 199], ['yds_allow_200_299', 200, 299], ['yds_allow_300_349', 300, 349],
  ['yds_allow_350_399', 350, 399], ['yds_allow_400_449', 400, 449], ['yds_allow_450_499', 450, 499], ['yds_allow_500_549', 500, 549], ['yds_allow_550p', 550, Infinity],
];

function flag(out: Stats, ladder: Ladder, value: number) {
  for (const [key] of ladder) delete out[key];
  for (const [key, lo, hi] of ladder) if (value >= lo && value <= hi) { out[key] = 1; return; }
}

/** Probability of each bucket for integer outcomes ~ Normal(mean, sd), truncated at zero. */
function spread(out: Stats, ladder: Ladder, mean: number, sd: number) {
  const below = (x: number) => normalCdf((x - mean) / sd);
  const zero = below(-0.5); // mass below zero folds into the lowest bucket
  let total = 0;
  const probs = ladder.map(([, lo, hi]) => {
    const p = (hi === Infinity ? 1 : below(hi + 0.5)) - (lo === 0 ? zero : below(lo - 0.5));
    return Math.max(0, p);
  });
  probs[0] += zero;
  for (const p of probs) total += p;
  ladder.forEach(([key], i) => {
    delete out[key];
    if (probs[i] > 1e-6) out[key] = probs[i] / total;
  });
}

/** Share of 50+ yard makes that come from 60+, for projections that only carry a 50+ total (2025). */
const SIXTY_SHARE = 0.08;

export function deriveKicking(stats: Stats, projection = false): Stats {
  const out = { ...stats };
  const n = (k: string) => stats[k] ?? 0;
  const short = n('fgm_0_19') + n('fgm_20_29') + n('fgm_30_39');
  const long = stats.fgm_50p ?? n('fgm_50_59') + n('fgm_60p');
  // If the line only reports total makes, assume the unlisted ones were short.
  out.x_fgm_0_39 = short + Math.max(0, n('fgm') - short - n('fgm_40_49') - long);
  out.x_fgm_40_49 = n('fgm_40_49');
  out.x_fgm_50p = long;
  if (projection && stats.fgm_50_59 === undefined && stats.fgm_60p === undefined) {
    out.x_fgm_60p = long * SIXTY_SHARE;
    out.x_fgm_50_59 = long - out.x_fgm_60p;
  } else {
    out.x_fgm_60p = n('fgm_60p');
    out.x_fgm_50_59 = stats.fgm_50_59 ?? Math.max(0, long - n('fgm_60p'));
  }
  const missLong = stats.fgmiss_50p ?? n('fgmiss_50_59') + n('fgmiss_60p');
  out.x_fgmiss_0_39 = n('fgmiss_0_19') + n('fgmiss_20_29') + n('fgmiss_30_39');
  out.x_fgmiss_40_49 = n('fgmiss_40_49');
  out.x_fgmiss_50p = missLong;
  out.x_fgmiss_60p = n('fgmiss_60p');
  out.x_fgmiss_50_59 = stats.fgmiss_50_59 ?? Math.max(0, missLong - n('fgmiss_60p'));
  if (stats.fgmiss === undefined && stats.fga !== undefined) out.fgmiss = Math.max(0, n('fga') - n('fgm'));
  if (stats.xpmiss === undefined && stats.xpa !== undefined) out.xpmiss = Math.max(0, n('xpa') - n('xpm'));
  out.x_fgmiss = out.fgmiss ?? 0;
  out.x_xpmiss = out.xpmiss ?? 0;
  for (const k of Object.keys(out)) if (k.startsWith('x_') && !out[k]) delete out[k];
  return out;
}

export function deriveDefense(stats: Stats, projection: boolean): Stats {
  const out = { ...stats };
  const n = (k: string) => stats[k] ?? 0;
  // Stat feeds drop zero values, so a shutout arrives without `pts_allow`; a defense that played allowed 0.
  const played = stats.yds_allow !== undefined || !!stats.gp;
  const pa = stats.pts_allow ?? (played && !projection ? 0 : undefined), ya = stats.yds_allow;
  if (pa !== undefined) {
    if (projection) { spread(out, ESPN_PA, pa, DST_POINTS_SD); spread(out, SLEEPER_PA, pa, DST_POINTS_SD); }
    else { flag(out, ESPN_PA, pa); flag(out, SLEEPER_PA, pa); }
  }
  if (ya !== undefined) {
    if (projection) { spread(out, ESPN_YA, ya, DST_YARDS_SD); spread(out, SLEEPER_YA, ya, DST_YARDS_SD); }
    else { flag(out, ESPN_YA, ya); flag(out, SLEEPER_YA, ya); }
  }
  // Sleeper's plain `td` on a defense row is every team touchdown; only defensive and return TDs count.
  // Projections carry return TDs under other names.
  const tds = n('def_td') + (stats.def_st_td ?? stats.st_td ?? n('def_pr_td') + n('def_kr_td'));
  if (tds) out.x_dst_td = tds;
  if (stats.int) out.x_dst_int = stats.int;
  // ESPN counts special-teams fumble recoveries too.
  const recoveries = n('fum_rec') + n('def_st_fum_rec');
  if (recoveries) out.x_dst_fum_rec = recoveries;
  if (pa !== undefined) out.x_dst_pa = pa;
  if (ya !== undefined) out.x_dst_ya = ya;
  if (stats.sack) out.x_dst_sack = stats.sack;
  if (stats.safe) out.x_dst_safe = stats.safe;
  if (stats.blk_kick) out.x_dst_blk = stats.blk_kick;
  if (stats.def_2pt) out.x_dst_2pt = stats.def_2pt;
  return out;
}
