import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CircleX, ExternalLink, LoaderCircle, X } from 'lucide-react';
import { refreshLeague, STATIC } from '../lib/api.ts';
import { useApp } from '../lib/context.tsx';
import { ago } from '../lib/format.ts';
import { leagueLoad } from '../lib/league-load.ts';
import { useSleeperStarters } from '../lib/live.ts';
import { changedLineups } from '../lib/live-score.ts';
import { canRebuild, dismissSiteRefresh, refreshSite, resumeRefresh, useSiteRefresh, type SiteRefresh } from '../lib/site-build.ts';
import { TokenCheck, TokenSetup, useToken } from './GitHubToken.tsx';
import { Notice, useEscape } from './ui.tsx';

const rebuilding = (r: SiteRefresh | null) => !!r && r.phase !== 'failed' && r.phase !== 'token';

/**
 * The Refresh button. The local server re-checks Sleeper/ESPN right away; the static site's files
 * only change when it's rebuilt, so it asks GitHub for a build now (lib/site-build.ts).
 */
export function useRefreshData(): { refresh: () => void; busy: boolean } {
  const { leagueId } = useApp();
  const client = useQueryClient();
  const site = useSiteRefresh();
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
    void refreshSite(() => void client.invalidateQueries({ queryKey: ['bootstrap'] }));
  }, [client, leagueId]);
  return { refresh, busy: checking || rebuilding(site) };
}

const STEPS: Record<Exclude<SiteRefresh['phase'], 'token' | 'failed'>, string> = {
  starting: 'starting a build on GitHub',
  waiting: 'waiting for the site’s current update to finish',
  building: 'rebuilding forecasts and lineups',
  publishing: 'publishing',
};

/** Under the top bar while a refresh's build runs (or after it failed). */
export function RefreshStatus() {
  const r = useSiteRefresh();
  const failed = r?.phase === 'failed';
  const [, tick] = useState(0);
  useEffect(() => {
    if (!rebuilding(r)) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [r]);
  if (!r || r.phase === 'token') return null;
  const secs = Math.max(0, Math.floor((Date.now() - r.startedAt) / 1000));
  return (
    <div className="border-t border-line px-4 py-2 text-[12px] sm:px-6 lg:px-8" role="status">
      <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-1.5">
          {failed ? <CircleX size={14} className="shrink-0 text-bad-ink" aria-hidden /> : <LoaderCircle size={14} className="shrink-0 animate-spin text-ink-3" aria-hidden />}
          <span className={failed ? 'text-bad-ink' : 'text-ink-2'}>
            {failed ? `Couldn’t get the latest from Sleeper: ${r.error}` : `Getting the latest from Sleeper: ${STEPS[r.phase as keyof typeof STEPS]}… ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}
          </span>
        </span>
        {!failed && <span className="text-ink-3">Usually about a minute; pages update by themselves.</span>}
        <span className="flex items-center gap-3 text-ink-3">
          {r.runUrl && <a href={r.runUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline hover:text-ink">GitHub<ExternalLink size={11} aria-hidden /></a>}
          <button className="underline hover:text-ink" onClick={dismissSiteRefresh}>{failed ? 'Dismiss' : 'Hide'}</button>
        </span>
      </div>
      {failed && r.tokenProblem && <div className="mx-auto max-w-[1320px]"><TokenCheck auto /></div>}
    </div>
  );
}

/** Refresh on a device without a GitHub token yet: set one up, then the refresh carries on. */
export function RefreshTokenDialog() {
  const r = useSiteRefresh();
  const token = useToken();
  const asking = r?.phase === 'token';
  useEffect(() => { if (asking && token) resumeRefresh(); }, [asking, token]);
  return asking ? <TokenDialog /> : null;
}

function TokenDialog() {
  const dialog = useEscape(dismissSiteRefresh);
  // Portal: the sticky, blurred header is its own stacking context and would trap the overlay beneath the page.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay)] p-4 pt-[12vh]" onClick={dismissSiteRefresh}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Get the latest from Sleeper" className="card max-h-[min(76vh,36rem)] w-full max-w-md overflow-y-auto overscroll-contain p-5 fade-in" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">Get the latest from Sleeper</h2>
          <button onClick={dismissSiteRefresh} className="rounded-md p-1 text-ink-3 hover:bg-surface-2" aria-label="Close"><X size={18} /></button>
        </div>
        <TokenSetup intro="This site’s data is rebuilt on a schedule: every 10 minutes during Sunday games, every 3 hours otherwise. Refresh rebuilds it now, so lineups set in Sleeper since then show up in about a minute. It starts a build on GitHub." />
      </div>
    </div>,
    document.body,
  );
}

/** Lineups set in Sleeper after this data was built: whose, and a rebuild one tap away. */
export function LineupDrift({ week, published }: { week: number | null; published: ReadonlyMap<number, readonly (string | null)[]> }) {
  const { boot, myTeamId, teamName } = useApp();
  const live = useSleeperStarters(week);
  const site = useSiteRefresh();
  const { refresh } = useRefreshData();
  const changed = live.data ? changedLineups(published, live.data) : [];
  if (!changed.length) return null;
  const who = changed.map(rid => (rid === myTeamId ? 'your team' : teamName(rid))).join(', ');
  return (
    <Notice tone="warn">
      <span>
        Lineups changed in Sleeper after this page was built {ago(boot.generatedAt)}: <b className="text-ink">{who}</b>.{' '}
        {!canRebuild ? 'They show after the next data refresh.'
          : rebuilding(site) ? 'Updating now…'
          : <button className="font-semibold text-ink underline" onClick={refresh}>Update now</button>}
      </span>
    </Notice>
  );
}
