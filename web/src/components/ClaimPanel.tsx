import { useEffect, useState, useSyncExternalStore } from 'react';
import { Ban, CircleCheck, CircleX, ExternalLink, LoaderCircle } from 'lucide-react';
import { CLAIMS_AVAILABLE, STATIC, useCancelClaim, useClaimInfo, useStartClaim, type ClaimInfoView, type ClaimJobView } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { ago, kickoff } from '../lib/format.ts';
import { bakedToken, checkToken, getToken, githubRepo, hasTokenOverride, runsUrl, setToken, subscribeToken, tokenHelpUrl, tokenSettingsUrl } from '../lib/github.ts';
import { Button, Card, Empty, Notice, Skeleton, cx } from './ui.tsx';

const PHASES: Record<NonNullable<ClaimJobView['phase']>, string> = {
  checking: 'Checking ESPN', watching: 'Watching for a drop', waiting: 'Waiting for waivers to clear', sending: 'Sending to ESPN',
  queued: 'Waiting for GitHub to start the job', running: 'Running on GitHub',
};

/** The GitHub token the static site starts claims with, kept in this browser. */
const useToken = () => useSyncExternalStore(subscribeToken, getToken, () => null);

/** Add, claim or watch this player on an ESPN league: by the local server, or by a GitHub Actions job from the static site. */
export function ClaimPanel({ pid, initialDrop, owner, name }: { pid: string; initialDrop: string | null; owner: number | null; name: string }) {
  const { boot } = useApp();
  const token = useToken();
  if (boot.league.platform !== 'espn') return null;
  if (!CLAIMS_AVAILABLE) {
    return <p className="text-[12px] leading-relaxed text-ink-3">To add or claim this player from here, open SLA from the server on your Mac (npm run dev). It holds your ESPN login; this site doesn’t.</p>;
  }
  if (STATIC && !token) return <Card><div className="eyebrow mb-3">Get this player</div><TokenSetup /></Card>;
  return <ClaimForm key={pid} pid={pid} initialDrop={initialDrop} player={{ owner, name }} token={token} />;
}

