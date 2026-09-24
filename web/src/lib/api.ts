import { useMutation, useQuery } from '@tanstack/react-query';
// Type-only: the server's view functions define the API contract end to end.
import type * as V from '../../../server/views.ts';

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
export type PlayerRow = Players['players'][number];
export type PlayerDetail = Awaited<ReturnType<typeof V.player>>;
export type Trade = Awaited<ReturnType<typeof V.trade>>;
export type Recap = Awaited<ReturnType<typeof V.recap>>;
export type History = Awaited<ReturnType<typeof V.history>>;
export type Transactions = Awaited<ReturnType<typeof V.transactions>>;
export type Forecast = NonNullable<PlayerRow['week']>;
export interface LeagueSearchResult { user: { id: string; name: string; avatar: string | null }; leagues: { id: string; name: string; season: number; teams: number; avatar: string | null; status: string }[] }

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'Can’t reach the SLA server. Is it running?');
  }
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new ApiError(response.status, body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

const base = (id: string) => `/api/leagues/${id}`;
const MIN = 60_000;

export const useBootstrap = (id: string) => useQuery({ queryKey: ['bootstrap', id], queryFn: () => request<Bootstrap>(`${base(id)}/bootstrap`), staleTime: MIN, refetchInterval: 2 * MIN });
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
export const useModel = () => useQuery({ queryKey: ['model'], queryFn: () => request<ModelReport>('/api/model'), staleTime: 30 * MIN });
export const useTracking = (id: string) => useQuery({ queryKey: ['tracking', id], queryFn: () => request<Tracking>(`${base(id)}/tracking`), staleTime: 10 * MIN });
export const useTrade = (id: string) => useMutation({ mutationFn: (body: { a: number; b: number; aGives: string[]; bGives: string[] }) => request<Trade>(`${base(id)}/trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
export const searchLeagues = (username: string) => request<LeagueSearchResult>(`/api/users/${encodeURIComponent(username)}/leagues`);

export interface Metrics { n: number; mae: number; rmse: number; bias: number; spearman: number; pairAcc: number; pairs: number; closePairAcc: number; closePairs: number; byPos: Record<string, { mae: number; n: number; bias: number; pairAcc: number }> }
export interface ModelReport {
  meta: { version: string; trainedAt: string; trainingRows: number; seasons: number[]; params: Record<string, number>; iterations: number };
  holdout2025: Record<'model' | 'provider' | 'linear' | 'form', Metrics>;
  live2026: Record<'model' | 'provider' | 'linear' | 'form', Metrics> | null;
  maeDeltaCI2025: [number, number];
  coverage80: Record<string, number>;
  availability: { none: number; Questionable: number; Doubtful: number; Out: number; n: Record<string, number> };
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
export interface Tracking { weeks: { week: number; players: number; maeModel: number; maeProvider: number; biasModel: number; pairAcc: number | null }[]; note: string }
