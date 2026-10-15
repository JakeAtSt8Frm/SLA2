import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileScoring, completeStats, scoreStats } from '../engine/scoring.ts';
import { optimizeLineup, type LineupCandidate } from '../engine/optimizer.ts';
import { adviseLineup } from '../engine/lineup.ts';
import { canFill } from '../engine/positions.ts';
import { exceedProbability, mixtureQuantile, mulberry32, sample, type Outcome } from '../engine/distribution.ts';
import { simulateSeason } from '../engine/simulate.ts';
import { FeatureState, FEATURE_NAMES } from '../engine/features.ts';
import { ProjectionModel, type ModelFile } from '../engine/model.ts';
import { ageCurve } from '../engine/values.ts';
import type { PlayerInfo, Pos } from '../engine/types.ts';
import type { WeekForecast } from '../engine/forecast.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('scoring', () => {
  const fixture = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/scoring-parity.json'), 'utf8')) as {
    scoring: Record<string, number>; rows: { pos: string; stats: Record<string, number>; official: number }[];
  };
  const scoring = compileScoring(fixture.scoring);

  it('reproduces Sleeper official player points exactly for every position', () => {
    expect(fixture.rows.length).toBeGreaterThan(80);
    for (const row of fixture.rows) expect(scoreStats(row.stats, scoring)).toBeCloseTo(row.official, 2);
  });

  it('adds the TE reception premium to projections only when the source omits it', () => {
    const projected = completeStats({ rec: 5, rec_yd: 50 }, 'TE');
    expect(projected.bonus_rec_te).toBe(5);
    const already = completeStats({ rec: 5, bonus_rec_te: 5 }, 'TE');
    expect(scoreStats(already, scoring)).toBe(scoreStats({ rec: 5, bonus_rec_te: 5 }, scoring));
    expect(completeStats({ rec: 5 }, 'WR').bonus_rec_te).toBeUndefined();
  });

  it('derives missed field goals and extra points for kicker projections', () => {
    const k = completeStats({ fga: 3, fgm: 2, xpa: 3, xpm: 3 }, 'K');
    expect(k.fgmiss).toBe(1);
    expect(k.xpmiss).toBe(0);
  });
});

describe('lineup optimizer', () => {
  const pos: Pos[] = ['QB', 'RB', 'WR', 'TE', 'DL', 'LB'];
  const slots = ['QB', 'RB', 'WR', 'TE', 'SUPER_FLEX', 'FLEX', 'DL', 'LB'];

  function brute(cands: LineupCandidate[]): number {
    let best = -Infinity;
    const used = new Set<number>();
    const go = (i: number, total: number) => {
      if (i === slots.length) { best = Math.max(best, total); return; }
      let placed = false;
      cands.forEach((c, j) => {
        if (used.has(j) || !canFill(c.eligible, slots[i])) return;
        placed = true;
        used.add(j);
        go(i + 1, total + c.value);
        used.delete(j);
      });
      if (!placed) go(i + 1, total);
    };
    go(0, 0);
    return best;
  }

  it('matches brute force on random rosters with flex and superflex slots', () => {
    const rand = mulberry32(42);
    for (let trial = 0; trial < 60; trial++) {
      const cands: LineupCandidate[] = Array.from({ length: 11 }, (_, i) => ({ id: String(i), eligible: [pos[Math.floor(rand() * pos.length)]], value: Math.round(rand() * 250) / 10 }));
      const result = optimizeLineup(slots, cands);
      expect(result.total).toBeCloseTo(brute(cands), 6);
      const ids = result.ids.filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
      result.ids.forEach((id, i) => { if (id) expect(canFill(cands[Number(id)].eligible, slots[i])).toBe(true); });
    }
  });

  it('honours locked slots', () => {
    const cands: LineupCandidate[] = [
      { id: 'a', eligible: ['RB'], value: 5 },
      { id: 'b', eligible: ['RB'], value: 20 },
      { id: 'c', eligible: ['WR'], value: 10 },
    ];
    const r = optimizeLineup(['RB', 'FLEX'], cands, new Map([[0, 'a']]));
    expect(r.ids[0]).toBe('a');
    expect(r.ids[1]).toBe('b');
  });
});

