import { describe, expect, it } from 'vitest';
import { godById } from '../game/gods';
import { ULTIMATE_SLOT } from '../game/loadout';
import { XP_TABLE } from '../game/progression';
import { GodBot } from './Bot';
import { BotComms } from './BotComms';
import { godUnit } from './factory';
import { contextKind, PING_BURST, PING_REFILL, PingLimiter, pingText, sectorOf, ULT_LOCKED, WHEEL } from './Pings';
import { Sim, type SimTerrain } from './Sim';
import type { SimEvent, Unit } from './Unit';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };
const bases = { order: { x: 0, z: 80, radius: 6 }, chaos: { x: 0, z: -80, radius: 6 } };
const DT = 1 / 60;

function world() {
  const sim = new Sim(flat, bases, () => 0.5);
  const pings: Extract<SimEvent, { type: 'ping' }>[] = [];
  sim.listeners.push((e) => {
    if (e.type === 'ping') pings.push(e);
  });
  const god = (id: string, team: 'order' | 'chaos', x: number, z: number, bot = false) => {
    // everyone's home is their team's fountain
    const u = godUnit(godById(id)!, team, { x: 0, z: bases[team].z, yaw: 0 });
    if (bot) u.brain = new GodBot(sim, u, { anchor: { x, z }, leash: 30, aggro: 20, aggression: 0 });
    sim.add(u);
    u.body.x = x;
    u.body.z = z;
    return u;
  };
  const run = (seconds: number, comms?: BotComms) => {
    for (let t = 0; t < seconds; t += DT) {
      sim.step(DT);
      comms?.step();
    }
  };
  return { sim, pings, god, run };
}

const orderOf = (u: Unit) => (u.brain as GodBot).order;

describe('ping words', () => {
  const thor = { name: 'Thor', kind: 'god' as const, team: 'chaos' as const };
  const tower = { name: 'Tower', kind: 'tower' as const, team: 'order' as const };
  const wyrm = { name: 'Treasure Wyrm', kind: 'monster' as const, team: 'neutral' as const };

  it('names what a call is about', () => {
    expect(pingText('attack', thor, 'order')).toBe('Attack Thor');
    expect(pingText('attack', null, 'order')).toBe('Attack here');
    expect(pingText('attack', tower, 'order')).toBe('Defend our tower');
    expect(pingText('group', wyrm, 'order')).toBe('Group at the Treasure Wyrm');
    expect(pingText('look', thor, 'order')).toBe('Enemy: Thor');
    expect(pingText('help', null, 'order')).toBe('Need help');
    expect(pingText('help', { ...thor, team: 'order' }, 'order')).toBe('Help Thor');
  });

  it('says how far off an ultimate is', () => {
    expect(pingText('ult', null, 'order', 0)).toBe('Ultimate ready');
    expect(pingText('ult', null, 'order', 31.2)).toBe('Ultimate in 32 s');
    expect(pingText('ult', null, 'order', ULT_LOCKED)).toBe('Ultimate at level 5');
  });

  it('picks a tap ping from what is under the crosshair', () => {
    expect(contextKind(null, 'order')).toBe('look');
    expect(contextKind(thor, 'order')).toBe('attack');
    expect(contextKind({ ...thor, team: 'order' }, 'order')).toBe('help');
    expect(contextKind(tower, 'order')).toBe('attack');
    expect(contextKind(wyrm, 'order')).toBe('attack');
  });

  it('maps the mouse to the wheel clockwise from the top', () => {
    expect(WHEEL[sectorOf(0, -50)]).toBe('attack');
    expect(WHEEL[sectorOf(50, 0)]).toBe('group');
    expect(WHEEL[sectorOf(0, 50)]).toBe('back');
    expect(WHEEL[sectorOf(-50, 0)]).toBe('help');
    expect(WHEEL[sectorOf(-35, -35)]).toBe('thanks');
  });
});

