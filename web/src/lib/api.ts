import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
// Type-only: the server's view functions define the API contract end to end.
import type * as V from '../../../server/views.ts';
import type { trackRecord } from '../../../server/snapshots.ts';
import type * as C from '../../../server/claims.ts';
import { cancelClaim as cancelGitHubClaim, getToken, githubClaims, listClaims, startClaim as startGitHubClaim, type GitHubClaim } from './github.ts';
import { evaluateTrade, TradeError, type TradeKit, type TradeRequest } from '../../../engine/trade.ts';

export type Bootstrap = Awaited<ReturnType<typeof V.bootstrap>>;
export type Overview = Awaited<ReturnType<typeof V.overview>>;
export type Matchups = Awaited<ReturnType<typeof V.matchups>>;
export type Game = Matchups['games'][number];
export type TeamPage = Awaited<ReturnType<typeof V.team>>;
export type Lineup = Awaited<ReturnType<typeof V.lineup>>;
export type LineupReady = Extract<Lineup, { week: number }>;
export type Waivers = Awaited<ReturnType<typeof V.waivers>>;
export type Playoffs = Awaited<ReturnType<typeof V.playoffs>>;
export type Power = Awaited<ReturnType<typeof V.powerView>>;
export type Players = Awaited<ReturnType<typeof V.players>>;
/** A full player row (forecast range, kickoff, live state), as on rosters and lineups. */
export type PlayerRow = TeamPage['roster'][number];
/** The compact row of the long player tables (Players, waiver wire, trade pickers). */
export type ListRow = Players['players'][number];
export type PlayerDetail = Awaited<ReturnType<typeof V.player>>;
export type Trade = Awaited<ReturnType<typeof V.trade>>;
export type Recap = Awaited<ReturnType<typeof V.recap>>;
export type History = Awaited<ReturnType<typeof V.history>>;
export type Transactions = Awaited<ReturnType<typeof V.transactions>>;
export type Defense = Awaited<ReturnType<typeof V.defense>>;
export type Forecast = NonNullable<PlayerRow['week']>;
export interface LeagueSearchResult { user: { id: string; name: string; avatar: string | null }; leagues: { id: string; name: string; season: number; teams: number; avatar: string | null; status: string }[] }

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Static deployment (GitHub Pages): a scheduled job prebuilds every view as a JSON file next to
 * the app (scripts/build-static.ts), so pages load from the CDN with no server to wake up.
 */
export const STATIC = import.meta.env.VITE_STATIC === '1';
const DATA = `${import.meta.env.BASE_URL}data`;
/** Build stamp of each league's files: a new build changes every URL, so nothing stale is reused. */
const builds = new Map<string, string>();

/** The prebuilt file behind an API route, or null for routes that need a live server. */
export function staticUrl(url: string): string | null {
  const u = new URL(url, 'http://local');
  const parts = u.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'model' && parts.length === 1) return `${DATA}/model.json`;
  if (parts[0] === 'espn-logos' && parts.length === 2) return `${DATA}/espn-logos/${encodeURIComponent(parts[1])}`;
  if (parts[0] !== 'leagues') return null;
  if (parts.length === 1) return `${DATA}/leagues.json`;
  const [, id, view, a, b] = parts;
  const dir = `${DATA}/${encodeURIComponent(id)}`;
  // Bootstrap says which build is current, so it is never served from a cache older than a minute.
  if (view === 'bootstrap') return `${dir}/bootstrap.json?t=${Math.floor(Date.now() / 60_000)}`;
  const v = `?v=${encodeURIComponent(builds.get(id) ?? '')}`;
  const week = u.searchParams.get('week'), season = u.searchParams.get('season');
  if (view === 'matchups') return `${dir}/matchups${week ? `-${week}` : ''}.json${v}`;
  if (view === 'defense') return `${dir}/defense${season ? `-${season}` : ''}.json${v}`;
  if (view === 'teams' && a) return `${dir}/${b ? `${b}-${a}` : `team-${a}`}.json${v}`;
  if (view === 'players' && a) return `${dir}/players/${encodeURIComponent(a)}.json${v}`;
  if (view && !a) return `${dir}/${view}.json${v}`;
  return null;
}

