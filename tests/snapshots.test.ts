import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { WeekForecast } from '../engine/forecast.ts';
import type { NflGame } from '../engine/types.ts';
import type { WeekLine } from '../server/sleeper.ts';

const directory = await mkdtemp(path.join(tmpdir(), 'sla-snapshots-'));
process.env.SLA_SNAPSHOT_DIR = directory;
const { recordSnapshot, readSnapshots, trackRecord, verifiedSnapshot } = await import('../server/snapshots.ts');
afterEach(() => vi.useRealTimers());
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

const kickoff = Date.UTC(2026, 9, 18, 17);
const forecast = (extra: Partial<WeekForecast> = {}): WeekForecast => ({
  id: 'p', week: 6, mean: 10, play: 1, rosPlay: 1, expected: 10, provider: 9,
  floor: 0, median: 10, ceiling: 20, opponent: 'Y', home: true, kickoff, bye: false,
  residuals: [-10, 10], live: { status: 'pre_game', points: 0 }, ...extra,
});
const core = (id: string, f: WeekForecast, season = 2026) => ({
  id, season, week: 6, forecasts: new Map([[6, new Map([['p', f]])]]), ownerOf: new Map([['p', 1]]),
});

describe('pregame snapshot integrity', () => {
  it('freezes at kickoff even when the status feed still says pregame', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(kickoff - 600_000);
    await recordSnapshot(core('freeze', forecast()));
    const before = (await readSnapshots('freeze', 2026, [6])).get(6)?.p;
    vi.setSystemTime(kickoff);
    await recordSnapshot(core('freeze', forecast({ mean: 30, expected: 30 })));
    expect((await readSnapshots('freeze', 2026, [6])).get(6)?.p).toEqual(before);
  });

  it('does not label unknown-kickoff or already-started forecasts as pregame', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(kickoff);
    await recordSnapshot(core('unknown', forecast({ kickoff: null, live: null })));
    await recordSnapshot(core('started', forecast({ live: null })));
    expect((await readSnapshots('unknown', 2026, [6])).size).toBe(0);
    expect((await readSnapshots('started', 2026, [6])).size).toBe(0);
  });

  it('allows the same league and week in a different season to be saved', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(kickoff - 600_000);
    await recordSnapshot(core('season', forecast(), 2025));
    await recordSnapshot(core('season', forecast(), 2026));
    expect((await readSnapshots('season', 2026, [6])).get(6)?.p.exp).toBe(10);
  });

  it('rejects unverifiable legacy timestamps and accepts only strictly pre-kickoff entries', () => {
    const entry = { exp: 10, mean: 10, play: 1, provider: 9, at: kickoff - 1, owner: 1 };
    expect(verifiedSnapshot(entry, kickoff)).toBe(entry);
    expect(verifiedSnapshot(entry, null)).toBeNull();
    expect(verifiedSnapshot({ ...entry, at: kickoff }, kickoff)).toBeNull();
    expect(verifiedSnapshot({ ...entry, at: Number.NaN }, kickoff)).toBeNull();
  });

  it('scores only verified snapshots, includes DNPs, and gives forecast ties half credit', async () => {
    const dir = path.join(directory, 'tracking');
    await mkdir(dir);
    const entry = { exp: 10, mean: 10, play: 1, provider: 8, at: kickoff - 1, owner: 1 };
    await writeFile(path.join(dir, '2026-w01.json'), JSON.stringify({ a: entry, b: entry, dnp: entry, late: { ...entry, at: kickoff } }));
    const line = (id: string, rec: number): WeekLine => ({ id, team: 'X', opponent: 'Y', gameId: 'game', stats: { gp: 1, rec } });
    const game: NflGame = { id: 'game', season: 2026, week: 1, home: 'X', away: 'Y', kickoff,
      spreadLine: null, totalLine: null, homeScore: 20, awayScore: 10, roof: null, homeRest: null, awayRest: null, divGame: false };
    const result = await trackRecord({
      id: 'tracking', season: 2026, lastScored: 1, league: { scoring: { rec: 1 } },
      players: { a: { pos: 'WR' }, b: { pos: 'WR' }, dnp: { pos: 'WR' }, late: { pos: 'WR' } },
      statsByWeek: new Map([[1, new Map([['a', line('a', 4)], ['b', line('b', 12)], ['late', line('late', 50)]])]]),
      projectionsByWeek: new Map([[1, new Map([['dnp', line('dnp', 8)]])]]), gameFor: () => game,
    });
    expect(result.excludedSnapshots).toBe(1);
    expect(result.weeks).toEqual([{ week: 1, players: 3, pairs: 3, excluded: 1, maeModel: 6, maeProvider: 5.333, biasModel: 4.667, pairAcc: 0.5 }]);
  });
});
