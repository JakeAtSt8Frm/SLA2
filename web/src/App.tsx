import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight, BarChart3, BookOpen, CalendarDays, ChartNoAxesCombined, FlaskConical, History, LayoutDashboard, ListChecks,
  Menu, Moon, RefreshCw, ScrollText, Search, Sparkles, Sun, Swords, Trophy, UserPlus, Users, X,
} from 'lucide-react';
import { searchLeagues, useBootstrap, type LeagueSearchResult } from './lib/api.ts';
import { AppProvider, useApp, useTheme } from './lib/context.tsx';
import { ago } from './lib/format.ts';
import { DEFAULT_LEAGUE, navigate, pathFor, useRoute, type Page } from './lib/router.ts';
import { Button, cx, ErrorState, PageSkeleton, Select, TeamAvatar, useEscape } from './components/ui.tsx';
import { PlayerDrawer } from './components/PlayerDrawer.tsx';

const pages: Record<Page, ComponentType> = {
  hub: lazy(() => import('./pages/Hub.tsx')),
  lineup: lazy(() => import('./pages/Lineup.tsx')),
  waivers: lazy(() => import('./pages/Waivers.tsx')),
  matchups: lazy(() => import('./pages/Matchups.tsx')),
  power: lazy(() => import('./pages/Power.tsx')),
  playoffs: lazy(() => import('./pages/Playoffs.tsx')),
  players: lazy(() => import('./pages/Players.tsx')),
  trade: lazy(() => import('./pages/Trade.tsx')),
  recap: lazy(() => import('./pages/Recap.tsx')),
  history: lazy(() => import('./pages/History.tsx')),
  model: lazy(() => import('./pages/ModelLab.tsx')),
  scoring: lazy(() => import('./pages/Scoring.tsx')),
  team: lazy(() => import('./pages/Team.tsx')),
  teams: lazy(() => import('./pages/Team.tsx')),
  transactions: lazy(() => import('./pages/Transactions.tsx')),
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
    { page: 'transactions', label: 'Transactions', icon: ScrollText },
    { page: 'model', label: 'Model lab', icon: FlaskConical },
    { page: 'scoring', label: 'Scoring rules', icon: BookOpen },
  ] },
];

export function App() {
  const route = useRoute();
  useEffect(() => {
    if (window.location.pathname === '/' || !window.location.pathname.startsWith('/league/')) navigate(pathFor(DEFAULT_LEAGUE, 'hub'), { replace: true });
  }, []);
  const boot = useBootstrap(route.leagueId);
  if (boot.isPending) return <BootScreen />;
  if (boot.isError) {
    return (
      <div className="mx-auto max-w-lg p-6 pt-24">
        <ErrorState error={boot.error} onRetry={() => void boot.refetch()} />
        <div className="mt-4 flex justify-center"><LeagueFinder onDone={() => undefined} /></div>
      </div>
    );
  }
  return (
    <AppProvider leagueId={route.leagueId} boot={boot.data}>
      <Shell />
    </AppProvider>
  );
}

