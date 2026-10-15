/**
 * Feature construction shared by model training (research/) and live serving (server/).
 * Keeping one implementation guarantees the model sees identical inputs in both places.
 *
 * Everything is causal: features for (season, week) only use games ingested before it,
 * limited to the current and previous season so live serving can reproduce it exactly.
 * Matchup features (opponent points allowed, opponent and team pace) use the current season only.
 */
import { completeStats, didPlay, hasForecast, scoreStatsExact } from './scoring.ts';
import type { GameContext, Pos, Stats } from './types.ts';

export const POS_INDEX: Record<Pos, number> = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DL: 5, LB: 6, DB: 7, DEF: 8 };
export const MODEL_POSITIONS: readonly Pos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'];
const IDP = new Set<Pos>(['DL', 'LB', 'DB']);

export const FEATURE_NAMES = [
  'proj_pts', 'has_proj', 'proj_off_pts', 'proj_tkl_pts', 'proj_big_pts', 'proj_k_pts', 'proj_opps', 'proj_pass_att', 'proj_tkl',
  'n_cur', 'mean_cur', 'ewma', 'last1', 'mean_l4', 'n_prev', 'mean_prev', 'mean_l16', 'n_l16', 'sd_l16', 'max_l16',
  'snap_l1', 'snap_l4', 'snaps_l4', 'opps_l4', 'tgt_l4', 'carry_l4', 'pass_att_l4', 'tkl_l4',
  'tkl_rate', 'big_rate', 'exp_tkl_pts', 'exp_big_pts', 'big_pts_l16', 'fga_l8', 'weeks_since',
  'proj_resid', 'proj_resid_n', 'proj_vs_form', 'snap_trend', 'gap_ewma', 'gap_l16', 'gap_big',
  'opp_ratio', 'opp_plays_ratio', 'team_plays_ratio', 'implied', 'opp_implied', 'spread', 'total', 'home', 'dome', 'rest',
  'age', 'exp', 'wk',
  'is_qb', 'is_rb', 'is_wr', 'is_te', 'is_k', 'is_dl', 'is_lb', 'is_db',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export const FEATURE_COUNT = FEATURE_NAMES.length;
const F = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, i])) as Record<FeatureName, number>;

export interface PlayerMeta { pos: Pos; birthDate: string | null; yearsExp: number | null }
export interface IngestLine { id: string; team: string | null; opponent: string | null; stats: Stats }

interface Log {
  season: number;
  week: number;
  abs: number;
  pts: number;
  snapShare: number | null;
  snaps: number;
  opps: number;
  tgt: number;
  carries: number;
  passAtt: number;
  tkl: number;
  tklPts: number;
  bigPts: number;
  fga: number;
  /** Provider projection for this game, league-scored (null when none existed). */
  proj: number | null;
}

interface HistoryPart { season: number; count: number; logs: readonly Log[]; x: Float64Array; lastAbs: number | null; bigRate: number; tklRate: number }

interface TeamSeason { offSnaps: number; defSnaps: number; games: number; weeks: Set<number>; allowed: Map<Pos, number> }

const TACKLE_KEYS = ['idp_tkl_solo', 'idp_tkl_ast'];
const BIG_KEYS = ['idp_sack', 'idp_int', 'idp_pass_def', 'idp_ff', 'idp_fum_rec', 'idp_tkl_loss', 'idp_qb_hit', 'idp_def_td', 'idp_safe', 'idp_blk_kick'];
const K_KEYS = ['fgm_0_19', 'fgm_20_29', 'fgm_30_39', 'fgm_40_49', 'fgm_50p', 'fgmiss', 'xpm', 'xpmiss'];
const OFF_PREFIXES = ['pass_', 'rush_', 'rec', 'bonus_rec', 'fum'];

const absWeek = (season: number, week: number) => season * 25 + week;

export interface WeightSplit { tackles: [string, number][]; big: [string, number][]; kick: [string, number][]; offense: [string, number][] }
export function splitScoring(scoring: readonly [string, number][]): WeightSplit {
  return {
    tackles: scoring.filter(([k]) => TACKLE_KEYS.includes(k)),
    big: scoring.filter(([k]) => BIG_KEYS.includes(k)),
    kick: scoring.filter(([k]) => K_KEYS.includes(k)),
    offense: scoring.filter(([k]) => OFF_PREFIXES.some(p => k.startsWith(p))),
  };
}

