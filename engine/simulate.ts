/**
 * Monte Carlo for head-to-head matchups (player-level) and the rest of the season
 * (team-level normal approximation), including a no-reseed playoff bracket.
 */
import { hashSeed, mulberry32, normal, sample, type Outcome } from './distribution.ts';

/** P(lineup A beats lineup B) by sampling every starter's outcome distribution. */
export function simulateMatchup(a: readonly Outcome[], b: readonly Outcome[], seedKey: string, n = 10000) {
  const rand = mulberry32(hashSeed(seedKey));
  let winsA = 0;
  const totalsA = new Float64Array(n), totalsB = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sa = 0, sb = 0;
    for (const o of a) sa += sample(o, rand);
    for (const o of b) sb += sample(o, rand);
    totalsA[i] = sa;
    totalsB[i] = sb;
    if (sa > sb) winsA++;
    else if (sa === sb) winsA += 0.5;
  }
  const q = (arr: Float64Array, p: number) => {
    const sorted = Float64Array.from(arr).sort();
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  };
  const histogram = (arr: Float64Array, lo: number, hi: number, bins = 28) => {
    const out = new Array(bins).fill(0);
    const width = (hi - lo) / bins;
    for (const v of arr) out[Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / width)))]++;
    return out.map(c => c / arr.length);
  };
  let lo = Math.min(q(totalsA, 0.005), q(totalsB, 0.005));
  let hi = Math.max(q(totalsA, 0.995), q(totalsB, 0.995));
  if (!(hi - lo > 1e-6)) { lo -= 1; hi += 1; }
  return {
    winProbA: winsA / n,
    a: { p10: q(totalsA, 0.1), p50: q(totalsA, 0.5), p90: q(totalsA, 0.9) },
    b: { p10: q(totalsB, 0.1), p50: q(totalsB, 0.5), p90: q(totalsB, 0.9) },
    histogram: { lo, hi, a: histogram(totalsA, lo, hi), b: histogram(totalsB, lo, hi) },
  };
}

export interface TeamWeekDist { mean: number; sd: number }
export interface ScheduledGame { week: number; a: number; b: number }

export interface SeasonSimInput {
  teams: number[];
  /** Completed results so far. */
  record: Map<number, { wins: number; losses: number; ties: number; pointsFor: number }>;
  /** Regular-season games not yet final (current week onward). */
  remaining: ScheduledGame[];
  dist: (rosterId: number, week: number) => TeamWeekDist;
  playoffTeams: number;
  playoffStart: number;
  /** Weeks per playoff round (Sleeper playoff_round_type 2 → 2). Final uses finalWeeks. */
  roundWeeks: number;
  finalWeeks: number;
  sims?: number;
  seed?: string;
  /** Week whose result leverage is reported (usually the current week). */
  leverageWeek: number;
}

export interface TeamSeasonOutlook {
  rosterId: number;
  playoffPct: number;
  byePct: number;
  firstSeedPct: number;
  finalPct: number;
  champPct: number;
  lastPct: number;
  meanWins: number;
  meanLosses: number;
  meanPointsFor: number;
  seedDist: number[];
  winsDist: number[];
  ifWinPlayoffPct: number | null;
  ifLosePlayoffPct: number | null;
}

