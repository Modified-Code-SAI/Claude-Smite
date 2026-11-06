import { describe, expect, it } from 'vitest';
import { GODS } from './gods';
import { clashBots, conquestBots, duelRival, lineupFor, seeded, siegeBots } from './lineup';
import { rushRoster } from '../net/rushRoster';
import { descentRoster } from '../net/descentRoster';
import type { NetPlayer } from '../net/roster';

const me = (god: string): NetPlayer[] => [{ id: 'me', name: 'You', god, team: 'order' }];

describe('lineup', () => {
  it('the same seed gives the same numbers', () => {
    const a = seeded(42);
    const b = seeded(42);
    const xs = Array.from({ length: 8 }, () => a());
    expect(Array.from({ length: 8 }, () => b())).toEqual(xs);
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(0), expect(x).toBeLessThan(1);
    expect(seeded(43)()).not.toBe(xs[0]);
  });

  it('bot allies never take the player\'s god, and changing god keeps the others', () => {
    for (let seed = 1; seed < 60; seed++) {
      for (const g of GODS) {
        const c = clashBots(g.id, seeded(seed));
        expect(c.allies).toHaveLength(2);
        expect(c.enemies).toHaveLength(3);
        expect(c.allies).not.toContain(g.id);
        expect(new Set(c.allies).size).toBe(2);
        expect(siegeBots(g.id, seeded(seed))).not.toContain(g.id);
        expect(duelRival(g.id, '', seeded(seed))).not.toBe(g.id);
      }
      // picking another god swaps out at most the one ally that clashed with it
      const a = clashBots('zeus', seeded(seed)).allies;
      const b = clashBots('thor', seeded(seed)).allies;
      expect(a.filter((x) => b.includes(x)).length).toBeGreaterThanOrEqual(1);
      // the enemies don't depend on your god at all
      expect(clashBots('zeus', seeded(seed)).enemies).toEqual(clashBots('loki', seeded(seed)).enemies);
    }
  });

  it('a named Duel rival is kept unless it is your own god', () => {
    expect(duelRival('zeus', 'odin', seeded(1))).toBe('odin');
    expect(duelRival('odin', 'odin', seeded(1))).not.toBe('odin');
  });

  it('shows the lineup each mode builds from the same seed', () => {
    const seed = 777;
    const clash = lineupFor({ mode: 'clash', players: me('loki'), seed });
    expect(clash.order.map((s) => s.god)).toEqual(['loki', ...clashBots('loki', seeded(seed)).allies]);
    expect(clash.chaos.map((s) => s.god)).toEqual(clashBots('loki', seeded(seed)).enemies);
    expect(lineupFor({ mode: 'siege', players: me('odin'), seed }).order.slice(1).map((s) => s.god)).toEqual(siegeBots('odin', seeded(seed)));
    expect(lineupFor({ mode: 'duel', players: me('odin'), seed, rival: 'thor' }).chaos[0]!.god).toBe('thor');
    const rush = rushRoster(me('anubis'), seeded(seed));
    expect(lineupFor({ mode: 'rush', players: me('anubis'), seed }).chaos.map((s) => s.god)).toEqual(rush.filter((s) => s.team === 'chaos').map((s) => s.god));
    const descent = descentRoster(me('thor'), seeded(seed), { versus: true, bots: { order: true } });
    expect(lineupFor({ mode: 'descent', players: me('thor'), seed, rivals: true }).chaos.map((s) => s.god)).toEqual(descent.filter((s) => s.team === 'chaos').map((s) => s.god));
    // Conquest alone: the other four gods with you, all five against you
    const cq = lineupFor({ mode: 'conquest', players: me('zeus'), seed });
    expect(cq.order).toHaveLength(5);
    expect(cq.chaos).toHaveLength(5);
    expect(cq.order[0]!.player).toBe('me');
    expect(cq.order.slice(1).map((s) => s.god)).toEqual(conquestBots('zeus', seeded(seed)).allies);
    expect(cq.chaos.map((s) => s.god)).toEqual(conquestBots('zeus', seeded(seed)).enemies);
    // every god can turn up as a Conquest bot, not only the first five
    const seen = new Set<string>();
    for (let k = 1; k < 40; k++) for (const g of conquestBots('zeus', seeded(k)).enemies) seen.add(g);
    expect(seen.size).toBe(GODS.length);
  });

  it('the Jötunn marks who is the giant first', () => {
    const giantFirst = (role?: 'giant' | 'god' | 'rotate') => lineupFor({ mode: 'jotunn', players: me('zeus'), seed: 1, role }).order.find((s) => s.giant)!;
    expect(giantFirst('giant').player).toBe('me');
    expect(giantFirst('rotate').player).toBeNull();
    expect(giantFirst('god').player).toBeNull();
  });
});
