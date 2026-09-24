import { canFill } from './positions.ts';
import type { Pos } from './types.ts';

export interface LineupCandidate {
  id: string;
  eligible: readonly Pos[];
  value: number;
}

export interface LineupResult {
  slots: string[];
  /** Player id per slot, or null when nothing eligible is available. */
  ids: (string | null)[];
  total: number;
}

const INELIGIBLE = 1e9;
/** Filling a slot is always preferred to leaving it empty, even with a negative projection. */
const FILL_BONUS = 1e4;

/**
 * Exact maximum-weight lineup via the Hungarian algorithm (O(n²m), n = slots).
 * Flex and superflex slots compete for players jointly, which greedy position-by-position
 * filling gets wrong. `locked` pins slot index → player id (null keeps the slot empty),
 * modelling games that have already kicked off.
 */
export function optimizeLineup(
  slots: readonly string[],
  candidates: readonly LineupCandidate[],
  locked: ReadonlyMap<number, string | null> = new Map(),
): LineupResult {
  const n = slots.length;
  if (n === 0) return { slots: [], ids: [], total: 0 };
  const lockedIds = new Set<string>();
  for (const id of locked.values()) if (id) lockedIds.add(id);
  const pool = candidates.filter(c => Number.isFinite(c.value));
  const m = pool.length + n;
  const cost = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    const hasLock = locked.has(i);
    const lockId = locked.get(i) ?? null;
    for (let j = 0; j < m; j++) {
      let c: number;
      if (j >= pool.length) {
        // Dummy column: slot left empty. A slot locked to a real player may not go empty.
        c = hasLock && lockId !== null ? INELIGIBLE : 0;
      } else {
        const p = pool[j];
        if (hasLock) c = lockId === p.id ? -(p.value + FILL_BONUS) : INELIGIBLE;
        else if (lockedIds.has(p.id) || !canFill(p.eligible, slots[i])) c = INELIGIBLE;
        else c = -(p.value + FILL_BONUS);
      }
      cost[i * m + j] = c;
    }
  }
  const assign = hungarian(cost, n, m);
  const ids: (string | null)[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = assign[i];
    if (j >= 0 && j < pool.length && cost[i * m + j] < INELIGIBLE / 2) {
      ids.push(pool[j].id);
      total += pool[j].value;
    } else ids.push(null);
  }
  return { slots: [...slots], ids, total };
}

/** Rectangular Hungarian (rows ≤ columns). Returns column index per row. */
function hungarian(cost: Float64Array, n: number, m: number): Int32Array {
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1); // p[j] = row matched to column j (1-based rows)
  const way = new Int32Array(m + 1);
  const minv = new Float64Array(m + 1);
  const used = new Uint8Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      const rowBase = (i0 - 1) * m;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[rowBase + j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const result = new Int32Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] > 0) result[p[j] - 1] = j - 1;
  return result;
}
