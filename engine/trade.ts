import type { WeekForecast } from './forecast.ts';
import { optimizeLineup, type LineupCandidate } from './optimizer.ts';
import { round } from './scoring.ts';
import { simulateSeason, type ScheduledGame, type TeamWeekDist } from './simulate.ts';
import type { PlayerInfo, Pos } from './types.ts';

export interface LineupProjection { total: number; byWeek: { week: number; points: number }[]; nextStarters: string[] }

/** Expected points from the best legal lineup each week over the horizon. */
export function projectRoster(
  ids: readonly string[],
  slots: readonly string[],
  players: Record<string, PlayerInfo>,
  forecasts: ReadonlyMap<number, ReadonlyMap<string, WeekForecast>>,
  weeks: readonly number[],
): LineupProjection {
  const byWeek: { week: number; points: number }[] = [];
  let nextStarters: string[] = [];
  for (const w of weeks) {
    const f = forecasts.get(w);
    const pool: LineupCandidate[] = [];
    for (const id of ids) {
      const p = players[id], fc = f?.get(id);
      if (p && fc) pool.push({ id, eligible: p.eligible, value: fc.expected });
    }
    const r = optimizeLineup(slots, pool);
    if (!byWeek.length) nextStarters = r.ids.filter((x): x is string => !!x);
    byWeek.push({ week: w, points: r.total });
  }
  return { total: byWeek.reduce((a, b) => a + b.points, 0), byWeek, nextStarters };
}

export interface TradeSide {
  rosterId: number;
  gives: string[];
  gets: string[];
  before: LineupProjection;
  after: LineupProjection;
  rosDelta: number;
  perWeekDelta: number;
  valueOut: number;
  valueIn: number;
  dynastyOut: number;
  dynastyIn: number;
  newStarters: string[];
  lostStarters: string[];
}

export function analyzeTradeSide(args: {
  rosterId: number;
  roster: readonly string[];
  gives: readonly string[];
  gets: readonly string[];
  slots: readonly string[];
  players: Record<string, PlayerInfo>;
  forecasts: ReadonlyMap<number, ReadonlyMap<string, WeekForecast>>;
  weeks: readonly number[];
  value: (id: string) => { value: number; dynasty: number };
}): TradeSide {
  const after = [...args.roster.filter(id => !args.gives.includes(id)), ...args.gets];
  const before = projectRoster(args.roster, args.slots, args.players, args.forecasts, args.weeks);
  const afterP = projectRoster(after, args.slots, args.players, args.forecasts, args.weeks);
  const sum = (ids: readonly string[], key: 'value' | 'dynasty') => ids.reduce((s, id) => s + args.value(id)[key], 0);
  const beforeSet = new Set(before.nextStarters), afterSet = new Set(afterP.nextStarters);
  return {
    rosterId: args.rosterId,
    gives: [...args.gives],
    gets: [...args.gets],
    before,
    after: afterP,
    rosDelta: afterP.total - before.total,
    perWeekDelta: args.weeks.length ? (afterP.total - before.total) / args.weeks.length : 0,
    valueOut: sum(args.gives, 'value'),
    valueIn: sum(args.gets, 'value'),
    dynastyOut: sum(args.gives, 'dynasty'),
    dynastyIn: sum(args.gets, 'dynasty'),
    newStarters: afterP.nextStarters.filter(id => !beforeSet.has(id)),
    lostStarters: before.nextStarters.filter(id => !afterSet.has(id)),
  };
}

// ─── Whole-trade evaluation from a compact kit (runs on the server and in the browser) ───

/**
 * Everything a trade evaluation reads, small enough to ship to the browser: each active rostered
 * player's expected points and variance for every remaining week, and each team's week-by-week
 * score distribution as the season simulation sees it.
 */
export interface TradeKit {
  weeks: number[];
  slots: string[];
  lastRegularWeek: number;
  season: { playoffTeams: number; playoffStart: number; roundWeeks: number; finalWeeks: number; leverageWeek: number; seed: string; sims: number };
  /** `roster` is everyone on the team (what can be traded); `active` leaves out IR and taxi (who can start). */
  teams: { rosterId: number; roster: string[]; active: string[]; record: { wins: number; losses: number; ties: number; pointsFor: number }; factor: number }[];
  remaining: ScheduledGame[];
  /** `${rosterId}:${week}` → [mean, sd] of the team's score (best lineup × manager factor). */
  dists: Record<string, [number, number]>;
  /** Every rostered player: eligibility, values and, per kit week, [expected, variance] (null: no forecast). */
  players: Record<string, { eligible: Pos[]; value: number; dynasty: number; name: string; weeks: ([number, number] | null)[] }>;
  /** Playoff and title odds before any trade, from the league's own season simulation. */
  before: Record<string, { playoffPct: number; champPct: number }>;
}

export interface TradeRequest { a: number; b: number; aGives: string[]; bGives: string[] }

/** Apply manager effects and common uncertainty only to points that have not been scored. */
export function lineupDist(l: { expected: number; sd: number }, factor: number, bankedPoints = 0): TeamWeekDist {
  const remaining = (l.expected - bankedPoints) * factor;
  return { mean: bankedPoints + remaining, sd: Math.sqrt(l.sd ** 2 + (0.03 * remaining) ** 2) };
}

export class TradeError extends Error {}

const r1 = (n: number) => round(n, 1);
const r2 = (n: number) => round(n, 2);
const r4 = (n: number) => round(n, 4);

