import { describe, expect, it } from 'vitest';
import { exceedProbability, mixtureQuantile, variance, type Outcome } from '../engine/distribution.ts';

describe('score distribution boundaries', () => {
  const defense: Outcome = { mean: 0, play: 0.8, residuals: [-10, 10] };

  it('includes DNP at zero without treating all negative scores as successes', () => {
    expect(exceedProbability(defense, 0)).toBeCloseTo(0.6);
    expect(exceedProbability(defense, -5)).toBeCloseTo(0.8);
    expect(exceedProbability(defense, 5)).toBeCloseTo(0.2);
  });

  it('counts exact-score outcomes at the threshold, including a flat upper tail', () => {
    expect(exceedProbability({ mean: 10, play: 0.75, residuals: [0, 0, 0] }, 10)).toBe(0.75);
    expect(exceedProbability({ mean: 0, play: 1, residuals: [-10, 5, 5] }, 5)).toBe(0.5);
    expect(exceedProbability({ mean: -5, play: 1, residuals: [0, 0] }, -4)).toBe(0);
  });

  it('integrates the same piecewise linear distribution used by the sampler', () => {
    expect(variance({ mean: 0, play: 1, residuals: [-10, 10] })).toBeCloseTo(100 / 3);
    expect(variance({ mean: 10, play: 0.5, residuals: [-10, 10] })).toBeCloseTo(125 / 3);
  });

  it('does not invent zero at the lower endpoint of an always-active positive score', () => {
    expect(mixtureQuantile({ mean: 10, play: 1, residuals: [0, 0] }, 0)).toBe(10);
    expect(mixtureQuantile({ mean: -10, play: 1, residuals: [0, 0] }, 1)).toBe(-10);
    expect(mixtureQuantile({ mean: 10, play: 0, residuals: [0, 0] }, 1)).toBe(0);
  });
});
