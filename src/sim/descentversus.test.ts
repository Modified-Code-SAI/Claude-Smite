import { describe, expect, it } from 'vitest';
import type { Side } from '../game/combatant';
import { GODS, loki, odin, thor, zeus } from '../game/gods';
import { addUnderworldColliders } from '../map/UnderworldLayout';
import { descentRoster } from '../net/descentRoster';
import type { NetPlayer } from '../net/roster';
import { CollisionWorld } from '../scene/Collision';
import { Descent, DESCENT, SOULS } from './Descent';
import { DescentBot } from './DescentBot';
import { godUnit } from './factory';
import { Sim, type SimTerrain } from './Sim';
import type { Unit } from './Unit';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };
const BASES = { order: { x: 0, z: 900, radius: 1 }, chaos: { x: 0, z: -900, radius: 1 } };

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shared descent: Order's gods, then Chaos's; the first god of each team is a human. */
function setup(order = [zeus, thor, odin], chaos = [loki, zeus, thor], seed = 7) {
  const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(seed));
  const run = new Descent(sim, zeus, undefined, true);
  const add = (team: Side, defs: typeof order) =>
    defs.map((def, i) => {
      const u = sim.add(godUnit(def, team, { x: 0, z: 0, yaw: 0 }));
      run.addGod(u, i === 0);
      return u;
    });
  const a = add('order', order);
  const b = add('chaos', chaos);
  run.begin();
  return { sim, run, a, b };
}

const step = (sim: Sim, run: Descent, seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    run.step(1 / 30);
    sim.step(1 / 30);
  }
};

const fight = (sim: Sim, run: Descent) => step(sim, run, DESCENT.enterTime + 0.1);

/** Kills every monster in the chamber with `by`'s blows and lets the run notice. */
const clear = (sim: Sim, run: Descent, by: Unit) => {
  for (let guard = 0; guard < 20 && run.phase === 'fight'; guard++) {
    for (const m of [...run.monsters]) if (m.alive) sim.strike(by, m, 1e7, 'true');
    step(sim, run, 0.2);
  }
};

const typeOf = (m: Unit) => (m.origin?.f === 'mode' ? (m.origin.data as { type: keyof typeof SOULS }).type : 'thornback');

