/**
 * Sleeper leagues saved from the app (config/sleeper.json): built and listed like the default
 * league. The static site saves and removes them through the Deploy workflow's save_league /
 * forget_league inputs (scripts/save-league.ts commits the file); the local server writes it directly.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SAVED_FILE = process.env.SLA_SAVED_LEAGUES ?? path.resolve(import.meta.dirname, '..', 'config', 'sleeper.json');
export const DEFAULT_LEAGUE = process.env.SLA_DEFAULT_LEAGUE ?? '1312656463549726720';
export const isSleeperId = (id: string) => /^\d{10,22}$/.test(id);

export interface SavedLeague { id: string; name: string }
const NOTE = 'Sleeper leagues saved from the app, besides the default league: every deploy builds them and the league switcher lists them. The app edits this file (Deploy workflow: save_league / forget_league).';

/** Read on every call: the file is tiny, and the local server writes it while running. */
export function savedLeagues(): SavedLeague[] {
  try {
    const file = JSON.parse(readFileSync(SAVED_FILE, 'utf8')) as { leagues?: unknown };
    return (Array.isArray(file.leagues) ? file.leagues : [])
      .map(l => l as Partial<SavedLeague>)
      .filter((l): l is SavedLeague => typeof l.id === 'string' && isSleeperId(l.id))
      .map(l => ({ id: l.id, name: typeof l.name === 'string' ? l.name : '' }));
  } catch {
    return [];
  }
}

/** Every Sleeper league this deployment builds and lists: the default, SLA_LEAGUES, then saved ones. */
export function configuredSleeperIds(): string[] {
  const env = (process.env.SLA_LEAGUES ?? '').split(',').map(x => x.trim()).filter(Boolean);
  return [...new Set([DEFAULT_LEAGUE, ...env, ...savedLeagues().map(l => l.id)])];
}

/** Adds (with its name) or removes a saved league. True when the file changed. */
export async function updateSaved(change: { save: SavedLeague } | { forget: string }): Promise<boolean> {
  const before = savedLeagues();
  let after: SavedLeague[];
  if ('save' in change) {
    if (!isSleeperId(change.save.id)) throw new Error(`Not a Sleeper league ID: ${change.save.id}`);
    if (change.save.id === DEFAULT_LEAGUE) return false;
    after = [...before.filter(l => l.id !== change.save.id), change.save];
  } else {
    after = before.filter(l => l.id !== change.forget);
  }
  if (JSON.stringify(after) === JSON.stringify(before)) return false;
  await writeFile(SAVED_FILE, `${JSON.stringify({ _note: NOTE, leagues: after }, null, 2)}\n`);
  return true;
}
