import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FeatureState } from '../engine/features.ts';
import { pregameForecast, replayForecast, withLiveState, type ForecastEnv } from '../engine/forecast.ts';
import { ProjectionModel, type ModelFile } from '../engine/model.ts';
import { compileScoring } from '../engine/scoring.ts';
import { evaluateTrade, TradeError, type TradeKit } from '../engine/trade.ts';
import type { NflGame, PlayerInfo, Pos } from '../engine/types.ts';
import { staticUrl } from '../web/src/lib/api.ts';
import { applyLive, type LiveWeek } from '../web/src/lib/live-score.ts';
import type { Game } from '../web/src/lib/api.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('static deployment', () => {
  it('maps every API route the app reads to a prebuilt file', () => {
    const v = (url: string) => staticUrl(url)?.replace(/\?.*$/, '');
    expect(v('/api/leagues')).toBe('/data/leagues.json');
    expect(v('/api/model')).toBe('/data/model.json');
    expect(staticUrl('/api/leagues/123/bootstrap')).toMatch(/^\/data\/123\/bootstrap\.json\?t=\d+$/);
    expect(v('/api/leagues/123/overview')).toBe('/data/123/overview.json');
    expect(v('/api/leagues/123/matchups')).toBe('/data/123/matchups.json');
    expect(v('/api/leagues/123/matchups?week=7')).toBe('/data/123/matchups-7.json');
    expect(v('/api/leagues/123/defense?season=2025')).toBe('/data/123/defense-2025.json');
    expect(v('/api/leagues/espn-390483100/teams/4')).toBe('/data/espn-390483100/team-4.json');
    expect(v('/api/leagues/123/teams/4/lineup')).toBe('/data/123/lineup-4.json');
    expect(v('/api/leagues/123/teams/4/waivers')).toBe('/data/123/waivers-4.json');
    expect(v('/api/leagues/123/players/4046')).toBe('/data/123/players/4046.json');
    expect(v('/api/leagues/123/trade-kit')).toBe('/data/123/trade-kit.json');
    // Needs a live server: searching Sleeper for any user's leagues.
    expect(staticUrl('/api/users/someone/leagues')).toBeNull();
  });
});

describe('live scoring between builds', () => {
  const scoring = compileScoring({ rec: 1, rec_yd: 0.1, rec_td: 6 });
  const player = (id: string, team: string, kickoff: number, dist: { mean: number; sd: number; play: number } | null, points = 0) => ({
    slot: 'WR', id, name: id, pos: 'WR', team, points, pregame: dist ? dist.mean : null, dist,
    forecast: { week: 6, exp: dist?.mean ?? 0, mean: dist?.mean ?? 0, play: 1, floor: 0, median: 0, ceiling: 0, provider: null, opp: null, home: null, kickoff, bye: false, live: null, boom: 0, bust: 0 },
  });
  const now = Date.UTC(2026, 9, 18, 19, 0);
  const hour = 3600_000;
  const game = {
    matchupId: 1, final: false, winProbA: 0.5, optimizedWinProbA: null, range: null,
    a: { rosterId: 1, points: 0, projected: 30, optimal: null, pregame: 30, bench: [], lineup: [player('done', 'AAA', now - 4 * hour, { mean: 15, sd: 6, play: 1 }), player('playing', 'BBB', now - hour, { mean: 15, sd: 6, play: 1 })] },
    b: { rosterId: 2, points: 0, projected: 30, optimal: null, pregame: 30, bench: [], lineup: [player('later', 'CCC', now + 3 * hour, { mean: 15, sd: 6, play: 0.9 }), player('later2', 'CCC', now + 3 * hour, { mean: 15, sd: 6, play: 1 })] },
  } as unknown as Game;
  const live: LiveWeek = {
    lines: new Map<string, Record<string, number>>([['done', { rec: 8, rec_yd: 120, rec_td: 1 }], ['playing', { rec: 3, rec_yd: 30 }]]),
    status: new Map([['AAA', 'complete'], ['BBB', 'in_game'], ['CCC', 'pre_game']]),
    at: now,
  };

  it('scores starters with the league rules and projects what is left of each game', () => {
    const out = applyLive(game, live, scoring, now);
    expect(out.a.lineup[0].points).toBeCloseTo(26);
    expect(out.a.lineup[1].points).toBeCloseTo(6);
    expect(out.a.points).toBeCloseTo(32);
    // 26 final + 6 so far + 15 × (1 − 60/185) still to come.
    expect(out.a.projected).toBeCloseTo(26 + 6 + 15 * (1 - 60 / 185), 1);
    expect(out.b?.points).toBe(0);
    expect(out.b?.projected).toBeCloseTo(0.9 * 15 + 15, 1);
    expect(out.a.lineup[0].forecast?.live).toEqual({ status: 'complete', points: 26 });
    expect(out.winProbA).toBeGreaterThan(0.5);
    expect(out.winProbA).toBeLessThan(1);
  });

  it('leaves final weeks alone', () => {
    const final = { ...game, final: true } as Game;
    expect(applyLive(final, live, scoring, now)).toBe(final);
  });

  it('updates score ranges with live totals and drops obsolete optimal-lineup odds', () => {
    const stale = { ...game, optimizedWinProbA: 0.9 };
    const out = applyLive(stale, live, scoring, now);
    expect(out.range).not.toBeNull();
    expect(out.range?.a[1]).toBe(out.a.projected);
    expect(out.range?.b[1]).toBe(out.b?.projected);
    expect(out.range?.histogram.a.reduce((sum, n) => sum + n, 0)).toBeCloseTo(1, 3);
    expect(out.optimizedWinProbA).toBeNull();
  });

  it('uses kickoff when the browser schedule status lags, preserving points already scored', () => {
    const lagging = { ...live, status: new Map(live.status).set('BBB', 'pre_game' as const) };
    const out = applyLive(game, lagging, scoring, now);
    expect(out.a.lineup[1].points).toBe(6);
    expect(out.a.lineup[1].forecast?.live?.status).toBe('in_game');
  });
});