describe('shared descent (team versus)', () => {
  it('splits a lobby into two teams of up to three, each filling with bots only if it wants them', () => {
    const p = (id: string, god: string, team: Side): NetPlayer => ({ id, name: id, god, team });
    const lobby = [p('a', 'zeus', 'order'), p('b', 'thor', 'chaos'), p('c', 'odin', 'chaos')];
    const both = descentRoster(lobby, undefined, { versus: true });
    expect(both.map((s) => s.team)).toEqual(['order', 'order', 'order', 'chaos', 'chaos', 'chaos']);
    expect(both.filter((s) => s.player).map((s) => s.player)).toEqual(['a', 'b', 'c']);
    // Order goes without bots: one human against a full team of three
    const alone = descentRoster(lobby, undefined, { versus: true, bots: { order: false } });
    expect(alone.filter((s) => s.team === 'order')).toHaveLength(1);
    expect(alone.filter((s) => s.team === 'chaos')).toHaveLength(3);
    // and nobody's bots: one against two
    expect(descentRoster(lobby, undefined, { versus: true, bots: { order: false, chaos: false } })).toHaveLength(3);
    // a team with no humans is always three bots
    const solo = descentRoster([p('a', 'zeus', 'order')], undefined, { versus: true, bots: { chaos: false } });
    expect(solo.filter((s) => s.team === 'chaos' && !s.player)).toHaveLength(3);
    // four on one side: the fourth crosses over
    const crowd = [p('a', 'zeus', 'order'), p('b', 'thor', 'order'), p('c', 'odin', 'order'), p('d', 'loki', 'order')];
    expect(descentRoster(crowd, undefined, { versus: true }).find((s) => s.player === 'd')!.team).toBe('chaos');
    // bots take gods nobody on their team picked; the same on every end
    for (const s of both.filter((x) => !x.player)) expect(both.filter((x) => x.team === s.team && x.player).map((x) => x.god)).not.toContain(s.god);
    expect(descentRoster(lobby, undefined, { versus: true })).toEqual(both);
    // co-op can go without bots too
    expect(descentRoster([p('a', 'zeus', 'order')], undefined, { bots: { order: false } })).toHaveLength(1);
  });

  it('puts the teams either side of the gate and pays souls to the team that lands each kill', () => {
    const { sim, run, a, b } = setup();
    const c = run.layout;
    for (const g of a) expect(g.x).toBeLessThan(c.x);
    for (const g of b) expect(g.x).toBeGreaterThan(c.x);
    fight(sim, run);
    const [m1, m2] = run.monsters;
    sim.strike(a[0]!, m1!, 1e7, 'true');
    sim.strike(b[1]!, m2!, 1e7, 'true');
    step(sim, run, 0.1);
    expect(run.souls.order).toBe(SOULS[typeOf(m1!)]);
    expect(run.souls.chaos).toBe(SOULS[typeOf(m2!)]);
    expect(run.teamKills).toEqual({ order: 1, chaos: 1 });
    expect(run.kills).toBe(2);
  });

  it('downs a rival for souls; the fallen rise at the gate on their own, and only their own team can raise them sooner', () => {
    const { sim, run, a, b } = setup();
    fight(sim, run);
    const victim = b[0]!;
    sim.strike(a[0]!, victim, 1e7, 'true');
    step(sim, run, 0.1);
    expect(run.downed.has(victim)).toBe(true);
    expect(run.souls.order).toBe(DESCENT.versus.god);
    // a rival standing over it does nothing
    a[1]!.body.x = victim.x;
    a[1]!.body.z = victim.z;
    for (const g of [...a.slice(2), ...b.slice(1)]) {
      g.body.x = victim.x + 30;
      g.body.z = victim.z;
    }
    step(sim, run, DESCENT.revive.time + 0.5);
    expect(run.downed.has(victim)).toBe(true);
    // and the timer brings it back at its team's side of the gate
    step(sim, run, DESCENT.versus.bleed);
    expect(victim.alive).toBe(true);
    expect(run.downed.has(victim)).toBe(false);
    const gate = run.gateOf(victim);
    expect(Math.hypot(victim.x - gate.x, victim.z - gate.z)).toBeLessThan(4);
    expect(victim.combatant.health / victim.combatant.stats.maxHealth).toBeCloseTo(DESCENT.versus.bleedHealth, 1);

    // an ally standing over a fallen god raises it
    const second = b[1]!;
    sim.strike(a[0]!, second, 1e7, 'true');
    step(sim, run, 0.1);
    victim.body.x = second.x;
    victim.body.z = second.z;
    step(sim, run, DESCENT.revive.time + 0.5);
    expect(second.alive).toBe(true);
  });

  it('pays the rivals for a rout and never ends the run on a wipe', () => {
    const { sim, run, a, b } = setup();
    fight(sim, run);
    for (const g of b) sim.strike(a[0]!, g, 1e7, 'true');
    step(sim, run, 0.1);
    expect(run.routs.chaos).toBe(1);
    expect(run.souls.order).toBe(DESCENT.versus.god * 3 + DESCENT.versus.rout * 3);
    // both teams down at once: still not lost
    for (const g of a) sim.strike(b[0]!, g, 1e7, 'true');
    step(sim, run, 0.1);
    expect(run.phase).not.toBe('lost');
    step(sim, run, DESCENT.versus.bleed + 1);
    expect([...a, ...b].every((g) => g.alive)).toBe(true);
  });

  it('gives each team its own pick from the same three cards, and the Gilded prize only to its catcher', () => {
    const { sim, run, a, b } = setup();
    fight(sim, run);
    clear(sim, run, a[0]!);
    expect(run.phase).toBe('reward');
    expect(run.offerTeams).toEqual(['order', 'chaos']);
    const offer = run.offer!;
    expect(offer.some((r) => r.kind === 'obol')).toBe(false);
    const boon = offer.findIndex((r) => r.kind === 'boon');
    const other = offer.findIndex((r, i) => i !== boon && r.kind !== 'skill');
    expect(boon).toBeGreaterThanOrEqual(0);
    expect(run.vote(a[0]!, boon)).toBe(true);
    // Chaos's vote is its own
    run.vote(b[0]!, other >= 0 ? other : (boon + 1) % 3);
    expect(run.tally('order')[boon]).toBe(1);
    step(sim, run, 0.1);
    expect(run.boonTeam).toEqual(['order', ...(offer[other >= 0 ? other : (boon + 1) % 3]!.kind === 'boon' ? ['chaos'] : [])]);
    const stat = Object.keys(offer[boon]!.boon!.stats ?? {})[0] as keyof (typeof a)[0]['combatant']['stats'];
    if (stat && offer[other >= 0 ? other : (boon + 1) % 3]!.kind !== 'boon') {
      // the boon lifts Order's gods only
      expect(a[1]!.combatant.stats[stat]).not.toBe(b[1]!.combatant.stats[stat]);
    }

    // a bonus reward for one team is offered to that team alone
    run.bonus.chaos = 1;
    for (let guard = 0; guard < 20 && run.phase === 'draft'; guard++) {
      for (const h of run.humans) run.draft(h, 0);
      step(sim, run, 0.1);
    }
    if (run.phase === 'reward') {
      expect(run.offerTeams).toEqual(['chaos']);
      expect(run.vote(a[0]!, 0)).toBe(false);
      expect(run.vote(b[0]!, 0)).toBe(true);
    }
  });

  it('makes the smaller team hit harder and count its souls per head', () => {
    const { sim, run, a, b } = setup([zeus], [loki, zeus, thor]);
    expect(run.short('order')).toBe(2);
    expect(run.short('chaos')).toBe(0);
    expect(run.soulRate('order')).toBe(3);
    expect(a[0]!.combatant.stats.damageBonus).toBeCloseTo(b[1]!.combatant.stats.damageBonus + DESCENT.versus.underdog.damage * 2, 5);
    fight(sim, run);
    const m = run.monsters[0]!;
    sim.strike(a[0]!, m, 1e7, 'true');
    step(sim, run, 0.1);
    expect(run.souls.order).toBe(SOULS[typeOf(m)] * 3);
  });

  it('runs a whole bot descent to the bottom and names the team with the most souls', () => {
    const rng = seeded(9);
    const world = new CollisionWorld(() => 0);
    addUnderworldColliders(world);
    const sim = new Sim(world, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, rng);
    const run = new Descent(sim, zeus, undefined, true);
    for (const [team, defs] of [['order', GODS.slice(0, 3)], ['chaos', GODS.slice(2, 5)]] as const) {
      for (const def of defs) {
        const u = sim.add(godUnit(def, team, { x: 0, z: 0, yaw: 0 }));
        u.brain = new DescentBot(sim, u, run);
        run.addGod(u, false);
      }
    }
    run.begin();
    for (let t = 0; t < 45 * 60 && !run.over; t += 1 / 30) {
      run.step(1 / 30);
      sim.step(1 / 30);
      sim.drainEvents();
    }
    expect(run.phase).toBe('won');
    expect(run.cleared).toBe(DESCENT.chambers);
    expect(run.souls.order + run.souls.chaos).toBeGreaterThan(200);
    const leader = run.souls.order > run.souls.chaos ? 'order' : 'chaos';
    expect(run.winner === leader || run.winner === 'draw').toBe(true);
  }, 60000);
});
