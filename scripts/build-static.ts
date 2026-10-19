/**
 * Static deployment: runs the full league engine once and writes every view the web app reads as
 * a JSON file (dist/data/…), so the app can be served from GitHub Pages with no server to wake up.
 * A scheduled GitHub Actions job (.github/workflows/deploy.yml) reruns it and redeploys.
 *
 * Also saves each league's pregame forecasts (data/snapshots, published under data/snapshots/ so
 * the next run starts from them). A league that fails to build keeps its last published files.
 *
 * Usage: node scripts/build-static.ts [outDir]   (env: SLA_SITE_URL = the live site, for carry-over)
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { refreshesSettled } from '../server/cache.ts';
import { claimSnapshot } from '../server/claims.ts';
import { configuredEspnLeagues, isEspnId } from '../server/espn.ts';
import { getCore, refreshCore, type LeagueCore } from '../server/league.ts';
import { recordSnapshot, SNAPSHOT_DIR, trackRecord } from '../server/snapshots.ts';
import * as views from '../server/views.ts';

const OUT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'dist', 'data'));
const SITE = (process.env.SLA_SITE_URL ?? '').replace(/\/+$/, '');
const DEFAULT_LEAGUE = process.env.SLA_DEFAULT_LEAGUE ?? '1312656463549726720';
const LEAGUES = [...new Set([DEFAULT_LEAGUE, ...(process.env.SLA_LEAGUES ?? '').split(',').map(x => x.trim()).filter(Boolean), ...configuredEspnLeagues().map(l => l.id)])];

let bytes = 0;
async function write(file: string, data: unknown) {
  const text = JSON.stringify(data);
  bytes += text.length;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** A core built from fresh inputs: any copy served stale from the disk cache is refreshed first. */
async function freshCore(id: string): Promise<LeagueCore> {
  let core = await getCore(id);
  for (let i = 0; i < 3; i++) {
    const pending = refreshesSettled();
    if (!pending) break;
    await pending;
    core = await refreshCore(id);
  }
  return core;
}

/** Players whose card can be opened from some page: everyone in a list, lineup, matchup or transaction. */
function playerIds(core: LeagueCore): string[] {
  const ids = new Set<string>([...core.relevant, ...core.ownerOf.keys()]);
  for (const ms of core.schedule.values()) for (const m of ms) for (const pid of [...m.starters, ...m.players]) ids.add(pid);
  for (const tx of core.transactions) for (const pid of [...Object.keys(tx.adds), ...Object.keys(tx.drops)]) ids.add(pid);
  return [...ids].filter(pid => pid !== '0' && core.players[pid]);
}

async function buildLeague(id: string): Promise<{ name: string; files: number }> {
  const t0 = Date.now();
  const core = await freshCore(id);
  await recordSnapshot(core);
  const dir = path.join(OUT, id);
  const files: string[] = [];
  const put = async (name: string, data: unknown) => { files.push(name); await write(path.join(dir, name), data); };

  await put('overview.json', await views.overview(id));
  await put('matchups.json', await views.matchups(id));
  for (const w of Array.from({ length: core.lastRegularWeek }, (_, i) => i + 1)) await put(`matchups-${w}.json`, await views.matchups(id, w));
  await put('power.json', await views.powerView(id));
  await put('playoffs.json', await views.playoffs(id));
  await put('players.json', await views.players(id));
  await put('recap.json', await views.recap(id));
  await put('transactions.json', await views.transactions(id));
  await put('model.json', views.model(id));
  await put('tracking.json', await trackRecord(core));
  await put('trade-kit.json', await views.tradeKit(id));
  const defense = await views.defense(id);
  await put('defense.json', defense);
  for (const season of defense.seasons) await put(`defense-${season}.json`, await views.defense(id, season));
  await put('history.json', await views.history(id).catch(error => {
    console.warn(`  history unavailable for ${id}:`, (error as Error).message);
    return { seasons: [], allTime: [], h2h: {}, records: { highScore: [], lowScore: [], blowouts: [], closest: [] }, ownerNames: {} };
  }));
  for (const t of core.teams) {
    await put(`team-${t.rosterId}.json`, await views.team(id, t.rosterId));
    await put(`lineup-${t.rosterId}.json`, await views.lineup(id, t.rosterId));
    await put(`waivers-${t.rosterId}.json`, await views.waivers(id, t.rosterId));
  }
  const pids = playerIds(core);
  for (const pid of pids) await put(`players/${pid}.json`, await views.player(id, pid));
  // ESPN claims from the static site: what the claim panel needs; the move itself runs in GitHub Actions.
  if (isEspnId(id)) {
    await claimSnapshot(id, pids).then(snap => put('claims.json', snap), error => console.warn(`  claim data unavailable for ${id}:`, (error as Error).message));
  }
  // Bootstrap last: it carries the build stamp the app uses to fetch everything above.
  await put('bootstrap.json', await views.bootstrap(id));
  await write(path.join(dir, 'files.json'), files);
  console.log(`built ${core.league.name}: ${files.length} files in ${Date.now() - t0} ms (week ${core.week ?? '-'}, ${core.relevant.length} players)`);
  return { name: core.league.name, files: files.length };
}

