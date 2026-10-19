/**
 * Applies live stat lines to one of this week's games (see live.ts): starters' points in league
 * scoring, live projected totals, and win odds from a normal approximation of what is left.
 */
import { normalCdf } from '../../../engine/distribution.ts';
import { completeStats, round, scoreStatsExact } from '../../../engine/scoring.ts';
import type { Pos, Stats } from '../../../engine/types.ts';
import type { Game } from './api.ts';

export type LiveStatus = 'pre_game' | 'in_game' | 'complete';
export interface LiveWeek { lines: Map<string, Stats>; status: Map<string, LiveStatus>; at: number }

/** A broadcast runs about 185 minutes; the feed has no game clock (same estimate as the server). */
const GAME_MINUTES = 185;
const r1 = (n: number) => round(n, 1);
const r2 = (n: number) => round(n, 2);

/** The same normal approximation as live win odds, including certain completed scores. */
function liveRange(a: { mean: number; variance: number }, b: { mean: number; variance: number }): NonNullable<Game['range']> {
  const sa = Math.sqrt(a.variance), sb = Math.sqrt(b.variance);
  let lo = Math.min(a.mean - 2.576 * sa, b.mean - 2.576 * sb);
  let hi = Math.max(a.mean + 2.576 * sa, b.mean + 2.576 * sb);
  if (hi - lo < 0.1) { lo -= 1; hi += 1; }
  const histogram = (mean: number, sd: number) => {
    const bins = 28, width = (hi - lo) / bins;
    if (sd <= 1e-6) {
      const counts = new Array<number>(bins).fill(0);
      counts[Math.min(bins - 1, Math.max(0, Math.floor((mean - lo) / width)))] = 1;
      return counts;
    }
    return Array.from({ length: bins }, (_, i) => {
      const lower = i === 0 ? 0 : normalCdf((lo + i * width - mean) / sd);
      const upper = i === bins - 1 ? 1 : normalCdf((lo + (i + 1) * width - mean) / sd);
      return upper - lower;
    });
  };
  return {
    a: [r1(a.mean - 1.282 * sa), r1(a.mean), r1(a.mean + 1.282 * sa)],
    b: [r1(b.mean - 1.282 * sb), r1(b.mean), r1(b.mean + 1.282 * sb)],
    histogram: { lo: r1(lo), hi: r1(hi), a: histogram(a.mean, sa), b: histogram(b.mean, sb) },
  };
}

export function applyLive<G extends Game>(g: G, live: LiveWeek, scoring: [string, number][], now: number): G {
  if (!g.b || g.final) return g;
  const side = (s: Game['a']) => {
    let points = 0, mean = 0, variance = 0;
    const lineup = s.lineup.map(p => {
      if (!p.id) return p;
      const line = live.lines.get(p.id);
      const kickoff = p.forecast?.kickoff ?? null;
      const reported = (p.team && live.status.get(p.team)) || p.forecast?.live?.status;
      const status: LiveStatus = reported === 'complete' || reported === 'in_game' ? reported : kickoff !== null && kickoff <= now ? 'in_game' : 'pre_game';
      const pts = status === 'pre_game' ? 0 : line ? scoreStatsExact(completeStats(line, (p.pos ?? 'WR') as Pos), scoring) : p.points ?? 0;
      points += pts;
      // Pregame outcome; without one, read the spread off the forecast's 10–90% band.
      const f = p.forecast;
      const d = p.dist ?? (f && !f.bye && status === 'pre_game' ? { mean: f.mean, sd: Math.max(0, f.ceiling - f.floor) / 2.563, play: f.play } : null);
      if (status === 'complete' || !d) mean += pts;
      else if (status === 'pre_game') {
        mean += d.play * d.mean;
        variance += Math.max(0, d.play * (d.sd ** 2 + d.mean ** 2) - (d.play * d.mean) ** 2);
      } else {
        const remaining = Math.min(1, Math.max(0.03, 1 - (kickoff ? (now - kickoff) / 60_000 : 90) / GAME_MINUTES));
        const playing = line ? 1 : d.play;
        mean += pts + d.mean * remaining * playing;
        variance += (d.sd * Math.sqrt(remaining) * playing) ** 2;
      }
      return p.forecast ? { ...p, points: r2(pts), forecast: { ...p.forecast, live: { status, points: r2(pts) } } } : { ...p, points: r2(pts) };
    });
    return { side: { ...s, lineup, points: r2(points), projected: r1(mean) }, mean, variance };
  };
  const A = side(g.a), B = side(g.b);
  const spread = Math.sqrt(A.variance + B.variance);
  const winProbA = spread > 1e-6 ? normalCdf((A.mean - B.mean) / spread) : A.mean > B.mean ? 1 : A.mean < B.mean ? 0 : 0.5;
  return { ...g, a: A.side, b: B.side, winProbA: round(winProbA, 4), range: liveRange(A, B), optimizedWinProbA: null, liveEstimate: true };
}
