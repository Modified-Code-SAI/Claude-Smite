import { describe, expect, it } from 'vitest';
import { anubis, loki, odin, thor, zeus } from '../game/gods';
import type { GodDef } from '../game/types';
import { XP_TABLE } from '../game/progression';
import { godUnit } from './factory';
import { Nav } from './Nav';
import { Rush, RUSH } from './Rush';
import { RushBot, RushCoach } from './RushBot';
import { rushTestField } from './rushTestField';
import { Sim, type SimTerrain } from './Sim';
import type { Unit } from './Unit';
import { rushRoster } from '../net/rushRoster';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };

function match(terrain: SimTerrain = flat, rng: () => number = () => 0.5) {
  const sim = new Sim(terrain, { order: { ...RUSH.bases.order }, chaos: { ...RUSH.bases.chaos } }, rng);
  const rush = new Rush(sim);
  return { sim, rush };
}

function god(sim: Sim, def: GodDef, team: 'order' | 'chaos', i: number): Unit {
  const u = sim.add(godUnit(def, team, RUSH.homes[team][i]!));
  u.combatant.gainXp(XP_TABLE[RUSH.startLevel - 1]!);
  return u;
}

/** Steps the mode and the sim together at 60 Hz. */
function run(sim: Sim, rush: Rush, seconds: number, until?: () => boolean): void {
  for (let i = 0; i < seconds * 60 && !until?.(); i++) {
    rush.step(1 / 60);
    sim.step(1 / 60);
    sim.drainEvents();
  }
}

