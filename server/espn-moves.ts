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

/** Everyone on waivers right now, with when they clear. */
export async function waiverWire(c: MoveContext): Promise<PlayerState[]> {
  const raw = obj(await espnJson(`${leagueRoute(c)}?view=kona_player_info&scoringPeriodId=${c.scoringPeriodId}`,
    { players: { filterStatus: { value: ['WAIVERS'] } } }));
  return arr(raw.players).map(obj).filter(p => p.status === 'WAIVERS').map(p => ({
    id: num(p.id), name: String(obj(p.player).fullName ?? p.id), status: 'WAIVERS' as const, onTeamId: num(p.onTeamId),
    waiverProcessDate: typeof p.waiverProcessDate === 'number' ? p.waiverProcessDate : null,
  }));
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

/** Your own waiver claim for this player that ESPN hasn't processed yet, so a restart never places a second one. */
export async function hasPendingClaim(c: MoveContext, playerId: number): Promise<boolean> {
  const raw = obj(await espnJson(`${leagueRoute(c)}?view=mTransactions2&scoringPeriodId=${c.scoringPeriodId}`));
  return arr(raw.transactions).map(obj).some(t => t.type === 'WAIVER' && t.status === 'PENDING' && num(t.teamId) === c.teamId
    && arr(t.items).map(obj).some(i => i.type === 'ADD' && num(i.playerId) === playerId));
}

// ─── The claim loop (CLI and the server's auto-claims) ─────────────────────

export interface ClaimSpec {
  league: string; add: number; drop: number | null; bid: number;
  keepPriority: boolean;
  /** Keep going while the player is on another roster (or, with keepPriority, until they clear waivers). */
  watch: boolean;
  pollMs?: number;
  /** Stop watching at this time and report `continuing` (a GitHub Actions job hands over to a fresh run). */
  deadline?: number;
}

export type ClaimPhase = 'checking' | 'watching' | 'waiting' | 'sending';

export interface ClaimHooks {
  log: (msg: string) => void;
  /** false: log the request that would be sent instead of sending it. */
  execute: boolean;
  signal?: AbortSignal;
  phase?: (phase: ClaimPhase) => void;
}

export type ClaimOutcome =
  | { kind: 'added' | 'claimed' | 'already' | 'dry-run'; ok: true; message: string }
  | { kind: 'not-yet'; ok: true; message: string; until: number | null; continuing?: boolean }
  | { kind: 'failed' | 'cancelled'; ok: false; message: string };

export const when = (ts: number) => new Date(ts).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const nap = (ms: number, signal?: AbortSignal) => new Promise<void>(done => {
  if (signal?.aborted) return done();
  const t = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); done(); }, { once: true });
});

/**
 * Gets `spec.add` onto your team at the earliest moment ESPN allows: adds a free agent, claims a
 * player on waivers, and (watching) waits for a drop or for waivers to clear. The drop goes in the
 * same move. Never retries a send that may have executed; reads the league back instead.
 */