describe('trade evaluation kit', () => {
  const kit: TradeKit = {
    weeks: [6, 7], slots: ['QB', 'WR'], lastRegularWeek: 7,
    season: { playoffTeams: 2, playoffStart: 8, roundWeeks: 1, finalWeeks: 1, leverageWeek: 6, seed: 'test', sims: 2000 },
    teams: [
      { rosterId: 1, roster: ['qa', 'wa', 'wa2'], active: ['qa', 'wa', 'wa2'], record: { wins: 3, losses: 2, ties: 0, pointsFor: 500 }, factor: 1 },
      { rosterId: 2, roster: ['qb', 'wb'], active: ['qb', 'wb'], record: { wins: 2, losses: 3, ties: 0, pointsFor: 480 }, factor: 1 },
    ],
    remaining: [{ week: 6, a: 1, b: 2 }, { week: 7, a: 1, b: 2 }],
    dists: { '1:6': [40, 8], '1:7': [40, 8], '2:6': [30, 8], '2:7': [30, 8] },
    players: {
      qa: { eligible: ['QB'], value: 20, dynasty: 20, name: 'QA', weeks: [[20, 30], [20, 30]] },
      wa: { eligible: ['WR'], value: 18, dynasty: 18, name: 'WA', weeks: [[20, 40], [20, 40]] },
      wa2: { eligible: ['WR'], value: 8, dynasty: 8, name: 'WA2', weeks: [[8, 20], [8, 20]] },
      qb: { eligible: ['QB'], value: 15, dynasty: 15, name: 'QB', weeks: [[15, 30], [15, 30]] },
      wb: { eligible: ['WR'], value: 15, dynasty: 15, name: 'WB', weeks: [[15, 40], [15, 40]] },
    },
    before: { 1: { playoffPct: 1, champPct: 0.6 }, 2: { playoffPct: 1, champPct: 0.4 } },
  };

  it('re-optimizes both rosters every remaining week', () => {
    const r = evaluateTrade(kit, { a: 1, b: 2, aGives: ['wa'], bGives: ['wb'] });
    // Team 1 starts WB (15) instead of WA (20) both weeks; team 2 the reverse.
    expect(r.a.rosDelta).toBeCloseTo(-10);
    expect(r.b.rosDelta).toBeCloseTo(10);
    expect(r.a.newStarters).toEqual(['WB']);
    expect(r.a.oddsAfter.champPct).toBeLessThan(0.6);
    expect(r.verdict).toBe('b');
  });

  it('rejects trades the rosters cannot make', () => {
    expect(() => evaluateTrade(kit, { a: 1, b: 2, aGives: ['wb'], bGives: [] })).toThrow(TradeError);
    expect(() => evaluateTrade(kit, { a: 1, b: 1, aGives: ['wa'], bGives: [] })).toThrow(TradeError);
    expect(() => evaluateTrade(kit, { a: 1, b: 2, aGives: [], bGives: [] })).toThrow(TradeError);
  });

  it('counts the settled current week when a trade takes effect next week', () => {
    const nextWeek: TradeKit = {
      ...kit, weeks: [7],
      teams: kit.teams.map(t => ({ ...t, record: { wins: 0, losses: 0, ties: 0, pointsFor: t.rosterId } })),
      season: { ...kit.season, playoffTeams: 1 },
      remaining: [{ week: 6, a: 1, b: 2 }],
      dists: { ...kit.dists, '1:6': [150, 0], '2:6': [147, 0] },
      players: Object.fromEntries(Object.entries(kit.players).map(([id, p]) => [id, { ...p, weeks: p.weeks.slice(1) }])),
    };
    const result = evaluateTrade(nextWeek, { a: 1, b: 2, aGives: ['wa'], bGives: ['wb'] });
    expect(result.a.oddsAfter.playoffPct).toBe(1);
    expect(result.b.oddsAfter.playoffPct).toBe(0);
    expect(result.a.byWeek.map(w => w.week)).toEqual([7]);
  });
});