export class FeatureState {
  private logs = new Map<string, Log[]>();
  private teams = new Map<string, TeamSeason>(); // key `${season}:${team}`
  private posTotals = new Map<string, { big: number; tkl: number; snaps: number }>(); // key `${season}:${pos}`
  private split: WeightSplit;
  private scoring: readonly [string, number][];
  private meta: (id: string) => PlayerMeta | undefined;
  /** History half of each player's feature vector, shared by every week forecast from the same games. */
  private historyMemo = new Map<string, HistoryPart>();

  constructor(scoring: readonly [string, number][], meta: (id: string) => PlayerMeta | undefined) {
    this.scoring = scoring;
    this.meta = meta;
    this.split = splitScoring(scoring);
  }

  /** Forget anything older than the previous season (live serving only ever has that much). */
  startSeason(season: number) {
    this.historyMemo.clear();
    for (const [id, logs] of this.logs) {
      const kept = logs.filter(l => l.season >= season - 1);
      if (kept.length) this.logs.set(id, kept); else this.logs.delete(id);
    }
    for (const key of this.teams.keys()) if (Number(key.split(':')[0]) < season - 1) this.teams.delete(key);
    for (const key of this.posTotals.keys()) if (Number(key.split(':')[0]) < season - 1) this.posTotals.delete(key);
  }

  /**
   * Add a completed week. `projections` are that week's provider forecasts, used to learn
   * how much each player tends to beat or miss them.
   */
  ingestWeek(season: number, week: number, lines: readonly IngestLine[], projections?: ReadonlyMap<string, Stats>) {
    this.historyMemo.clear();
    const abs = absWeek(season, week);
    // Team volume from any player's team-snap counters.
    const teamSnaps = new Map<string, { off: number; def: number; opp: string | null }>();
    for (const line of lines) {
      if (!line.team || line.id.startsWith('TEAM_')) continue;
      const t = teamSnaps.get(line.team) ?? { off: 0, def: 0, opp: line.opponent };
      t.off = Math.max(t.off, line.stats.tm_off_snp ?? 0);
      t.def = Math.max(t.def, line.stats.tm_def_snp ?? 0);
      t.opp ??= line.opponent;
      teamSnaps.set(line.team, t);
    }
    for (const [team, t] of teamSnaps) {
      if (t.off <= 0 && t.def <= 0) continue;
      const ts = this.team(season, team);
      if (ts.weeks.has(week)) continue;
      ts.weeks.add(week);
      ts.games++;
      ts.offSnaps += t.off;
      ts.defSnaps += t.def;
    }
    for (const line of lines) {
      if (line.id.startsWith('TEAM_') || !didPlay(line.stats)) continue;
      const m = this.meta(line.id);
      if (!m || m.pos === 'DEF') continue;
      const s = completeStats(line.stats, m.pos);
      const pts = scoreStatsExact(s, this.scoring);
      const idp = IDP.has(m.pos);
      const snaps = idp ? (s.def_snp ?? 0) : m.pos === 'K' ? 0 : (s.off_snp ?? 0);
      const teamSnapsForPlayer = idp ? (s.tm_def_snp ?? 0) : (s.tm_off_snp ?? 0);
      const log: Log = {
        season, week, abs, pts,
        snapShare: teamSnapsForPlayer > 0 && m.pos !== 'K' ? Math.min(1, snaps / teamSnapsForPlayer) : null,
        snaps,
        opps: (s.rec_tgt ?? 0) + (s.rush_att ?? 0),
        tgt: s.rec_tgt ?? 0,
        carries: s.rush_att ?? 0,
        passAtt: s.pass_att ?? 0,
        tkl: (s.idp_tkl_solo ?? 0) + (s.idp_tkl_ast ?? 0),
        tklPts: scoreStatsExact(s, this.split.tackles),
        bigPts: scoreStatsExact(s, this.split.big),
        fga: (s.fga ?? 0) + (s.xpa ?? 0) * 0.25,
        proj: null,
      };
      const projection = projections?.get(line.id);
      if (projection && hasForecast(projection)) log.proj = scoreStatsExact(completeStats(projection, m.pos, true), this.scoring);
      const list = this.logs.get(line.id) ?? [];
      if (!list.length || list[list.length - 1].abs < abs) list.push(log);
      this.logs.set(line.id, list);
      if (line.opponent) {
        const opp = this.team(season, line.opponent);
        opp.allowed.set(m.pos, (opp.allowed.get(m.pos) ?? 0) + pts);
      }
      if (idp && snaps > 0) {
        const key = `${season}:${m.pos}`;
        const tot = this.posTotals.get(key) ?? { big: 0, tkl: 0, snaps: 0 };
        tot.big += log.bigPts;
        tot.tkl += log.tklPts;
        tot.snaps += snaps;
        this.posTotals.set(key, tot);
      }
    }
  }

