/** JSON views over the league core. Everything returned here is what the web app renders. */
import { readFileSync } from 'node:fs';
import { memo, HOUR } from './cache.ts';
import { prepare } from './http.ts';
import { getCore, modelFor, onCoreBuilt, playoffShape, type LeagueCore } from './league.ts';
import { sleeper, type SleeperMatchup } from './sleeper.ts';
import { sourceFor } from './source.ts';
import { configuredEspnLeagues } from './espn.ts';
import { explainInputs, outcomeOf, type WeekForecast } from '../engine/forecast.ts';
import { exceedProbability, normalCdf } from '../engine/distribution.ts';
import { bestLineup, lineupStats } from '../engine/lineup.ts';
import { powerRankings } from '../engine/power.ts';
import { seasonAwards, summarizeSeason, type TeamWeek } from '../engine/recap.ts';
import { compileScoring, didPlay, hasForecast, round, scoreBreakdown, scoreStats, categoryPoints, completeStats, STAT_LABELS } from '../engine/scoring.ts';
import { simulateMatchup, simulateSeason, type TeamWeekDist } from '../engine/simulate.ts';
import { analyzeTradeSide } from '../engine/trade.ts';
import { waiverRecommendations } from '../engine/waivers.ts';
import { buildDefenseIndex, type DefenseRow } from '../engine/defense.ts';
import { canFill, starterSlots } from '../engine/positions.ts';
import type { Pos, Stats } from '../engine/types.ts';

const r1 = (n: number) => round(n, 1);
const SEASON_SIMS = 12000;
const r2 = (n: number) => round(n, 2);
const pct = (n: number) => round(n, 4);

// ─── Shared helpers ──────────────────────────────────────────────────────────

const derived = new WeakMap<LeagueCore, Map<string, unknown>>();
function once<T>(core: LeagueCore, key: string, compute: () => T): T {
  let bag = derived.get(core);
  if (!bag) { bag = new Map(); derived.set(core, bag); }
  if (!bag.has(key)) bag.set(key, compute());
  return bag.get(key) as T;
}

interface RankInfo { rank: number; outOf: number }
interface SeasonLine { gp: number; total: number; ppg: number; last3: number; snap: number | null; weeks: { week: number; pts: number }[]; totalRank: RankInfo | null; ppgRank: RankInfo | null }
function seasonLines(core: LeagueCore): Map<string, SeasonLine> {
  return once(core, 'seasonLines', () => {
    const scoring = compileScoring(core.league.scoring);
    const out = new Map<string, SeasonLine>();
    for (let w = 1; w <= core.lastScored; w++) {
      const lines = core.statsByWeek.get(w);
      if (!lines) continue;
      for (const [id, line] of lines) {
        if (!didPlay(line.stats) || !core.players[id]) continue;
        const s = out.get(id) ?? { gp: 0, total: 0, ppg: 0, last3: 0, snap: null, weeks: [], totalRank: null, ppgRank: null };
        s.gp++;
        const pts = scoreStats(completeStats(line.stats, core.players[id].pos), scoring);
        s.total += pts;
        s.weeks.push({ week: w, pts });
        out.set(id, s);
      }
    }
    for (const [id, s] of out) {
      s.ppg = s.total / s.gp;
      const last = s.weeks.slice(-3);
      s.last3 = last.reduce((a, b) => a + b.pts, 0) / last.length;
      const shares = s.weeks.slice(-3).map(({ week }) => {
        const st = core.statsByWeek.get(week)?.get(id)?.stats;
        if (!st) return null;
        const idp = ['DL', 'LB', 'DB'].includes(core.players[id].pos);
        const snaps = idp ? st.def_snp : st.off_snp, team = idp ? st.tm_def_snp : st.tm_off_snp;
        return snaps && team ? snaps / team : null;
      }).filter((v): v is number => v !== null);
      s.snap = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null;
    }
    // SLA 1.0 position ranks: Total among everyone who scored; PPG needs a minimum number of games
    // (min(6, max(3, 55% of weeks played))), capped at the weeks played so early-season ranks exist.
    const minGames = Math.min(core.lastScored, Math.min(6, Math.max(3, Math.floor(core.lastScored * 0.55))));
    const byPos = new Map<string, [string, SeasonLine][]>();
    for (const [id, s] of out) {
      const pos = core.players[id]?.pos;
      if (!pos) continue;
      if (!byPos.has(pos)) byPos.set(pos, []);
      byPos.get(pos)!.push([id, s]);
    }
    for (const list of byPos.values()) {
      const byTotal = list.filter(([, s]) => s.total > 0).sort((a, b) => b[1].total - a[1].total);
      byTotal.forEach(([, s], i) => { s.totalRank = { rank: i + 1, outOf: byTotal.length }; });
      const byPpg = list.filter(([, s]) => s.gp >= Math.max(1, minGames)).sort((a, b) => b[1].ppg - a[1].ppg);
      byPpg.forEach(([, s], i) => { s.ppgRank = { rank: i + 1, outOf: byPpg.length }; });
    }
    return out;
  });
}

function forecastView(f: WeekForecast | undefined) {
  if (!f) return null;
  return {
    week: f.week, exp: r2(f.expected), mean: r2(f.mean), play: pct(f.play), floor: r1(f.floor), median: r1(f.median), ceiling: r1(f.ceiling),
    provider: f.provider === null ? null : r2(f.provider), opp: f.opponent, home: f.home, kickoff: f.kickoff, bye: f.bye, live: f.live ? { status: f.live.status, points: r2(f.live.points) } : null,
    boom: pct(exceedProbability(outcomeOf(f), Math.max(10, f.mean * 1.5))),
    bust: pct(1 - exceedProbability(outcomeOf(f), f.mean * 0.5)),
  };
}

function playerRow(core: LeagueCore, id: string) {
  const p = core.players[id];
  const week = core.week;
  const v = core.values.get(id);
  const s = seasonLines(core).get(id);
  const owner = core.ownerOf.get(id) ?? null;
  const roster = owner !== null ? core.teams.find(t => t.rosterId === owner)?.roster : undefined;
  return {
    id, name: p.name, pos: p.pos, eligible: p.eligible, team: p.team, age: p.age === null ? null : Math.floor(p.age), exp: p.yearsExp,
    injury: p.injuryStatus, injuryPart: p.injuryBodyPart, number: p.number,
    owner, slot: roster ? (roster.reserve.includes(id) ? 'IR' : roster.taxi.includes(id) ? 'TAXI' : roster.starters.includes(id) ? 'START' : 'BN') : null,
    week: week !== null ? forecastView(core.forecasts.get(week)?.get(id)) : null,
    value: v ? { value: r1(v.value), dynasty: r1(v.dynasty), vorp: r2(v.vorp), rosAvg: r2(v.rosAvg), rosTotal: r1(v.rosTotal), posRank: v.posRank, rank: v.overallRank, tier: v.tier } : null,
    season: s ? { gp: s.gp, total: r1(s.total), ppg: r2(s.ppg), last3: r2(s.last3), snap: s.snap === null ? null : pct(s.snap), weeks: s.weeks.map(x => [x.week, r1(x.pts)]) } : null,
    ranks: { total: s?.totalRank ?? null, ppg: s?.ppgRank ?? null },
    trending: core.trending.get(id) ?? 0,
  };
}

function teamView(core: LeagueCore, rosterId: number) {
  const t = core.teams.find(x => x.rosterId === rosterId)!;
  const s = core.summaries.get(rosterId);
  return {
    rosterId, name: t.name, owner: t.owner, avatar: t.avatar,
    wins: t.roster.wins, losses: t.roster.losses, ties: t.roster.ties,
    pointsFor: r2(t.roster.pointsFor), pointsAgainst: r2(t.roster.pointsAgainst),
    faabRemaining: Math.max(0, core.league.waiverBudget - t.roster.faabUsed),
    waiverPosition: t.roster.waiverPosition || null,
    streak: s?.streak ?? '',
  };
}

