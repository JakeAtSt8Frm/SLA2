/**
 * Ground-truth check: rescoring raw Sleeper stat lines with the league's settings must
 * reproduce Sleeper's official `players_points` and team totals for every week on record.
 */
import { sleeper, weekStats } from '../server/sleeper.ts';
import { compileScoring, round, scoreStats } from '../engine/scoring.ts';

const LEAGUE = process.argv[2] ?? '1312656463549726720';

async function main() {
  const state = await sleeper.state();
  let id: string | null = LEAGUE;
  const summary: Record<string, unknown>[] = [];
  while (id) {
    const league = await sleeper.league(id);
    const scoring = compileScoring(league.scoring);
    const lastWeek = league.season < state.season ? 17 : league.lastScoredWeek;
    let checked = 0, mismatched = 0, maxDelta = 0, teamChecked = 0, teamMismatched = 0;
    const examples: string[] = [];
    for (let week = 1; week <= lastWeek; week++) {
      const [stats, matchups] = await Promise.all([
        weekStats({ season: league.season, week, currentSeason: state.season, currentWeek: state.week }),
        sleeper.matchups(id, week, league.season < state.season),
      ]);
      const byId = new Map(stats.map(s => [s.id, s.stats]));
      for (const m of matchups) {
        for (const [pid, official] of Object.entries(m.playersPoints)) {
          const line = byId.get(pid);
          const ours = line ? scoreStats(line, scoring) : 0;
          checked++;
          const delta = Math.abs(ours - official);
          maxDelta = Math.max(maxDelta, delta);
          if (delta > 0.011) {
            mismatched++;
            if (examples.length < 5) examples.push(`w${week} ${pid}: ours ${ours} vs ${official}`);
          }
        }
        const starters = m.starters.filter(s => s !== '0');
        if (!starters.length) continue;
        teamChecked++;
        const total = round(starters.reduce((sum, pid) => sum + (byId.get(pid) ? scoreStats(byId.get(pid)!, scoring) : 0), 0));
        const official = m.customPoints ?? m.points;
        if (Math.abs(total - official) > 0.02) teamMismatched++;
      }
    }
    summary.push({ season: league.season, league: league.name, checked, mismatched, maxDelta: round(maxDelta, 4), teamChecked, teamMismatched, examples });
    id = league.previousId;
  }
  console.log(JSON.stringify(summary, null, 2));
}

await main();
