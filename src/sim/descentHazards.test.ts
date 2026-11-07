import { describe, expect, it } from 'vitest';
import { zeus } from '../game/gods';
import { addUnderworldColliders, BRINK_FAR, CHAMBERS, entranceSpot, type ChamberDef } from '../map/UnderworldLayout';
import { CollisionWorld } from '../scene/Collision';
import { Hazards, HAZARDS } from './DescentHazards';
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

const chamber = (name: string): ChamberDef => CHAMBERS.find((c) => c.name === name)!;

function setup(c: ChamberDef, terrain: SimTerrain = flat) {
  const sim = new Sim(terrain, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(3));
  const h = new Hazards(sim);
  h.enter(c);
  return { sim, h };
}

const god = (sim: Sim, x: number, z: number): Unit => sim.add(godUnit(zeus, 'order', { x, z, yaw: 0 }));
const beast = (sim: Sim, x: number, z: number): Unit => sim.add(monsterUnit(zeus, 'thornback', { x, z, yaw: 0 }, 0));
const share = (u: Unit) => u.combatant.health / u.combatant.stats.maxHealth;
const noMaster = () => false;

/** A floor spot `b` meters in from the edge of the chamber's lava, water or void (searching outward from the hold). */
function brinkSpot(c: ChamberDef, b: number): [number, number] {
  let best: [number, number] = [0, 0];
  let bd = Infinity;
  for (let x = -c.extent; x <= c.extent; x += 0.5) {
    for (let z = -c.extent * 0.6; z <= c.extent * 0.6; z += 0.5) {
      if (c.sd(x, z) < 0.6 || c.pillars.some(([px, pz, pr]) => Math.hypot(x - px, z - pz) < pr + 1.5)) continue;
      const d = Math.abs(c.brink(x, z) - b) + Math.hypot(x, z) * 0.01;
      if (d < bd) [bd, best] = [d, [x, z]];
    }
  }
  return [c.x + best[0], c.z + best[1]];
}

