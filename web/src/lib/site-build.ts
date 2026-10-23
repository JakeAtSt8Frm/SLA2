/**
 * Site builds started from the static site (.github/workflows/deploy.yml). The data on GitHub Pages
 * is rebuilt on a schedule; Refresh asks for a build now, so lineups set in Sleeper since then show
 * up in about a minute. Saving or removing a league, and adding a temporary one (lib/league-load.ts),
 * work the same way. Each follows the run on GitHub, then waits for Pages to serve the result.
 */
import { useSyncExternalStore } from 'react';
import { STATIC } from './api.ts';
import { buildRun, findSiteBuild, getToken, GitHubError, githubRepo, startSiteBuild, type SiteBuildInputs } from './github.ts';

/** This site can start its own builds (the static deployment, linked to its GitHub repository). */
export const canRebuild = STATIC && githubRepo.length > 0;

const DATA = `${import.meta.env.BASE_URL}data`;
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Cache-busted: Pages' CDN can hold a file from before the last deploy for a few minutes. */
export const fresh = (file: string) => fetch(`${DATA}/${file}?t=${Date.now()}`, { cache: 'no-store' });

export interface Manifest { builtAt: string; guest?: string | null; guestError?: { league: string; message: string } | null }
export async function manifest(): Promise<Manifest | null> {
  try { return await (await fresh('manifest.json')).json() as Manifest; } catch { return null; }
}

export type BuildPhase = 'starting' | 'waiting' | 'building';
/** A build that gets superseded while it waits its turn is asked for again, this many times. */
const RETRIES = 3;

/**
 * Starts a build and follows it to the end. Resolves with when GitHub created the successful run
 * (its clock, like the build's own timestamps), or null once `alive` turns false.
 */
export async function followSiteBuild(inputs: SiteBuildInputs, alive: () => boolean, progress: (p: { phase: BuildPhase; runUrl?: string }) => void): Promise<number | null> {
  for (let attempt = 0; ; attempt++) {
    progress({ phase: 'starting' });
    const requestedAt = Date.now();
    let run = await startSiteBuild(inputs);
    for (let i = 0; !run && i < 6 && alive(); i++) { await sleep(2500); run = await findSiteBuild(requestedAt); }
    if (!alive()) return null;
    if (!run) throw new Error('GitHub started the build but hasn’t listed it yet. The site updates when it finishes.');
    progress({ phase: 'starting', runUrl: run.url });
    let done: { conclusion: string | null; createdAt: number } | null = null;
    for (let misses = 0; alive();) {
      // A dropped connection (a phone between networks) only skips a check.
      const r = await buildRun(run.id).catch((error: unknown) => { if (++misses > 5) throw error; return null; });
      if (!r) { await sleep(5000); continue; }
      misses = 0;
      if (r.status === 'completed') { done = { conclusion: r.conclusion, createdAt: Date.parse(r.created_at) || requestedAt }; break; }
      progress({ phase: r.status === 'in_progress' ? 'building' : 'waiting' });
      await sleep(5000);
    }
    if (!alive() || !done) return null;
    // The site builds one at a time, and a build queued behind a waiting one replaces it: ask again.
    if (done.conclusion === 'cancelled' && attempt < RETRIES) continue;
    if (done.conclusion !== 'success') throw new Error(`The build ${done.conclusion === 'cancelled' ? 'was cancelled' : 'failed'}. Open it on GitHub for details.`);
    return done.createdAt;
  }
}

// ─── Site jobs: Refresh, and saving or removing a league ─────────────────────

export type SiteJobKind = { kind: 'refresh' } | { kind: 'save' | 'forget'; league: string; name: string };

export interface SiteJob {
  job: SiteJobKind;
  /** `token`: waiting for a GitHub token to be added on this device. */
  phase: 'token' | BuildPhase | 'publishing' | 'failed';
  error: string | null;
  tokenProblem: boolean;
  runUrl: string | null;
  startedAt: number;
}

let state: SiteJob | null = null;
const listeners = new Set<() => void>();
const set = (next: SiteJob | null) => { state = next; listeners.forEach(l => l()); };
const patch = (p: Partial<SiteJob>) => { if (state) set({ ...state, ...p }); };
export const siteJob = () => state;
export const useSiteJob = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, siteJob);
/** A build is on its way (not waiting for a token, not failed). */
export const jobRunning = (job: SiteJob | null) => !!job && job.phase !== 'failed' && job.phase !== 'token';

const inputsFor = (job: SiteJobKind): SiteBuildInputs =>
  job.kind === 'save' ? { save_league: job.league } : job.kind === 'forget' ? { forget_league: job.league } : {};

let generation = 0;
let onPublished: () => void = () => undefined;

/**
 * Starts a site build for `job`; `published` runs once Pages serves it. One job at a time: a refresh
 * while another job runs does nothing (that build rebuilds everything too), and saving or removing a
 * league takes over from a running refresh.
 */
export async function startSiteJob(job: SiteJobKind, published: () => void): Promise<void> {
  if (!canRebuild) return;
  if (jobRunning(state) && (job.kind === 'refresh' || state!.job.kind !== 'refresh')) return;
  onPublished = published;
  const mine = ++generation;
  const alive = () => generation === mine;
  if (!getToken()) {
    set({ job, phase: 'token', error: null, tokenProblem: false, runUrl: null, startedAt: Date.now() });
    return;
  }
  set({ job, phase: 'starting', error: null, tokenProblem: false, runUrl: null, startedAt: Date.now() });
  try {
    const createdAt = await followSiteBuild(inputsFor(job), alive, p => patch(p));
    if (createdAt === null) return;
    patch({ phase: 'publishing' });
    for (let i = 0; i < 45 && alive(); i++) {
      const m = await manifest();
      if (m && Date.parse(m.builtAt) >= createdAt) {
        set(null);
        onPublished();
        return;
      }
      await sleep(4000);
    }
    if (alive()) throw new Error('The build finished, but the site hasn’t picked it up yet. It shows within a few minutes.');
  } catch (error) {
    if (alive()) patch({ phase: 'failed', error: error instanceof Error ? error.message : String(error), tokenProblem: error instanceof GitHubError });
  }
}

/** The token was added: start the job that was waiting for it. */
export function resumeSiteJob() {
  if (state?.phase !== 'token') return;
  const { job } = state;
  set(null);
  void startSiteJob(job, onPublished);
}

/** Stops following the build (one already started still updates the site). */
export function dismissSiteJob() {
  generation++;
  set(null);
}

/** A league build rebuilds everything too: a refresh waiting on its own build can stop. */
export function supersedeRefresh() {
  if (state?.job.kind === 'refresh') dismissSiteJob();
}
