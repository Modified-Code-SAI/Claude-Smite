import { describe, expect, it } from 'vitest';
import { thor, zeus } from '../game/gods';
import { Descent, DESCENT, RELIC_CHANCE } from './Descent';
import { godUnit } from './factory';
import { RELIC, RELICS } from './Relics';
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

function setup(gods = [zeus, thor], seed = 7) {
  const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(seed));
  const run = new Descent(sim, zeus);
  const team = gods.map((def, i) => {
    const u = sim.add(godUnit(def, 'order', { x: 0, z: 0, yaw: 0 }));
    run.addGod(u, i === 0);
    return u;
  });
  run.begin();
  return { sim, run, team };
}

const step = (sim: Sim, run: Descent, seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    run.step(1 / 30);
    sim.step(1 / 30);
  }
};

/** Into the chamber's fight, its first monsters risen and held still (no brains), far from the gods. */
function fight(sim: Sim, run: Descent) {
  step(sim, run, DESCENT.enterTime + 1.2);
  for (const m of run.monsters) {
    m.brain = null;
    m.move = null;
  }
  // the gods stand well off, out of every monster's reach
  for (const g of run.gods) sim.teleport(g, 200, 200);
  const [a, b, c] = run.monsters as [Unit, Unit, Unit];
  return { a, b, c };
}

const lost = (m: Unit) => m.combatant.stats.maxHealth - m.combatant.health;

