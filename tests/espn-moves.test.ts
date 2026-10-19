import { describe, expect, it } from 'vitest';
import { matchPlayer, moveBody, nextStep, openSpots, readResult, rosterPlayer, type MoveContext, type PlayerState } from '../server/espn-moves.ts';

const me = { teamId: 6, scoringPeriodId: 7 };
const player = (p: Partial<PlayerState>): PlayerState => ({ id: 1, name: 'Target', status: 'FREEAGENT', onTeamId: 0, waiverProcessDate: null, ...p });

describe('ESPN roster moves', () => {
  it('adds free agents, claims waiver players and watches rostered ones', () => {
    expect(nextStep(player({}), me, { keepPriority: false })).toEqual({ kind: 'add' });
    expect(nextStep(player({ status: 'WAIVERS', waiverProcessDate: 5 }), me, { keepPriority: false })).toEqual({ kind: 'claim', processAt: 5 });
    expect(nextStep(player({ status: 'ONTEAM', onTeamId: 2 }), me, { keepPriority: false }).kind).toBe('watch');
    expect(nextStep(player({ status: 'ONTEAM', onTeamId: 6 }), me, { keepPriority: false }).kind).toBe('done');
  });

  it('keeps waiver priority by waiting for the clear time, but only when ESPN gives one', () => {
    expect(nextStep(player({ status: 'WAIVERS', waiverProcessDate: 5 }), me, { keepPriority: true })).toEqual({ kind: 'wait', until: 5 });
    expect(nextStep(player({ status: 'WAIVERS' }), me, { keepPriority: true })).toEqual({ kind: 'claim', processAt: null });
  });

  it('builds the envelope ESPN records for its own adds, for our team only', () => {
    const body = moveBody(me, 'WAIVER', 111, { playerId: 222, slot: 20 }, 4);
    expect(body).toMatchObject({ isLeagueManager: false, teamId: 6, type: 'WAIVER', scoringPeriodId: 7, executionType: 'EXECUTE', bidAmount: 4 });
    expect(body.items).toEqual([
      { playerId: 111, type: 'ADD', fromTeamId: 0, toTeamId: 6, fromLineupSlotId: -1, toLineupSlotId: -1 },
      { playerId: 222, type: 'DROP', fromTeamId: 6, toTeamId: 0, fromLineupSlotId: 20, toLineupSlotId: -1 },
    ]);
    // Free-agent adds never carry a bid.
    expect(moveBody(me, 'FREEAGENT', 111, null, 9)).toMatchObject({ type: 'FREEAGENT', bidAmount: 0, items: [{ type: 'ADD' }] });
  });

  it('reads ESPN success states and TRAN_* rejections', () => {
    expect(readResult(200, { transactions: [{ status: 'EXECUTED' }] })).toMatchObject({ ok: true, state: 'EXECUTED' });
    expect(readResult(200, { status: 'PENDING' })).toMatchObject({ ok: true, state: 'PENDING' });
    expect(readResult(200, { status: 'FAILED_ROSTERLIMIT' }).ok).toBe(false);
    expect(readResult(409, { details: [{ type: 'TRAN_ROSTER_LIMIT_EXCEEDED', message: 'Roster is full' }] }))
      .toMatchObject({ ok: false, status: 409, message: 'TRAN_ROSTER_LIMIT_EXCEEDED: Roster is full' });
  });

  it('matches players by id, exact name (ignoring accents and suffixes) or a unique partial name', () => {
    const dir = { 1: ['Aaron Jones Sr.', 2, 9] as [string, number, number], 2: ['Josh Allen', 1, 2] as [string, number, number], 3: ['Josh Allen', 11, 30] as [string, number, number], 4: ['Amon-Ra St. Brown', 3, 8] as [string, number, number] };
    expect(matchPlayer(dir, '42')).toBe(42);
    expect(matchPlayer(dir, 'aaron jones')).toBe(1);
    expect(matchPlayer(dir, 'amonra st brown')).toBe(4);
    expect(matchPlayer(dir, 'st. brown')).toBe(4);
    expect(() => matchPlayer(dir, 'Josh Allen')).toThrow(/matches 2 players/);
    expect(() => matchPlayer(dir, 'Nobody')).toThrow(/No ESPN player/);
  });

  it('counts open roster spots without IR', () => {
    const roster = [{ playerId: 1, name: 'A', slot: 20 }, { playerId: 2, name: 'B', slot: 4 }, { playerId: 3, name: 'Hurt', slot: 21 }];
    expect(openSpots({ rosterLimit: 2, roster })).toBe(0);
    expect(openSpots({ rosterLimit: 3, roster })).toBe(1);
  });

  it('only drops players on our own roster', () => {
    const ctx = { teamName: 'Mine', roster: [{ playerId: 9, name: "Ja'Marr Chase", slot: 20 }, { playerId: 8, name: 'DK Metcalf', slot: 4 }] } as MoveContext;
    expect(rosterPlayer(ctx, 'jamarr chase').playerId).toBe(9);
    expect(rosterPlayer(ctx, '8').name).toBe('DK Metcalf');
    expect(() => rosterPlayer(ctx, 'Puka Nacua')).toThrow(/not on Mine/);
  });
});
