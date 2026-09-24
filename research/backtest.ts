/**
 * 1. Runtime parity: the TypeScript tree evaluator must reproduce sklearn's predictions.
 * 2. Lineup backtest on the league's real 2025 rosters: for every team-week, set the best
 *    legal lineup using (a) the SLA model and (b) the raw provider projection, both rescored
 *    for the league and both using only pregame injury designations, then score the lineups
 *    with what actually happened. Compared with the lineups managers really started.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FEATURE_NAMES } from '../engine/features.ts';
import { ProjectionModel, type ModelFile } from '../engine/model.ts';
import { optimizeLineup } from '../engine/optimizer.ts';
import { starterSlots } from '../engine/positions.ts';
import { round } from '../engine/scoring.ts';
import { sleeper } from '../server/sleeper.ts';
import { RESEARCH_DIR } from './fetch-history.ts';

const LEAGUE_2025 = '1180280389862244352';
const MODEL_DIR = path.join(RESEARCH_DIR, '..', 'model');

function readCsv(text: string): Record<string, string>[] {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',');
  return lines.map(line => {
    const cells = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

async function parity(model: ProjectionModel) {
  const fixture = readCsv(await readFile(path.join(RESEARCH_DIR, 'parity_fixture.csv'), 'utf8'));
  const wanted = new Map(fixture.map(r => [`${r.season}:${r.week}:${r.player_id}`, Number(r.expected)]));
  const text = await readFile(path.join(RESEARCH_DIR, 'dataset.csv'), 'utf8');
  const lines = text.split('\n');
  const header = lines[0].split(',');
  const offset = header.indexOf(FEATURE_NAMES[0]);
  let maxDiff = 0, checked = 0;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = line.split(',');
    const key = `${cells[0]}:${cells[1]}:${cells[2]}`;
    const expected = wanted.get(key);
    if (expected === undefined) continue;
    const x = new Float64Array(FEATURE_NAMES.length);
    for (let i = 0; i < FEATURE_NAMES.length; i++) {
      const v = cells[offset + i];
      x[i] = v === '' ? Number.NaN : Number(v);
    }
    maxDiff = Math.max(maxDiff, Math.abs(model.predict(x) - expected));
    checked++;
  }
  console.log(`runtime parity: ${checked} rows, max |TS - sklearn| = ${maxDiff.toExponential(2)}`);
  if (checked < 300 || maxDiff > 1e-3) throw new Error('TypeScript model runtime does not match the trained model');
  return { checked, maxDiff };
}

async function main() {
  const file = JSON.parse(await readFile(path.join(MODEL_DIR, 'model.json'), 'utf8')) as ModelFile;
  const model = new ProjectionModel(file);
  const parityResult = await parity(model);

  const rows = readCsv(await readFile(path.join(RESEARCH_DIR, 'backtest_2025.csv'), 'utf8'));
  const byKey = new Map(rows.map(r => [`${r.week}:${r.player_id}`, r]));
  const players = await sleeper.players();
  const league = await sleeper.league(LEAGUE_2025);
  const slots = starterSlots(league.rosterPositions);
  const status = (code: string) => (code === 'Q' ? 'Questionable' : code === 'D' ? 'Doubtful' : code === 'O' ? 'Out' : null);

  const totals = { model: 0, provider: 0, manager: 0, optimal: 0, teamWeeks: 0, modelBeatProvider: 0, providerBeatModel: 0 };
  const byWeek: { week: number; model: number; provider: number; manager: number; optimal: number }[] = [];
  let flips = 0, games = 0;
  const diffsByWeek = new Map<number, number[]>(); // model − provider per team-week
  for (let week = 1; week <= 17; week++) {
    const matchups = await sleeper.matchups(LEAGUE_2025, week, true);
    const week_ = { week, model: 0, provider: 0, manager: 0, optimal: 0 };
    const results = new Map<number, { model: number; provider: number; manager: number }>();
    for (const m of matchups) {
      if (!m.players.length) continue;
      const actual = (id: string) => {
        const r = byKey.get(`${week}:${id}`);
        return r && r.played === '1' ? Number(r.y) : 0;
      };
      const pool = (pick: 'model' | 'provider' | 'actual') => m.players.flatMap(id => {
        const p = players[id];
        if (!p) return [];
        const r = byKey.get(`${week}:${id}`);
        if (pick === 'actual') return [{ id, eligible: p.eligible, value: actual(id) }];
        if (!r) return [];
        const base = pick === 'model' ? Number(r.model) : r.provider === '' ? Number.NaN : Number(r.provider);
        if (!Number.isFinite(base)) return [];
        return [{ id, eligible: p.eligible, value: base * model.playProbability(status(r.inj), true) }];
      });
      const score = (ids: (string | null)[]) => ids.reduce((s, id) => s + (id ? actual(id) : 0), 0);
      const modelPts = score(optimizeLineup(slots, pool('model')).ids);
      const providerPts = score(optimizeLineup(slots, pool('provider')).ids);
      const optimalPts = optimizeLineup(slots, pool('actual')).total;
      const managerPts = m.points;
      totals.model += modelPts; totals.provider += providerPts; totals.manager += managerPts; totals.optimal += optimalPts; totals.teamWeeks++;
      diffsByWeek.set(week, [...(diffsByWeek.get(week) ?? []), modelPts - providerPts]);
      if (modelPts > providerPts + 1e-9) totals.modelBeatProvider++;
      if (providerPts > modelPts + 1e-9) totals.providerBeatModel++;
      week_.model += modelPts; week_.provider += providerPts; week_.manager += managerPts; week_.optimal += optimalPts;
      results.set(m.rosterId, { model: modelPts, provider: providerPts, manager: managerPts });
    }
    // How many real head-to-head results would the manager have flipped using the SLA lineup?
    const pairs = new Map<number, number[]>();
    for (const m of matchups) if (m.matchupId !== null) pairs.set(m.matchupId, [...(pairs.get(m.matchupId) ?? []), m.rosterId]);
    for (const [a, b] of [...pairs.values()].filter(p => p.length === 2)) {
      const ra = results.get(a), rb = results.get(b);
      if (!ra || !rb) continue;
      games += 2;
      if (Math.sign(ra.model - rb.manager) !== Math.sign(ra.manager - rb.manager)) flips++;
      if (Math.sign(rb.model - ra.manager) !== Math.sign(rb.manager - ra.manager)) flips++;
    }
    const n = results.size || 1;
    byWeek.push({ week, model: round(week_.model / n), provider: round(week_.provider / n), manager: round(week_.manager / n), optimal: round(week_.optimal / n) });
  }
  const per = (v: number) => round(v / totals.teamWeeks);
  // Week-clustered bootstrap of the model − provider lineup gain (team-weeks share a slate).
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const weeksList = [...diffsByWeek.values()];
  const boots: number[] = [];
  for (let b = 0; b < 4000; b++) {
    let sum = 0, n = 0;
    for (let k = 0; k < weeksList.length; k++) {
      const w = weeksList[Math.floor(rand() * weeksList.length)];
      for (const d of w) { sum += d; n++; }
    }
    boots.push(sum / n);
  }
  boots.sort((a, b) => a - b);
  const gainCI = [round(boots[Math.floor(0.025 * boots.length)]), round(boots[Math.floor(0.975 * boots.length)])];
  const summary = {
    season: 2025,
    teamWeeks: totals.teamWeeks,
    perTeamWeek: { model: per(totals.model), provider: per(totals.provider), manager: per(totals.manager), optimal: per(totals.optimal) },
    modelMinusProvider: per(totals.model - totals.provider),
    modelMinusProviderCI: gainCI,
    modelMinusManager: per(totals.model - totals.manager),
    modelBeatProvider: totals.modelBeatProvider,
    providerBeatModel: totals.providerBeatModel,
    captureRate: { model: round(totals.model / totals.optimal, 4), provider: round(totals.provider / totals.optimal, 4), manager: round(totals.manager / totals.optimal, 4) },
    resultFlipsVsManager: { flips, games },
    byWeek,
    parity: parityResult,
  };
  console.log(JSON.stringify({ ...summary, byWeek: undefined }, null, 2));
  const reportPath = path.join(MODEL_DIR, 'report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  report.lineupBacktest = summary;
  await writeFile(reportPath, JSON.stringify(report, null, 1));
}

await main();