function forecast(id: string, expected: number): WeekForecast {
  return { id, week: 3, mean: expected, play: 1, rosPlay: 1, expected, provider: expected, floor: 0, median: expected, ceiling: expected, opponent: 'X', home: true, kickoff: 0, bye: false, residuals: new Array(21).fill(0), live: null };
}
const info = (id: string, p: Pos): PlayerInfo => ({ id, name: id, pos: p, eligible: [p], team: 'X', age: 25, birthDate: null, yearsExp: 3, injuryStatus: null, injuryBodyPart: null, injuryNotes: null, status: 'Active', depthOrder: 1, searchRank: 100, number: 1, college: null, newsUpdated: null });

describe('start/sit advice', () => {
  const players = { a: info('a', 'RB'), b: info('b', 'RB'), c: info('c', 'RB'), d: info('d', 'RB') };
  const f = new Map([['a', forecast('a', 10)], ['b', forecast('b', 8)], ['c', forecast('c', 15)], ['d', forecast('d', 12)]]);

  it('recommends swapping in better bench players and pairs the swap correctly', () => {
    const adv = adviseLineup(['RB', 'RB'], ['a', 'b'], ['a', 'b', 'c', 'd'], players, f, () => false);
    expect(new Set(adv.optimal.ids)).toEqual(new Set(['c', 'd']));
    expect(adv.gain).toBeCloseTo(9);
    expect(adv.swaps).toHaveLength(2);
  });

  it('never benches a locked starter or starts a locked bench player', () => {
    const locked = new Set(['b', 'c']);
    const adv = adviseLineup(['RB', 'RB'], ['a', 'b'], ['a', 'b', 'c', 'd'], players, f, id => locked.has(id));
    expect(adv.optimal.ids).toContain('b');
    expect(adv.optimal.ids).not.toContain('c');
    expect(adv.optimal.ids).toContain('d');
  });

  it('keeps unchanged starters in their current slot', () => {
    const adv = adviseLineup(['RB', 'RB'], ['d', 'a'], ['a', 'b', 'c', 'd'], players, f, () => false);
    expect(adv.optimal.ids[0]).toBe('d');
    expect(adv.optimal.ids[1]).toBe('c');
  });
});