describe("each depth's dangers", () => {
  it('gives the forge, and only the forge, magma vents on open floor clear of the lava, the gate and the hold', () => {
    for (const c of CHAMBERS) {
      if (c.depth !== 0) {
        expect(c.vents, c.name).toEqual([]);
        continue;
      }
      expect(c.vents.length, c.name).toBe(c.boss ? 6 : 4);
      const gate = entranceSpot(c);
      for (const [x, z] of c.vents) {
        expect(c.sd(x, z), c.name).toBeGreaterThanOrEqual(3);
        expect(c.brink(x, z), c.name).toBeGreaterThanOrEqual(3);
        expect(Math.hypot(c.x + x - gate.x, c.z + z - gate.z), c.name).toBeGreaterThan(10);
        expect(Math.hypot(x - c.hold[0], z - c.hold[1]), c.name).toBeGreaterThan(3);
      }
    }
  });

  it('measures the brink: positive on the floor, negative over the holes, far where nothing cuts it', () => {
    const ring = chamber('The Shattered Ring');
    expect(ring.brink(0, 0)).toBeLessThan(0);
    expect(ring.brink(0, 16)).toBeGreaterThan(0);
    const cloister = chamber('The Sunken Cloister');
    expect(cloister.brink(0, 0)).toBeLessThan(0);
    expect(cloister.brink(15, 15)).toBeGreaterThan(5);
    for (const c of CHAMBERS) expect(c.brink(0, 0), c.name).toBeLessThanOrEqual(BRINK_FAR);
  });

  it('blows a vent once it has glowed: gods and beasts in it burn (a master barely), anyone outside is untouched', () => {
    const c = chamber('The Slag Hall');
    const { sim, h } = setup(c);
    const v = h.vents[0]!;
    const near = god(sim, v.x + 0.5, v.z);
    const far = god(sim, v.x + 6, v.z);
    const thorn = beast(sim, v.x - 0.5, v.z);
    const boss = beast(sim, v.x, v.z + 0.6);
    v.t = HAZARDS.vent.warn;
    expect(h.heat(v)).toBe(0);
    h.step(HAZARDS.vent.warn * 0.5, true, [near, far], [thorn, boss], (m) => m === boss);
    expect(h.heat(v)).toBeCloseTo(0.5, 2);
    expect(share(near)).toBe(1);
    h.step(HAZARDS.vent.warn * 0.5 + 0.01, true, [near, far], [thorn, boss], (m) => m === boss);
    expect(share(near)).toBeCloseTo(1 - HAZARDS.vent.damage * (1 - near.combatant.stats.damageReduction), 3);
    expect(share(far)).toBe(1);
    expect(share(thorn)).toBeCloseTo(1 - HAZARDS.vent.beast, 2);
    expect(share(boss)).toBeCloseTo(1 - HAZARDS.vent.master, 2);
    expect(v.t).toBeGreaterThan(HAZARDS.vent.every[0] - 0.1);
  });

  it('lets a cold vent rest between fights, but one already glowing still blows', () => {
    const c = chamber('The Slag Hall');
    const { sim, h } = setup(c);
    const [a, b] = h.vents;
    const g = god(sim, b!.x, b!.z);
    a!.t = 5;
    b!.t = 0.5;
    h.step(1, false, [g], [], noMaster);
    expect(a!.t).toBe(5);
    expect(share(g)).toBeLessThan(1);
  });

  it('spits slag at a god near the lava: it lands, then burns and slows anyone in the puddle until it cools', () => {
    const c = chamber('The Slag Hall');
    const { sim, h } = setup(c);
    const [x, z] = brinkSpot(c, 2.5);
    const g = god(sim, x, z);
    for (let t = 0; t < HAZARDS.slag.first + 0.2 && !h.slag.length; t += 0.1) h.step(0.1, true, [g], [], noMaster);
    expect(h.slag.length).toBe(1);
    const s = h.slag[0]!;
    expect(Math.hypot(s.x - x, s.z - z)).toBeLessThan(2);
    // spat from the lava
    expect(c.brink(s.fx - c.x, s.fz - c.z)).toBeLessThan(0);
    // standing in it as it lands
    g.body.x = s.x;
    g.body.z = s.z;
    const before = share(g);
    for (let t = 0; t < HAZARDS.slag.flight + 1; t += 0.1) h.step(0.1, false, [g], [], noMaster);
    expect(share(g)).toBeLessThan(before);
    expect(g.combatant.moveSpeed).toBeLessThan(g.combatant.stats.moveSpeed);
    for (let t = 0; t < HAZARDS.slag.life + 0.5; t += 0.1) h.step(0.1, false, [g], [], noMaster);
    expect(h.slag.length).toBe(0);
  });

  it('never spits slag at a god far from the lava', () => {
    const c = chamber('The Great Forge');
    const { sim, h } = setup(c);
    const g = god(sim, c.x, c.z);
    expect(c.brink(0, 0)).toBeGreaterThan(HAZARDS.slag.near);
    for (let t = 0; t < 20; t += 0.1) h.step(0.1, true, [g], [], noMaster);
    expect(h.slag.length).toBe(0);
  });

  it('floods the floor near the Drowned Halls\' water on a cycle: gods wading in it are slowed and dragged toward the deep, gods inland are not', () => {
    const c = chamber('The Sunken Cloister');
    const { sim, h } = setup(c);
    const [wx, wz] = brinkSpot(c, 2);
    const wading = god(sim, wx, wz);
    const [dx, dz] = brinkSpot(c, 8);
    const dry = god(sim, dx, dz);
    expect(h.flood).toBe(0);
    const T = HAZARDS.tide;
    const gods = [wading, dry];
    let t = 0;
    for (; t < T.first + T.rise + 1 && h.flood < 1; t += 0.1) h.step(0.1, true, gods, [], noMaster);
    expect(h.flood).toBe(1);
    expect(h.floodReach).toBeCloseTo(T.reach, 5);
    const b0 = c.brink(wading.x - c.x, wading.z - c.z);
    h.step(0.1, true, gods, [], noMaster);
    expect(wading.combatant.moveSpeed).toBeLessThan(wading.combatant.stats.moveSpeed);
    expect(dry.combatant.moveSpeed).toBe(dry.combatant.stats.moveSpeed);
    for (let k = 0; k < 20; k++) h.step(0.1, true, gods, [], noMaster);
    expect(c.brink(wading.x - c.x, wading.z - c.z)).toBeLessThan(b0 - 1);
    expect(Math.hypot(dry.x - dx, dry.z - dz)).toBe(0);
    // the fight over, the water drains away and the next fight starts calm
    for (let k = 0; k < 40; k++) h.step(0.1, false, gods, [], noMaster);
    expect(h.flood).toBe(0);
    expect(h.tide).toBeCloseTo(T.calm - T.first, 5);
  });

  it('cracks the Abyss\'s brink under a god and drops it: the god is flung back onto solid floor, hurt and dazed, and a beast on it is gone', () => {
    const c = chamber('The Shattered Ring');
    const { sim, h } = setup(c);
    const [x, z] = brinkSpot(c, 1.5);
    const g = god(sim, x, z);
    const C = HAZARDS.crumble;
    for (let t = 0; t < C.first + 0.2 && !h.gaps.length; t += 0.1) h.step(0.1, true, [g], [], noMaster);
    expect(h.gaps.length).toBe(1);
    const gap = h.gaps[0]!;
    expect(Math.hypot(gap.x - x, gap.z - z)).toBeLessThan(gap.r);
    const thorn = beast(sim, gap.x, gap.z);
    for (let t = 0; t < C.warn + 0.05; t += 0.05) h.step(0.05, true, [g], [thorn], noMaster);
    expect(Hazards.open(gap)).toBe(true);
    expect(thorn.alive).toBe(false);
    expect(share(g)).toBeCloseTo(1 - C.damage * (1 - g.combatant.stats.damageReduction), 3);
    expect(g.combatant.cc.has('stun')).toBe(true);
    // flung back to solid floor clear of the hole
    for (let k = 0; k < 40; k++) sim.step(1 / 30);
    expect(Math.hypot(g.x - gap.x, g.z - gap.z)).toBeGreaterThan(gap.r);
    expect(c.sd(g.x - c.x, g.z - c.z)).toBeGreaterThan(1);
    // and it comes back
    for (let t = 0; t < C.down + C.rise + 0.5; t += 0.1) h.step(0.1, false, [g], [], noMaster);
    expect(h.gaps.length).toBe(0);
  });

  it('cuts a fallen patch out of the walkable floor while it is gone', () => {
    const c = chamber('The Shattered Ring');
    const world = new CollisionWorld(() => 0);
    addUnderworldColliders(world);
    const { sim, h } = setup(c, world);
    const [x, z] = brinkSpot(c, 1.5);
    const g = god(sim, x, z);
    for (let t = 0; t < 10 && !h.gaps.some(Hazards.open); t += 0.1) h.step(0.1, true, [g], [], noMaster);
    const gap = h.gaps.find(Hazards.open)!;
    // a step into it is pushed back out
    const p = world.resolve(gap.x + 1, gap.z, 0.5, 0);
    expect(Math.hypot(p.x - gap.x, p.z - gap.z)).toBeGreaterThan(gap.r - 0.1);
    // a leap passes over it
    const q = world.resolve(gap.x + 1, gap.z, 0.5, 2);
    expect(Math.hypot(q.x - gap.x - 1, q.z - gap.z)).toBeLessThan(0.01);
  });

  it('never cracks the brink under a god on a narrow bridge', () => {
    const c = chamber('The Isles');
    const { sim, h } = setup(c);
    // the middle of the north bridge
    const g = god(sim, c.x, c.z - 11);
    expect(c.brink(0, -11)).toBeLessThan(HAZARDS.crumble.near);
    for (let t = 0; t < 30; t += 0.1) h.step(0.1, true, [g], [], noMaster);
    expect(h.gaps.length).toBe(0);
  });

  it('creeps the dark in from the void the longer an Abyss hall\'s fight runs, burning gods in it; kills drive it back, and it leaves half the floor clear', () => {
    const c = chamber('The Shattered Ring');
    const { sim, h } = setup(c);
    const [x, z] = brinkSpot(c, 1);
    const g = god(sim, x, z);
    const D = HAZARDS.dark;
    for (let k = 0; k < D.after * 10 - 1; k++) h.step(0.1, true, [], [], noMaster);
    expect(h.dark).toBe(0);
    for (let t = 0; t < 10; t += 0.1) h.step(0.1, true, [g], [], noMaster);
    expect(h.dark).toBeGreaterThan(1);
    expect(share(g)).toBeLessThan(1);
    const was = h.dark;
    h.onKill();
    expect(h.dark).toBeCloseTo(was - D.kill, 5);
    for (let t = 0; t < 200; t += 0.5) h.step(0.5, true, [], [], noMaster);
    let floor = 0;
    let clear = 0;
    for (let lx = -c.extent; lx <= c.extent; lx += 1) {
      for (let lz = -c.extent; lz <= c.extent; lz += 1) {
        if (c.sd(lx, lz) < 0) continue;
        floor++;
        if (c.brink(lx, lz) >= h.dark) clear++;
      }
    }
    expect(clear / floor).toBeGreaterThanOrEqual(D.keep - 0.02);
    // and once the chamber is won it draws back
    for (let t = 0; t < 10; t += 0.1) h.step(0.1, false, [], [], noMaster);
    expect(h.dark).toBe(0);
  });

  it("keeps the dark out of the Ossuary King's hall", () => {
    const c = chamber('The Ossuary Throne');
    const { h } = setup(c);
    for (let t = 0; t < 60; t += 0.5) h.step(0.5, true, [], [], noMaster);
    expect(h.dark).toBe(0);
  });

  it('sends a guest the same dangers', () => {
    const c = chamber('The Shattered Ring');
    const host = setup(c);
    const [x, z] = brinkSpot(c, 1.5);
    const g = god(host.sim, x, z);
    for (let t = 0; t < 25; t += 0.1) host.h.step(0.1, true, [g], [], noMaster);
    expect(host.h.gaps.length + (host.h.dark > 0 ? 1 : 0)).toBeGreaterThan(0);
    const guest = setup(chamber('The Slag Hall'));
    guest.h.applyNet(c, JSON.parse(JSON.stringify(host.h.netState())));
    expect(guest.h.gaps.map((q) => q.id)).toEqual(host.h.gaps.map((q) => q.id));
    expect(guest.h.dark).toBeCloseTo(host.h.dark, 1);
    const forge = setup(chamber('The Slag Hall'));
    forge.h.vents[1]!.t = 0.3;
    const copy = setup(chamber('The Isles'));
    copy.h.applyNet(chamber('The Slag Hall'), forge.h.netState()!);
    expect(copy.h.vents.map((v) => v.t)).toEqual(forge.h.vents.map((v) => Math.round(v.t * 100) / 100));
  });
});
