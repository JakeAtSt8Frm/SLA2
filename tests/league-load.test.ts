import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Load = typeof import('../web/src/lib/league-load.ts');
type GitHub = typeof import('../web/src/lib/github.ts');
type Site = typeof import('../web/src/lib/site-build.ts');
let load: Load;
let gh: GitHub;
let siteBuild: Site;
const calls: { url: string; init?: RequestInit }[] = [];
let respond: (url: string, init?: RequestInit) => { status: number; body?: unknown } = () => ({ status: 404 });
const location = { pathname: '/league/1312656463549726720/hub', search: '' };

beforeAll(async () => {
  vi.stubEnv('VITE_GITHUB_REPO', 'owner/repo');
  vi.stubEnv('VITE_STATIC', '1');
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  const go = (_: unknown, __: string, to: string) => { const u = new URL(to, 'http://site'); location.pathname = u.pathname; location.search = u.search; };
  vi.stubGlobal('window', { location, addEventListener: () => undefined, history: { pushState: go, replaceState: go }, scrollTo: () => undefined });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = respond(url, init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  gh = await import('../web/src/lib/github.ts');
  load = await import('../web/src/lib/league-load.ts');
  siteBuild = await import('../web/src/lib/site-build.ts');
  gh.setToken('github_pat_test');
});
afterEach(() => { calls.length = 0; vi.useRealTimers(); load.dismissLeagueLoad(); siteBuild.dismissSiteJob(); });

const GUEST = '1257479498937454592';

/** A fake GitHub + Pages: each dispatch starts a run that goes through `script` (one status per poll). */
function site(scripts: { status: string; conclusion?: string }[][], published: () => boolean, manifest: () => unknown = () => ({ builtAt: new Date().toISOString(), guest: null })) {
  let runs = 0;
  const polls = new Map<number, number>();
  respond = (url, init) => {
    if (url.endsWith('/actions/workflows/deploy.yml/dispatches') && init?.method === 'POST') {
      runs++;
      return { status: 200, body: { workflow_run_id: 900 + runs, run_url: '', html_url: `https://github.com/owner/repo/actions/runs/${900 + runs}` } };
    }
    const run = /\/actions\/runs\/(\d+)$/.exec(url);
    if (run) {
      const id = Number(run[1]), n = polls.get(id) ?? 0;
      polls.set(id, n + 1);
      const steps = scripts[id - 901];
      return { status: 200, body: { created_at: '2026-10-22T18:00:00Z', ...steps[Math.min(n, steps.length - 1)] } };
    }
    if (url.startsWith(`/data/${GUEST}/bootstrap.json`)) return published() ? { status: 200, body: { league: { id: GUEST } } } : { status: 404 };
    if (url.startsWith('/data/manifest.json')) return { status: 200, body: manifest() };
    return { status: 404 };
  };
}

describe('temporary leagues on the static site', () => {
  it('starts the Deploy workflow with the league as guest_league and asks for the run it started', async () => {
    site([[{ status: 'queued' }]], () => false);
    expect(await gh.startSiteBuild({ guest_league: GUEST })).toEqual({ id: 901, url: 'https://github.com/owner/repo/actions/runs/901' });
    expect(calls[0].url).toBe('https://api.github.com/repos/owner/repo/actions/workflows/deploy.yml/dispatches');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ ref: 'main', inputs: { guest_league: GUEST }, return_run_details: true });
  });

  it('follows the build, asks again when a newer deploy replaced it, then opens the league once it is published', async () => {
    vi.useFakeTimers();
    let done = false;
    site([
      [{ status: 'pending' }, { status: 'completed', conclusion: 'cancelled' }],
      [{ status: 'queued' }, { status: 'in_progress' }, { status: 'completed', conclusion: 'success' }],
    ], () => done);
    const seen: (string | undefined)[] = [];
    const task = load.loadLeague(GUEST, 'Other League');
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      seen.push(stateOf()?.phase);
    }
    done = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await task;
    expect(calls.filter(c => c.url.endsWith('/dispatches')).length).toBe(2);
    expect(seen).toContain('waiting');
    expect(seen).toContain('building');
    expect(seen).toContain('publishing');
    expect(location.pathname).toBe(`/league/${GUEST}/hub`);
    expect(stateOf()).toBeNull();
  });

  it('says why the build couldn’t add the league', async () => {
    vi.useFakeTimers();
    site([[{ status: 'completed', conclusion: 'success' }]], () => false,
      () => ({ builtAt: new Date(Date.now() + 1000).toISOString(), guest: null, guestError: { league: GUEST, message: 'League not found' } }));
    const task = load.loadLeague(GUEST, 'Other League');
    await vi.advanceTimersByTimeAsync(5000);
    await task;
    expect(stateOf()).toMatchObject({ phase: 'failed', error: expect.stringMatching(/couldn’t build this league: League not found/), tokenProblem: false });
  });

  it('flags a token GitHub refuses', async () => {
    respond = () => ({ status: 403, body: { message: 'Resource not accessible by personal access token' } });
    await load.loadLeague(GUEST, 'Other League');
    expect(stateOf()).toMatchObject({ phase: 'failed', tokenProblem: true, error: expect.stringMatching(/refused to start the job \(403\)/) });
  });
});

