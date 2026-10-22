/**
 * Loading a Sleeper league that isn't on the static site yet. A GitHub Actions build adds it as the
 * site's temporary league (scripts/build-static.ts); this follows the run until the league's data is
 * published, then opens it. One load at a time, and it keeps going when the league dialog closes.
 */
import { useSyncExternalStore } from 'react';
import { buildRun, findLeagueBuild, GitHubError, startLeagueBuild } from './github.ts';
import { navigate, pathFor } from './router.ts';

export interface LeagueLoad {
  id: string;
  name: string;
  phase: 'starting' | 'waiting' | 'building' | 'publishing' | 'failed';
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

const DATA = `${import.meta.env.BASE_URL}data`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Cache-busted: Pages' CDN can hold a file from before the last deploy for a few minutes. */
const fresh = (file: string) => fetch(`${DATA}/${file}?t=${Date.now()}`, { cache: 'no-store' });

/** True when the site has this league's data: a configured league, or the current temporary one. */
export async function isPublished(id: string): Promise<boolean> {
  try {
    const res = await fresh(`${encodeURIComponent(id)}/bootstrap.json`);
    // The JSON itself, not just a 200: a host's SPA fallback can answer any path with the app page.
    return res.ok && !!(await res.json() as { league?: unknown }).league;
  } catch { return false; }
}

interface Manifest { builtAt: string; guest?: string | null; guestError?: { league: string; message: string } | null }
async function manifest(): Promise<Manifest | null> {
  try { return await (await fresh('manifest.json')).json() as Manifest; } catch { return null; }
}

/** A deploy that gets superseded while it waits its turn is asked for again, this many times. */
const RETRIES = 3;
let generation = 0;

export async function loadLeague(id: string, name: string): Promise<void> {
  const mine = ++generation;
  const alive = () => generation === mine;
  set({ id, name, phase: 'starting', error: null, tokenProblem: false, runUrl: null, startedAt: Date.now() });
  try {
    let requestedAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      requestedAt = Date.now();
      let run = await startLeagueBuild(id);
      for (let i = 0; !run && i < 6 && alive(); i++) { await sleep(2500); run = await findLeagueBuild(requestedAt); }
      if (!alive()) return;
      if (!run) throw new Error('GitHub started the build but hasn’t listed it yet. The league opens from the switcher once the site updates.');
      patch({ runUrl: run.url });
      let conclusion: string | null = null;
      for (let misses = 0; alive();) {
        // A dropped connection (a phone between networks) only skips a check.
        const r = await buildRun(run.id).catch((error: unknown) => { if (++misses > 5) throw error; return null; });
        if (!r) { await sleep(5000); continue; }
        misses = 0;
        if (r.status === 'completed') { conclusion = r.conclusion; break; }
        patch({ phase: r.status === 'in_progress' ? 'building' : 'waiting' });
        await sleep(5000);
      }
      if (!alive()) return;
      // The site builds one at a time, and a build queued behind a waiting one replaces it: ask again.
      if (conclusion === 'cancelled' && attempt < RETRIES) { patch({ phase: 'starting' }); continue; }
      if (conclusion !== 'success') throw new Error(`The build ${conclusion === 'cancelled' ? 'was cancelled' : 'failed'}. Open it on GitHub for details.`);
      break;
    }
    patch({ phase: 'publishing' });
    for (let i = 0; i < 45 && alive(); i++) {
      const m = await manifest();
      if (m && m.guestError?.league === id && Date.parse(m.builtAt) >= requestedAt) throw new Error(`SLA couldn’t build this league: ${m.guestError.message}`);
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
