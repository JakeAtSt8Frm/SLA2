import { describe, expect, it } from 'vitest';
import { powerRankings, type PowerGame, type PowerInput } from '../engine/power.ts';

const row = (rosterId: number, weekly: number[], games: PowerGame[]): PowerInput => ({ rosterId, weekly, allPlayWins: 0, allPlayGames: 0, outlook: 0, games });
const comp = (rows: PowerInput[], rosterId: number) => powerRankings(rows, 3).find(r => r.rosterId === rosterId)!;

describe('opponent-adjusted strength', () => {
  // A pads his record against a soft team; B earns the same raw margin against a strong one.
  it('credits the same margin more against tough opponents', () => {
    const rows = [
      row(1, [25, 20], [{ opponentId: 3, margin: 10 }, { opponentId: 3, margin: 10 }]), // A
      row(2, [30, 25], [{ opponentId: 4, margin: 10 }, { opponentId: 4, margin: 10 }]), // B
      row(3, [5, 0], [{ opponentId: 1, margin: -10 }, { opponentId: 5, margin: -30 }]), // soft X
      row(4, [10, 5], [{ opponentId: 2, margin: -10 }, { opponentId: 5, margin: 20 }]), // strong Y
      row(5, [15, 10], [{ opponentId: 3, margin: 30 }, { opponentId: 4, margin: -20 }]),
    ];
    const a = comp(rows, 1), b = comp(rows, 2);
    expect(b.components.strength).toBeGreaterThan(a.components.strength);
    expect(b.weights.strength).toBeGreaterThan(0);
  });

  it('rates a bye week as average, not as a zero', () => {
    const rows = [
      row(1, [20], [{ opponentId: null, margin: null }]),
      row(2, [20], [{ opponentId: 1, margin: 5 }]),
    ];
    const a = comp(rows, 1);
    expect(a.components.strength).toBe(50); // no games played → neutral
  });

  it('weights strength to zero when the schedule is unknown', () => {
    const rows: PowerInput[] = [{ rosterId: 1, weekly: [20, 30], allPlayWins: 0, allPlayGames: 0, outlook: 0 }];
    const r = powerRankings(rows, 2);
    expect(r[0].weights.strength).toBe(0);
    expect(r[0].rank).toBe(1);
  });
});
