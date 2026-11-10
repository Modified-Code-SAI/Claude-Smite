import { describe, expect, it } from 'vitest';
import { zeus, thor } from '../game/gods';
import { CHAMBERS, DEPTH_CHAMBERS, entranceSpot, escapeSpot, exitSpot, type ChamberDef } from '../map/UnderworldLayout';
import { Descent, DESCENT } from './Descent';
import { DEPTH_TRAP, Loot, LOOT } from './DescentLoot';
import { godUnit, monsterUnit } from './factory';
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

const newSim = (seed = 3) => new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(seed));
const god = (sim: Sim, x: number, z: number): Unit => sim.add(godUnit(zeus, 'order', { x, z, yaw: 0 }));
const beast = (sim: Sim, x: number, z: number): Unit => sim.add(monsterUnit(zeus, 'thornback', { x, z, yaw: 0 }, 0));
const share = (u: Unit) => u.combatant.health / u.combatant.stats.maxHealth;
const noMaster = () => false;
const plain = CHAMBERS.filter((c) => !c.boss);

/** A chamber's loot laid with a given seed. */
function laid(c: ChamberDef, seed = 3) {
  const sim = newSim(seed);
  const loot = new Loot(sim);
  loot.enter(c, c.depth, false);
  return { sim, loot };
}

/** A laid chamber that has a chest of the kind asked for. */
function withChest(cursed: boolean) {
  for (let seed = 1; seed < 80; seed++) {
    for (const c of plain) {
      const l = laid(c, seed);
      const ch = l.loot.chests.find((x) => x.cursed === cursed);
      if (ch) return { ...l, c, ch };
    }
  }
  throw new Error('no such chest');
}

/** A plate out on the open floor, away from any chest (so nothing else goes off on whoever stands there). */
const openTrap = (loot: Loot) => loot.traps.find((t) => loot.chests.every((ch) => Math.hypot(ch.x - t.x, ch.z - t.z) > 7))!;

const run = (loot: Loot, seconds: number, gods: Unit[], monsters: Unit[] = [], openers = gods) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) loot.step(1 / 30, gods, openers, monsters, noMaster);
};

describe("the Descent's treasure: what a chamber holds", () => {
  it('lays one or two chests and a few traps on open floor in every plain chamber, clear of both gates', () => {
    for (const c of plain) {
      for (const seed of [1, 2, 3, 4]) {
        const { loot } = laid(c, seed);
        const tag = `${c.name} #${seed}`;
        expect(loot.chests.length, tag).toBeGreaterThanOrEqual(1);
        expect(loot.chests.length, tag).toBeLessThanOrEqual(2);
        expect(loot.traps.length, tag).toBeGreaterThanOrEqual(LOOT.trap.count[0]);
        const gates = [entranceSpot(c), exitSpot(c)];
        for (const s of [...loot.chests, ...loot.traps]) {
          expect(c.sd(s.x - c.x, s.z - c.z), tag).toBeGreaterThan(0.9);
          for (const g of gates) expect(Math.hypot(s.x - g.x, s.z - g.z), tag).toBeGreaterThan(5);
          for (const [px, pz, pr] of c.pillars) expect(Math.hypot(s.x - c.x - px, s.z - c.z - pz), tag).toBeGreaterThan(pr + 0.5);
        }
        for (const t of loot.traps) expect(t.kind, tag).toBe(DEPTH_TRAP[c.depth]);
      }
    }
  });

  it("lays the same chamber the same way from the same dice, and a master's chamber bare until it falls", () => {
    const c = plain[0]!;
    expect(laid(c, 9).loot.netState()).toEqual(laid(c, 9).loot.netState());
    const sim = newSim();
    const loot = new Loot(sim);
    const boss = CHAMBERS.find((x) => x.boss)!;
    loot.enter(boss, boss.depth, true);
    expect(loot.chests.length + loot.traps.length).toBe(0);
    loot.hoard({ x: boss.x + boss.hold[0], z: boss.z + boss.hold[1] });
    expect(loot.chests).toHaveLength(1);
    expect(loot.chests[0]!.hoard).toBe(true);
    expect(loot.chests[0]!.value).toBeGreaterThanOrEqual(LOOT.chest.hoard[0]);
  });
});

