import { describe, expect, it } from 'vitest';
import type { JotunnTally } from '../sim/Jotunn';
import { clockText, jotunnAwards, mightText } from './jotunnAwards';

type P = { name: string; tally: JotunnTally; giantRound: { braziers: number; time: number; won: boolean } | null };
const p = (name: string, t: Partial<JotunnTally> = {}, giantRound: P['giantRound'] = null): P => ({ name, tally: { might: 0, breaks: 0, felled: 0, takedowns: 0, ...t }, giantRound });
const who = (awards: ReturnType<typeof jotunnAwards<P>>) => Object.fromEntries(awards.map((a) => [a.key, `${a.player.name}: ${a.stat}`]));

describe("Jötunn's end-of-match awards", () => {
  it('the Giant Slayer tears the most Might, the Breaker breaks the most, each a different player where it can', () => {
    const players = [p('Zeus', { might: 34200, breaks: 3, felled: 1 }), p('Thor', { might: 21000, breaks: 4 }), p('Odin', { might: 900 })];
    expect(who(jotunnAwards(players))).toEqual({ slayer: 'Zeus: 34k Might · felled it', breaker: 'Thor: 4 weak points broken' });
    // the only one who broke anything takes both
    expect(who(jotunnAwards([p('Zeus', { might: 4200, breaks: 2 }), p('Thor', { might: 800 })]))).toEqual({ slayer: 'Zeus: 4.2k Might · 2 weak points broken', breaker: 'Zeus: 2 weak points broken' });
  });

  it('the Mightiest Jötunn is the best round as the giant: a win, braziers, then the quicker win or the loss with more takedowns; only when several played it', () => {
    const won = p('Loki', { takedowns: 2 }, { braziers: 3, time: 161, won: true });
    const slow = p('Anubis', { takedowns: 6 }, { braziers: 3, time: 200, won: true });
    const lost = p('Thor', { takedowns: 9 }, { braziers: 2, time: 300, won: false });
    expect(who(jotunnAwards([lost, slow, won]))).toMatchObject({ giant: 'Loki: won in 2:41 · 3 braziers' });
    expect(who(jotunnAwards([lost, p('Odin', {}, { braziers: 1, time: 400, won: false })]))).toMatchObject({ giant: 'Thor: 2 braziers · 9 takedowns' });
    // one giant all match (or a round where it did nothing) earns no medal
    expect(jotunnAwards([won, p('Zeus')]).some((a) => a.key === 'giant')).toBe(false);
    expect(jotunnAwards([p('Odin', {}, { braziers: 0, time: 90, won: false }), p('Zeus', {}, { braziers: 0, time: 80, won: false })])).toEqual([]);
  });

  it('formats Might and time for the end screen', () => {
    expect([mightText(860), mightText(4249), mightText(34200)]).toEqual(['860', '4.2k', '34k']);
    expect(clockText(161.9)).toBe('2:41');
  });
});
