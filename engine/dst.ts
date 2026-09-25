/**
 * Team defense (D/ST) forecasts. D/ST scoring is a few rare events plus points/yards-allowed
 * ladders, so the tree model (trained on individual players) doesn't apply. Instead the
 * provider projection is rescored for the league with bucket probabilities (not the single
 * bucket its average falls in) and given the residual spread of D/ST results on record for
 * floors, ceilings and simulations.
 *
 * A least-squares recalibration was tested out of sample (fit 2023 → test 2024, fit 2024 →
 * test 2025, both ESPN leagues' scoring) and did not beat the rescored projection
 * consistently (MAE 4.73 vs 4.83, 4.76 vs 4.75, 4.13 vs 4.23, 4.28 vs 4.25), whose bias is
 * ≈ 0, so the projection is used as the mean as is.
 */
import { completeStats, hasForecast, scoreStatsExact } from './scoring.ts';
import type { Stats } from './types.ts';

export interface DefenseModel {
  /** Residual quantiles (21 points, 0%…100%), centred so simulations keep the forecast mean. */
  residuals: number[];
  /** Mean league points for a defense with no projection. */
  fallback: number;
  n: number;
}

const QS = Array.from({ length: 21 }, (_, i) => i / 20);

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function fitDefenseModel(rows: readonly { proj: number; actual: number }[]): DefenseModel | null {
  if (rows.length < 60) return null;
  const n = rows.length;
  const res = rows.map(r => r.actual - r.proj).sort((x, y) => x - y);
  const q = QS.map(p => quantile(res, p));
  let m = 0;
  for (let i = 0; i < q.length - 1; i++) m += (q[i] + q[i + 1]) / 2;
  m /= q.length - 1;
  return { residuals: q.map(v => Math.round((v - m) * 1000) / 1000), fallback: rows.reduce((s, r) => s + r.actual, 0) / n, n };
}

/** Training rows from weekly stat and projection lines (any number of weeks). */
export function defenseRows(
  weeks: readonly { stats: Iterable<{ id: string; stats: Stats }>; projections: ReadonlyMap<string, Stats> }[],
  isDefense: (id: string) => boolean,
  scoring: readonly [string, number][],
): { proj: number; actual: number }[] {
  const rows: { proj: number; actual: number }[] = [];
  for (const w of weeks) {
    for (const line of w.stats) {
      if (!isDefense(line.id)) continue;
      const proj = w.projections.get(line.id);
      if (!proj || !hasForecast(proj)) continue;
      rows.push({
        proj: scoreStatsExact(completeStats(proj, 'DEF', true), scoring),
        actual: scoreStatsExact(completeStats(line.stats, 'DEF'), scoring),
      });
    }
  }
  return rows;
}