describe("the Descent's treasure: chests", () => {
  it('opens for a god who stands at it long enough, and shuts again on one who walks off early', () => {
    const { sim, loot, ch } = withChest(false);
    const g = god(sim, ch.x + 1, ch.z);
    run(loot, LOOT.chest.time * 0.5, [g]);
    expect(ch.open).toBeGreaterThan(0.3);
    expect(ch.opened).toBe(false);
    g.body.x += 30;
    run(loot, LOOT.chest.time, [g]);
    expect(ch.open).toBe(0);
    expect(loot.haul).toBe(0);
    g.body.x -= 30;
    run(loot, LOOT.chest.time + 0.2, [g]);
    expect(ch.opened).toBe(true);
    expect(loot.haul).toBe(Math.round(ch.value * loot.worth));
    expect(loot.gain.chest).toBe(true);
    // and pays once
    run(loot, 3, [g]);
    expect(loot.haul).toBe(Math.round(ch.value * loot.worth));
  });

  it('leaves a chest shut to a bot while a human plays', () => {
    const { sim, loot, ch } = withChest(false);
    const bot = god(sim, ch.x + 1, ch.z);
    const human = god(sim, ch.x + 40, ch.z);
    run(loot, LOOT.chest.time * 2, [bot, human], [], [human]);
    expect(ch.opened).toBe(false);
  });

  it('pays more for a cursed chest, which bursts on whoever is still standing there', () => {
    const { sim, loot, ch } = withChest(true);
    const greedy = god(sim, ch.x + 1, ch.z);
    const wary = god(sim, ch.x + 1, ch.z + 0.5);
    run(loot, LOOT.chest.time + 0.1, [greedy, wary]);
    expect(ch.opened).toBe(true);
    expect(ch.burst).toBeGreaterThan(0);
    expect(loot.threat(greedy.x, greedy.z, greedy.radius)).not.toBeNull();
    wary.body.x += 20;
    run(loot, LOOT.chest.burst.warn + 0.2, [greedy, wary]);
    expect(share(greedy)).toBeCloseTo(1 - LOOT.chest.burst.damage, 1);
    expect(share(wary)).toBe(1);
    expect(loot.threat(greedy.x, greedy.z, greedy.radius)).toBeNull();
  });
});

describe("the Descent's treasure: traps", () => {
  it('clicks under a god, goes off after a beat on whoever stayed, then rests before it sets again', () => {
    const { sim, loot } = laid(plain[0]!);
    const t = openTrap(loot);
    const slow = god(sim, t.x, t.z);
    const quick = god(sim, t.x + 0.2, t.z);
    run(loot, 0.1, [slow, quick]);
    expect(t.fuse).toBeGreaterThan(0);
    expect(loot.threat(slow.x, slow.z, slow.radius)).not.toBeNull();
    quick.body.x += 300;
    run(loot, LOOT.trap.delay + 0.1, [slow, quick]);
    expect(t.fired).toBe(1);
    expect(share(slow)).toBeLessThan(1);
    expect(share(quick)).toBe(1);
    const after = share(slow);
    run(loot, LOOT.trap.reset - 1, [slow, quick]);
    expect(t.fired).toBe(1);
    expect(share(slow)).toBe(after);
    run(loot, 2 + LOOT.trap.delay, [slow, quick]);
    expect(t.fired).toBe(2);
  });

  it("goes off each depth's own way: fire burns, frost roots, bone spikes stun", () => {
    for (const depth of [0, 1, 2]) {
      const c = CHAMBERS[DEPTH_CHAMBERS[depth]!.halls[0]!]!;
      const { sim, loot } = laid(c);
      const t = openTrap(loot);
      const g = god(sim, t.x, t.z);
      run(loot, LOOT.trap.delay + 0.2, [g]);
      expect(share(g), c.name).toBeCloseTo(1 - LOOT.trap.damage[depth]!, 1);
      const cc = g.combatant.cc;
      if (depth === 1) expect(cc.locks().move, c.name).toBe(true);
      if (depth === 2) expect(cc.has('stun'), c.name).toBe(true);
      if (depth === 0) expect(cc.locks().move, c.name).toBe(false);
    }
  });

  it('is sprung by a beast, and hurts the beasts on it: a god can lure a pack over a plate', () => {
    const { sim, loot } = laid(plain[0]!);
    const t = openTrap(loot);
    const g = god(sim, t.x + 30, t.z);
    const m = beast(sim, t.x, t.z);
    run(loot, LOOT.trap.delay + 0.2, [g], [m]);
    expect(t.fired).toBe(1);
    expect(share(m)).toBeCloseTo(1 - LOOT.trap.beast, 1);
  });

  it('is not sprung by a bot while a human plays', () => {
    const { sim, loot } = laid(plain[0]!);
    const t = openTrap(loot);
    const bot = god(sim, t.x, t.z);
    const human = god(sim, t.x + 30, t.z);
    run(loot, 2, [bot, human], [], [human]);
    expect(t.fired).toBe(0);
  });
});

