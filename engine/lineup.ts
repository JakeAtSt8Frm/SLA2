import { headToHead, variance, type Outcome } from './distribution.ts';
import { outcomeOf, type WeekForecast } from './forecast.ts';
import { optimizeLineup, type LineupCandidate } from './optimizer.ts';
import { canFill } from './positions.ts';
import type { PlayerInfo } from './types.ts';

export interface TeamLineup {
  slots: string[];
  ids: (string | null)[];
  expected: number;
  sd: number;
}

export interface Swap {
  slot: string;
  startId: string;
  sitId: string | null;
  gain: number;
  /** P(start outscores sit) — how confident the call is. */
  confidence: number;
}

export interface LineupAdvice {
  current: TeamLineup;
  optimal: TeamLineup;
  gain: number;
  swaps: Swap[];
  moves: { id: string; from: string; to: string }[];
  /** Starter slots that are locked because the game kicked off. */
  lockedSlots: number[];
  emptySlots: number[];
  warnings: { id: string; kind: 'out' | 'bye' | 'questionable' | 'empty' | 'no-projection'; message: string }[];
}

export function lineupStats(slots: readonly string[], ids: readonly (string | null)[], forecasts: ReadonlyMap<string, WeekForecast>): TeamLineup {
  let expected = 0, v = 0;
  for (const id of ids) {
    if (!id) continue;
    const f = forecasts.get(id);
    if (!f) continue;
    expected += f.expected;
    v += variance(outcomeOf(f));
  }
  return { slots: [...slots], ids: [...ids], expected, sd: Math.sqrt(v) };
}

/** Best legal lineup for a set of players in one week (no locks: planning future weeks). */
export function bestLineup(slots: readonly string[], ids: readonly string[], players: Record<string, PlayerInfo>, forecasts: ReadonlyMap<string, WeekForecast>): TeamLineup {
  const pool: LineupCandidate[] = [];
  for (const id of ids) {
    const p = players[id], f = forecasts.get(id);
    if (!p || !f) continue;
    pool.push({ id, eligible: p.eligible, value: f.expected });
  }
  const result = optimizeLineup(slots, pool);
  return lineupStats(slots, result.ids, forecasts);
}

/**
 * Start/sit advice for the current week: respects kickoff locks (a started player cannot be
 * benched, a benched player whose game started cannot be inserted).
 */
