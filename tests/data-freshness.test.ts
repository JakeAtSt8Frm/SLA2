import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlayerInfo } from '../engine/types.ts';
import type { Revalidation } from '../server/cache.ts';
import type { WeekLine } from '../server/sleeper.ts';

// The cache directory is read when the module loads.
process.env.SLA_CACHE_DIR = mkdtempSync(path.join(tmpdir(), 'sla-cache-'));
const { cached, refreshesSettled, NOT_MODIFIED } = await import('../server/cache.ts');
const { applyInjuryTags } = await import('../server/sleeper.ts');

const catalogPlayer = (id: string, injuryStatus: string | null, newsUpdated: number): PlayerInfo => ({
  id, name: id, pos: 'WR', eligible: ['WR'], team: 'LAR', age: 25, birthDate: null, yearsExp: 3,
  injuryStatus, injuryBodyPart: injuryStatus ? 'Hip' : null, injuryNotes: injuryStatus ? 'Soreness' : null,
  status: 'Active', depthOrder: 1, searchRank: 4, number: 12, college: null, newsUpdated,
});
const row = (id: string, status: string | null, at: number): WeekLine => ({
  id, team: 'LAR', opponent: 'PHI', gameId: null, stats: { rec: 7 },
  injury: { status, part: status ? 'Hip' : null, notes: null, at },
});

describe('injury tags', () => {
  it('clears an Out tag once a newer row reports the player healthy, even if another feed is older', () => {
    const catalog = { puka: catalogPlayer('puka', 'Out', 100) };
    const out: Record<string, PlayerInfo> = Object.create(catalog);
    applyInjuryTags(catalog, out, [row('puka', null, 300), row('puka', 'Out', 200)]);
    expect(out.puka.injuryStatus).toBeNull();
    expect(out.puka.injuryBodyPart).toBeNull();
    expect(out.puka.injuryNotes).toBeNull();
  });

  it('keeps the catalogue tag when it is newer than every row', () => {
    const catalog = { puka: catalogPlayer('puka', 'Questionable', 500) };
    const out: Record<string, PlayerInfo> = Object.create(catalog);
    applyInjuryTags(catalog, out, [row('puka', null, 300)]);
    expect(out.puka.injuryStatus).toBe('Questionable');
  });
});

describe('cache revalidation', () => {
  it('sends the stored ETag and keeps the same object on a 304', async () => {
    const seen: (string | null)[] = [];
    const load = async (rv: Revalidation) => {
      seen.push(rv.etag);
      if (rv.etag === 'v1') return NOT_MODIFIED;
      rv.next = 'v1';
      return { rows: [1, 2, 3] };
    };
    const a = await cached('test:etag', 0, load, { disk: true });
    const b = await cached('test:etag', 0, load, { disk: true });
    expect(seen).toEqual([null, 'v1']);
    expect(b).toBe(a);
    const file = path.join(process.env.SLA_CACHE_DIR!, 'test_etag.json.gz.etag');
    expect(readFileSync(file, 'utf8')).toBe('v1');
  });

  it('serves a stale copy at once, and reports when its background refresh has landed', async () => {
    await cached('test:swr', 0, async () => 'old', { swr: true });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stale = await cached('test:swr', 60_000, async () => { await gate; return 'new'; }, { swr: true });
    expect(stale).toBe('old');
    const settled = refreshesSettled();
    expect(settled).not.toBeNull();
    release();
    await settled;
    expect(await cached('test:swr', 60_000, async () => 'unused', { swr: true })).toBe('new');
  });
});
