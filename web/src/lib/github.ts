/**
 * GitHub Actions jobs started from the static site with the owner's own GitHub token (kept in this
 * browser only): ESPN claims (.github/workflows/claim.yml), whose runs and result annotations are
 * read back, and builds that add a temporary league to the site (.github/workflows/deploy.yml).
 */
const REPO = (import.meta.env.VITE_GITHUB_REPO as string | undefined) ?? '';
const REF = (import.meta.env.VITE_GITHUB_REF as string | undefined) ?? 'main';
const WORKFLOW = 'claim.yml';
const API = 'https://api.github.com';
const TOKEN_KEY = 'sla-github-token';
/**
 * Token baked into the build (VITE_GITHUB_TOKEN): claims work with zero setup on every device.
 * It is public to anyone who can open the site — scope it to this repository's Actions and
 * rotate it, not the deployment, when needed. A token pasted in this browser overrides it.
 */
const BAKED = ((import.meta.env.VITE_GITHUB_TOKEN as string | undefined) ?? '').trim() || null;

export const githubRepo = REPO;
export const githubClaims = REPO.length > 0;
/** Set at build time (deploy secret CLAIM_TOKEN); the pasted override lives in localStorage. */
export const bakedToken = BAKED;
export const tokenHelpUrl = 'https://github.com/settings/personal-access-tokens/new';
export const runsUrl = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`;

const tokenListeners = new Set<() => void>();
export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) ?? BAKED; } catch { return BAKED; }
}
export const hasTokenOverride = () => {
  try { return localStorage.getItem(TOKEN_KEY) !== null; } catch { return false; }
};
export function setToken(token: string | null) {
  try { if (token) localStorage.setItem(TOKEN_KEY, token.trim()); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage optional */ }
  tokenListeners.forEach(l => l());
}
export const subscribeToken = (listener: () => void) => { tokenListeners.add(listener); return () => { tokenListeners.delete(listener); }; };

export class GitHubError extends Error {}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  if (!token) throw new GitHubError('Add your GitHub token first.');
  try {
    return await fetch(`${API}${path}`, {
      ...init,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch {
    throw new GitHubError('Can’t reach GitHub. Check your connection.');
  }
}

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await call(path, init);
  if (res.status === 401) throw new GitHubError('GitHub rejected the token (expired or mistyped). Paste a new one.');
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    const said = body?.message ? ` GitHub said: “${body.message}”.` : '';
    if (/rate limit/i.test(body?.message ?? '')) throw new GitHubError('GitHub rate limit reached. Try again in a few minutes.');
    if (res.status === 403 || res.status === 404) {
      throw new GitHubError(init.method === 'POST'
        ? `GitHub refused to ${path.endsWith('/cancel') ? 'cancel' : 'start'} the job (${res.status}).${said} Use Check token below to see what the token is missing.`
        : `GitHub refused to list the jobs (${res.status}).${said}`);
    }
    throw new GitHubError(`GitHub error ${res.status}.${said}`);
  }
  return (res.status === 204 || res.status === 202 ? null : await res.json()) as T;
}

export const tokenSettingsUrl = 'https://github.com/settings/personal-access-tokens';

/**
 * What the saved token can do, found without side effects: who it belongs to, and whether it may run
 * this repository's Actions (asking to cancel a finished run is refused with 409 when it may, 403 when not).
 */
export async function checkToken(): Promise<{ ok: boolean; message: string }> {
  const owner = REPO.split('/')[0];
  const me = await call('/user');
  if (me.status === 401) return { ok: false, message: 'GitHub doesn’t accept this token: it’s mistyped, expired or revoked. Create a new one and paste it again.' };
  const login = me.ok ? ((await me.json()) as { login?: string }).login ?? null : null;
  // Only classic tokens report scopes; fine-grained tokens send no such header.
  const scopes = me.headers.get('X-OAuth-Scopes');
  if (login && login.toLowerCase() !== owner.toLowerCase()) {
    return { ok: false, message: `This token belongs to ${login}, but the jobs run in ${REPO}. Create the token while signed in as ${owner}.` };
  }
  const runs = await call(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1&status=completed`);
  if (!runs.ok) {
    return { ok: false, message: `This token can’t see ${REPO}’s Actions (${runs.status}). Edit it: Repository access → Only select repositories → ${REPO.split('/')[1]}.` };
  }
  const finished = ((await runs.json()) as { workflow_runs: { id: number }[] }).workflow_runs[0];
  if (!finished) return { ok: true, message: 'The token can see the repository. Its Actions permission can be confirmed after the first job runs.' };
  const probe = await call(`/repos/${REPO}/actions/runs/${finished.id}/cancel`, { method: 'POST' });
  if (probe.status === 409 || probe.ok) return { ok: true, message: `The token works: it can start and cancel jobs in ${REPO}.` };
  if (scopes !== null) {
    return { ok: false, message: `This is a classic token with scopes “${scopes || 'none'}”. It needs the “repo” scope, or use a fine-grained token with Actions: Read and write on ${REPO.split('/')[1]}.` };
  }
  return {
    ok: false,
    message: `The token can read ${REPO} but can’t run its Actions (${probe.status}). Open the token on GitHub → Edit: Repository access must be “Only select repositories” with ${REPO.split('/')[1]}, and Repository permissions → Actions must be “Read and write” (not “Read-only”). Save on GitHub; this same token then works without pasting it again.`,
  };
}