const stateOf = () => load.leagueLoad();

describe('Refresh on the static site', () => {
  it('asks for a GitHub token first on a device without one, then carries on', async () => {
    gh.setToken(null);
    const published = vi.fn();
    await siteBuild.startSiteJob({ kind: 'refresh' }, published);
    expect(siteBuild.siteJob()).toMatchObject({ phase: 'token' });
    expect(calls).toHaveLength(0);
    vi.useFakeTimers();
    site([[{ status: 'completed', conclusion: 'success' }]], () => false, () => ({ builtAt: '2026-10-22T18:01:00Z' }));
    gh.setToken('github_pat_test');
    siteBuild.resumeSiteJob();
    await vi.advanceTimersByTimeAsync(5000);
    expect(published).toHaveBeenCalledOnce();
    expect(siteBuild.siteJob()).toBeNull();
    // No inputs: the build keeps the temporary league the site already has.
    expect(JSON.parse(String(calls.find(c => c.url.endsWith('/dispatches'))?.init?.body)).inputs).toEqual({});
  });

  it('waits until Pages serves a build newer than the run it started', async () => {
    vi.useFakeTimers();
    let builtAt = '2026-10-22T17:50:00Z';
    site([[{ status: 'in_progress' }, { status: 'completed', conclusion: 'success' }]], () => false, () => ({ builtAt }));
    const published = vi.fn();
    const task = siteBuild.startSiteJob({ kind: 'refresh' }, published);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(siteBuild.siteJob()).toMatchObject({ phase: 'publishing' });
    expect(published).not.toHaveBeenCalled();
    // A second tap while it runs starts nothing new.
    await siteBuild.startSiteJob({ kind: 'refresh' }, published);
    expect(calls.filter(c => c.url.endsWith('/dispatches'))).toHaveLength(1);
    builtAt = '2026-10-22T18:00:40Z';
    await vi.advanceTimersByTimeAsync(5000);
    await task;
    expect(published).toHaveBeenCalledOnce();
  });
});

describe('Saving a league from the static site', () => {
  const dispatched = () => calls.filter(c => c.url.endsWith('/dispatches')).map(c => JSON.parse(String(c.init?.body)).inputs as Record<string, string>);

  it('asks the Deploy workflow to save it, taking over from a refresh that is running', async () => {
    vi.useFakeTimers();
    site([[{ status: 'queued' }], [{ status: 'in_progress' }, { status: 'completed', conclusion: 'success' }]], () => false, () => ({ builtAt: '2026-10-22T18:00:40Z' }));
    void siteBuild.startSiteJob({ kind: 'refresh' }, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    const published = vi.fn();
    const task = siteBuild.startSiteJob({ kind: 'save', league: GUEST, name: 'Other League' }, published);
    expect(siteBuild.siteJob()?.job).toEqual({ kind: 'save', league: GUEST, name: 'Other League' });
    // A refresh now would rebuild nothing the save doesn't.
    await siteBuild.startSiteJob({ kind: 'refresh' }, vi.fn());
    await vi.advanceTimersByTimeAsync(15_000);
    await task;
    expect(dispatched()).toEqual([{}, { save_league: GUEST }]);
    expect(published).toHaveBeenCalledOnce();
  });

  it('removes a saved league with forget_league', async () => {
    vi.useFakeTimers();
    site([[{ status: 'completed', conclusion: 'success' }]], () => false, () => ({ builtAt: '2026-10-22T18:00:40Z' }));
    const task = siteBuild.startSiteJob({ kind: 'forget', league: GUEST, name: 'Other League' }, vi.fn());
    await vi.advanceTimersByTimeAsync(5000);
    await task;
    expect(dispatched()).toEqual([{ forget_league: GUEST }]);
  });
});