/** An image the app serves itself (a copy of an ESPN team logo), at its address in this deployment; other URLs as they are. */
export const imageUrl = (url: string) => (STATIC && url.startsWith('/api/') ? staticUrl(url) ?? url : url);

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  const target = STATIC ? staticUrl(url) : url;
  if (target === null) throw new ApiError(404, 'Not available in this version of the app.');
  try {
    response = await fetch(target, STATIC ? { cache: 'no-cache' } : init);
  } catch {
    throw new ApiError(0, STATIC ? 'Can’t reach the app’s data. Check your connection.' : 'Can’t reach the SLA server. Is it running?');
  }
  const body = await response.json().catch(() => null) as { error?: string; generatedAt?: string; league?: { id?: string } } | null;
  // A static host's SPA fallback answers a missing file with the app page: that's a 404 too.
  const status = STATIC && response.ok && body === null ? 404 : response.status;
  if (status >= 400) throw new ApiError(status, body?.error ?? (STATIC && status === 404 ? 'Not available yet. It appears after the next data refresh.' : `Request failed (${status})`));
  if (STATIC && body?.generatedAt && body.league?.id) builds.set(body.league.id, body.generatedAt);
  return body as T;
}

/** Trades are evaluated in the browser from the league's trade kit when there is no server. */
async function tradeLocally(id: string, body: TradeRequest): Promise<Trade> {
  const [kit, list] = await Promise.all([request<TradeKit>(`${base(id)}/trade-kit`), request<Players>(`${base(id)}/players`)]);
  const rows = new Map(list.players.map(p => [p.id, p]));
  try {
    const r = evaluateTrade(kit, body);
    const side = (s: typeof r.a) => ({ ...s, gives: s.gives.map(pid => rows.get(pid)!).filter(Boolean), gets: s.gets.map(pid => rows.get(pid)!).filter(Boolean) });
    return { ...r, a: side(r.a), b: side(r.b) };
  } catch (error) {
    if (error instanceof TradeError) throw new ApiError(400, error.message);
    throw error;
  }
}

const base = (id: string) => `/api/leagues/${id}`;
const MIN = 60_000;

/** Warm the pages people open most, so switching tabs is instant. */
export function prefetchCore(client: QueryClient, id: string, rosterId: number | null) {
  const jobs: [unknown[], string][] = [
    [['overview', id], `${base(id)}/overview`],
    [['matchups', id, 'current'], `${base(id)}/matchups`],
    [['players', id], `${base(id)}/players`],
    [['power', id], `${base(id)}/power`],
    [['playoffs', id], `${base(id)}/playoffs`],
  ];
  if (rosterId !== null) {
    jobs.unshift([['lineup', id, rosterId], `${base(id)}/teams/${rosterId}/lineup`]);
    jobs.push([['team', id, rosterId], `${base(id)}/teams/${rosterId}`], [['waivers', id, rosterId], `${base(id)}/teams/${rosterId}/waivers`]);
  }
  // Sequential: a small server CPU answers one at a time anyway.
  void (async () => {
    for (const [queryKey, url] of jobs) {
      await client.prefetchQuery({ queryKey, queryFn: () => request(url), staleTime: MIN }).catch(() => undefined);
    }
  })();
}

