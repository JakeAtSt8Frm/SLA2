/**
 * Roster moves on an ESPN league, for the saved login's own team only: add a free agent, or place
 * a waiver claim, at the earliest moment ESPN allows (scripts/espn-claim.ts drives it).
 *
 * ESPN has no public write API. The request mirrors what ESPN's own site records in mTransactions2
 * (a FREEAGENT or WAIVER envelope of ADD/DROP items), and ESPN applies a request whole or not at all.
 */
import { directory, espnJson, espnWrite, ownsTeam, POSITIONS, PRO_TEAMS, resolve, validEspnId } from './espn.ts';

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export type Availability = 'FREEAGENT' | 'WAIVERS' | 'ONTEAM';

export interface MoveContext {
  id: string; leagueId: string; season: number; scoringPeriodId: number;
  teamId: number; teamName: string;
  /** No waivers at all: a dropped player is a free agent straight away. */
  freeAgency: boolean;
  /** FAAB: waiver claims carry a bid. */
  budget: { total: number; left: number; minimumBid: number } | null;
  /** Starters plus bench; IR spots don't count. */
  rosterLimit: number;
  roster: { playerId: number; name: string; slot: number }[];
}

const IR_SLOT = 21;

/** Open roster spots: an add without a drop needs one, or ESPN rejects it (a waiver claim only when it runs). */
export const openSpots = (c: Pick<MoveContext, 'rosterLimit' | 'roster'>) => c.rosterLimit - c.roster.filter(r => r.slot !== IR_SLOT).length;

export interface PlayerState { id: number; name: string; status: Availability; onTeamId: number; waiverProcessDate: number | null }

const leagueRoute = (c: Pick<MoveContext, 'leagueId' | 'season'>) => `/seasons/${c.season}/segments/0/leagues/${c.leagueId}`;

/** League settings, the current scoring period and the saved login's own team and roster, read fresh. */
export async function moveContext(id: string): Promise<MoveContext> {
  if (!validEspnId(id)) throw new Error(`${id} is not an ESPN league in config/espn.json`);
  const { leagueId, season, current } = await resolve(id);
  if (!current) throw new Error(`${id} is a past season`);
  const raw = obj(await espnJson(`${leagueRoute({ leagueId, season })}?view=mSettings&view=mTeam&view=mRoster&view=mStatus`));
  const team = arr(raw.teams).map(obj).find(ownsTeam);
  if (!team) throw new Error('The saved ESPN login has no team in this league');
  const acq = obj(obj(raw.settings).acquisitionSettings);
  const spent = num(obj(team.transactionCounter).acquisitionBudgetSpent);
  const slots = Object.entries(obj(obj(obj(raw.settings).rosterSettings).lineupSlotCounts));
  return {
    id, leagueId, season, scoringPeriodId: num(raw.scoringPeriodId),
    teamId: num(team.id),
    teamName: String(team.name ?? `Team ${num(team.id)}`),
    freeAgency: acq.acquisitionType === 'FREEAGENCY',
    budget: acq.isUsingAcquisitionBudget === true ? { total: num(acq.acquisitionBudget), left: num(acq.acquisitionBudget) - spent, minimumBid: num(acq.minimumBid) } : null,
    rosterLimit: slots.reduce((n, [slot, count]) => n + (Number(slot) === IR_SLOT ? 0 : num(count)), 0),
    roster: arr(obj(team.roster).entries).map(obj).map(e => ({
      playerId: num(e.playerId),
      name: String(obj(obj(e.playerPoolEntry).player).fullName ?? e.playerId),
      slot: num(e.lineupSlotId, 20),
    })),
  };
}

/** Where each player stands right now: free agent, on waivers (and when they clear), or on a roster. */
export async function playerStates(c: MoveContext, ids: number[]): Promise<PlayerState[]> {
  const raw = obj(await espnJson(`${leagueRoute(c)}?view=kona_player_info&scoringPeriodId=${c.scoringPeriodId}`,
    { players: { filterIds: { value: ids } } }));
  return arr(raw.players).map(obj).map(p => {
    const status = String(p.status);
    return {
      id: num(p.id),
      name: String(obj(p.player).fullName ?? p.id),
      status: (status === 'FREEAGENT' || status === 'WAIVERS' ? status : 'ONTEAM') as Availability,
      onTeamId: num(p.onTeamId),
      waiverProcessDate: typeof p.waiverProcessDate === 'number' ? p.waiverProcessDate : null,
    };
  });
}

// ─── Finding players by name ────────────────────────────────────────────────

