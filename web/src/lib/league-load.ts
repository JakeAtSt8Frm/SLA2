/**
 * Loading a Sleeper league that isn't on the static site yet. A site build adds it as the
 * temporary league (scripts/build-static.ts); this follows the run until the league's data is
 * published, then opens it. One load at a time, and it keeps going when the league dialog closes.
 */
import { useSyncExternalStore } from 'react';
import { GitHubError } from './github.ts';
import { navigate, pathFor } from './router.ts';
import { dismissSiteRefresh, followSiteBuild, fresh, manifest, sleep, type BuildPhase } from './site-build.ts';

export interface LeagueLoad {
  id: string;
  name: string;
  phase: BuildPhase | 'publishing' | 'failed';
  error: string | null;
  /** The failure came from GitHub (token or permissions), so checking the token helps. */
  tokenProblem: boolean;
  runUrl: string | null;
  startedAt: number;
}

let state: LeagueLoad | null = null;
const listeners = new Set<() => void>();
const set = (next: LeagueLoad | null) => { state = next; listeners.forEach(l => l()); };
const patch = (p: Partial<LeagueLoad>) => { if (state) set({ ...state, ...p }); };
/** The load in progress (or the one that failed), if any. */
export const leagueLoad = () => state;
export const useLeagueLoad = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, leagueLoad);

/** True when the site has this league's data: a configured league, or the current temporary one. */
export async function isPublished(id: string): Promise<boolean> {
  try {
    const res = await fresh(`${encodeURIComponent(id)}/bootstrap.json`);
    // The JSON itself, not just a 200: a host's SPA fallback can answer any path with the app page.
    return res.ok && !!(await res.json() as { league?: unknown }).league;
  } catch { return false; }
}

let generation = 0;

export async function loadLeague(id: string, name: string): Promise<void> {
  const mine = ++generation;
  const alive = () => generation === mine;
  // This build rebuilds every league too, so a refresh waiting on its own build can stop.
  dismissSiteRefresh();
  set({ id, name, phase: 'starting', error: null, tokenProblem: false, runUrl: null, startedAt: Date.now() });
  try {
    const createdAt = await followSiteBuild(id, alive, p => patch(p));
    if (createdAt === null) return;
    patch({ phase: 'publishing' });
    for (let i = 0; i < 45 && alive(); i++) {
      const m = await manifest();
      if (m && m.guestError?.league === id && Date.parse(m.builtAt) >= createdAt) throw new Error(`SLA couldn’t build this league: ${m.guestError.message}`);
      if (await isPublished(id)) {
        set(null);
        navigate(pathFor(id, 'hub'));
        return;
      }
      await sleep(4000);
    }
    if (alive()) throw new Error('The build finished, but the league isn’t showing on the site yet. Try opening it again in a minute.');
  } catch (error) {
    if (alive()) patch({ phase: 'failed', error: error instanceof Error ? error.message : String(error), tokenProblem: error instanceof GitHubError });
  }
}

/** Stops following the build (a build already started still adds the league to the site). */
export function dismissLeagueLoad() {
  generation++;
  set(null);
}
