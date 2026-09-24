/** Player outcome distributions: a point mass at zero (doesn't play) mixed with an empirical residual curve. */

export interface Outcome {
  /** E[points | plays] */
  mean: number;
  /** P(plays) */
  play: number;
  /** Zero-mean residual quantiles at 0%, 5%, …, 100% (21 points). */
  residuals: readonly number[];
}

/** Deterministic PRNG so simulations are stable between refreshes. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function interp(table: readonly number[], u: number): number {
  const x = Math.min(0.999999, Math.max(0, u)) * (table.length - 1);
  const i = Math.floor(x);
  return table[i] + (table[Math.min(i + 1, table.length - 1)] - table[i]) * (x - i);
}

export function sample(o: Outcome, rand: () => number): number {
  if (rand() >= o.play) return 0;
  return o.mean + interp(o.residuals, rand());
}

export function expected(o: Outcome): number {
  return o.play * o.mean;
}

/** Variance of the zero-inflated mixture. */
export function variance(o: Outcome): number {
  const r = o.residuals;
  let m2 = 0;
  for (let i = 0; i < r.length - 1; i++) m2 += (r[i] * r[i] + r[i + 1] * r[i + 1]) / 2;
  m2 /= r.length - 1;
  const conditional = m2 + o.mean * o.mean;
  return Math.max(0, o.play * conditional - (o.play * o.mean) ** 2);
}

/** Quantile of the mixture (DNP mass at 0 plus the conditional curve). */
export function mixtureQuantile(o: Outcome, q: number): number {
  const miss = 1 - o.play;
  if (o.play <= 0) return 0;
  // Values below zero only occur when playing; treat the DNP mass as sitting at exactly 0.
  const belowZeroShare = zeroCdf(o);
  const pZeroOrLess = o.play * belowZeroShare + miss;
  if (q < o.play * belowZeroShare) return o.mean + interp(o.residuals, q / o.play);
  if (q <= pZeroOrLess) return 0;
  return o.mean + interp(o.residuals, (q - miss) / o.play);
}

function zeroCdf(o: Outcome): number {
  // P(mean + r <= 0) from the residual table.
  const target = -o.mean;
  const r = o.residuals;
  if (target <= r[0]) return 0;
  if (target >= r[r.length - 1]) return 1;
  for (let i = 0; i < r.length - 1; i++) {
    if (target <= r[i + 1]) {
      const span = r[i + 1] - r[i];
      const frac = span > 0 ? (target - r[i]) / span : 0;
      return (i + frac) / (r.length - 1);
    }
  }
  return 1;
}

/** P(outcome >= threshold). */
export function exceedProbability(o: Outcome, threshold: number): number {
  if (threshold <= 0) return 1;
  const r = o.residuals;
  const target = threshold - o.mean;
  if (target <= r[0]) return o.play;
  if (target >= r[r.length - 1]) return 0;
  for (let i = 0; i < r.length - 1; i++) {
    if (target <= r[i + 1]) {
      const span = r[i + 1] - r[i];
      const frac = span > 0 ? (target - r[i]) / span : 0;
      return o.play * (1 - (i + frac) / (r.length - 1));
    }
  }
  return 0;
}

/** P(A outscores B) by simulation — for close start/sit calls. */
export function headToHead(a: Outcome, b: Outcome, seed = 1, n = 4000): number {
  const rand = mulberry32(seed);
  let wins = 0;
  for (let i = 0; i < n; i++) {
    const x = sample(a, rand), y = sample(b, rand);
    if (x > y) wins++;
    else if (x === y) wins += 0.5;
  }
  return wins / n;
}

/** Standard normal CDF (Abramowitz–Stegun). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** Box–Muller normal draw. */
export function normal(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}
