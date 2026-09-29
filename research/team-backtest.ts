/**
 * Team-level backtest of the weekly and season projections on the league's real rosters.
 *
 * For every team-week of recent seasons it records what the app would have projected from that
 * week's out-of-sample player forecasts (research/oos[-key].csv: each season predicted by a model
 * trained only on earlier seasons) and what the team then scored:
 *   - optimal: best legal lineup by expected points (what the season sim uses for future weeks)
 *   - asSet: the lineup the manager actually started, projected
 *   - sd: the lineup's model-implied standard deviation
 *   - actual: the manager's starters scored with this season's rules (0 for anyone who sat out)
 * research/review.py turns this into bias, spread and horizon calibration.
 *
 * Usage: node research/team-backtest.ts [leagueId]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { variance } from '../engine/distribution.ts';
import { ProjectionModel, type ModelFile } from '../engine/model.ts';
import { optimizeLineup } from '../engine/optimizer.ts';
import { starterSlots } from '../engine/positions.ts';
import { modelKey } from '../server/league.ts';
import { sleeper } from '../server/sleeper.ts';
import { sourceFor } from '../server/source.ts';
import { RESEARCH_DIR } from './fetch-history.ts';
import type { Pos } from '../engine/types.ts';

const LEAGUE = process.argv[2] ?? '1312656463549726720';
const KEY = modelKey(LEAGUE);
const SUFFIX = KEY === 'default' ? '' : `-${KEY}`;

function readCsv(text: string): Record<string, string>[] {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',');
  return lines.map(line => {
    const cells = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

async function main() {
  const file = JSON.parse(await readFile(path.join(RESEARCH_DIR, '..', 'model', `model${SUFFIX}.json`), 'utf8')) as ModelFile;
  const model = new ProjectionModel(file);
  const rows = readCsv(await readFile(path.join(RESEARCH_DIR, `oos${SUFFIX}.csv`), 'utf8'));
  const byKey = new Map(rows.map(r => [`${r.season}:${r.week}:${r.player_id}`, r]));
  const players = await sleeper.players();
  const status = (code: string) => (code === 'Q' ? 'Questionable' : code === 'D' ? 'Doubtful' : code === 'O' ? 'Out' : null);
  const out: string[] = ['season,week,roster,opponent,optimal,optimal_sd,as_set,as_set_sd,actual,hindsight'];
  const starters: string[] = ['season,week,roster,player_id,pos,inj,mean,play,expected,actual,played'];

  // Walk back through the league's seasons that have out-of-sample forecasts.
  const seasons = new Set(rows.map(r => Number(r.season)));
  let id: string | null = LEAGUE;
  while (id) {
    const src = sourceFor(id);
    const league = await src.league().catch(() => null);
    if (!league) break;
    if (seasons.has(league.season)) {
      const slots = starterSlots(league.rosterPositions);
      const state = await sleeper.state();
      const final = league.season < state.season;
      for (let week = 1; week < league.playoffWeekStart; week++) {
        const matchups = await src.matchups(week, final).catch(() => []);
        const opponents = new Map<number, number>();
        for (const m of matchups) for (const o of matchups) if (m !== o && m.matchupId !== null && m.matchupId === o.matchupId) opponents.set(m.rosterId, o.rosterId);
        for (const m of matchups) {
          if (!m.players.length) continue;
          const info = (pid: string) => {
            const r = byKey.get(`${league.season}:${week}:${pid}`);
            const p = players[pid];
            if (!r || !p) return null;
            const mean = Number(r.model);
            const play = model.playProbability(status(r.inj), true);
            const outcome = { mean, play, residuals: model.quantiles(p.pos as Pos, mean) };
            return { pid, eligible: p.eligible, mean, play, expected: play * mean, var: variance(outcome), actual: r.played === '1' ? Number(r.y) : 0 };
          };
          const pool = m.players.map(info).filter((x): x is NonNullable<ReturnType<typeof info>> => x !== null && Number.isFinite(x.mean));
          if (!pool.length) continue;
          const byPid = new Map(pool.map(x => [x.pid, x]));
          const lineup = (ids: (string | null)[]) => {
            let exp = 0, v = 0, act = 0;
            for (const pid of ids) {
              const x = pid ? byPid.get(pid) : undefined;
              if (!x) continue;
              exp += x.expected; v += x.var; act += x.actual;
            }
            return { exp, sd: Math.sqrt(v), act };
          };
          const optimal = lineup(optimizeLineup(slots, pool.map(x => ({ id: x.pid, eligible: x.eligible, value: x.expected }))).ids);
          const asSet = lineup(m.starters.filter(s => s !== '0'));
          for (const pid of m.starters) {
            const x = byPid.get(pid);
            const r = byKey.get(`${league.season}:${week}:${pid}`);
            if (x && r) starters.push([league.season, week, m.rosterId, pid, r.pos, r.inj, x.mean.toFixed(2), x.play.toFixed(3), x.expected.toFixed(2), x.actual.toFixed(2), r.played].join(','));
          }
          const hindsight = optimizeLineup(slots, pool.map(x => ({ id: x.pid, eligible: x.eligible, value: x.actual }))).total;
          out.push([league.season, week, m.rosterId, opponents.get(m.rosterId) ?? '', optimal.exp.toFixed(2), optimal.sd.toFixed(2), asSet.exp.toFixed(2), asSet.sd.toFixed(2), asSet.act.toFixed(2), hindsight.toFixed(2)].join(','));
        }
      }
      console.log(`${league.name} ${league.season}: done`);
    }
    id = league.previousId;
  }
  await writeFile(path.join(RESEARCH_DIR, `team_backtest${SUFFIX}.csv`), out.join('\n') + '\n');
  await writeFile(path.join(RESEARCH_DIR, `starter_backtest${SUFFIX}.csv`), starters.join('\n') + '\n');
  console.log(`wrote team_backtest${SUFFIX}.csv (${out.length - 1} team-weeks)`);
}

await main();