export async function runClaim(spec: ClaimSpec, hooks: ClaimHooks): Promise<ClaimOutcome> {
  const { log, signal } = hooks;
  const poll = Math.max(10_000, spec.pollMs ?? 30_000);
  const cancelled = (): ClaimOutcome => ({ kind: 'cancelled', ok: false, message: 'Cancelled' });
  const failed = (message: string): ClaimOutcome => ({ kind: 'failed', ok: false, message });
  let ctx = await moveContext(spec.league);
  let ctxAt = Date.now();
  const room = (c: MoveContext) => (openSpots(c) <= 0 && spec.drop === null ? `Your roster is full (${c.rosterLimit} players, not counting IR). Choose who to drop.` : null);
  const dropOf = (c: MoveContext) => (spec.drop === null ? null : c.roster.find(r => r.playerId === spec.drop) ?? null);
  if (room(ctx)) return failed(room(ctx)!);
  if (spec.drop !== null && !dropOf(ctx)) return failed(`The player to drop is no longer on ${ctx.teamName}.`);

  /** Rebuilt right before sending: the drop's lineup slot and the scoring period may have changed. */
  async function send(type: 'FREEAGENT' | 'WAIVER', name: string): Promise<ClaimOutcome | string> {
    hooks.phase?.('sending');
    ctx = await moveContext(spec.league);
    ctxAt = Date.now();
    if (room(ctx)) return failed(room(ctx)!);
    const drop = dropOf(ctx);
    if (spec.drop !== null && !drop) return failed(`The player to drop is no longer on ${ctx.teamName}.`);
    if (type === 'WAIVER' && await hasPendingClaim(ctx, spec.add)) return { kind: 'claimed', ok: true, message: `Your waiver claim for ${name} is already pending.` };
    const body = moveBody(ctx, type, spec.add, drop, ctx.budget ? spec.bid : 0);
    if (!hooks.execute) {
      log(`Would send this ${type === 'WAIVER' ? 'waiver claim' : 'free-agent add'}:\n${JSON.stringify(body, null, 2)}`);
      return { kind: 'dry-run', ok: true, message: 'Dry run: nothing was sent.' };
    }
    let result: MoveResult;
    try {
      result = await submitMove(ctx, body);
    } catch (error) {
      // No retry: a request that timed out may still have gone through. Read back what happened.
      const [now] = await playerStates(ctx, [spec.add]).catch(() => []);
      if (now?.onTeamId === ctx.teamId) return { kind: 'added', ok: true, message: `${name} is on your team.` };
      if (type === 'WAIVER' && await hasPendingClaim(ctx, spec.add).catch(() => false)) return { kind: 'claimed', ok: true, message: `Waiver claim for ${name} placed.` };
      return failed(`Couldn't confirm the move (${(error as Error).message}). Check ESPN before trying again.`);
    }
    if (!result.ok) {
      log(`ESPN rejected the ${type === 'WAIVER' ? 'claim' : 'add'} (${result.status}): ${result.message}`);
      return result.message;
    }
    return type === 'WAIVER'
      ? { kind: 'claimed', ok: true, message: `Waiver claim for ${name} placed${drop ? `, dropping ${drop.name}` : ''} (${result.state}).` }
      : { kind: 'added', ok: true, message: `Added ${name}${drop ? `, dropped ${drop.name}` : ''} (${result.state}).` };
  }

  let lastNote = '', lastKind = '', lastRejection = '', rejections = 0, readErrors = 0;
  const note = (msg: string) => { if (msg !== lastNote) log(msg); lastNote = msg; };
  for (;;) {
    if (signal?.aborted) return cancelled();
    if (spec.deadline && Date.now() >= spec.deadline) return { kind: 'not-yet', ok: true, message: lastNote || 'Still watching.', until: null, continuing: true };
    hooks.phase?.('checking');
    let state: PlayerState | undefined;
    try {
      // Long watches cross weeks: refresh the scoring period now and then.
      if (Date.now() - ctxAt > 30 * 60_000) { ctx = await moveContext(spec.league); ctxAt = Date.now(); }
      [state] = await playerStates(ctx, [spec.add]);
      readErrors = 0;
    } catch (error) {
      // A long watch outlives ESPN hiccups; a rejected login doesn't fix itself.
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403 || ++readErrors >= 20) return failed((error as Error).message);
      note(`Couldn't reach ESPN (${(error as Error).message}); retrying.`);
      await nap(poll, signal);
      continue;
    }
    if (!state) return failed('ESPN returned nothing for this player.');
    const step = nextStep(state, ctx, { keepPriority: spec.keepPriority });
    if (step.kind === 'watch' && lastKind === 'wait') return failed(`${state.name} was claimed off waivers by another team.`);
    lastKind = step.kind;
    if (step.kind === 'done') return { kind: 'already', ok: true, message: step.reason };
    if (step.kind === 'add' || step.kind === 'claim') {
      if (step.kind === 'claim') log(`${state.name} is on waivers${step.processAt ? ` until ${when(step.processAt)}` : ''}; placing a claim.`);
      const sent = await send(step.kind === 'add' ? 'FREEAGENT' : 'WAIVER', state.name);
      if (typeof sent !== 'string') return sent;
      // Rejected (game locked, roster rules, …): keep trying while watching, unless ESPN keeps giving the same reason.
      rejections = sent === lastRejection ? rejections + 1 : 1;
      lastRejection = sent;
      if (!spec.watch || rejections >= 3) return failed(`ESPN rejected the move: ${sent}`);
      await nap(poll, signal);
      continue;
    }
    if (!spec.watch) {
      return step.kind === 'wait'
        ? { kind: 'not-yet', ok: true, message: `${state.name} clears waivers ${when(step.until)}.`, until: step.until }
        : { kind: 'not-yet', ok: true, message: `${step.reason}.`, until: null };
    }
    if (step.kind === 'wait') {
      hooks.phase?.('waiting');
      const left = step.until - Date.now();
      note(`Waiting for ${state.name} to clear waivers at ${when(step.until)}.`);
      // Short naps so a sleeping laptop catches up when it wakes; every few seconds near the time; then
      // every 10 s, since ESPN's waiver run can start up to an hour after the scheduled time.
      await nap(left > 60_000 ? Math.min(left - 30_000, 5 * 60_000) : left > 0 ? 3000 : 10_000, signal);
      continue;
    }
    hooks.phase?.('watching');
    note(`${step.reason}; checking every ${poll / 1000}s.`);
    await nap(poll, signal);
  }
}
