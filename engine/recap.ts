/** Season results, all-play, luck, lineup efficiency and awards from completed weeks. */
import { optimizeLineup } from './optimizer.ts';
import type { PlayerInfo } from './types.ts';

export interface TeamWeek {
  week: number;
  rosterId: number;
  matchupId: number | null;
  points: number;
  opponentId: number | null;
  opponentPoints: number | null;
  /** Hindsight-optimal lineup points from the players rostered that week. */
  optimal: number;
  starters: string[];
  playersPoints: Record<string, number>;
  result: 'W' | 'L' | 'T' | null;
}

export function buildTeamWeeks(
  week: number,
  matchups: readonly { rosterId: number; matchupId: number | null; points: number; customPoints: number | null; players: string[]; starters: string[]; playersPoints: Record<string, number> }[],
  slots: readonly string[],
  players: Record<string, PlayerInfo>,
): TeamWeek[] {
  const rows: TeamWeek[] = matchups.map(m => {
    const pool = m.players.flatMap(id => (players[id] ? [{ id, eligible: players[id].eligible, value: m.playersPoints[id] ?? 0 }] : []));
    return {
      week,
      rosterId: m.rosterId,
      matchupId: m.matchupId,
      points: m.customPoints ?? m.points,
      opponentId: null,
      opponentPoints: null,
      optimal: optimizeLineup(slots, pool).total,
      starters: m.starters.filter(s => s !== '0'),
      playersPoints: m.playersPoints,
      result: null,
    };
  });
  for (const r of rows) {
    if (r.matchupId === null) continue;
    const opp = rows.find(o => o.matchupId === r.matchupId && o.rosterId !== r.rosterId);
    if (!opp) continue;
    r.opponentId = opp.rosterId;
    r.opponentPoints = opp.points;
    r.result = r.points > opp.points ? 'W' : r.points < opp.points ? 'L' : 'T';
  }
  return rows;
}

export interface SeasonSummary {
  rosterId: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  allPlayWins: number;
  allPlayLosses: number;
  expectedWins: number;
  luck: number;
  efficiency: number;
  benchPoints: number;
  weekly: number[];
  high: number;
  low: number;
  streak: string;
}

export function summarizeSeason(weeks: TeamWeek[][], rosterIds: number[]): Map<number, SeasonSummary> {
  const out = new Map<number, SeasonSummary>();
  for (const id of rosterIds) out.set(id, { rosterId: id, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, allPlayWins: 0, allPlayLosses: 0, expectedWins: 0, luck: 0, efficiency: 0, benchPoints: 0, weekly: [], high: 0, low: Infinity, streak: '' });
  const results = new Map<number, string[]>();
  let optimalTotal = new Map<number, number>();
  for (const week of weeks) {
    for (const r of week) {
      const s = out.get(r.rosterId);
      if (!s) continue;
      s.pointsFor += r.points;
      s.pointsAgainst += r.opponentPoints ?? 0;
      s.weekly.push(r.points);
      s.high = Math.max(s.high, r.points);
      s.low = Math.min(s.low, r.points);
      s.benchPoints += Math.max(0, r.optimal - r.points);
      optimalTotal.set(r.rosterId, (optimalTotal.get(r.rosterId) ?? 0) + r.optimal);
      if (r.result === 'W') s.wins++;
      else if (r.result === 'L') s.losses++;
      else if (r.result === 'T') s.ties++;
      if (r.result) results.set(r.rosterId, [...(results.get(r.rosterId) ?? []), r.result]);
      const others = week.filter(o => o.rosterId !== r.rosterId);
      let w = 0;
      for (const o of others) {
        if (r.points > o.points) { s.allPlayWins++; w++; } else if (r.points < o.points) s.allPlayLosses++;
        else { s.allPlayWins += 0.5; s.allPlayLosses += 0.5; w += 0.5; }
      }
      if (others.length && r.result) s.expectedWins += w / others.length;
    }
  }
  for (const s of out.values()) {
    s.luck = s.wins + s.ties / 2 - s.expectedWins;
    const opt = optimalTotal.get(s.rosterId) ?? 0;
    s.efficiency = opt > 0 ? s.pointsFor / opt : 0;
    if (s.low === Infinity) s.low = 0;
    const res = results.get(s.rosterId) ?? [];
    if (res.length) {
      const last = res[res.length - 1];
      let n = 0;
      for (let i = res.length - 1; i >= 0 && res[i] === last; i--) n++;
      s.streak = `${last}${n}`;
    }
  }
  optimalTotal = new Map();
  return out;
}

export interface Award {
  key: string;
  title: string;
  rosterId: number;
  value: string;
  detail: string;
  week?: number;
  playerId?: string;
}

