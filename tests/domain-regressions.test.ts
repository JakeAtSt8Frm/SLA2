import { describe, expect, it } from 'vitest';
import { optimizeLineup } from '../engine/optimizer.ts';
import { waiverRecommendations } from '../engine/waivers.ts';
import { simulateMatchup, simulateSeason } from '../engine/simulate.ts';
import type { WeekForecast } from '../engine/forecast.ts';
import type { PlayerInfo, Pos } from '../engine/types.ts';

const player = (id: string, eligible: Pos[]): PlayerInfo => ({
  id, name: id, pos: eligible[0], eligible, team: 'X', age: 25, birthDate: null,
  yearsExp: 3, injuryStatus: null, injuryBodyPart: null, injuryNotes: null, status: 'Active',
  depthOrder: 1, searchRank: 100, number: 1, college: null, newsUpdated: null,
});
const forecast = (id: string, expected: number, week: number): WeekForecast => ({
  id, week, mean: expected, play: 1, expected, provider: expected, floor: expected,
  median: expected, ceiling: expected, opponent: 'Y', home: true, kickoff: null, bye: false,
  residuals: new Array(21).fill(0), live: null,
});
const weekly = (week: number, values: Record<string, number>) =>
  new Map(Object.entries(values).map(([id, value]) => [id, forecast(id, value, week)]));
const waiverDefaults = {
  otherRosters: [], faabRemaining: 100, dynasty: new Map<string, number>(),
  trending: new Map<string, number>(), isLocked: () => false,
};

describe('legal waiver gains', () => {
  it('keeps an already-started player in his occupied slot when valuing a pickup', () => {
    const args = {
      ...waiverDefaults, roster: ['starter'], starters: ['starter'], rosterLimit: 2,
      slots: ['QB'], players: { starter: player('starter', ['QB']), pickup: player('pickup', ['QB']) },
      forecasts: new Map([[3, weekly(3, { starter: 30, pickup: 20 })], [4, weekly(4, { starter: 10, pickup: 20 })]]),
      weeks: [3, 4], currentWeek: 3, freeAgents: ['pickup'], isLocked: (id: string) => id === 'starter',
    };
    const [recommendation] = waiverRecommendations(args);
    expect(recommendation).toBeDefined();
    expect(recommendation.weekGain).toBe(0);
    expect(recommendation.startWeeks).toEqual([4]);
    expect(recommendation.netGain).toBeCloseTo(9.2);
  });

  it('finds a useful pickup that moves an incumbent through dual-position slots', () => {
    const [recommendation] = waiverRecommendations({
      ...waiverDefaults, roster: ['dual', 'dl'], rosterLimit: 3, slots: ['DL', 'LB'],
      players: { dual: player('dual', ['DL', 'LB']), dl: player('dl', ['DL']), pickup: player('pickup', ['LB']) },
      forecasts: new Map([[3, weekly(3, { dual: 20, dl: 10, pickup: 15 })]]),
      weeks: [3], currentWeek: 3, freeAgents: ['pickup'],
    });
    expect(recommendation).toBeDefined();
    expect(recommendation.weekGain).toBe(5);
  });

  it('considers dropping the incumbent the pickup replaces, even when his standalone loss is largest', () => {
    const players = Object.fromEntries((['QB', 'RB', 'WR', 'TE', 'DL'] as Pos[]).map(pos => [pos, player(pos, [pos])]));
    players.pickup = player('pickup', ['QB']);
    const [recommendation] = waiverRecommendations({
      ...waiverDefaults, roster: ['QB', 'RB', 'WR', 'TE', 'DL'], rosterLimit: 5,
      slots: ['QB', 'RB', 'WR', 'TE', 'DL'], players,
      forecasts: new Map([[3, weekly(3, { QB: 100, RB: 20, WR: 20, TE: 20, DL: 20, pickup: 110 })]]),
      weeks: [3], currentWeek: 3, freeAgents: ['pickup'],
    });
    expect(recommendation.dropId).toBe('QB');
    expect(recommendation.netGain).toBe(10);
  });
});

describe('lineup identities', () => {
  it('cannot start the same player twice when a roster contains duplicate IDs', () => {
    const result = optimizeLineup(['RB', 'FLEX'], [
      { id: 'one', eligible: ['RB'], value: 20 }, { id: 'one', eligible: ['RB'], value: 20 },
      { id: 'two', eligible: ['RB'], value: 10 },
    ]);
    expect(new Set(result.ids)).toEqual(new Set(['one', 'two']));
    expect(result.total).toBe(30);
  });
});

describe('settled matchup simulation', () => {
  it('keeps a normalized histogram when both teams have the same certain score', () => {
    const certain = { mean: 100, play: 1, residuals: new Array(21).fill(0) };
    const result = simulateMatchup([certain], [certain], 'tie', 100);
    expect(result.winProbA).toBe(0.5);
    expect(result.histogram.a.reduce((sum, n) => sum + n, 0)).toBeCloseTo(1);
    expect(result.histogram.b.reduce((sum, n) => sum + n, 0)).toBeCloseTo(1);
    expect(result.histogram.hi).toBeGreaterThan(result.histogram.lo);
  });

  it('splits a tied regular-season result instead of awarding the second team a win', () => {
    const result = simulateSeason({ teams: [1, 2], record: new Map(), remaining: [{ week: 3, a: 1, b: 2 }],
      dist: () => ({ mean: 100, sd: 0 }), playoffTeams: 2, playoffStart: 4,
      roundWeeks: 1, finalWeeks: 1, leverageWeek: 3, sims: 10 });
    expect(result.teams.map(t => t.meanWins)).toEqual([0.5, 0.5]);
    expect(result.gameWinProb.get('3:1:2')).toBe(0.5);
  });

  it('gives only the first seed a bye in a three-team playoff', () => {
    const result = simulateSeason({ teams: [1, 2, 3],
      record: new Map([1, 2, 3].map(id => [id, { wins: 4 - id, losses: id, ties: 0, pointsFor: 100 }])),
      remaining: [], dist: () => ({ mean: 100, sd: 0 }), playoffTeams: 3, playoffStart: 4,
      roundWeeks: 1, finalWeeks: 1, leverageWeek: 3, sims: 10 });
    expect(result.teams.map(t => t.byePct)).toEqual([1, 0, 0]);
  });
});