/**
 * Not every manager starts their best lineup. Replaying this league's 2024–25 seasons, the lineups
 * actually started were worth 68–97% of each team's best projected lineup, and a team's rate carried
 * from the first half of the season into the second. Scaling a team's future weeks by its lineup
 * efficiency relative to the league (shrunk toward average with six weeks of prior) cut the error of
 * second-half team projections by 6–13% and the Brier score of game win probabilities by 6–12%
 * (research/review.py). 1 means league-average lineup setting.
 */
function managerFactor(core: LeagueCore, rosterId: number): number {
  const factors = once(core, 'managerFactors', () => {
    const PRIOR_WEEKS = 6;
    let points = 0, optimal = 0;
    for (const s of core.summaries.values()) { points += s.pointsFor; if (s.efficiency > 0) optimal += s.pointsFor / s.efficiency; }
    const league = optimal > 0 ? points / optimal : 0;
    const out = new Map<number, number>();
    for (const s of core.summaries.values()) {
      const n = s.weekly.length;
      const relative = league > 0 && s.efficiency > 0 ? s.efficiency / league : 1;
      out.set(s.rosterId, Math.min(1.1, Math.max(0.8, (n * relative + PRIOR_WEEKS) / (n + PRIOR_WEEKS))));
    }
    return out;
  });
  return factors.get(rosterId) ?? 1;
}

/** A team's score distribution for a week: its best lineup, scaled by how its manager sets lineups (unless `asOptimized`). */
function teamDist(core: LeagueCore, rosterId: number, week: number, asOptimized = false): TeamWeekDist {
  const l = core.bestByWeek.get(`${rosterId}:${week}`);
  if (!l) return { mean: 0, sd: 25 };
  return lineupDist(l, asOptimized ? 1 : managerFactor(core, rosterId));
}

// Player errors are close to independent across NFL teams; add a small common-mode term.
const lineupDist = (l: { expected: number; sd: number }, factor: number): TeamWeekDist =>
  ({ mean: l.expected * factor, sd: Math.sqrt(l.sd ** 2 + (0.03 * l.expected * factor) ** 2) });

function seasonSim(core: LeagueCore) {
  return once(core, 'seasonSim', () => {
    const remaining: { week: number; a: number; b: number }[] = [];
    if (core.week !== null) {
      for (let w = core.week; w <= core.lastRegularWeek; w++) {
        const ms = core.schedule.get(w) ?? [];
        const byMatch = new Map<number, number[]>();
        for (const m of ms) if (m.matchupId !== null) byMatch.set(m.matchupId, [...(byMatch.get(m.matchupId) ?? []), m.rosterId]);
        for (const pair of byMatch.values()) if (pair.length === 2) remaining.push({ week: w, a: pair[0], b: pair[1] });
      }
    }
    const shape = playoffShape(core.league);
    return simulateSeason({
      teams: core.teams.map(t => t.rosterId),
      record: new Map(core.teams.map(t => [t.rosterId, { wins: t.roster.wins, losses: t.roster.losses, ties: t.roster.ties, pointsFor: t.roster.pointsFor }])),
      remaining,
      dist: (rid, w) => (core.bestByWeek.has(`${rid}:${w}`) ? teamDist(core, rid, w) : { mean: 0, sd: 1 }),
      playoffTeams: core.league.playoffTeams,
      playoffStart: core.league.playoffWeekStart,
      roundWeeks: shape.roundWeeks,
      finalWeeks: shape.finalWeeks,
      leverageWeek: core.week ?? 0,
      seed: `${core.id}:${core.week}`,
      sims: SEASON_SIMS,
    });
  });
}

function power(core: LeagueCore) {
  return once(core, 'power', () => {
    const upcoming = core.horizon.filter(w => w <= core.lastRegularWeek).slice(0, 6);
    return powerRankings(core.teams.map(t => {
      const s = core.summaries.get(t.rosterId)!;
      const outlook = upcoming.length ? upcoming.reduce((a, w) => a + (core.bestByWeek.get(`${t.rosterId}:${w}`)?.expected ?? 0), 0) / upcoming.length : 0;
      return { rosterId: t.rosterId, weekly: s.weekly, allPlayWins: s.allPlayWins, allPlayGames: s.allPlayWins + s.allPlayLosses, outlook };
    }), core.results.length);
  });
}

function matchupPairs(ms: readonly SleeperMatchup[]): [SleeperMatchup, SleeperMatchup | null][] {
  const byId = new Map<number, SleeperMatchup[]>();
  const solo: SleeperMatchup[] = [];
  for (const m of ms) {
    if (m.matchupId === null) solo.push(m);
    else byId.set(m.matchupId, [...(byId.get(m.matchupId) ?? []), m]);
  }
  return [...[...byId.values()].map(p => [p[0], p[1] ?? null] as [SleeperMatchup, SleeperMatchup | null]), ...solo.map(m => [m, null] as [SleeperMatchup, SleeperMatchup | null])];
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

export async function bootstrap(id: string) {
  const core = await getCore(id);
  return once(core, 'bootstrap', () => bootstrapView(core));
}

function bootstrapView(core: LeagueCore) {
  const nonzero = Object.entries(core.league.scoring).filter(([, v]) => v !== 0);
  return {
    league: {
      id: core.id, name: core.league.name, season: core.season, week: core.week, lastScored: core.lastScored, status: core.league.status,
      avatar: core.league.avatar ? `https://sleepercdn.com/avatars/thumbs/${core.league.avatar}` : null,
      slots: core.slots, rosterPositions: core.league.rosterPositions, totalRosters: core.league.totalRosters,
      playoffTeams: core.league.playoffTeams, playoffWeekStart: core.league.playoffWeekStart, lastRegularWeek: core.lastRegularWeek, lastWeek: core.lastWeek,
      isDynasty: core.league.isDynasty, waiverBudget: core.league.waiverBudget, tradeDeadline: core.league.tradeDeadline,
      scoringRules: nonzero.length, idpSlots: core.slots.filter(s => ['DL', 'LB', 'DB', 'IDP_FLEX'].includes(s)).length,
      previousId: core.league.previousId,
      scoring: Object.fromEntries(nonzero),
      reserveSlots: core.league.reserveSlots ?? 0,
      taxiSlots: core.league.taxiSlots ?? 0,
      platform: core.platform,
      /** How free agents are claimed: blind FAAB bids, rolling waiver priority, or first come first served. */
      waiverMode: core.league.waiverBudget > 0 ? 'faab' : core.platform === 'espn' && core.teams.every(t => !t.roster.waiverPosition) ? 'free' : 'priority',
      /** Positions that can be started in this league, in display order. */
      positions: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'].filter(pos => core.slots.some(slot => canFill([pos as Pos], slot))),
    },
    teams: core.teams.map(t => teamView(core, t.rosterId)),
    myRosterId: core.myRosterId,
    model: modelMeta(core.id),
    generatedAt: core.generatedAt,
    warnings: core.warnings,
  };
}

export async function overview(id: string) {
  const core = await getCore(id);
  return once(core, 'overview', () => overviewView(core));
}

async function overviewView(core: LeagueCore) {
  const sim = seasonSim(core);
  const pw = power(core);
  const standings = core.teams.map(t => {
    const s = core.summaries.get(t.rosterId)!;
    const o = sim.teams.find(x => x.rosterId === t.rosterId)!;
    const p = pw.find(x => x.rosterId === t.rosterId)!;
    return {
      ...teamView(core, t.rosterId),
      allPlayWins: s.allPlayWins, allPlayLosses: s.allPlayLosses, expectedWins: r2(s.expectedWins), luck: r2(s.luck), efficiency: pct(s.efficiency),
      high: r1(s.high), weekly: s.weekly.map(r1),
      playoffPct: pct(o.playoffPct), champPct: pct(o.champPct), projWins: r1(o.meanWins), projLosses: r1(o.meanLosses),
      power: r1(p.score), powerRank: p.rank,
      nextWeek: core.week !== null ? r1(core.bestByWeek.get(`${t.rosterId}:${core.week}`)?.expected ?? 0) : null,
    };
  }).sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.pointsFor - a.pointsFor);
  return {
    standings,
    matchups: core.week !== null && core.week <= core.lastRegularWeek ? (await once(core, `matchups:${core.week}`, () => matchupsView(core, core.week!))).games : [],
    lastWeek: core.results.length ? weekRecap(core, core.results[core.results.length - 1]) : null,
    awards: seasonAwards(core.results, core.summaries, core.players, pickups(core)).slice(0, 6),
    transactions: transactionsView(core).slice(0, 8),
  };
}

