/**
 * Auto-claims for ESPN leagues, run by this server with the ESPN login in config/espn.json: add a
 * free agent, place a waiver claim, or watch a player and grab them at the earliest moment
 * (server/espn-moves.ts runClaim). Jobs are saved to data/claims.json so a restart resumes them.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getCore, type LeagueCore } from './league.ts';
import { espnIdIndex, isEspnId, PRO_TEAMS, type EspnIdIndex } from './espn.ts';
import { hasPendingClaim, moveContext, nextStep, openSpots, playerStates, runClaim, type ClaimPhase } from './espn-moves.ts';
import { HttpError, waivers } from './views.ts';

const FILE = process.env.SLA_CLAIMS_FILE ?? path.resolve(import.meta.dirname, '..', 'data', 'claims.json');
/** Test mode: jobs log the move they would send instead of sending it. */
const DRY_RUN = process.env.SLA_CLAIMS_DRY_RUN === '1';
const KEEP_FINISHED = 20;
const LOG_LINES = 30;

export interface ClaimJob {
  id: string; league: string;
  add: { espnId: number; pid: string; name: string };
  drop: { espnId: number; name: string } | null;
  bid: number; keepPriority: boolean;
  status: 'active' | 'done' | 'failed' | 'cancelled';
  phase: ClaimPhase | null;
  /** The final message once the job is no longer active. */
  result: string | null;
  log: { at: number; msg: string }[];
  createdAt: number; updatedAt: number;
}

export interface ClaimRequest { player: string; drop: number | null; bid?: number; keepPriority?: boolean }

const jobs = new Map<string, ClaimJob>();
const running = new Map<string, AbortController>();

function load() {
  try {
    for (const j of JSON.parse(readFileSync(FILE, 'utf8')) as ClaimJob[]) jobs.set(j.id, j);
  } catch { /* none saved yet */ }
}

let saving: Promise<void> = Promise.resolve();
function save() {
  const finished = [...jobs.values()].filter(j => j.status !== 'active').sort((a, b) => b.updatedAt - a.updatedAt);
  for (const j of finished.slice(KEEP_FINISHED)) jobs.delete(j.id);
  const text = JSON.stringify([...jobs.values()], null, 1);
  saving = saving.then(async () => {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, FILE);
  }).catch(error => console.error('[claims] save failed:', (error as Error).message));
}

function touch(j: ClaimJob, msg?: string) {
  j.updatedAt = Date.now();
  if (msg) j.log = [...j.log, { at: j.updatedAt, msg }].slice(-LOG_LINES);
  save();
}

function start(j: ClaimJob) {
  const controller = new AbortController();
  running.set(j.id, controller);
  void runClaim(
    { league: j.league, add: j.add.espnId, drop: j.drop?.espnId ?? null, bid: j.bid, keepPriority: j.keepPriority, watch: true },
    {
      execute: !DRY_RUN, signal: controller.signal,
      log: msg => touch(j, msg),
      phase: p => { if (j.phase !== p) { j.phase = p; touch(j); } },
    },
  ).then(
    outcome => finish(j, outcome.kind === 'cancelled' ? 'cancelled' : outcome.ok ? 'done' : 'failed', outcome.message),
    error => finish(j, 'failed', (error as Error).message),
  );
}

function finish(j: ClaimJob, status: ClaimJob['status'], message: string) {
  running.delete(j.id);
  // A cancel can't recall a move already on its way to ESPN: if it went through, say so.
  if (j.status === 'cancelled' && status !== 'done') return;
  if (j.status === 'cancelled') message = `${message} It was already being sent when you cancelled.`;
  j.status = status;
  j.phase = null;
  j.result = message;
  touch(j, message);
  console.log(`[claims] ${j.add.name}: ${message}`);
}

load();
// Resume watches the last run left active. A send cut off mid-way is safe: the loop re-reads the
// league first, and never places a second waiver claim for the same player.
for (const j of jobs.values()) if (j.status === 'active') start(j);

const leagueJobs = (league: string) => [...jobs.values()].filter(j => j.league === league).sort((a, b) =>
  Number(b.status === 'active') - Number(a.status === 'active') || b.createdAt - a.createdAt);

// ─── Ids: the app keys players by Sleeper id; ESPN moves need ESPN ids ──────

const defenseEspnId = (pid: string) => {
  const team = Object.entries(PRO_TEAMS).find(([, code]) => code === pid)?.[0];
  return team ? -16000 - Number(team) : null;
};

function espnIdOf(core: LeagueCore, index: EspnIdIndex, pid: string): number {
  const p = core.players[pid];
  const id = (p?.pos === 'DEF' ? defenseEspnId(pid) : null) ?? index.byPid.get(pid) ?? (p?.espnId ? Number(p.espnId) : NaN);
  if (!Number.isFinite(id)) throw new HttpError(400, `ESPN doesn't list ${p?.name ?? pid}.`);
  return id;
}