describe('Relic Rush', () => {
  it('holds the kickoff, then the first god to reach the center takes the relic', () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const b = god(sim, thor, 'chaos', 0);
    rush.begin([a, b]);
    expect(rush.phase).toBe('kickoff');
    expect(a.x).toBeCloseTo(RUSH.kickoff.order[0]!.x);
    a.move = { x: 0, z: -1 };
    run(sim, rush, 1);
    // nobody leaves their mark during the countdown
    expect(a.z).toBeCloseTo(RUSH.kickoff.order[0]!.z, 0);
    run(sim, rush, RUSH.countdown);
    expect(rush.phase).toBe('play');
    sim.teleport(a, 0, 1.6);
    run(sim, rush, 0.1);
    expect(rush.holder).toBe(a);
    // carrying: slower, and no attacks or casts
    expect(a.combatant.moveSpeed).toBeLessThan(b.combatant.moveSpeed * 1.2);
    expect(sim.cast(a, 0)).toBe('cc');
    expect(sim.basic(a)).toBe(false);
  });

  it('a pass flies to where it was aimed and a teammate catches it', () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const b = god(sim, odin, 'order', 1);
    const c = god(sim, thor, 'chaos', 0);
    rush.begin([a, b, c]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(a, 0, 1.6);
    sim.teleport(b, 10, 1.6);
    sim.teleport(c, -20, 20);
    run(sim, rush, 0.5);
    expect(rush.holder).toBe(a);
    expect(rush.throwRelic(a, { x: 10, z: 1.6 })).toBe(true);
    expect(rush.relic.phase).toBe('flying');
    run(sim, rush, 2, () => rush.holder !== null);
    expect(rush.holder).toBe(b);
    expect(rush.lines.get(a)!.passes).toBe(1);
  });

  it('a stun knocks the relic loose, and the tackler is credited', () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const t = god(sim, thor, 'chaos', 0);
    rush.begin([a, t]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(a, 0, 1.6);
    run(sim, rush, 0.2);
    expect(rush.holder).toBe(a);
    sim.teleport(t, 0, 3.6, 0);
    t.aim.x = a.x;
    t.aim.z = a.z;
    // Mjolnir Slam stuns in a cone in front of Thor
    const slot = t.combatant.loadout.indexOf('thor.mjolnir-slam');
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(sim.cast(t, slot)).toBeNull();
    run(sim, rush, 0.05);
    expect(rush.holder).toBeNull();
    expect(rush.relic.phase).toBe('flying');
    expect(rush.lines.get(t)!.tackles).toBe(1);
    // and the fumbler can't grab it straight back
    run(sim, rush, 0.4);
    expect(rush.holder).not.toBe(a);
  });

  it('a daze is short, drops the relic, and stands the god up at their gate', () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const t = god(sim, thor, 'chaos', 0);
    rush.begin([a, t]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(a, 0, 1.6);
    run(sim, rush, 0.2);
    sim.strike(t, a, 1e6, 'true');
    run(sim, rush, 0.05);
    expect(a.alive).toBe(false);
    expect(rush.holder).toBeNull();
    run(sim, rush, RUSH.daze + 0.2);
    expect(a.alive).toBe(true);
    expect(Math.hypot(a.x - RUSH.homes.order[0]!.x, a.z - RUSH.homes.order[0]!.z)).toBeLessThan(0.5);
  });

  it('carrying the relic through the enemy gate scores, then a kickoff resets everyone', () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const b = god(sim, odin, 'order', 1);
    const t = god(sim, thor, 'chaos', 0);
    rush.begin([a, b, t]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(b, 0, 1.6);
    run(sim, rush, 0.4);
    expect(rush.throwRelic(b, { x: 0, z: -12 })).toBe(true);
    sim.teleport(a, 0, -12);
    run(sim, rush, 2, () => rush.holder !== null);
    expect(rush.holder).toBe(a);
    // order attacks the north gate (chaos defends it)
    sim.teleport(a, 0, RUSH.gates.chaos.z);
    run(sim, rush, 0.05);
    expect(rush.score.order).toBe(1);
    expect(rush.lastGoal?.scorer).toBe(a);
    expect(rush.lastGoal?.assist).toBe(b);
    expect(rush.lines.get(b)!.assists).toBe(1);
    expect(rush.phase).toBe('goal');
    run(sim, rush, RUSH.celebrate + 0.1);
    expect(rush.phase).toBe('kickoff');
    expect(rush.relic.phase).toBe('center');
    expect(a.z).toBeCloseTo(RUSH.kickoff.order[0]!.z, 1);
  });

  it('a low throw through the gate scores; a lob over it does not', () => {
    const { sim, rush } = match();
    const a = god(sim, loki, 'order', 0);
    rush.begin([a]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(a, 0, -14);
    rush.relic.phase = 'loose';
    rush.relic.x = 0;
    rush.relic.z = -14;
    run(sim, rush, 0.4);
    expect(rush.holder).toBe(a);
    rush.throwRelic(a, { x: 0, z: RUSH.gates.chaos.z });
    run(sim, rush, 2, () => rush.phase !== 'play');
    expect(rush.score.order).toBe(1);
    expect(rush.lastGoal?.kind).toBe('shot');
  });

  it('first to five wins; a tie at the end of the clock goes to golden-relic overtime', () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const t = god(sim, thor, 'chaos', 0);
    rush.begin([a, t]);
    run(sim, rush, RUSH.countdown + 0.1);
    rush.clock = 0.05;
    run(sim, rush, 0.1);
    expect(rush.overtime).toBe(true);
    expect(rush.phase).toBe('kickoff');
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(t, 0, -1.6);
    run(sim, rush, 0.2);
    sim.teleport(t, 0, RUSH.gates.order.z);
    run(sim, rush, 0.05);
    expect(rush.winner).toBe('chaos');
    expect(rush.phase).toBe('over');
  });

  it('bot teams play a full match on the plaza: goals, passes and tackles', () => {
    const terrain = rushTestField();
    let seed = 7;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const { sim, rush } = match(terrain, rng);
    const nav = new Nav({ groundAt: (x, z) => terrain.groundAt(x, z), resolve: (x, z, r, y) => sim.solid(x, z, r, y) }, RUSH.pitchRadius + 2);
    const coach = new RushCoach(sim, rush);
    const gods: Unit[] = [];
    const teams = { order: [zeus, thor, odin], chaos: [loki, anubis, zeus] };
    for (const side of ['order', 'chaos'] as const) {
      teams[side].forEach((d, i) => {
        const u = god(sim, d, side, i);
        u.brain = new RushBot(sim, u, rush, coach, nav);
        gods.push(u);
      });
    }
    rush.begin(gods);
    run(sim, rush, RUSH.clock + 60, () => rush.phase === 'over');
    const total = (k: 'goals' | 'passes' | 'tackles' | 'steals') => [...rush.lines.values()].reduce((s, l) => s + l[k], 0);
    expect(total('goals')).toBeGreaterThan(0);
    expect(total('passes')).toBeGreaterThan(0);
    expect(total('tackles')).toBeGreaterThan(0);
    expect(rush.score.order + rush.score.chaos).toBe(total('goals'));
  });
  it('a guest copy takes the whole match from the host state, gods by their place in the line-up', () => {
    const terrain = rushTestField();
    let seed = 11;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const host = match(terrain, rng);
    const guest = match(terrain);
    const nav = new Nav({ groundAt: (x, z) => terrain.groundAt(x, z), resolve: (x, z, r, y) => host.sim.solid(x, z, r, y) }, RUSH.pitchRadius + 2);
    const coach = new RushCoach(host.sim, host.rush);
    const defs = [zeus, thor, odin, loki, anubis, zeus];
    const hostGods = defs.map((d, i) => god(host.sim, d, i < 3 ? 'order' : 'chaos', i % 3));
    const guestGods = defs.map((d, i) => god(guest.sim, d, i < 3 ? 'order' : 'chaos', i % 3));
    for (const u of hostGods) u.brain = new RushBot(host.sim, u, host.rush, coach, nav);
    host.rush.begin(hostGods);
    guest.rush.join(guestGods);
    // play until something worth copying happened: a goal, and the relic in someone's hands
    run(host.sim, host.rush, RUSH.clock, () => host.rush.goalCount > 0 && host.rush.holder !== null);
    expect(host.rush.goalCount).toBeGreaterThan(0);
    guest.rush.applyNet(JSON.parse(JSON.stringify(host.rush.netState())));
    const g = guest.rush;
    const h = host.rush;
    expect(g.score).toEqual(h.score);
    expect(g.phase).toBe(h.phase);
    expect(g.clock).toBeCloseTo(h.clock, 1);
    expect(g.relic.phase).toBe(h.relic.phase);
    expect(g.holder).toBe(guestGods[hostGods.indexOf(h.holder!)]);
    expect(g.lastGoal?.scorer).toBe(guestGods[hostGods.indexOf(h.lastGoal!.scorer)]);
    hostGods.forEach((u, i) => expect(g.lines.get(guestGods[i]!)).toEqual(h.lines.get(u)));
    // between snapshots a guest's thrown relic keeps flying on its own
    Object.assign(g.relic, { phase: 'flying', holder: null, fx: 0, fz: 0, tx: 10, tz: 0, t: 0, duration: 1, arc: 2, h0: 3 });
    g.follow(0.5);
    expect(g.relic.x).toBeCloseTo(5);
    expect(g.relic.h).toBeCloseTo(Rush.flightHeight(g.relic, 0.5));
  });

  it('lobby roster: humans take the middle first, bots fill the rest, the same on every end', () => {
    const p = (id: string, team: 'order' | 'chaos', god = 'zeus') => ({ id, name: id, god, team });
    const solo = rushRoster([p('me', 'order', 'thor')]);
    expect(solo).toHaveLength(6);
    expect(solo.find((s) => s.player === 'me')).toMatchObject({ team: 'order', spot: 1, god: 'thor' });
    // the player's teammates play other gods
    expect(solo.filter((s) => s.team === 'order' && !s.player).map((s) => s.god)).not.toContain('thor');
    expect(new Set(solo.filter((s) => s.team === 'order').map((s) => s.god)).size).toBe(3);
    // too many humans on one side: the extra one plays for the other team
    const lobby = [p('a', 'order'), p('b', 'order', 'thor'), p('c', 'order', 'odin'), p('d', 'order', 'loki')];
    const slots = rushRoster(lobby);
    expect(slots.filter((s) => s.player).length).toBe(4);
    expect(slots.find((s) => s.player === 'd')?.team).toBe('chaos');
    expect(rushRoster(lobby)).toEqual(slots);
  });
});

