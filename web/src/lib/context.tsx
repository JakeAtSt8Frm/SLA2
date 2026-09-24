import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Bootstrap } from './api.ts';
import { useSearchParam } from './router.ts';

/** The owner this build is configured for; their team is picked by default. */
const DEFAULT_OWNER = 'JakeAtSt8Frm';

type Team = Bootstrap['teams'][number];
interface AppState {
  leagueId: string;
  boot: Bootstrap;
  teams: Map<number, Team>;
  myTeamId: number | null;
  setMyTeam: (id: number | null) => void;
  openPlayer: (id: string) => void;
  teamName: (rosterId: number | null | undefined) => string;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ leagueId, boot, children }: { leagueId: string; boot: Bootstrap; children: ReactNode }) {
  const storageKey = `sla-team-${leagueId}`;
  const [myTeamId, setMyTeamId] = useState<number | null>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) return saved === '' ? null : Number(saved);
    } catch { /* storage optional */ }
    return boot.teams.find(t => t.owner === DEFAULT_OWNER)?.rosterId ?? null;
  });
  useEffect(() => {
    if (myTeamId !== null && !boot.teams.some(t => t.rosterId === myTeamId)) setMyTeamId(null);
  }, [boot.teams, myTeamId]);
  const setMyTeam = useCallback((id: number | null) => {
    setMyTeamId(id);
    try { localStorage.setItem(storageKey, id === null ? '' : String(id)); } catch { /* storage optional */ }
  }, [storageKey]);
  const [, setPlayer] = useSearchParam('player');
  const openPlayer = useCallback((id: string) => setPlayer(id), [setPlayer]);
  const teams = useMemo(() => new Map(boot.teams.map(t => [t.rosterId, t])), [boot.teams]);
  const teamName = useCallback((rid: number | null | undefined) => (rid ? teams.get(rid)?.name ?? `Team ${rid}` : 'Free agent'), [teams]);
  const value = useMemo(() => ({ leagueId, boot, teams, myTeamId, setMyTeam, openPlayer, teamName }), [leagueId, boot, teams, myTeamId, setMyTeam, openPlayer, teamName]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

export function useTheme(): ['light' | 'dark', () => void] {
  const system = () => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme as 'light' | 'dark' | undefined) ?? system());
  const toggle = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('sla-theme', next); } catch { /* storage optional */ }
    setTheme(next);
  }, [theme]);
  return [theme, toggle];
}