describe("the Descent's treasure: the haul", () => {
  it('is worth more the deeper it is found, banks whole on the way out, a half more at the bottom, and all but a keepsake is lost in death', () => {
    const sim = newSim();
    const loot = new Loot(sim);
    const at = { x: 0, z: 0 };
    for (const depth of [0, 1, 2]) {
      const c = CHAMBERS[DEPTH_CHAMBERS[depth]!.halls[0]!]!;
      loot.enter(c, depth, true);
      const before = loot.haul;
      loot.find(100, at);
      expect(loot.haul - before).toBe(Math.round(100 * LOOT.worth[depth]!));
    }
    const haul = loot.haul;
    expect(loot.bank()).toBe(haul);
    expect(loot.haul).toBe(0);
    loot.haul = 200;
    expect(loot.bank(true)).toBe(Math.round(200 * (1 + LOOT.crown)));
    loot.haul = 200;
    expect(loot.lose()).toBe(Math.floor(200 * LOOT.keepsake));
    expect(loot.banked).toBe(20);
  });

  it('reaches a guest whole: chests, traps, fuses and the haul', () => {
    const { sim, loot, c, ch } = withChest(true);
    const g = god(sim, ch.x + 1, ch.z);
    run(loot, LOOT.chest.time + 0.1, [g]);
    const guest = new Loot(newSim(99));
    guest.applyNet(c, c.depth, JSON.parse(JSON.stringify(loot.netState())));
    expect(guest.haul).toBe(loot.haul);
    expect(guest.chests.map((x) => [x.id, x.opened, x.cursed, x.hoard])).toEqual(loot.chests.map((x) => [x.id, x.opened, x.cursed, x.hoard]));
    expect(guest.traps.map((x) => [x.id, x.kind])).toEqual(loot.traps.map((x) => [x.id, x.kind]));
    expect(guest.gain.n).toBe(1);
    expect(guest.gain.chest).toBe(true);
    const burst = guest.chests.find((x) => x.id === ch.id)!.burst;
    guest.follow(0.2);
    expect(guest.chests.find((x) => x.id === ch.id)!.burst).toBeCloseTo(burst - 0.2, 2);
  });
});

