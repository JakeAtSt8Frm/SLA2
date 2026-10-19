import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type GitHub = typeof import('../web/src/lib/github.ts');
let gh: GitHub;
let startedId = '';
const calls: { url: string; init?: RequestInit }[] = [];
let respond: (url: string, init?: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> } = () => ({ status: 404 });

beforeAll(async () => {
  vi.stubEnv('VITE_GITHUB_REPO', 'owner/repo');
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = respond(url, init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  });
  gh = await import('../web/src/lib/github.ts');
  gh.setToken('github_pat_test');
});
afterEach(() => { calls.length = 0; });

const run = (id: number, title: string, status: string, conclusion: string | null, at: string) =>
  ({ id, display_title: title, status, conclusion, created_at: at, updated_at: at, html_url: `https://github.com/owner/repo/actions/runs/${id}` });
const title = (claim: string, mode = 'now', drop = 'Jordan Addison') => `SLA claim ${claim} | espn-1 | 4360310 | ${mode} | Trevor Lawrence | ${drop}`;
const notes: Record<number, { annotation_level: string; title: string; message: string }[]> = {};

function api(runs: ReturnType<typeof run>[]) {
  respond = url => {
    if (url.includes('/actions/workflows/claim.yml/runs')) return { status: 200, body: { workflow_runs: runs } };
    const jobs = /\/actions\/runs\/(\d+)\/jobs$/.exec(url);
    if (jobs) return { status: 200, body: { jobs: [{ check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${jobs[1]}` }] } };
    const ann = /\/check-runs\/(\d+)\/annotations$/.exec(url);
    if (ann) return { status: 200, body: notes[Number(ann[1])] ?? [] };
    return { status: 404 };
  };
}

describe('ESPN claims from the static site (GitHub Actions)', () => {
  it('dispatches claim.yml on main with the claim as string inputs', async () => {
    respond = () => ({ status: 204 });
    const id = startedId = await gh.startClaim({ league: 'espn-1', add: 4360310, addName: 'Trevor Lawrence', drop: { espnId: 4429205, name: 'Jordan Addison' }, bid: 0, keepPriority: false, watch: false });
    const call = calls[0];
    expect(call.url).toBe('https://api.github.com/repos/owner/repo/actions/workflows/claim.yml/dispatches');
    expect((call.init?.headers as Record<string, string>).Authorization).toBe('Bearer github_pat_test');
    expect(JSON.parse(String(call.init?.body))).toEqual({
      ref: 'main',
      inputs: { claim_id: id, league: 'espn-1', add: '4360310', drop: '4429205', bid: '0', keep_priority: 'false', watch: 'false', dry_run: 'false', label: 'Trevor Lawrence | Jordan Addison' },
    });
    // The claim id must pass claim.yml's input check.
    expect(id).toMatch(/^[a-z0-9-]{6,40}$/);
  });

  it('reads each claim from its latest run and its result annotation', async () => {
    notes[2] = [{ annotation_level: 'notice', title: 'SLA claim', message: 'Added Trevor Lawrence, dropped Jordan Addison (EXECUTED).' }];
    notes[3] = [{ annotation_level: 'failure', title: 'SLA claim', message: 'ESPN rejected the move: roster locked' }];
    notes[10] = [{ annotation_level: 'notice', title: 'SLA claim continuing', message: 'Still watching.' }];
    api([
      run(1, title('aaa111', 'watch', '-'), 'in_progress', null, '2026-10-19T10:00:00Z'),
      run(2, title('bbb222'), 'completed', 'success', '2026-10-19T09:00:00Z'),
      run(3, title('ccc333'), 'completed', 'failure', '2026-10-19T08:00:00Z'),
      run(4, title('ddd444'), 'completed', 'cancelled', '2026-10-19T07:00:00Z'),
      // A watch that handed over: the newer run decides; the claim started with the first.
      run(11, title('eee555', 'watch'), 'queued', null, '2026-10-19T12:00:00Z'),
      run(10, title('eee555', 'watch'), 'completed', 'success', '2026-10-19T06:00:00Z'),
      run(20, title('fff666').replace('espn-1', 'espn-2'), 'completed', 'success', '2026-10-19T05:00:00Z'),
      run(21, 'Deploy', 'completed', 'success', '2026-10-19T05:00:00Z'),
    ]);
    const claims = await gh.listClaims('espn-1');
    const by = Object.fromEntries(claims.map(c => [c.id, c]));
    expect(Object.keys(by).sort()).toEqual(['aaa111', 'bbb222', 'ccc333', 'ddd444', 'eee555', startedId].sort());
    // Just started: shown before GitHub lists its first run.
    expect(by[startedId]).toMatchObject({ status: 'active', phase: 'queued', addName: 'Trevor Lawrence', dropName: 'Jordan Addison' });
    expect(by.aaa111).toMatchObject({ status: 'active', phase: 'running', mode: 'watch', dropName: null, addEspnId: 4360310 });
    expect(by.bbb222).toMatchObject({ status: 'done', result: 'Added Trevor Lawrence, dropped Jordan Addison (EXECUTED).', dropName: 'Jordan Addison' });
    expect(by.ccc333).toMatchObject({ status: 'failed', result: 'ESPN rejected the move: roster locked' });
    expect(by.ddd444).toMatchObject({ status: 'cancelled' });
    expect(by.eee555).toMatchObject({ status: 'active', phase: 'queued', createdAt: Date.parse('2026-10-19T06:00:00Z') });
    // Running claims first, then newest.
    expect(claims[0].status).toBe('active');
  });

  it('keeps a watch active between runs, while the next run is not listed yet', async () => {
    api([run(10, title('ggg777', 'watch'), 'completed', 'success', '2026-10-19T06:00:00Z')]);
    notes[10] = [{ annotation_level: 'notice', title: 'SLA claim continuing', message: 'Still watching.' }];
    const c = (await gh.listClaims('espn-1')).find(x => x.id === 'ggg777');
    expect(c).toMatchObject({ id: 'ggg777', status: 'active', phase: 'queued' });
  });

  it('cancels every unfinished run of a claim', async () => {
    vi.useFakeTimers();
    api([
      run(31, title('hhh888', 'watch'), 'in_progress', null, '2026-10-19T06:00:00Z'),
      run(32, title('hhh888', 'watch'), 'queued', null, '2026-10-19T06:01:00Z'),
      run(33, title('iii999', 'watch'), 'in_progress', null, '2026-10-19T06:00:00Z'),
    ]);
    const base = respond;
    respond = (url, init) => (init?.method === 'POST' ? { status: 202 } : base(url, init));
    const done = gh.cancelClaim('hhh888');
    await vi.advanceTimersByTimeAsync(9000);
    await done;
    vi.useRealTimers();
    const cancelled = calls.filter(c => c.init?.method === 'POST').map(c => c.url.match(/runs\/(\d+)\/cancel/)?.[1]);
    expect(new Set(cancelled)).toEqual(new Set(['31', '32']));
  });

  it('explains a token that GitHub rejects', async () => {
    respond = () => ({ status: 401 });
    await expect(gh.listClaims('espn-1')).rejects.toThrow(/rejected the token/);
    respond = () => ({ status: 403, body: { message: 'Resource not accessible by personal access token' } });
    await expect(gh.startClaim({ league: 'espn-1', add: 1, addName: 'X', drop: null, bid: 0, keepPriority: false, watch: false }))
      .rejects.toThrow(/refused to start the job \(403\)\. GitHub said: “Resource not accessible by personal access token”/);
  });

  describe('Check token', () => {
    const repoUrl = '/repos/owner/repo/actions/workflows/claim.yml/runs';
    const setup = (o: { user?: number; login?: string; scopes?: string; runs?: number; probe?: number }) => {
      respond = (url, init) => {
        if (url.endsWith('/user')) return { status: o.user ?? 200, body: { login: o.login ?? 'owner' }, headers: o.scopes === undefined ? {} as Record<string, string> : { 'X-OAuth-Scopes': o.scopes } };
        if (url.includes(repoUrl)) return { status: o.runs ?? 200, body: { workflow_runs: [{ id: 5 }] } };
        if (url.endsWith('/runs/5/cancel') && init?.method === 'POST') return { status: o.probe ?? 409, body: { message: 'Cannot cancel a workflow run that is completed.' } };
        return { status: 404 };
      };
    };
    it('passes when GitHub refuses to cancel a finished run because it is finished', async () => {
      setup({});
      expect(await gh.checkToken()).toMatchObject({ ok: true, message: expect.stringMatching(/can start and cancel/) });
    });
    it('names the missing Actions permission on a fine-grained token', async () => {
      setup({ probe: 403 });
      expect(await gh.checkToken()).toMatchObject({ ok: false, message: expect.stringMatching(/Actions must be “Read and write”/) });
    });
    it('names the missing scope on a classic token', async () => {
      setup({ probe: 404, scopes: 'read:user' });
      expect(await gh.checkToken()).toMatchObject({ ok: false, message: expect.stringMatching(/classic token with scopes “read:user”/) });
    });
    it('spots a token from another account, and a dead token', async () => {
      setup({ login: 'someone-else' });
      expect((await gh.checkToken()).message).toMatch(/belongs to someone-else/);
      setup({ user: 401 });
      expect((await gh.checkToken()).message).toMatch(/doesn’t accept this token/);
    });
  });
});
