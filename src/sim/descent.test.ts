import { describe, expect, it } from 'vitest';
import { ULTIMATE_SLOT } from '../game/loadout';
import { GODS, odin, thor, zeus } from '../game/gods';
import { skillById } from '../game/loadout';
import { BOSS_CHAMBER, CHAMBERS, chamberField, entranceSpot, exitSpot, steer, underworldField, obstaclesOf } from '../map/UnderworldLayout';
import { ALL_SLOTS, chamberWaves, CURSE_AT, Descent, DESCENT, DescentMonsterBrain, draftFor, KEEPER, KING, learnSkill, planRun, SHADE_BLINK } from './Descent';
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
  sim.teleport(u, door.x, door.z);
  step(sim, run, DESCENT.fadeTime + 0.2);
};

describe('Underworld Descent: the map', () => {
  it('lays out six chambers that never touch, each open at both gates', () => {
    expect(CHAMBERS.length).toBe(6);
    expect(CHAMBERS[BOSS_CHAMBER]!.boss).toBe(true);
    for (const c of CHAMBERS) {
      const e = entranceSpot(c);
      const x = exitSpot(c);
      expect(underworldField(e.x, e.z)).toBeGreaterThan(1);
      expect(underworldField(x.x, x.z)).toBeGreaterThan(0.6);
      // the chamber's middle is floor unless it is the lava pit
      expect(underworldField(c.x, c.z) > 0).toBe(!c.pit);
      for (const s of c.spawns) expect(chamberField(c, s[0]!, s[1]!)).toBeGreaterThan(1.2);
    }
    // halfway between two neighbours is solid rock
    expect(underworldField(-47.5, -55)).toBeLessThan(-5);
    expect(underworldField(0, 0)).toBeLessThan(-5);
  });

  it('steers a walker around a column or the pit in its way', () => {
    const pit = CHAMBERS.find((c) => c.pit)!;
    const obs = obstaclesOf(pit);
    const from = { x: pit.x, z: pit.z + 15 };
    const to = { x: pit.x, z: pit.z - 15 };
    const p = steer(obs, from.x, from.z, to.x, to.z, 0.6);
    expect(Math.abs(p.x - pit.x)).toBeGreaterThan(pit.pit! + 0.6);
    // a clear line goes straight
    expect(steer(obs, pit.x + 18, pit.z, pit.x + 18, pit.z - 5, 0.6)).toEqual({ x: pit.x + 18, z: pit.z - 5 });
  });
});

describe('Underworld Descent: the run', () => {
  it('plans fifteen chambers with a boss every fifth and no hall twice in a depth', () => {
    for (let seed = 1; seed < 40; seed++) {
      const plan = planRun(seeded(seed));
      expect(plan.length).toBe(DESCENT.chambers);
      expect(plan[0]!.kind).toBe('pack');
      for (const p of plan) expect(p.kind === 'boss').toBe(p.n % DESCENT.bossEvery === 0);
      for (const p of plan) if (p.kind === 'boss') expect(p.layout).toBe(BOSS_CHAMBER);
      for (let d = 0; d < 3; d++) {
        const halls = plan.slice(d * 5, d * 5 + 4).map((p) => p.layout);
        expect(new Set(halls).size).toBe(4);
        expect(plan.slice(d * 5, d * 5 + 5).filter((p) => p.kind === 'treasure').length).toBeLessThanOrEqual(1);
      }
      for (let i = 1; i < plan.length; i++) expect(plan[i]!.layout === plan[i - 1]!.layout && plan[i]!.kind !== 'boss').toBe(false);
    }
  });

  it('grows the monster packs deeper down, and every boss chamber has its boss', () => {
    const size = (n: number) => chamberWaves({ n, layout: 0, kind: 'pack' }).flat().length;
    expect(size(1)).toBeLessThan(size(6));
    expect(size(6)).toBeLessThanOrEqual(size(13));
    expect(chamberWaves({ n: 5, layout: BOSS_CHAMBER, kind: 'boss' })[0]).toContain('treasureWyrm');
    expect(chamberWaves({ n: 10, layout: BOSS_CHAMBER, kind: 'boss' })[0]).toContain('moltenColossus');
    expect(chamberWaves({ n: 15, layout: BOSS_CHAMBER, kind: 'boss' })[0]).toContain('ossuaryKing');
    expect(chamberWaves({ n: 4, layout: 0, kind: 'elite' })[0]).toContain('warden');
  });

  it('brings Shades only past the first boss, more of them deeper down', () => {
    const shades = (n: number) => chamberWaves({ n, layout: 0, kind: 'pack' }).flat().filter((t) => t === 'shade').length;
    for (let n = 1; n <= DESCENT.bossEvery; n++) expect(shades(n)).toBe(0);
    expect(shades(DESCENT.bossEvery + 1)).toBeGreaterThan(0);
    expect(shades(14)).toBeGreaterThan(shades(DESCENT.bossEvery + 1));
  });

  it('blinks a Shade away from a god who closes in, onto open floor, but never while it is stunned', () => {
    const c = CHAMBERS[1]!;
    const sim = new Sim(flat, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, seeded(4));
    const [sx, sz] = c.spawns[3]!;
    const shade = sim.add(monsterUnit(zeus, 'shade', { x: c.x + sx, z: c.z + sz, yaw: 0 }, 0));
    shade.tag = 'descent-small-6.0.0:shade';
    const camp = { camp: { id: 'shade', kind: 'small' as const, team: null, at: [shade.x, shade.z] as [number, number] }, members: [shade], respawnAt: null, foe: null };
    shade.brain = new DescentMonsterBrain(sim, shade, camp, obstaclesOf(c), c);
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
      m.brain = new DescentMonsterBrain(sim, m, camp, obstaclesOf(c), c);
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
        expect(fighting).toBeLessThan(240);
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
    for (let guard = 0; guard < 80 && run.phase === 'fight'; guard++) {
      for (const m of run.monsters) seen.add(m);
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
        expect(raised(sim, run, team[0]!)).toEqual(coming);
        kinds.add(run.current.kind);
      }
    }
    expect([...kinds].sort()).toEqual(['boss', 'champion', 'elite', 'pack', 'trap', 'treasure']);
  });
});