export type Directory = Record<string, [name: string, pos: number, team: number]>;

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[.'’-]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();

export const playerLabel = (id: number, entry: Directory[string] | undefined) =>
  entry ? `${entry[0]} (${POSITIONS[entry[1]] ?? '?'}, ${PRO_TEAMS[entry[2]] ?? 'FA'}, id ${id})` : `player ${id}`;

/** An ESPN id, or a name that matches exactly one player (exact full names win over partial ones). */
export function matchPlayer(dir: Directory, query: string): number {
  const q = query.trim();
  if (/^-?\d+$/.test(q)) return Number(q);
  const want = normalize(q);
  const entries = Object.entries(dir);
  const exact = entries.filter(([, e]) => normalize(e[0]) === want);
  const found = exact.length ? exact : entries.filter(([, e]) => normalize(e[0]).includes(want));
  if (found.length === 1) return Number(found[0][0]);
  const list = found.slice(0, 8).map(([id, e]) => `  ${playerLabel(Number(id), e)}`).join('\n');
  throw new Error(found.length ? `"${query}" matches ${found.length} players; use the id:\n${list}` : `No ESPN player matches "${query}"`);
}

export const findPlayer = async (c: MoveContext, query: string) => {
  const dir = await directory(c.season);
  const id = matchPlayer(dir, query);
  return { id, label: playerLabel(id, dir[String(id)]) };
};

/** A player on your own roster, by id or name. */
export function rosterPlayer(c: MoveContext, query: string): MoveContext['roster'][number] {
  const q = query.trim();
  const want = normalize(q);
  const found = /^-?\d+$/.test(q) ? c.roster.filter(r => r.playerId === Number(q))
    : (x => (x.length ? x : c.roster.filter(r => normalize(r.name).includes(want))))(c.roster.filter(r => normalize(r.name) === want));
  if (found.length === 1) return found[0];
  throw new Error(found.length ? `"${query}" matches ${found.map(r => r.name).join(', ')} on your roster` : `"${query}" is not on ${c.teamName}`);
}

// ─── Deciding and sending ───────────────────────────────────────────────────

export type Step =
  | { kind: 'done'; reason: string }
  | { kind: 'add' }
  | { kind: 'claim'; processAt: number | null }
  | { kind: 'wait'; until: number }
  | { kind: 'watch'; reason: string };

/**
 * What to do about a target now. A free agent is added; a player on waivers gets a claim (it is
 * processed in waiver order whenever it was placed), unless `keepPriority`, which waits for the
 * player to clear and adds them as a free agent instead; a rostered player is watched until dropped.
 */
export function nextStep(p: PlayerState, c: Pick<MoveContext, 'teamId'>, opts: { keepPriority: boolean }): Step {
  if (p.onTeamId === c.teamId) return { kind: 'done', reason: `${p.name} is already on your team` };
  if (p.status === 'FREEAGENT') return { kind: 'add' };
  if (p.status === 'WAIVERS') return opts.keepPriority && p.waiverProcessDate ? { kind: 'wait', until: p.waiverProcessDate } : { kind: 'claim', processAt: p.waiverProcessDate };
  return { kind: 'watch', reason: `${p.name} is on another team's roster` };
}

export function moveBody(c: Pick<MoveContext, 'teamId' | 'scoringPeriodId'>, type: 'FREEAGENT' | 'WAIVER', add: number, drop: { playerId: number; slot: number } | null, bid = 0): Raw {
  return {
    isLeagueManager: false, teamId: c.teamId, type, scoringPeriodId: c.scoringPeriodId, executionType: 'EXECUTE',
    bidAmount: type === 'WAIVER' ? bid : 0,
    items: [
      { playerId: add, type: 'ADD', fromTeamId: 0, toTeamId: c.teamId, fromLineupSlotId: -1, toLineupSlotId: -1 },
      ...(drop ? [{ playerId: drop.playerId, type: 'DROP', fromTeamId: c.teamId, toTeamId: 0, fromLineupSlotId: drop.slot, toLineupSlotId: -1 }] : []),
    ],
  };
}

export interface MoveResult { ok: boolean; status: number; state: string | null; message: string }

/** ESPN's answer: the transaction's status on success, or its TRAN_* reasons on a rejection. */
export function readResult(status: number, body: unknown): MoveResult {
  const b = obj(body);
  const tx = obj(arr(b.transactions)[0] ?? b);
  const state = typeof tx.status === 'string' ? tx.status : null;
  if (status >= 200 && status < 300) return { ok: state !== null && !state.startsWith('FAILED'), status, state, message: state ?? 'accepted' };
  const details = arr(b.details).map(obj).map(d => [d.type, d.message].filter(Boolean).join(': ')).filter(Boolean);
  return { ok: false, status, state, message: details.join('; ') || (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)) };
}

/** Sends one move for the context's own team. Refuses a body built for any other team. */
export async function submitMove(c: MoveContext, body: Raw): Promise<MoveResult> {
  if (body.teamId !== c.teamId || body.isLeagueManager !== false) throw new Error('Refusing a move that is not for your own team');
  const res = await espnWrite(`${leagueRoute(c)}/transactions/`, body);
  return readResult(res.status, res.body);
}
