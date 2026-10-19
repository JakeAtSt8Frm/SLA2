/**
 * Prospective track record. Historical projections can't prove what was known pregame, so
 * every forecast served before kickoff is saved; once the week is final the saved forecasts are
 * scored against what happened. This is the honest, leakage-free accuracy number.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { LeagueCore } from './league.ts';
import { compileScoring, completeStats, didPlay, round, scoreStats } from '../engine/scoring.ts';

export const SNAPSHOT_DIR = process.env.SLA_SNAPSHOT_DIR ?? path.resolve(import.meta.dirname, '..', 'data', 'snapshots');
const DIR = SNAPSHOT_DIR;
const lastWrite = new Map<string, number>();

export interface SavedForecast { exp: number; mean: number; play: number; provider: number | null; at: number; owner: number | null }
type Snapshot = Record<string, SavedForecast>;

/** Legacy snapshots are usable only when their timestamp proves they preceded kickoff. */
export function verifiedSnapshot(entry: SavedForecast | undefined, kickoff: number | null | undefined): SavedForecast | null {
  return entry && Number.isFinite(entry.at) && kickoff != null && Number.isFinite(kickoff) && entry.at < kickoff ? entry : null;
}

const fileFor = (leagueId: string, season: number, week: number) => path.join(DIR, leagueId, `${season}-w${String(week).padStart(2, '0')}.json`);

async function read(file: string): Promise<Snapshot> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Snapshot; } catch { return {}; }
}

/** Saved pregame forecasts for some weeks of a season (weeks without a file are left out). */
export async function readSnapshots(leagueId: string, season: number, weeks: readonly number[]): Promise<Map<number, Readonly<Snapshot>>> {
  const out = new Map<number, Snapshot>();
  await Promise.all(weeks.map(async w => {
    const snap = await read(fileFor(leagueId, season, w));
    if (Object.keys(snap).length) out.set(w, snap);
  }));
  return out;
}

/** Record pregame forecasts for rostered players and anyone projected to matter. */
export async function recordSnapshot(core: Pick<LeagueCore, 'id' | 'season' | 'week' | 'forecasts' | 'ownerOf'>): Promise<void> {
  if (core.week === null) return;
  const now = Date.now();
  const key = `${core.id}:${core.season}:${core.week}`;
  if (now - (lastWrite.get(key) ?? 0) < 5 * 60_000) return;
  const forecasts = core.forecasts.get(core.week);
  if (!forecasts) return;
  const file = fileFor(core.id, core.season, core.week);
  const snap = await read(file);
  let changed = 0;
  for (const [id, f] of forecasts) {
    if (f.kickoff === null || !Number.isFinite(f.kickoff) || f.kickoff <= now) continue;
    if (f.live && f.live.status !== 'pre_game') continue; // frozen at kickoff
    if (f.bye || (f.expected < 1 && !core.ownerOf.has(id))) continue;
    snap[id] = { exp: round(f.expected, 2), mean: round(f.mean, 2), play: round(f.play, 3), provider: f.provider === null ? null : round(f.provider, 2), at: now, owner: core.ownerOf.get(id) ?? null };
    changed++;
  }
  if (!changed) return;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(snap));
  await rename(tmp, file);
  lastWrite.set(key, now);
}

/** Score saved pregame forecasts for completed weeks against realised points. */
type TrackingCore = Pick<LeagueCore, 'id' | 'season' | 'lastScored' | 'statsByWeek' | 'projectionsByWeek' | 'gameFor'> & {
  league: Pick<LeagueCore['league'], 'scoring'>;
  players: Record<string, Pick<LeagueCore['players'][string], 'pos'>>;
};

export async function trackRecord(core: TrackingCore) {
  const scoring = compileScoring(core.league.scoring);
  let excludedSnapshots = 0;
  const weeks: { week: number; players: number; pairs: number; excluded: number; maeModel: number; maeProvider: number; biasModel: number; pairAcc: number | null }[] = [];
  for (let w = 1; w <= core.lastScored; w++) {
    const snap = await read(fileFor(core.id, core.season, w));
    const stats = core.statsByWeek.get(w);
    if (!Object.keys(snap).length || !stats) continue;
    let n = 0, em = 0, ep = 0, bias = 0, excluded = 0;
    const rows: { exp: number; actual: number; pos: string }[] = [];
    for (const [id, e] of Object.entries(snap)) {
      if (e.owner === null || e.provider === null) continue;
      const line = stats.get(id);
      const team = line?.team ?? core.projectionsByWeek.get(w)?.get(id)?.team;
      if (!verifiedSnapshot(e, team ? core.gameFor(team, w)?.kickoff : null)) { excluded++; continue; }
      const pos = core.players[id]?.pos;
      const actual = line && pos && didPlay(line.stats) ? scoreStats(completeStats(line.stats, pos), scoring) : 0;
      n++;
      em += Math.abs(e.exp - actual);
      ep += Math.abs(e.provider * e.play - actual);
      bias += e.exp - actual;
      rows.push({ exp: e.exp, actual, pos: core.players[id]?.pos ?? '' });
    }
    excludedSnapshots += excluded;
    if (!n) continue;
    let hits = 0, pairs = 0;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].pos !== rows[j].pos || rows[i].actual === rows[j].actual) continue;
      pairs++;
      if (Math.sign(rows[i].exp - rows[j].exp) === Math.sign(rows[i].actual - rows[j].actual)) hits++;
      else if (rows[i].exp === rows[j].exp) hits += 0.5;
    }
    weeks.push({ week: w, players: n, pairs, excluded, maeModel: round(em / n, 3), maeProvider: round(ep / n, 3), biasModel: round(bias / n, 3), pairAcc: pairs ? round(hits / pairs, 4) : null });
  }
  return { weeks, excludedSnapshots, note: 'Rostered players with a provider projection and a saved timestamp verified before kickoff. Both forecasts include the same chance to play. Lower MAE is better; positive bias means overprediction. Pair accuracy compares same-position players, excludes actual ties and gives tied forecasts half credit. Historical replays are excluded.' };
}
