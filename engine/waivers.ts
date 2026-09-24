/**
 * Waiver recommendations measured the only way that matters: how many expected points a
 * pickup adds to *your* best legal lineup, this week and over the rest of the season,
 * net of the player you'd have to drop.
 */
import type { WeekForecast } from './forecast.ts';
import { optimizeLineup, type LineupCandidate } from './optimizer.ts';
import { canFill } from './positions.ts';
import type { PlayerInfo } from './types.ts';

export interface WaiverRecommendation {
  id: string;
  /** Expected-point gain to your best lineup this week (0 if his game already started). */
  weekGain: number;
  /** Discounted sum of weekly lineup gains over the horizon. */
  rosGain: number;
  /** Weeks within the horizon where he would start for you. */
  startWeeks: number[];
  dropId: string | null;
  dropCost: number;
  netGain: number;
  /** Other teams whose best lineup he would crack next week. */
  competition: number;
  faab: { low: number; high: number } | null;
  reasons: string[];
}

interface Args {
  roster: readonly string[];
  rosterLimit: number;
  slots: readonly string[];
  players: Record<string, PlayerInfo>;
  forecasts: ReadonlyMap<number, ReadonlyMap<string, WeekForecast>>;
  weeks: readonly number[];
  currentWeek: number;
  freeAgents: readonly string[];
  otherRosters: readonly (readonly string[])[];
  faabRemaining: number | null;
  dynasty: ReadonlyMap<string, number>;
  trending: ReadonlyMap<string, number>;
  isLocked: (id: string) => boolean;
  /** Players who must not be suggested as drops (IR, taxi are already excluded). */
  protectedIds?: ReadonlySet<string>;
  limit?: number;
}

const DISCOUNT = 0.92;
/** Converts dynasty value (0–100) into "points you'd give up" when choosing a drop. */
const DYNASTY_KEEP_WEIGHT = 0.9;

