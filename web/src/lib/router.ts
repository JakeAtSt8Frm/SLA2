import { useCallback, useSyncExternalStore } from 'react';

export const DEFAULT_LEAGUE = '1312656463549726720';

export type Page =
  | 'hub' | 'lineup' | 'waivers' | 'matchups' | 'power' | 'playoffs' | 'players'
  | 'trade' | 'recap' | 'history' | 'model' | 'scoring' | 'team' | 'teams' | 'transactions';

const PAGES = new Set<Page>(['hub', 'lineup', 'waivers', 'matchups', 'power', 'playoffs', 'players', 'trade', 'recap', 'history', 'model', 'scoring', 'team', 'teams', 'transactions']);

export interface Route { leagueId: string; page: Page; param: string | null; search: URLSearchParams }

function parse(): Route {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const search = new URLSearchParams(window.location.search);
  if (parts[0] === 'league' && parts[1] && /^\d{10,22}$/.test(parts[1])) {
    const page = (PAGES.has(parts[2] as Page) ? parts[2] : 'hub') as Page;
    return { leagueId: parts[1], page, param: parts[3] ?? null, search };
  }
  return { leagueId: DEFAULT_LEAGUE, page: 'hub', param: null, search };
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
  `/league/${leagueId}/${page}${param !== undefined && param !== null ? `/${param}` : ''}`;

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
