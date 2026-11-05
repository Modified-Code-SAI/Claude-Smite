import { describe, expect, it } from 'vitest';
import { GODS, thor, zeus } from '../game/gods';
import { jotunn } from '../game/gods/jotunn';
import { ULTIMATE_SLOT } from '../game/loadout';
import { godUnit } from './factory';
import { Jotunn, JOTUNN, PARTS, SHRINES } from './Jotunn';
import { escape, jotunnBots } from './JotunnBots';
import { Sim, type SimTerrain } from './Sim';
import type { Flash, Unit } from './Unit';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };

const newSim = () => new Sim(flat, { order: { ...JOTUNN.bases.order }, chaos: { ...JOTUNN.bases.chaos } }, () => 0.5);

/** Five players (the first is you), no bots, so tests drive everything. */
function setup(order?: number[]) {
  const sim = newSim();
  const players = GODS.map((g, i) => ({ name: g.name, id: i === 0 ? '' : null, god: g }));
  const mode = new Jotunn(sim, players, { order });
  mode.begin();
  const run = (s: number) => {
    for (let i = 0; i < Math.round(s * 60); i++) {
      mode.step(1 / 60);
      sim.step(1 / 60);
    }
  };
  const part = (id: keyof typeof PARTS) => mode.parts.get(id)!;
  return { sim, mode, run, part, g: mode.giant };
}

/** Deal `amount` to a unit as an enemy god would (through the sim, so events fire). */
function hit(sim: Sim, from: Unit, target: Unit, amount: number): void {
  sim.strike(from, target, amount, 'true');
}

describe('wound-up attacks', () => {
  it('root the caster, warn with the shape they will strike, and land on the aim they had at the press', () => {
    const sim = newSim();
    const giant = sim.add(godUnit(jotunn, 'chaos', { x: 0, z: 0, yaw: Math.PI }));
    giant.combatant.gainXp(1e6);
    const god = sim.add(godUnit(zeus, 'order', { x: 0, z: 5, yaw: 0 }));
    giant.aim.x = 0;
    giant.aim.z = 5;
    const slam = giant.combatant.loadout.indexOf('jotunn.slam');
    expect(sim.cast(giant, slam)).toBeNull();
    expect(sim.canMove(giant)).toBe(false);
    const warn = sim.flashes.find((f) => f.warn)!;
    expect(warn.shape).toMatchObject({ type: 'circle', x: 0, z: 5 });
    // the aim wanders off during the windup: the blow still lands where it was aimed
    giant.aim.x = 30;
    const before = god.combatant.health;
    for (let i = 0; i < 40; i++) sim.step(1 / 60);
    expect(god.combatant.health).toBe(before);
    for (let i = 0; i < 20; i++) sim.step(1 / 60);
    expect(god.combatant.health).toBeLessThan(before);
    expect(god.combatant.cc.has('stun')).toBe(true);
    expect(sim.canMove(giant)).toBe(true);
    expect(sim.flashes.some((f) => f.warn)).toBe(false);
  });

  it('are cancelled by a stun, warning and all', () => {
    const sim = newSim();
    const giant = sim.add(godUnit(jotunn, 'chaos', { x: 0, z: 0, yaw: Math.PI }));
    giant.combatant.gainXp(1e6);
    const god = sim.add(godUnit(zeus, 'order', { x: 0, z: 3, yaw: 0 }));
    expect(sim.cast(giant, 0)).toBeNull();
    giant.combatant.cc.apply('stun', 1);
    const before = god.combatant.health;
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    expect(god.combatant.health).toBe(before);
    expect(sim.flashes.some((f) => f.warn)).toBe(false);
    expect(giant.windup).toBe(0);
  });

  it('a wound-up club swing hits the cone shown, not where the giant looks when it lands', () => {
    const sim = newSim();
    const giant = sim.add(godUnit(jotunn, 'chaos', { x: 0, z: 0, yaw: Math.PI }));
    const front = sim.add(godUnit(zeus, 'order', { x: 0, z: 6, yaw: 0 }));
    const behind = sim.add(godUnit(thor, 'order', { x: 0, z: -6, yaw: 0 }));
    giant.aim.x = 0;
    giant.aim.z = 10;
    expect(sim.basic(giant)).toBe(true);
    expect(sim.flashes.find((f) => f.warn)?.shape.type).toBe('cone');
    giant.aim.z = -10;
    const [f0, b0] = [front.combatant.health, behind.combatant.health];
    for (let i = 0; i < 40; i++) sim.step(1 / 60);
    expect(front.combatant.health).toBeLessThan(f0);
    expect(behind.combatant.health).toBe(b0);
  });
});

