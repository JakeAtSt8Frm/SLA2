/**
 * Warms the disk cache at image build time (full CPU) so a cold start on a small host only
 * refreshes what changed instead of downloading and parsing two seasons of data.
 */
import { getCore } from '../server/league.ts';
import { history } from '../server/views.ts';

const league = process.env.SLA_DEFAULT_LEAGUE ?? '1312656463549726720';
const t = Date.now();
const core = await getCore(league);
await history(league).catch(error => console.warn('history prefetch skipped:', (error as Error).message));
console.log(`prefetched ${core.league.name}: ${core.relevant.length} players, weeks ${core.horizon[0] ?? '-'}–${core.horizon.at(-1) ?? '-'} in ${Date.now() - t} ms`);
process.exit(0);