function weekRecap(core: LeagueCore, rows: TeamWeek[]) {
  const top: { id: string; rosterId: number; pts: number }[] = [];
  for (const r of rows) for (const pid of r.starters) top.push({ id: pid, rosterId: r.rosterId, pts: r.playersPoints[pid] ?? 0 });
  top.sort((a, b) => b.pts - a.pts);
  const benched: { id: string; rosterId: number; pts: number }[] = [];
  for (const r of rows) for (const pid of Object.keys(r.playersPoints)) if (!r.starters.includes(pid)) benched.push({ id: pid, rosterId: r.rosterId, pts: r.playersPoints[pid] });
  benched.sort((a, b) => b.pts - a.pts);
  const nm = (x: { id: string; rosterId: number; pts: number }) => ({ id: x.id, name: core.players[x.id]?.name ?? x.id, pos: core.players[x.id]?.pos ?? '', rosterId: x.rosterId, pts: r2(x.pts) });
  return {
    week: rows[0]?.week ?? 0,
    results: rows.filter(r => r.opponentId !== null && r.result !== 'L').map(r => ({ winner: r.rosterId, loser: r.opponentId, winnerPts: r2(r.points), loserPts: r2(r.opponentPoints ?? 0) })),
    topPerformers: top.slice(0, 6).map(nm),
    benchBlunders: benched.slice(0, 4).map(nm),
    efficiency: rows.map(r => ({ rosterId: r.rosterId, points: r2(r.points), optimal: r2(r.optimal), left: r2(Math.max(0, r.optimal - r.points)) })).sort((a, b) => b.left - a.left),
  };
}

export async function matchups(id: string, requestedWeek?: number) {
  const core = await getCore(id);
  const week = requestedWeek ?? core.week ?? core.lastScored;
  return once(core, `matchups:${week}`, () => matchupsView(core, week));
}

async function matchupsView(core: LeagueCore, week: number) {
  const id = core.id;
  const ms = core.schedule.get(week) ?? (await sourceFor(id).matchups(week).catch(() => []));
  const isPast = week <= core.lastScored;
  const isCurrent = week === core.week;
  const forecasts = core.forecasts.get(week);
  const sim = isCurrent || !isPast ? seasonSim(core) : null;
  const games = matchupPairs(ms).map(([a, b]) => {
    const side = (m: SleeperMatchup) => {
      const starters = m.starters.map(s => (s === '0' ? null : s));
      const lineup = starterSlots(core.league.rosterPositions).map((slot, i) => {
        const pid = starters[i] ?? null;
        const f = pid ? forecasts?.get(pid) : undefined;
        return {
          slot, id: pid, name: pid ? core.players[pid]?.name ?? pid : null, pos: pid ? core.players[pid]?.pos ?? null : null, team: pid ? core.players[pid]?.team ?? null : null,
          points: pid && (isPast || isCurrent) ? r2(m.playersPoints[pid] ?? 0) : null,
          forecast: forecastView(f),
        };
      });
      const current = forecasts && !isPast ? lineupStats(core.slots, starters, forecasts) : null;
      const best = !isPast ? core.bestByWeek.get(`${m.rosterId}:${week}`) ?? null : null;
      return {
        rosterId: m.rosterId, points: r2(m.customPoints ?? m.points), lineup,
        projected: current ? r1(current.expected) : null, optimal: best ? r1(best.expected) : null,
        bench: isPast ? m.players.filter(pid => !m.starters.includes(pid)).map(pid => ({ id: pid, name: core.players[pid]?.name ?? pid, pos: core.players[pid]?.pos ?? '', points: r2(m.playersPoints[pid] ?? 0) })).sort((x, y) => y.points - x.points).slice(0, 8) : [],
      };
    };
    const A = side(a), B = b ? side(b) : null;
    let winProb: number | null = null, sim10: ReturnType<typeof simulateMatchup> | null = null, optimizedWinProb: number | null = null;
    if (b && forecasts && !isPast) {
      if (isCurrent) {
        const outcomes = (m: SleeperMatchup) => m.starters.filter(s => s !== '0').map(pid => forecasts.get(pid)).filter((f): f is WeekForecast => !!f).map(outcomeOf);
        sim10 = simulateMatchup(outcomes(a), outcomes(b), `${id}:${week}:${a.rosterId}:${b.rosterId}`, 8000);
        winProb = sim10.winProbA;
      } else {
        const key1 = `${week}:${a.rosterId}:${b.rosterId}`, key2 = `${week}:${b.rosterId}:${a.rosterId}`;
        winProb = sim?.gameWinProb.get(key1) ?? (sim?.gameWinProb.has(key2) ? 1 - sim.gameWinProb.get(key2)! : null);
      }
      const da = teamDist(core, a.rosterId, week, true), db = teamDist(core, b.rosterId, week, true);
      optimizedWinProb = normalCdf((da.mean - db.mean) / Math.sqrt(da.sd ** 2 + db.sd ** 2 || 1));
    }
    return {
      matchupId: a.matchupId, a: A, b: B,
      winProbA: winProb === null ? null : pct(winProb), optimizedWinProbA: optimizedWinProb === null ? null : pct(optimizedWinProb),
      range: sim10 ? { a: [r1(sim10.a.p10), r1(sim10.a.p50), r1(sim10.a.p90)], b: [r1(sim10.b.p10), r1(sim10.b.p50), r1(sim10.b.p90)], histogram: { lo: r1(sim10.histogram.lo), hi: r1(sim10.histogram.hi), a: sim10.histogram.a.map(pct), b: sim10.histogram.b.map(pct) } } : null,
      final: isPast,
    };
  });
  return { week, final: isPast, current: isCurrent, games, weeks: Array.from({ length: core.lastRegularWeek }, (_, i) => i + 1) };
}

export async function team(id: string, rosterId: number) {
  const core = await getCore(id);
  const t = core.teams.find(x => x.rosterId === rosterId);
  if (!t) throw new HttpError(404, 'Team not found');
  return once(core, `team:${rosterId}`, () => teamPage(core, t));
}

