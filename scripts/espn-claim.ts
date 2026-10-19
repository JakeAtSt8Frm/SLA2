/**
 * Gets a player onto your ESPN team at the earliest moment ESPN allows.
 *
 *   npm run espn:claim -- <league> --add <player> [--drop <player>] [--bid <n>] [--watch] [--keep-priority] [--execute]
 *
 * <league>         a league from config/espn.json, by name ("oj", "uk-bg") or id
 * --add            the player to get, by name or ESPN id
 * --drop           a player on your roster to release with it, in the same move (for a waiver claim,
 *                  when the claim is processed). Required when your roster is full
 * --bid            FAAB bid for a waiver claim (FAAB leagues only)
 * --watch          keep running until the move is made: while the player is on another roster,
 *                  poll for the drop; with --keep-priority, sleep until waivers clear
 * --keep-priority  waiver leagues: don't spend a claim; add the player the moment they clear waivers
 * --poll <sec>     how often to check while watching (default 30)
 * --execute        send the move; without it, prints the request that would be sent
 *
 * Free agents are added immediately. A player on waivers gets a claim placed now (ESPN processes
 * claims in waiver order whenever they were placed). Runs on this machine with the ESPN login in
 * config/espn.json; keep the Mac awake for long watches (caffeinate -i npm run espn:claim -- …).
 */
import { parseArgs } from 'node:util';
import { configuredEspnLeagues } from '../server/espn.ts';
import { findPlayer, moveBody, moveContext, nextStep, openSpots, playerStates, rosterPlayer, submitMove, type MoveContext } from '../server/espn-moves.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    add: { type: 'string' }, drop: { type: 'string' }, bid: { type: 'string' }, poll: { type: 'string' },
    watch: { type: 'boolean', default: false }, 'keep-priority': { type: 'boolean', default: false }, execute: { type: 'boolean', default: false },
  },
});

const log = (msg: string) => console.log(`${new Date().toLocaleTimeString()}  ${msg}`);
const when = (ts: number) => new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fail = (msg: string): never => { console.error(msg); process.exit(1); };
// Bad names, a full roster, an expired login: one line, not a stack trace.
process.on('uncaughtException', error => fail(error.message));

const leagueQuery = positionals[0];
if (!leagueQuery || !values.add) fail('Usage: npm run espn:claim -- <league> --add <player> [--drop <player>] [--bid <n>] [--watch] [--keep-priority] [--execute]');
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const leagues = configuredEspnLeagues();
const matches = leagues.filter(l => l.id === leagueQuery || l.id === `espn-${leagueQuery}` || squash(l.name).includes(squash(leagueQuery!)));
if (matches.length !== 1) fail(`League "${leagueQuery}" ${matches.length ? 'is ambiguous' : 'not found'}. Configured: ${leagues.map(l => `${l.name} (${l.id})`).join(', ')}`);
const league = matches[0];
const poll = Math.max(10, Number(values.poll ?? 30)) * 1000;
const bid = values.bid === undefined ? 0 : Number(values.bid);
if (!Number.isInteger(bid) || bid < 0) fail('--bid must be a whole number');

/** A full roster needs a drop. Checked up front and again before sending, so a doomed claim isn't left to fail at 2 a.m. */
function checkRoom(c: MoveContext) {
  const open = openSpots(c);
  if (open <= 0 && !values.drop) fail(`Your roster is full (${c.rosterLimit} players, not counting IR). Add --drop <player> to say who goes.`);
  return open;
}

let ctx = await moveContext(league.id);
const target = await findPlayer(ctx, values.add!);
// Resolve the drop up front so a typo fails now, not at 3 a.m. when the player clears.
const dropping = values.drop ? rosterPlayer(ctx, values.drop) : null;
log(`${league.name} · ${ctx.teamName} · week ${ctx.scoringPeriodId} · ${ctx.freeAgency ? 'free agency (no waivers)' : 'waivers'}${ctx.budget ? ` · $${ctx.budget.left} FAAB left` : ''}`);
log(`Target: ${target.label}${dropping ? ` · dropping ${dropping.name}` : ''}${values.execute ? '' : ' · dry run (add --execute to send)'}`);
const open = checkRoom(ctx);
if (open > 0 && dropping) log(`You have ${open} open roster spot${open === 1 ? '' : 's'}; ${dropping.name} will still be dropped.`);
if (bid && !ctx.budget) log('This league has no FAAB budget; the bid is ignored.');

