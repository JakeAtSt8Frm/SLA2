/**
 * Downloads everything the model research needs into the shared disk cache:
 * weekly Sleeper stats + projections (2020 → current), the player catalogue,
 * nflverse schedule/lines, injury reports and the Sleeper↔GSIS ID crosswalk.
 * Safe to re-run; cached weeks are not re-downloaded.
 */
import { writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { nflGames, sleeper, sleeperSchedule, weekProjections, weekStats, type NflState } from '../server/sleeper.ts';

export const RESEARCH_DIR = import.meta.dirname;
export const RAW_DIR = path.join(RESEARCH_DIR, 'cache');
export const FIRST_SEASON = 2020;

export const weeksIn = (season: number) => (season <= 2020 ? 17 : 18);

/**
 * Last week of the current season with every game final. Sleeper's state only rolls to the
 * next week mid-week, so a finished Monday night would otherwise wait a day or two.
 */
export async function completedThrough(state: NflState): Promise<number> {
  const games = (await sleeperSchedule(state.season).catch(() => [])).filter(g => g.week === state.week);
  return games.length && games.every(g => g.status === 'complete') ? state.week : state.week - 1;
}

async function download(url: string, file: string) {
  try {
    await access(file);
    return;
  } catch { /* not downloaded yet */ }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  console.log('downloaded', path.basename(file));
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  const state = await sleeper.state();
  const currentSeason = state.season;
  const currentWeek = state.week;
  const done = await completedThrough(state);
  console.log(`NFL state: ${currentSeason} week ${currentWeek} (final through week ${done})`);

  const players = await sleeper.players();
  console.log(`players: ${Object.keys(players).length}`);
  const games = await nflGames();
  console.log(`games: ${games.length}`);

  const jobs: { season: number; week: number }[] = [];
  for (let season = FIRST_SEASON; season <= currentSeason; season++) {
    const last = season < currentSeason ? weeksIn(season) : Math.min(weeksIn(season), currentWeek);
    for (let week = 1; week <= last; week++) jobs.push({ season, week });
  }
  let fetched = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (jobs.length) {
      const job = jobs.shift()!;
      const f = { ...job, currentSeason, currentWeek };
      // Projections for the current week are needed; stats only exist for completed weeks.
      const [stats, proj] = await Promise.all([
        job.season === currentSeason && job.week > done ? Promise.resolve([]) : weekStats(f),
        weekProjections(f),
      ]);
      fetched++;
      if (fetched % 10 === 0 || !stats.length) console.log(`${job.season} w${job.week}: ${stats.length} stat rows, ${proj.length} projection rows (${fetched} done)`);
    }
  }));

  // Injury reports (availability model) and ID crosswalk.
  for (let season = FIRST_SEASON; season <= currentSeason; season++) {
    await download(`https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${season}.csv`, path.join(RAW_DIR, `injuries_${season}.csv`)).catch(e => console.warn('injuries', season, e.message));
  }
  await download('https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv', path.join(RAW_DIR, 'db_playerids.csv'));
  console.log('fetch complete');
}

if (import.meta.main) await main();