function teamPage(core: LeagueCore, t: LeagueCore['teams'][number]) {
  const rosterId = t.rosterId;
  const sim = seasonSim(core).teams.find(x => x.rosterId === rosterId)!;
  const s = core.summaries.get(rosterId)!;
  const roster = t.roster.players.map(pid => playerRow(core, pid)).filter(r => r.name);
  // Positional strength: this team's best-lineup expected points by slot group vs the league.
  const groups = ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'];
  const strength = core.week !== null ? groups.map(g => {
    const byTeam = core.teams.map(x => {
      const l = core.bestByWeek.get(`${x.rosterId}:${core.week}`);
      if (!l) return 0;
      return l.ids.reduce((sum, pid) => sum + (pid && core.players[pid]?.pos === g ? core.forecasts.get(core.week!)?.get(pid)?.expected ?? 0 : 0), 0);
    });
    const mine = byTeam[core.teams.findIndex(x => x.rosterId === rosterId)];
    const sorted = [...byTeam].sort((a, b) => b - a);
    return { group: g, points: r1(mine), leagueAvg: r1(byTeam.reduce((a, b) => a + b, 0) / byTeam.length), rank: sorted.indexOf(mine) + 1 };
  }).filter(g => core.slots.some(slot => slot === g.group || (g.group === 'QB' && slot === 'SUPER_FLEX'))) : [];
  const schedule = core.horizon.filter(w => w <= core.lastRegularWeek).map(w => {
    const m = core.schedule.get(w)?.find(x => x.rosterId === rosterId);
    const opp = m && m.matchupId !== null ? core.schedule.get(w)?.find(x => x.matchupId === m.matchupId && x.rosterId !== rosterId) : undefined;
    const da = teamDist(core, rosterId, w), db = opp ? teamDist(core, opp.rosterId, w) : null;
    return { week: w, opponent: opp?.rosterId ?? null, projected: r1(da.mean), opponentProjected: db ? r1(db.mean) : null, winProb: db ? pct(normalCdf((da.mean - db.mean) / Math.sqrt(da.sd ** 2 + db.sd ** 2))) : null };
  });
  const history = core.results.map(week => week.find(r => r.rosterId === rosterId)).filter((r): r is TeamWeek => !!r)
    .map(r => ({ week: r.week, points: r2(r.points), opponent: r.opponentId, opponentPoints: r.opponentPoints === null ? null : r2(r.opponentPoints), result: r.result, optimal: r2(r.optimal) }));
  return {
    team: teamView(core, rosterId),
    summary: { ...s, weekly: s.weekly.map(r1), pointsFor: r2(s.pointsFor), pointsAgainst: r2(s.pointsAgainst), efficiency: pct(s.efficiency), benchPoints: r1(s.benchPoints), expectedWins: r2(s.expectedWins), luck: r2(s.luck) },
    outlook: { ...sim, seedDist: sim.seedDist.map(pct), winsDist: sim.winsDist.map(pct) },
    roster,
    strength,
    schedule,
    history,
    transactions: transactionsView(core).filter(tx => tx.rosterIds.includes(rosterId)).slice(0, 20),
  };
}

export async function lineup(id: string, rosterId: number) {
  const core = await getCore(id);
  if (core.week === null) return { week: null, message: 'The season is over.' };
  const t = core.teams.find(x => x.rosterId === rosterId);
  const adv = core.advice.get(rosterId);
  if (!t || !adv) throw new HttpError(404, 'Team not found');
  return once(core, `lineup:${rosterId}`, () => lineupView(core, core.week!, t, adv));
}

function lineupView(core: LeagueCore, week: number, t: LeagueCore['teams'][number], adv: NonNullable<ReturnType<LeagueCore['advice']['get']>>) {
  const id = core.id, rosterId = t.rosterId;
  const f = core.forecasts.get(week)!;
  const bench = t.roster.players.filter(pid => !adv.optimal.ids.includes(pid) && !core.taxiOrIr.has(pid));
  const row = (pid: string | null) => (pid ? { ...playerRow(core, pid), locked: core.isLocked(pid) } : null);
  // Head-to-head odds against the opponent as set vs. as optimised.
  const ms = core.schedule.get(week) ?? [];
  const me = ms.find(m => m.rosterId === rosterId);
  const opp = me && me.matchupId !== null ? ms.find(m => m.matchupId === me.matchupId && m.rosterId !== rosterId) : undefined;
  let odds: { asSet: number; optimized: number; opponent: number } | null = null;
  if (opp) {
    const outcomes = (ids: (string | null)[]) => ids.filter((x): x is string => !!x).map(pid => f.get(pid)).filter((x): x is WeekForecast => !!x).map(outcomeOf);
    const oppIds = opp.starters.map(s => (s === '0' ? null : s));
    odds = {
      asSet: pct(simulateMatchup(outcomes(adv.current.ids), outcomes(oppIds), `${id}:${week}:set:${rosterId}`, 6000).winProbA),
      optimized: pct(simulateMatchup(outcomes(adv.optimal.ids), outcomes(oppIds), `${id}:${week}:opt:${rosterId}`, 6000).winProbA),
      opponent: opp.rosterId,
    };
  }
  return {
    week,
    slots: core.slots,
    current: adv.current.ids.map(row),
    optimal: adv.optimal.ids.map(row),
    currentTotal: r1(adv.current.expected), optimalTotal: r1(adv.optimal.expected), gain: r1(adv.gain),
    currentSd: r1(adv.current.sd), optimalSd: r1(adv.optimal.sd),
    swaps: adv.swaps.map(s => ({ ...s, gain: r2(s.gain), confidence: pct(s.confidence) })),
    moves: adv.moves,
    lockedSlots: adv.lockedSlots,
    warnings: adv.warnings,
    bench: bench.map(row).filter(Boolean).sort((a, b) => (b!.week?.exp ?? 0) - (a!.week?.exp ?? 0)),
    reserve: t.roster.players.filter(pid => core.taxiOrIr.has(pid)).map(row),
    odds,
  };
}

function pickups(core: LeagueCore) {
  const out: { rosterId: number; playerId: string; week: number }[] = [];
  for (const tx of core.transactions) {
    if (tx.type !== 'waiver' && tx.type !== 'free_agent') continue;
    for (const [pid, rid] of Object.entries(tx.adds)) out.push({ rosterId: rid, playerId: pid, week: tx.week });
  }
  return out;
}

function transactionsView(core: LeagueCore) {
  return core.transactions.map(tx => ({
    id: tx.id, type: tx.type, week: tx.week, created: tx.created, rosterIds: tx.rosterIds, faab: tx.faab,
    adds: Object.entries(tx.adds).map(([pid, rid]) => ({ id: pid, name: core.players[pid]?.name ?? pid, pos: core.players[pid]?.pos ?? '', rosterId: rid })),
    drops: Object.entries(tx.drops).map(([pid, rid]) => ({ id: pid, name: core.players[pid]?.name ?? pid, pos: core.players[pid]?.pos ?? '', rosterId: rid })),
    picks: tx.picks, budget: tx.budget,
  }));
}

export async function transactions(id: string) {
  const core = await getCore(id);
  return once(core, 'transactions', () => ({ transactions: transactionsView(core) }));
}

