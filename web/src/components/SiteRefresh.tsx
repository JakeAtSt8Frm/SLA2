import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CircleX, ExternalLink, LoaderCircle, X } from 'lucide-react';
import { forgetLeagueLocally, refreshLeague, saveLeagueLocally, STATIC } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { ago } from '../lib/format.ts';
import { leagueLoad } from '../lib/league-load.ts';
import { useSleeperStarters } from '../lib/live.ts';
import { changedLineups } from '../lib/live-score.ts';
import { canRebuild, dismissSiteJob, jobRunning, resumeSiteJob, startSiteJob, useSiteJob, type SiteJob, type SiteJobKind } from '../lib/site-build.ts';
import { TokenCheck, TokenSetup, useToken } from './GitHubToken.tsx';
import { Notice, useEscape } from './ui.tsx';

/**
 * The Refresh button. The local server re-checks Sleeper/ESPN right away; the static site's files
 * only change when it's rebuilt, so it asks GitHub for a build now (lib/site-build.ts).
 */
export function useRefreshData(): { refresh: () => void; busy: boolean } {
  const { leagueId } = useApp();
  const client = useQueryClient();
  const job = useSiteJob();
  const [checking, setChecking] = useState(false);
  const refresh = useCallback(() => {
    if (!STATIC) {
      setChecking(true);
      void refreshLeague(leagueId).catch(() => undefined).finally(() => { setChecking(false); void client.invalidateQueries(); });
      return;
    }
    // Picks up a build that already landed, and Sleeper's current starters.
    void client.invalidateQueries();
    // A league being added rebuilds everything already.
    const load = leagueLoad();
    if (load && load.phase !== 'failed') return;
    // The new bootstrap's build stamp makes every page refetch (App's Shell).
    void startSiteJob({ kind: 'refresh' }, () => void client.invalidateQueries({ queryKey: ['bootstrap'] }));
  }, [client, leagueId]);
  return { refresh, busy: checking || jobRunning(job) };
}

/**
 * Saving a league opened by ID (so it's built every time and listed), or removing a saved one. The
 * local server writes config/sleeper.json; the static site commits it in a site build.
 */
export function useSavedLeagues() {
  const client = useQueryClient();
  const job = useSiteJob();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = useCallback((kind: 'save' | 'forget', league: { id: string; name: string }) => {
    setError(null);
    if (STATIC) {
      void startSiteJob({ kind, league: league.id, name: league.name.trim() || league.id }, () => void client.invalidateQueries({ predicate: q => q.queryKey[0] === 'leagues' || q.queryKey[0] === 'bootstrap' }));
      return;
    }
    setPending(league.id);
    void (kind === 'save' ? saveLeagueLocally(league.id) : forgetLeagueLocally(league.id))
      .then(() => client.invalidateQueries({ queryKey: ['leagues'] }), (e: Error) => setError(e.message))
      .finally(() => setPending(null));
  }, [client]);
  /** What's happening to this league right now, if anything. */
  const busy = (id: string): 'save' | 'forget' | null => {
    if (pending === id) return 'save';
    const j = jobRunning(job) && job!.job.kind !== 'refresh' ? job!.job : null;
    return j && 'league' in j && j.league === id ? j.kind as 'save' | 'forget' : null;
  };
  return { save: (l: { id: string; name: string }) => change('save', l), forget: (l: { id: string; name: string }) => change('forget', l), busy, error };
}

const STEPS: Record<Exclude<SiteJob['phase'], 'token' | 'failed'>, string> = {
  starting: 'starting a build on GitHub',
  waiting: 'waiting for the site’s current update to finish',
  building: 'rebuilding forecasts and lineups',
  publishing: 'publishing',
};
const doing = (job: SiteJobKind) => (job.kind === 'refresh' ? 'Getting the latest from Sleeper' : `${job.kind === 'save' ? 'Saving' : 'Removing'} ${job.name}`);
const failedTo = (job: SiteJobKind) => (job.kind === 'refresh' ? 'Couldn’t get the latest from Sleeper' : `Couldn’t ${job.kind === 'save' ? 'save' : 'remove'} ${job.name}`);