export const useBootstrap = (id: string) => useQuery({ queryKey: ['bootstrap', id], queryFn: () => request<Bootstrap>(`${base(id)}/bootstrap`), staleTime: 30_000, refetchInterval: MIN });
export const useOverview = (id: string) => useQuery({ queryKey: ['overview', id], queryFn: () => request<Overview>(`${base(id)}/overview`), staleTime: MIN, refetchInterval: 2 * MIN });
export const useMatchups = (id: string, week?: number) => useQuery({ queryKey: ['matchups', id, week ?? 'current'], queryFn: () => request<Matchups>(`${base(id)}/matchups${week ? `?week=${week}` : ''}`), staleTime: MIN, refetchInterval: 90_000, placeholderData: prev => prev });
export const useTeam = (id: string, rid: number | null) => useQuery({ queryKey: ['team', id, rid], queryFn: () => request<TeamPage>(`${base(id)}/teams/${rid}`), enabled: rid !== null, staleTime: MIN });
export const useLineup = (id: string, rid: number | null) => useQuery({ queryKey: ['lineup', id, rid], queryFn: () => request<Lineup>(`${base(id)}/teams/${rid}/lineup`), enabled: rid !== null, staleTime: 30_000, refetchInterval: 90_000 });
export const useWaivers = (id: string, rid: number | null) => useQuery({ queryKey: ['waivers', id, rid], queryFn: () => request<Waivers>(`${base(id)}/teams/${rid}/waivers`), enabled: rid !== null, staleTime: 2 * MIN });
export const usePlayoffs = (id: string) => useQuery({ queryKey: ['playoffs', id], queryFn: () => request<Playoffs>(`${base(id)}/playoffs`), staleTime: 2 * MIN });
export const usePower = (id: string) => useQuery({ queryKey: ['power', id], queryFn: () => request<Power>(`${base(id)}/power`), staleTime: 2 * MIN });
export const usePlayers = (id: string) => useQuery({ queryKey: ['players', id], queryFn: () => request<Players>(`${base(id)}/players`), staleTime: 2 * MIN });
export const usePlayer = (id: string, pid: string | null) => useQuery({ queryKey: ['player', id, pid], queryFn: () => request<PlayerDetail>(`${base(id)}/players/${pid}`), enabled: !!pid, staleTime: 2 * MIN });
export const useRecap = (id: string) => useQuery({ queryKey: ['recap', id], queryFn: () => request<Recap>(`${base(id)}/recap`), staleTime: 5 * MIN });
export const useHistory = (id: string) => useQuery({ queryKey: ['history', id], queryFn: () => request<History>(`${base(id)}/history`), staleTime: 30 * MIN });
export const useTransactions = (id: string) => useQuery({ queryKey: ['transactions', id], queryFn: () => request<Transactions>(`${base(id)}/transactions`), staleTime: 2 * MIN });
export const useDefense = (id: string, season?: number) => useQuery({ queryKey: ['defense', id, season ?? 'default'], queryFn: () => request<Defense>(`${base(id)}/defense${season ? `?season=${season}` : ''}`), staleTime: 10 * MIN, placeholderData: prev => prev });
export const useModel = (id: string) => useQuery({ queryKey: ['model', id], queryFn: () => request<ModelReport>(`${base(id)}/model`), staleTime: 30 * MIN });
export type ConfiguredLeague = Awaited<ReturnType<typeof V.configuredLeagues>>[number];
export const useLeagues = () => useQuery({ queryKey: ['leagues'], queryFn: () => request<ConfiguredLeague[]>('/api/leagues'), staleTime: 30 * MIN });
export const useTracking = (id: string) => useQuery({ queryKey: ['tracking', id], queryFn: () => request<Tracking>(`${base(id)}/tracking`), staleTime: 10 * MIN });
export const useTrade = (id: string) => useMutation({
  mutationFn: (body: TradeRequest) => (STATIC ? tradeLocally(id, body) : request<Trade>(`${base(id)}/trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })),
});
/**
 * ESPN claims. With the local server (npm run dev) the server makes the move with the ESPN login.
 * On the static site the page starts .github/workflows/claim.yml with the owner's GitHub token
 * (web/src/lib/github.ts) and sets up the claim from data the build published (claims.json).
 */
export type ClaimInfo = Awaited<ReturnType<typeof C.claimInfo>>;
export type ClaimJob = C.ClaimJob;
export type ClaimSnapshot = Awaited<ReturnType<typeof C.claimSnapshot>>;
/** A claim as the panel shows it: a local server job, or a GitHub Actions run. */
export interface ClaimJobView {
  id: string; add: { espnId: number; name: string }; drop: { name: string } | null; keepPriority: boolean;
  status: ClaimJob['status']; phase: ClaimJob['phase'] | 'queued' | 'running'; result: string | null;
  log: { at: number; msg: string }[]; createdAt: number; updatedAt: number; url?: string;
}
export type ClaimInfoView = Omit<ClaimInfo, 'jobs'> & { jobs: ClaimJobView[]; jobsError: string | null };
export const CLAIMS_AVAILABLE = !STATIC || githubClaims;

const fromGitHub = (c: GitHubClaim): ClaimJobView => ({
  id: c.id, add: { espnId: c.addEspnId, name: c.addName }, drop: c.dropName ? { name: c.dropName } : null, keepPriority: c.mode === 'keep',
  status: c.status, phase: c.phase, result: c.result, log: [], createdAt: c.createdAt, updatedAt: c.updatedAt, url: c.url,
});

/** The static site's version of the server's claim info: published roster data, plus your claims' runs on GitHub. */
async function staticClaimInfo(id: string, pid: string | null, player?: { owner: number | null; name: string }): Promise<ClaimInfoView> {
  const snap = await request<ClaimSnapshot>(`${base(id)}/claims`);
  let jobs: ClaimJobView[] = [], jobsError: string | null = null;
  if (getToken()) {
    try { jobs = (await listClaims(id)).map(fromGitHub); } catch (error) { jobsError = (error as Error).message; }
  }
  let target: ClaimInfo['target'] = null;
  if (pid) {
    const espnId = snap.espnIds[pid];
    if (espnId === undefined) throw new ApiError(404, 'ESPN doesn’t list this player.');
    const owner = player?.owner ?? null;
    const waiver = String(espnId) in snap.waivers;
    target = {
      pid, espnId, name: player?.name ?? pid, status: owner ? 'ONTEAM' : waiver ? 'WAIVERS' : 'FREEAGENT', onTeamId: owner ?? 0,
      waiverProcessDate: !owner && waiver ? snap.waivers[String(espnId)] : null,
      mine: owner === snap.teamId, pendingClaim: false, suggestedDrop: snap.suggestedDrops[pid] ?? null,
    };
  }
  return {
    mode: 'github', asOf: snap.builtAt, dryRun: false, teamId: snap.teamId, teamName: snap.teamName, freeAgency: snap.freeAgency, budget: snap.budget,
    rosterLimit: snap.rosterLimit, openSpots: snap.openSpots, roster: snap.roster, target, jobs, jobsError,
  };
}

export const useClaimInfo = (id: string, pid: string | null, opts: { enabled?: boolean; player?: { owner: number | null; name: string }; token?: string | null } = {}) => useQuery({
  queryKey: ['claims', id, pid ?? 'all', STATIC ? !!opts.token : 'server'],
  queryFn: (): Promise<ClaimInfoView> => (STATIC ? staticClaimInfo(id, pid, opts.player)
    : request<ClaimInfo>(`${base(id)}/claims${pid ? `?player=${encodeURIComponent(pid)}` : ''}`).then(info => ({ ...info, jobsError: null }))),
  enabled: (opts.enabled ?? true) && CLAIMS_AVAILABLE, staleTime: 5_000,
  refetchInterval: q => (q.state.data?.jobs.some(j => j.status === 'active') ? (STATIC ? 10_000 : 5_000) : STATIC ? 60_000 : 30_000),
});

export interface StartClaim { pid: string; espnId: number; name: string; drop: { espnId: number; name: string } | null; bid: number; keepPriority: boolean; watch: boolean }
export const useStartClaim = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (c: StartClaim): Promise<unknown> => (STATIC
      ? startGitHubClaim({ league: id, add: c.espnId, addName: c.name, drop: c.drop, bid: c.bid, keepPriority: c.keepPriority, watch: c.watch })
      : request<ClaimJob>(`${base(id)}/claims`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player: c.pid, drop: c.drop?.espnId ?? null, bid: c.bid, keepPriority: c.keepPriority } satisfies C.ClaimRequest) })),
    onSettled: () => client.invalidateQueries({ queryKey: ['claims', id] }),
  });
};
export const useCancelClaim = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (job: string): Promise<unknown> => (STATIC ? cancelGitHubClaim(job) : request<ClaimJob>(`${base(id)}/claims/${encodeURIComponent(job)}`, { method: 'DELETE' })),
    onSettled: () => client.invalidateQueries({ queryKey: ['claims', id] }),
  });
};

/** The local server re-checks the league's inputs now (Refresh); the static site rebuilds instead (lib/site-build.ts). */
export const refreshLeague = (id: string) => request<{ generatedAt: string }>(`${base(id)}/refresh`, { method: 'POST' });
/** Local server: save a Sleeper league opened by ID in config/sleeper.json, or remove it (the static site does this in a build). */
export const saveLeagueLocally = (id: string) => request<{ ok: boolean }>(`${base(id)}/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
export const forgetLeagueLocally = (id: string) => request<{ ok: boolean }>(`${base(id)}/save`, { method: 'DELETE' });

// ─── Sleeper lookups from the browser ────────────────────────────────────────
// The static site has no server: it asks Sleeper directly (Sleeper allows cross-origin requests).

const SLEEPER = 'https://api.sleeper.app/v1';
type Row = Record<string, unknown> | null;
async function sleeperJson<T>(path: string): Promise<T> {
  let response: Response;
  try { response = await fetch(`${SLEEPER}${path}`); } catch { throw new ApiError(0, 'Can’t reach Sleeper. Check your connection.'); }
  if (!response.ok) throw new ApiError(response.status, `Sleeper error ${response.status}. Try again in a moment.`);
  return await response.json() as T;
}
type SleeperLeagueInfo = LeagueSearchResult['leagues'][number];
const leagueInfo = (row: NonNullable<Row>): SleeperLeagueInfo => ({
  id: String(row.league_id ?? ''), name: String(row.name ?? 'League'), season: Number(row.season), teams: Number(row.total_rosters),
  avatar: row.avatar ? `https://sleepercdn.com/avatars/thumbs/${String(row.avatar)}` : null, status: String(row.status ?? ''),
});

/** A Sleeper league's name and size, to check an ID before building it. */
export async function sleeperLeague(id: string): Promise<SleeperLeagueInfo> {
  const row = await sleeperJson<Row>(`/league/${encodeURIComponent(id)}`);
  if (!row) throw new ApiError(404, 'League not found. Check the league ID.');
  if (row.sport !== 'nfl') throw new ApiError(400, 'Only NFL leagues are supported.');
  return leagueInfo(row);
}

/** A Sleeper user's NFL leagues this season and last (the server's findLeagues, on the static site). */
export async function searchLeagues(username: string): Promise<LeagueSearchResult> {
  if (!STATIC) return request<LeagueSearchResult>(`/api/users/${encodeURIComponent(username)}/leagues`);
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(username)) throw new ApiError(400, 'Enter a Sleeper username or league ID.');
  const user = await sleeperJson<Row>(`/user/${encodeURIComponent(username)}`);
  if (!user?.user_id) throw new ApiError(404, 'Sleeper user not found. Check the username.');
  const state = await sleeperJson<{ season?: string; league_season?: string }>('/state/nfl');
  const season = Number(state.league_season || state.season);
  const lists = await Promise.all([season, season - 1].map(s => sleeperJson<Row[] | null>(`/user/${String(user.user_id)}/leagues/nfl/${s}`).catch(() => null)));
  return {
    user: { id: String(user.user_id), name: String(user.display_name ?? username), avatar: user.avatar ? `https://sleepercdn.com/avatars/thumbs/${String(user.avatar)}` : null },
    leagues: lists.flatMap(list => (list ?? []).filter(row => row !== null).map(leagueInfo)).filter(l => l.id),
  };
}

export interface Metrics { n: number; mae: number; rmse: number; bias: number; spearman: number; pairAcc: number; pairs: number; closePairAcc: number; closePairs: number; byPos: Record<string, { mae: number; n: number; bias: number; pairAcc: number }> }
export interface ModelReport {
  key: string;
  meta: { league?: string | null; key?: string; version: string; trainedAt: string; trainingRows: number; seasons: number[]; params: Record<string, number>; iterations: number };
  holdout2025: Record<'model' | 'provider' | 'linear' | 'form', Metrics>;
  live2026: Record<'model' | 'provider' | 'linear' | 'form', Metrics> | null;
  /** 2026 weeks scored out of sample. */
  live2026Weeks?: number[];
  maeDeltaCI2025: [number, number];
  coverage80: Record<string, number>;
  availability: {
    none: number; Questionable: number; Doubtful: number; Out: number; n: Record<string, number>;
    roles?: { Questionable?: { starter: number; reserve: number } };
  };
  importance: { feature: string; share: number }[];
  cohort: Record<string, number>;
  lineupBacktest?: {
    season: number; teamWeeks: number;
    perTeamWeek: { model: number; provider: number; manager: number; optimal: number };
    modelMinusProvider: number; modelMinusProviderCI?: [number, number]; modelMinusManager: number; modelBeatProvider: number; providerBeatModel: number;
    captureRate: { model: number; provider: number; manager: number };
    resultFlipsVsManager: { flips: number; games: number };
    byWeek: { week: number; model: number; provider: number; manager: number; optimal: number }[];
    parity: { checked: number; maxDiff: number };
  };
}
export type Tracking = Awaited<ReturnType<typeof trackRecord>>;