function ClaimForm({ pid, initialDrop, player, token }: { pid: string; initialDrop: string | null; player: { owner: number | null; name: string }; token: string | null }) {
  const { leagueId, teamName } = useApp();
  const q = useClaimInfo(leagueId, pid, { player, token });
  const start = useStartClaim(leagueId);
  const [drop, setDrop] = useState<string | null>(null);
  const [bid, setBid] = useState('0');
  const [keepPriority, setKeepPriority] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (q.isPending) return <Card><Skeleton className="h-24" /></Card>;
  if (q.isError) return <Notice tone="warn">Claims unavailable: {(q.error as Error).message}</Notice>;
  const info = q.data;
  const t = info.target;
  if (!t) return null;
  const github = info.mode === 'github';
  const job = info.jobs.find(j => j.status === 'active' && j.add.espnId === t.espnId);
  // The last finished claim for this player, so a result never vanishes silently.
  const recent = info.jobs.find(j => j.status !== 'active' && j.add.espnId === t.espnId && Date.now() - j.updatedAt < 6 * 3600_000);
  if (t.mine) return recent ? <Card><JobRow job={recent} /></Card> : null;
  const full = info.openSpots <= 0;
  const preset = info.roster.find(r => r.pid === initialDrop)?.espnId ?? t.suggestedDrop;
  const chosen = drop ?? (preset !== null ? String(preset) : full ? '' : 'none');
  const dropPlayer = info.roster.find(r => String(r.espnId) === chosen) ?? null;
  const onWaivers = t.status === 'WAIVERS';
  const keep = onWaivers && !info.freeAgency && keepPriority && t.waiverProcessDate !== null;
  const clears = t.waiverProcessDate ? kickoff(t.waiverProcessDate) : null;
  const owner = t.onTeamId ? teamName(t.onTeamId) : 'another team';
  const action = t.status === 'FREEAGENT' ? 'Add now' : onWaivers ? (keep ? 'Add when they clear' : 'Place waiver claim') : 'Grab when dropped';
  const dropText = dropPlayer ? `, dropping ${dropPlayer.name}` : '';
  const question = t.status === 'FREEAGENT' ? `Add ${t.name}${dropText} on ESPN right now?`
    : onWaivers && !keep ? `Place a waiver claim for ${t.name}${dropText}? ESPN runs claims in waiver order${clears ? ` ${clears}` : ''}; the drop only happens if the claim wins.`
    : keep ? `Add ${t.name}${dropText} the moment they clear waivers (${clears}), without using a claim?`
    : `Watch ${t.name} and add them${dropText} the moment ${owner} drops them?`;
  const blocked = (full && !dropPlayer) || (onWaivers && !keep && t.pendingClaim);
  const submit = () => start.mutate(
    { pid, espnId: t.espnId, name: t.name, drop: dropPlayer ? { espnId: dropPlayer.espnId, name: dropPlayer.name } : null, bid: Number(bid) || 0, keepPriority: keep, watch: keep || t.status === 'ONTEAM' },
    { onSuccess: () => setConfirming(false) },
  );
  const status = t.status === 'FREEAGENT' ? `Free agent${info.freeAgency ? ' · first come, first served' : ''}` : onWaivers ? `On waivers${clears ? ` until ${clears}` : ''}` : `On ${owner}`;

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="eyebrow">Get this player · {info.teamName}</div>
        <div className="text-[12px] text-ink-3">{status}{github && info.asOf ? ` · as of ${kickoff(Date.parse(info.asOf))}` : ''}</div>
      </div>
      {info.dryRun && <div className="mt-3"><Notice>Test mode (SLA_CLAIMS_DRY_RUN): moves are logged, not sent to ESPN.</Notice></div>}
      {info.jobsError && <div className="mt-3"><Notice tone="warn">{info.jobsError}</Notice></div>}
      {job ? <div className="mt-3"><JobRow job={job} /></div> : (
        <div className="mt-3 space-y-3">
          {recent && <div className="border-b border-line pb-3"><JobRow job={recent} /></div>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label className="block">
              <span className="mb-1 block text-[12px] text-ink-3">{full ? `Drop (roster full: ${info.rosterLimit} of ${info.rosterLimit})` : `Drop (${info.openSpots} open spot${info.openSpots === 1 ? '' : 's'})`}</span>
              <select value={chosen} onChange={e => { setDrop(e.target.value); setConfirming(false); }} className="h-9 w-full rounded-[9px] border border-line-strong bg-surface px-3 text-[16px] text-ink">
                {full ? <option value="" disabled>Choose who to drop</option> : <option value="none">No drop</option>}
                {info.roster.map(r => <option key={r.espnId} value={String(r.espnId)}>{r.name} · {r.slot}{r.espnId === t.suggestedDrop ? ' (suggested)' : ''}</option>)}
              </select>
            </label>
            {info.budget && onWaivers && !keep && (
              <label className="block">
                <span className="mb-1 block text-[12px] text-ink-3">Bid (${info.budget.left} left)</span>
                <input type="number" min={0} max={info.budget.left} value={bid} onChange={e => setBid(e.target.value)} className="num h-9 w-28 rounded-[9px] border border-line-strong bg-surface px-3 text-[16px]" />
              </label>
            )}
          </div>
          {onWaivers && !info.freeAgency && t.waiverProcessDate !== null && (
            <label className="flex items-start gap-2 text-[13px] text-ink-2">
              <input type="checkbox" checked={keepPriority} onChange={e => { setKeepPriority(e.target.checked); setConfirming(false); }} className="mt-0.5" />
              <span>Keep my waiver priority: add them as a free agent the moment they clear ({clears}) instead of placing a claim.</span>
            </label>
          )}
          {onWaivers && !keep && t.pendingClaim && <Notice>Your waiver claim for {t.name} is already pending on ESPN.</Notice>}
          {confirming ? (
            <div className="rounded-[10px] border border-line-strong bg-surface-2 p-3">
              <p className="text-[13px] text-ink">{question}</p>
              {start.isError && <p className="mt-2 text-[12px] text-bad-ink">{(start.error as Error).message}</p>}
              {start.isError && github && <TokenCheck auto />}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="primary" onClick={submit} disabled={start.isPending}>{start.isPending ? 'Starting…' : `Confirm: ${action.toLowerCase()}`}</Button>
                <Button variant="ghost" onClick={() => setConfirming(false)} disabled={start.isPending}>Back</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={() => { start.reset(); setConfirming(true); }} disabled={blocked}>{action}</Button>
              {full && !dropPlayer && <span className="text-[12px] text-ink-3">Choose who to drop first.</span>}
            </div>
          )}
          <Footnote github={github} />
        </div>
      )}
    </Card>
  );
}

