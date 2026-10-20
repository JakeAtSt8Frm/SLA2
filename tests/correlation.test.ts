import { describe, expect, it } from 'vitest';
import { sample, type Outcome } from '../engine/distribution.ts';
import { corrLoad, DEFAULT_CORRELATION, simulateMatchup, type CorrGroup } from '../engine/simulate.ts';
import { adviseLineup, lineupStats, opponentEntries } from '../engine/lineup.ts';
import type { WeekForecast } from '../engine/forecast.ts';
import type { PlayerInfo } from '../engine/types.ts';

/** A constant outcome: plays for sure with zero-mean residuals, so every sample equals `mean`. */
const fixedOutcome = (mean: number): Outcome => ({ mean, play: 1, residuals: new Array(21).fill(0) });

describe('game-environment correlation', () => {
  const a = [fixedOutcome(15), fixedOutcome(12), fixedOutcome(10)];
  const b = [fixedOutcome(10), fixedOutcome(8), fixedOutcome(6)];
  const noGroups = { a: [null, null, null] as (CorrGroup | null)[], b: [null, null, null] as (CorrGroup | null)[] };

  it('leaves results unchanged when no groups are supplied', () => {
    const plain = simulateMatchup(a, b, 'plain', 4000);
    const empty = simulateMatchup(a, b, 'plain', 4000, noGroups);
    expect(empty.winProbA).toBe(plain.winProbA);
    expect(empty.a.p90).toBe(plain.a.p90);
  });

  it('widens a lineup whose starters share an NFL team', () => {
    const gA: CorrGroup = { team: 'KC', game: 'g1', load: 1 };
    const r = simulateMatchup(a, b, 'grp', 20000, { a: [gA, gA, gA], b: noGroups.b });
    // Constant outcomes otherwise: the whole spread is the shared shock (≈ ±1.28·σ_team).
    expect(r.a.p90 - r.a.p10).toBeGreaterThan(4);
    const independent = simulateMatchup(a, b, 'grp', 20000, noGroups);
    expect(independent.a.p90 - independent.a.p10).toBe(0);
  });

  it('co-moves opposing sides through a shared game without a team link', () => {
    const g = (team: string, game: string): CorrGroup => ({ team, game, load: 1 });
    const shared = simulateMatchup(a, b, 'game', 20000, { a: [g('KC', 'g2'), null, null], b: [g('NE', 'g2'), null, null] });
    const apart = simulateMatchup(a, b, 'game', 20000, { a: [g('KC', 'g2'), null, null], b: [g('NE', 'g9'), null, null] });
    expect(shared.winProbA).not.toBe(apart.winProbA);
    expect(shared.winProbA).toBeGreaterThan(0.9); // the favourite still wins almost always
  });

  it('slightly cuts the favourite win odds when his starters share a team', () => {
    const strong = simulateMatchup(a, b, 'strong', 20000, { a: [{ team: 'BUF', game: 'g3', load: 1 }, { team: 'BUF', game: 'g3', load: 1 }, null], b: noGroups.b });
    const base = simulateMatchup(a, b, 'strong', 20000, noGroups);
    expect(strong.winProbA).toBeLessThan(1.0001);
    expect(strong.winProbA).toBeGreaterThan(0.75);
    expect(base.winProbA).toBeGreaterThan(strong.winProbA - 0.001); // more variance, never a boost to certainty
  });

  it('lineupStats widens sd exactly by the shared covariance terms', () => {
    const slots = ['SUPER_FLEX', 'FLEX', 'WR'];
    const forecasts: Map<string, WeekForecast> = new Map(a.map((o, i) => [`p${i}`, { id: `p${i}`, week: 1, mean: o.mean, play: 1, rosPlay: 1, expected: o.mean, provider: null, floor: 0, median: 0, ceiling: 0, opponent: null, home: null, kickoff: null, bye: false, residuals: o.residuals.slice(), live: null }]));
    const { teamSd, gameSd } = DEFAULT_CORRELATION;
    // Constant outcomes carry no own variance, so any spread is the shared shock.
    expect(lineupStats(slots, ['p0', 'p1', 'p2'], forecasts).sd).toBe(0);
    const grouped = lineupStats(slots, ['p0', 'p1', 'p2'], forecasts, [{ team: 'BUF', game: 'g4', load: 1 }, { team: 'BUF', game: 'g4', load: 1 }, null]);
    expect(grouped.sd ** 2).toBeCloseTo(2 * (teamSd ** 2 + gameSd ** 2), 6);
    // Same team, different games: only the team term.
    const teamOnly = lineupStats(slots, ['p0', 'p1'], forecasts, [{ team: 'BUF', game: 'g4', load: 1 }, { team: 'BUF', game: 'g5', load: 1 }]);
    expect(teamOnly.sd ** 2).toBeCloseTo(2 * teamSd ** 2, 6);
    // Different teams, different games: no covariance.
    const apart = lineupStats(slots, ['p0', 'p1'], forecasts, [{ team: 'BUF', game: 'g4', load: 1 }, { team: 'NE', game: 'g8', load: 1 }]);
    expect(apart.sd).toBe(0);
  });

  it('respects the position loading order', () => {
    expect(corrLoad('QB')).toBeGreaterThan(corrLoad('WR'));
    expect(corrLoad('DEF')).toBe(1);
    expect(corrLoad('DB')).toBeLessThan(corrLoad('RB'));
  });

  it('samples still work with mixed zero-probability outcomes', () => {
    const rand = () => 0.999; // above every play probability: everything sits out
    expect(sample({ mean: 0, play: 0, residuals: new Array(21).fill(0) }, rand)).toBe(0);
  });
});

