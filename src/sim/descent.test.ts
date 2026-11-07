import { describe, expect, it } from 'vitest';
import { ULTIMATE_SLOT } from '../game/loadout';
import { GODS, odin, thor, zeus } from '../game/gods';
import { skillById } from '../game/loadout';
import { CHAMBERS, chamberField, DEPTH_CHAMBERS, entranceSpot, exitSpot, underworldCave, underworldField, obstaclesOf } from '../map/UnderworldLayout';
import { navOf } from '../map/ChamberNav';
import { ALL_SLOTS, ASHSMITH, BRUTE, CHALLENGE, challengeSpots, chamberWaves, CINDER, CURSE_AT, DEPTH_CHALLENGE, Descent, DESCENT, DescentMonsterBrain, draftFor, GRIP, HOWL, KEEPER, KING, learnSkill, LURK, planRun, POUNCE, SHADE_BLINK, TIDEMAW, type ChamberKind } from './Descent';
import { HAZARDS } from './DescentHazards';
import { CURSES } from './Siege';
import { DescentBot } from './DescentBot';
import { godUnit, monsterUnit } from './factory';
import { CollisionWorld } from '../scene/Collision';
import { addUnderworldColliders } from '../map/UnderworldLayout';
import { Sim, type SimTerrain } from './Sim';
import type { Unit } from './Unit';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };
// the underworld has no fountain: the sim's bases sit far outside every chamber
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