  private team(season: number, team: string): TeamSeason {
    const key = `${season}:${team}`;
    let ts = this.teams.get(key);
    if (!ts) {
      ts = { offSnaps: 0, defSnaps: 0, games: 0, weeks: new Set(), allowed: new Map() };
      this.teams.set(key, ts);
    }
    return ts;
  }

  /** League-average per-team-game quantities for a season. */
  private leagueAverages(season: number) {
    let games = 0, off = 0, def = 0;
    const allowed = new Map<Pos, number>();
    for (const [key, ts] of this.teams) {
      if (Number(key.split(':')[0]) !== season) continue;
      games += ts.games;
      off += ts.offSnaps;
      def += ts.defSnaps;
      for (const [pos, v] of ts.allowed) allowed.set(pos, (allowed.get(pos) ?? 0) + v);
    }
    return { games, off: games ? off / games : 0, def: games ? def / games : 0, allowed, };
  }

  private averagesCache = new Map<number, ReturnType<FeatureState['leagueAverages']>>();
  /** Call after ingesting a week so cached league averages refresh. */
  clearAverages() { this.averagesCache.clear(); }
  private averages(season: number) {
    let a = this.averagesCache.get(season);
    if (!a) { a = this.leagueAverages(season); this.averagesCache.set(season, a); }
    return a;
  }

  /**
   * Opponent points allowed to a position relative to league average, from this season's games
   * only (neutral before the opponent has played), shrunk toward average while the sample is small.
   */
  private oppRatio(season: number, opp: string, pos: Pos): number {
    const K = 4;
    const cur = this.averages(season);
    const base = cur.games ? (cur.allowed.get(pos) ?? 0) / cur.games : 0;
    const team = this.teams.get(`${season}:${opp}`);
    if (!base || !team?.games) return 1;
    return ((team.allowed.get(pos) ?? 0) + K * base) / ((team.games + K) * base);
  }

  /** Team snaps per game relative to league average, this season only, shrunk like `oppRatio`. */
  private playsRatio(season: number, team: string, kind: 'off' | 'def'): number {
    const K = 3;
    const avg = this.averages(season)[kind];
    const ts = this.teams.get(`${season}:${team}`);
    if (!avg || !ts?.games) return 1;
    return ((kind === 'off' ? ts.offSnaps : ts.defSnaps) + K * avg) / ((ts.games + K) * avg);
  }

  private posRates(season: number, pos: Pos) {
    let big = 0, tkl = 0, snaps = 0;
    for (const s of [season, season - 1]) {
      const t = this.posTotals.get(`${s}:${pos}`);
      if (t) { big += t.big; tkl += t.tkl; snaps += t.snaps; }
    }
    return snaps > 0 ? { big: big / snaps, tkl: tkl / snaps } : { big: 0, tkl: 0 };
  }

  history(id: string): readonly Log[] { return this.logs.get(id) ?? []; }

