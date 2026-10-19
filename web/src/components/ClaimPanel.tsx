import { useState } from 'react';
import { Ban, CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { CLAIMS_AVAILABLE, useCancelClaim, useClaimInfo, useStartClaim, type ClaimInfo, type ClaimJob } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { ago, kickoff } from '../lib/format.ts';
import { Button, Card, Empty, Notice, Skeleton, cx } from './ui.tsx';

const PHASES: Record<NonNullable<ClaimJob['phase']>, string> = {
  checking: 'Checking ESPN', watching: 'Watching for a drop', waiting: 'Waiting for waivers to clear', sending: 'Sending to ESPN',
};

/** Add, claim or watch this player on an ESPN league. The local server makes the move with your ESPN login. */
export function ClaimPanel({ pid, initialDrop }: { pid: string; initialDrop: string | null }) {
  const { boot } = useApp();
  if (boot.league.platform !== 'espn') return null;
  if (!CLAIMS_AVAILABLE) {
    return <p className="text-[12px] leading-relaxed text-ink-3">To add or claim this player from here, open SLA from the server on your Mac (npm run dev). It holds your ESPN login; this site doesn’t.</p>;
  }
  return <ClaimForm key={pid} pid={pid} initialDrop={initialDrop} />;
}

function ClaimForm({ pid, initialDrop }: { pid: string; initialDrop: string | null }) {
  const { leagueId, teamName } = useApp();
  const q = useClaimInfo(leagueId, pid);
  const start = useStartClaim(leagueId);
  const [drop, setDrop] = useState<string | null>(null);
  const [bid, setBid] = useState('0');
  const [keepPriority, setKeepPriority] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (q.isPending) return <Card><Skeleton className="h-24" /></Card>;
  if (q.isError) return <Notice tone="warn">Auto-claims unavailable: {(q.error as Error).message}</Notice>;
  const info = q.data;
  const t = info.target;
  if (!t) return null;
  const job = info.jobs.find(j => j.status === 'active' && j.add.espnId === t.espnId);
  // The last finished auto-claim for this player, so a result never vanishes silently.
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
    { player: pid, drop: dropPlayer?.espnId ?? null, bid: Number(bid) || 0, keepPriority: keep },
    { onSuccess: () => setConfirming(false) },
  );

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="eyebrow">Get this player · {info.teamName}</div>
        <div className="text-[12px] text-ink-3">
          {t.status === 'FREEAGENT' ? `Free agent${info.freeAgency ? ' · first come, first served' : ''}` : onWaivers ? `On waivers${clears ? ` until ${clears}` : ''}` : `On ${owner}`}
        </div>
      </div>
      {info.dryRun && <div className="mt-3"><Notice>Test mode (SLA_CLAIMS_DRY_RUN): moves are logged, not sent to ESPN.</Notice></div>}
      {job ? <div className="mt-3"><JobRow job={job} /></div> : (
        <div className="mt-3 space-y-3">
          {recent && <div className="border-b border-line pb-3"><JobRow job={recent} /></div>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label className="block">
              <span className="mb-1 block text-[12px] text-ink-3">{full ? `Drop (roster full: ${info.rosterLimit} of ${info.rosterLimit})` : `Drop (${info.openSpots} open spot${info.openSpots === 1 ? '' : 's'})`}</span>
              <select value={chosen} onChange={e => { setDrop(e.target.value); setConfirming(false); }} className="h-9 w-full rounded-[9px] border border-line-strong bg-surface px-3 text-[14px] text-ink">
                {full ? <option value="" disabled>Choose who to drop</option> : <option value="none">No drop</option>}
                {info.roster.map(r => <option key={r.espnId} value={String(r.espnId)}>{r.name} · {r.slot}{r.espnId === t.suggestedDrop ? ' (suggested)' : ''}</option>)}
              </select>
            </label>
            {info.budget && onWaivers && !keep && (
              <label className="block">
                <span className="mb-1 block text-[12px] text-ink-3">Bid (${info.budget.left} left)</span>
                <input type="number" min={0} max={info.budget.left} value={bid} onChange={e => setBid(e.target.value)} className="num h-9 w-28 rounded-[9px] border border-line-strong bg-surface px-3 text-[14px]" />
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
          <p className="text-[11px] leading-relaxed text-ink-3">Made by the SLA server on this Mac with your ESPN login. Watches keep running while the server does and pick up again after a restart.</p>
        </div>
      )}
    </Card>
  );
}

function JobRow({ job }: { job: ClaimJob }) {
  const { leagueId } = useApp();
  const cancel = useCancelClaim(leagueId);
  const active = job.status === 'active';
  const last = job.log.at(-1)?.msg;
  const Icon = active ? LoaderCircle : job.status === 'done' ? CircleCheck : job.status === 'cancelled' ? Ban : CircleX;
  return (
    <div className="flex items-start gap-3">
      <Icon size={18} className={cx('mt-0.5 shrink-0', active ? 'animate-spin text-ink-3' : job.status === 'done' ? 'text-good-ink' : job.status === 'failed' ? 'text-bad-ink' : 'text-ink-3')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-ink">{job.add.name}{job.drop && <span className="font-normal text-ink-2"> · drop {job.drop.name}</span>}{job.keepPriority && <span className="font-normal text-ink-3"> · keeping priority</span>}</div>
        <div className="text-[12px] text-ink-2">{active ? (job.phase === 'sending' ? PHASES.sending : last ?? (job.phase ? PHASES[job.phase] : 'Starting')) : job.result}</div>
        <div className="text-[11px] text-ink-3">Started {ago(job.createdAt)}{!active ? ` · finished ${ago(job.updatedAt)}` : ''}</div>
      </div>
      {active && <Button size="sm" onClick={() => cancel.mutate(job.id)} disabled={cancel.isPending}>Cancel</Button>}
    </div>
  );
}

/** Every auto-claim on this league, running ones first. */
export function AutoClaims() {
  const { leagueId, boot } = useApp();
  const q = useClaimInfo(leagueId, null, boot.league.platform === 'espn');
  if (boot.league.platform !== 'espn' || !CLAIMS_AVAILABLE) return null;
  const info: ClaimInfo | undefined = q.data;
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[16px] font-semibold tracking-tight">Auto-claims</h2>
        <span className="text-[12px] text-ink-3">Open any player, or use Claim on a pickup below</span>
      </div>
      {info?.dryRun && <div className="mt-3"><Notice>Test mode (SLA_CLAIMS_DRY_RUN): moves are logged, not sent to ESPN.</Notice></div>}
      {q.isError && <div className="mt-3"><Notice tone="warn">{(q.error as Error).message}</Notice></div>}
      {q.isPending ? <Skeleton className="mt-3 h-12" /> : info && (info.jobs.length
        ? <div className="mt-3 divide-y divide-line">{info.jobs.map(j => <div key={j.id} className="py-2.5 first:pt-0 last:pb-0"><JobRow job={j} /></div>)}</div>
        : <Empty title="No auto-claims yet">Add a free agent, place a waiver claim, or watch a rostered player and grab them the moment they’re dropped.</Empty>)}
    </Card>
  );
}