describe('pregame replay of a past week', () => {
  const model = new ProjectionModel(JSON.parse(readFileSync(path.join(ROOT, 'model/model.json'), 'utf8')) as ModelFile);
  const scoring = compileScoring({ rec: 1, rec_yd: 0.1 });
  const info: PlayerInfo = { id: 'p', name: 'P', pos: 'WR' as Pos, eligible: ['WR'], team: 'AAA', age: 25, birthDate: '2001-01-01', yearsExp: 3, injuryStatus: 'Out', injuryBodyPart: null, injuryNotes: null, status: 'Active', depthOrder: 1, searchRank: 1, number: 1, college: null, newsUpdated: null, espnId: null };
  const game: NflGame = { id: 'g', season: 2026, week: 3, home: 'AAA', away: 'BBB', kickoff: 0, spreadLine: 3, totalLine: 45, homeScore: null, awayScore: null, roof: null, homeRest: 7, awayRest: 7, divGame: false };
  const state = new FeatureState(scoring, () => ({ pos: 'WR', birthDate: info.birthDate, yearsExp: 3 }));
  state.startSeason(2026);
  for (const w of [1, 2]) state.ingestWeek(2026, w, [{ id: 'p', team: 'AAA', opponent: 'BBB', stats: { gp: 1, off_snp: 60, tm_off_snp: 65, rec: 6, rec_yd: 70, rec_tgt: 8 } }]);
  const env: ForecastEnv = {
    model, state, season: 2026, currentWeek: 3, players: { p: info }, scoring, gameFor: (t, w) => (w === 3 && (t === 'AAA' || t === 'BBB') ? game : undefined),
    projections: w => (w === 3 ? new Map([['p', { team: 'AAA', stats: { gp: 1, rec: 5, rec_yd: 60 } }]]) : undefined), now: 0,
  };

  it("ignores today's injury tag, which wasn't known before that game", () => {
    expect(pregameForecast(env, 'p', 3).play).toBe(0);
    const replay = replayForecast(env, 'p', 3, 'AAA')!;
    expect(replay.mean).toBeGreaterThan(5);
    expect(replay.exp).toBeCloseTo(replay.mean * model.playProbability(null, true));
    expect(replay.provider).toBeCloseTo(11);
  });

  it('preserves negative final scores across the whole forecast range', () => {
    const finalEnv: ForecastEnv = { ...env, scoring: compileScoring({ rec: -2 }),
      gameStatus: () => 'complete', liveStats: new Map([['p', { gp: 1, rec: 6 }]]) };
    const result = withLiveState(finalEnv, pregameForecast(finalEnv, 'p', 3));
    expect(result.expected).toBe(-12);
    expect([result.floor, result.median, result.ceiling]).toEqual([-12, -12, -12]);
  });
});

describe('lineups set in Sleeper after a build', () => {
  it('names the rosters whose starters changed, ignoring order and empty slots', async () => {
    const { changedLineups } = await import('../web/src/lib/live-score.ts');
    const published = new Map<number, (string | null)[]>([[1, ['a', 'b', null]], [2, ['c', 'd']], [3, ['e']]]);
    const live = new Map<number, string[]>([[1, ['b', 'a']], [2, ['c', 'x']], [4, ['z']]]);
    expect(changedLineups(published, live)).toEqual([2]);
    expect(changedLineups(published, new Map([[1, ['a', 'b', 'f']]]))).toEqual([1]);
  });
});
