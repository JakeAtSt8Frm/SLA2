import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Saved = typeof import('../server/saved-leagues.ts');
let saved: Saved;
const file = path.join(mkdtempSync(path.join(tmpdir(), 'sla-saved-')), 'sleeper.json');

beforeAll(async () => {
  vi.stubEnv('SLA_SAVED_LEAGUES', file);
  vi.stubEnv('SLA_DEFAULT_LEAGUE', '1312656463549726720');
  vi.stubEnv('SLA_LEAGUES', '');
  saved = await import('../server/saved-leagues.ts');
});

describe('leagues saved from the app (config/sleeper.json)', () => {
  it('starts empty, with only the default league configured', () => {
    expect(saved.savedLeagues()).toEqual([]);
    expect(saved.configuredSleeperIds()).toEqual(['1312656463549726720']);
  });

  it('saves a league once, renames it in place of a duplicate, and removes it', async () => {
    expect(await saved.updateSaved({ save: { id: '1399265965505576960', name: 'Other League' } })).toBe(true);
    expect(await saved.updateSaved({ save: { id: '1399265965505576960', name: 'Other League' } })).toBe(false);
    expect(saved.configuredSleeperIds()).toEqual(['1312656463549726720', '1399265965505576960']);
    expect(JSON.parse(readFileSync(file, 'utf8')).leagues).toEqual([{ id: '1399265965505576960', name: 'Other League' }]);
    expect(await saved.updateSaved({ save: { id: '1399265965505576960', name: 'Renamed' } })).toBe(true);
    expect(saved.savedLeagues()).toEqual([{ id: '1399265965505576960', name: 'Renamed' }]);
    expect(await saved.updateSaved({ forget: '1399265965505576960' })).toBe(true);
    expect(saved.savedLeagues()).toEqual([]);
  });

  it('never saves the default league or something that isn’t a Sleeper ID', async () => {
    expect(await saved.updateSaved({ save: { id: '1312656463549726720', name: 'Default' } })).toBe(false);
    await expect(saved.updateSaved({ save: { id: 'espn-390483100', name: 'ESPN' } })).rejects.toThrow(/Not a Sleeper league ID/);
  });
});