function BootScreen() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 text-ink-2">
      <ChartNoAxesCombined size={30} className="text-accent" aria-hidden />
      <div className="text-[15px] font-semibold text-ink">Loading your league</div>
      <div className="text-[13px]">Scoring every player with your league’s rules…</div>
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
    const titles: Partial<Record<Page, string>> = { hub: 'League hub', lineup: 'Start / sit', waivers: 'Waivers', matchups: 'Matchups', power: 'Power rankings', playoffs: 'Playoff odds', players: 'Players', trade: 'Trade lab', recap: 'Season wrapped', history: 'History', model: 'Model lab', scoring: 'Scoring', team: 'Team', transactions: 'Transactions' };
    document.title = `${titles[route.page] ?? 'SLA'} · ${boot.league.name} · SLA 2.0`;
  }, [route.page, boot.league.name]);
  const needsTeam = ['lineup', 'waivers'].includes(route.page) && myTeamId === null;
  return (
    <div className="flex min-h-dvh">
      <aside className={cx('fixed inset-y-0 left-0 z-40 w-[248px] shrink-0 border-r border-line bg-surface transition-transform lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0', menu ? 'translate-x-0' : '-translate-x-full')}>
        <Sidebar onClose={() => setMenu(false)} />
      </aside>
      {menu && <div className="fixed inset-0 z-30 bg-[var(--overlay)] lg:hidden" onClick={() => setMenu(false)} aria-hidden />}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMenu(true)} />
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 pb-16 pt-5 sm:px-6 lg:px-8">
          {boot.warnings.length > 0 && (
            <div className="mb-4 space-y-2">{boot.warnings.map(w => <div key={w} className="rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-[13px] text-ink-2">{w}</div>)}</div>
          )}
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
      <nav className="flex-1 overflow-y-auto px-2.5 pb-4 scroll-thin" aria-label="Main">
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
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-[color-mix(in_oklab,var(--page)_88%,transparent)] backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-2 px-4 sm:px-6 lg:px-8">
        <button className="-ml-1.5 rounded-md p-1.5 text-ink-2 hover:bg-surface-2 lg:hidden" onClick={onMenu} aria-label="Open menu"><Menu size={20} /></button>
        <button onClick={() => setFinder(true)} className="flex min-w-0 items-center gap-2 rounded-[9px] px-2 py-1 text-left hover:bg-surface-2" title="Switch league">
          {boot.league.avatar ? <img src={boot.league.avatar} alt="" className="h-7 w-7 rounded-full" /> : <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-3 text-[11px] font-bold text-ink-2">{boot.league.name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()}</span>}
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-semibold leading-tight">{boot.league.name}</span>
            <span className="block truncate text-[11px] leading-tight text-ink-3">{boot.league.totalRosters}-team {boot.league.isDynasty ? 'dynasty' : 'redraft'} · {boot.league.idpSlots} IDP · updated {ago(boot.generatedAt)}</span>
          </span>
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
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay)] p-4 pt-[12vh]" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Switch league" className="card w-full max-w-md p-5 fade-in" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">Switch league</h2>
          <button onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-surface-2" aria-label="Close"><X size={18} /></button>
        </div>
        <LeagueFinder onDone={onClose} />
      </div>
    </div>
  );
}

function LeagueFinder({ onDone }: { onDone: () => void }) {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<LeagueSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = (id: string) => { onDone(); navigate(pathFor(id, 'hub')); };
  const submit = async () => {
    const v = input.trim();
    setError(null);
    if (/^\d{10,22}$/.test(v)) return go(v);
    if (!v) return;
    setBusy(true);
    try { setResult(await searchLeagues(v)); } catch (e) { setError(e instanceof Error ? e.message : 'Lookup failed'); } finally { setBusy(false); }
  };
  return (
    <div className="w-full">
      <form onSubmit={e => { e.preventDefault(); void submit(); }} className="flex gap-2">
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="Sleeper username or league ID" aria-label="Sleeper username or league ID"
          className="h-9 min-w-0 flex-1 rounded-[9px] border border-line-strong bg-surface px-3 text-[14px] placeholder:text-ink-3" />
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Finding…' : 'Go'}</Button>
      </form>
      {error && <p className="mt-2 text-[13px] text-bad-ink">{error}</p>}
      {result && (
        <div className="mt-3 max-h-72 space-y-1 overflow-y-auto scroll-thin">
          {result.leagues.length === 0 && <p className="text-[13px] text-ink-3">No NFL leagues found for {result.user.name}.</p>}
          {result.leagues.map(l => (
            <button key={l.id} onClick={() => go(l.id)} className="flex w-full items-center gap-3 rounded-[9px] p-2 text-left hover:bg-surface-2">
              {l.avatar ? <img src={l.avatar} alt="" className="h-8 w-8 rounded-full" /> : <span className="h-8 w-8 rounded-full bg-surface-3" />}
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{l.name}</span><span className="block text-[12px] text-ink-3">{l.season} · {l.teams} teams · {l.status.replace('_', ' ')}</span></span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-3 text-[12px] text-ink-3">Any Sleeper NFL league works. Custom scoring, IDP and superflex are read from the league’s settings.</p>
    </div>
  );
}