/**
 * Re-optimizes both rosters every remaining week and re-runs the season simulation with the
 * traded teams' new lineups. Players come back as ids; the caller attaches display rows.
 */
export function evaluateTrade(kit: TradeKit, body: TradeRequest) {
  const ta = kit.teams.find(t => t.rosterId === body.a), tb = kit.teams.find(t => t.rosterId === body.b);
  if (!ta || !tb || ta === tb) throw new TradeError('Pick two different teams');
  const valid = (ids: unknown, owner: typeof ta) => Array.isArray(ids) && ids.every(x => typeof x === 'string' && owner.roster.includes(x));
  if (!valid(body.aGives, ta) || !valid(body.bGives, tb)) throw new TradeError('Every traded player must be on the giving roster');
  if (!body.aGives.length && !body.bGives.length) throw new TradeError('Add at least one player');
  const weeks = kit.weeks;
  const players: Record<string, PlayerInfo> = {};
  const forecasts = new Map<number, Map<string, WeekForecast>>(weeks.map(w => [w, new Map()]));
  for (const [id, p] of Object.entries(kit.players)) {
    players[id] = { id, name: p.name, pos: p.eligible[0], eligible: p.eligible } as PlayerInfo;
    p.weeks.forEach((v, i) => { if (v) forecasts.get(weeks[i])!.set(id, { expected: v[0] } as WeekForecast); });
  }
  const value = (pid: string) => ({ value: kit.players[pid]?.value ?? 0, dynasty: kit.players[pid]?.dynasty ?? 0 });
  const sideA = analyzeTradeSide({ rosterId: ta.rosterId, roster: ta.active, gives: body.aGives, gets: body.bGives, slots: kit.slots, players, forecasts, weeks, value });
  const sideB = analyzeTradeSide({ rosterId: tb.rosterId, roster: tb.active, gives: body.bGives, gets: body.aGives, slots: kit.slots, players, forecasts, weeks, value });

  // Best lineup of a set of players in one kit week: expected and sd as lineupStats computes them.
  const best = (ids: readonly string[], i: number) => {
    const pool: LineupCandidate[] = [];
    for (const id of ids) {
      const p = kit.players[id], v = p?.weeks[i];
      if (p && v) pool.push({ id, eligible: p.eligible, value: v[0] });
    }
    const result = optimizeLineup(kit.slots, pool);
    let expected = 0, variance = 0;
    for (const id of result.ids) {
      const v = id ? kit.players[id]?.weeks[i] : null;
      if (v) { expected += v[0]; variance += v[1]; }
    }
    return { expected, sd: Math.sqrt(variance) };
  };
  const override = new Map<string, TeamWeekDist>();
  for (const [side, t] of [[sideA, ta], [sideB, tb]] as const) {
    const ids = [...t.active.filter(pid => !side.gives.includes(pid)), ...side.gets];
    weeks.forEach((w, i) => override.set(`${t.rosterId}:${w}`, lineupDist(best(ids, i), t.factor)));
  }
  const after = simulateSeason({
    teams: kit.teams.map(t => t.rosterId),
    record: new Map(kit.teams.map(t => [t.rosterId, t.record])),
    // The current week's result still counts when the trade takes effect next week.
    remaining: kit.remaining.filter(g => g.week <= kit.lastRegularWeek),
    dist: (rid, w) => override.get(`${rid}:${w}`) ?? (d => (d ? { mean: d[0], sd: d[1] } : { mean: 0, sd: 1 }))(kit.dists[`${rid}:${w}`]),
    ...kit.season,
  });
  const odds = (rid: number) => {
    const o = after.teams.find(x => x.rosterId === rid)!;
    return { playoffPct: r4(o.playoffPct), champPct: r4(o.champPct) };
  };
  const name = (pid: string) => kit.players[pid]?.name ?? pid;
  const view = (s: TradeSide, t: typeof ta) => ({
    rosterId: s.rosterId,
    gives: s.gives, gets: s.gets,
    rosBefore: r1(s.before.total), rosAfter: r1(s.after.total), rosDelta: r1(s.rosDelta), perWeekDelta: r2(s.perWeekDelta),
    byWeek: s.before.byWeek.map((b, i) => ({ week: b.week, before: r1(b.points), after: r1(s.after.byWeek[i].points) })),
    valueOut: r1(s.valueOut), valueIn: r1(s.valueIn), dynastyOut: r1(s.dynastyOut), dynastyIn: r1(s.dynastyIn),
    newStarters: s.newStarters.map(name), lostStarters: s.lostStarters.map(name),
    oddsBefore: kit.before[String(s.rosterId)] ?? { playoffPct: 0, champPct: 0 }, oddsAfter: odds(s.rosterId),
    rosterSizeAfter: t.active.length - s.gives.length + s.gets.length,
  });
  const A = view(sideA, ta), B = view(sideB, tb);
  const edge = (x: typeof A) => x.rosDelta / Math.max(1, weeks.length) + 0.08 * (x.dynastyIn - x.dynastyOut);
  const ea = edge(A), eb = edge(B);
  const verdict = (Math.abs(ea - eb) < 1.2 ? 'fair' : ea > eb ? 'a' : 'b') as 'fair' | 'a' | 'b';
  return { weeks, a: A, b: B, verdict, note: `Trade impact starts ${weeks.length ? `in week ${weeks[0]}` : 'after the remaining forecast horizon'}; current-week results and lineups stay with their original teams. Now = each team’s best legal lineup from then on. Dynasty = four-season value on the age curve.` };
}