export interface ClaimDispatch {
  league: string; add: number; addName: string; drop: { espnId: number; name: string } | null;
  bid: number; keepPriority: boolean; watch: boolean;
}

/** One claim as the app shows it, from its latest workflow run. */
export interface GitHubClaim {
  id: string; league: string; addEspnId: number; mode: 'now' | 'watch' | 'keep';
  addName: string; dropName: string | null;
  status: 'active' | 'done' | 'failed' | 'cancelled';
  phase: 'queued' | 'running' | null;
  result: string | null; createdAt: number; updatedAt: number; url: string;
}

interface Run { id: number; display_title: string; status: string; conclusion: string | null; created_at: string; updated_at: string; html_url: string; run_started_at?: string }

// A claim shows up right away, before GitHub lists its first run.
const started = new Map<string, GitHubClaim>();
// Finished runs never change: their result annotation is read once.
const results = new Map<number, { level: string; title: string; message: string } | null>();

export async function startClaim(c: ClaimDispatch): Promise<string> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const label = `${c.addName} | ${c.drop?.name ?? '-'}`.replace(/[\r\n]/g, ' ');
  await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({
      ref: REF,
      inputs: {
        claim_id: id, league: c.league, add: String(c.add), drop: c.drop ? String(c.drop.espnId) : '', bid: String(c.bid),
        keep_priority: String(c.keepPriority), watch: String(c.watch), dry_run: 'false', label,
      },
    }),
  });
  const now = Date.now();
  started.set(id, {
    id, league: c.league, addEspnId: c.add, mode: c.keepPriority ? 'keep' : c.watch ? 'watch' : 'now', addName: c.addName, dropName: c.drop?.name ?? null,
    status: 'active', phase: 'queued', result: null, createdAt: now, updatedAt: now, url: runsUrl,
  });
  return id;
}

/** "SLA claim <id> | <league> | <ESPN id> | <mode> | <player> | <drop>", as claim.yml titles its runs. */
function parseTitle(title: string) {
  const parts = title.split(' | ');
  const m = /^SLA claim ([a-z0-9-]+)$/.exec(parts[0] ?? '');
  if (!m || parts.length < 6) return null;
  return { id: m[1], league: parts[1], addEspnId: Number(parts[2]), mode: parts[3] as GitHubClaim['mode'], addName: parts[4], dropName: parts[5] === '-' ? null : parts.slice(5).join(' | ') };
}

async function resultOf(run: Run) {
  if (results.has(run.id)) return results.get(run.id)!;
  const jobs = await gh<{ jobs: { check_run_url: string }[] }>(`/repos/${REPO}/actions/runs/${run.id}/jobs`);
  let found: { level: string; title: string; message: string } | null = null;
  for (const job of jobs.jobs) {
    const path = job.check_run_url.replace(API, '');
    const notes = await gh<{ annotation_level: string; title: string | null; message: string }[]>(`${path}/annotations`);
    const note = notes.find(n => (n.title ?? '').startsWith('SLA claim'));
    if (note) found = { level: note.annotation_level, title: note.title ?? '', message: note.message };
  }
  results.set(run.id, found);
  return found;
}

const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