export async function waivers(id: string, rosterId: number) {
  const core = await getCore(id);
  const t = core.teams.find(x => x.rosterId === rosterId);
  if (!t) throw new HttpError(404, 'Team not found');
  if (core.week === null) return { week: null, recommendations: [], freeAgents: [] };
  return once(core, `waivers:${rosterId}`, () => {
    const benchSlots = core.league.rosterPositions.filter(s => s === 'BN').length;
    const active = t.roster.players.filter(pid => !core.taxiOrIr.has(pid));
    const rostered = new Set(core.ownerOf.keys());
    const freeAgents = core.relevant.filter(pid => !rostered.has(pid) && core.players[pid]?.team);
    const recs = waiverRecommendations({
      roster: active,
      starters: core.advice.get(rosterId)?.current.ids.map(x => x ?? '') ?? t.roster.starters,
      rosterLimit: core.slots.length + benchSlots,
      slots: core.slots,
      players: core.players,
      forecasts: core.forecasts,
      weeks: core.horizon,
      currentWeek: core.week!,
      freeAgents,
      otherRosters: core.teams.filter(x => x.rosterId !== rosterId).map(x => x.roster.players.filter(pid => !core.taxiOrIr.has(pid))),
      faabRemaining: Math.max(0, core.league.waiverBudget - t.roster.faabUsed),
      // Redraft rosters reset every year: a drop only costs what the player adds this season.
      dynasty: core.league.isDynasty ? new Map([...core.values].map(([pid, v]) => [pid, v.dynasty])) : new Map(),
      trending: core.trending,
      isLocked: core.isLocked,
      limit: 30,
    });
    // Everyone available who could plausibly matter: forecast to score, or has scored this season.
    const gainOf = new Map(recs.map(r => [r.id, r]));
    const fa = freeAgents.map(pid => ({ ...playerRow(core, pid), gain: gainOf.has(pid) ? r1(gainOf.get(pid)!.netGain) : null }))
      .filter(r => (r.week?.exp ?? 0) > 0.3 || (r.value?.rosAvg ?? 0) > 0.5 || (r.season?.ppg ?? 0) > 2)
      .sort((a, b) => (b.value?.rosAvg ?? 0) - (a.value?.rosAvg ?? 0));
    return {
      week: core.week,
      rosterCount: active.length,
      rosterLimit: core.slots.length + benchSlots,
      faabRemaining: Math.max(0, core.league.waiverBudget - t.roster.faabUsed),
      horizon: core.horizon,
      recommendations: recs.map(r => ({
        ...r, weekGain: r2(r.weekGain), rosGain: r1(r.rosGain), dropCost: r1(r.dropCost), netGain: r1(r.netGain),
        player: playerRow(core, r.id), drop: r.dropId ? playerRow(core, r.dropId) : null,
      })),
      availableCount: fa.length,
      freeAgents: fa,
    };
  });
}

export async function playoffs(id: string) {
  const core = await getCore(id);
  return once(core, 'playoffsView', () => playoffsView(core));
}

function playoffsView(core: LeagueCore) {
  const sim = seasonSim(core);
  const pw = power(core);
  return {
    week: core.week,
    playoffTeams: core.league.playoffTeams,
    playoffWeekStart: core.league.playoffWeekStart,
    lastRegularWeek: core.lastRegularWeek,
    sims: SEASON_SIMS,
    teams: sim.teams.map(o => ({
      ...teamView(core, o.rosterId), ...o,
      playoffPct: pct(o.playoffPct), byePct: pct(o.byePct), firstSeedPct: pct(o.firstSeedPct), finalPct: pct(o.finalPct), champPct: pct(o.champPct), lastPct: pct(o.lastPct),
      meanWins: r2(o.meanWins), meanLosses: r2(o.meanLosses), meanPointsFor: r1(o.meanPointsFor),
      seedDist: o.seedDist.map(pct), winsDist: o.winsDist.map(pct),
      ifWinPlayoffPct: o.ifWinPlayoffPct === null ? null : pct(o.ifWinPlayoffPct), ifLosePlayoffPct: o.ifLosePlayoffPct === null ? null : pct(o.ifLosePlayoffPct),
      power: r1(pw.find(p => p.rosterId === o.rosterId)!.score),
    })).sort((a, b) => b.playoffPct - a.playoffPct || b.champPct - a.champPct),
    games: [...sim.gameWinProb].map(([key, p]) => {
      const [week, a, b] = key.split(':').map(Number);
      return { week, a, b, winProbA: pct(p), projA: r1(teamDist(core, a, week).mean), projB: r1(teamDist(core, b, week).mean) };
    }).sort((x, y) => x.week - y.week),
  };
}

export async function powerView(id: string) {
  const core = await getCore(id);
  return once(core, 'powerView', () => powerPage(core));
}

function powerPage(core: LeagueCore) {
  const pw = power(core);
  // Performance-only power after each completed week, for the trend chart.
  const history: { week: number; ranks: { rosterId: number; score: number; rank: number }[] }[] = [];
  for (let w = 1; w <= core.results.length; w++) {
    const partial = summarizeSeason(core.results.slice(0, w), core.teams.map(t => t.rosterId));
    const rows = powerRankings(core.teams.map(t => {
      const s = partial.get(t.rosterId)!;
      return { rosterId: t.rosterId, weekly: s.weekly, allPlayWins: s.allPlayWins, allPlayGames: s.allPlayWins + s.allPlayLosses, outlook: s.weekly.reduce((a, b) => a + b, 0) / Math.max(1, s.weekly.length) };
    }), 99);
    history.push({ week: w, ranks: rows.map(r => ({ rosterId: r.rosterId, score: r1(r.score), rank: r.rank })) });
  }
  const upcoming = core.horizon.filter(w => w <= core.lastRegularWeek).slice(0, 6);
  // Season power: points already scored plus every remaining regular-season week, projected the way
  // the playoff simulation projects it (best lineup scaled by how the manager sets lineups).
  const remaining = core.horizon.filter(w => w <= core.lastRegularWeek);
  const seasonRows = core.teams.map(t => {
    const scored = core.summaries.get(t.rosterId)!.pointsFor;
    const projected = remaining.reduce((a, w) => a + teamDist(core, t.rosterId, w).mean, 0);
    return { rosterId: t.rosterId, scored, projected, total: scored + projected };
  });
  const scoredRank = new Map([...seasonRows].sort((a, b) => b.scored - a.scored).map((r, i) => [r.rosterId, i + 1]));
  const seasonWeeks = core.results.length + remaining.length;
  return {
    week: core.week,
    season: {
      playedWeeks: core.results.length,
      remainingWeeks: remaining.length,
      firstRemaining: remaining[0] ?? null,
      lastRegularWeek: core.lastRegularWeek,
      rankings: seasonRows.sort((a, b) => b.total - a.total).map((r, i) => ({
        rosterId: r.rosterId, rank: i + 1, scoredRank: scoredRank.get(r.rosterId)!,
        scored: r1(r.scored), projected: r1(r.projected), total: r1(r.total), ppg: r1(seasonWeeks ? r.total / seasonWeeks : 0),
      })),
    },
    rankings: pw.map(p => {
      const t = core.teams.find(x => x.rosterId === p.rosterId)!;
      const s = core.summaries.get(p.rosterId)!;
      const starters = core.week !== null ? (core.bestByWeek.get(`${p.rosterId}:${core.week}`)?.ids ?? []).filter((x): x is string => !!x) : [];
      const top = [...starters].sort((a, b) => (core.values.get(b)?.value ?? 0) - (core.values.get(a)?.value ?? 0)).slice(0, 3);
      return {
        ...teamView(core, p.rosterId), score: r1(p.score), rank: p.rank,
        components: { season: r1(p.components.season), allPlay: r1(p.components.allPlay), recent: r1(p.components.recent), outlook: r1(p.components.outlook) },
        weights: { season: r2(p.weights.season), allPlay: r2(p.weights.allPlay), recent: r2(p.weights.recent), outlook: r2(p.weights.outlook) },
        ppg: r1(s.weekly.length ? s.pointsFor / s.weekly.length : 0),
        outlookPpg: r1(upcoming.length ? upcoming.reduce((a, w) => a + (core.bestByWeek.get(`${p.rosterId}:${w}`)?.expected ?? 0), 0) / upcoming.length : 0),
        rosterValue: r1(t.roster.players.reduce((a, pid) => a + (core.values.get(pid)?.value ?? 0), 0)),
        dynastyValue: r1(t.roster.players.reduce((a, pid) => a + (core.values.get(pid)?.dynasty ?? 0), 0)),
        keyPlayers: top.map(pid => ({ id: pid, name: core.players[pid].name, pos: core.players[pid].pos })),
      };
    }),
    history,
  };
}

export async function players(id: string) {
  const core = await getCore(id);
  return once(core, 'players', () => ({
    week: core.week,
    players: core.relevant.map(pid => playerRow(core, pid))
      .filter(r => r.owner !== null || (r.value?.rosAvg ?? 0) > 0.5 || (r.season?.gp ?? 0) > 0)
      .sort((a, b) => (b.value?.value ?? 0) - (a.value?.value ?? 0)),
  }));
}