describe('Jötunn', () => {
  it('sets up the giant, its weak points, four braziers and five players; you are a god first', () => {
    const { mode, sim, g } = setup();
    expect(mode.rounds).toBe(2);
    expect(mode.giantPlayer.id).toBeNull();
    expect(mode.gods).toHaveLength(4);
    expect(mode.gods).toContain(mode.players[0]!.god);
    // the giant's own god sits the round out
    expect(sim.units.includes(mode.giantPlayer.god)).toBe(false);
    expect(mode.braziers).toHaveLength(4);
    expect(g.combatant.stats.maxHealth).toBe(JOTUNN.might.base + JOTUNN.might.perGod * 4);
    expect(g.combatant.ccImmune).toBe(true);
    expect(mode.phase).toBe('countdown');
  });

  it('passes weak point damage on to the giant; its hide takes a small share', () => {
    const { mode, sim, run, part, g } = setup();
    run(JOTUNN.countdown + 0.1);
    const god = mode.gods[0]!;
    const might = g.combatant.health;
    hit(sim, god, part('kneeL'), 500);
    expect(might - g.combatant.health).toBeCloseTo(500 * PARTS.kneeL.mult, 0);
    const after = g.combatant.health;
    sim.strike(god, g, 1000, 'physical');
    expect(after - g.combatant.health).toBeLessThan(120);
    expect(after - g.combatant.health).toBeGreaterThan(0);
  });

  it('kneels when both knees break: stunned, crown exposed for double damage, knees back when it stands', () => {
    const { mode, sim, run, part, g } = setup();
    run(JOTUNN.countdown + 0.1);
    const god = mode.gods[0]!;
    expect(part('crown').targetable).toBe(false);
    hit(sim, god, part('kneeL'), 1e5);
    run(0.1);
    expect(mode.kneeling).toBe(0);
    // one knee down: it limps
    expect(g.combatant.stats.bonusMoveSpeed).toBeCloseTo(-JOTUNN.limp);
    hit(sim, god, part('kneeR'), 1e5);
    run(0.1);
    expect(mode.kneeling).toBeGreaterThan(0);
    expect(g.combatant.cc.has('stun')).toBe(true);
    expect(part('crown').targetable).toBe(true);
    const might = g.combatant.health;
    hit(sim, god, part('crown'), 400);
    expect(might - g.combatant.health).toBeCloseTo(400 * PARTS.crown.mult, 0);
    run(JOTUNN.kneel);
    expect(mode.kneeling).toBe(0);
    expect(part('kneeL').alive && part('kneeR').alive).toBe(true);
    expect(part('crown').targetable).toBe(false);
    expect(g.combatant.stats.bonusMoveSpeed).toBeCloseTo(0);
  });

  it('a broken knee grows back if the other holds', () => {
    const { mode, sim, run, part } = setup();
    run(JOTUNN.countdown + 0.1);
    hit(sim, mode.gods[0]!, part('kneeL'), 1e5);
    run(PARTS.kneeL.regrow + 0.2);
    expect(part('kneeL').alive).toBe(true);
    expect(part('kneeL').combatant.health).toBe(part('kneeL').combatant.stats.maxHealth);
  });

  it('a slam plants the fist: that wrist can be struck where it landed, and breaking it staggers the giant and spends the slam', () => {
    const { mode, sim, run, part, g } = setup();
    run(JOTUNN.countdown + 0.1);
    g.aim.x = g.x;
    g.aim.z = g.z + 8;
    expect(sim.cast(g, 2)).toBeNull();
    run(1);
    const wrist = mode.planted ? part(mode.planted.part) : null;
    expect(wrist?.targetable).toBe(true);
    expect(Math.hypot(wrist!.x - mode.planted!.x, wrist!.z - mode.planted!.z)).toBeLessThan(0.01);
    expect(sim.canMove(g)).toBe(false);
    hit(sim, mode.gods[0]!, wrist!, 1e5);
    run(0.05);
    expect(mode.planted).toBeNull();
    expect(g.combatant.cc.has('stun')).toBe(true);
    expect(g.combatant.cooldownOf(2)).toBeGreaterThan(JOTUNN.wristLock - 1);
    run(JOTUNN.plant);
    expect(part('wristL').targetable || part('wristR').targetable).toBe(false);
  });

  it('breaking the back rune silences the giant', () => {
    const { mode, sim, run, part, g } = setup();
    run(JOTUNN.countdown + 0.1);
    hit(sim, mode.gods[0]!, part('rune'), 1e5);
    run(0.05);
    expect(g.combatant.canCast(0)).toBe('cc');
  });

  it('claims a shrine it stands in for its new ultimate, unless a god holds it', () => {
    const { mode, sim, run, g } = setup();
    run(JOTUNN.countdown + 0.1);
    const shrine = SHRINES[1]!;
    sim.teleport(g, shrine.x, shrine.z);
    const god = mode.gods[0]!;
    sim.teleport(god, shrine.x + 1, shrine.z);
    god.home.x = god.x;
    run(JOTUNN.claimTime + 0.5);
    expect(mode.claims).toBe(0);
    sim.teleport(god, 0, 30);
    run(JOTUNN.claimTime + 0.2);
    expect(mode.claims).toBe(1);
    expect(g.combatant.loadout[ULTIMATE_SLOT]).toBe(shrine.ult);
    expect(g.combatant.canCast(ULTIMATE_SLOT)).toBeNull();
    expect(mode.shrines[1]!.dormant).toBeGreaterThan(0);
    expect(g.combatant.stats.damageBonus).toBeCloseTo(JOTUNN.shrineDamage);
  });

  it('only the giant\'s club breaks braziers; three broken win the round, and the next round you are the giant', () => {
    const { mode, sim, run, g } = setup();
    run(JOTUNN.countdown + 0.1);
    const b = mode.braziers[0]!;
    const god = mode.gods[0]!;
    // a skill does nothing to it
    sim.strike(g, b, 1e5, 'true');
    expect(b.alive).toBe(true);
    for (const target of mode.braziers.slice(0, 3)) {
      sim.teleport(g, target.x, target.z + 4);
      g.aim.x = target.x;
      g.aim.z = target.z;
      for (let i = 0; i < JOTUNN.brazierHits + 1 && target.alive; i++) {
        sim.basic(g);
        run(2.1);
      }
      expect(target.alive).toBe(false);
    }
    run(0.1);
    expect(mode.phase).toBe('over');
    expect(mode.lastRound).toBe('giant');
    const botGiant = mode.giantPlayer;
    expect(botGiant.wins).toBe(1);
    expect(botGiant.giantRound).toMatchObject({ braziers: 3, won: true });
    expect(god.alive).toBe(true);
    run(JOTUNN.pause + 0.1);
    expect(mode.round).toBe(2);
    expect(mode.giantPlayer).toBe(mode.players[0]);
    expect(sim.units.includes(mode.players[0]!.god)).toBe(false);
    expect(sim.units.includes(botGiant.god)).toBe(true);
    expect(mode.braziersLeft).toBe(4);
    expect(g.combatant.health).toBe(g.combatant.stats.maxHealth);
  });

  it('the gods win when the giant falls, and the match ends after the last round', () => {
    const { mode, run, g } = setup([1]);
    run(JOTUNN.countdown + 0.1);
    g.combatant.takeDamage(1e9);
    run(0.1);
    expect(mode.lastRound).toBe('gods');
    expect(mode.players[0]!.wins).toBe(1);
    expect(mode.players[1]!.wins).toBe(0);
    run(JOTUNN.pause + 0.1);
    expect(mode.phase).toBe('done');
    expect(mode.champions).not.toContain(mode.players[1]);
  });

  it('online, each person takes a turn as the giant', () => {
    const sim = newSim();
    const players = GODS.map((g, i) => ({ name: g.name, id: i < 3 ? `peer${i}` : null, god: g }));
    const mode = new Jotunn(sim, players);
    expect(mode.order).toEqual([0, 1, 2]);
  });

  it('bots play a whole round to an end, both sides', () => {
    const sim = new Sim(flat, { order: { ...JOTUNN.bases.order }, chaos: { ...JOTUNN.bases.chaos } });
    const players = GODS.map((g) => ({ name: g.name, id: null, god: g }));
    const mode = new Jotunn(sim, players, { order: [2], brains: jotunnBots(sim) });
    mode.begin();
    let swings = 0;
    sim.listeners.push((e) => {
      if (e.type === 'basic' && e.unit === mode.giant) swings++;
    });
    for (let i = 0; i < 60 * 600 && mode.phase === 'countdown' || (mode.phase === 'fight' && i < 60 * 600); i++) {
      mode.step(1 / 60);
      sim.step(1 / 60);
    }
    expect(mode.phase).toBe('over');
    expect(swings).toBeGreaterThan(5);
  });
});

describe('dodging a warning', () => {
  const flash = (shape: Flash['shape']): Flash => ({ id: 1, shape, owner: null as unknown as Unit, age: 0.5, life: 1, warn: true });

  it('leaves a circle outward and ignores one it is clear of', () => {
    const f = flash({ type: 'circle', x: 0, z: 0, radius: 4 });
    expect(escape(f, { x: 2, z: 0 }, 1)).toEqual({ x: 1, z: 0 });
    expect(escape(f, { x: 6, z: 0 }, 1)).toBeNull();
  });

  it('steps sideways out of a line or a cone, and is safe behind a cone', () => {
    // facing -Z from the origin
    const line = flash({ type: 'line', x: 0, z: 0, yaw: 0, length: 10, width: 4 });
    expect(escape(line, { x: 1, z: -5 }, 0.5)!.x).toBeGreaterThan(0);
    expect(escape(line, { x: 5, z: -5 }, 0.5)).toBeNull();
    const cone = flash({ type: 'cone', x: 0, z: 0, yaw: 0, range: 9, angle: 100 });
    expect(escape(cone, { x: -1, z: -4 }, 0.5)!.x).toBeLessThan(0);
    expect(escape(cone, { x: 0, z: 5 }, 0.5)).toBeNull();
  });
});
