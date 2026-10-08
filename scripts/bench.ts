/**
 * Times a cold league build and the first request of every view (what a visitor waits for after
 * a restart). Uses the disk cache like the server does. Usage: node scripts/bench.ts [leagueId]
 */
import { getCore, refreshCore } from '../server/league.ts';
import { encode } from '../server/http.ts';
import * as views from '../server/views.ts';

const id = process.argv[2] ?? process.env.SLA_DEFAULT_LEAGUE ?? '1312656463549726720';
const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t = performance.now();
  const value = await fn();
  const ms = performance.now() - t;
  const bytes = value && typeof value === 'object' ? encode(value).raw.length : 0;
  console.log(`${label.padEnd(22)} ${ms.toFixed(0).padStart(6)} ms ${bytes ? `${(bytes / 1024).toFixed(0).padStart(6)} KB` : ''}`);
  return value;
};

const core = await time('core (cold)', () => getCore(id));
const mine = core.teams[1]?.rosterId ?? core.teams[0].rosterId;
await time('bootstrap', () => views.bootstrap(id));
await time('overview', () => views.overview(id));
await time('matchups', () => views.matchups(id));
await time('lineup', () => views.lineup(id, mine));
await time('players', () => views.players(id));
await time('player', () => views.player(id, core.relevant[0]));
await time('team', () => views.team(id, mine));
await time('waivers', () => views.waivers(id, mine));
await time('power', () => views.powerView(id));
await time('playoffs', () => views.playoffs(id));
await time('recap', () => views.recap(id));
await time('defense', () => views.defense(id));
await time('history', () => views.history(id));
await time('core (recheck)', () => refreshCore(id));
process.exit(0);
