import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { createPortal } from 'react-dom';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight, BarChart3, CalendarDays, ChartNoAxesCombined, CircleX, ExternalLink, FlaskConical, History, LayoutDashboard, ListChecks,
  LoaderCircle, Menu, Moon, RefreshCw, ScrollText, Search, Shield, Sparkles, Sun, Swords, Trophy, UserPlus, Users, X,
} from 'lucide-react';
import { ApiError, prefetchCore, searchLeagues, sleeperLeague, STATIC, useBootstrap, useLeagues, type ConfiguredLeague, type LeagueSearchResult } from './lib/api.ts';
import { AppProvider, useApp, useTheme } from './lib/context.tsx';
import { ago } from './lib/format.ts';
import { getToken, githubRepo } from './lib/github.ts';
import { dismissLeagueLoad, isPublished, loadLeague, useLeagueLoad, type LeagueLoad } from './lib/league-load.ts';
import { atLeagueRoute, isLeagueId, navigate, pathFor, rememberLeague, startLeague, useRoute, type Page } from './lib/router.ts';
import { Button, cx, ErrorState, PageSkeleton, Select, TeamAvatar, useEscape } from './components/ui.tsx';
import { TokenCheck, TokenSetup, useToken } from './components/GitHubToken.tsx';
import { PlayerDrawer } from './components/PlayerDrawer.tsx';

const pageModules: Record<Page, () => Promise<{ default: ComponentType }>> = {
  hub: () => import('./pages/Hub.tsx'),
  lineup: () => import('./pages/Lineup.tsx'),
  waivers: () => import('./pages/Waivers.tsx'),
  matchups: () => import('./pages/Matchups.tsx'),
  power: () => import('./pages/Power.tsx'),
  playoffs: () => import('./pages/Playoffs.tsx'),
  players: () => import('./pages/Players.tsx'),
  trade: () => import('./pages/Trade.tsx'),
  recap: () => import('./pages/Recap.tsx'),
  history: () => import('./pages/History.tsx'),
  model: () => import('./pages/ModelLab.tsx'),
  defense: () => import('./pages/Defense.tsx'),
  team: () => import('./pages/Team.tsx'),
  teams: () => import('./pages/Team.tsx'),
  transactions: () => import('./pages/Transactions.tsx'),
};
const pages: Record<Page, LazyExoticComponent<ComponentType>> = {
  hub: lazy(pageModules.hub), lineup: lazy(pageModules.lineup), waivers: lazy(pageModules.waivers),
  matchups: lazy(pageModules.matchups), power: lazy(pageModules.power), playoffs: lazy(pageModules.playoffs),
  players: lazy(pageModules.players), trade: lazy(pageModules.trade), recap: lazy(pageModules.recap),
  history: lazy(pageModules.history), model: lazy(pageModules.model), defense: lazy(pageModules.defense),
  team: lazy(pageModules.team), teams: lazy(pageModules.teams), transactions: lazy(pageModules.transactions),
};

const NAV: { group: string; items: { page: Page; label: string; icon: ComponentType<{ size?: number }> }[] }[] = [
  { group: 'League', items: [
    { page: 'hub', label: 'League hub', icon: LayoutDashboard },
    { page: 'matchups', label: 'Matchups', icon: Swords },
    { page: 'power', label: 'Power rankings', icon: BarChart3 },
    { page: 'playoffs', label: 'Playoff odds', icon: Trophy },
    { page: 'recap', label: 'Season wrapped', icon: Sparkles },
    { page: 'history', label: 'League history', icon: History },
  ] },
  { group: 'Your team', items: [
    { page: 'lineup', label: 'Start / sit', icon: ListChecks },
    { page: 'waivers', label: 'Waiver wire', icon: UserPlus },
    { page: 'team', label: 'Roster & outlook', icon: Users },
    { page: 'trade', label: 'Trade lab', icon: ArrowLeftRight },
  ] },
  { group: 'Research', items: [
    { page: 'players', label: 'Players', icon: Search },
    { page: 'defense', label: 'Defense', icon: Shield },
    { page: 'transactions', label: 'Transactions', icon: ScrollText },
    { page: 'model', label: 'Model lab', icon: FlaskConical },
  ] },
];