export async function player(id: string, playerId: string) {
  const core = await getCore(id);
  const p = core.players[playerId];
  if (!p) throw new HttpError(404, 'Player not found');
  return once(core, `player:${playerId}`, () => playerPage(core, playerId, p));
}

function playerPage(core: LeagueCore, playerId: string, p: LeagueCore['players'][string]) {
  const scoring = compileScoring(core.league.scoring);
  const log = (byWeek: Map<number, Map<string, { stats: Stats; opponent: string | null; team: string | null }>>, season: number) =>
    [...byWeek].sort((a, b) => a[0] - b[0]).flatMap(([week, lines]) => {
      const line = lines.get(playerId);
      if (!line || !didPlay(line.stats)) return [];
      const st = line.stats;
      const idp = ['DL', 'LB', 'DB'].includes(p.pos);
      const snaps = idp ? st.def_snp : st.off_snp, teamSnaps = idp ? st.tm_def_snp : st.tm_off_snp;
      const full = completeStats(st, p.pos);
      const cats = categoryPoints(full, scoring);
      return [{
        season, week, opp: line.opponent, pts: r2(scoreStats(full, scoring)), snapShare: snaps && teamSnaps ? pct(snaps / teamSnaps) : null,
        categories: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, r2(v ?? 0)])),
        stats: Object.fromEntries(scoreBreakdown(full, scoring).map(b => [b.key, b.stat])),
      }];
    });
  const current = core.week !== null ? core.forecasts.get(core.week)?.get(playerId) : undefined;
  const projLine = core.week !== null ? core.projectionsByWeek.get(core.week)?.get(playerId) : undefined;
  const projStats = projLine && hasForecast(projLine.stats) ? completeStats(projLine.stats, p.pos, true) : null;
  const upcoming = core.horizon.map(w => forecastView(core.forecasts.get(w)?.get(playerId))).filter(Boolean);
  const quantiles = current ? Array.from({ length: 21 }, (_, i) => r1(current.mean + current.residuals[i])) : null;
  return {
    player: playerRow(core, playerId),
    details: { college: p.college, birthDate: p.birthDate, depthOrder: p.depthOrder, injuryNotes: p.injuryNotes, status: p.status },
    gameLog: [...log(core.statsByWeek as never, core.season), ...log(core.prevStatsByWeek as never, core.season - 1)].sort((a, b) => b.season - a.season || b.week - a.week),
    projection: projStats ? { breakdown: scoreBreakdown(projStats, scoring).map(b => ({ ...b, stat: r2(b.stat), points: r2(b.points) })), total: r2(scoreStats(projStats, scoring)) } : null,
    inputs: core.week !== null ? explainInputs(core.env, playerId, core.week) : {},
    /** ESPN's weekly outlook, in ESPN leagues. */
    outlook: core.outlooks.get(playerId) ?? null,
    quantiles,
    upcoming,
    labels: STAT_LABELS,
  };
}

export async function trade(id: string, body: { a: number; b: number; aGives: string[]; bGives: string[] }) {
  const core = await getCore(id);
  const ta = core.teams.find(t => t.rosterId === body.a), tb = core.teams.find(t => t.rosterId === body.b);
  if (!ta || !tb || ta === tb) throw new HttpError(400, 'Pick two different teams');
  const valid = (ids: unknown, owner: typeof ta) => Array.isArray(ids) && ids.every(x => typeof x === 'string' && owner.roster.players.includes(x));
  if (!valid(body.aGives, ta) || !valid(body.bGives, tb)) throw new HttpError(400, 'Every traded player must be on the giving roster');
  if (!body.aGives.length && !body.bGives.length) throw new HttpError(400, 'Add at least one player');
  const weeks = core.horizon.length ? core.horizon : [];
  const value = (pid: string) => ({ value: core.values.get(pid)?.value ?? 0, dynasty: core.values.get(pid)?.dynasty ?? 0 });
  const active = (t: typeof ta) => t.roster.players.filter(pid => !core.taxiOrIr.has(pid));
  const sideA = analyzeTradeSide({ rosterId: ta.rosterId, roster: active(ta), gives: body.aGives, gets: body.bGives, slots: core.slots, players: core.players, forecasts: core.forecasts, weeks, value });
  const sideB = analyzeTradeSide({ rosterId: tb.rosterId, roster: active(tb), gives: body.bGives, gets: body.aGives, slots: core.slots, players: core.players, forecasts: core.forecasts, weeks, value });

  // Playoff odds before/after: rerun the season with both teams' post-trade weekly lineups.
  const before = seasonSim(core);
  const after = (() => {
    const shape = playoffShape(core.league);
    const override = new Map<string, TeamWeekDist>();
    for (const [side, t] of [[sideA, ta], [sideB, tb]] as const) {
      const ids = [...active(t).filter(pid => !side.gives.includes(pid)), ...side.gets];
      for (const w of weeks) {
        const l = bestLineup(core.slots, ids, core.players, core.forecasts.get(w)!);
        override.set(`${t.rosterId}:${w}`, lineupDist(l, managerFactor(core, t.rosterId)));
      }
    }
    const remaining: { week: number; a: number; b: number }[] = [];
    for (const w of weeks.filter(x => x <= core.lastRegularWeek)) {
      const byMatch = new Map<number, number[]>();
      for (const m of core.schedule.get(w) ?? []) if (m.matchupId !== null) byMatch.set(m.matchupId, [...(byMatch.get(m.matchupId) ?? []), m.rosterId]);
      for (const pair of byMatch.values()) if (pair.length === 2) remaining.push({ week: w, a: pair[0], b: pair[1] });
    }
    return simulateSeason({
      teams: core.teams.map(t => t.rosterId),
      record: new Map(core.teams.map(t => [t.rosterId, { wins: t.roster.wins, losses: t.roster.losses, ties: t.roster.ties, pointsFor: t.roster.pointsFor }])),
      remaining,
      dist: (rid, w) => override.get(`${rid}:${w}`) ?? teamDist(core, rid, w),
      playoffTeams: core.league.playoffTeams, playoffStart: core.league.playoffWeekStart, roundWeeks: shape.roundWeeks, finalWeeks: shape.finalWeeks,
      leverageWeek: core.week ?? 0, seed: `${core.id}:${core.week}`, sims: SEASON_SIMS,
    });
  })();
  const odds = (sim: typeof before, rid: number) => {
    const o = sim.teams.find(x => x.rosterId === rid)!;
    return { playoffPct: pct(o.playoffPct), champPct: pct(o.champPct) };
  };
  const view = (s: typeof sideA) => ({
    rosterId: s.rosterId,
    gives: s.gives.map(pid => playerRow(core, pid)), gets: s.gets.map(pid => playerRow(core, pid)),
    rosBefore: r1(s.before.total), rosAfter: r1(s.after.total), rosDelta: r1(s.rosDelta), perWeekDelta: r2(s.perWeekDelta),
    byWeek: s.before.byWeek.map((b, i) => ({ week: b.week, before: r1(b.points), after: r1(s.after.byWeek[i].points) })),
    valueOut: r1(s.valueOut), valueIn: r1(s.valueIn), dynastyOut: r1(s.dynastyOut), dynastyIn: r1(s.dynastyIn),
    newStarters: s.newStarters.map(pid => core.players[pid]?.name ?? pid), lostStarters: s.lostStarters.map(pid => core.players[pid]?.name ?? pid),
    oddsBefore: odds(before, s.rosterId), oddsAfter: odds(after, s.rosterId),
    rosterSizeAfter: active(s.rosterId === ta.rosterId ? ta : tb).length - s.gives.length + s.gets.length,
  });
  const A = view(sideA), B = view(sideB);
  const edge = (x: typeof A) => x.rosDelta / Math.max(1, weeks.length) + 0.08 * (x.dynastyIn - x.dynastyOut);
  const ea = edge(A), eb = edge(B);
  const verdict = Math.abs(ea - eb) < 1.2 ? 'fair' : ea > eb ? 'a' : 'b';
  return { weeks, a: A, b: B, verdict, note: 'Now = expected points from each team’s best legal lineup, every remaining week. Dynasty = four-season value on the age curve.' };
}

