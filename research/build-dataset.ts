/**
 * Builds the chronological training table: one row per player-week with causal features
 * (engine/features.ts — the exact code the live server runs) and the realised league score.
 * Also measures how often players with each injury designation actually played.
 */
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FeatureState, FEATURE_NAMES, gameContext, type PlayerMeta } from '../engine/features.ts';
import { compileScoring, didPlay, hasForecast, scoreStatsExact } from '../engine/scoring.ts';
import { nflGames, sleeper, weekProjections, weekStats, type WeekLine } from '../server/sleeper.ts';
import { FIRST_SEASON, RAW_DIR, RESEARCH_DIR, weeksIn } from './fetch-history.ts';
import type { NflGame } from '../engine/types.ts';

const LEAGUE = '1312656463549726720';

function parseCsv(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const lines = text.split(/\r?\n/);
  const split = (line: string) => {
    const out: string[] = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]);
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = split(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    rows.push(row);
  }
  return rows;
}

async function main() {
  const state = await sleeper.state();
  const league = await sleeper.league(LEAGUE);
  const scoring = compileScoring(league.scoring);
  const players = await sleeper.players();
  const games = await nflGames();
  const gameIndex = new Map<string, NflGame>();
  for (const g of games) {
    gameIndex.set(`${g.season}:${g.week}:${g.home}`, g);
    gameIndex.set(`${g.season}:${g.week}:${g.away}`, g);
  }

  const idRows = parseCsv(await readFile(path.join(RAW_DIR, 'db_playerids.csv'), 'utf8'));
  const gsisToSleeper = new Map<string, string>();
  for (const r of idRows) if (r.gsis_id && r.gsis_id !== 'NA' && r.sleeper_id && r.sleeper_id !== 'NA') gsisToSleeper.set(r.gsis_id, r.sleeper_id);
  const injuryRows: { season: number; week: number; id: string; status: string }[] = [];
  const designation = new Map<string, string>(); // `${season}:${week}:${id}` → Q | D | O
  for (let s = FIRST_SEASON; s <= state.season; s++) {
    let text: string;
    try { text = await readFile(path.join(RAW_DIR, `injuries_${s}.csv`), 'utf8'); } catch { continue; }
    for (const r of parseCsv(text)) {
      if (r.game_type !== 'REG') continue;
      const id = gsisToSleeper.get(r.gsis_id);
      const code = r.report_status === 'Questionable' ? 'Q' : r.report_status === 'Doubtful' ? 'D' : r.report_status === 'Out' ? 'O' : '';
      if (!id || !code) continue;
      injuryRows.push({ season: s, week: Number(r.week), id, status: r.report_status });
      designation.set(`${s}:${r.week}:${id}`, code);
    }
  }

  let season = FIRST_SEASON;
  const meta = (id: string): PlayerMeta | undefined => {
    const p = players[id];
    if (!p) return undefined;
    return { pos: p.pos, birthDate: p.birthDate, yearsExp: p.yearsExp === null ? null : p.yearsExp - (state.season - season) };
  };
  const fs = new FeatureState(scoring, meta);

  const out = createWriteStream(path.join(RESEARCH_DIR, 'dataset.csv'));
  const header = ['season', 'week', 'player_id', 'pos', 'team', 'opp', 'played', 'y', 'inj', ...FEATURE_NAMES];
  out.write(header.join(',') + '\n');
  let rows = 0;

  const playedSets = new Map<string, Set<string>>(); // `${season}:${week}` → ids with a snap

  for (season = FIRST_SEASON; season <= state.season; season++) {
    fs.startSeason(season);
    const lastWeek = season < state.season ? weeksIn(season) : state.week - 1;
    for (let week = 1; week <= lastWeek; week++) {
      const f = { season, week, currentSeason: state.season, currentWeek: state.week };
      const [stats, proj] = await Promise.all([weekStats(f), weekProjections(f)]);
      const statById = new Map<string, WeekLine>(stats.map(s => [s.id, s]));
      const projById = new Map<string, WeekLine>(proj.filter(p => hasForecast(p.stats)).map(p => [p.id, p]));
      const candidates = new Set<string>([...projById.keys()]);
      const playedIds = new Set<string>();
      for (const s of stats) if (didPlay(s.stats)) { candidates.add(s.id); playedIds.add(s.id); }
      playedSets.set(`${season}:${week}`, playedIds);
      fs.clearAverages();
      for (const id of candidates) {
        const p = players[id];
        if (!p || p.pos === 'DEF' || id.startsWith('TEAM_')) continue;
        const pl = projById.get(id), sl = statById.get(id);
        const team = pl?.team ?? sl?.team ?? null;
        if (!team) continue;
        const game = gameIndex.get(`${season}:${week}:${team}`);
        const ctx = game ? gameContext(game, team) : undefined;
        const played = didPlay(sl?.stats);
        const y = played && sl ? scoreStatsExact(sl.stats, scoring) : 0;
        const x = fs.features(id, season, week, pl?.stats, ctx, team);
        const cells = [season, week, id, p.pos, team, ctx?.opponent ?? '', played ? 1 : 0, y.toFixed(3), designation.get(`${season}:${week}:${id}`) ?? '', ...Array.from(x, v => (Number.isNaN(v) ? '' : Number(v.toFixed(5))))];
        out.write(cells.join(',') + '\n');
        rows++;
      }
      fs.ingestWeek(season, week, stats, new Map([...projById].map(([id, line]) => [id, line.stats])));
    }
    console.log(`season ${season} done, ${rows} rows so far`);
  }
  await new Promise<void>(resolve => out.end(resolve));

  // ── Availability: P(plays | official game-status designation) ──
  const tally = new Map<string, { n: number; played: number }>();
  const add = (key: string, played: boolean) => {
    const t = tally.get(key) ?? { n: 0, played: 0 };
    t.n++;
    if (played) t.played++;
    tally.set(key, t);
  };
  for (const r of injuryRows) {
    const set = playedSets.get(`${r.season}:${r.week}`);
    if (!set) continue;
    const played = set.has(r.id);
    const pos = players[r.id]?.pos ?? 'UNK';
    add(r.status, played);
    add(`${r.status}:${['DL', 'LB', 'DB'].includes(pos) ? 'IDP' : pos === 'K' ? 'K' : 'OFF'}`, played);
  }
  const availability = Object.fromEntries([...tally].map(([k, v]) => [k, { n: v.n, rate: +(v.played / v.n).toFixed(4) }]));
  await writeFile(path.join(RESEARCH_DIR, 'availability.json'), JSON.stringify(availability, null, 2));
  console.log(`dataset rows: ${rows}`);
  console.log('availability', availability);
}

await main();