  /**
   * Feature vector for one player-week. `projection` is the provider's raw component
   * projection (may be undefined); `ctx` is the NFL game context (undefined on bye).
   */
  features(id: string, season: number, week: number, projection: Stats | undefined, ctx: GameContext | undefined, team: string | null): Float64Array {
    const m = this.meta(id);
    if (!m) return new Float64Array(FEATURE_COUNT).fill(Number.NaN);
    const pos = m.pos;
    const idp = IDP.has(pos);
    const target = absWeek(season, week);
    const history = this.historyPart(id, season, target, pos);
    const x = history.x.slice();

    // Provider projection, rescored with this league's settings.
    if (projection && hasForecast(projection)) {
      const p = completeStats(projection, pos, true);
      x[F.proj_pts] = scoreStatsExact(p, this.scoring);
      x[F.has_proj] = 1;
      x[F.proj_off_pts] = scoreStatsExact(p, this.split.offense);
      x[F.proj_tkl_pts] = scoreStatsExact(p, this.split.tackles);
      x[F.proj_big_pts] = scoreStatsExact(p, this.split.big);
      x[F.proj_k_pts] = scoreStatsExact(p, this.split.kick);
      x[F.proj_opps] = (p.rec_tgt ?? 0) + (p.rush_att ?? 0);
      x[F.proj_pass_att] = p.pass_att ?? 0;
      x[F.proj_tkl] = (p.idp_tkl_solo ?? 0) + (p.idp_tkl_ast ?? 0);
    } else x[F.has_proj] = 0;

    if (history.lastAbs !== null) {
      x[F.weeks_since] = Math.min(30, target - history.lastAbs);
      if (idp) {
        const expSnaps = x[F.snaps_l4];
        const oppPlays = ctx ? this.playsRatio(season, ctx.opponent, 'off') : 1;
        x[F.exp_big_pts] = history.bigRate * expSnaps * oppPlays;
        x[F.exp_tkl_pts] = history.tklRate * expSnaps * oppPlays;
      }
    }

    if (!Number.isNaN(x[F.proj_pts]) && !Number.isNaN(x[F.mean_l16])) x[F.proj_vs_form] = x[F.proj_pts] - x[F.mean_l16];
    // How far recent production sits above/below the provider — where the provider is most wrong.
    x[F.gap_ewma] = x[F.ewma] - x[F.proj_pts];
    x[F.gap_l16] = x[F.mean_l16] - x[F.proj_pts];
    x[F.gap_big] = x[F.big_pts_l16] - x[F.proj_big_pts];

    if (ctx) {
      x[F.opp_ratio] = this.oppRatio(season, ctx.opponent, pos);
      x[F.opp_plays_ratio] = this.playsRatio(season, ctx.opponent, 'off');
      if (team) x[F.team_plays_ratio] = this.playsRatio(season, team, idp ? 'def' : 'off');
      if (ctx.impliedTotal !== null) x[F.implied] = ctx.impliedTotal;
      if (ctx.opponentImplied !== null) x[F.opp_implied] = ctx.opponentImplied;
      if (ctx.spread !== null) x[F.spread] = ctx.spread;
      if (ctx.total !== null) x[F.total] = ctx.total;
      x[F.home] = ctx.home ? 1 : 0;
      x[F.dome] = ctx.dome ? 1 : 0;
      if (ctx.rest !== null) x[F.rest] = ctx.rest;
    }

    if (m.birthDate) {
      const born = Date.parse(m.birthDate);
      if (Number.isFinite(born)) x[F.age] = (Date.UTC(season, 8, 1) - born) / (365.25 * 86400000);
    }
    if (m.yearsExp !== null) x[F.exp] = m.yearsExp;
    x[F.wk] = week;
    const flags: [FeatureName, Pos][] = [['is_qb', 'QB'], ['is_rb', 'RB'], ['is_wr', 'WR'], ['is_te', 'TE'], ['is_k', 'K'], ['is_dl', 'DL'], ['is_lb', 'LB'], ['is_db', 'DB']];
    for (const [name, p] of flags) x[F[name]] = pos === p ? 1 : 0;
    return x;
  }

  /**
   * Features built from the games played before `target`. Logs are in week order, so every week
   * after the latest game sees the same history; the result is kept until the next ingest.
   */
  private historyPart(id: string, season: number, target: number, pos: Pos): HistoryPart {
    const logs = this.logs.get(id) ?? [];
    let count = logs.length;
    while (count > 0 && logs[count - 1].abs >= target) count--;
    const cached = this.historyMemo.get(id);
    if (cached && cached.season === season && cached.count === count && cached.logs === logs) return cached;

    const x = new Float64Array(FEATURE_COUNT).fill(Number.NaN);
    const part: HistoryPart = { season, count, logs, x, lastAbs: null, bigRate: Number.NaN, tklRate: Number.NaN };
    const past = logs.slice(0, count);
    const cur = past.filter(l => l.season === season);
    const prev = past.filter(l => l.season === season - 1);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);

