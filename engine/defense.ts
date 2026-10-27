/**
 * Points allowed by opponent, per position group, in league scoring — SLA 1.0's
 * "matchup research" metrics, ported faithfully:
 *   allowed/gm, last 4, ceiling/floor/top-10 rates, volatility, opportunities allowed,
 *   schedule-adjusted allowed (two-way ridge fit) and the 0–100 matchup rating.
 * For IDP groups and team defenses (D/ST) the "opponent" is the offense they faced, so the
 * table reads "which offenses give defenders the most", the streaming question.
 */
import { completeStats, didPlay, scoreStatsExact } from './scoring.ts';
import type { PlayerInfo, Pos, Stats } from './types.ts';

export const DEFENSE_GROUPS: readonly Pos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];

export interface DefenseRow {
  team: string;
  /** 0–100 composite, 100 = softest matchup in the league. */
  score: number;
  /** Player-facing rating: 60% schedule-adjusted allowed + 40% opportunity allowed (percentiles). */
  playerScore: number;
  pointsPerGame: number;
  adjustedPerGame: number;
  last3: number;
  last4: number;
  ceilingRate: number;
  floorRate: number;
  top10Rate: number;
  opportunitiesPerGame: number;
  efficiency: number;
  volatility: number;
  games: number;
  rank: number;
  weekly: [number, number][];
}

interface WeekInput { week: number; lines: Iterable<{ id: string; team: string | null; opponent: string | null; stats: Stats }> }

const TOP_N = 10;
const RIDGE = 3;

function opportunities(group: Pos, s: Stats): number {
  const n = (k: string) => s[k] ?? 0;
  const receiving = s.rec_tgt ?? n('rec');
  switch (group) {
    case 'QB': return n('pass_att') + n('rush_att');
    case 'RB': return n('rush_att') + receiving;
    case 'WR': case 'TE': return receiving;
    case 'K': return n('fga') + n('xpa');
    // Sacks and takeaways the offense gave up.
    case 'DEF': return n('sack') + n('int') + n('fum_rec');
    default: return n('idp_tkl_solo') + n('idp_tkl_ast') + n('idp_qb_hit') + n('idp_sack') + n('idp_pass_def');
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
function percentileRanks(entries: { id: string; value: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  if (entries.length === 1) out.set(entries[0].id, 0.5);
  if (entries.length < 2) return out;
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const denom = sorted.length - 1;
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].value === sorted[i].value) j++;
    for (let k = i; k <= j; k++) out.set(sorted[k].id, (i + j) / 2 / denom);
    i = j + 1;
  }
  return out;
}

/** Points conceded = league mean + offense effect + defense effect, solved by alternating ridge. */
function twoWayDefenseEffects(games: { defense: string; offense: string; points: number }[], leagueMean: number): Map<string, number> {
  const offense = new Map<string, number>(), defense = new Map<string, number>();
  for (let it = 0; it < 25; it++) {
    const off = new Map<string, { s: number; n: number }>();
    for (const g of games) {
      const e = off.get(g.offense) ?? { s: 0, n: 0 };
      e.s += g.points - leagueMean - (defense.get(g.defense) ?? 0);
      e.n++;
      off.set(g.offense, e);
    }
    for (const [t, { s, n }] of off) offense.set(t, s / (n + RIDGE));
    const def = new Map<string, { s: number; n: number }>();
    for (const g of games) {
      const e = def.get(g.defense) ?? { s: 0, n: 0 };
      e.s += g.points - leagueMean - (offense.get(g.offense) ?? 0);
      e.n++;
      def.set(g.defense, e);
    }
    for (const [t, { s, n }] of def) defense.set(t, s / (n + RIDGE));
  }
  return defense;
}