export function App() {
  const route = useRoute();
  useEffect(() => {
    if (!atLeagueRoute()) navigate(pathFor(startLeague(), 'hub'), { replace: true });
  }, []);
  const boot = useBootstrap(route.leagueId);
  const missing = boot.isError && !boot.data && boot.error instanceof ApiError && boot.error.status === 404;
  useEffect(() => {
    if (boot.data) rememberLeague(route.leagueId);
    // The temporary league left the site (another one replaced it): open the default next time.
    else if (missing && startLeague() === route.leagueId) rememberLeague(null);
  }, [boot.data, missing, route.leagueId]);
  if (boot.isPending) return <BootScreen />;
  // Only when there's nothing to show: a failed background refresh keeps the app (and open drawers) as they are.
  if (boot.isError && !boot.data) {
    // The static site has only the leagues it built; any other Sleeper league can be added from here.
    const addable = STATIC && missing && /^\d+$/.test(route.leagueId);
    return (
      <div className="mx-auto max-w-lg p-6 pt-24">
        <ErrorState error={addable ? new Error('This league isn’t on the site. Add it below; it takes a minute or two.') : boot.error} onRetry={() => void boot.refetch()} />
        <div className="card mt-4 p-5">
          <YourLeagues onDone={() => undefined} />
          <div className="eyebrow mb-2 mt-5">Open another Sleeper league</div>
          <LeagueLoader onDone={() => undefined} initial={addable ? route.leagueId : ''} />
        </div>
      </div>
    );
  }
  return (
    <AppProvider key={route.leagueId} leagueId={route.leagueId} boot={boot.data}>
      <Shell />
    </AppProvider>
  );
}

function BootScreen() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center text-ink-2">
      <ChartNoAxesCombined size={30} className="animate-pulse text-accent" aria-hidden />
      <div className="text-[15px] font-semibold text-ink">Loading your league</div>
      {slow && <div className="max-w-sm text-[13px]">Loading league data and calculating your custom-scoring forecasts. The first visit can take a little longer.</div>}
    </div>
  );
}

function Shell() {
  const route = useRoute();
  const { boot, leagueId, myTeamId } = useApp();
  const [menu, setMenu] = useState(false);
  const Page = pages[route.page] ?? pages.hub;
  useEffect(() => setMenu(false), [route.page, route.param]);
  useEffect(() => {
    const titles: Partial<Record<Page, string>> = { hub: 'League hub', lineup: 'Start / sit', waivers: 'Waivers', matchups: 'Matchups', power: 'Power rankings', playoffs: 'Playoff odds', players: 'Players', trade: 'Trade lab', recap: 'Season wrapped', history: 'History', model: 'Model lab', defense: 'Defense', team: 'Team', transactions: 'Transactions' };
    document.title = `${titles[route.page] ?? 'SLA'} · ${boot.league.name} · SLA 2.0`;
  }, [route.page, boot.league.name]);
  const needsTeam = ['lineup', 'waivers'].includes(route.page) && myTeamId === null;
  const client = useQueryClient();
  useEffect(() => {
    const t = setTimeout(() => {
      prefetchCore(client, leagueId, myTeamId);
      // Page code, too, so the first visit to each tab doesn't wait on a chunk download.
      for (const page of ['lineup', 'waivers', 'matchups', 'players', 'power', 'playoffs', 'team', 'defense'] as const) void pageModules[page]().catch(() => undefined);
    }, 600);
    return () => clearTimeout(t);
  }, [client, leagueId, myTeamId]);
  // The server rebuilt the league (new injury tags, projections or scores): refresh every page's data.
  const built = useRef(boot.generatedAt);
  useEffect(() => {
    if (built.current === boot.generatedAt) return;
    built.current = boot.generatedAt;
    void client.invalidateQueries({ predicate: q => q.queryKey[1] === leagueId && q.queryKey[0] !== 'bootstrap' });
  }, [client, leagueId, boot.generatedAt]);
  return (
    <div className="flex min-h-dvh">
      <aside className={cx('safe-top safe-bottom fixed inset-y-0 left-0 z-40 w-[248px] shrink-0 border-r border-line bg-surface transition-transform lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0', menu ? 'translate-x-0' : '-translate-x-full')}>
        <Sidebar onClose={() => setMenu(false)} />
      </aside>
      {menu && <div className="fixed inset-0 z-30 bg-[var(--overlay)] lg:hidden" onClick={() => setMenu(false)} aria-hidden />}
      <div className="flex min-w-0 flex-1 flex-col overflow-x-clip">
        <TopBar onMenu={() => setMenu(true)} />
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 pb-16 pt-5 sm:px-6 lg:px-8">
          <Suspense fallback={<PageSkeleton />}>
            {needsTeam ? <PickTeam /> : <Page key={`${leagueId}:${route.page}:${route.param ?? ''}`} />}
          </Suspense>
        </main>
      </div>
      <PlayerDrawer />
    </div>
  );
}

