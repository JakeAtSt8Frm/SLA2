import { normalCdf } from './distribution.ts';

/** One completed fantasy game: who the team played and the scoring margin, or nulls for a bye. */
export interface PowerGame {
  opponentId: number | null;
  margin: number | null;
}

export interface PowerInput {
  rosterId: number;
  /** Actual points by completed week (in order). */
  weekly: number[];
  allPlayWins: number;
  allPlayGames: number;
  /** Mean expected points of the best legal lineup over upcoming weeks. */
  outlook: number;
  /** The completed schedule in order, when available (bye weeks contribute nulls). */
  games?: readonly PowerGame[];
}

export interface PowerRow {
  rosterId: number;
  score: number;
  rank: number;
  components: { season: number; strength: number; allPlay: number; recent: number; outlook: number };
  weights: { season: number; strength: number; allPlay: number; recent: number; outlook: number };
}

/** Component scores are league z-scores mapped through the normal CDF to 0–100. */
function scaled(values: (number | null)[]): number[] {
  const present = values.filter((v): v is number => v !== null);
  const n = present.length;
  const mean = n ? present.reduce((a, b) => a + b, 0) / n : 0;
  const sd = Math.sqrt(n ? present.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0) || 1;
  return values.map(v => (v === null ? 50 : 100 * normalCdf((v - mean) / sd)));
}

/**
 * One-step SRS: average scoring margin plus the average margin of the teams actually faced.
 * Facing a strong opponent (who beats his own opponents) therefore raises the rating, while
 * padding the record against weak teams does not. Iterating SRS further over a fantasy
 * round-robin is numerically unstable — the schedule is a near-permutation and the ratings
 * cycle — so exactly one refinement step is right.
 */
function strengthRatings(rows: PowerInput[]): (number | null)[] | null {
  const perRow = rows.map(r => (r.games ?? []).filter((g): g is { opponentId: number; margin: number } => g.opponentId !== null && g.margin !== null));
  if (!perRow.some(gs => gs.length)) return null;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const marginAvg = new Map(rows.map((r, i) => [r.rosterId, mean(perRow[i].map(g => g.margin))]));
  return rows.map((_r, i) => {
    const games = perRow[i];
    if (!games.length) return null;
    const oppAvg = mean(games.map(g => marginAvg.get(g.opponentId) ?? 0));
    return mean(games.map(g => g.margin)) + oppAvg;
  });
}

/**
 * Composite: what a team has done (points, all-play, recent form, opponent-adjusted strength)
 * and what its roster is projected to do. Early in the season the projection carries more of
 * the weight, and schedule strength only counts once there are enough games to read it.
 */
export function powerRankings(rows: PowerInput[], completedWeeks: number): PowerRow[] {
  const trust = Math.min(1, completedWeeks / 7);
  const strength = strengthRatings(rows);
  const strengthTrust = strength === null ? 0 : Math.min(1, Math.max(0, (completedWeeks - 2) / 5));
  const weights = { season: 0.15 * trust, strength: 0.25 * strengthTrust, allPlay: 0.10 * trust, recent: 0.15 * trust, outlook: 0.35 + 0.65 * (1 - trust) };
  const total = weights.season + weights.strength + weights.allPlay + weights.recent + weights.outlook;
  for (const k of Object.keys(weights) as (keyof typeof weights)[]) weights[k] /= total;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const season = scaled(rows.map(r => avg(r.weekly)));
  const strengthScore = scaled(strength ?? (rows.map(() => null) as (number | null)[]));
  const allPlay = scaled(rows.map(r => (r.allPlayGames ? r.allPlayWins / r.allPlayGames : 0.5)));
  const recent = scaled(rows.map(r => avg(r.weekly.slice(-3))));
  const outlook = scaled(rows.map(r => r.outlook));
  const out = rows.map((r, i) => ({
    rosterId: r.rosterId,
    score: 0,
    rank: 0,
    components: { season: season[i], strength: strengthScore[i], allPlay: allPlay[i], recent: recent[i], outlook: outlook[i] },
    weights: { ...weights },
  }));
  for (const r of out) r.score = r.components.season * weights.season + r.components.strength * weights.strength + r.components.allPlay * weights.allPlay + r.components.recent * weights.recent + r.components.outlook * weights.outlook;
  out.sort((a, b) => b.score - a.score).forEach((r, i) => { r.rank = i + 1; });
  return out;
}