export function waiverRecommendations(a: Args): WaiverRecommendation[] {
  const weight = (w: number) => DISCOUNT ** Math.max(0, w - a.currentWeek);
  const best = (ids: readonly string[], week: number): number => {
    const f = a.forecasts.get(week);
    if (!f) return 0;
    const pool: LineupCandidate[] = [];
    for (const id of ids) {
      const p = a.players[id], fc = f.get(id);
      if (!p || !fc) continue;
      if (week === a.currentWeek && a.isLocked(id)) continue;
      pool.push({ id, eligible: p.eligible, value: fc.expected });
    }
    return optimizeLineup(a.slots, pool).total;
  };
  const base = new Map(a.weeks.map(w => [w, best(a.roster, w)]));

  // Cheap upper bound to prune: can he beat the weakest starter he could replace?
  const weakest = new Map<number, Map<string, number>>();
  for (const w of a.weeks) {
    const f = a.forecasts.get(w);
    const pool: LineupCandidate[] = a.roster.flatMap(id => (a.players[id] && f?.get(id) ? [{ id, eligible: a.players[id].eligible, value: f.get(id)!.expected }] : []));
    const lineup = optimizeLineup(a.slots, pool);
    const bySlot = new Map<string, number>();
    lineup.ids.forEach((id, i) => {
      const v = id ? f?.get(id)?.expected ?? 0 : 0;
      const slot = a.slots[i];
      bySlot.set(slot, Math.min(bySlot.get(slot) ?? Infinity, v));
    });
    weakest.set(w, bySlot);
  }
  const upperBound = (id: string) => {
    const p = a.players[id];
    let total = 0;
    for (const w of a.weeks) {
      const fc = a.forecasts.get(w)?.get(id);
      if (!fc || (w === a.currentWeek && a.isLocked(id))) continue;
      let gap = 0;
      for (const [slot, v] of weakest.get(w)!) if (canFill(p.eligible, slot)) gap = Math.max(gap, fc.expected - v);
      total += gap * weight(w);
    }
    return total;
  };
  const candidates = a.freeAgents.filter(id => a.players[id]).map(id => ({ id, ub: upperBound(id) }))
    .filter(c => c.ub > 0.05).sort((x, y) => y.ub - x.ub).slice(0, 45);

  const needsDrop = a.roster.length >= a.rosterLimit;
  // Cost of losing each rostered player (lineup points over the horizon + dynasty keep value).
  const dropCosts = new Map<string, { lineup: number; total: number }>();
  if (needsDrop) {
    for (const id of a.roster) {
      if (a.protectedIds?.has(id) || a.isLocked(id)) continue;
      const without = a.roster.filter(x => x !== id);
      let loss = 0;
      for (const w of a.weeks) loss += (base.get(w)! - best(without, w)) * weight(w);
      const keep = (a.dynasty.get(id) ?? 0) * DYNASTY_KEEP_WEIGHT;
      dropCosts.set(id, { lineup: loss, total: loss + keep });
    }
  }
  const dropOrder = [...dropCosts].sort((x, y) => x[1].total - y[1].total).map(([id]) => id);

  const recs: WaiverRecommendation[] = [];
  for (const c of candidates) {
    const withAdd = [...a.roster, c.id];
    let rosGain = 0, weekGain = 0;
    const startWeeks: number[] = [];
    for (const w of a.weeks) {
      const g = best(withAdd, w) - base.get(w)!;
      if (g > 0.05) startWeeks.push(w);
      if (w === a.currentWeek) weekGain = g;
      rosGain += g * weight(w);
    }
    if (rosGain <= 0.05) continue;
    let dropId: string | null = null, dropCost = 0, netGain = rosGain;
    if (needsDrop) {
      // Evaluate the three cheapest drops exactly with the new player on the roster.
      let bestNet = -Infinity;
      for (const d of dropOrder.slice(0, 4)) {
        const after = withAdd.filter(x => x !== d);
        let gain = 0;
        for (const w of a.weeks) gain += (best(after, w) - base.get(w)!) * weight(w);
        const keep = (a.dynasty.get(d) ?? 0) * DYNASTY_KEEP_WEIGHT;
        if (gain - keep > bestNet) {
          bestNet = gain - keep;
          dropId = d;
          dropCost = rosGain - gain;
          netGain = gain;
        }
      }
      if (dropId === null) continue;
    }
    recs.push({ id: c.id, weekGain, rosGain, startWeeks, dropId, dropCost, netGain, competition: 0, faab: null, reasons: [] });
  }
  recs.sort((x, y) => y.netGain - x.netGain);
  const top = recs.slice(0, a.limit ?? 25);

  // Competition: how many other managers would start him in their best lineup next week.
  const nextWeek = a.weeks.find(w => w > a.currentWeek) ?? a.currentWeek;
  for (const r of top) {
    for (const other of a.otherRosters) {
      const before = best(other, nextWeek);
      if (best([...other, r.id], nextWeek) - before > 0.5) r.competition++;
    }
  }
  for (const r of top) {
    const p = a.players[r.id];
    const perWeek = r.netGain / Math.max(1, r.startWeeks.length);
    if (a.faabRemaining !== null && a.faabRemaining > 0) {
      // Guidance, not a clearing-price prediction: scale by value and by how many rivals want him.
      const share = Math.min(0.5, Math.max(0.01, (r.netGain / 160) * (1 + 0.25 * r.competition)));
      r.faab = { low: Math.max(0, Math.round(a.faabRemaining * share * 0.7)), high: Math.max(1, Math.round(a.faabRemaining * share * 1.25)) };
    }
    if (r.weekGain > 0.3) r.reasons.push(`+${r.weekGain.toFixed(1)} pts to your best lineup this week`);
    if (r.startWeeks.length) r.reasons.push(`Starts for you in ${r.startWeeks.length} of the next ${a.weeks.length} weeks (${perWeek.toFixed(1)}/wk when he does)`);
    const tr = a.trending.get(r.id);
    if (tr) r.reasons.push(`${tr.toLocaleString('en-US')} Sleeper adds in the last 48h`);
    if (r.competition) r.reasons.push(`${r.competition} other team${r.competition > 1 ? 's' : ''} would start him`);
    if (p.injuryStatus) r.reasons.push(`Injury: ${p.injuryStatus}`);
  }
  return top;
}