/** Under the top bar while a site job's build runs (or after it failed). */
export function SiteJobStatus() {
  const j = useSiteJob();
  const failed = j?.phase === 'failed';
  const [, tick] = useState(0);
  useEffect(() => {
    if (!jobRunning(j)) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [j]);
  if (!j || j.phase === 'token') return null;
  const secs = Math.max(0, Math.floor((Date.now() - j.startedAt) / 1000));
  return (
    <div className="border-t border-line px-4 py-2 text-[12px] sm:px-6 lg:px-8" role="status">
      <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-1.5">
          {failed ? <CircleX size={14} className="shrink-0 text-bad-ink" aria-hidden /> : <LoaderCircle size={14} className="shrink-0 animate-spin text-ink-3" aria-hidden />}
          <span className={failed ? 'text-bad-ink' : 'text-ink-2'}>
            {failed ? `${failedTo(j.job)}: ${j.error}` : `${doing(j.job)}: ${STEPS[j.phase as keyof typeof STEPS]}… ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}
          </span>
        </span>
        {!failed && <span className="text-ink-3">Usually about a minute; pages update by themselves.</span>}
        <span className="flex items-center gap-3 text-ink-3">
          {j.runUrl && <a href={j.runUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline hover:text-ink">GitHub<ExternalLink size={11} aria-hidden /></a>}
          <button className="underline hover:text-ink" onClick={dismissSiteJob}>{failed ? 'Dismiss' : 'Hide'}</button>
        </span>
      </div>
      {failed && j.tokenProblem && <div className="mx-auto max-w-[1320px]"><TokenCheck auto /></div>}
    </div>
  );
}

/** A site job on a device without a GitHub token yet: set one up, then the job carries on. */
export function SiteJobTokenDialog() {
  const j = useSiteJob();
  const token = useToken();
  const asking = j?.phase === 'token';
  useEffect(() => { if (asking && token) resumeSiteJob(); }, [asking, token]);
  return asking ? <TokenDialog job={j.job} /> : null;
}

function TokenDialog({ job }: { job: SiteJobKind }) {
  const dialog = useEscape(dismissSiteJob);
  const title = job.kind === 'refresh' ? 'Get the latest from Sleeper' : job.kind === 'save' ? `Save ${job.name}` : `Remove ${job.name}`;
  const intro = job.kind === 'refresh'
    ? 'This site’s data is rebuilt on a schedule: every 10 minutes during Sunday games, every 3 hours otherwise. Refresh rebuilds it now, so lineups set in Sleeper since then show up in about a minute. It starts a build on GitHub.'
    : `${job.kind === 'save' ? 'Saving a league adds it to' : 'Removing a league takes it out of'} the site’s settings (config/sleeper.json) and rebuilds the site, in a build on GitHub.`;
  // Portal: the sticky, blurred header is its own stacking context and would trap the overlay beneath the page.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay)] p-4 pt-[12vh]" onClick={dismissSiteJob}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="card max-h-[min(76vh,36rem)] w-full max-w-md overflow-y-auto overscroll-contain p-5 fade-in" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="min-w-0 truncate text-[16px] font-semibold">{title}</h2>
          <button onClick={dismissSiteJob} className="rounded-md p-1 text-ink-3 hover:bg-surface-2" aria-label="Close"><X size={18} /></button>
        </div>
        <TokenSetup intro={intro} />
      </div>
    </div>,
    document.body,
  );
}

/** Lineups set in Sleeper after this data was built: whose, and a rebuild one tap away. */
export function LineupDrift({ week, published }: { week: number | null; published: ReadonlyMap<number, readonly (string | null)[]> }) {
  const { boot, myTeamId, teamName } = useApp();
  const live = useSleeperStarters(week);
  const job = useSiteJob();
  const { refresh } = useRefreshData();
  const changed = live.data ? changedLineups(published, live.data) : [];
  if (!changed.length) return null;
  const who = changed.map(rid => (rid === myTeamId ? 'your team' : teamName(rid))).join(', ');
  return (
    <Notice tone="warn">
      <span>
        Lineups changed in Sleeper after this page was built {ago(boot.generatedAt)}: <b className="text-ink">{who}</b>.{' '}
        {!canRebuild ? 'They show after the next data refresh.'
          : jobRunning(job) ? 'Updating now…'
          : <button className="font-semibold text-ink underline" onClick={refresh}>Update now</button>}
      </span>
    </Notice>
  );
}
