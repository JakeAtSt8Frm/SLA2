/**
 * Restores saved pregame forecasts before a static build: first the seed committed in
 * data/snapshot-seed/ (forecasts saved before the GitHub deploy existed), then the copy the last
 * deploy published under data/snapshots/. Entries are merged: for each player-week the most
 * recently saved forecast wins, so nothing recorded locally is lost.
 *
 * Usage: SLA_SITE_URL=https://… node scripts/pull-snapshots.ts
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SNAPSHOT_DIR } from '../server/snapshots.ts';

const SITE = (process.env.SLA_SITE_URL ?? '').replace(/\/+$/, '');
const SEED = path.resolve(import.meta.dirname, '..', 'data', 'snapshot-seed');
const NAME = /^[\w-]+\/\d{4}-w\d{2}\.json$/;
type Snapshot = Record<string, { at: number }>;

async function merge(name: string, incoming: Snapshot) {
  const file = path.join(SNAPSHOT_DIR, name);
  const local = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Snapshot;
  for (const [pid, entry] of Object.entries(incoming)) if (!local[pid] || (local[pid].at ?? 0) < (entry.at ?? 0)) local[pid] = entry;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(local));
}

let seeded = 0;
for (const league of await readdir(SEED).catch(() => [] as string[])) {
  for (const file of await readdir(path.join(SEED, league)).catch(() => [] as string[])) {
    const name = `${league}/${file}`;
    if (!NAME.test(name)) continue;
    await merge(name, JSON.parse(await readFile(path.join(SEED, name), 'utf8')) as Snapshot);
    seeded++;
  }
}
console.log(`merged ${seeded} seed snapshot files`);

let index: string[] = [];
if (SITE) {
  try {
    const res = await fetch(`${SITE}/data/snapshots/index.json`, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) index = await res.json() as string[];
    else console.log(`no published snapshots yet (${res.status})`);
  } catch (error) {
    console.warn('could not reach the live site:', (error as Error).message);
  }
} else console.log('SLA_SITE_URL not set; skipping the live site');
let pulled = 0;
for (let i = 0; i < index.length; i += 16) {
  await Promise.all(index.slice(i, i + 16).filter(name => NAME.test(name)).map(async name => {
    const res = await fetch(`${SITE}/data/snapshots/${name}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!res?.ok) return;
    await merge(name, await res.json() as Snapshot);
    pulled++;
  }));
}
if (SITE) console.log(`pulled ${pulled} of ${index.length} snapshot files from ${SITE}`);
