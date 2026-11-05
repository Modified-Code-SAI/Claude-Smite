import { describe, expect, it } from 'vitest';
import type { RushLine } from '../sim/Rush';
import { rushAwards } from './rushAwards';

const line = (l: Partial<RushLine>): RushLine => ({ goals: 0, assists: 0, steals: 0, tackles: 0, passes: 0, dazed: 0, ...l });

describe('Relic Rush awards', () => {
  it('names an MVP, a Playmaker and a Wall, each a different god', () => {
    const a = { team: 'order', name: 'a' };
    const b = { team: 'order', name: 'b' };
    const c = { team: 'chaos', name: 'c' };
    const lines = new Map([
      [a, line({ goals: 3, passes: 4, assists: 1 })],
      [b, line({ passes: 6, assists: 2 })],
      [c, line({ tackles: 3, steals: 2, goals: 1 })],
    ]);
    const got = rushAwards([a, b, c], lines, 'order');
    expect(got.map((x) => [x.key, x.unit.name])).toEqual([['mvp', 'a'], ['playmaker', 'b'], ['wall', 'c']]);
    expect(got[0]!.stat).toBe('3 goals · 1 assist');
    expect(rushAwards([a, b, c], new Map([[a, line({ goals: 1, tackles: 2, steals: 9, passes: 3 })]]), 'order')[0]!.stat).toBe('1 goal · 2 tackles');
    expect(got[1]!.stat).toBe('6 passes · 2 assists');
    expect(got[2]!.stat).toBe('3 tackles · 2 steals');
  });

  it('skips an award nobody earned, and a tie goes to the winners', () => {
    const a = { team: 'order', name: 'a' };
    const c = { team: 'chaos', name: 'c' };
    const lines = new Map([
      [a, line({ goals: 1 })],
      [c, line({ goals: 1 })],
    ]);
    const got = rushAwards([a, c], lines, 'chaos');
    expect(got.map((x) => [x.key, x.unit.name])).toEqual([['mvp', 'c']]);
  });

  it('the MVP comes from the winning team, even when a loser had the bigger game', () => {
    const a = { team: 'order', name: 'a' };
    const c = { team: 'chaos', name: 'c' };
    const lines = new Map([
      [a, line({ goals: 1, passes: 2 })],
      [c, line({ goals: 3, steals: 8 })],
    ]);
    const got = rushAwards([a, c], lines, 'order');
    expect(got.find((x) => x.key === 'mvp')!.unit).toBe(a);
    expect(got.find((x) => x.key === 'wall')!.unit).toBe(c);
  });

  it('gives a god two awards only when nobody else earned the second', () => {
    const a = { team: 'order', name: 'a' };
    const b = { team: 'chaos', name: 'b' };
    const lines = new Map([
      [a, line({ goals: 2, tackles: 2 })],
      [b, line({ dazed: 3 })],
    ]);
    expect(rushAwards([a, b], lines, 'order').map((x) => [x.key, x.unit.name])).toEqual([['mvp', 'a'], ['wall', 'a']]);
  });
});
