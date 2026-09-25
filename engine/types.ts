/** Raw Sleeper stat/projection components keyed by Sleeper stat name. */
export type Stats = Record<string, number>;

export type Pos = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DL' | 'LB' | 'DB' | 'DEF';

export interface PlayerInfo {
  id: string;
  name: string;
  pos: Pos;
  /** Fantasy positions this player can fill (normalised to DL/LB/DB for IDP). */
  eligible: Pos[];
  team: string | null;
  age: number | null;
  birthDate: string | null;
  yearsExp: number | null;
  injuryStatus: string | null;
  injuryBodyPart: string | null;
  injuryNotes: string | null;
  status: string | null;
  depthOrder: number | null;
  searchRank: number | null;
  number: number | null;
  college: string | null;
  newsUpdated: number | null;
  /** ESPN player id, for leagues hosted on ESPN. */
  espnId?: string | null;
}

/** One NFL game in the schedule, joined from nflverse (kickoff/lines) and Sleeper (status). */
export interface NflGame {
  id: string;
  season: number;
  week: number;
  home: string;
  away: string;
  /** Kickoff in epoch ms (UTC). Null when the kickoff time is not published yet. */
  kickoff: number | null;
  /** Home spread from the home team's perspective as nflverse reports it: positive = home favoured. */
  spreadLine: number | null;
  totalLine: number | null;
  homeScore: number | null;
  awayScore: number | null;
  roof: string | null;
  homeRest: number | null;
  awayRest: number | null;
  divGame: boolean;
}

export interface GameContext {
  opponent: string;
  home: boolean;
  kickoff: number | null;
  /** Points the team is implied to score from spread and total. */
  impliedTotal: number | null;
  opponentImplied: number | null;
  /** Team perspective: positive = team favoured. */
  spread: number | null;
  total: number | null;
  rest: number | null;
  dome: boolean;
}

/** A played game in a player's history, already joined to the week's opponent. */
export interface GameLog {
  season: number;
  week: number;
  team: string | null;
  opponent: string | null;
  stats: Stats;
  points: number;
}
