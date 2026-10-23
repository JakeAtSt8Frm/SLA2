/**
 * Warms the disk cache at image build time (full CPU) so a cold start on a small host only
 * refreshes what changed instead of downloading and parsing two seasons of data.
 * Covers the default Sleeper league and every ESPN league in config/espn.json.
 */
import { configuredEspnLeagues } from '../server/espn.ts';
import { configuredSleeperIds } from '../server/saved-leagues.ts';
import { getCore } from '../server/league.ts';
import { history } from '../server/views.ts';

const leagues = [...configuredSleeperIds(), ...configuredEspnLeagues().map(l => l.id)];
for (const league of leagues) {
  const t = Date.now();
  try {
    const core = await getCore(league);
    await history(league).catch(error => console.warn('history prefetch skipped:', (error as Error).message));
    console.log(`prefetched ${core.league.name}: ${core.relevant.length} players, weeks ${core.horizon[0] ?? '-'}–${core.horizon.at(-1) ?? '-'} in ${Date.now() - t} ms`);
  } catch (error) {
    console.warn(`prefetch failed for ${league}:`, (error as Error).message);
  }
}
process.exit(0);