function Footnote({ github }: { github: boolean }) {
  if (!github) return <p className="text-[11px] leading-relaxed text-ink-3">Made by the SLA server on this Mac with your ESPN login. Watches keep running while the server does and pick up again after a restart.</p>;
  // Baked-token builds need no per-device setup: claims run with the token in the build unless a
  // pasted override exists. Forgetting the override falls back to the built-in token.
  const bakedHere = !!bakedToken && !hasTokenOverride();
  return (
    <p className="text-[11px] leading-relaxed text-ink-3">
      Runs as a GitHub Actions job in {githubRepo} with the ESPN login there, and re-checks the player live before moving. Jobs usually start within a minute; a watch keeps going in fresh runs until it’s done or you cancel it.{' '}
      <a href={runsUrl} target="_blank" rel="noreferrer" className="underline hover:text-ink">Runs on GitHub</a>{' · '}
      <a href={tokenSettingsUrl} target="_blank" rel="noreferrer" className="underline hover:text-ink">Your tokens</a>{' · '}
      {bakedHere
        ? <span>This build includes the owner’s claim token and nothing is saved here.</span>
        : <button className="underline hover:text-ink" onClick={() => setToken(null)}>{bakedToken ? 'Reset to built-in token' : 'Forget token'}</button>}
      <TokenCheck />
    </p>
  );
}

/** Says what the saved token is missing, without starting anything. */
function TokenCheck({ auto = false }: { auto?: boolean }) {
  const [state, setState] = useState<{ ok: boolean; message: string } | 'checking' | null>(null);
  const run = () => { setState('checking'); checkToken().then(setState, (error: Error) => setState({ ok: false, message: error.message })); };
  useEffect(() => { if (auto) run(); }, [auto]);
  return (
    <span className="mt-2 block">
      <Button size="sm" onClick={run} disabled={state === 'checking'}>{state === 'checking' ? 'Checking…' : 'Check token'}</Button>
      {state && state !== 'checking' && <span className={cx('mt-1.5 block text-[12px] leading-relaxed', state.ok ? 'text-good-ink' : 'text-bad-ink')}>{state.message}</span>}
    </span>
  );
}