export async function recap(id: string) {
  const core = await getCore(id);
  return once(core, 'recap', () => recapView(core));
}

function recapView(core: LeagueCore) {
  const awards = seasonAwards(core.results, core.summaries, core.players, pickups(core));
  const weekly = core.results.map(rows => ({
    week: rows[0]?.week ?? 0,
    scores: rows.map(r => ({ rosterId: r.rosterId, points: r2(r.points), optimal: r2(r.optimal), result: r.result, opponent: r.opponentId })),
    high: rows.reduce((a, b) => (b.points > a.points ? b : a), rows[0])?.rosterId ?? null,
  }));
  // MVPs: each team's top starter by season points.
  const mvps = core.teams.map(t => {
    const tally = new Map<string, number>();
    for (const rows of core.results) {
      const r = rows.find(x => x.rosterId === t.rosterId);
      if (!r) continue;
      for (const pid of r.starters) tally.set(pid, (tally.get(pid) ?? 0) + (r.playersPoints[pid] ?? 0));
    }
    const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { rosterId: t.rosterId, players: top.map(([pid, pts]) => ({ id: pid, name: core.players[pid]?.name ?? pid, pos: core.players[pid]?.pos ?? '', points: r1(pts) })) };
  });
  const recaps = core.results.map(rows => weekRecap(core, rows)).reverse();
  return { awards, weekly, mvps, recaps, summaries: [...core.summaries.values()].map(s => ({ ...s, weekly: s.weekly.map(r1), pointsFor: r2(s.pointsFor), pointsAgainst: r2(s.pointsAgainst), efficiency: pct(s.efficiency), benchPoints: r1(s.benchPoints), expectedWins: r2(s.expectedWins), luck: r2(s.luck) })) };
}

// ─── League history (previous seasons via previous_league_id) ───────────────

export async function history(id: string) {
  const core = await getCore(id);
  return memo(`history:${id}:${core.lastScored}`, HOUR, async () => {
    const seasons: {
      season: number; leagueId: string; name: string; complete: boolean;
      teams: { ownerId: string | null; rosterId: number; name: string; owner: string; wins: number; losses: number; ties: number; pointsFor: number; pointsAgainst: number; finish: number | null }[];
      champion: string | null; runnerUp: string | null; games: { week: number; a: string | null; b: string | null; aPts: number; bPts: number; playoff: boolean; span: number }[];
      highs: { owner: string | null; points: number; week: number }[];
    }[] = [];
    let leagueId: string | null = id;
    const state = await sleeper.state();
    while (leagueId && seasons.length < 12) {
      const src = sourceFor(leagueId);
      const lg = await src.league().catch(() => null);
      if (!lg) break;
      const complete = lg.season < state.season || lg.status === 'complete';
      const [users, rosters] = await Promise.all([src.users(), src.rosters()]);
      const lastWeek = complete ? Math.min(18, lg.playoffWeekStart + 3) : Math.max(0, lg.lastScoredWeek);
      const weeks = await Promise.all(Array.from({ length: lastWeek }, (_, i) => src.matchups(i + 1, complete).catch(() => [])));
      const finish = complete ? await src.finalPlaces(true).catch(() => new Map<number, number>()) : new Map<number, number>();
      const ownerOfRoster = new Map(rosters.map(r => [r.rosterId, r.ownerId]));
      const nameOf = (rid: number) => {
        const u = users.find(x => x.userId === ownerOfRoster.get(rid));
        return { name: u?.teamName ?? u?.displayName ?? `Team ${rid}`, owner: u?.displayName ?? 'Open team' };
      };
      const games: (typeof seasons)[number]['games'] = [];
      const highs: (typeof seasons)[number]['highs'] = [];
      weeks.forEach((ms, i) => {
        const w = i + 1;
        for (const [a, b] of matchupPairs(ms)) {
          if (!b) continue;
          const aPts = a.customPoints ?? a.points, bPts = b.customPoints ?? b.points;
          if (!aPts && !bPts) continue;
          const playoff = w >= lg.playoffWeekStart;
          // Two-week playoff rounds report a two-week total; records compare single weeks only.
          games.push({ week: w, a: ownerOfRoster.get(a.rosterId) ?? null, b: ownerOfRoster.get(b.rosterId) ?? null, aPts: r2(aPts), bPts: r2(bPts), playoff, span: playoff && lg.playoffRoundType === 2 ? 2 : 1 });
        }
        for (const m of ms) if (w < lg.playoffWeekStart && (m.customPoints ?? m.points) > 0) highs.push({ owner: ownerOfRoster.get(m.rosterId) ?? null, points: r2(m.customPoints ?? m.points), week: w });
      });
      const champ = [...finish].find(([, place]) => place === 1)?.[0];
      const runner = [...finish].find(([, place]) => place === 2)?.[0];
      seasons.push({
        season: lg.season, leagueId: lg.id, name: lg.name, complete,
        teams: rosters.map(r => ({ ownerId: r.ownerId, rosterId: r.rosterId, ...nameOf(r.rosterId), wins: r.wins, losses: r.losses, ties: r.ties, pointsFor: r2(r.pointsFor), pointsAgainst: r2(r.pointsAgainst), finish: finish.get(r.rosterId) ?? null }))
          .sort((x, y) => (x.finish ?? 99) - (y.finish ?? 99) || y.wins - x.wins || y.pointsFor - x.pointsFor),
        champion: champ !== undefined ? ownerOfRoster.get(champ) ?? null : null,
        runnerUp: runner !== undefined ? ownerOfRoster.get(runner) ?? null : null,
        games,
        highs: highs.sort((a, b) => b.points - a.points).slice(0, 5),
      });
      leagueId = lg.previousId;
    }
    // All-time by owner.
    const owners = new Map<string, { ownerId: string; name: string; seasons: number; wins: number; losses: number; ties: number; pointsFor: number; titles: number; finals: number; playoffWins: number }>();
    const currentUsers = core.users;
    for (const s of seasons) for (const t of s.teams) {
      if (!t.ownerId) continue;
      const o = owners.get(t.ownerId) ?? { ownerId: t.ownerId, name: currentUsers.find(u => u.userId === t.ownerId)?.teamName ?? t.name, seasons: 0, wins: 0, losses: 0, ties: 0, pointsFor: 0, titles: 0, finals: 0, playoffWins: 0 };
      o.seasons++; o.wins += t.wins; o.losses += t.losses; o.ties += t.ties; o.pointsFor += t.pointsFor;
      if (s.champion === t.ownerId) o.titles++;
      if (s.champion === t.ownerId || s.runnerUp === t.ownerId) o.finals++;
      owners.set(t.ownerId, o);
    }
    const h2h: Record<string, Record<string, { w: number; l: number; t: number }>> = {};
    for (const s of seasons) for (const g of s.games) {
      if (!g.a || !g.b || g.playoff) continue;
      const rec = (x: string, y: string) => ((h2h[x] ??= {})[y] ??= { w: 0, l: 0, t: 0 });
      if (g.aPts > g.bPts) { rec(g.a, g.b).w++; rec(g.b, g.a).l++; } else if (g.aPts < g.bPts) { rec(g.a, g.b).l++; rec(g.b, g.a).w++; } else { rec(g.a, g.b).t++; rec(g.b, g.a).t++; }
    }
    const allGames = seasons.flatMap(s => s.games.filter(g => g.span === 1).map(g => ({ ...g, season: s.season })));
    const records = {
      highScore: allGames.flatMap(g => [{ owner: g.a, points: g.aPts, season: g.season, week: g.week }, { owner: g.b, points: g.bPts, season: g.season, week: g.week }]).sort((a, b) => b.points - a.points).slice(0, 5),
      lowScore: allGames.flatMap(g => [{ owner: g.a, points: g.aPts, season: g.season, week: g.week }, { owner: g.b, points: g.bPts, season: g.season, week: g.week }]).filter(x => x.points > 0).sort((a, b) => a.points - b.points).slice(0, 5),
      blowouts: allGames.map(g => ({ winner: g.aPts >= g.bPts ? g.a : g.b, loser: g.aPts >= g.bPts ? g.b : g.a, margin: r2(Math.abs(g.aPts - g.bPts)), season: g.season, week: g.week, score: `${Math.max(g.aPts, g.bPts).toFixed(1)}–${Math.min(g.aPts, g.bPts).toFixed(1)}` })).sort((a, b) => b.margin - a.margin).slice(0, 5),
      closest: allGames.filter(g => g.aPts !== g.bPts).map(g => ({ winner: g.aPts > g.bPts ? g.a : g.b, loser: g.aPts > g.bPts ? g.b : g.a, margin: r2(Math.abs(g.aPts - g.bPts)), season: g.season, week: g.week, score: `${Math.max(g.aPts, g.bPts).toFixed(1)}–${Math.min(g.aPts, g.bPts).toFixed(1)}` })).sort((a, b) => a.margin - b.margin).slice(0, 5),
    };
    const ownerNames = Object.fromEntries(core.users.map(u => [u.userId, { name: u.teamName ?? u.displayName, owner: u.displayName }]));
    return {
      seasons: seasons.map(s => ({ ...s, games: undefined, gameCount: s.games.length })),
      allTime: [...owners.values()].map(o => ({ ...o, pointsFor: r1(o.pointsFor), winPct: pct((o.wins + o.ties / 2) / Math.max(1, o.wins + o.losses + o.ties)) })).sort((a, b) => b.titles - a.titles || b.winPct - a.winPct),
      h2h, records, ownerNames,
    };
  });
}

