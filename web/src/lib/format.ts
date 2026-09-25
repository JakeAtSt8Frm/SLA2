export const fmt = (n: number | null | undefined, digits = 1): string =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const signed = (n: number | null | undefined, digits = 1): string =>
  n === null || n === undefined ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmt(Math.abs(n), digits)}`;

export const pct = (n: number | null | undefined, digits = 0): string =>
  n === null || n === undefined ? '—' : `${(n * 100).toFixed(digits)}%`;

/** Probability shown without false precision at the extremes. */
export const prob = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '—';
  if (n >= 0.995) return '>99%';
  if (n <= 0.005) return '<1%';
  return `${Math.round(n * 100)}%`;
};

export const record = (w: number, l: number, t = 0) => `${w}–${l}${t ? `–${t}` : ''}`;

export const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

export function kickoff(ms: number | null | undefined): string {
  if (!ms) return 'TBD';
  const d = new Date(ms);
  return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function ago(iso: string | number | null | undefined): string {
  if (!iso) return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/**
 * Team colour follows the team (its place in the league's team list), never its rank.
 * ESPN team ids have gaps (1, 2, 3, 6, 9…), so ids are mapped to their order first.
 */
let teamOrder = new Map<number, number>();
export function setTeamOrder(rosterIds: readonly number[]) {
  teamOrder = new Map([...rosterIds].sort((a, b) => a - b).map((id, i) => [id, i]));
}
const slotOf = (rosterId: number) => ((teamOrder.get(rosterId) ?? rosterId - 1) % 8) + 1;
export const teamColor = (rosterId: number | null | undefined) => (rosterId ? `var(--team-${slotOf(rosterId)})` : 'var(--ink-3)');

/** Palette slots that read as the same hue family side by side (orange/pink/red, the two greens). */
const HUE_FAMILY: Record<number, string> = { 1: 'blue', 2: 'warm', 3: 'green', 4: 'yellow', 5: 'warm', 6: 'green', 7: 'violet', 8: 'warm' };
/**
 * Colours for a head-to-head view. Each team keeps its colour unless the pair would be hard
 * to tell apart, in which case the second team borrows the nearest contrasting palette colour.
 */
export function pairColors(a: number, b: number | null): [string, string] {
  const ca = teamColor(a);
  if (b === null) return [ca, 'var(--ink-3)'];
  const sa = slotOf(a), sb = slotOf(b);
  if (HUE_FAMILY[sa] !== HUE_FAMILY[sb]) return [ca, teamColor(b)];
  const alt = [1, 7, 4, 3].find(s => HUE_FAMILY[s] !== HUE_FAMILY[sa])!;
  return [ca, `var(--team-${alt})`];
}

export const SLOT_LABEL: Record<string, string> = { SUPER_FLEX: 'SF', FLEX: 'FLEX', WRRB_FLEX: 'W/R', REC_FLEX: 'W/T', IDP_FLEX: 'IDP' };
/** Platform of the league on screen, so labels follow its vocabulary (ESPN says D/ST, Sleeper DEF). */
let platform: string | undefined;
export function setPlatform(p: string | undefined) { platform = p; }
export const slotLabel = (s: string) => (s === 'DEF' && platform === 'espn' ? 'D/ST' : SLOT_LABEL[s] ?? s);

export const FEATURE_LABELS: Record<string, string> = {
  proj_pts: 'Provider projection (league scoring)', mean_cur: 'Season average', ewma: 'Recent-weighted average', mean_l4: 'Last 4 games',
  mean_prev: 'Last season average', snap_l4: 'Snap share (last 4)', snap_trend: 'Snap share trend', opps_l4: 'Touches + targets (last 4)',
  tkl_l4: 'Tackles per game (last 4)', big_rate: 'Big-play points per snap', exp_big_pts: 'Expected big-play points', proj_resid: 'Beats projections by',
  opp_ratio: 'Opponent allows vs average', opp_plays_ratio: 'Opponent offensive pace', implied: 'Team implied points', spread: 'Point spread (team)',
  weeks_since: 'Weeks since last game', age: 'Age', proj_big_pts: 'Projected big-play points', proj_tkl_pts: 'Projected tackle points',
  sd_l16: 'Game-to-game volatility', n_prev: 'Games last season', mean_l16: 'Last 16 games average', proj_vs_form: 'Projection vs form',
  last1: 'Last game', max_l16: 'Best game (last 16)', snap_l1: 'Snap share (last game)', snaps_l4: 'Snaps (last 4)', has_proj: 'Has projection',
  proj_off_pts: 'Projected offense points', proj_k_pts: 'Projected kicking points', proj_opps: 'Projected touches + targets', proj_tkl: 'Projected tackles',
  proj_pass_att: 'Projected pass attempts', total: 'Game total', opp_implied: 'Opponent implied points', team_plays_ratio: 'Team pace',
  tkl_rate: 'Tackle points per snap', big_pts_l16: 'Big-play points per game', fga_l8: 'Kick attempts per game', proj_resid_n: 'Games vs projection',
  n_cur: 'Games this season', n_l16: 'Games in last 16', tgt_l4: 'Targets (last 4)', carry_l4: 'Carries (last 4)', pass_att_l4: 'Pass attempts (last 4)',
  home: 'Home game', dome: 'Dome', rest: 'Rest days', wk: 'Week', exp_tkl_pts: 'Expected tackle points',
  gap_ewma: 'Recent form above projection', gap_l16: 'Last-16 average above projection', gap_big: 'Big-play form above projection',
};

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'] as const;
/** D/ST is ESPN's name for a team defense; Sleeper calls it DEF. */
export const posLabel = (pos: string, on: string | undefined = platform) => (pos === 'DEF' && on === 'espn' ? 'D/ST' : pos);

export const INJURY_SHORT: Record<string, string> = { Questionable: 'Q', Doubtful: 'D', Out: 'OUT', IR: 'IR', PUP: 'PUP', Sus: 'SUS', NA: 'NA', DNR: 'DNR', COV: 'COV', NFI: 'NFI' };
