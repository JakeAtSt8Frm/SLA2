import type { Pos } from './types.ts';

const POSITION_MAP: Record<string, Pos> = {
  QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE', K: 'K', PK: 'K', DEF: 'DEF',
  DL: 'DL', DE: 'DL', DT: 'DL', NT: 'DL', EDGE: 'DL',
  LB: 'LB', ILB: 'LB', OLB: 'LB', MLB: 'LB',
  DB: 'DB', CB: 'DB', S: 'DB', SS: 'DB', FS: 'DB',
};

export const FANTASY_POSITIONS: readonly Pos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'];
export const IDP_POSITIONS: readonly Pos[] = ['DL', 'LB', 'DB'];

export function normalizePosition(raw: string | null | undefined): Pos | null {
  if (!raw) return null;
  return POSITION_MAP[raw.toUpperCase()] ?? null;
}

/** Which fantasy positions may fill each Sleeper roster slot. */
export const SLOT_ELIGIBILITY: Record<string, readonly Pos[]> = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'],
  DL: ['DL'], LB: ['LB'], DB: ['DB'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['WR', 'RB'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
};

export const SLOT_LABELS: Record<string, string> = {
  SUPER_FLEX: 'SF', FLEX: 'FLX', WRRB_FLEX: 'W/R', REC_FLEX: 'W/T', IDP_FLEX: 'IDP',
};

export const NON_STARTING_SLOTS = new Set(['BN', 'IR', 'TAXI']);

export function starterSlots(rosterPositions: readonly string[]): string[] {
  return rosterPositions.filter(slot => !NON_STARTING_SLOTS.has(slot));
}

export function canFill(eligible: readonly Pos[], slot: string): boolean {
  const allowed = SLOT_ELIGIBILITY[slot];
  if (!allowed) return false;
  return eligible.some(pos => allowed.includes(pos));
}

/** Sleeper and nflverse disagree on a handful of team codes. Everything internal uses Sleeper's. */
const TEAM_ALIASES: Record<string, string> = { LA: 'LAR', STL: 'LAR', SD: 'LAC', OAK: 'LV', WSH: 'WAS', JAC: 'JAX' };
export function normalizeTeam(team: string | null | undefined): string | null {
  if (!team) return null;
  const upper = team.toUpperCase();
  return TEAM_ALIASES[upper] ?? upper;
}