describe('pings', () => {
  it('allows a short burst, then mutes a stream until the allowance comes back', () => {
    const { god } = world();
    const u = god('zeus', 'order', 0, 0);
    const lim = new PingLimiter();
    for (let i = 0; i < PING_BURST; i++) expect(lim.take(u, 0)).toBe(true);
    expect(lim.take(u, 0.1)).toBe(false);
    expect(lim.take(u, PING_REFILL + 0.05)).toBe(true);
    expect(lim.take(u, PING_REFILL + 0.1)).toBe(false);
  });

  it('marks a unit where it stands, a call about yourself on you, and never names a hidden enemy', () => {
    const { sim, pings, god } = world();
    const me = god('zeus', 'order', 0, 0);
    const foe = god('loki', 'chaos', 10, -20);
    expect(sim.ping(me, 'attack', 3, 3, foe)).toBe(true);
    expect(pings.at(-1)).toMatchObject({ kind: 'attack', subject: foe, x: 10, z: -20 });
    sim.ping(me, 'thanks', 40, 40, null);
    expect(pings.at(-1)).toMatchObject({ x: 0, z: 0 });
    foe.stealth = 3;
    sim.ping(me, 'attack', 9, -19, foe);
    expect(pings.at(-1)).toMatchObject({ subject: null, x: 9, z: -19 });
  });

  it('reports the ultimate: locked early, then its cooldown', () => {
    const { sim, pings, god } = world();
    const me = god('zeus', 'order', 0, 0);
    sim.ping(me, 'ult', 0, 0);
    expect(pings.at(-1)!.ult).toBe(ULT_LOCKED);
    me.combatant.gainXp(XP_TABLE[9]!);
    me.combatant.mana = me.combatant.stats.maxMana;
    me.aim.x = 0;
    me.aim.z = -10;
    expect(sim.cast(me, ULTIMATE_SLOT)).toBeNull();
    sim.ping(me, 'ult', 0, 0);
    expect(pings.at(-1)!.ult).toBeGreaterThan(10);
  });
});

describe('bots answering pings', () => {
  it('sends the two nearest bots to an attack call, and they say they are coming', () => {
    const { sim, pings, god, run } = world();
    const comms = new BotComms(sim);
    const me = god('zeus', 'order', 0, 20);
    const near = god('thor', 'order', 5, 10, true);
    const mid = god('odin', 'order', -5, 25, true);
    const far = god('anubis', 'order', 0, 70, true);
    const foe = god('loki', 'chaos', 0, -10, true);
    foe.combatant.health = foe.combatant.stats.maxHealth;
    sim.ping(me, 'attack', 0, -10, foe);
    expect(orderOf(near)).toMatchObject({ kind: 'come', subject: foe });
    expect(orderOf(mid)).toMatchObject({ kind: 'come', subject: foe });
    expect(orderOf(far)).toBeNull();
    run(2.5, comms);
    const replies = pings.filter((p) => p.kind === 'omw');
    expect(replies.map((p) => p.unit).sort((a, b) => a.id - b.id)).toEqual([near, mid].sort((a, b) => a.id - b.id));
    // and they go: both close on the enemy they were called to
    expect(Math.hypot(near.x - foe.x, near.z - foe.z)).toBeLessThan(12);
    // the bots' own replies are never answered
    expect(orderOf(far)).toBeNull();
  });

  it('pulls bots near a "fall back" mark away from it', () => {
    const { sim, god, run } = world();
    const comms = new BotComms(sim);
    const me = god('zeus', 'order', 0, 30);
    const bot = god('thor', 'order', 0, 0, true);
    const away = god('odin', 'order', 60, 60, true);
    sim.ping(me, 'back', 0, -6);
    expect(orderOf(bot)).toMatchObject({ kind: 'back' });
    expect(orderOf(away)).toBeNull();
    const z = bot.z;
    run(2, comms);
    // home is toward +z for order
    expect(bot.z).toBeGreaterThan(z + 6);
  });

  it('lets a hurt bot sit out a call to fight', () => {
    const { sim, god } = world();
    new BotComms(sim);
    const me = god('zeus', 'order', 0, 0);
    const hurt = god('thor', 'order', 4, 0, true);
    hurt.combatant.health = hurt.combatant.stats.maxHealth * 0.2;
    sim.ping(me, 'help', 0, 0);
    expect(orderOf(hurt)).toBeNull();
  });
});