describe("the Descent's treasure: the run", () => {
  function setup(humans = 1, seed = 7) {
    const sim = newSim(seed);
    const d = new Descent(sim, zeus);
    const team = [zeus, thor].map((def, i) => {
      const u = sim.add(godUnit(def, 'order', { x: 0, z: 0, yaw: 0 }));
      d.addGod(u, i < humans);
      return u;
    });
    d.begin();
    return { sim, d, team };
  }
  const step = (sim: Sim, d: Descent, seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 30); i++) {
      d.step(1 / 30);
      sim.step(1 / 30);
    }
  };
  /** Plays on, killing what rises and taking the first of every choice, until the way on is open. */
  const toExit = (sim: Sim, d: Descent, by: Unit) => {
    for (let guard = 0; guard < 400 && d.phase !== 'exit' && d.phase !== 'won' && d.phase !== 'lost'; guard++) {
      for (const m of [...d.monsters]) if (m.alive) sim.strike(by, m, 1e7, 'true');
      for (const b of d.bells) b.rung = 1;
      if (d.floodLeft > 0) d.floodLeft = 0.01;
      if (d.phase === 'reward') d.vote(by, 0);
      if (d.phase === 'draft') d.draft(by, 0);
      step(sim, d, 0.2);
    }
  };

  it('pays coin for every kill and lays each chamber its chests', () => {
    const { sim, d, team } = setup();
    expect(d.loot.chests.length).toBeGreaterThan(0);
    step(sim, d, 6);
    const m = d.monsters.find((x) => x.alive)!;
    sim.strike(team[0]!, m, 1e7, 'true');
    step(sim, d, 0.1);
    expect(d.loot.haul).toBeGreaterThanOrEqual(LOOT.kill.body);
    expect(d.loot.gain.chest).toBe(false);
  });

  it('opens the way back up only once a master has fallen with more depths below, and climbing out ends the run with the haul banked', () => {
    const { sim, d, team } = setup();
    const me = team[0]!;
    let escapes = 0;
    for (let guard = 0; guard < 12 && d.phase !== 'won'; guard++) {
      toExit(sim, d, me);
      if (d.phase !== 'exit') break;
      if (!d.escape) {
        expect(d.current.kind === 'boss' && d.depth < 2).toBe(false);
        const out = exitSpot(d.layout);
        for (const g of team) sim.teleport(g, out.x, out.z);
        step(sim, d, 4);
        continue;
      }
      escapes++;
      expect(d.current.kind).toBe('boss');
      expect(d.timer).toBeGreaterThan(DESCENT.exitPull);
      // the master's hoard is there to open first
      const hoard = d.loot.chests.find((c) => c.hoard)!;
      expect(hoard).toBeTruthy();
      sim.teleport(me, hoard.x + 1, hoard.z);
      step(sim, d, LOOT.chest.time + 0.3);
      expect(hoard.opened).toBe(true);
      const haul = d.loot.haul;
      expect(haul).toBeGreaterThan(LOOT.chest.hoard[0]);
      const up = escapeSpot(d.layout);
      sim.teleport(me, up.x, up.z);
      step(sim, d, 0.3);
      expect(d.phase).toBe('won');
      expect(d.escaped).toBe(true);
      expect(d.loot.banked).toBe(haul);
      expect(d.loot.haul).toBe(0);
    }
    expect(escapes).toBe(1);
  });

  it('loses all but a keepsake when the team dies below', () => {
    const { sim, d, team } = setup();
    d.loot.find(300, { x: 0, z: 0 });
    const had = d.loot.haul;
    for (let guard = 0; guard < 40 && d.phase !== 'lost'; guard++) {
      for (const g of team) if (g.alive) g.combatant.takeDamage(1e7);
      step(sim, d, 1);
    }
    expect(d.phase).toBe('lost');
    expect(d.loot.banked).toBe(Math.floor(had * LOOT.keepsake));
    expect(d.escaped).toBe(false);
  });

  it('lays no treasure in a race between two teams', () => {
    const sim = newSim();
    const d = new Descent(sim, zeus, undefined, true);
    const a = sim.add(godUnit(zeus, 'order', { x: 0, z: 0, yaw: 0 }));
    const b = sim.add(godUnit(thor, 'chaos', { x: 0, z: 0, yaw: 0 }));
    d.addGod(a, true);
    d.addGod(b, false);
    d.begin();
    expect(d.versus).toBe(true);
    expect(d.loot.chests.length + d.loot.traps.length).toBe(0);
    expect(d.escape).toBe(false);
  });
});