function setup(gods = [zeus], humans = 1, seed = 7) {
  const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(seed));
  const run = new Descent(sim, zeus);
  const team = gods.map((def, i) => {
    const u = sim.add(godUnit(def, 'order', { x: 0, z: 0, yaw: 0 }));
    run.addGod(u, i < humans);
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

/** Kills every monster in the chamber and lets the run notice. */
const clear = (sim: Sim, run: Descent, by: Unit) => {
  for (let guard = 0; guard < 20 && run.phase === 'fight'; guard++) {
    for (const m of [...run.monsters]) if (m.alive) sim.strike(by, m, 1e7, 'true');
    // (and a challenge chamber's own task done: the bells rung, the flood waited out)
    for (const b of run.bells) b.rung = 1;
    if (run.floodLeft > 0) run.floodLeft = 0.01;
    step(sim, run, 0.2);
  }
};

/** Fights into the current chamber and clears it, ready for its reward. */
const reachReward = (sim: Sim, run: Descent, by: Unit) => {
  step(sim, run, DESCENT.enterTime + 0.1);
  clear(sim, run, by);
};

/** Takes whatever is offered and drafts the first skill until the exit opens. */
const settle = (sim: Sim, run: Descent) => {
  for (let guard = 0; guard < 10 && (run.phase === 'reward' || run.phase === 'draft'); guard++) {
    if (run.phase === 'reward') for (const h of run.humans) run.vote(h, 0);
    if (run.phase === 'draft') for (const h of run.humans) run.draft(h, 0);
    step(sim, run, 0.1);
  }
};

const walkOut = (sim: Sim, run: Descent, u: Unit) => {
  const door = exitSpot(run.layout);
  const fall = run.plunging ? DESCENT.plungeTime : DESCENT.fadeTime;
  sim.teleport(u, door.x, door.z);
  step(sim, run, fall + 0.2);
};

describe('Underworld Descent: the map', () => {
  it('lays out six chambers to each depth, none shared, that never touch, each open at both gates', () => {
    expect(CHAMBERS.length).toBe(18);
    expect(new Set(CHAMBERS.map((c) => c.name)).size).toBe(18);
    for (let d = 0; d < 3; d++) {
      const own = DEPTH_CHAMBERS[d]!;
      expect(own.halls.length).toBe(5);
      expect(CHAMBERS[own.boss]!.boss).toBe(true);
      for (const i of [...own.halls, own.boss]) expect(CHAMBERS[i]!.depth).toBe(d);
      // each depth's halls are each a different kind of hall, each dressed with its own landmark
      expect(new Set(own.halls.map((i) => CHAMBERS[i]!.plan)).size).toBe(5);
    }
    for (const c of CHAMBERS) {
      const e = entranceSpot(c);
      const x = exitSpot(c);
      expect(underworldField(e.x, e.z), c.name).toBeGreaterThan(1);
      expect(underworldField(x.x, x.z), c.name).toBeGreaterThan(0.6);
      // the team and its rivals all arrive on floor
      for (let i = 0; i < 7; i++) {
        const s = entranceSpot(c, i, 7, 2);
        expect(underworldField(s.x, s.z), c.name).toBeGreaterThan(0.7);
      }
      for (const s of c.spawns) expect(chamberField(c, s[0]!, s[1]!), c.name).toBeGreaterThan(1.2);
      expect(c.spawns.length, c.name).toBeGreaterThanOrEqual(6);
      expect(c.fires.length, c.name).toBeGreaterThanOrEqual(c.boss ? 8 : 5);
      expect(chamberField(c, c.hold[0], c.hold[1]), c.name).toBeGreaterThan(3.9);
      // the boss rises on floor
      if (c.boss) expect(chamberField(c, 0, -c.extent * 0.35), c.name).toBeGreaterThan(3);
      // the floor is cut by its depth's lava, water or void (the Abyss's halls are mostly void)
      let floor = 0;
      let cut = 0;
      for (let z = -c.extent; z <= c.extent; z += 1) {
        for (let x = -c.extent; x <= c.extent; x += 1) {
          if (c.sd(x, z) >= 0) floor++;
          else if (c.cave(x, z) >= 0) cut++;
        }
      }
      expect(cut / (floor + cut), c.name).toBeGreaterThan(c.depth === 2 ? 0.15 : 0.04);
    }
    // halfway between two neighbours is solid rock, and so is where no chamber is
    for (let i = 1; i < CHAMBERS.length; i++) {
      const a = CHAMBERS[i - 1]!;
      const b = CHAMBERS[i]!;
      if (Math.abs(a.z - b.z) > 1) continue;
      expect(underworldCave((a.x + b.x) / 2, a.z), `${a.name} | ${b.name}`).toBeLessThan(-5);
    }
    expect(underworldField(300, 300)).toBeLessThan(-5);
  });

  it('finds every way across a chamber over its bridges, never across the lava, water or void', () => {
    for (const c of CHAMBERS) {
      const nav = navOf(c);
      const e = entranceSpot(c);
      const goals = [exitSpot(c), { x: c.x + c.hold[0], z: c.z + c.hold[1] }, ...c.spawns.map(([x, z]) => ({ x: c.x + x, z: c.z + z }))];
      for (const g of goals) {
        const path = nav.path(e.x, e.z, g.x, g.z);
        for (let i = 1; i < path.length; i++) expect(nav.clear(path[i - 1]!.x, path[i - 1]!.z, path[i]!.x, path[i]!.z), `${c.name} to ${g.x - c.x}, ${g.z - c.z}`).toBe(true);
      }
    }
    // across the Slag Hall's channel by one of its bridges
    const slag = CHAMBERS.find((c) => c.name === 'The Slag Hall')!;
    const way = navOf(slag).path(slag.x, slag.z + 12, slag.x, slag.z - 12);
    expect(way.length).toBeGreaterThan(2);
    const crossing = way.find((p) => Math.abs(p.z - slag.z) < 3);
    expect(Math.abs(Math.abs((crossing ?? way[1]!).x - slag.x) - 8)).toBeLessThan(2.6);
    // and a clear line goes straight
    expect(navOf(slag).next(slag.x - 4, slag.z + 12, slag.x + 4, slag.z + 8)).toEqual({ x: slag.x + 4, z: slag.z + 8 });
  });
});

describe('Underworld Descent: the run', () => {
  it('plans fifteen chambers with a boss every fifth and no hall twice in a depth', () => {
    for (let seed = 1; seed < 40; seed++) {
      const plan = planRun(seeded(seed));
      expect(plan.length).toBe(DESCENT.chambers);
      expect(plan[0]!.kind).toBe('pack');
      for (const p of plan) expect(p.kind === 'boss').toBe(p.n % DESCENT.bossEvery === 0);
      for (let d = 0; d < 3; d++) {
        const halls = plan.slice(d * 5, d * 5 + 4).map((p) => p.layout);
        expect(new Set(halls).size).toBe(4);
        // only the depth's own halls, then its own master's arena
        for (const h of halls) expect(DEPTH_CHAMBERS[d]!.halls).toContain(h);
        expect(plan[d * 5 + 4]!.layout).toBe(DEPTH_CHAMBERS[d]!.boss);
        expect(plan.slice(d * 5, d * 5 + 5).filter((p) => p.kind === 'treasure').length).toBeLessThanOrEqual(1);
      }
      for (let i = 1; i < plan.length; i++) expect(plan[i]!.layout === plan[i - 1]!.layout && plan[i]!.kind !== 'boss').toBe(false);
    }
  });

  it('grows the monster packs deeper down, and every boss chamber has its boss', () => {
    const size = (n: number) => chamberWaves({ n, layout: 0, kind: 'pack' }).flat().length;
    expect(size(1)).toBeLessThan(size(6));
    expect(size(6)).toBeLessThanOrEqual(size(13));
    // each depth's own: the forge's smith, the Drowned Halls' great crab, the Abyss's king (the jungle's bosses stay in the jungle)
    expect(chamberWaves({ n: 5, layout: DEPTH_CHAMBERS[0]!.boss, kind: 'boss' })[0]).toContain('ashsmith');
    expect(chamberWaves({ n: 10, layout: DEPTH_CHAMBERS[1]!.boss, kind: 'boss' })[0]).toContain('tidemaw');
    for (const n of [5, 10, 15]) expect(chamberWaves({ n, layout: 0, kind: 'boss' }).flat()).not.toContain('treasureWyrm');
    for (const n of [5, 10, 15]) expect(chamberWaves({ n, layout: 0, kind: 'boss' }).flat()).not.toContain('moltenColossus');
    expect(chamberWaves({ n: 15, layout: DEPTH_CHAMBERS[2]!.boss, kind: 'boss' })[0]).toContain('ossuaryKing');
    expect(chamberWaves({ n: 4, layout: 0, kind: 'elite' })[0]).toContain('warden');
  });

  it('brings Shades only into the Abyss, never fewer deeper down', () => {
    const shades = (n: number) => chamberWaves({ n, layout: 0, kind: 'pack' }).flat().filter((t) => t === 'shade').length;
    for (let n = 1; n <= 2 * DESCENT.bossEvery; n++) expect(shades(n)).toBe(0);
    expect(shades(2 * DESCENT.bossEvery + 1)).toBeGreaterThan(0);
    expect(shades(14)).toBeGreaterThanOrEqual(shades(2 * DESCENT.bossEvery + 1));
  });

  it('blinks a Shade away from a god who closes in, onto open floor, but never while it is stunned', () => {
    const c = CHAMBERS[1]!;
    const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(4));
    const [sx, sz] = c.spawns[3]!;
    const shade = sim.add(monsterUnit(zeus, 'shade', { x: c.x + sx, z: c.z + sz, yaw: 0 }, 0));
    shade.tag = 'descent-small-6.0.0:shade';
    const camp = { camp: { id: 'shade', kind: 'small' as const, team: null, at: [shade.x, shade.z] as [number, number] }, members: [shade], respawnAt: null, foe: null };
    shade.brain = new DescentMonsterBrain(sim, shade, camp, c);
    const god = sim.add(godUnit(thor, 'order', { x: shade.x + 2, z: shade.z, yaw: 0 }));
    let hops = 0;
    sim.listeners.push((e) => {
      if (e.type === 'teleport' && e.unit === shade) hops++;
    });
    const run = (seconds: number) => {
      for (let i = 0; i < seconds * 30; i++) sim.step(1 / 30);
    };
    // it gets its bearings first, then goes
    run(SHADE_BLINK.first - 0.2);
    expect(hops).toBe(0);
    run(0.4);
    expect(hops).toBe(1);
    const away = () => Math.hypot(shade.x - god.x, shade.z - god.z);
    expect(away()).toBeGreaterThan(SHADE_BLINK.far - 0.5);
    expect(c.sd(shade.x - c.x, shade.z - c.z)).toBeGreaterThan(2);
    for (const [ox, oz, r] of obstaclesOf(c)) expect(Math.hypot(shade.x - ox, shade.z - oz)).toBeGreaterThan(r);
    // still in range of its bolts
    expect(away()).toBeLessThan(shade.combatant.god.basicAttack.range * 1.75);
    // closing in again too soon: it waits out its cooldown
    sim.teleport(god, shade.x + 2, shade.z);
    run(1);
    expect(hops).toBe(1);
    // a stunned Shade stays put
    shade.combatant.cc.apply('stun', SHADE_BLINK.every + 1);
    run(SHADE_BLINK.every);
    expect(hops).toBe(1);
    run(2);
    expect(hops).toBe(2);
  });

  it('brings Gravekeepers only into the Abyss, past the second boss', () => {
    const keepers = (n: number) => chamberWaves({ n, layout: 0, kind: 'pack' }).flat().filter((t) => t === 'gravekeeper').length;
    for (let n = 1; n <= 2 * DESCENT.bossEvery; n++) expect(keepers(n)).toBe(0);
    expect(keepers(2 * DESCENT.bossEvery + 1)).toBeGreaterThan(0);
    expect(keepers(14)).toBeGreaterThan(keepers(2 * DESCENT.bossEvery + 1));
  });

  it('has a Gravekeeper mend the most hurt monster near it, never itself, and not while stunned; it backs away from gods', () => {
    const c = CHAMBERS[1]!;
    const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(5));
    const [sx, sz] = c.spawns[3]!;
    const brained = (type: 'gravekeeper' | 'thornback', x: number, z: number, i: number) => {
      const m = sim.add(monsterUnit(zeus, type, { x, z, yaw: 0 }, 0));
      m.tag = `descent-small-11.0.${i}:${type}`;
      const camp = { camp: { id: `m${i}`, kind: 'small' as const, team: null, at: [x, z] as [number, number] }, members: [m], respawnAt: null, foe: null };
      m.brain = new DescentMonsterBrain(sim, m, camp, c);
      return m;
    };
    const keeper = brained('gravekeeper', c.x + sx, c.z + sz, 0);
    const scratched = brained('thornback', keeper.x + 4, keeper.z, 1);
    const mauled = brained('thornback', keeper.x - 4, keeper.z, 2);
    const far = brained('thornback', keeper.x, keeper.z + KEEPER.range + 4, 3);
    const hp = (m: Unit) => m.combatant.health / m.combatant.stats.maxHealth;
    scratched.combatant.health = scratched.combatant.stats.maxHealth * 0.8;
    mauled.combatant.health = mauled.combatant.stats.maxHealth * 0.3;
    far.combatant.health = far.combatant.stats.maxHealth * 0.1;
    keeper.combatant.health = keeper.combatant.stats.maxHealth * 0.2;
    const mends: Unit[] = [];
    sim.listeners.push((e) => {
      if (e.type === 'heal' && e.source === keeper) mends.push(e.target);
    });
    const run = (seconds: number) => {
      for (let i = 0; i < seconds * 30; i++) sim.step(1 / 30);
    };
    run(KEEPER.first + 0.1);
    // the worst hurt within its reach, not the one out of reach, and never itself
    expect(mends).toEqual([mauled]);
    expect(hp(mauled)).toBeCloseTo(0.3 + KEEPER.share, 2);
    expect(hp(far)).toBeCloseTo(0.1, 5);
    expect(hp(keeper)).toBeCloseTo(0.2, 5);
    run(KEEPER.every);
    expect(mends).toEqual([mauled, mauled]);
    // stunned, the lantern stays dark
    keeper.combatant.cc.apply('stun', KEEPER.every * 2);
    run(KEEPER.every * 2 - 0.2);
    expect(mends).toHaveLength(2);
    // (it looks for a patient again a few times a second)
    run(1);
    expect(mends).toHaveLength(3);
    // a god walks up: it backs off
    const god = sim.add(godUnit(thor, 'order', { x: keeper.x + 2.5, z: keeper.z, yaw: 0 }));
    const gap = () => Math.hypot(keeper.x - god.x, keeper.z - god.z);
    const start = gap();
    run(1);
    expect(gap()).toBeGreaterThan(start + 1);
    expect(c.sd(keeper.x - c.x, keeper.z - c.z)).toBeGreaterThan(0);
  });

  it("gives the Ashen Depths beasts of its own: Cinderlings swarm and Slag Brutes anchor the packs, and they never leave the forge", () => {
    const kinds: ChamberKind[] = ['pack', 'trap', 'elite', 'champion', 'treasure'];
    const raised = (from: number, to: number) => {
      const out = new Set<string>();
      for (let n = from; n <= to; n++) for (const kind of kinds) for (const t of chamberWaves({ n, layout: 0, kind }).flat()) out.add(t);
      return out;
    };
    const forge = raised(1, DESCENT.bossEvery - 1);
    expect(forge.has('cinderling')).toBe(true);
    expect(forge.has('slagBrute')).toBe(true);
    expect(forge.has('thornback')).toBe(false);
    expect(forge.has('thornbackAlpha')).toBe(false);
    // the first chamber is all swarm and spit; the heavies come in from the fourth
    expect(chamberWaves({ n: 1, layout: 0, kind: 'pack' }).flat().filter((t) => t === 'cinderling').length).toBeGreaterThanOrEqual(3);
    expect(chamberWaves({ n: 1, layout: 0, kind: 'pack' }).flat()).not.toContain('slagBrute');
    expect(chamberWaves({ n: 4, layout: 0, kind: 'pack' }).flat()).toContain('slagBrute');
    expect(chamberWaves({ n: 3, layout: 0, kind: 'champion' })[0]![0]).toBe('slagBrute');
    const deeper = raised(DESCENT.bossEvery + 1, DESCENT.chambers);
    expect(deeper.has('cinderling')).toBe(false);
    expect(deeper.has('slagBrute')).toBe(false);
  });

  it('bursts a fallen Cinderling into flame where it fell, after a moment to get clear, burning the gods in it', () => {
    const { sim, run, team } = setup([zeus, thor], 2, 7);
    step(sim, run, DESCENT.enterTime + 2.5);
    const imp = run.monsters.find((m) => m.alive && m.tag.endsWith(':cinderling'))!;
    expect(imp).toBeDefined();
    const before = run.eruptions.length;
    sim.strike(team[0]!, imp, 1e7, 'true');
    const burst = run.eruptions.slice(before).find((e) => e.r === CINDER.radius)!;
    expect(burst).toBeDefined();
    expect(Math.hypot(burst.x - imp.x, burst.z - imp.z)).toBeLessThan(0.01);
    expect(burst.left).toBe(CINDER.warn);
    expect(burst.share).toBe(CINDER.damage);
    // Thor stands in it; what soul fire burns him is the burst (a pack's other bursts may land on him too)
    const burnt = new Map<Unit, number>();
    sim.listeners.push((e) => {
      if (e.type === 'damage' && e.source === null && e.target.kind === 'god') burnt.set(e.target, (burnt.get(e.target) ?? 0) + e.amount);
    });
    const god = team[1]!;
    sim.teleport(god, burst.x, burst.z, undefined, true);
    for (const m of run.monsters) m.combatant.cc.apply('stun', 5);
    step(sim, run, CINDER.warn - 0.3);
    expect(burnt.get(god) ?? 0).toBe(0);
    sim.teleport(god, burst.x, burst.z, undefined, true);
    step(sim, run, 0.4);
    expect(run.eruptions).not.toContain(burst);
    const c = god.combatant;
    expect(burnt.get(god) ?? 0).toBeGreaterThanOrEqual(c.stats.maxHealth * CINDER.damage * (1 - Math.min(0.9, c.stats.damageReduction)) * 0.99);
  });

  it("winds up a Slag Brute's slam only with a god close, its circle on the ground, and lands it on every god inside; its warning goes if it dies first", () => {
    const c = CHAMBERS[1]!;
    const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(6));
    const [sx, sz] = c.spawns[3]!;
    const brute = sim.add(monsterUnit(zeus, 'slagBrute', { x: c.x + sx, z: c.z + sz, yaw: 0 }, 0));
    brute.tag = 'descent-small-4.0.0:slagBrute';
    const camp = { camp: { id: 'brute', kind: 'small' as const, team: null, at: [brute.x, brute.z] as [number, number] }, members: [brute], respawnAt: null, foe: null };
    const brain = new DescentMonsterBrain(sim, brute, camp, c);
    brute.brain = brain;
    // rooted, so it can't walk up to the god itself
    brute.combatant.cc.apply('root', 60);
    const near = sim.add(godUnit(thor, 'order', { x: brute.x + 14, z: brute.z, yaw: 0 }));
    const far = sim.add(godUnit(zeus, 'order', { x: brute.x + BRUTE.radius + 3.5, z: brute.z + 1, yaw: 0 }));
    const run = (seconds: number) => {
      for (let i = 0; i < seconds * 30; i++) sim.step(1 / 30);
    };
    const warning = () => sim.flashes.find((f) => f.owner === brute && f.warn);
    // the gods are all out of reach: its slam waits
    sim.teleport(far, brute.x + 14, brute.z + 3, undefined, true);
    run(6);
    expect(brain.specialProgress).toBe(0);
    expect(warning()).toBeUndefined();
    // a god comes close: it raises its fists, the circle it will strike on the ground under them
    sim.teleport(far, brute.x + BRUTE.radius + 3.5, brute.z + 1, undefined, true);
    sim.teleport(near, brute.x + 2.2, brute.z, undefined, true);
    run(1 / 15);
    expect(brain.specialProgress).toBeGreaterThan(0);
    const w = warning()!;
    expect(w).toBeDefined();
    expect(w.act).toBe('special');
    expect(w.shape).toMatchObject({ type: 'circle', radius: BRUTE.radius });
    expect(Math.hypot((w.shape as { x: number }).x - brute.x, (w.shape as { z: number }).z - brute.z)).toBeLessThan(0.01);
    const hit = new Set<Unit>();
    sim.listeners.push((e) => {
      if (e.type === 'damage' && e.source === brute) hit.add(e.target);
    });
    run(BRUTE.windup + 0.1);
    expect(brain.specialProgress).toBe(0);
    expect(warning()).toBeUndefined();
    expect(sim.flashes.some((f) => f.owner === brute && !f.warn && f.shape.type === 'circle')).toBe(true);
    expect(hit.has(near)).toBe(true);
    expect(hit.has(far)).toBe(false);
    // the next one: it falls mid-windup, and its warning goes with it
    near.combatant.health = near.combatant.stats.maxHealth;
    for (let guard = 0; guard < 400 && !warning(); guard++) run(1 / 30);
    expect(warning()).toBeDefined();
    sim.strike(near, brute, 1e7, 'true');
    run(1 / 15);
    expect(warning()).toBeUndefined();
  });

  it("gives the Drowned Halls beasts of its own: Drowned Thralls, Lantern Jellies and Tide Lurkers, found nowhere else", () => {
    const kinds: ChamberKind[] = ['pack', 'trap', 'elite', 'champion', 'treasure'];
    const raised = (from: number, to: number) => {
      const out = new Set<string>();
      for (let n = from; n <= to; n++) for (const kind of kinds) for (const t of chamberWaves({ n, layout: 0, kind }).flat()) out.add(t);
      return out;
    };
    const drowned = raised(DESCENT.bossEvery + 1, 2 * DESCENT.bossEvery - 1);
    for (const t of ['drownedThrall', 'lanternJelly', 'tideLurker']) expect(drowned.has(t), t).toBe(true);
    for (const t of ['thornback', 'thornbackAlpha', 'thornSpitter', 'cinderling', 'slagBrute', 'shade', 'gravekeeper']) expect(drowned.has(t), t).toBe(false);
    const elsewhere = new Set([...raised(1, DESCENT.bossEvery - 1), ...raised(2 * DESCENT.bossEvery + 1, DESCENT.chambers - 1)]);
    for (const t of ['drownedThrall', 'lanternJelly', 'tideLurker']) expect(elsewhere.has(t), t).toBe(false);
  });

  it('gives the Abyss beasts of its own: Gravehounds, Packleaders and Shades, with no Thornbacks left anywhere', () => {
    const kinds: ChamberKind[] = ['pack', 'trap', 'elite', 'champion', 'treasure'];
    const raised = (from: number, to: number) => {
      const out = new Set<string>();
      for (let n = from; n <= to; n++) for (const kind of kinds) for (const t of chamberWaves({ n, layout: 0, kind }).flat()) out.add(t);
      return out;
    };
    const abyss = raised(2 * DESCENT.bossEvery + 1, DESCENT.chambers - 1);
    for (const t of ['gravehound', 'packleader', 'shade', 'gravekeeper']) expect(abyss.has(t), t).toBe(true);
    for (const t of ['thornback', 'thornbackAlpha', 'thornSpitter', 'cinderling', 'slagBrute', 'drownedThrall', 'lanternJelly', 'tideLurker']) expect(abyss.has(t), t).toBe(false);
    const above = raised(1, 2 * DESCENT.bossEvery - 1);
    for (const t of ['gravehound', 'packleader', 'thornback', 'thornbackAlpha']) expect(above.has(t), t).toBe(false);
  });

  /** One Descent beast on its own in a chamber, fighting for real. */
  const loose = (sim: Sim, type: 'drownedThrall' | 'tideLurker' | 'gravehound' | 'packleader', x: number, z: number) => {
    const c = CHAMBERS[7]!;
    const m = sim.add(monsterUnit(zeus, type, { x, z, yaw: 0 }, 0));
    m.tag = `descent-small-7.0.0:${type}`;
    const camp = { camp: { id: type, kind: 'small' as const, team: null, at: [x, z] as [number, number] }, members: [m], respawnAt: null, foe: null };
    const brain = new DescentMonsterBrain(sim, m, camp, c);
    m.brain = brain;
    return { m, brain, c };
  };

  it("slows the god a Drowned Thrall's blows land on", () => {
    const { sim, run, team } = setup([thor], 1, 9);
    const c = CHAMBERS[7]!;
    const [sx, sz] = c.spawns[2]!;
    const { m } = loose(sim, 'drownedThrall', c.x + sx, c.z + sz);
    const god = team[0]!;
    sim.teleport(god, m.x + 1.6, m.z, undefined, true);
    god.brain = null;
    const before = sim.moveSpeed(god);
    let hit = false;
    sim.listeners.push((e) => {
      if (e.type === 'damage' && e.source === m && e.target === god) hit = true;
    });
    for (let i = 0; i < 90 && !hit; i++) {
      run.step(1 / 30);
      sim.step(1 / 30);
    }
    expect(hit).toBe(true);
    expect(sim.moveSpeed(god)).toBeLessThan(before * (1 - GRIP.slow * 0.8));
  });

  it('sends a Tide Lurker under the floor out of reach, up beside its foe behind a warning circle, and bursts it up into every god there; stunned, it stays up', () => {
    const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(12));
    const c = CHAMBERS[7]!;
    const [sx, sz] = c.spawns[2]!;
    const { m, brain } = loose(sim, 'tideLurker', c.x + sx, c.z + sz);
    // the god across the chamber from it, too far to reach on foot before it dives
    const [fx, fz] = [...c.spawns].sort((a, b) => Math.hypot(b[0] - sx, b[1] - sz) - Math.hypot(a[0] - sx, a[1] - sz))[0]!;
    const god = sim.add(godUnit(thor, 'order', { x: c.x + fx, z: c.z + fz, yaw: 0 }));
    god.brain = null;
    const far = Math.hypot(god.x - m.x, god.z - m.z);
    const run = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds * 30); i++) sim.step(1 / 30);
    };
    expect(far).toBeGreaterThan(18);
    run(LURK.first - 0.3);
    expect(brain.lurkState).toBe('up');
    expect(m.targetable).toBe(true);
    run(0.4);
    expect(brain.lurkState).toBe('under');
    expect(m.targetable).toBe(false);
    // nothing touches it down there
    const hp = m.combatant.health;
    sim.strike(god, m, 1e5, 'true');
    expect(m.combatant.health).toBe(hp);
    // it comes up beside the god, its circle on the ground first
    for (let i = 0; i < 30 * LURK.under + 10 && brain.lurkState === 'under'; i++) run(1 / 30);
    expect(brain.lurkState).toBe('rising');
    const w = sim.flashes.find((f) => f.owner === m && f.warn && f.act === 'special')!;
    expect(w).toBeDefined();
    expect(w.shape).toMatchObject({ type: 'circle', radius: LURK.radius });
    expect(Math.hypot(god.x - m.x, god.z - m.z)).toBeLessThan(LURK.radius);
    let struck = 0;
    sim.listeners.push((e) => {
      if (e.type === 'damage' && e.source === m && e.target === god) struck++;
    });
    god.move = null;
    run(LURK.warn + 0.1);
    expect(brain.lurkState).toBe('up');
    expect(m.targetable).toBe(true);
    expect(struck).toBeGreaterThan(0);
    // stunned when its time comes round again, it can't go under
    m.combatant.cc.apply('stun', LURK.up + 2);
    run(LURK.up + 1);
    expect(brain.lurkState).toBe('up');
    run(1.5);
    // (right beside the god already, it goes straight from under to rising)
    expect(brain.lurkState).not.toBe('up');
    expect(m.targetable).toBe(false);
  });

  it('crouches a Gravehound, then pounces it onto a god who stands off from it, biting where it lands; stunned, it can\'t', () => {
    const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(4));
    const c = CHAMBERS[7]!;
    const [sx, sz] = c.spawns[2]!;
    const { m, brain } = loose(sim, 'gravehound', c.x + sx, c.z + sz);
    // the god a few strides off, along a clear line
    const nav = navOf(c);
    let [gx, gz] = [m.x + 5, m.z];
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      [gx, gz] = [m.x + Math.cos(a) * 5, m.z + Math.sin(a) * 5];
      if (nav.clear(m.x, m.z, gx, gz) && nav.room(gx, gz) > 1.2) break;
    }
    const god = sim.add(godUnit(thor, 'order', { x: gx, z: gz, yaw: 0 }));
    god.brain = null;
    const run = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds * 30); i++) {
        god.move = null;
        sim.step(1 / 30);
      }
    };
    let struck = 0;
    sim.listeners.push((e) => {
      if (e.type === 'damage' && e.source === m && e.target === god) struck++;
    });
    // held down past its first pounce's time, it neither crouches nor leaps
    m.combatant.cc.apply('stun', POUNCE.first + 0.5);
    run(POUNCE.first + 0.4);
    expect(brain.gathering).toBe(0);
    expect(brain.loosed).toBe(0);
    // free again: it crouches, then flies at the god
    run(0.2);
    expect(brain.gathering).toBeGreaterThan(0);
    expect(m.forced).toBeNull();
    run(POUNCE.crouch);
    expect(brain.loosed).toBe(1);
    expect(m.forced).not.toBeNull();
    run(0.7);
    expect(m.forced).toBeNull();
    expect(struck).toBeGreaterThan(0);
    expect(Math.hypot(god.x - m.x, god.z - m.z)).toBeLessThan(POUNCE.radius + god.radius);
  });

  it('has a Packleader howl once a god comes near, hastening itself and the Gravehounds round it; silenced, it can\'t', () => {
    const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(5));
    const c = CHAMBERS[7]!;
    const [sx, sz] = c.spawns[2]!;
    const { m: lead, brain } = loose(sim, 'packleader', c.x + sx, c.z + sz);
    const { m: hound } = loose(sim, 'gravehound', c.x + sx + 1.2, c.z + sz);
    const god = sim.add(godUnit(thor, 'order', { x: lead.x + 4, z: lead.z, yaw: 0 }));
    god.brain = null;
    const run = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds * 30); i++) {
        god.move = null;
        god.combatant.health = god.combatant.stats.maxHealth;
        sim.step(1 / 30);
      }
    };
    run(HOWL.first - 0.2);
    expect(brain.loosed).toBe(0);
    for (let i = 0; i < 60 && brain.loosed === 0; i++) run(1 / 30);
    expect(brain.loosed).toBe(1);
    expect(hound.combatant.stats.bonusMoveSpeed).toBeGreaterThanOrEqual(HOWL.haste - 1e-6);
    expect(hound.combatant.stats.bonusAttackSpeed).toBeGreaterThanOrEqual(HOWL.frenzy - 1e-6);
    expect(lead.combatant.stats.bonusMoveSpeed).toBeGreaterThanOrEqual(HOWL.haste - 1e-6);
    // silenced when its next howl comes round, it stays quiet
    lead.combatant.cc.apply('silence', HOWL.every + 1);
    run(HOWL.every + 0.5);
    expect(brain.loosed).toBe(1);
  });

  it('crowns the bottom of the run with the Ossuary King: Soul Rain under every god, never while stunned, faster when hurt; a Grave Toll; Shades among its adds', () => {
    const { sim, run, team } = setup([zeus, thor], 2, 11);
    const jump = run as unknown as { chamber: number; nextChamber(): void };
    jump.chamber = DESCENT.chambers - 1;
    jump.nextChamber();
    step(sim, run, DESCENT.enterTime + 0.1);
    // its entrance: the chamber holds still, and the rain's clock waits for it
    expect(run.intro).toBeGreaterThan(DESCENT.bossIntro - 0.2);
    step(sim, run, DESCENT.bossIntro);
    expect(run.intro).toBe(0);
    const k = run.boss!;
    expect(k.name).toBe('Ossuary King');
    expect(k.tag.endsWith(':ossuaryKing')).toBe(true);
    // only the rain can hurt for now: the King stands still and the gods stand clear of it
    const brain = k.brain as DescentMonsterBrain;
    k.brain = null;
    k.move = null;
    const place = () => team.forEach((g, i) => {
      g.combatant.health = g.combatant.stats.maxHealth;
      sim.teleport(g, k.x + (i ? 6 : -6), k.z + 10);
    });
    place();
    const under = (g: Unit) => run.eruptions.some((e) => Math.hypot(e.x - g.x, e.z - g.z) < 1.5);
    let newest = 0;
    /** Seconds until the King next calls the rain, or null if it doesn't within `limit`. */
    const nextRain = (limit: number, each?: () => void): number | null => {
      for (let i = 1; i <= Math.round(limit * 30); i++) {
        team.forEach((g) => (g.combatant.health = g.combatant.stats.maxHealth));
        each?.();
        step(sim, run, 1 / 30);
        const id = Math.max(0, ...run.eruptions.map((e) => e.id));
        if (id > newest) {
          newest = id;
          return i / 30;
        }
      }
      return null;
    };
    // (the rain's clock starts as the King rises, a moment into the fight)
    expect(nextRain(KING.rain.first + 1)).toBeGreaterThan(KING.rain.first - 0.3);
    for (const g of team) expect(under(g)).toBe(true);
    expect(run.eruptions.length).toBeLessThanOrEqual(team.length + KING.rain.extra);
    // stunned, it can't; freed, it calls the rain at once
    k.combatant.cc.apply('stun', 60);
    expect(nextRain(KING.rain.every + 2)).toBe(null);
    k.combatant.cc.cleanse();
    place();
    expect(nextRain(1)).not.toBe(null);
    for (const g of team) expect(under(g)).toBe(true);
    // badly hurt, the rain after next comes sooner
    const low = () => (k.combatant.health = k.combatant.stats.maxHealth * (KING.enrage - 0.05));
    expect(nextRain(KING.rain.every + 0.5, low)).toBeCloseTo(KING.rain.every, 0);
    expect(nextRain(KING.rain.every + 0.5, low)).toBeCloseTo(KING.rain.enraged, 0);
    // the Grave Toll: a windup, then a ring of the toll's size around it
    k.brain = brain;
    let wound = false;
    let ring = false;
    for (let i = 0; i < 30 * (KING.toll.every + 3) && !ring; i++) {
      team.forEach((g) => (g.combatant.health = g.combatant.stats.maxHealth));
      step(sim, run, 1 / 30);
      if (brain.specialProgress > 0) wound = true;
      ring = sim.flashes.some((f) => f.owner === k && f.shape.type === 'circle' && f.shape.radius === KING.toll.radius);
    }
    expect(wound).toBe(true);
    expect(ring).toBe(true);
    // its adds (called as it weakens, which the hurt check above already did) bring Shades of its court, never a healer
    const adds = run.monsters.map((m) => m.tag.split(':')[1]);
    expect(adds).toContain('shade');
    expect(adds).not.toContain('gravekeeper');
  });

  /** The team taken to the `n`th chamber (a boss's) and through its boss's entrance. */
  const bossFight = (n: number) => {
    const { sim, run, team } = setup([zeus, thor], 2, 11);
    const jump = run as unknown as { chamber: number; nextChamber(): void };
    jump.chamber = n - 1;
    jump.nextChamber();
    step(sim, run, DESCENT.enterTime + 0.1 + DESCENT.bossIntro);
    expect(run.intro).toBe(0);
    const b = run.boss!;
    const full = () => team.forEach((g) => (g.combatant.health = g.combatant.stats.maxHealth));
    return { sim, run, team, b, brain: b.brain as DescentMonsterBrain, full };
  };

  it("raises the Ashsmith at the bottom of the Ashen Depths: cracks of fire run out at the nearest gods over the floor, never while it's stunned, faster once it's hurt; a Hammerfall behind its circle", () => {
    const { sim, run, team, b, brain, full } = bossFight(DESCENT.bossEvery);
    const F = ASHSMITH.fissure;
    expect(b.name).toBe('Ashsmith');
    expect(brain.bossKey).toBe('ashsmith');
    const c = run.layout;
    /** Seconds until it next cracks the floor (or null), and the cracks it sent, with where it stood. */
    const nextCrack = (limit: number, each?: () => void) => {
      const was = run.fissures;
      const newest = Math.max(0, ...run.eruptions.map((e) => e.id));
      let gathered = false;
      for (let i = 1; i <= Math.round(limit * 30); i++) {
        full();
        each?.();
        step(sim, run, 1 / 30);
        if (brain.gathering > 0) gathered = true;
        if (run.fissures > was) return { at: i / 30, gathered, cracks: run.eruptions.filter((e) => e.id > newest && e.r === F.radius), from: { x: b.x, z: b.z } };
      }
      return null;
    };
    const first = nextCrack(F.first + 3)!;
    expect(first).not.toBe(null);
    expect(first.gathered).toBe(true);
    expect(first.cracks.length).toBeGreaterThan(2);
    // each burst lies on a line from it toward one of the gods, a step at a time, over the floor
    for (const e of first.cracks) {
      expect(c.sd(e.x - c.x, e.z - c.z)).toBeGreaterThan(0.5);
      expect(e.share).toBe(F.damage);
      const off = Math.min(
        ...team.map((g) => {
          const [dx, dz] = [g.x - first.from.x, g.z - first.from.z];
          const d = Math.hypot(dx, dz);
          return Math.abs((e.x - first.from.x) * (dz / d) - (e.z - first.from.z) * (dx / d));
        }),
      );
      expect(off).toBeLessThan(0.8);
    }
    // (they burst one after another down the line, the nearest first)
    const lefts = first.cracks.map((e) => e.left).sort((p, q) => p - q);
    expect(lefts[lefts.length - 1]! - lefts[0]!).toBeGreaterThan(F.travel);
    // a god standing on a crack is burned as it bursts
    const g = team[0]!;
    const e0 = first.cracks[0]!;
    sim.teleport(g, e0.x, e0.z);
    const hp = (g.combatant.health = g.combatant.stats.maxHealth);
    for (let i = 0; i < 30 * 1.5; i++) {
      [g.body.x, g.body.z, g.move] = [e0.x, e0.z, null];
      step(sim, run, 1 / 30);
    }
    expect(g.combatant.health).toBeLessThan(hp);
    // stunned, it can't; free again, hurt, the next comes sooner than its usual pace
    b.combatant.cc.apply('stun', 60);
    expect(nextCrack(F.every + 2)).toBe(null);
    b.combatant.cc.cleanse();
    const low = () => (b.combatant.health = b.combatant.stats.maxHealth * (ASHSMITH.enrage - 0.05));
    expect(nextCrack(F.every + 2, low)).not.toBe(null);
    expect(nextCrack(F.every + 2, low)!.at).toBeLessThan(F.every - 1.5);
    // its Hammerfall: the circle on the ground through the windup, then the blow
    let warned = false;
    let fell = false;
    // (its clock runs only between its blows and cracks)
    for (let i = 0; i < 30 * (2 * ASHSMITH.slam.every + 4) && !fell; i++) {
      full();
      step(sim, run, 1 / 30);
      if (sim.flashes.some((f) => f.owner === b && f.warn && f.act === 'special' && f.shape.type === 'circle' && f.shape.radius === ASHSMITH.slam.radius)) warned = true;
      fell = sim.flashes.some((f) => f.owner === b && !f.warn && f.shape.type === 'circle' && f.shape.radius === ASHSMITH.slam.radius);
    }
    expect(warned).toBe(true);
    expect(fell).toBe(true);
    // its adds are the forge's own
    expect(run.monsters.map((m) => m.tag.split(':')[1])).toContain('cinderling');
  });

  it('raises the Tidemaw at the bottom of the Drowned Halls: it dives out of reach and the tide comes in with it, then bursts up under its foe behind a circle, stunning every god there; a Claw Crush', () => {
    const { sim, run, team, b, brain, full } = bossFight(2 * DESCENT.bossEvery);
    const D = TIDEMAW.dive;
    expect(b.name).toBe('Tidemaw');
    expect(brain.bossKey).toBe('tidemaw');
    // (the gods stand together, out of its reach)
    const [g0, g1] = team as [Unit, Unit];
    let crushed = false;
    const until = (limit: number, done: () => boolean) => {
      for (let i = 0; i < Math.round(limit * 30) && !done(); i++) {
        full();
        for (const g of team) g.move = null;
        step(sim, run, 1 / 30);
        if (sim.flashes.some((f) => f.owner === b && !f.warn && f.shape.type === 'circle' && f.shape.radius === TIDEMAW.crush.radius)) crushed = true;
      }
      return done();
    };
    sim.teleport(g0, b.x + 14, b.z + 6);
    sim.teleport(g1, b.x + 15, b.z + 7);
    expect(until(D.first + 4, () => brain.lurkState === 'under')).toBe(true);
    expect(b.targetable).toBe(false);
    const hp = b.combatant.health;
    sim.strike(g0, b, 1e5, 'true');
    expect(b.combatant.health).toBe(hp);
    // the tide comes in with it
    step(sim, run, 1 / 30);
    expect(run.hazards.tide).toBeGreaterThanOrEqual(HAZARDS.tide.calm);
    // up beneath its foe, its circle on the ground first
    expect(until(D.under + 1, () => brain.lurkState === 'rising')).toBe(true);
    const w = sim.flashes.find((f) => f.owner === b && f.warn && f.act === 'special')!;
    expect(w.shape).toMatchObject({ type: 'circle', radius: D.radius });
    const foe = [g0, g1].sort((p, q) => Math.hypot(p.x - b.x, p.z - b.z) - Math.hypot(q.x - b.x, q.z - b.z))[0]!;
    expect(Math.hypot(foe.x - b.x, foe.z - b.z)).toBeLessThan(D.radius);
    let struck = 0;
    sim.listeners.push((e) => {
      if (e.type === 'damage' && e.source === b && team.includes(e.target)) struck++;
    });
    expect(until(D.warn + 0.5, () => brain.lurkState === 'up')).toBe(true);
    expect(b.targetable).toBe(true);
    expect(struck).toBeGreaterThan(0);
    expect(foe.combatant.cc.locks().move).toBe(true);
    // and its Claw Crush, sooner or later
    until(TIDEMAW.crush.every + 4, () => crushed);
    expect(crushed).toBe(true);
  });

  it('starts every god with one skill, the rest sealed', () => {
    const { team } = setup([zeus, thor]);
    for (const g of team) {
      expect(g.combatant.level).toBe(DESCENT.startLevel);
      expect(g.combatant.canCast(0)).toBe(null);
      for (const s of Descent.SEALED) expect(g.combatant.canCast(s)).toBe('locked');
    }
  });

  it('puts the team at the gate, raises the first chamber, and offers three rewards once it is cleared', () => {
    const { sim, run, team } = setup([zeus, thor], 1);
    const c = run.layout;
    for (const g of team) expect(Math.abs(g.z - (c.z + c.extent))).toBeLessThan(6);
    step(sim, run, DESCENT.enterTime + 0.1);
    expect(run.phase).toBe('fight');
    expect(run.monsters.length).toBeGreaterThan(0);
    for (const m of run.monsters) {
      expect(m.tag).toMatch(/^descent-[a-zA-Z]+-1\.w1\.\d+:[a-zA-Z]+$/);
      expect(chamberField(c, m.x - c.x, m.z - c.z)).toBeGreaterThan(0);
    }
    const xp = team[0]!.combatant.xp;
    clear(sim, run, team[0]!);
    expect(run.phase).toBe('reward');
    expect(run.offer!.length).toBe(3);
    expect(new Set(run.offer!.map((r) => r.name)).size).toBe(3);
    // the first chamber always offers a new skill
    expect(run.offer!.some((r) => r.kind === 'skill')).toBe(true);
    expect(team[0]!.combatant.xp).toBeGreaterThan(xp);
  });

  it('lets the humans vote: the bots on the team never do, and the vote closes when every human has voted', () => {
    const { sim, run, team } = setup([zeus, thor, odin], 2);
    reachReward(sim, run, team[0]!);
    expect(run.vote(team[2]!, 1)).toBe(true);
    run.vote(team[0]!, 2);
    step(sim, run, 0.1);
    expect(run.phase).toBe('reward');
    run.vote(team[1]!, 2);
    step(sim, run, 0.1);
    expect(run.phase).not.toBe('reward');
    expect(run.lastReward).not.toBe(null);
  });

  it('closes an unanswered vote on its own', () => {
    const { sim, run, team } = setup([zeus], 1);
    reachReward(sim, run, team[0]!);
    step(sim, run, DESCENT.voteTime + 0.2);
    expect(run.phase).not.toBe('reward');
  });

  it('teaches a new skill through a draft, never twice and never an ultimate in a regular slot', () => {
    for (const god of GODS) {
      const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(3));
      const u = sim.add(godUnit(god, 'order', { x: 0, z: 0, yaw: 0 }));
      const run = new Descent(sim, zeus);
      run.addGod(u, true);
      const rng = seeded(11);
      for (let k = 0; k < 3; k++) {
        const d = draftFor(u, rng)!;
        expect(d.options.length).toBe(3);
        expect(d.slot).toBe(Descent.SEALED[k]);
        for (const s of d.options) expect(s.kind).toBe(d.slot === ULTIMATE_SLOT ? 'ultimate' : 'regular');
        learnSkill(u, d.slot, d.options[k % 3]!);
        const ids = u.combatant.loadout;
        expect(new Set(ids).size).toBe(4);
        expect(ids[d.slot]).toBe(d.options[k % 3]!.id);
        for (const s of ALL_SLOTS) expect(skillById(god, ids[s]!)).toBeTruthy();
      }
      expect(u.combatant.sealed.size).toBe(0);
      expect(draftFor(u, rng)).toBe(null);
    }
  });

  it('runs the reward into a draft for every god, bots drafting at once', () => {
    const { sim, run, team } = setup([zeus, thor], 1);
    reachReward(sim, run, team[0]!);
    const skill = run.offer!.findIndex((r) => r.kind === 'skill');
    run.vote(team[0]!, skill);
    step(sim, run, 0.1);
    expect(run.phase).toBe('draft');
    expect(run.drafts.has(team[0]!)).toBe(true);
    expect(run.drafts.has(team[1]!)).toBe(false);
    expect(team[1]!.combatant.sealed.has(1)).toBe(false);
    run.draft(team[0]!, 2);
    step(sim, run, 0.1);
    expect(team[0]!.combatant.canCast(1)).not.toBe('locked');
    expect(run.phase).toBe('exit');
  });

  it('takes the team down when a human walks into the exit gate', () => {
    const { sim, run, team } = setup([zeus, thor], 1);
    reachReward(sim, run, team[0]!);
    settle(sim, run);
    expect(run.phase).toBe('exit');
    // a bot walking in does nothing while a human leads
    const door = exitSpot(run.layout);
    sim.teleport(team[1]!, door.x, door.z);
    step(sim, run, 0.3);
    expect(run.phase).toBe('exit');
    walkOut(sim, run, team[0]!);
    expect(run.chamber).toBe(2);
    expect(run.phase).toBe('enter');
    const c = run.layout;
    for (const g of team) expect(Math.abs(g.z - (c.z + c.extent - 3.5))).toBeLessThan(2);
  });

  it('pulls the team down on its own when nobody walks in', () => {
    const { sim, run, team } = setup([zeus], 1);
    reachReward(sim, run, team[0]!);
    settle(sim, run);
    step(sim, run, DESCENT.exitPull + DESCENT.fadeTime + 0.3);
    expect(run.chamber).toBe(2);
  });

  it('leaves a fallen god down until an ally stands over them', () => {
    const { sim, run, team } = setup([zeus, thor], 1);
    step(sim, run, DESCENT.enterTime + 0.1);
    const [a, b] = team as [Unit, Unit];
    sim.teleport(b, a.x + 10, a.z);
    a.combatant.takeDamage(1e7);
    step(sim, run, 10);
    expect(a.alive).toBe(false);
    expect(a.downed).toBe(true);
    expect(run.downed.has(a)).toBe(true);
    const lay = { x: a.x, z: a.z };
    sim.teleport(b, a.x + 1.5, a.z);
    step(sim, run, run.reviveTime + 0.3);
    expect(a.alive).toBe(true);
    expect(a.downed).toBe(false);
    // up where they fell, with part of their health
    expect(Math.hypot(a.x - lay.x, a.z - lay.z)).toBeLessThan(0.5);
    expect(a.combatant.health / a.combatant.stats.maxHealth).toBeLessThan(DESCENT.revive.health + 0.15);
  });

  it('ends the run when every god is down at once, unless an obol lifts them', () => {
    const { sim, run, team } = setup([zeus, thor], 1);
    step(sim, run, DESCENT.enterTime + 0.1);
    run.obols = 1;
    for (const g of team) g.combatant.takeDamage(1e7);
    step(sim, run, 0.5);
    expect(run.phase).toBe('fight');
    expect(run.obolUsed).toBe(1);
    for (const g of team) expect(g.alive).toBe(true);
    for (const g of team) g.combatant.takeDamage(1e7);
    step(sim, run, 0.5);
    expect(run.phase).toBe('lost');
    expect(run.over).toBe(true);
  });

  it('brings the fallen along to the next chamber', () => {
    const { sim, run, team } = setup([zeus, thor], 1);
    reachReward(sim, run, team[0]!);
    team[1]!.combatant.takeDamage(1e7);
    step(sim, run, 0.2);
    // the heal card would raise them; pick anything else
    const pick = run.offer!.findIndex((r) => r.kind !== 'heal');
    run.vote(team[0]!, pick);
    step(sim, run, 0.1);
    settle(sim, run);
    expect(team[1]!.alive).toBe(false);
    walkOut(sim, run, team[0]!);
    step(sim, run, 0.2);
    expect(team[1]!.alive).toBe(true);
    const share = team[1]!.combatant.health / team[1]!.combatant.stats.maxHealth;
    expect(share).toBeCloseTo(DESCENT.returnHealth, 1);
  });

  it('erupts soul fire under the gods in a trap room', () => {
    const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(5));
    const plan = planRun(seeded(5));
    plan[0] = { n: 1, layout: 0, kind: 'trap' };
    const run = new Descent(sim, zeus, plan);
    const u = sim.add(godUnit(zeus, 'order', { x: 0, z: 0, yaw: 0 }));
    run.addGod(u, true);
    run.begin();
    step(sim, run, DESCENT.enterTime + 0.1);
    // monsters elsewhere, so only the fire can hurt
    for (const m of run.monsters) m.brain = null;
    const before = u.combatant.health;
    step(sim, run, 5);
    expect(run.erupting).toBe(true);
    expect(u.combatant.health).toBeLessThan(before);
  });

  /** A run whose first chamber is the given challenge, in the given hall, with Zeus at its gate and the fight begun. */
  const challenge = (kind: ChamberKind, layout: number) => {
    const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(9));
    const plan = planRun(seeded(9));
    plan[0] = { n: 1, layout, kind };
    const run = new Descent(sim, zeus, plan);
    const god = sim.add(godUnit(zeus, 'order', { x: 0, z: 0, yaw: 0 }));
    run.addGod(god, true);
    run.begin();
    step(sim, run, DESCENT.enterTime + 0.1);
    expect(run.phase).toBe('fight');
    return { sim, run, god };
  };
  /** Strikes down every beast but the forges, as if the team were mopping them up. */
  const mop = (sim: Sim, run: Descent, by: Unit) => {
    for (const m of [...run.monsters]) if (m.alive && !run.forges.includes(m)) sim.strike(by, m, 1e7, 'true');
  };

  it("plans each depth's own challenge chamber: soul forges in the Ashen Depths, the flood in the Drowned Halls, grave bells in the Abyss", () => {
    const byDepth = [new Set<ChamberKind>(), new Set<ChamberKind>(), new Set<ChamberKind>()];
    for (let seed = 1; seed < 60; seed++) for (const c of planRun(seeded(seed))) byDepth[Math.floor((c.n - 1) / DESCENT.bossEvery)]!.add(c.kind);
    expect(DEPTH_CHALLENGE).toEqual(['forges', 'flood', 'bells']);
    byDepth.forEach((kinds, d) => {
      expect(kinds.has(DEPTH_CHALLENGE[d]!), `depth ${d}`).toBe(true);
      for (const other of [...DEPTH_CHALLENGE.filter((k) => k !== DEPTH_CHALLENGE[d]), 'trap' as const]) expect(kinds.has(other), `depth ${d} ${other}`).toBe(false);
    });
  });

  it('stands every challenge on broad open floor in every hall, spread across it', () => {
    for (const c of CHAMBERS.filter((k) => !k.boss)) {
      const spots = challengeSpots(c);
      expect(spots, c.name).toHaveLength(3);
      for (const [x, z] of spots) {
        expect(c.sd(x, z), c.name).toBeGreaterThan(1.9);
        expect(c.brink(x, z), c.name).toBeGreaterThan(2.4);
        for (const [px, pz, r] of c.pillars) expect(Math.hypot(x - px, z - pz), c.name).toBeGreaterThan(r + 2);
      }
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(Math.hypot(spots[i]![0] - spots[j]![0], spots[i]![1] - spots[j]![1]), c.name).toBeGreaterThan(6);
      expect(challengeSpots(c)).toBe(spots);
    }
  });

  it('builds three soul forges that stand their ground and breathe out Cinderlings until each is smashed, bursting as it goes', () => {
    const { sim, run, god } = challenge('forges', DEPTH_CHAMBERS[0]!.halls[0]!);
    const c = run.layout;
    expect(run.forges).toHaveLength(CHALLENGE.forges.count);
    const at = run.forges.map((f) => [f.x, f.z]);
    for (const f of run.forges) {
      expect(f.blocks).toBe(true);
      expect(f.combatant.ccImmune).toBe(true);
      // its mouth toward where the team holds
      const face = Math.atan2(-(c.x + c.hold[0] - f.x), -(c.z + c.hold[1] - f.z));
      expect(Math.abs(Math.atan2(Math.sin(f.body.yaw - face), Math.cos(f.body.yaw - face)))).toBeLessThan(0.01);
    }
    const born = new Set<Unit>();
    for (let i = 0; i < 40; i++) {
      step(sim, run, 0.5);
      for (const m of run.monsters) if (m.tag.includes('.b.')) born.add(m);
      mop(sim, run, god);
      god.combatant.health = god.combatant.stats.maxHealth;
    }
    // every forge breathed some out, each out of its own mouth, and none moved
    expect(born.size).toBeGreaterThanOrEqual(CHALLENGE.forges.count * 2);
    for (const m of born) expect(run.forges.some((f) => Math.hypot(m.home.x - f.x, m.home.z - f.z) < f.radius + 1)).toBe(true);
    run.forges.forEach((f, i) => expect(Math.hypot(f.x - at[i]![0]!, f.z - at[i]![1]!)).toBeLessThan(0.01));
    expect(run.phase).toBe('fight');
    // smashed, each bursts into flame where it stood, and breathes no more
    for (const f of run.forges) sim.strike(god, f, 1e7, 'true');
    for (const f of run.forges) expect(run.eruptions.some((e) => Math.hypot(e.x - f.x, e.z - f.z) < 0.01 && e.r === CHALLENGE.burst.radius)).toBe(true);
    mop(sim, run, god);
    const before = born.size;
    step(sim, run, CHALLENGE.forges.every * 2);
    for (const m of run.monsters) if (m.tag.includes('.b.')) born.add(m);
    expect(born.size).toBe(before);
    clear(sim, run, god);
    expect(run.phase).toBe('reward');
  });

  it('holds a flood chamber until its time runs out, the drowned rising all along, then drains it and everything in it', () => {
    const { sim, run, god } = challenge('flood', DEPTH_CHAMBERS[1]!.halls[0]!);
    expect(run.floodLeft).toBeCloseTo(CHALLENGE.flood.time - 0.1, 1);
    expect(run.challengeDone).toBe(false);
    let risen = 0;
    const seen = new Set<Unit>();
    // the water comes in for the second half, and stays at the full
    let low = 1;
    for (let t = 0; t < CHALLENGE.flood.time - 6; t += 0.5) {
      step(sim, run, 0.5);
      if (run.floodLeft < CHALLENGE.flood.surge - 4) low = Math.min(low, run.hazards.flood);
      for (const m of run.monsters) {
        if (!m.tag.includes('.c.') || seen.has(m)) continue;
        seen.add(m);
        risen++;
      }
      mop(sim, run, god);
      god.combatant.health = god.combatant.stats.maxHealth;
    }
    // cleared out over and over, the chamber still isn't done: the water keeps bringing them
    expect(risen).toBeGreaterThanOrEqual(8);
    expect(low).toBe(1);
    expect(run.phase).toBe('fight');
    // left standing at the end, they go down with the water, to the god for the kill
    step(sim, run, 4);
    const standing = run.monsters.filter((m) => m.alive);
    expect(standing.length).toBeGreaterThan(0);
    const kills = run.kills;
    god.combatant.health = god.combatant.stats.maxHealth;
    step(sim, run, run.floodLeft + 0.2);
    expect(run.floodLeft).toBe(0);
    expect(standing.every((m) => !m.alive)).toBe(true);
    expect(run.kills).toBeGreaterThanOrEqual(kills + standing.length);
    step(sim, run, 0.2);
    expect(run.phase).toBe('reward');
    // and the water goes out with them
    step(sim, run, 6);
    expect(run.hazards.flood).toBe(0);
  });

  it('rings a grave bell under a god who stands by it (slower with a beast beside it too), and tolls it: the dark falls back, the beasts round it reel, the gods are mended', () => {
    const { sim, run, god } = challenge('bells', DEPTH_CHAMBERS[2]!.halls[0]!);
    expect(run.bells).toHaveLength(CHALLENGE.bells.count);
    const [b0, b1, b2] = run.bells;
    // nobody near: nothing rings
    for (const m of run.monsters) [m.brain, m.move] = [null, null];
    const far = (b: { x: number; z: number }) => run.monsters.every((m) => !m.alive || Math.hypot(m.x - b.x, m.z - b.z) > CHALLENGE.bells.radius + 1);
    step(sim, run, 1);
    expect(run.bells.every((b) => b.rung === 0)).toBe(true);
    // a beast at the bell holds it back
    const beast = run.monsters[0]!;
    [beast.body.x, beast.body.z] = [b0!.x + 1, b0!.z];
    [god.body.x, god.body.z] = [b0!.x - 0.5, b0!.z];
    god.move = null;
    step(sim, run, 1);
    expect(b0!.rung).toBeCloseTo(CHALLENGE.bells.held / CHALLENGE.bells.ring, 1);
    // the beast gone, it rings at full pace and tolls: the dark creeping in is pushed back, the beasts near it stunned
    mop(sim, run, god);
    const near = sim.add(monsterUnit(zeus, 'gravehound', { x: b0!.x + CHALLENGE.bells.stagger - 1.5, z: b0!.z, yaw: 0 }, 0));
    run.monsters.push(near);
    run.hazards.dark = 3;
    god.combatant.health = god.combatant.stats.maxHealth * 0.5;
    const tolls = run.tolls;
    // (held there: the Abyss's crumbling floor would throw the god off it)
    const left = CHALLENGE.bells.ring * (1 - b0!.rung) + 0.1;
    let mended = 0;
    for (let t = 0; t < left; t += 0.1) {
      [god.body.x, god.body.z, god.forced] = [b0!.x - 0.5, b0!.z, null];
      const [was, rang] = [god.combatant.health, run.tolls];
      step(sim, run, 0.1);
      if (run.tolls > rang) mended = god.combatant.health - was;
      for (const m of run.monsters) if (m !== near && m.alive) sim.strike(god, m, 1e7, 'true');
    }
    expect(b0!.rung).toBe(1);
    expect(run.tolls).toBe(tolls + 1);
    expect(run.rung).toBe(1);
    expect(run.hazards.dark).toBeLessThan(0.5);
    expect(near.combatant.cc.locks().move).toBe(true);
    // and its soul fire mends the gods
    expect(mended).toBeGreaterThan(god.combatant.stats.maxHealth * CHALLENGE.bells.heal * 0.8);
    // the others too, then the rest cleared: the chamber is won, and nothing more rises once all three have tolled
    for (const b of [b1!, b2!]) {
      for (let t = 0; t < CHALLENGE.bells.ring + 0.1; t += 0.1) {
        [god.body.x, god.body.z, god.forced] = [b.x, b.z, null];
        mop(sim, run, god);
        expect(far(b)).toBe(true);
        step(sim, run, 0.1);
      }
      expect(b.rung).toBe(1);
    }
    expect(run.challengeDone).toBe(true);
    // a guest hangs the same bells, rung as far
    const guest = new Descent(new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(1)), zeus);
    guest.applyNet(run.netState());
    expect(guest.bells.map((b) => [b.x, b.z, b.rung])).toEqual(run.bells.map((b) => [b.x, b.z, b.rung]));
    expect(guest.tolls).toBe(run.tolls);
    clear(sim, run, god);
    expect(run.phase).toBe('reward');
  });

  it('stacks a new curse at each of its chambers', () => {
    const { sim, run, team } = setup([zeus], 1);
    let seen = 0;
    for (let n = 1; n < 15 && !run.over; n++) {
      reachReward(sim, run, team[0]!);
      if (CURSE_AT.includes(n + 1)) expect(run.nextCurse).not.toBe(null);
      settle(sim, run);
      team[0]!.combatant.health = team[0]!.combatant.stats.maxHealth;
      walkOut(sim, run, team[0]!);
      seen = CURSE_AT.filter((k) => k <= n + 1).length;
      expect(run.curses.length).toBe(seen);
    }
    expect(new Set(run.curses.map((c) => c.id)).size).toBe(run.curses.length);
  });

  it('holds a boss chamber still while its boss rises: nothing acts, then the fight begins; a guest copy holds too', () => {
    const { sim, run, team } = setup([zeus, thor, odin], 1, 5);
    for (const g of team.slice(1)) g.brain = new DescentBot(sim, g, run);
    const jump = run as unknown as { chamber: number; nextChamber(): void };
    // an ordinary chamber has no entrance
    step(sim, run, DESCENT.enterTime + 0.1);
    expect(run.phase).toBe('fight');
    expect(run.intro).toBe(0);
    jump.chamber = DESCENT.bossEvery - 1;
    jump.nextChamber();
    step(sim, run, DESCENT.enterTime + 0.1);
    const boss = run.boss!;
    expect(run.intro).toBeGreaterThan(DESCENT.bossIntro - 0.2);
    const at = { x: boss.x, z: boss.z };
    const gods = team.map((g) => ({ x: g.x, z: g.z, hp: g.combatant.health }));
    const guest = new Descent(new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(1)), zeus);
    guest.applyNet(run.netState());
    expect(guest.intro).toBeCloseTo(run.intro, 1);
    step(sim, run, DESCENT.bossIntro - 0.3);
    expect(Math.hypot(boss.x - at.x, boss.z - at.z)).toBeLessThan(0.01);
    team.slice(1).forEach((g, i) => expect(Math.hypot(g.x - gods[i + 1]!.x, g.z - gods[i + 1]!.z)).toBeLessThan(0.01));
    team.forEach((g, i) => expect(g.combatant.health).toBe(gods[i]!.hp));
    // it turned to face the team as it rose
    const facing = Math.atan2(-(team[0]!.x - boss.x), -(team[0]!.z - boss.z));
    expect(Math.abs(Math.atan2(Math.sin(boss.body.yaw - facing), Math.cos(boss.body.yaw - facing)))).toBeLessThan(0.6);
    // then it comes for them, and the bots go to meet it
    step(sim, run, 2);
    expect(run.intro).toBe(0);
    expect(Math.hypot(boss.x - at.x, boss.z - at.z)).toBeGreaterThan(0.5);
    expect(team.slice(1).some((g, i) => Math.hypot(g.x - gods[i + 1]!.x, g.z - gods[i + 1]!.z) > 0.5)).toBe(true);
    // a guest runs the entrance down between snapshots, and the next one without it ends it
    guest.follow(1);
    expect(guest.intro).toBeLessThan(DESCENT.bossIntro - 0.9);
    guest.applyNet(run.netState());
    expect(guest.intro).toBe(0);
  });

  it("brings a boss's adds down with it and holds the chamber a moment before the reward; a guest copy holds too", () => {
    const { sim, run, team } = setup([zeus, thor, odin], 1, 5);
    for (const g of team.slice(1)) g.brain = new DescentBot(sim, g, run);
    const jump = run as unknown as { chamber: number; nextChamber(): void };
    jump.chamber = DESCENT.bossEvery - 1;
    jump.nextChamber();
    step(sim, run, DESCENT.enterTime + DESCENT.bossIntro + 0.2);
    const boss = run.boss!;
    expect(run.calls).toBe(0);
    // under both thresholds: it calls up both lots of adds
    boss.combatant.health = boss.combatant.stats.maxHealth * 0.3;
    step(sim, run, 0.5);
    expect(run.calls).toBe(DESCENT.bossAdds.length);
    const retinue = run.monsters.filter((m) => m.alive && m !== boss && m !== run.gilded);
    const adds = retinue.length;
    expect(adds).toBeGreaterThan(5);
    const kills = run.kills;
    expect(run.fall).toBe(0);
    // when each crumbles, and whether anything showed a hit on it
    const died = new Map<Unit, number>();
    let hits = 0;
    sim.listeners.push((e) => {
      if (e.type === 'death' && retinue.includes(e.unit)) died.set(e.unit, sim.time);
      if (e.type === 'damage' && retinue.includes(e.target)) hits++;
    });
    sim.strike(team[0]!, boss, 1e9, 'true');
    const at = { x: boss.x, z: boss.z };
    step(sim, run, 0.1);
    expect(run.fall).toBeGreaterThan(DESCENT.bossFall - 0.2);
    expect(run.phase).toBe('fight');
    step(sim, run, DESCENT.bossFall * 0.6);
    expect(run.monsters.filter((m) => m.alive && m !== run.gilded)).toHaveLength(0);
    expect(run.kills).toBe(kills + 1 + adds);
    // a wave out from where it fell, nearest first, with no hits to show
    expect(hits).toBe(0);
    const order = [...retinue].sort((p, q) => Math.hypot(p.x - at.x, p.z - at.z) - Math.hypot(q.x - at.x, q.z - at.z));
    for (let i = 1; i < order.length; i++) expect(died.get(order[i]!)!).toBeGreaterThanOrEqual(died.get(order[i - 1]!)!);
    expect(died.get(order.at(-1)!)! - died.get(order[0]!)!).toBeGreaterThan(0.1);
    const guest = new Descent(new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(1)), zeus);
    guest.applyNet(run.netState());
    expect(guest.fall).toBeCloseTo(run.fall, 1);
    expect(guest.calls).toBe(DESCENT.bossAdds.length);
    // the team holds and watches it go down; then the reward comes
    const stood = team.map((g) => ({ x: g.x, z: g.z }));
    step(sim, run, DESCENT.bossFall * 0.4 - 0.4);
    expect(run.phase).toBe('fight');
    team.slice(1).forEach((g, i) => expect(Math.hypot(g.x - stood[i + 1]!.x, g.z - stood[i + 1]!.z)).toBeLessThan(0.01));
    step(sim, run, 0.4);
    expect(run.fall).toBe(0);
    expect(run.phase).toBe('reward');
    guest.follow(1);
    expect(guest.fall).toBeLessThan(DESCENT.bossFall - 0.9);
    guest.applyNet(run.netState());
    expect(guest.fall).toBe(0);
  });

  it('falls longer out of a master\'s chamber, into the next depth, than between chambers', () => {
    const { sim, run, team } = setup([zeus], 1);
    const seen: { from: number; fall: number }[] = [];
    for (let n = 1; n < DESCENT.chambers && !run.over && seen.length < 2 * DESCENT.bossEvery; n++) {
      reachReward(sim, run, team[0]!);
      settle(sim, run);
      team[0]!.combatant.health = team[0]!.combatant.stats.maxHealth;
      const from = run.chamber;
      const door = exitSpot(run.layout);
      sim.teleport(team[0]!, door.x, door.z);
      let fall = 0;
      for (let k = 0; k < 400 && run.chamber === from; k++) {
        step(sim, run, 1 / 30);
        if (run.phase === 'descend') fall += 1 / 30;
      }
      seen.push({ from, fall });
    }
    for (const { from, fall } of seen) {
      const deep = from % DESCENT.bossEvery === 0;
      expect(fall, `out of chamber ${from}`).toBeCloseTo(deep ? DESCENT.plungeTime : DESCENT.fadeTime, 1);
    }
    expect(seen.some((s) => s.from === DESCENT.bossEvery)).toBe(true);
  });

  it('wins the run when the last boss falls', () => {
    const { sim, run, team } = setup([zeus], 1);
    for (let n = 1; n <= 15 && !run.over; n++) {
      reachReward(sim, run, team[0]!);
      if (run.over) break;
      settle(sim, run);
      team[0]!.combatant.health = team[0]!.combatant.stats.maxHealth;
      walkOut(sim, run, team[0]!);
    }
    expect(run.phase).toBe('won');
    expect(run.cleared).toBe(15);
  });

  // three whole bot runs: more than the default timeout allows on a busy machine
  it('lets a team of bots play a run on its own, walls and all, with no chamber stalling', () => {
    for (let r = 0; r < 3; r++) {
      const walls = new CollisionWorld(() => 0);
      addUnderworldColliders(walls);
      const sim = new Sim(walls, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(200 + r));
      const run = new Descent(sim, zeus);
      for (const def of [thor, odin, GODS[3 + (r % 2)]!]) {
        const u = sim.add(godUnit(def, 'order', { x: 0, z: 0, yaw: 0 }));
        u.brain = new DescentBot(sim, u, run);
        run.addGod(u, false);
      }
      run.begin();
      let fighting = 0;
      for (let t = 0; t < 40 * 60 && !run.over; t += 1 / 30) {
        run.step(1 / 30);
        sim.step(1 / 30);
        sim.drainEvents();
        fighting = run.phase === 'fight' ? fighting + 1 / 30 : 0;
        // a chamber falls to bots in well under four minutes; the Ossuary King, the last and biggest boss, takes them two to four
        expect(fighting).toBeLessThan(run.chamber === DESCENT.chambers ? 360 : 240);
      }
      expect(run.over).toBe(true);
      expect(run.cleared).toBeGreaterThanOrEqual(3);
      for (const g of run.gods) expect(underworldField(g.x, g.z)).toBeGreaterThan(-0.2);
    }
  }, 20000);
});