export function simulateSeason(input: SeasonSimInput): { teams: TeamSeasonOutlook[]; gameWinProb: Map<string, number> } {
  const sims = input.sims ?? 10000;
  const rand = mulberry32(hashSeed(input.seed ?? 'season'));
  const T = input.teams.length;
  const idx = new Map(input.teams.map((id, i) => [id, i]));
  const byeCount = input.playoffTeams > 1 ? 2 ** Math.ceil(Math.log2(input.playoffTeams)) - input.playoffTeams : 0;
  const counters = input.teams.map(() => ({
    playoff: 0, bye: 0, first: 0, final: 0, champ: 0, last: 0, wins: 0, losses: 0, pf: 0,
    seed: new Array(T).fill(0), winsHist: new Array(20).fill(0), ifWin: [0, 0], ifLose: [0, 0],
  }));
  const gameWins = new Map<string, number>();
  const distCache = new Map<string, TeamWeekDist>();
  const dist = (id: number, week: number) => {
    const key = `${id}:${week}`;
    let d = distCache.get(key);
    if (!d) { d = input.dist(id, week); distCache.set(key, d); }
    return d;
  };
  const draw = (id: number, week: number) => {
    const d = dist(id, week);
    return d.mean + d.sd * normal(rand);
  };

  const wins = new Float64Array(T), losses = new Float64Array(T), pf = new Float64Array(T);
  const leverageResult = new Int8Array(T); // 1 win, -1 loss, 0 no game
  for (let s = 0; s < sims; s++) {
    for (const id of input.teams) {
      const r = input.record.get(id);
      const i = idx.get(id)!;
      wins[i] = (r?.wins ?? 0) + (r?.ties ?? 0) * 0.5;
      losses[i] = (r?.losses ?? 0) + (r?.ties ?? 0) * 0.5;
      pf[i] = r?.pointsFor ?? 0;
      leverageResult[i] = 0;
    }
    for (const g of input.remaining) {
      const ia = idx.get(g.a), ib = idx.get(g.b);
      if (ia === undefined || ib === undefined) continue;
      const sa = draw(g.a, g.week), sb = draw(g.b, g.week);
      pf[ia] += sa;
      pf[ib] += sb;
      const key = `${g.week}:${g.a}:${g.b}`;
      if (sa === sb) {
        wins[ia] += 0.5; wins[ib] += 0.5; losses[ia] += 0.5; losses[ib] += 0.5;
        gameWins.set(key, (gameWins.get(key) ?? 0) + 0.5);
        continue;
      }
      const aWins = sa > sb;
      if (aWins) { wins[ia]++; losses[ib]++; } else { wins[ib]++; losses[ia]++; }
      gameWins.set(key, (gameWins.get(key) ?? 0) + (aWins ? 1 : 0));
      if (g.week === input.leverageWeek) {
        leverageResult[ia] = aWins ? 1 : -1;
        leverageResult[ib] = aWins ? -1 : 1;
      }
    }
    // Standings: wins, then points for (Sleeper's default tiebreaker).
    const order = input.teams.map((_, i) => i).sort((x, y) => wins[y] - wins[x] || pf[y] - pf[x]);
    order.forEach((i, rank) => {
      const c = counters[i];
      c.seed[rank]++;
      c.wins += wins[i];
      c.losses += losses[i];
      c.pf += pf[i];
      c.winsHist[Math.min(19, Math.round(wins[i]))]++;
      const inPlayoffs = rank < input.playoffTeams;
      if (inPlayoffs) c.playoff++;
      if (rank === 0) c.first++;
      if (rank < byeCount) c.bye++;
      if (rank === T - 1) c.last++;
      if (leverageResult[i] === 1) { c.ifWin[0]++; if (inPlayoffs) c.ifWin[1]++; }
      if (leverageResult[i] === -1) { c.ifLose[0]++; if (inPlayoffs) c.ifLose[1]++; }
    });
    const seeds = order.slice(0, input.playoffTeams).map(i => input.teams[i]);
    const { finalists, champion } = playBracket(seeds, input, draw);
    for (const id of finalists) counters[idx.get(id)!].final++;
    if (champion !== null) counters[idx.get(champion)!].champ++;
  }
  const gameWinProb = new Map<string, number>();
  for (const [k, v] of gameWins) gameWinProb.set(k, v / sims);
  return {
    teams: input.teams.map((id, i) => {
      const c = counters[i];
      return {
        rosterId: id,
        playoffPct: c.playoff / sims,
        byePct: c.bye / sims,
        firstSeedPct: c.first / sims,
        finalPct: c.final / sims,
        champPct: c.champ / sims,
        lastPct: c.last / sims,
        meanWins: c.wins / sims,
        meanLosses: c.losses / sims,
        meanPointsFor: c.pf / sims,
        seedDist: c.seed.map(v => v / sims),
        winsDist: c.winsHist.map(v => v / sims),
        ifWinPlayoffPct: c.ifWin[0] ? c.ifWin[1] / c.ifWin[0] : null,
        ifLosePlayoffPct: c.ifLose[0] ? c.ifLose[1] / c.ifLose[0] : null,
      };
    }),
    gameWinProb,
  };
}

/** Standard bracket order for a power-of-two field: 1v8, 4v5, 2v7, 3v6, … */
function bracketOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap(seed => [seed, n + 1 - seed]);
  }
  return order;
}

/**
 * Fixed (no-reseed) single elimination, as Sleeper runs it. Seeds beyond the field are byes, so
 * 6 teams play 3v6 and 4v5 while 1 and 2 wait, and 3 teams give only the top seed a bye.
 */
function playBracket(seeds: number[], input: SeasonSimInput, draw: (id: number, week: number) => number): { finalists: number[]; champion: number | null } {
  if (seeds.length < 2) return { finalists: seeds, champion: seeds[0] ?? null };
  const size = 2 ** Math.ceil(Math.log2(seeds.length));
  let field: (number | null)[] = bracketOrder(size).map(seed => seeds[seed - 1] ?? null);
  let week = input.playoffStart;
  while (field.length > 2) {
    const next: (number | null)[] = [];
    let played = false;
    for (let i = 0; i < field.length; i += 2) {
      const a = field[i], b = field[i + 1];
      if (a === null || b === null) { next.push(a ?? b); continue; }
      played = true;
      let sa = 0, sb = 0;
      for (let w = 0; w < input.roundWeeks; w++) { sa += draw(a, week + w); sb += draw(b, week + w); }
      next.push(sa >= sb ? a : b);
    }
    if (played) week += input.roundWeeks;
    field = next;
  }
  const [a, b] = field;
  if (a === null || b === null) return { finalists: [a, b].filter((x): x is number => x !== null), champion: a ?? b };
  let sa = 0, sb = 0;
  for (let w = 0; w < input.finalWeeks; w++) { sa += draw(a, week + w); sb += draw(b, week + w); }
  return { finalists: [a, b], champion: sa >= sb ? a : b };
}