/** Keep a league's last published files when this run can't build it (e.g. an expired ESPN login). */
async function carryOver(id: string): Promise<boolean> {
  if (!SITE) return false;
  try {
    const list = await (await fetch(`${SITE}/data/${id}/files.json`)).json() as string[];
    const dir = path.join(OUT, id);
    for (let i = 0; i < list.length; i += 24) {
      await Promise.all(list.slice(i, i + 24).map(async name => {
        const res = await fetch(`${SITE}/data/${id}/${name}`);
        if (!res.ok) throw new Error(`${res.status} ${name}`);
        await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await writeFile(path.join(dir, name), Buffer.from(await res.arrayBuffer()));
      }));
    }
    await write(path.join(dir, 'files.json'), list);
    console.warn(`  kept the last published data for ${id} (${list.length} files)`);
    return true;
  } catch (error) {
    console.warn(`  no published data to keep for ${id}:`, (error as Error).message);
    return false;
  }
}

/** Publish saved pregame forecasts (and an index of them) so the next run can pull them back. */
async function publishSnapshots() {
  const index: string[] = [];
  for (const league of await readdir(SNAPSHOT_DIR).catch(() => [] as string[])) {
    for (const file of await readdir(path.join(SNAPSHOT_DIR, league)).catch(() => [] as string[])) {
      if (!/^\d{4}-w\d{2}\.json$/.test(file)) continue;
      const text = await readFile(path.join(SNAPSHOT_DIR, league, file), 'utf8');
      await mkdir(path.join(OUT, 'snapshots', league), { recursive: true });
      await writeFile(path.join(OUT, 'snapshots', league, file), text);
      index.push(`${league}/${file}`);
    }
  }
  await write(path.join(OUT, 'snapshots', 'index.json'), index);
  return index.length;
}

const t0 = Date.now();
const built: string[] = [];
let failed = 0;
for (const id of LEAGUES) {
  try {
    await buildLeague(id);
    built.push(id);
  } catch (error) {
    console.error(`build failed for ${id}:`, (error as Error).message);
    if (await carryOver(id)) built.push(id); else failed++;
  }
}
await write(path.join(OUT, 'leagues.json'), (await views.configuredLeagues(DEFAULT_LEAGUE)).filter(l => built.includes(l.id)));
await write(path.join(OUT, 'model.json'), views.model());
const snapshots = await publishSnapshots();
await write(path.join(OUT, 'manifest.json'), { builtAt: new Date().toISOString(), leagues: built });
console.log(`static data: ${built.length} leagues, ${snapshots} snapshot files, ${(bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
// Nothing at all to publish is a failed build; a league carried over from the last deploy is not.
process.exit(built.length === 0 || failed === LEAGUES.length ? 1 : 0);
