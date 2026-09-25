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
  /** Current starters in slot order (empty string / missing = empty slot). Needed for kickoff locks. */
  starters?: readonly string[];
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
  const starters = a.starters ?? [];

  /**
   * Best legal lineup from `ids` in `week`. In the current week a started player stays in the slot
   * he occupies and a player whose game has kicked off cannot be moved in.
   */
  const lineup = (ids: readonly string[], week: number) => {
    const f = a.forecasts.get(week);
    if (!f) return { total: 0, ids: [] as (string | null)[] };
    const current = week === a.currentWeek;
    const members = new Set(ids);
    const locked = new Map<number, string | null>();
    if (current) starters.forEach((id, i) => { if (id && members.has(id) && a.isLocked(id)) locked.set(i, id); });
    const lockedIds = new Set(locked.values());
    const pool: LineupCandidate[] = [];
    for (const id of members) {
      const p = a.players[id], fc = f.get(id);
      if (!p || !fc) continue;
      if (current && a.isLocked(id) && !lockedIds.has(id)) continue;
      pool.push({ id, eligible: p.eligible, value: fc.expected });
    }
    return optimizeLineup(a.slots, pool, locked);
  };
  const best = (ids: readonly string[], week: number) => lineup(ids, week).total;
  const baseLineups = new Map(a.weeks.map(w => [w, lineup(a.roster, w)]));
  const base = new Map([...baseLineups].map(([w, l]) => [w, l.total]));

  /*
   * Pruning bound. Lineups are bases of a transversal matroid, so adding one player can raise the
   * optimum by at most (his value − the weakest movable starter), or by his whole value when a slot
   * is empty. The bound is exact enough to skip hundreds of free agents without missing a pickup
   * that helps by pushing a dual-eligible starter into another slot.
   */
  const floorByWeek = new Map<number, number>();
  for (const [w, l] of baseLineups) {
    const f = a.forecasts.get(w);
    let min = Infinity, empty = false;
    l.ids.forEach(id => {
      if (!id) { empty = true; return; }
      if (w === a.currentWeek && a.isLocked(id)) return;
      min = Math.min(min, f?.get(id)?.expected ?? 0);
    });
    floorByWeek.set(w, empty ? 0 : min);
  }
  const upperBound = (id: string) => {
    const p = a.players[id];
    if (!a.slots.some(slot => canFill(p.eligible, slot))) return 0;
    let total = 0;
    for (const w of a.weeks) {
      const fc = a.forecasts.get(w)?.get(id);
      if (!fc || (w === a.currentWeek && a.isLocked(id))) continue;
      const floor = floorByWeek.get(w)!;
      total += Math.max(0, fc.expected - (Number.isFinite(floor) ? floor : Infinity)) * weight(w);
    }
    return total;
  };
  const candidates = a.freeAgents.filter(id => a.players[id]).map(id => ({ id, ub: upperBound(id) }))
    .filter(c => c.ub > 0.05).sort((x, y) => y.ub - x.ub).slice(0, 45);

  const needsDrop = a.roster.length >= a.rosterLimit;
  // Cost of losing each rostered player (lineup points over the horizon + dynasty keep value).
  const dropCosts = new Map<string, number>();
  if (needsDrop) {
    for (const id of a.roster) {
      if (a.protectedIds?.has(id) || a.isLocked(id)) continue;
      const without = a.roster.filter(x => x !== id);
      let loss = 0;
      for (const w of a.weeks) loss += (base.get(w)! - best(without, w)) * weight(w);
      dropCosts.set(id, loss + (a.dynasty.get(id) ?? 0) * DYNASTY_KEEP_WEIGHT);
    }
  }
  const cheapest = [...dropCosts].sort((x, y) => x[1] - y[1]).map(([id]) => id).slice(0, 4);

  const recs: WaiverRecommendation[] = [];
  for (const c of candidates) {
    const withAdd = [...a.roster, c.id];
    let rosGain = 0, weekGain = 0;
    const startWeeks: number[] = [];
    // Starters the pickup pushes out of the lineup: always worth testing as the drop.
    const displaced = new Set<string>();
    for (const w of a.weeks) {
      const after = lineup(withAdd, w);
      const g = after.total - base.get(w)!;
      if (g > 0.05) {
        startWeeks.push(w);
        const inAfter = new Set(after.ids);
        for (const id of baseLineups.get(w)!.ids) if (id && !inAfter.has(id)) displaced.add(id);
      }
      if (w === a.currentWeek) weekGain = g;
      rosGain += g * weight(w);
    }
    if (rosGain <= 0.05) continue;
    let dropId: string | null = null, dropCost = 0, netGain = rosGain;
    if (needsDrop) {
      let bestNet = -Infinity;
      const options = new Set([...cheapest, ...[...displaced].filter(id => dropCosts.has(id))]);
      for (const d of options) {
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
      if (dropId === null || netGain <= 0.05) continue;
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
