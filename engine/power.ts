import { normalCdf } from './distribution.ts';

export interface PowerInput {
  rosterId: number;
  /** Actual points by completed week (in order). */
  weekly: number[];
  allPlayWins: number;
  allPlayGames: number;
  /** Mean expected points of the best legal lineup over upcoming weeks. */
  outlook: number;
}

export interface PowerRow {
  rosterId: number;
  score: number;
  rank: number;
  components: { season: number; allPlay: number; recent: number; outlook: number };
  weights: { season: number; allPlay: number; recent: number; outlook: number };
}

/** Component scores are league z-scores mapped through the normal CDF to 0–100. */
function scaled(values: number[]): number[] {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return values.map(v => 100 * normalCdf((v - mean) / sd));
}

/**
 * Composite: what a team has done (points, all-play, recent form) and what its roster is
 * projected to do. Early in the season the projection carries more of the weight.
 */
export function powerRankings(rows: PowerInput[], completedWeeks: number): PowerRow[] {
  const trust = Math.min(1, completedWeeks / 7);
  const weights = { season: 0.3 * trust, allPlay: 0.15 * trust, recent: 0.15 * trust, outlook: 0.4 + 0.6 * (1 - trust) };
  const total = weights.season + weights.allPlay + weights.recent + weights.outlook;
  for (const k of Object.keys(weights) as (keyof typeof weights)[]) weights[k] /= total;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const season = scaled(rows.map(r => avg(r.weekly)));
  const allPlay = scaled(rows.map(r => (r.allPlayGames ? r.allPlayWins / r.allPlayGames : 0.5)));
  const recent = scaled(rows.map(r => avg(r.weekly.slice(-3))));
  const outlook = scaled(rows.map(r => r.outlook));
  const out = rows.map((r, i) => {
    const components = { season: season[i], allPlay: allPlay[i], recent: recent[i], outlook: outlook[i] };
    const score = components.season * weights.season + components.allPlay * weights.allPlay + components.recent * weights.recent + components.outlook * weights.outlook;
    return { rosterId: r.rosterId, score, rank: 0, components, weights };
  });
  out.sort((a, b) => b.score - a.score).forEach((r, i) => { r.rank = i + 1; });
  return out;
}