// ─── Model report & prospective tracking ─────────────────────────────────────

const reports = new Map<string, Record<string, unknown>>();
export function modelMeta(leagueId = 'default'): { key: string; meta: { version: string; trainedAt: string; trainingRows: number } | null } {
  const report = model(leagueId) as { meta?: { version: string; trainedAt: string; trainingRows: number } };
  return { key: modelFor(leagueId).key, meta: report.meta ? { version: report.meta.version, trainedAt: report.meta.trainedAt, trainingRows: report.meta.trainingRows } : null };
}
/** The evaluation report of the model serving a league (each league is scored and trained separately). */
export function model(leagueId = 'default') {
  const { key, reportFile } = modelFor(leagueId);
  let data = reports.get(key);
  if (!data) {
    try { data = JSON.parse(readFileSync(reportFile, 'utf8')) as Record<string, unknown>; } catch { data = {}; }
    data = { ...data, key };
    reports.set(key, data);
  }
  return data as Record<string, unknown> & { key: string };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ─── Defense: points allowed by opponent, per position (SLA matchup research) ─

export async function defense(id: string, requestedSeason?: number): Promise<DefenseView> {
  const core = await getCore(id);
  const seasons = [core.season, core.season - 1];
  // The current season as soon as a week of it is in; last season only before week 1 is scored.
  const defaultSeason = core.lastScored >= 1 ? core.season : core.season - 1;
  const season = requestedSeason && seasons.includes(requestedSeason) ? requestedSeason : defaultSeason;
  const compute = (): DefenseView => {
    const source = season === core.season ? core.statsByWeek : core.prevStatsByWeek;
    const lastWeek = season === core.season ? core.lastScored : 18;
    const weeks = [...source].filter(([w]) => w <= lastWeek).sort((a, b) => a[0] - b[0]).map(([week, lines]) => ({ week, lines: lines.values() }));
    const index = buildDefenseIndex(weeks, core.players, compileScoring(core.league.scoring));
    // Who each team plays in the current week, so the table doubles as a matchup finder.
    const upcoming: Record<string, string> = {};
    if (core.week !== null) for (const g of core.games.filter(x => x.week === core.week)) { upcoming[g.home] = g.away; upcoming[g.away] = g.home; }
    return {
      season, seasons, week: core.week, throughWeek: weeks.at(-1)?.week ?? 0, weeks: weeks.map(w => w.week), upcoming,
      groups: Object.fromEntries([...index].map(([g, rows]) => [g, rows.map(r => ({
        ...r, pointsPerGame: r1(r.pointsPerGame), adjustedPerGame: r1(r.adjustedPerGame), last4: r1(r.last4), ceilingRate: pct(r.ceilingRate),
        floorRate: pct(r.floorRate), top10Rate: pct(r.top10Rate), opportunitiesPerGame: r1(r.opportunitiesPerGame), efficiency: r2(r.efficiency), volatility: r1(r.volatility),
      }))])) as Record<string, DefenseRow[]>,
    };
  };
  if (season === core.season) return once(core, `defense:${season}`, compute);
  return once(core, `defense:${season}`, () => {
    const key = `${id}:${season}`;
    let cachedPrev = pastDefense.get(key);
    if (!cachedPrev) { cachedPrev = compute(); pastDefense.set(key, cachedPrev); }
    // The "this week" opponents still come from the live schedule.
    const upcoming: Record<string, string> = {};
    if (core.week !== null) for (const g of core.games.filter(x => x.week === core.week)) { upcoming[g.home] = g.away; upcoming[g.away] = g.home; }
    return { ...cachedPrev, week: core.week, upcoming };
  });
}
interface DefenseView { season: number; seasons: number[]; week: number | null; throughWeek: number; weeks: number[]; upcoming: Record<string, string>; groups: Record<string, DefenseRow[]> }
/** Past seasons never change, so their tables are shared across core rebuilds. */
const pastDefense = new Map<string, DefenseView>();

/**
 * After each rebuild, precompute the heaviest shared views one at a time (yielding between
 * them) so the first visitor doesn't pay for them on a slow CPU.
 */
onCoreBuilt(core => {
  const id = core.id;
  void (async () => {
    // First paint needs bootstrap + overview (+ this week's matchups): encode and compress those too.
    const views: [() => Promise<object>, boolean][] = [
      [() => bootstrap(id), true], [() => overview(id), true], [() => matchups(id), true],
      [() => players(id), false], [() => powerView(id), false], [() => playoffs(id), false], [() => defense(id), false], [() => history(id), false],
    ];
    for (const [view, encode] of views) {
      try {
        const data = await view();
        if (encode) prepare(data);
      } catch { /* best effort */ }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  })();
});

// ─── Configured leagues (league switcher) ────────────────────────────────────

/** Every league this deployment is set up for, with display names. Credentials never leave the server. */
export async function configuredLeagues(defaultLeague: string) {
  const ids = [...new Set([defaultLeague, ...(process.env.SLA_LEAGUES ?? '').split(',').map(x => x.trim()).filter(Boolean)])];
  const entries = [...ids.map(id => ({ id, name: '', platform: 'sleeper' as const })), ...configuredEspnLeagues()];
  const out = await Promise.all(entries.map(async e => {
    try {
      const lg = await sourceFor(e.id).league();
      return { id: e.id, name: lg.name || e.name, platform: e.platform, season: lg.season, teams: lg.totalRosters, dynasty: lg.isDynasty };
    } catch {
      return e.name ? { id: e.id, name: e.name, platform: e.platform, season: null, teams: null, dynasty: false } : null;
    }
  }));
  return out.filter(x => x !== null);
}
