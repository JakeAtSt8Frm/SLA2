import type { WeekForecast } from './forecast.ts';
import { optimizeLineup, type LineupCandidate } from './optimizer.ts';
import type { PlayerInfo } from './types.ts';

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
