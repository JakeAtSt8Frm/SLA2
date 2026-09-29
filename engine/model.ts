/**
 * Runtime for the exported gradient-boosted projection model (see research/train.py).
 * Predicts league points *given the player plays*; availability and uncertainty are
 * layered on separately so each piece stays auditable.
 */
import { FEATURE_NAMES } from './features.ts';
import type { Pos } from './types.ts';

interface ExportedTree { f: number[]; t: number[]; l: number[]; r: number[]; m: number[]; v: number[] }
export interface ModelFile {
  meta: { version: string; trainedAt: string; trainingRows: number; seasons: number[] };
  features: string[];
  residualTarget: boolean;
  /**
   * Share of the trees' correction to the provider projection that is applied (0–1), chosen on
   * a tuning season. Leagues where the trees don't beat the provider shrink toward it. Default 1.
   */
  shrink?: number;
  points: { baseline: number; trees: ExportedTree[] };
  residuals: Record<string, { edges: number[]; quantiles: number[][] }>;
  availability: {
    none: number; Questionable: number; Doubtful: number; Out: number;
    /** Questionable split by role: starters (≥50% of recent snaps) play more often than reserves. */
    roles?: { Questionable?: { starter: number; reserve: number } };
    /** P(plays k weeks ahead | healthy starter now), k = 1…, by position group (QB, RB, WR, TE, K, IDP). */
    ahead?: Record<string, number[]>;
  };
}

/**
 * Every tree packed end to end into one set of typed arrays (node indices are absolute). With the
 * input gathered once into the model's column order, prediction is one tight loop over contiguous
 * memory instead of a walk over per-tree objects (≈30% faster, identical results).
 */
interface PackedForest { roots: Int32Array; feature: Int16Array; threshold: Float64Array; left: Int32Array; right: Int32Array; missingLeft: Uint8Array; value: Float64Array }

const IDX = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, i])) as Record<string, number>;

/** Sleeper injury_status values that mean the player will not suit up. */
const OUT_STATUSES = new Set(['Out', 'IR', 'PUP', 'Sus', 'Suspended', 'NA', 'DNR', 'COV', 'NFI', 'Inactive']);

export class ProjectionModel {
  readonly meta: ModelFile['meta'];
  private forest: PackedForest;
  private baseline: number;
  private columns: Int32Array;
  private row: Float64Array;
  private residualTarget: boolean;
  private shrink: number;
  private residuals: ModelFile['residuals'];
  private avail: ModelFile['availability'];

  constructor(file: ModelFile) {
    this.meta = file.meta;
    this.baseline = file.points.baseline;
    this.residualTarget = file.residualTarget;
    this.shrink = file.shrink ?? 1;
    // Centre each residual curve so simulated means equal the model's point forecast.
    this.residuals = Object.fromEntries(Object.entries(file.residuals).map(([pos, table]) => [pos, {
      edges: table.edges,
      quantiles: table.quantiles.map(q => {
        let m = 0;
        for (let i = 0; i < q.length - 1; i++) m += (q[i] + q[i + 1]) / 2;
        m /= q.length - 1;
        return q.map(v => v - m);
      }),
    }]));
    this.avail = file.availability;
    this.columns = Int32Array.from(file.features.map(name => {
      const i = IDX[name];
      if (i === undefined) throw new Error(`Model feature ${name} is not produced by engine/features.ts`);
      return i;
    }));
    this.row = new Float64Array(this.columns.length);
    this.forest = packForest(file.points.trees);
  }

  /** Expected league points if the player takes the field. */
  predict(x: Float64Array): number {
    const cols = this.columns, row = this.row;
    for (let i = 0; i < cols.length; i++) row[i] = x[cols[i]];
    const { roots, feature, threshold, left, right, missingLeft, value } = this.forest;
    let out = this.baseline;
    for (let t = 0; t < roots.length; t++) {
      let node = roots[t];
      let f = feature[node];
      while (f !== -1) {
        const v = row[f];
        node = (v !== v ? missingLeft[node] === 1 : v <= threshold[node]) ? left[node] : right[node];
        f = feature[node];
      }
      out += value[node];
    }
    if (this.residualTarget) {
      out *= this.shrink;
      const proj = x[IDX.proj_pts];
      const base = !Number.isNaN(proj) ? proj : !Number.isNaN(x[IDX.ewma]) ? x[IDX.ewma] : !Number.isNaN(x[IDX.mean_prev]) ? x[IDX.mean_prev] : 0;
      out += base;
    }
    return out;
  }

  /** Residual quantile table for a position at a predicted level (21 points, 0%…100%). */
  quantiles(pos: Pos, prediction: number): number[] {
    const table = this.residuals[pos] ?? this.residuals.WR;
    let bucket = 0;
    while (bucket < table.edges.length && prediction > table.edges[bucket]) bucket++;
    return table.quantiles[bucket];
  }

  /** Points at probability level u ∈ [0,1], given the player plays. Linear between tabulated quantiles. */
  quantile(pos: Pos, prediction: number, u: number, table = this.quantiles(pos, prediction)): number {
    const x = Math.min(0.999999, Math.max(0, u)) * (table.length - 1);
    const i = Math.floor(x);
    const frac = x - i;
    const r = table[i] + (table[Math.min(i + 1, table.length - 1)] - table[i]) * frac;
    return prediction + r;
  }

  /**
   * Probability of playing from the Sleeper injury designation, measured on 2020–2025 official
   * reports (Questionable ≈ 67%). Weekly projections alone cannot tell us this pregame.
   */
  playProbability(injuryStatus: string | null, onNflRoster: boolean, role?: 'starter' | 'reserve'): number {
    if (!onNflRoster) return 0;
    if (!injuryStatus) return this.avail.none;
    if (OUT_STATUSES.has(injuryStatus)) return 0;
    if (injuryStatus === 'Doubtful') return this.avail.Doubtful;
    if (injuryStatus === 'Questionable') return (role && this.avail.roles?.Questionable?.[role]) || this.avail.Questionable;
    return this.avail.none;
  }

  /**
   * Chance a player who is healthy now plays `weeksAhead` weeks from now (injuries, benchings),
   * measured on 2020–25 starters. Season-long value uses this; lineup planning does not, because a
   * roster covers an injured starter from the bench.
   */
  healthyAhead(group: string, weeksAhead: number): number {
    const curve = this.avail.ahead?.[group];
    if (!curve?.length || weeksAhead <= 0) return this.avail.none;
    return curve[Math.min(weeksAhead, curve.length) - 1];
  }
}

function packForest(trees: readonly ExportedTree[]): PackedForest {
  const size = trees.reduce((n, t) => n + t.f.length, 0);
  const forest: PackedForest = {
    roots: new Int32Array(trees.length), feature: new Int16Array(size), threshold: new Float64Array(size),
    left: new Int32Array(size), right: new Int32Array(size), missingLeft: new Uint8Array(size), value: new Float64Array(size),
  };
  let offset = 0;
  trees.forEach((t, i) => {
    forest.roots[i] = offset;
    for (let n = 0; n < t.f.length; n++) {
      const at = offset + n;
      forest.feature[at] = t.f[n];
      forest.threshold[at] = t.t[n];
      forest.left[at] = t.l[n] + offset;
      forest.right[at] = t.r[n] + offset;
      forest.missingLeft[at] = t.m[n];
      forest.value[at] = t.v[n];
    }
    offset += t.f.length;
  });
  return forest;
}
