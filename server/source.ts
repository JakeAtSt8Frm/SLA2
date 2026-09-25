/**
 * One interface over league platforms. Sleeper leagues read Sleeper's API; ESPN leagues are
 * adapted onto the same shapes (server/espn.ts). Everything downstream is platform-blind.
 */
import { espnLeague, espnMatchups, espnTransactions, isEspnId } from './espn.ts';
import { sleeper, type SleeperLeague, type SleeperMatchup, type SleeperRoster, type SleeperTransaction, type SleeperUser } from './sleeper.ts';
import type { PlayerInfo } from '../engine/types.ts';

export type Platform = 'sleeper' | 'espn';

export interface LeagueExtras {
  /** Players the platform rosters that Sleeper's catalogue lacks. */
  players: Record<string, PlayerInfo>;
  /** Roster owned by the configured login, when the platform can tell. */
  myRosterId: number | null;
  /** Platform-written weekly outlooks, by player id. */
  outlooks: Map<string, string>;
  /** Scoring items the translation could not map (should be empty). */
  unsupportedScoring: number[];
}

export interface LeagueSource {
  platform: Platform;
  league(): Promise<SleeperLeague>;
  users(): Promise<SleeperUser[]>;
  rosters(): Promise<SleeperRoster[]>;
  matchups(week: number, final?: boolean): Promise<SleeperMatchup[]>;
  transactions(week: number, final?: boolean): Promise<SleeperTransaction[]>;
  /** Final placing by roster once a season is complete (1 = champion). */
  finalPlaces(final?: boolean): Promise<Map<number, number>>;
  extras(): Promise<LeagueExtras>;
}

const NO_EXTRAS: LeagueExtras = { players: {}, myRosterId: null, outlooks: new Map(), unsupportedScoring: [] };

export function sourceFor(id: string): LeagueSource {
  if (isEspnId(id)) {
    return {
      platform: 'espn',
      league: async () => (await espnLeague(id)).league,
      users: async () => (await espnLeague(id)).users,
      rosters: async () => (await espnLeague(id)).rosters,
      matchups: week => espnMatchups(id, week),
      transactions: (week, final = false) => espnTransactions(id, week, final),
      finalPlaces: async () => (await espnLeague(id)).finalPlaces,
      extras: async () => {
        const e = await espnLeague(id);
        return { players: e.extraPlayers, myRosterId: e.myRosterId, outlooks: e.outlooks, unsupportedScoring: e.unsupportedScoring };
      },
    };
  }
  return {
    platform: 'sleeper',
    league: () => sleeper.league(id),
    users: () => sleeper.users(id),
    rosters: () => sleeper.rosters(id),
    matchups: (week, final = false) => sleeper.matchups(id, week, final),
    transactions: (week, final = false) => sleeper.transactions(id, week, final),
    finalPlaces: async (final = false) => {
      const finish = new Map<number, number>();
      for (const m of await sleeper.winnersBracket(id, final)) {
        if (m.place !== null && m.winner !== null && m.loser !== null) { finish.set(m.winner, m.place); finish.set(m.loser, m.place + 1); }
      }
      return finish;
    },
    extras: async () => NO_EXTRAS,
  };
}