describe('win-odds chase', () => {
  const wf = (id: string, mean: number, residuals: number[]): WeekForecast => ({ id, week: 1, mean, play: 1, rosPlay: 1, expected: mean, provider: null, floor: 0, median: 0, ceiling: 0, opponent: null, home: null, kickoff: null, bye: false, residuals, live: null });
  const boom = Array.from({ length: 21 }, (_, k) => -9 + 18 * (k / 20)); // mean 10, sd ≈ 5.2
  const forecasts: Map<string, WeekForecast> = new Map([
    ['pA', wf('pA', 15, new Array(21).fill(0))],
    ['pB', wf('pB', 10, boom)],
    ['oX', wf('oX', 17, new Array(21).fill(0))], // monster opponent
    ['oY', wf('oY', 5, new Array(21).fill(0))], // winnable opponent
  ]);
  const player = (id: string): PlayerInfo => ({ id, name: id.toUpperCase(), pos: 'QB', eligible: ['QB'], team: null, age: null, birthDate: null, yearsExp: null, injuryStatus: null, injuryBodyPart: null, injuryNotes: null, status: null, depthOrder: null, searchRank: null, number: null, college: null, newsUpdated: null });
  const players = { pA: player('pA'), pB: player('pB') };
  const call = (oppId: string) => adviseLineup(['QB'], ['pA'], ['pA', 'pB'], players, forecasts, () => false, undefined, opponentEntries([oppId], forecasts));

  it('swings for the upside play when a monster opponent needs chasing', () => {
    const adv = call('oX');
    expect(adv.optimal.ids).toEqual(['pA']); // points pick the steady QB…
    expect(adv.winMax?.ids).toEqual(['pB']); // …but only the boom swing can beat 17
  });

  it('keeps the floor pick when the matchup is already in hand', () => {
    const adv = call('oY');
    expect(adv.optimal.ids).toEqual(['pA']);
    expect(adv.winMax?.ids).toEqual(['pA']); // chasing variance only donates wins
  });

  it('returns no chase lineup without an opponent', () => {
    expect(adviseLineup(['QB'], ['pA'], ['pA', 'pB'], players, forecasts, () => false).winMax).toBeNull();
  });
});
