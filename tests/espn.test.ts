import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveDefense, deriveKicking } from '../engine/derived.ts';
import { fitDefenseModel } from '../engine/dst.ts';
import { compileScoring, completeStats, scoreStats, scoreStatsExact } from '../engine/scoring.ts';
import type { Pos, Stats } from '../engine/types.ts';
import { nflWeekOf, translateScoring } from '../server/espn.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('ESPN scoring translation', () => {
  // Official ESPN per-player points (both leagues, 2025 and 2026, including K and D/ST) with the
  // Sleeper stat lines behind them. Rescoring with the translated rules must reproduce them.
  const fixture = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/espn-parity.json'), 'utf8')) as {
    league: string; season: number; items: unknown[]; rows: { pos: Pos; name: string; week: number; stats: Stats; official: number }[];
  }[];

  it('reproduces ESPN official points for every captured player-week', () => {
    let checked = 0;
    for (const block of fixture) {
      const { scoring, unsupported } = translateScoring(block.items);
      expect(unsupported).toEqual([]);
      const compiled = compileScoring(scoring);
      for (const row of block.rows) {
        expect(scoreStats(completeStats(row.stats, row.pos), compiled), `${block.league} w${row.week} ${row.name}`).toBeCloseTo(row.official, 2);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(350);
    expect(fixture.flatMap(b => b.rows).filter(r => r.pos === 'DEF').length).toBeGreaterThan(60);
  });

  it('keeps D/ST overrides off individual players and vice versa', () => {
    const { scoring } = translateScoring([
      { statId: 93, points: 6, pointsOverrides: { 16: 6 } },
      { statId: 95, points: 0, pointsOverrides: { 16: 2 } },
      { statId: 20, points: -2 },
      { statId: 53, points: 0.5 },
    ]);
    expect(scoring).toEqual({ x_dst_td: 6, x_dst_int: 2, pass_int: -2, rec: 0.5 });
  });
});

describe('derived ladders', () => {
  it('flags the exact points- and yards-allowed buckets for actual games', () => {
    const s = deriveDefense({ pts_allow: 17, yds_allow: 312, gp: 1, sack: 3, int: 1, fum_rec: 1, def_st_fum_rec: 1, def_td: 1 }, false);
    expect(s.x_pa_14_17).toBe(1);
    expect(s.pts_allow_14_20).toBe(1);
    expect(s.x_ya_300_349).toBe(1);
    expect(s.x_dst_fum_rec).toBe(2); // special-teams recoveries count
    expect(s.x_dst_td).toBe(1);
  });

  it('treats a defense with no points-allowed line as a shutout', () => {
    // Stat feeds drop zeros, so shutouts arrive without pts_allow.
    const s = deriveDefense({ yds_allow: 175, gp: 1, sack: 2 }, false);
    expect(s.x_pa_0).toBe(1);
    expect(s.pts_allow_0).toBe(1);
  });

  it('spreads a projection over buckets instead of flagging the one its mean falls in', () => {
    const s = deriveDefense({ pts_allow: 19.3, yds_allow: 330, gp: 1 }, true);
    const pa = Object.entries(s).filter(([k]) => k.startsWith('x_pa_')).reduce((a, [, v]) => a + v, 0);
    expect(pa).toBeCloseTo(1, 6);
    expect(s.x_pa_18_21).toBeLessThan(0.5);
    expect(s.x_pa_7_13).toBeGreaterThan(0.05);
  });

  it('splits kicking into ESPN distance buckets and derives misses', () => {
    const actual = deriveKicking({ fga: 4, fgm: 3, fgm_20_29: 1, fgm_40_49: 1, fgm_50_59: 1, fgmiss_50_59: 1, xpa: 2, xpm: 1 });
    expect(actual.x_fgm_0_39).toBe(1);
    expect(actual.x_fgm_40_49).toBe(1);
    expect(actual.x_fgm_50_59).toBe(1);
    expect(actual.x_fgmiss).toBe(1);
    expect(actual.x_fgmiss_50p).toBe(1);
    expect(actual.x_xpmiss).toBe(1);
    // Projections only carry a 50+ total; a small share is expected from 60+.
    const proj = deriveKicking({ fga: 2, fgm: 1.8, fgm_50p: 0.5, fgm_30_39: 1.3 }, true);
    expect(proj.x_fgm_50_59! + proj.x_fgm_60p!).toBeCloseTo(0.5, 6);
    expect(proj.x_fgm_60p).toBeGreaterThan(0);
  });

  it('never double-counts return touchdowns for individual players', () => {
    const scoring = compileScoring({ x_ret_td: 6, rec_td: 6 });
    expect(scoreStatsExact(completeStats({ st_td: 1, rec_td: 1 }, 'WR'), scoring)).toBe(12);
  });
});

describe('D/ST forecast spread', () => {
  it('centres residual quantiles so simulations keep the projection as the mean', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ proj: 7, actual: 7 + ((i * 37) % 23) - 9 }));
    const m = fitDefenseModel(rows)!;
    let mean = 0;
    for (let i = 0; i < m.residuals.length - 1; i++) mean += (m.residuals[i] + m.residuals[i + 1]) / 2;
    expect(mean / (m.residuals.length - 1)).toBeCloseTo(0, 2);
    expect(m.residuals[0]).toBeLessThan(0);
    expect(m.residuals[20]).toBeGreaterThan(0);
  });
});

describe('ESPN calendar', () => {
  it('maps timestamps to NFL weeks (week 1 starts the Tuesday after Labor Day)', () => {
    expect(nflWeekOf(Date.UTC(2026, 8, 10, 0, 20), 2026)).toBe(1); // Thursday opener
    expect(nflWeekOf(Date.UTC(2026, 8, 15, 12), 2026)).toBe(2);
    expect(nflWeekOf(Date.UTC(2026, 10, 3, 12), 2026)).toBe(9);
    expect(nflWeekOf(Date.UTC(2025, 8, 4, 23), 2025)).toBe(1);
  });
});

describe('ESPN team logos', () => {
  it('serves uploaded logos (which need the ESPN login) from the app, and stock logos as they are', async () => {
    const { teamLogo, LOGO_FILE } = await import('../server/espn.ts');
    const uploaded = teamLogo('https://mystique-api.fantasy.espn.com/apis/v1/domains/lm/images/54504790-A59A-11f1-8623-4f919cfbc4d9');
    expect(uploaded).toBe('/api/espn-logos/54504790-a59a-11f1-8623-4f919cfbc4d9.jpg');
    expect(LOGO_FILE.test(uploaded!.split('/').at(-1)!)).toBe(true);
    const stock = 'https://g.espncdn.com/lm-static/logo-packs/ffl/HelmetAlphabet-ESPN/Helmet-M.svg';
    expect(teamLogo(stock)).toBe(stock);
    expect(teamLogo(null)).toBeNull();
  });
});