describe('Underworld Descent: monster models built ahead', () => {
  /** Plays a chamber to its end (a boss worn down in steps, so it calls its adds) and lists every monster that rose, by tag and name. */
  const raised = (sim: Sim, run: Descent, by: Unit): string[] => {
    const seen = new Set<Unit>();
    step(sim, run, DESCENT.enterTime + 0.1);
    for (let guard = 0; guard < 160 && run.phase === 'fight'; guard++) {
      for (const m of run.monsters) seen.add(m);
      // a bell chamber: the god goes to stand by each bell in turn (the flood is waited out)
      const bell = run.bells.find((b) => b.rung < 1);
      if (bell) [by.body.x, by.body.z] = [bell.x, bell.z];
      for (const m of [...run.monsters]) {
        if (!m.alive) continue;
        const boss = run.boss === m;
        sim.strike(by, m, boss ? m.combatant.stats.maxHealth * 0.3 : 1e7, 'true');
      }
      step(sim, run, 0.4);
    }
    for (const m of run.monsters) seen.add(m);
    expect(run.phase).not.toBe('fight');
    return [...seen].map((m) => `${m.tag} ${m.name}`).sort();
  };

  it('knows every monster a chamber will raise before the first one rises, for every kind of chamber and the Swarm curse', () => {
    const kinds = new Set<string>();
    for (const seed of [3, 11, 5, 8]) {
      const { sim, run, team } = setup([zeus, thor, odin], 1, seed);
      const jump = run as unknown as { chamber: number; nextChamber(): void };
      for (let n = 1; n <= DESCENT.chambers; n++) {
        jump.chamber = n - 1;
        jump.nextChamber();
        if (seed === 11 && n === 7 && !run.curses.some((c) => c.swarm)) run.curses.push(CURSES.find((c) => c.swarm)!);
        for (const g of team) g.combatant.health = g.combatant.stats.maxHealth;
        const coming = run.upcoming().map((m) => `${m.tag} ${m.name}`).sort();
        const got = raised(sim, run, team[0]!);
        // a challenge chamber's forges, flood or bells keep raising more as long as it lasts: a chamber's worth is stocked,
        // and every one that rose is among them; anywhere else, exactly what rose
        if (!DEPTH_CHALLENGE.includes(run.current.kind)) expect(got).toEqual(coming);
        else {
          const left = [...coming];
          for (const m of got) {
            expect(left, m).toContain(m);
            left.splice(left.indexOf(m), 1);
          }
        }
        kinds.add(run.current.kind);
      }
    }
    expect([...kinds].sort()).toEqual(['bells', 'boss', 'champion', 'elite', 'flood', 'forges', 'pack', 'treasure']);
  });
});
