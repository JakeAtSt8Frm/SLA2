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
  availability: { none: number; Questionable: number; Doubtful: number; Out: number };
}

interface PackedTree { f: Int16Array; t: Float64Array; l: Int32Array; r: Int32Array; m: Uint8Array; v: Float64Array }

const IDX = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, i])) as Record<string, number>;

/** Sleeper injury_status values that mean the player will not suit up. */
const OUT_STATUSES = new Set(['Out', 'IR', 'PUP', 'Sus', 'Suspended', 'NA', 'DNR', 'COV', 'NFI', 'Inactive']);

export class ProjectionModel {
  readonly meta: ModelFile['meta'];
  private trees: PackedTree[];
  private baseline: number;
  private columns: Int32Array;
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
    this.trees = file.points.trees.map(t => ({
      f: Int16Array.from(t.f), t: Float64Array.from(t.t), l: Int32Array.from(t.l), r: Int32Array.from(t.r), m: Uint8Array.from(t.m), v: Float64Array.from(t.v),
    }));
  }

  /** Expected league points if the player takes the field. */
  predict(x: Float64Array): number {
    const cols = this.columns;
    let out = this.baseline;
    for (const tree of this.trees) {
      let node = 0;
      while (tree.f[node] !== -1) {
        const value = x[cols[tree.f[node]]];
        const left = value !== value ? tree.m[node] === 1 : value <= tree.t[node];
        node = left ? tree.l[node] : tree.r[node];
      }
      out += tree.v[node];
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
  playProbability(injuryStatus: string | null, onNflRoster: boolean): number {
    if (!onNflRoster) return 0;
    if (!injuryStatus) return this.avail.none;
    if (OUT_STATUSES.has(injuryStatus)) return 0;
    if (injuryStatus === 'Doubtful') return this.avail.Doubtful;
    if (injuryStatus === 'Questionable') return this.avail.Questionable;
    return this.avail.none;
  }
}