function Sidebar({ onClose }: { onClose: () => void }) {
  const route = useRoute();
  const { leagueId, boot, myTeamId } = useApp();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center justify-between px-4">
        <a href={pathFor(leagueId, 'hub')} onClick={e => { e.preventDefault(); navigate(pathFor(leagueId, 'hub')); }} className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-ink text-page"><ChartNoAxesCombined size={17} aria-hidden /></span>
          <span className="leading-tight">
            <span className="block text-[15px] font-bold tracking-tight">SLA <span className="text-ink-3">2.0</span></span>
            <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">League intelligence</span>
          </span>
        </a>
        <button className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 lg:hidden" onClick={onClose} aria-label="Close menu"><X size={18} /></button>
      </div>
      <nav className="overscroll-contain flex-1 overflow-y-auto px-2.5 pb-4 scroll-thin" aria-label="Main">
        {NAV.map(group => (
          <div key={group.group} className="mt-4">
            <div className="eyebrow px-2.5 pb-1.5">{group.group}</div>
            {group.items.map(item => {
              const target = item.page === 'team' ? pathFor(leagueId, 'team', myTeamId ?? boot.teams[0]?.rosterId) : pathFor(leagueId, item.page);
              const active = route.page === item.page && (item.page !== 'team' || Number(route.param) === myTeamId);
              return (
                <a key={item.page} href={target} onClick={e => { e.preventDefault(); navigate(target); }} aria-current={active ? 'page' : undefined}
                  className={cx('mb-0.5 flex h-9 items-center gap-2.5 rounded-[9px] px-2.5 text-[14px] transition-colors', active ? 'bg-surface-3 font-semibold text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
                  <item.icon size={16} />
                  {item.label}
                </a>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="border-t border-line p-3 text-[12px] text-ink-3">
        <div className="flex items-center gap-1.5"><CalendarDays size={13} aria-hidden /> {boot.league.season} · {boot.league.week ? `Week ${boot.league.week}` : 'Season complete'}</div>
        <div className="mt-1">Model {boot.model?.meta?.version ?? '—'} · trained on {boot.model?.meta?.trainingRows?.toLocaleString('en-US') ?? '—'} player-games</div>
      </div>
    </div>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { boot, myTeamId, setMyTeam } = useApp();
  const [theme, toggle] = useTheme();
  const client = useQueryClient();
  const fetching = useIsFetching();
  const [finder, setFinder] = useState(false);
  const load = useLeagueLoad();
  return (
    <header className="safe-top sticky top-0 z-20 border-b border-line bg-[color-mix(in_oklab,var(--page)_88%,transparent)] backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-2 px-4 sm:px-6 lg:px-8">
        <button className="-ml-1.5 rounded-md p-1.5 text-ink-2 hover:bg-surface-2 lg:hidden" onClick={onMenu} aria-label="Open menu"><Menu size={20} /></button>
        <button onClick={() => setFinder(true)} className="flex min-w-0 items-center gap-2 rounded-[9px] px-2 py-1 text-left hover:bg-surface-2" title="Switch league">
          {boot.league.avatar ? <img src={boot.league.avatar} alt="" className="h-7 w-7 rounded-full" /> : <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-3 text-[11px] font-bold text-ink-2">{boot.league.name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()}</span>}
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-semibold leading-tight">{boot.league.name}</span>
            <span className="block truncate text-[11px] leading-tight text-ink-3">{boot.league.platform === 'espn' ? 'ESPN' : 'Sleeper'} · {boot.league.totalRosters}-team {boot.league.isDynasty ? 'dynasty' : 'redraft'}{boot.league.idpSlots ? ` · ${boot.league.idpSlots} IDP` : ''} · updated {ago(boot.generatedAt)}</span>
          </span>
          {load && load.phase !== 'failed' && <LoaderCircle size={14} className="shrink-0 animate-spin text-ink-3" aria-label={`Adding ${load.name}`} />}
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="hidden items-center gap-2 sm:flex">
            {myTeamId !== null && <TeamAvatar rosterId={myTeamId} size={24} />}
            <Select
              label="Your team"
              value={myTeamId ?? 0}
              onChange={v => setMyTeam(v === 0 ? null : v)}
              options={[{ value: 0, label: 'Choose your team…' }, ...boot.teams.map(t => ({ value: t.rosterId, label: t.name }))]}
              className="w-[210px]"
            />
          </div>
          <Button variant="ghost" size="sm" onClick={() => void client.invalidateQueries()} title="Refresh data">
            <RefreshCw size={15} className={fetching ? 'animate-spin' : ''} aria-hidden /><span className="sr-only">Refresh</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={toggle} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
            {theme === 'dark' ? <Sun size={15} aria-hidden /> : <Moon size={15} aria-hidden />}<span className="sr-only">Toggle theme</span>
          </Button>
        </div>
      </div>
      <div className="border-t border-line px-4 py-2 sm:hidden">
        <Select label="Your team" value={myTeamId ?? 0} onChange={v => setMyTeam(v === 0 ? null : v)} options={[{ value: 0, label: 'Choose your team…' }, ...boot.teams.map(t => ({ value: t.rosterId, label: t.name }))]} className="w-full" />
      </div>
      {finder && <LeagueDialog onClose={() => setFinder(false)} />}
    </header>
  );
}

function PickTeam() {
  const { boot, setMyTeam } = useApp();
  return (
    <div className="mx-auto max-w-xl pt-10">
      <h1 className="text-[24px] font-semibold tracking-tight">Which team is yours?</h1>
      <p className="mt-1 text-ink-2">Start/sit and waiver advice are personal. Pick your team; you can change it any time from the top bar.</p>
      <div className="mt-5 grid gap-2">
        {boot.teams.map(t => (
          <button key={t.rosterId} onClick={() => setMyTeam(t.rosterId)} className="card flex items-center gap-3 p-3 text-left hover:bg-surface-2">
            <TeamAvatar rosterId={t.rosterId} />
            <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{t.name}</span><span className="block text-[12px] text-ink-3">{t.owner} · {t.wins}–{t.losses}</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LeagueDialog({ onClose }: { onClose: () => void }) {
  const dialog = useEscape(onClose);
  const { leagueId, boot } = useApp();
  const current: ConfiguredLeague = { id: leagueId, name: boot.league.name, platform: boot.league.platform, season: boot.league.season, teams: boot.league.totalRosters, dynasty: boot.league.isDynasty };
  // Portal: the sticky, blurred header is its own stacking context and would trap the overlay beneath the page.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay)] p-4 pt-[12vh]" onClick={onClose}>
      {/* Caps the dialog under the keyboard/viewport (iOS zooms while typing in the finder) and scrolls inside. */}
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Switch league" className="card max-h-[min(70vh,32rem)] w-full max-w-md overflow-y-auto overscroll-contain p-5 fade-in" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">Switch league</h2>
          <button onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-surface-2" aria-label="Close"><X size={18} /></button>
        </div>
        <YourLeagues onDone={onClose} current={current} />
        <div className="eyebrow mb-2 mt-5">Open another Sleeper league</div>
        <LeagueLoader onDone={onClose} />
      </div>
    </div>,
    document.body,
  );
}

/**
 * The leagues this deployment is set up for (Sleeper and ESPN), one click away. A league opened by
 * ID or username (`current`, when it isn't one of them) is listed as temporary while it's open.
 */
function YourLeagues({ onDone, current }: { onDone: () => void; current?: ConfiguredLeague }) {
  const leagues = useLeagues();
  // Also shown on the error screen, where no league is open.
  const leagueId = useRoute().leagueId;
  const list: (ConfiguredLeague & { temporary?: boolean })[] = [...(leagues.data ?? [])];
  const temporary = !!current && leagues.isSuccess && !list.some(l => l.id === current.id);
  if (temporary) list.push({ ...current, temporary: true });
  if (!list.length) return null;
  return (
    <div className="space-y-1">
      <div className="eyebrow mb-2">Your leagues</div>
      {list.map(l => (
        <button key={l.id} onClick={() => { onDone(); if (l.id !== leagueId) navigate(pathFor(l.id, 'hub')); }} aria-current={l.id === leagueId ? 'true' : undefined}
          className={cx('flex w-full items-center gap-3 rounded-[9px] p-2 text-left hover:bg-surface-2', l.id === leagueId && 'bg-surface-2')}>
          <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-bold', l.platform === 'espn' ? 'bg-[color-mix(in_oklab,#d00_18%,var(--surface-2))] text-ink' : 'bg-surface-3 text-ink-2')}>{l.platform === 'espn' ? 'ESPN' : 'SLPR'}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{l.name}</span>
            <span className="block text-[12px] text-ink-3">{[l.season, l.teams ? `${l.teams} teams` : null, l.dynasty ? 'dynasty' : 'redraft', l.temporary ? 'temporary' : null].filter(Boolean).join(' · ')}</span>
          </span>
          {l.id === leagueId && <span className="text-[12px] text-ink-3">Current</span>}
        </button>
      ))}
      {temporary && <p className="px-2 pt-1 text-[12px] text-ink-3">{current.name} stays open, here and when you reopen the app, until you switch to another league.</p>}
    </div>
  );
}

/**
 * Opens any Sleeper league by ID, league link or owner username, as a temporary league. The local
 * server builds it on the spot; the static site first adds it with a GitHub Actions build (lib/league-load.ts).
 */
function LeagueLoader({ onDone, initial = '' }: { onDone: () => void; initial?: string }) {
  const [input, setInput] = useState(initial);
  const [result, setResult] = useState<LeagueSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaitingToken, setAwaitingToken] = useState<{ id: string; name: string } | null>(null);
  const token = useToken();
  const load = useLeagueLoad();
  // The token was all that was missing: start the build.
  useEffect(() => {
    if (!awaitingToken || !token) return;
    setAwaitingToken(null);
    void loadLeague(awaitingToken.id, awaitingToken.name);
  }, [awaitingToken, token]);
  const go = (id: string) => { onDone(); navigate(pathFor(id, 'hub')); };
  const open = async (id: string) => {
    if (!STATIC || await isPublished(id)) return go(id);
    if (!/^\d+$/.test(id)) throw new Error('Only Sleeper leagues can be added from here.');
    const league = await sleeperLeague(id);
    if (!githubRepo) throw new Error('This copy of the site can’t add leagues: it isn’t linked to a GitHub repository.');
    if (getToken()) void loadLeague(id, league.name); else setAwaitingToken({ id, name: league.name });
  };
  const run = async (task: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : 'Lookup failed'); } finally { setBusy(false); }
  };
  const submit = () => {
    const v = input.trim();
    // A league link (sleeper.com/leagues/<id>/…) works as well as the bare ID.
    const id = /\/leagues?\/(\d{10,22})/.exec(v)?.[1] ?? v;
    if (isLeagueId(id)) return run(() => open(id));
    if (v) return run(async () => setResult(await searchLeagues(v)));
  };
  if (load) return <LoadProgress load={load} />;
  if (awaitingToken) {
    return (
      <div>
        <TokenSetup intro={`${awaitingToken.name} isn’t on this site yet. To add it, the site starts a build on GitHub.`} />
        <button onClick={() => setAwaitingToken(null)} className="mt-2 text-[12px] text-ink-3 underline hover:text-ink">Cancel</button>
      </div>
    );
  }
  return (
    <div className="w-full">
      <form onSubmit={e => { e.preventDefault(); void submit(); }} className="flex gap-2">
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="Sleeper league ID or username" aria-label="Sleeper league ID or username"
          className="h-9 min-w-0 flex-1 rounded-[9px] border border-line-strong bg-surface px-3 text-[16px] placeholder:text-ink-3" />
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Finding…' : 'Open'}</Button>
      </form>
      {error && <p className="mt-2 text-[13px] text-bad-ink">{error}</p>}
      {result && (
        <div className="mt-3 max-h-72 space-y-1 overflow-y-auto scroll-thin">
          {result.leagues.length === 0 && <p className="text-[13px] text-ink-3">No NFL leagues found for {result.user.name}.</p>}
          {result.leagues.map(l => (
            <button key={l.id} onClick={() => void run(() => open(l.id))} disabled={busy} className="flex w-full items-center gap-3 rounded-[9px] p-2 text-left hover:bg-surface-2">
              {l.avatar ? <img src={l.avatar} alt="" className="h-8 w-8 rounded-full" /> : <span className="h-8 w-8 rounded-full bg-surface-3" />}
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{l.name}</span><span className="block text-[12px] text-ink-3">{l.season} · {l.teams} teams · {l.status.replace('_', ' ')}</span></span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-3 text-[12px] text-ink-3">
        Any Sleeper NFL league works. Custom scoring, IDP and superflex are read from the league’s settings.
        {' '}It opens as a temporary league and stays until you switch to another.{STATIC ? ' One that isn’t on this site yet takes a minute or two to add.' : ''}
      </p>
    </div>
  );
}

const LOAD_STEPS: Record<LeagueLoad['phase'], string> = {
  starting: 'Starting a build on GitHub…',
  waiting: 'Waiting for the site’s current update to finish…',
  building: 'Forecasting every player under the league’s scoring…',
  publishing: 'Publishing to the site…',
  failed: '',
};

/** A temporary league being added to the static site. */
function LoadProgress({ load }: { load: LeagueLoad }) {
  const failed = load.phase === 'failed';
  const [, tick] = useState(0);
  useEffect(() => {
    if (failed) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [failed]);
  const secs = Math.max(0, Math.floor((Date.now() - load.startedAt) / 1000));
  return (
    <div className="rounded-[10px] border border-line p-3">
      <div className="flex items-center gap-2 text-[14px] font-medium">
        {failed ? <CircleX size={16} className="shrink-0 text-bad-ink" aria-hidden /> : <LoaderCircle size={16} className="shrink-0 animate-spin text-ink-3" aria-hidden />}
        <span className="min-w-0 truncate">{failed ? `Couldn’t add ${load.name}` : `Adding ${load.name}`}</span>
      </div>
      <p className={cx('mt-1 text-[13px]', failed ? 'text-bad-ink' : 'text-ink-2')}>{failed ? load.error : LOAD_STEPS[load.phase]}</p>
      {!failed && <p className="mt-1 text-[12px] text-ink-3">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')} · usually a minute or two. It opens by itself when it’s ready, so you can close this.</p>}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-ink-3">
        {load.runUrl && <a href={load.runUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline hover:text-ink">Build on GitHub<ExternalLink size={11} aria-hidden /></a>}
        <button className="underline hover:text-ink" onClick={dismissLeagueLoad}>{failed ? 'Try another league' : 'Stop waiting'}</button>
      </div>
      {failed && load.tokenProblem && <TokenCheck auto />}
    </div>
  );
}