describe('outcome distributions', () => {
  const o: Outcome = { mean: 12, play: 0.7, residuals: Array.from({ length: 21 }, (_, i) => -8 + i * 0.8) };
  it('has monotone quantiles including the did-not-play mass at zero', () => {
    let prev = -Infinity;
    for (let q = 0; q <= 1; q += 0.05) {
      const v = mixtureQuantile(o, q);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
    expect(mixtureQuantile(o, 0.2)).toBe(0);
  });
  it('agrees with sampling for exceedance probabilities', () => {
    const rand = mulberry32(1);
    let hits = 0;
    const n = 40000;
    for (let i = 0; i < n; i++) if (sample(o, rand) >= 15) hits++;
    expect(hits / n).toBeCloseTo(exceedProbability(o, 15), 1);
  });
});

describe('season simulation', () => {
  it('produces coherent playoff and title probabilities', () => {
    const teams = [1, 2, 3, 4, 5, 6];
    const remaining = [] as { week: number; a: number; b: number }[];
    for (let w = 3; w <= 13; w++) remaining.push({ week: w, a: 1, b: 2 }, { week: w, a: 3, b: 4 }, { week: w, a: 5, b: 6 });
    const sim = simulateSeason({
      teams, record: new Map(teams.map(t => [t, { wins: 1, losses: 1, ties: 0, pointsFor: 200 }])), remaining,
      dist: rid => ({ mean: 200 + rid * 5, sd: 30 }), playoffTeams: 4, playoffStart: 14, roundWeeks: 2, finalWeeks: 2, leverageWeek: 3, sims: 4000,
    });
    const sum = (k: 'playoffPct' | 'champPct' | 'firstSeedPct') => sim.teams.reduce((a, t) => a + t[k], 0);
    expect(sum('playoffPct')).toBeCloseTo(4, 5);
    expect(sum('champPct')).toBeCloseTo(1, 5);
    expect(sum('firstSeedPct')).toBeCloseTo(1, 5);
    const byId = new Map(sim.teams.map(t => [t.rosterId, t]));
    expect(byId.get(6)!.playoffPct).toBeGreaterThan(byId.get(1)!.playoffPct);
    for (const t of sim.teams) if (t.ifWinPlayoffPct !== null && t.ifLosePlayoffPct !== null) expect(t.ifWinPlayoffPct).toBeGreaterThanOrEqual(t.ifLosePlayoffPct);
  });
});

describe('features', () => {
  it('only use games before the target week', () => {
    const meta = () => ({ pos: 'WR' as Pos, birthDate: '2000-01-01', yearsExp: 3 });
    const scoring = compileScoring({ rec: 1, rec_yd: 0.1 });
    const fs = new FeatureState(scoring, meta);
    fs.startSeason(2025);
    for (let w = 1; w <= 3; w++) fs.ingestWeek(2025, w, [{ id: 'p', team: 'X', opponent: 'Y', stats: { gp: 1, off_snp: 50, tm_off_snp: 60, rec: w, rec_yd: 10 * w } }]);
    const idx = (name: string) => FEATURE_NAMES.indexOf(name as (typeof FEATURE_NAMES)[number]);
    const x = fs.features('p', 2025, 2, undefined, undefined, 'X');
    expect(x[idx('n_cur')]).toBe(1);
    expect(x[idx('last1')]).toBeCloseTo(2);
    const x4 = fs.features('p', 2025, 4, undefined, undefined, 'X');
    expect(x4[idx('n_cur')]).toBe(3);
  });

  it('reuse history across weeks without changing a value, and refresh it after an ingest', () => {
    const meta = () => ({ pos: 'LB' as Pos, birthDate: '1999-05-01', yearsExp: 4 });
    const scoring = compileScoring({ idp_tkl_solo: 2, idp_sack: 9 });
    const line = (w: number) => ({ id: 'p', team: 'X', opponent: w % 2 ? 'Y' : 'Z', stats: { gp: 1, def_snp: 60, tm_def_snp: 65, idp_tkl_solo: w + 3, idp_sack: w % 2 } });
    const build = () => {
      const fs = new FeatureState(scoring, meta);
      fs.startSeason(2025);
      for (let w = 1; w <= 5; w++) fs.ingestWeek(2025, w, [line(w)]);
      return fs;
    };
    const warm = build();
    for (let w = 6; w <= 9; w++) warm.features('p', 2025, w, undefined, undefined, 'X');
    const ctx = { opponent: 'Y', home: true, kickoff: null, impliedTotal: 21, opponentImplied: 24, spread: -3, total: 45, rest: 7, dome: false };
    for (let w = 6; w <= 9; w++) {
      // A warmed state (history reused) and a fresh one must agree exactly, NaN for NaN.
      expect(Array.from(warm.features('p', 2025, w, { gp: 1, idp_tkl_solo: 6 }, ctx, 'X'))).toEqual(Array.from(build().features('p', 2025, w, { gp: 1, idp_tkl_solo: 6 }, ctx, 'X')));
    }
    warm.ingestWeek(2025, 6, [line(6)]);
    const idx = (name: string) => FEATURE_NAMES.indexOf(name as (typeof FEATURE_NAMES)[number]);
    expect(warm.features('p', 2025, 7, undefined, undefined, 'X')[idx('n_cur')]).toBe(6);
  });

  it('rate matchups on this season’s games only', () => {
    const meta = () => ({ pos: 'WR' as Pos, birthDate: '2000-01-01', yearsExp: 3 });
    const fs = new FeatureState(compileScoring({ rec: 1 }), meta);
    // X plays A and Y plays B every week. A was the soft defense last season, B is this season.
    const line = (id: string, team: string, opponent: string, rec: number) => ({ id, team, opponent, stats: { gp: 1, off_snp: 60, tm_off_snp: 60, rec } });
    const week = (season: number, w: number, vsA: number, vsB: number) => fs.ingestWeek(season, w, [
      line('a', 'X', 'A', vsA), line('xa', 'A', 'X', 8), line('b', 'Y', 'B', vsB), line('yb', 'B', 'Y', 8),
    ]);
    fs.startSeason(2025);
    for (let w = 1; w <= 17; w++) week(2025, w, 12, 4);
    fs.startSeason(2026);
    const idx = (name: string) => FEATURE_NAMES.indexOf(name as (typeof FEATURE_NAMES)[number]);
    const ctx = (opponent: string) => ({ opponent, home: true, kickoff: null, impliedTotal: null, opponentImplied: null, spread: null, total: null, rest: null, dome: false });
    const vs = (opponent: string, name: string) => fs.features('a', 2026, 6, undefined, ctx(opponent), 'X')[idx(name)];
    expect(vs('A', 'opp_ratio')).toBe(1);
    expect(vs('B', 'opp_ratio')).toBe(1);
    for (let w = 1; w <= 5; w++) week(2026, w, 4, 12);
    fs.clearAverages();
    expect(vs('A', 'opp_ratio')).toBeLessThan(1);
    expect(vs('B', 'opp_ratio')).toBeGreaterThan(1);
    // 60 points allowed in 5 games against a league average of 8, plus 4 games of prior at average.
    expect(vs('B', 'opp_ratio')).toBeCloseTo((60 + 4 * 8) / (9 * 8));
    expect(vs('B', 'opp_plays_ratio')).toBe(1);
  });
});

describe('trained model', () => {
  const file = JSON.parse(readFileSync(path.join(ROOT, 'model/model.json'), 'utf8')) as ModelFile;
  const model = new ProjectionModel(file);
  it('uses only features the engine produces and predicts finite values', () => {
    const x = new Float64Array(FEATURE_NAMES.length).fill(Number.NaN);
    x[FEATURE_NAMES.indexOf('proj_pts')] = 12;
    x[FEATURE_NAMES.indexOf('has_proj')] = 1;
    x[FEATURE_NAMES.indexOf('is_wr')] = 1;
    const p = model.predict(x);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(5);
    expect(p).toBeLessThan(20);
  });
  it('maps injury designations to playing probabilities', () => {
    expect(model.playProbability(null, true)).toBeGreaterThan(0.95);
    expect(model.playProbability('Questionable', true)).toBeGreaterThan(0.55);
    expect(model.playProbability('Questionable', true)).toBeLessThan(0.8);
    expect(model.playProbability('Out', true)).toBe(0);
    expect(model.playProbability('IR', true)).toBe(0);
  });
  it('gives Questionable starters better odds than reserves when the model measured both', () => {
    if (!file.availability.roles?.Questionable) return;
    expect(model.playProbability('Questionable', true, 'starter')).toBeGreaterThan(model.playProbability('Questionable', true, 'reserve'));
  });
  it('lets availability decay with the horizon for season-long value, and falls back without a curve', () => {
    for (const group of Object.keys(file.availability.ahead ?? {})) {
      expect(model.healthyAhead(group, 1)).toBeLessThan(model.playProbability(null, true));
      expect(model.healthyAhead(group, 8)).toBeLessThanOrEqual(model.healthyAhead(group, 1));
      expect(model.healthyAhead(group, 40)).toBeGreaterThan(0.4);
    }
    const legacy = new ProjectionModel({ ...file, availability: { ...file.availability, ahead: undefined } });
    expect(legacy.healthyAhead('RB', 5)).toBe(legacy.playProbability(null, true));
  });
});

describe('age curves', () => {
  it('decline for veterans without flattening at the floor', () => {
    const ratio = (pos: Pos, age: number) => ageCurve(pos, age + 1) / ageCurve(pos, age);
    expect(ratio('RB', 32)).toBeLessThan(0.8);
    expect(ratio('RB', 35)).toBeLessThan(ratio('RB', 30));
    expect(ageCurve('QB', 30)).toBe(1);
  });
});
