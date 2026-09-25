/**
 * Ground-truth check for ESPN leagues: Sleeper stat lines, scored with the ESPN league's
 * translated rules, must reproduce ESPN's official per-player points in every completed week.
 */
import { espnLeague, espnMatchups } from '../server/espn.ts';
import { sleeper, weekStats } from '../server/sleeper.ts';
import { compileScoring, completeStats, round, scoreStats } from '../engine/scoring.ts';

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['espn-390483100', 'espn-1159035309'];
const state = await sleeper.state();
const players = await sleeper.players();
for (const id of ids) {
  const parsed = await espnLeague(id);
  const scoring = compileScoring(parsed.league.scoring);
  let checked = 0, mismatched = 0, unmapped = 0, teamChecked = 0, teamMismatched = 0;
  const byPos = new Map<string, { n: number; bad: number }>();
  const examples: string[] = [];
  for (let week = 1; week <= Math.min(parsed.league.lastScoredWeek, parsed.league.playoffWeekStart + 2); week++) {
    const [lines, matchups] = await Promise.all([weekStats({ season: parsed.league.season, week, currentSeason: state.season, currentWeek: state.week }), espnMatchups(id, week, true)]);
    const byId = new Map(lines.map(l => [l.id, l.stats]));
    for (const m of matchups) {
      let total = 0;
      for (const [pid, official] of Object.entries(m.playersPoints)) {
        const p = players[pid];
        if (!p) { unmapped++; if (examples.length < 12) examples.push(`unmapped ${pid} ${parsed.extraPlayers[pid]?.name}`); continue; }
        const line = byId.get(pid);
        const ours = line ? scoreStats(completeStats(line, p.pos), scoring) : 0;
        if (m.starters.includes(pid)) total += ours;
        checked++;
        const e = byPos.get(p.pos) ?? { n: 0, bad: 0 };
        e.n++;
        if (Math.abs(ours - official) > 0.011) {
          mismatched++; e.bad++;
          if (examples.length < 12) examples.push(`w${week} ${p.pos} ${p.name}: ours ${ours} vs ESPN ${official}  ${JSON.stringify(Object.fromEntries(Object.entries(line ? completeStats(line, p.pos) : {}).filter(([k]) => scoring.some(([s]) => s === k))))}`);
        }
        byPos.set(p.pos, e);
      }
      if (m.starters.length) {
        teamChecked++;
        if (Math.abs(round(total) - m.points) > 0.02) teamMismatched++;
      }
    }
  }
  console.log(JSON.stringify({ id, name: parsed.league.name, weeks: parsed.league.lastScoredWeek, checked, mismatched, unmapped, teamChecked, teamMismatched, unsupported: parsed.unsupportedScoring, byPos: Object.fromEntries(byPos) }, null, 1));
  for (const e of examples) console.log('  ', e);
}