    x[F.n_cur] = cur.length;
    x[F.mean_cur] = mean(cur.map(l => l.pts));
    x[F.n_prev] = prev.length;
    x[F.mean_prev] = mean(prev.map(l => l.pts));
    if (past.length) {
      const l16 = past.slice(-16), l4 = past.slice(-4), l8 = past.slice(-8);
      let wsum = 0, wtot = 0;
      for (let i = 0; i < past.length; i++) {
        const w = 2 ** (-(past.length - 1 - i) / 4);
        wsum += w * past[i].pts;
        wtot += w;
      }
      x[F.ewma] = wsum / wtot;
      x[F.last1] = past[past.length - 1].pts;
      x[F.mean_l4] = mean(l4.map(l => l.pts));
      const m16 = mean(l16.map(l => l.pts));
      x[F.mean_l16] = m16;
      x[F.n_l16] = l16.length;
      x[F.sd_l16] = l16.length >= 3 ? Math.sqrt(mean(l16.map(l => (l.pts - m16) ** 2))) : Number.NaN;
      x[F.max_l16] = Math.max(...l16.map(l => l.pts));
      const shares4 = l4.map(l => l.snapShare).filter((v): v is number => v !== null);
      x[F.snap_l1] = past[past.length - 1].snapShare ?? Number.NaN;
      x[F.snap_l4] = mean(shares4);
      x[F.snaps_l4] = mean(l4.map(l => l.snaps));
      x[F.opps_l4] = mean(l4.map(l => l.opps));
      x[F.tgt_l4] = mean(l4.map(l => l.tgt));
      x[F.carry_l4] = mean(l4.map(l => l.carries));
      x[F.pass_att_l4] = mean(l4.map(l => l.passAtt));
      x[F.tkl_l4] = mean(l4.map(l => l.tkl));
      x[F.big_pts_l16] = mean(l16.map(l => l.bigPts));
      x[F.fga_l8] = mean(l8.map(l => l.fga));
      part.lastAbs = past[past.length - 1].abs;
      // Player-specific tendency to beat or miss the provider, shrunk hard toward zero.
      const withProj = past.filter(l => l.proj !== null).slice(-10);
      x[F.proj_resid_n] = withProj.length;
      x[F.proj_resid] = withProj.reduce((a, l) => a + (l.pts - (l.proj ?? 0)), 0) / (withProj.length + 6);
      const prevShares = past.slice(-8, -4).map(l => l.snapShare).filter((v): v is number => v !== null);
      if (prevShares.length && !Number.isNaN(x[F.snap_l4])) x[F.snap_trend] = x[F.snap_l4] - mean(prevShares);
      if (IDP.has(pos)) {
        // Per-snap rates shrunk toward the position (big plays are rare and noisy).
        const prior = this.posRates(season, pos);
        const snaps = l16.reduce((a, l) => a + l.snaps, 0);
        part.bigRate = (l16.reduce((a, l) => a + l.bigPts, 0) + 250 * prior.big) / (snaps + 250);
        part.tklRate = (l16.reduce((a, l) => a + l.tklPts, 0) + 120 * prior.tkl) / (snaps + 120);
        x[F.big_rate] = part.bigRate;
        x[F.tkl_rate] = part.tklRate;
      }
    }
    this.historyMemo.set(id, part);
    return part;
  }
}

/** Team-perspective betting context for a team in a game (nflverse spread: positive = home favoured). */
export function gameContext(
  game: { home: string; away: string; kickoff: number | null; spreadLine: number | null; totalLine: number | null; roof: string | null; homeRest: number | null; awayRest: number | null },
  team: string,
): GameContext {
  const home = game.home === team;
  const spread = game.spreadLine === null ? null : home ? game.spreadLine : -game.spreadLine;
  const total = game.totalLine;
  const implied = spread !== null && total !== null ? total / 2 + spread / 2 : null;
  return {
    opponent: home ? game.away : game.home,
    home,
    kickoff: game.kickoff,
    impliedTotal: implied,
    opponentImplied: implied !== null && total !== null ? total - implied : null,
    spread,
    total,
    rest: home ? game.homeRest : game.awayRest,
    dome: game.roof === 'dome' || game.roof === 'closed',
  };
}