/** One-time setup on the static site: a fine-grained token that can run this repository's Actions. */
function TokenSetup() {
  const [value, setValue] = useState('');
  const valid = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(value.trim());
  return (
    <div className="space-y-3 text-[13px] text-ink-2">
      <p>To add or claim ESPN players from this site, it starts a job on GitHub that makes the move with the ESPN login there. That needs a GitHub token, once per device:</p>
      <ol className="list-decimal space-y-1 pl-5 text-[12px]">
        <li>Open <a href={tokenHelpUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline hover:text-ink">a new fine-grained token on GitHub<ExternalLink size={11} aria-hidden /></a>.</li>
        <li>Resource owner: <b>{githubRepo.split('/')[0]}</b>. Repository access: <b>Only select repositories</b> → <b>{githubRepo.split('/')[1] ?? githubRepo}</b> (not “Public repositories”, which is read-only).</li>
        <li>Permissions → Repository permissions → <b>Actions</b> → change it to <b>Read and write</b>.</li>
        <li>Generate it, copy it, and paste it here.</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <input type="password" autoComplete="off" spellCheck={false} value={value} onChange={e => setValue(e.target.value)} placeholder="github_pat_…" aria-label="GitHub token"
          className="h-9 min-w-0 flex-1 rounded-[9px] border border-line-strong bg-surface px-3 font-mono text-[16px] placeholder:text-ink-3" />
        <Button variant="primary" onClick={() => setToken(value)} disabled={!valid}>Save token</Button>
      </div>
      <p className="text-[11px] text-ink-3">Kept only in this browser. It can run and cancel Actions on {githubRepo} and nothing else.</p>
    </div>
  );
}

function JobRow({ job }: { job: ClaimJobView }) {
  const { leagueId } = useApp();
  const cancel = useCancelClaim(leagueId);
  const active = job.status === 'active';
  const last = job.log.at(-1)?.msg ?? job.result;
  const Icon = active ? LoaderCircle : job.status === 'done' ? CircleCheck : job.status === 'cancelled' ? Ban : CircleX;
  return (
    <div className="flex items-start gap-3">
      <Icon size={18} className={cx('mt-0.5 shrink-0', active ? 'animate-spin text-ink-3' : job.status === 'done' ? 'text-good-ink' : job.status === 'failed' ? 'text-bad-ink' : 'text-ink-3')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-ink">{job.add.name}{job.drop && <span className="font-normal text-ink-2"> · drop {job.drop.name}</span>}{job.keepPriority && <span className="font-normal text-ink-3"> · keeping priority</span>}</div>
        <div className="text-[12px] text-ink-2">{active ? (job.phase === 'sending' || job.phase === 'queued' || job.phase === 'running' || !last ? (job.phase ? PHASES[job.phase] : 'Starting') : last) : job.result}</div>
        <div className="text-[11px] text-ink-3">
          Started {ago(job.createdAt)}{!active ? ` · finished ${ago(job.updatedAt)}` : ''}
          {job.url && <> · <a href={job.url} target="_blank" rel="noreferrer" className="underline hover:text-ink">GitHub</a></>}
        </div>
      </div>
      {active && <Button size="sm" onClick={() => cancel.mutate(job.id)} disabled={cancel.isPending}>{cancel.isPending ? 'Cancelling…' : 'Cancel'}</Button>}
    </div>
  );
}

/** Every claim on this league, running ones first. */
export function AutoClaims() {
  const { leagueId, boot } = useApp();
  const token = useToken();
  const espn = boot.league.platform === 'espn';
  const q = useClaimInfo(leagueId, null, { enabled: espn && (!STATIC || !!token), token });
  if (!espn || !CLAIMS_AVAILABLE) return null;
  const info: ClaimInfoView | undefined = q.data;
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[16px] font-semibold tracking-tight">Auto-claims</h2>
        <span className="text-[12px] text-ink-3">Open any player, or use Claim on a pickup below</span>
      </div>
      {STATIC && !token ? <div className="mt-3"><TokenSetup /></div> : <>
        {info?.dryRun && <div className="mt-3"><Notice>Test mode (SLA_CLAIMS_DRY_RUN): moves are logged, not sent to ESPN.</Notice></div>}
        {info?.jobsError && <div className="mt-3"><Notice tone="warn">{info.jobsError}</Notice></div>}
        {q.isError && <div className="mt-3"><Notice tone="warn">{(q.error as Error).message}</Notice></div>}
        {q.isPending ? <Skeleton className="mt-3 h-12" /> : info && (info.jobs.length
          ? <div className="mt-3 divide-y divide-line">{info.jobs.map(j => <div key={j.id} className="py-2.5 first:pt-0 last:pb-0"><JobRow job={j} /></div>)}</div>
          : <Empty title="No auto-claims yet">Add a free agent, place a waiver claim, or watch a rostered player and grab them the moment they’re dropped.</Empty>)}
        {info?.mode === 'github' && <div className="mt-3"><Footnote github /></div>}
      </>}
    </Card>
  );
}