/** This league's claims, newest first, each from its latest run (a long watch spans several). */
export async function listClaims(league: string): Promise<GitHubClaim[]> {
  const { workflow_runs: runs } = await gh<{ workflow_runs: Run[] }>(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=60&event=workflow_dispatch`);
  const latest = new Map<string, { run: Run; first: number; meta: NonNullable<ReturnType<typeof parseTitle>> }>();
  for (const run of runs) {
    const meta = parseTitle(run.display_title);
    if (!meta || meta.league !== league) continue;
    const created = Date.parse(run.created_at);
    const seen = latest.get(meta.id);
    if (!seen) latest.set(meta.id, { run, first: created, meta });
    else {
      seen.first = Math.min(seen.first, created);
      if (created > Date.parse(seen.run.created_at)) seen.run = run;
    }
  }
  const out: GitHubClaim[] = [];
  for (const { run, first, meta } of latest.values()) {
    started.delete(meta.id);
    const base = { ...meta, createdAt: first, updatedAt: Date.parse(run.updated_at), url: run.html_url };
    if (ACTIVE.has(run.status)) {
      out.push({ ...base, status: 'active', phase: run.status === 'in_progress' ? 'running' : 'queued', result: null });
      continue;
    }
    const note = await resultOf(run).catch(() => null);
    if (run.conclusion === 'cancelled') out.push({ ...base, status: 'cancelled', phase: null, result: 'Cancelled' });
    // A watch that ran out of time has started its next run; until GitHub lists it, it is still going.
    else if (run.conclusion === 'success' && note?.title === 'SLA claim continuing') out.push({ ...base, status: 'active', phase: 'queued', result: note.message });
    else if (run.conclusion === 'success') out.push({ ...base, status: 'done', phase: null, result: note?.message ?? 'Done' });
    else out.push({ ...base, status: 'failed', phase: null, result: note?.message ?? `The job ${run.conclusion ?? 'failed'}; open it on GitHub for details.` });
  }
  for (const s of started.values()) if (s.league === league && Date.now() - s.createdAt < 3 * 60_000) out.push(s);
  return out.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.createdAt - a.createdAt);
}

/** Stops a claim: cancels every run of it that hasn't finished, then once more in case a watch was handing over to a new run. */
export async function cancelClaim(id: string): Promise<void> {
  for (let pass = 0; pass < 2; pass++) {
    if (pass) await new Promise(r => setTimeout(r, 8000));
    const { workflow_runs: runs } = await gh<{ workflow_runs: Run[] }>(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=60&event=workflow_dispatch`);
    const open = runs.filter(r => parseTitle(r.display_title)?.id === id && ACTIVE.has(r.status));
    await Promise.all(open.map(r => gh(`/repos/${REPO}/actions/runs/${r.id}/cancel`, { method: 'POST' })));
  }
  started.delete(id);
}

// ─── Temporary leagues ───────────────────────────────────────────────────────

const DEPLOY = 'deploy.yml';
export const buildsUrl = `https://github.com/${REPO}/actions/workflows/${DEPLOY}`;

export interface LeagueBuild { id: number; url: string }
export interface BuildRun { status: string; conclusion: string | null }

/**
 * Starts a site build with `league` as the temporary league. GitHub answers with the run it started
 * (return_run_details); null if it didn't say, and findLeagueBuild looks for it instead.
 */
export async function startLeagueBuild(league: string): Promise<LeagueBuild | null> {
  const run = await gh<{ workflow_run_id?: number; html_url?: string } | null>(`/repos/${REPO}/actions/workflows/${DEPLOY}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: REF, inputs: { guest_league: league }, return_run_details: true }),
  });
  return run?.workflow_run_id ? { id: run.workflow_run_id, url: run.html_url ?? buildsUrl } : null;
}

/** The newest manually started build created since `since` (ms). */
export async function findLeagueBuild(since: number): Promise<LeagueBuild | null> {
  const { workflow_runs: runs } = await gh<{ workflow_runs: Run[] }>(`/repos/${REPO}/actions/workflows/${DEPLOY}/runs?per_page=5&event=workflow_dispatch`);
  const run = runs.find(r => Date.parse(r.created_at) >= since - 10_000);
  return run ? { id: run.id, url: run.html_url } : null;
}

export const buildRun = (id: number) => gh<BuildRun>(`/repos/${REPO}/actions/runs/${id}`);
