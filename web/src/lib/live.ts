/**
 * Live scoring between data builds. The static deployment rebuilds every 10–15 minutes during
 * games; in between, the browser reads Sleeper's live stat lines and game status itself (both
 * allow cross-origin requests), scores each starter with the league's rules (the engine's own
 * scoring code) and moves points, live projections and win odds along.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { normalizeTeam } from '../../../engine/positions.ts';
import { cleanProviderStats, compileScoring } from '../../../engine/scoring.ts';
import type { Stats } from '../../../engine/types.ts';
import { STATIC, type Game } from './api.ts';
import { useApp } from './context.tsx';
import { applyLive, type LiveStatus, type LiveWeek } from './live-score.ts';

const SLEEPER = 'https://api.sleeper.com';
const WINDOW = 4.5 * 3600_000;

async function loadLiveWeek(season: number, week: number): Promise<LiveWeek> {
  const [rows, schedule] = await Promise.all([
    fetch(`${SLEEPER}/stats/nfl/${season}/${week}?season_type=regular`).then(r => (r.ok ? r.json() : [])) as Promise<unknown[]>,
    fetch(`${SLEEPER}/schedule/nfl/regular/${season}`).then(r => (r.ok ? r.json() : [])) as Promise<unknown[]>,
  ]);
  const lines = new Map<string, Stats>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = row as { player_id?: unknown; stats?: unknown };
    if (typeof r.player_id !== 'string') continue;
    const stats = cleanProviderStats(r.stats);
    if (Object.keys(stats).length) lines.set(r.player_id, stats);
  }
  const status = new Map<string, LiveStatus>();
  for (const g of Array.isArray(schedule) ? schedule : []) {
    const x = g as { week?: unknown; home?: unknown; away?: unknown; status?: unknown };
    if (Number(x.week) !== week) continue;
    const st: LiveStatus = x.status === 'complete' ? 'complete' : x.status === 'in_game' ? 'in_game' : 'pre_game';
    for (const t of [x.home, x.away]) { const team = normalizeTeam(typeof t === 'string' ? t : null); if (team) status.set(team, st); }
  }
  return { lines, status, at: Date.now() };
}

/** Re-render every `ms` so time-based state (game windows, "updated … ago") stays current. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * This week's games with live scoring applied, plus when the live lines were fetched (null when
 * no game is on, outside the static deployment, or for another week).
 */
export function useLiveGames<G extends Game>(games: readonly G[], week: number | null): { games: G[]; at: number | null } {
  const { boot } = useApp();
  const now = useNow(30_000);
  const current = STATIC && week !== null && week === boot.league.week;
  // Poll only while a starter's game is under way (or kicked off within the last 4.5 hours).
  const inWindow = current && games.some(g => [g.a, g.b].some(s => s?.lineup.some(p => p.forecast?.kickoff && p.forecast.kickoff <= now && now - p.forecast.kickoff < WINDOW)));
  const q = useQuery({
    queryKey: ['live', boot.league.season, week],
    queryFn: () => loadLiveWeek(boot.league.season, week!),
    enabled: inWindow,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    retry: 1,
  });
  const scoring = useMemo(() => compileScoring(boot.league.scoring as Record<string, number>), [boot.league.scoring]);
  const live = inWindow ? q.data : undefined;
  const out = useMemo(() => (live ? games.map(g => applyLive(g, live, scoring, Date.now())) : [...games]), [games, live, scoring]);
  return { games: out, at: live?.at ?? null };
}

/**
 * Each roster's starters as Sleeper has them right now, to spot lineups set after the data was
 * built (static site, Sleeper leagues, the current week only).
 */
export function useSleeperStarters(week: number | null) {
  const { boot, leagueId } = useApp();
  return useQuery({
    queryKey: ['sleeper-starters', leagueId, week],
    queryFn: async () => {
      const rows = await fetch(`${SLEEPER}/v1/league/${leagueId}/matchups/${week}`).then(r => (r.ok ? r.json() : [])) as unknown;
      const starters = new Map<number, string[]>();
      for (const row of Array.isArray(rows) ? rows : []) {
        const r = row as { roster_id?: unknown; starters?: unknown };
        if (typeof r.roster_id === 'number' && Array.isArray(r.starters)) starters.set(r.roster_id, r.starters.filter((s): s is string => typeof s === 'string' && s !== '0'));
      }
      return starters;
    },
    enabled: STATIC && boot.league.platform === 'sleeper' && week !== null && week === boot.league.week,
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}