describe('Underworld relics', () => {
  it('offers a relic after a boss, never one the team already holds, and a team of bots takes it', () => {
    const { sim, run, team } = setup();
    expect(RELIC_CHANCE.boss).toBe(1);
    // straight to the first boss
    (run as unknown as { chamber: number }).chamber = 4;
    (run as unknown as { nextChamber(): void }).nextChamber();
    for (const r of RELICS.slice(1)) run.relics.take(r.id, 'order');
    step(sim, run, DESCENT.enterTime + 0.1);
    for (let i = 0; i < 20 && run.phase === 'fight'; i++) {
      for (const m of [...run.monsters]) if (m.alive) sim.strike(team[0]!, m, 1e7, 'true');
      step(sim, run, 0.2);
    }
    expect(run.phase).toBe('reward');
    const card = run.offer!.find((c) => c.kind === 'relic');
    // the only relic left to find
    expect(card?.relic?.id).toBe(RELICS[0]!.id);
    run.vote(team[0]!, run.offer!.indexOf(card!));
    step(sim, run, 0.2);
    expect(run.relics.has('order', RELICS[0]!.id)).toBe(true);
    expect(run.relics.open(['order'])).toEqual([]);
  });

  it('Death Knell: a slain monster bursts a beat later, burning the monsters beside it and none far off', () => {
    const { sim, run, team } = setup();
    run.relics.take('knell', 'order');
    const { a, b, c } = fight(sim, run);
    sim.teleport(b, a.x + 1.5, a.z);
    sim.teleport(c, a.x + 30, a.z);
    const share = a.combatant.stats.maxHealth * RELIC.knell.share;
    sim.strike(team[0]!, a, 1e7, 'true');
    expect(lost(b)).toBe(0);
    step(sim, run, RELIC.knell.delay + 0.1);
    // true damage, through the burst's god's bonus and the monster's own reduction like any hit
    const dealt = share * (1 + team[0]!.combatant.stats.damageBonus) * (1 - b.combatant.stats.damageReduction);
    expect(lost(b)).toBeGreaterThan(dealt * 0.95);
    expect(lost(c)).toBe(0);
    expect(run.relics.procs.some((p) => p.k === 'knell')).toBe(true);
  });

  it('Chain of Souls: every third basic hit leaps on to the two nearest monsters', () => {
    const { sim, run, team } = setup();
    run.relics.take('chain', 'order');
    const { a } = fight(sim, run);
    const g = team[0]!;
    const others = run.monsters.filter((m) => m !== a);
    others.forEach((m, i) => sim.teleport(m, a.x + 2 + i * 2.5, a.z));
    const basic = () => sim.inject({ type: 'damage', target: a, source: g, amount: 10, crit: false, ability: false });
    basic();
    basic();
    expect(others.every((m) => lost(m) === 0)).toBe(true);
    basic();
    const hit = others.filter((m) => lost(m) > 0);
    expect(hit.length).toBe(Math.min(RELIC.chain.leaps, others.filter((m) => Math.hypot(m.x - a.x, m.z - a.z) - m.radius <= RELIC.chain.range).length));
    // the nearest ones
    expect(hit).toContain(others[0]);
    expect(run.relics.procs.filter((p) => p.k === 'chain').length).toBe(hit.length);
    // a skill's hit never counts toward it
    for (let i = 0; i < 3; i++) sim.inject({ type: 'damage', target: a, source: g, amount: 10, crit: false, ability: true });
    expect(run.relics.procs.filter((p) => p.k === 'chain').length).toBe(hit.length);
  });

  it('Echoing Rite: a monster slain by a skill gives the slayer cooldowns back', () => {
    const { sim, run, team } = setup();
    run.relics.take('echo', 'order');
    const { a } = fight(sim, run);
    const g = team[0]!;
    const c = g.combatant;
    const id = c.loadout[0]!;
    (c as unknown as { cooldowns: Map<string, number> }).cooldowns.set(id, 8);
    sim.strike(g, a, 1e7, 'true');
    expect(c.cooldownOf(0)).toBeCloseTo(8 - RELIC.echo.cut, 1);
  });

  it('Bone Aegis: a skill cast shields its caster, at most once in a short while', () => {
    const { sim, run, team } = setup();
    run.relics.take('aegis', 'order');
    fight(sim, run);
    const g = team[0]!;
    const cast = () => sim.inject({ type: 'cast', unit: g, cast: {} as never, x: g.x, z: g.z });
    cast();
    const shield = g.combatant.stats.maxHealth * RELIC.aegis.share;
    expect(g.combatant.shieldTotal).toBeCloseTo(shield, 0);
    cast();
    expect(g.combatant.shieldTotal).toBeCloseTo(shield, 0);
    step(sim, run, RELIC.aegis.every + 0.1);
    cast();
    expect(g.combatant.shieldTotal).toBeGreaterThan(shield * 1.5);
  });

  it('Grave Harvest: each kill heals the gods near it, not those far off', () => {
    const { sim, run, team } = setup();
    run.relics.take('harvest', 'order');
    const { a } = fight(sim, run);
    const [near, far] = team as [Unit, Unit];
    sim.teleport(near, a.x + 3, a.z);
    sim.teleport(far, a.x + 40, a.z);
    for (const g of team) g.combatant.health = g.combatant.stats.maxHealth * 0.5;
    sim.strike(near, a, 1e7, 'true');
    const max = near.combatant.stats.maxHealth;
    expect(near.combatant.health).toBeCloseTo(max * (0.5 + RELIC.harvest.share), 0);
    expect(far.combatant.health).toBeCloseTo(far.combatant.stats.maxHealth * 0.5, 0);
  });

  it('Spite of the Fallen: a god low on health deals more and takes less, until it recovers', () => {
    const { sim, run, team } = setup();
    run.relics.take('spite', 'order');
    fight(sim, run);
    const g = team[0]!;
    const c = g.combatant;
    const base = { dmg: c.stats.damageBonus, red: c.stats.damageReduction };
    c.health = c.stats.maxHealth * 0.3;
    step(sim, run, 0.1);
    expect(c.stats.damageBonus).toBeCloseTo(base.dmg + RELIC.spite.damage, 5);
    expect(c.stats.damageReduction).toBeCloseTo(base.red + RELIC.spite.reduction, 5);
    expect(run.relics.spiting(g)).toBe(true);
    c.health = c.stats.maxHealth;
    step(sim, run, 0.5);
    expect(c.stats.damageBonus).toBeCloseTo(base.dmg, 5);
    expect(run.relics.spiting(g)).toBe(false);
  });

  it("Ferryman's Lantern: the fallen are raised faster, with more of their health", () => {
    const { sim, run, team } = setup();
    run.relics.take('lantern', 'order');
    step(sim, run, DESCENT.enterTime + 0.1);
    const [a, b] = team as [Unit, Unit];
    for (const m of run.monsters) m.brain = null;
    sim.teleport(a, 150, 150);
    a.combatant.takeDamage(1e7);
    step(sim, run, 0.5);
    expect(run.downed.has(a)).toBe(true);
    sim.teleport(b, a.x + 1.5, a.z);
    step(sim, run, run.reviveTime / RELIC.lantern.speed + 0.4);
    expect(a.alive).toBe(true);
    expect(a.combatant.health / a.combatant.stats.maxHealth).toBeGreaterThan(RELIC.lantern.health - 0.05);
  });

  it('works for its own team only, and a guest copies the relics without anything going off on its end', () => {
    const { sim, run, team } = setup();
    run.relics.take('harvest', 'order');
    const { a } = fight(sim, run);
    // a guest's copy of the same run
    const gsim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(7));
    const guest = new Descent(gsim, zeus);
    const gods = team.map((g) => gsim.add(godUnit(g.combatant.god, 'order', { x: 0, z: 0, yaw: 0 })));
    guest.join(gods, [gods[0]!]);
    sim.teleport(team[0]!, a.x + 2, a.z);
    team[0]!.combatant.health = team[0]!.combatant.stats.maxHealth * 0.5;
    sim.strike(team[0]!, a, 1e7, 'true');
    guest.applyNet(JSON.parse(JSON.stringify(run.netState())));
    expect(guest.relics.has('order', 'harvest')).toBe(true);
    expect(guest.relics.procs.map((p) => p.k)).toEqual(run.relics.procs.map((p) => p.k));
    // a death the host reports heals nobody here (the host's heal arrives with its state)
    gods[0]!.combatant.health = gods[0]!.combatant.stats.maxHealth * 0.5;
    const victim = gsim.add(godUnit(zeus, 'chaos', { x: gods[0]!.x + 1, z: gods[0]!.z, yaw: 0 }));
    gsim.inject({ type: 'death', unit: { ...victim, kind: 'monster' } as Unit, killer: gods[0]!, assists: [] });
    expect(gods[0]!.combatant.health).toBeCloseTo(gods[0]!.combatant.stats.maxHealth * 0.5, 0);
  });
});