export function buildDefenseIndex(weeks: readonly WeekInput[], players: Record<string, PlayerInfo>, scoring: readonly [string, number][]): Map<Pos, DefenseRow[]> {
  // group → opponent → week → { points, opportunities, source team }
  const totals = new Map<Pos, Map<string, Map<number, { pts: number; opp: number; source: string | null }>>>();
  const performances = new Map<Pos, Map<string, number[]>>();
  const top10 = new Map<Pos, Map<string, number>>();
  for (const g of DEFENSE_GROUPS) { totals.set(g, new Map()); performances.set(g, new Map()); top10.set(g, new Map()); }

  for (const { week, lines } of weeks) {
    const rows: { group: Pos; opp: string; team: string | null; pts: number; vol: number }[] = [];
    for (const line of lines) {
      if (line.id.startsWith('TEAM_') || !line.opponent || !didPlay(line.stats)) continue;
      const p = players[line.id];
      if (!p || !DEFENSE_GROUPS.includes(p.pos)) continue;
      rows.push({ group: p.pos, opp: line.opponent, team: line.team, pts: scoreStatsExact(completeStats(line.stats, p.pos), scoring), vol: opportunities(p.pos, line.stats) });
    }
    for (const g of DEFENSE_GROUPS) {
      const inGroup = rows.filter(r => r.group === g);
      for (const r of [...inGroup].sort((a, b) => b.pts - a.pts).slice(0, TOP_N)) top10.get(g)!.set(r.opp, (top10.get(g)!.get(r.opp) ?? 0) + 1);
      for (const r of inGroup) {
        const byOpp = totals.get(g)!;
        if (!byOpp.has(r.opp)) byOpp.set(r.opp, new Map());
        const wk = byOpp.get(r.opp)!;
        const e = wk.get(week) ?? { pts: 0, opp: 0, source: r.team };
        e.pts += r.pts;
        e.opp += r.vol;
        e.source ??= r.team;
        wk.set(week, e);
        const perf = performances.get(g)!;
        if (!perf.has(r.opp)) perf.set(r.opp, []);
        perf.get(r.opp)!.push(r.pts);
      }
    }
  }

  const out = new Map<Pos, DefenseRow[]>();
  for (const g of DEFENSE_GROUPS) {
    const byOpp = totals.get(g)!;
    if (!byOpp.size) { out.set(g, []); continue; }
    const allWeekly = [...byOpp.values()].flatMap(m => [...m.values()].map(v => v.pts));
    const leagueMean = mean(allWeekly);
    const games: { defense: string; offense: string; points: number }[] = [];
    for (const [def, wk] of byOpp) for (const v of wk.values()) if (v.source) games.push({ defense: def, offense: v.source, points: v.pts });
    const effects = twoWayDefenseEffects(games, leagueMean);
    const allPerf = [...performances.get(g)!.values()].flat();
    const p25 = quantile(allPerf, 0.25), p75 = quantile(allPerf, 0.75);
    const iqr = Math.max(p75 - p25, 1e-6);

    const rows = [...byOpp].map(([team, wk]) => {
      const weeksSorted = [...wk.keys()].sort((a, b) => a - b);
      const pts = weeksSorted.map(w => wk.get(w)!.pts);
      const ppg = mean(pts);
      const opps = mean(weeksSorted.map(w => wk.get(w)!.opp));
      const perf = performances.get(g)!.get(team) ?? [];
      return {
        team, ppg, last3: mean(pts.slice(-3)) || ppg, last4: mean(pts.slice(-4)) || ppg, volatility: stdev(pts), games: weeksSorted.length,
        ceilingRate: perf.length ? perf.filter(p => p >= p75).length / perf.length : 0,
        floorRate: perf.length ? perf.filter(p => p <= p25).length / perf.length : 0,
        top10Rate: weeksSorted.length ? (top10.get(g)!.get(team) ?? 0) / weeksSorted.length : 0,
        adjusted: leagueMean + (effects.get(team) ?? 0),
        opps, efficiency: ppg / Math.max(opps, 1),
        weekly: weeksSorted.map(w => [w, Math.round(wk.get(w)!.pts * 10) / 10] as [number, number]),
      };
    });
    const ranked = [...rows].sort((a, b) => b.ppg - a.ppg);
    const rankOf = new Map(ranked.map((r, i) => [r.team, i + 1]));
    const n = rows.length;
    const composite = rows.map(r => {
      const base = n > 1 ? (100 * (n - rankOf.get(r.team)!)) / (n - 1) : 50;
      const trend = ((r.last4 - r.ppg) / iqr) * 10;
      const consistency = (1 - Math.min(r.volatility / (r.ppg || 1), 1)) * 10;
      return { id: r.team, value: base + trend + r.ceilingRate * 15 - r.floorRate * 10 + consistency + r.top10Rate * 20 };
    });
    const scorePct = percentileRanks(composite);
    const adjPct = percentileRanks(rows.map(r => ({ id: r.team, value: r.adjusted })));
    const oppPct = percentileRanks(rows.map(r => ({ id: r.team, value: r.opps })));
    out.set(g, rows.map(r => ({
      team: r.team,
      score: Math.round((scorePct.get(r.team) ?? 0.5) * 1000) / 10,
      playerScore: Math.round(((adjPct.get(r.team) ?? 0.5) * 0.6 + (oppPct.get(r.team) ?? 0.5) * 0.4) * 1000) / 10,
      pointsPerGame: r.ppg, adjustedPerGame: r.adjusted, last3: r.last3, last4: r.last4, ceilingRate: r.ceilingRate, floorRate: r.floorRate,
      top10Rate: r.top10Rate, opportunitiesPerGame: r.opps, efficiency: r.efficiency, volatility: r.volatility, games: r.games,
      rank: rankOf.get(r.team)!, weekly: r.weekly,
    })).sort((a, b) => b.score - a.score));
  }
  return out;
}