/** Rebuilt right before sending: the drop's lineup slot and the scoring period may have changed. */
async function send(type: 'FREEAGENT' | 'WAIVER'): Promise<string | null> {
  ctx = await moveContext(league.id);
  checkRoom(ctx);
  const drop = values.drop ? rosterPlayer(ctx, values.drop) : null;
  const body = moveBody(ctx, type, target.id, drop, ctx.budget ? bid : 0);
  if (!values.execute) {
    log(`Would send this ${type === 'WAIVER' ? 'waiver claim' : 'free-agent add'}:\n${JSON.stringify(body, null, 2)}`);
    return null;
  }
  let result;
  try {
    result = await submitMove(ctx, body);
  } catch (error) {
    // No retry: a request that timed out may still have gone through. Read back what happened.
    const [now] = await playerStates(ctx, [target.id]);
    if (now?.onTeamId === ctx.teamId) { log(`${target.label} is on your team.`); return null; }
    return fail(`Couldn't confirm the move (${(error as Error).message}). Check ESPN before running again.`);
  }
  if (!result.ok) {
    log(`ESPN rejected the ${type === 'WAIVER' ? 'claim' : 'add'} (${result.status}): ${result.message}`);
    return result.message;
  }
  log(type === 'WAIVER' ? `Waiver claim placed (${result.state}).` : `Added ${target.label} (${result.state}).`);
  return null;
}

let lastNote = '', lastKind = '', lastRejection = '', rejections = 0;
const note = (msg: string) => { if (msg !== lastNote) log(msg); lastNote = msg; };

for (;;) {
  const [state] = await playerStates(ctx, [target.id]);
  if (!state) fail(`ESPN returned nothing for ${target.label}`);
  const step = nextStep(state, ctx, { keepPriority: values['keep-priority']! });
  if (step.kind === 'watch' && lastKind === 'wait') fail(`${state.name} was claimed off waivers by another team.`);
  lastKind = step.kind;
  if (step.kind === 'done') { log(step.reason); break; }
  if (step.kind === 'add' || step.kind === 'claim') {
    if (step.kind === 'claim') log(`${state.name} is on waivers${step.processAt ? ` until ${when(step.processAt)}` : ''}; placing a claim.`);
    const rejected = await send(step.kind === 'add' ? 'FREEAGENT' : 'WAIVER');
    if (rejected === null) break;
    // Rejected (roster full, game locked, …): keep trying while watching, unless ESPN keeps giving the same reason.
    rejections = rejected === lastRejection ? rejections + 1 : 1;
    lastRejection = rejected;
    if (!values.watch || rejections >= 3) process.exit(1);
    await sleep(poll);
    continue;
  }
  if (!values.watch) {
    log(step.kind === 'wait' ? `${state.name} clears waivers ${when(step.until)}. Run with --watch to add them then.` : `${step.reason}. Run with --watch to grab them when they're dropped.`);
    break;
  }
  if (step.kind === 'wait') {
    const left = step.until - Date.now();
    note(`Waiting for ${state.name} to clear waivers at ${when(step.until)}.`);
    // Short naps so a sleeping laptop catches up when it wakes; every few seconds near the time; then
    // every 10 s, since ESPN's waiver run can start up to an hour after the scheduled time.
    await sleep(left > 60_000 ? Math.min(left - 30_000, 5 * 60_000) : left > 0 ? 3000 : 10_000);
    continue;
  }
  note(`${step.reason}; checking every ${poll / 1000}s.`);
  await sleep(poll);
}