export function seasonAwards(weeks: TeamWeek[][], summaries: Map<number, SeasonSummary>, players: Record<string, PlayerInfo>, pickups: { rosterId: number; playerId: string; week: number }[]): Award[] {
  const all = weeks.flat();
  if (!all.length) return [];
  const awards: Award[] = [];
  const fmt = (n: number) => n.toFixed(1);
  const hi = all.reduce((a, b) => (b.points > a.points ? b : a));
  awards.push({ key: 'high', title: 'Heat check', rosterId: hi.rosterId, value: fmt(hi.points), detail: `Highest single-week score (week ${hi.week})`, week: hi.week });
  const lo = all.filter(r => r.points > 0).reduce((a, b) => (b.points < a.points ? b : a), all[0]);
  awards.push({ key: 'low', title: 'Ice cold', rosterId: lo.rosterId, value: fmt(lo.points), detail: `Lowest single-week score (week ${lo.week})`, week: lo.week });
  const games = all.filter(r => r.result === 'W' && r.opponentPoints !== null);
  if (games.length) {
    const blow = games.reduce((a, b) => (b.points - b.opponentPoints! > a.points - a.opponentPoints! ? b : a));
    awards.push({ key: 'blowout', title: 'Statement win', rosterId: blow.rosterId, value: `+${fmt(blow.points - blow.opponentPoints!)}`, detail: `Biggest margin of victory (week ${blow.week})`, week: blow.week });
    const close = games.reduce((a, b) => (b.points - b.opponentPoints! < a.points - a.opponentPoints! ? b : a));
    awards.push({ key: 'close', title: 'Photo finish', rosterId: close.rosterId, value: `+${fmt(close.points - close.opponentPoints!)}`, detail: `Narrowest win (week ${close.week})`, week: close.week });
  }
  const sums = [...summaries.values()].filter(s => s.weekly.length);
  if (sums.length) {
    const eff = sums.reduce((a, b) => (b.efficiency > a.efficiency ? b : a));
    awards.push({ key: 'efficiency', title: 'Lineup savant', rosterId: eff.rosterId, value: `${(eff.efficiency * 100).toFixed(1)}%`, detail: 'Best share of hindsight-optimal points started' });
    const bench = sums.reduce((a, b) => (b.benchPoints > a.benchPoints ? b : a));
    awards.push({ key: 'bench', title: 'Bench mob', rosterId: bench.rosterId, value: fmt(bench.benchPoints), detail: 'Most points left on the bench' });
    const lucky = sums.reduce((a, b) => (b.luck > a.luck ? b : a));
    awards.push({ key: 'lucky', title: 'Horseshoe', rosterId: lucky.rosterId, value: `${lucky.luck >= 0 ? '+' : ''}${lucky.luck.toFixed(2)}`, detail: 'Most wins above all-play expectation' });
    const unlucky = sums.reduce((a, b) => (b.luck < a.luck ? b : a));
    awards.push({ key: 'unlucky', title: 'Snakebitten', rosterId: unlucky.rosterId, value: unlucky.luck.toFixed(2), detail: 'Most wins below all-play expectation' });
    const pf = sums.reduce((a, b) => (b.pointsFor > a.pointsFor ? b : a));
    awards.push({ key: 'pf', title: 'Points machine', rosterId: pf.rosterId, value: fmt(pf.pointsFor), detail: 'Most points scored' });
  }
  // Top individual starter performance.
  let bestPerf: { r: TeamWeek; id: string; pts: number } | null = null;
  for (const r of all) for (const id of r.starters) {
    const pts = r.playersPoints[id] ?? 0;
    if (!bestPerf || pts > bestPerf.pts) bestPerf = { r, id, pts };
  }
  if (bestPerf) awards.push({ key: 'performance', title: 'Player of the year (so far)', rosterId: bestPerf.r.rosterId, value: fmt(bestPerf.pts), detail: `${players[bestPerf.id]?.name ?? 'Unknown'} in week ${bestPerf.r.week}`, week: bestPerf.r.week, playerId: bestPerf.id });
  // Best pickup: starter points produced for the team that added him.
  let bestPickup: { rosterId: number; id: string; pts: number } | null = null;
  for (const pk of pickups) {
    let pts = 0;
    for (const r of all) if (r.rosterId === pk.rosterId && r.week >= pk.week && r.starters.includes(pk.playerId)) pts += r.playersPoints[pk.playerId] ?? 0;
    if (pts > 0 && (!bestPickup || pts > bestPickup.pts)) bestPickup = { rosterId: pk.rosterId, id: pk.playerId, pts };
  }
  if (bestPickup) awards.push({ key: 'pickup', title: 'Waiver hawk', rosterId: bestPickup.rosterId, value: fmt(bestPickup.pts), detail: `${players[bestPickup.id]?.name ?? 'Unknown'} — starter points since the pickup`, playerId: bestPickup.id });
  return awards;
}
