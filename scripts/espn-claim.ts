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
import { findPlayer, moveContext, openSpots, rosterPlayer, runClaim } from '../server/espn-moves.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    add: { type: 'string' }, drop: { type: 'string' }, bid: { type: 'string' }, poll: { type: 'string' },
    watch: { type: 'boolean', default: false }, 'keep-priority': { type: 'boolean', default: false }, execute: { type: 'boolean', default: false },
  },
});

const log = (msg: string) => console.log(`${new Date().toLocaleTimeString()}  ${msg}`);
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
const bid = values.bid === undefined ? 0 : Number(values.bid);
if (!Number.isInteger(bid) || bid < 0) fail('--bid must be a whole number');

const ctx = await moveContext(league.id);
const target = await findPlayer(ctx, values.add!);
// Resolve the drop up front so a typo fails now, not at 3 a.m. when the player clears.
const dropping = values.drop ? rosterPlayer(ctx, values.drop) : null;
log(`${league.name} · ${ctx.teamName} · week ${ctx.scoringPeriodId} · ${ctx.freeAgency ? 'free agency (no waivers)' : 'waivers'}${ctx.budget ? ` · $${ctx.budget.left} FAAB left` : ''}`);
log(`Target: ${target.label}${dropping ? ` · dropping ${dropping.name}` : ''}${values.execute ? '' : ' · dry run (add --execute to send)'}`);
const open = openSpots(ctx);
if (open > 0 && dropping) log(`You have ${open} open roster spot${open === 1 ? '' : 's'}; ${dropping.name} will still be dropped.`);
if (bid && !ctx.budget) log('This league has no FAAB budget; the bid is ignored.');

const outcome = await runClaim(
  { league: league.id, add: target.id, drop: dropping?.playerId ?? null, bid, keepPriority: values['keep-priority']!, watch: values.watch!, pollMs: Number(values.poll ?? 30) * 1000 },
  { log, execute: values.execute! },
);
if (outcome.kind === 'not-yet') log(`${outcome.message} Run with --watch to ${outcome.until ? 'add them then' : 'grab them when they\'re dropped'}.`);
else log(outcome.message);
process.exit(outcome.ok ? 0 : 1);
