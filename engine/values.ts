/**
 * Player value in this league's economy:
 *  - ROS: expected points per remaining week (byes and injury odds included)
 *  - VORP: above the replacement level actually available on the waiver wire
 *  - Dynasty: VORP carried over four seasons through a position age curve
 */
import type { WeekForecast } from './forecast.ts';
import type { PlayerInfo, Pos } from './types.ts';

export interface PlayerValue {
  id: string;
  rosAvg: number;
  rosTotal: number;
  replacement: number;
  vorp: number;
  dynasty: number;
  /** 0–100 composite used for trade and roster decisions. */
  value: number;
  posRank: number;
  overallRank: number;
  tier: number;
}

/** Relative production vs a player's prime, by position and age. */
export function ageCurve(pos: Pos, age: number): number {
  const shape: Record<string, [number, number, number, number]> = {
    // [prime start, prime end, growth/yr before, decline/yr after]
    QB: [26, 33, 0.06, 0.07], RB: [23, 26, 0.05, 0.13], WR: [24, 28, 0.07, 0.09], TE: [25, 29, 0.1, 0.09],
    DL: [25, 30, 0.06, 0.07], LB: [24, 28, 0.06, 0.09], DB: [24, 28, 0.05, 0.1], K: [24, 36, 0.01, 0.04],
  };
  const [start, end, grow, decline] = shape[pos] ?? shape.WR;
  if (age < start) return Math.max(0.55, 1 - grow * (start - age));
  if (age <= end) return 1;
  // Compounding decline that accelerates a few years past the prime (no floor, so ratios
  // between future and current age keep falling for veterans).
  const years = age - end;
  return (1 - decline) ** years * Math.exp(-0.04 * Math.max(0, years - 3) ** 2);
}

export function computeValues(args: {
  ids: readonly string[];
  players: Record<string, PlayerInfo>;
  weeks: readonly number[];
  forecasts: ReadonlyMap<number, ReadonlyMap<string, WeekForecast>>;
  /** Players on any fantasy roster; everyone else is a free agent. */
  rostered: ReadonlySet<string>;
  /** Keeper/dynasty league: long-term value counts. Defaults to true. */
  dynasty?: boolean;
}): Map<string, PlayerValue> {
  const { ids, players, weeks, forecasts, rostered } = args;
  const keeper = args.dynasty ?? true;
  const ros = new Map<string, { avg: number; total: number; healthy: number }>();
  for (const id of ids) {
    let total = 0, n = 0, healthy = 0;
    for (const w of weeks) {
      const f = forecasts.get(w)?.get(id);
      if (!f || f.bye) continue;
      total += f.expected;
      healthy += f.mean;
      n++;
    }
    ros.set(id, { avg: n ? total / n : 0, total, healthy: n ? healthy / n : 0 });
  }

  // Replacement level = what the waiver wire offers: the mean of the three best free agents
  // at each position. In a deep league this, not the last starter, is the real alternative.
  const byPos = new Map<Pos, string[]>();
  for (const id of ids) {
    const p = players[id];
    if (!p) continue;
    if (!byPos.has(p.pos)) byPos.set(p.pos, []);
    byPos.get(p.pos)!.push(id);
  }
  const replacement = new Map<Pos, number>();
  for (const [pos, list] of byPos) {
    const fa = list.filter(id => !rostered.has(id)).map(id => ros.get(id)?.avg ?? 0).sort((a, b) => b - a).slice(0, 3);
    replacement.set(pos, fa.length ? fa.reduce((a, b) => a + b, 0) / fa.length : 0);
  }

  const raw = new Map<string, { vorp: number; dynasty: number; repl: number }>();
  for (const id of ids) {
    const p = players[id];
    if (!p) continue;
    const r = ros.get(id)!;
    const repl = replacement.get(p.pos) ?? 0;
    const vorp = r.avg - repl;
    const age = p.age ?? 26;
    const base = ageCurve(p.pos, age);
    // This season uses injury-adjusted expectations; later seasons assume normal (≈90%) availability.
    let dynasty = Math.max(0, r.avg - repl) * weeks.length;
    for (let y = 1; y < 4; y++) {
      const projected = r.healthy * 0.92 * (ageCurve(p.pos, age + y) / base);
      dynasty += Math.max(0, projected - repl) * 17 * 0.8 ** y;
    }
    // Young players with little production still carry market value; Sleeper's popularity
    // rank is the only market signal available for IDP-inclusive leagues.
    if ((p.yearsExp ?? 5) <= 2 && p.searchRank !== null && p.searchRank < 600) dynasty += ((600 - p.searchRank) / 600) * 40;
    raw.set(id, { vorp, dynasty, repl });
  }
  const maxDynasty = Math.max(1, ...[...raw.values()].map(v => v.dynasty));
  const maxVorp = Math.max(1, ...[...raw.values()].map(v => v.vorp));

  const out = new Map<string, PlayerValue>();
  for (const [id, r] of raw) {
    const ro = ros.get(id)!;
    // Dynasty: half "helps now", half "long-term asset", both scaled to the league's best.
    // Redraft: only this season counts.
    const value = keeper ? 100 * (0.5 * Math.max(0, r.vorp) / maxVorp + 0.5 * r.dynasty / maxDynasty) : 100 * Math.max(0, r.vorp) / maxVorp;
    out.set(id, { id, rosAvg: ro.avg, rosTotal: ro.total, replacement: r.repl, vorp: r.vorp, dynasty: (100 * r.dynasty) / maxDynasty, value, posRank: 0, overallRank: 0, tier: 0 });
  }
  const sorted = [...out.values()].sort((a, b) => b.value - a.value);
  sorted.forEach((v, i) => { v.overallRank = i + 1; });
  for (const [, list] of byPos) {
    const vs = list.map(id => out.get(id)).filter((v): v is PlayerValue => !!v).sort((a, b) => b.rosAvg - a.rosAvg);
    vs.forEach((v, i) => { v.posRank = i + 1; });
    // Tiers: break where the gap to the next player is unusually large.
    let tier = 1;
    const gaps = vs.slice(0, 60).map((v, i) => (i ? vs[i - 1].rosAvg - v.rosAvg : 0));
    const meanGap = gaps.length > 1 ? gaps.slice(1).reduce((a, b) => a + b, 0) / (gaps.length - 1) : 0;
    vs.forEach((v, i) => {
      if (i > 0 && i < 60 && gaps[i] > meanGap * 2.2) tier++;
      v.tier = i < 60 ? tier : tier + 1;
    });
  }
  return out;
}
