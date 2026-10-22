import { useCallback, useSyncExternalStore } from 'react';

export const DEFAULT_LEAGUE = '1312656463549726720';
/** Sleeper league ids are long numbers; ESPN leagues are `espn-<id>` (optionally `-<season>`). */
export const isLeagueId = (id: string) => /^(\d{10,22}|espn-\d{4,12}(-\d{4})?)$/.test(id);

export type Page =
  | 'hub' | 'lineup' | 'waivers' | 'matchups' | 'power' | 'playoffs' | 'players'
  | 'trade' | 'recap' | 'history' | 'model' | 'defense' | 'team' | 'teams' | 'transactions';

const PAGES = new Set<Page>(['hub', 'lineup', 'waivers', 'matchups', 'power', 'playoffs', 'players', 'trade', 'recap', 'history', 'model', 'defense', 'team', 'teams', 'transactions']);

export interface Route { leagueId: string; page: Page; param: string | null; search: URLSearchParams }

/** Where the app is served from: '' locally, '/SLA2' on GitHub Pages. */
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');
const appPath = () => {
  const p = window.location.pathname;
  return BASE && p.startsWith(BASE) ? p.slice(BASE.length) || '/' : p;
};
/** True when the address is a league page (anything else redirects to the start league). */
export const atLeagueRoute = () => appPath().startsWith('/league/');

const LAST_LEAGUE = 'sla-league';
/**
 * The league the app opens to: the one open last time, so a temporary league (one opened by ID
 * or username) stays until you switch to another; the configured default before that.
 */
export function startLeague(): string {
  try {
    const id = localStorage.getItem(LAST_LEAGUE);
    if (id && isLeagueId(id)) return id;
  } catch { /* storage optional */ }
  return DEFAULT_LEAGUE;
}
/** Called once a league loads (and with null when the remembered one is gone). */
export function rememberLeague(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_LEAGUE, id); else localStorage.removeItem(LAST_LEAGUE);
  } catch { /* storage optional */ }
}

function parse(): Route {
  const parts = appPath().split('/').filter(Boolean);
  const search = new URLSearchParams(window.location.search);
  if (parts[0] === 'league' && parts[1] && isLeagueId(parts[1])) {
    const page = (PAGES.has(parts[2] as Page) ? parts[2] : 'hub') as Page;
    return { leagueId: parts[1], page, param: parts[3] ?? null, search };
  }
  return { leagueId: startLeague(), page: 'hub', param: null, search };
}

let current = parse();
const listeners = new Set<() => void>();
const emit = () => { current = parse(); listeners.forEach(l => l()); };
window.addEventListener('popstate', emit);

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (to === window.location.pathname + window.location.search) return;
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  emit();
  if (!options.replace && !to.includes('player=')) window.scrollTo({ top: 0 });
}

export function useRoute(): Route {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => current);
}

export const pathFor = (leagueId: string, page: Page, param?: string | number | null) =>
  `${BASE}/league/${leagueId}/${page}${param !== undefined && param !== null ? `/${param}` : ''}`;

/** Read/write a single query parameter without losing the others. */
export function useSearchParam(name: string): [string | null, (value: string | null, replace?: boolean) => void] {
  const route = useRoute();
  const value = route.search.get(name);
  const set = useCallback((next: string | null, replace = false) => {
    const params = new URLSearchParams(window.location.search);
    if (next === null) params.delete(name); else params.set(name, next);
    const qs = params.toString();
    navigate(`${window.location.pathname}${qs ? `?${qs}` : ''}`, { replace });
  }, [name]);
  return [value, set];
}
