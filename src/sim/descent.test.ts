import { describe, expect, it } from 'vitest';
import { ULTIMATE_SLOT } from '../game/loadout';
import { GODS, odin, thor, zeus } from '../game/gods';
import { skillById } from '../game/loadout';
import { BOSS_CHAMBER, CHAMBERS, chamberField, entranceSpot, exitSpot, steer, underworldField, obstaclesOf } from '../map/UnderworldLayout';
import { ALL_SLOTS, chamberWaves, CURSE_AT, Descent, DESCENT, DescentMonsterBrain, draftFor, learnSkill, planRun, SHADE_BLINK } from './Descent';
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
    expect(chamberWaves({ n: 15, layout: BOSS_CHAMBER, kind: 'boss' })[0]).toContain('treasureWyrm');
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