const pidOf = (index: EspnIdIndex, espnId: number) => index.byEspn.get(espnId) ?? (espnId < 0 ? PRO_TEAMS[-espnId - 16000] ?? null : null);

const slotLabel = (slot: number) => (slot === 20 ? 'Bench' : slot === 21 ? 'IR' : 'Starting');

// ─── API ────────────────────────────────────────────────────────────────────

function espnOnly(id: string) {
  if (!isEspnId(id)) throw new HttpError(400, 'Auto-claims are for ESPN leagues.');
}

/** Your roster, roster room and auto-claims; with `pid`, where that player stands and what a claim would do. */
export async function claimInfo(id: string, pid: string | null) {
  espnOnly(id);
  const [ctx, core, index] = await Promise.all([moveContext(id), getCore(id), espnIdIndex(id)]);
  const roster = ctx.roster
    .map(r => ({ espnId: r.playerId, pid: pidOf(index, r.playerId), name: r.name, slot: slotLabel(r.slot) }))
    .sort((a, b) => (a.slot === b.slot ? a.name.localeCompare(b.name) : a.slot === 'Bench' ? -1 : b.slot === 'Bench' ? 1 : a.slot === 'IR' ? -1 : 1));
  let target = null;
  if (pid) {
    const espnId = espnIdOf(core, index, pid);
    const [state] = await playerStates(ctx, [espnId]);
    if (!state) throw new HttpError(404, 'ESPN has no record of this player.');
    const step = nextStep(state, ctx, { keepPriority: false });
    const rec = await waivers(id, ctx.teamId).then(w => w.recommendations.find(r => r.id === pid), () => undefined);
    const suggested = rec?.drop ? roster.find(r => r.pid === rec.drop!.id)?.espnId ?? null : null;
    target = {
      pid, espnId, name: state.name, status: state.status, onTeamId: state.onTeamId, waiverProcessDate: state.waiverProcessDate,
      mine: step.kind === 'done',
      pendingClaim: state.status === 'WAIVERS' && await hasPendingClaim(ctx, espnId).catch(() => false),
      suggestedDrop: suggested,
    };
  }
  return {
    dryRun: DRY_RUN, teamId: ctx.teamId, teamName: ctx.teamName, freeAgency: ctx.freeAgency, budget: ctx.budget,
    rosterLimit: ctx.rosterLimit, openSpots: openSpots(ctx), roster, target, jobs: leagueJobs(id),
  };
}

/** Starts an auto-claim. The browser confirms the move first; from here the server makes it. */
export async function createClaim(id: string, body: ClaimRequest): Promise<ClaimJob> {
  espnOnly(id);
  if (typeof body.player !== 'string' || !/^[A-Za-z0-9_:]{1,20}$/.test(body.player)) throw new HttpError(400, 'Invalid player.');
  const bid = Number(body.bid ?? 0);
  if (!Number.isInteger(bid) || bid < 0) throw new HttpError(400, 'The bid must be a whole number.');
  const [ctx, core, index] = await Promise.all([moveContext(id), getCore(id), espnIdIndex(id)]);
  const espnId = espnIdOf(core, index, body.player);
  const drop = body.drop === null || body.drop === undefined ? null : ctx.roster.find(r => r.playerId === Number(body.drop));
  if (body.drop !== null && body.drop !== undefined && !drop) throw new HttpError(400, `That player is not on ${ctx.teamName}.`);
  if (!drop && openSpots(ctx) <= 0) throw new HttpError(400, `Your roster is full (${ctx.rosterLimit} players, not counting IR). Choose who to drop.`);
  if (leagueJobs(id).some(j => j.status === 'active' && j.add.espnId === espnId)) throw new HttpError(409, 'There is already an auto-claim running for this player.');
  const [state] = await playerStates(ctx, [espnId]);
  const now = Date.now();
  const job: ClaimJob = {
    id: randomUUID(), league: id,
    add: { espnId, pid: body.player, name: state?.name ?? core.players[body.player]?.name ?? body.player },
    drop: drop ? { espnId: drop.playerId, name: drop.name } : null,
    bid: ctx.budget ? bid : 0, keepPriority: body.keepPriority === true,
    status: 'active', phase: 'checking', result: null, log: [], createdAt: now, updatedAt: now,
  };
  jobs.set(job.id, job);
  touch(job, `Started by you${job.drop ? `, dropping ${job.drop.name}` : ''}.`);
  start(job);
  return job;
}

export function cancelClaim(id: string, jobId: string): ClaimJob {
  const job = jobs.get(jobId);
  if (!job || job.league !== id) throw new HttpError(404, 'No such auto-claim.');
  if (job.status === 'active') {
    job.status = 'cancelled';
    job.phase = null;
    job.result = 'Cancelled';
    running.get(job.id)?.abort();
    touch(job, 'Cancelled by you.');
  }
  return job;
}
