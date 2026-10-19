/**
 * ESPN claims from the static site: the page starts .github/workflows/claim.yml with the owner's own
 * GitHub token (kept in this browser only), and reads each claim's runs and result annotation back.
 */
const REPO = (import.meta.env.VITE_GITHUB_REPO as string | undefined) ?? '';
const REF = (import.meta.env.VITE_GITHUB_REF as string | undefined) ?? 'main';
const WORKFLOW = 'claim.yml';
const API = 'https://api.github.com';
const TOKEN_KEY = 'sla-github-token';

export const githubRepo = REPO;
export const githubClaims = REPO.length > 0;
export const tokenHelpUrl = 'https://github.com/settings/personal-access-tokens/new';
export const runsUrl = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`;

const tokenListeners = new Set<() => void>();
export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string | null) {
  try { if (token) localStorage.setItem(TOKEN_KEY, token.trim()); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage optional */ }
  tokenListeners.forEach(l => l());
}
export const subscribeToken = (listener: () => void) => { tokenListeners.add(listener); return () => { tokenListeners.delete(listener); }; };

export class GitHubError extends Error {}

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  if (!token) throw new GitHubError('Add your GitHub token first.');
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch {
    throw new GitHubError('Can’t reach GitHub. Check your connection.');
  }
  if (res.status === 401) throw new GitHubError('GitHub rejected the token (expired or mistyped). Paste a new one.');
  if (res.status === 403 || res.status === 404) {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    throw new GitHubError(/rate limit/i.test(body?.message ?? '') ? 'GitHub rate limit reached. Try again in a few minutes.'
      : `This token can’t run workflows on ${REPO}. Give it “Actions: Read and write” access to that repository.`);
  }
  if (!res.ok) throw new GitHubError(`GitHub error ${res.status}`);
  return (res.status === 204 || res.status === 202 ? null : await res.json()) as T;
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