describe('Relic Rush: the Playmaker tree', () => {
  /** Max level and Favor, then the named sport nodes learned in order (a bare name takes every rank). */
  function learn(u: Unit, ...ids: string[]): void {
    const c = u.combatant;
    c.gainXp(XP_TABLE[XP_TABLE.length - 1]!);
    c.gainFavor(1e6);
    for (const id of ids) {
      const n = c.trees.node.get(`sport.${id}`)!.node;
      for (let r = 0; r < n.maxRank; r++) expect(c.allocate(n.id), n.id).toBeNull();
    }
  }
  const TIER_ONE = ['stride', 'arm', 'hands'];
  const TIER_TWO = ['bearer', 'rise', 'strip'];

  /** Two gods, order's `a` holding the relic at the center. */
  function carrying(def: GodDef = zeus) {
    const { sim, rush } = match();
    const a = god(sim, def, 'order', 0);
    const t = god(sim, thor, 'chaos', 0);
    rush.begin([a, t]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(a, 0, 1.6);
    sim.teleport(t, -20, 20);
    run(sim, rush, 0.3);
    expect(rush.holder).toBe(a);
    return { sim, rush, a, t };
  }

  /** Thor slams the carrier from 2 m north of them. */
  function slam(sim: Sim, rush: Rush, t: Unit, a: Unit): void {
    sim.teleport(t, a.x, a.z + 2, 0);
    t.aim.x = a.x;
    t.aim.z = a.z;
    t.combatant.mana = t.combatant.stats.maxMana;
    expect(sim.cast(t, t.combatant.loadout.indexOf('thor.mjolnir-slam'))).toBeNull();
    run(sim, rush, 0.05);
  }

  it('opens as a fourth tree for every god in the match, and only there', () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    expect(a.combatant.treeList).toHaveLength(3);
    expect(a.combatant.allocate('sport.arm')).toBe('unknownNode');
    rush.begin([a]);
    expect(a.combatant.treeList.map((t) => t.id)).toEqual([...zeus.trees.map((t) => t.id), 'sport']);
    expect(a.combatant.allocate('sport.arm')).toBeNull();
    expect(a.combatant.sport('throwRange')).toBe(1.5);
  });

  it('Long Arm throws farther and Bullet Pass flies faster', () => {
    const { sim, rush, a } = carrying();
    const far = { x: 0, z: -40 };
    const plain = rush.throwTarget(a, far);
    expect(Math.hypot(plain.x - a.x, plain.z - a.z)).toBeCloseTo(RUSH.relic.maxThrow);
    learn(a, ...TIER_ONE, ...TIER_TWO, 'bullet');
    const long = rush.throwTarget(a, far);
    const d = Math.hypot(long.x - a.x, long.z - a.z);
    expect(d).toBeCloseTo(RUSH.relic.maxThrow + 4.5);
    run(sim, rush, 0.3);
    expect(rush.throwRelic(a, far)).toBe(true);
    expect(rush.relic.duration).toBeCloseTo(Rush.flightTime(d, 0.3));
    expect(rush.relic.duration).toBeLessThan(Rush.flightTime(d));
  });

  it("Bearer's Stride halves the carrier's slow, and Quick to Rise stands up sooner", () => {
    const { sim, rush, a, t } = carrying();
    const slowed = a.combatant.moveSpeed;
    learn(a, ...TIER_ONE, 'bearer', 'rise');
    run(sim, rush, 0.4);
    const free = a.combatant.moveSpeed;
    // Fleet Foot's +9% and half the carrier's slow
    expect(free / slowed).toBeCloseTo((1 + 0.09 - RUSH.carrierSlow / 2) / (1 - RUSH.carrierSlow), 2);
    sim.strike(t, a, 1e6, 'true');
    run(sim, rush, 0.05);
    expect(a.alive).toBe(false);
    expect(a.combatant.respawnTimer).toBeCloseTo(RUSH.daze - 1, 1);
  });

  it('Strip Tackle pops a knocked-loose relic toward the tackler', () => {
    const plain = carrying();
    slam(plain.sim, plain.rush, plain.t, plain.a);
    // away from Thor (north of the carrier): it lands south
    expect(plain.rush.relic.tz).toBeLessThan(plain.a.z);
    const { sim, rush, a, t } = carrying();
    learn(t, ...TIER_ONE, 'strip');
    slam(sim, rush, t, a);
    expect(rush.relic.phase).toBe('flying');
    expect(rush.relic.tz).toBeGreaterThan(a.z);
    expect(Math.hypot(rush.relic.tx - t.x, rush.relic.tz - t.z)).toBeLessThan(Math.hypot(a.x - t.x, a.z - t.z));
    run(sim, rush, 1, () => rush.holder !== null);
    expect(rush.holder).toBe(t);
    expect(rush.lines.get(t)!.steals).toBe(1);
  });

  it('Bulldozer knocks gods farther, and Iron Footing holds them', () => {
    const shove = (push: boolean, footing: boolean): number => {
      const { sim, rush } = match();
      const o = god(sim, odin, 'order', 0);
      const v = god(sim, zeus, 'chaos', 0);
      rush.begin([o, v]);
      run(sim, rush, RUSH.countdown + 0.1);
      if (push) learn(o, ...TIER_ONE, ...TIER_TWO, 'shove');
      if (footing) learn(v, ...TIER_ONE, ...TIER_TWO, 'footing');
      sim.teleport(o, 0, 0, Math.PI);
      sim.teleport(v, 0, -2.5);
      o.aim.x = 0;
      o.aim.z = -2.5;
      const loadout = [...o.combatant.loadout];
      loadout[0] = 'odin.gungnir-sweep';
      o.combatant.setBuild(loadout, o.combatant.allocation);
      o.combatant.mana = o.combatant.stats.maxMana;
      expect(sim.cast(o, 0)).toBeNull();
      run(sim, rush, 1.2);
      return Math.hypot(v.x, v.z + 2.5);
    };
    const base = shove(false, false);
    expect(base).toBeGreaterThan(RUSH.knockback * 0.8);
    expect(shove(true, false) / base).toBeCloseTo(1.36, 1);
    expect(shove(false, true) / base).toBeCloseTo(0.64, 1);
  });

  it('a Captain shrugs off the first hit each time they take the relic, and their passes speed the catcher up', () => {
    const { sim, rush, a, t } = carrying();
    const b = god(sim, odin, 'order', 1);
    rush.join([b]);
    learn(a, ...TIER_ONE, ...TIER_TWO, 'bullet', 'shove', 'footing', 'captain');
    expect(a.combatant.sport('captain')).toBe(1);
    slam(sim, rush, t, a);
    expect(rush.holder).toBe(a);
    expect(rush.beats.shrug).toBe(1);
    expect(rush.lastBeat).toMatchObject({ kind: 'shrug', unit: a, by: t });
    // still holding once the stun wears off; the next hit takes it
    run(sim, rush, 1.5);
    expect(rush.holder).toBe(a);
    const t2 = god(sim, thor, 'chaos', 1);
    rush.join([t2]);
    slam(sim, rush, t2, a);
    expect(rush.holder).toBeNull();
    // a fresh possession, a pass: the catcher runs faster
    run(sim, rush, 2, () => rush.holder !== null);
    sim.teleport(t, -20, 20);
    sim.teleport(t2, 20, 20);
    sim.teleport(a, 0, 1.6);
    sim.teleport(b, 10, 1.6);
    run(sim, rush, 1, () => rush.holder === a);
    if (rush.holder !== a) {
      // the relic landed somewhere else: hand it over
      sim.teleport(a, rush.relic.x, rush.relic.z);
      run(sim, rush, 1, () => rush.holder === a);
    }
    expect(rush.holder).toBe(a);
    run(sim, rush, 0.3);
    const before = b.combatant.moveSpeed;
    expect(rush.throwRelic(a, { x: b.x, z: b.z })).toBe(true);
    run(sim, rush, 2, () => rush.holder !== null);
    expect(rush.holder).toBe(b);
    expect(b.combatant.moveSpeed / before).toBeGreaterThan(1.2);
  });
});