export function adviseLineup(
  slots: readonly string[],
  starters: readonly string[],
  eligibleIds: readonly string[],
  players: Record<string, PlayerInfo>,
  forecasts: ReadonlyMap<string, WeekForecast>,
  isLocked: (id: string) => boolean,
): LineupAdvice {
  const current = slots.map((_, i) => (starters[i] && starters[i] !== '0' ? starters[i] : null));
  const locked = new Map<number, string | null>();
  current.forEach((id, i) => { if (id && isLocked(id)) locked.set(i, id); });
  const starterSet = new Set(current.filter((x): x is string => !!x));
  const pool: LineupCandidate[] = [];
  for (const id of eligibleIds) {
    const p = players[id], f = forecasts.get(id);
    if (!p || !f) continue;
    if (isLocked(id) && !starterSet.has(id)) continue;
    pool.push({ id, eligible: p.eligible, value: f.expected });
  }
  const best = optimizeLineup(slots, pool, locked);
  best.ids = alignToCurrent(slots, current, best.ids);
  const cur = lineupStats(slots, current, forecasts);
  const opt = lineupStats(slots, best.ids, forecasts);

  // Pair each newly started player with the starter he replaces: same position first, then any
  // shared eligibility, then whatever is left (a chain move through a flex-style slot).
  const exp = (id: string) => forecasts.get(id)?.expected ?? 0;
  const ins = best.ids.filter((id): id is string => !!id && !starterSet.has(id)).sort((a, b) => exp(b) - exp(a));
  const outs = current.filter((id): id is string => !!id && !best.ids.includes(id)).sort((a, b) => exp(a) - exp(b));
  const pairs = new Map<string, string | null>();
  const usedOuts = new Set<string>();
  const passes: ((inId: string, outId: string) => boolean)[] = [
    (i, o) => players[i]?.pos === players[o]?.pos,
    (i, o) => !!players[o]?.eligible.some(pos => players[i]?.eligible.includes(pos)),
    () => true,
  ];
  for (const rule of passes) {
    for (const inId of ins) {
      if (pairs.has(inId)) continue;
      const outId = outs.find(o => !usedOuts.has(o) && rule(inId, o));
      if (outId) { pairs.set(inId, outId); usedOuts.add(outId); }
    }
  }
  const emptyOutcome: Outcome = { mean: 0, play: 0, residuals: new Array(21).fill(0) };
  const swaps: Swap[] = ins.map(inId => {
    const sitId = pairs.get(inId) ?? null;
    const fin = forecasts.get(inId)!;
    const fout = sitId ? forecasts.get(sitId) : undefined;
    return {
      slot: slots[best.ids.indexOf(inId)],
      startId: inId,
      sitId,
      gain: fin.expected - (fout?.expected ?? 0),
      confidence: headToHead(outcomeOf(fin), fout ? outcomeOf(fout) : emptyOutcome, hashCode(inId + (sitId ?? ''))),
    };
  });
  // Starters who stay in but must change slot type (e.g. an edge rusher sliding from LB to DL).
  const moves: LineupAdvice['moves'] = [];
  for (const id of starterSet) {
    const from = current.indexOf(id), to = best.ids.indexOf(id);
    if (to >= 0 && slots[from] !== slots[to]) moves.push({ id, from: slots[from], to: slots[to] });
  }

  const warnings: LineupAdvice['warnings'] = [];
  current.forEach((id, i) => {
    if (!id) {
      warnings.push({ id: '', kind: 'empty', message: `${slots[i]} slot is empty` });
      return;
    }
    const f = forecasts.get(id), p = players[id];
    if (!f || !p) return;
    if (f.bye) warnings.push({ id, kind: 'bye', message: `${p.name} is on bye` });
    else if (f.play === 0 && !f.live) warnings.push({ id, kind: 'out', message: `${p.name} is ${p.injuryStatus ?? 'not expected to play'}` });
    else if (p.injuryStatus === 'Questionable' || p.injuryStatus === 'Doubtful') warnings.push({ id, kind: 'questionable', message: `${p.name} is ${p.injuryStatus}` });
    else if (f.provider === null && !f.live) warnings.push({ id, kind: 'no-projection', message: `${p.name} has no projection this week` });
  });

  return {
    current: cur,
    optimal: opt,
    gain: opt.expected - cur.expected,
    swaps,
    moves,
    lockedSlots: [...locked.keys()],
    emptySlots: current.map((id, i) => (id ? -1 : i)).filter(i => i >= 0),
    warnings,
  };
}

/**
 * The optimiser is indifferent between identical slots (DL1 vs DL2). Reorder its answer within
 * each slot type so players who stay in the lineup keep the slot they already occupy.
 */
function alignToCurrent(slots: readonly string[], current: readonly (string | null)[], optimal: readonly (string | null)[]): (string | null)[] {
  const out = [...optimal];
  const types = new Set(slots);
  for (const type of types) {
    const idx = slots.map((s, i) => (s === type ? i : -1)).filter(i => i >= 0);
    const chosen = new Set(idx.map(i => optimal[i]).filter((x): x is string => !!x));
    const placed = new Set<string>();
    const result = new Map<number, string | null>();
    for (const i of idx) {
      const c = current[i];
      if (c && chosen.has(c)) { result.set(i, c); placed.add(c); }
    }
    const rest = idx.map(i => optimal[i]).filter(x => !x || !placed.has(x));
    for (const i of idx) if (!result.has(i)) result.set(i, rest.shift() ?? null);
    for (const [i, v] of result) out[i] = v;
  }
  return out;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** Can this player occupy any starting slot in the league? */
export function startable(slots: readonly string[], player: PlayerInfo): boolean {
  return slots.some(slot => canFill(player.eligible, slot));
}
