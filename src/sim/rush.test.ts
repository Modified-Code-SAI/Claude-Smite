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

  it('a throw that comes down loose by the gate it went at is a near miss; one in midfield is not', () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const c = god(sim, thor, 'chaos', 0);
    rush.begin([a, c]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(c, 20, 20);
    const pickUp = () => {
      sim.teleport(a, rush.relic.x, rush.relic.z);
      run(sim, rush, 0.6, () => rush.holder === a);
      expect(rush.holder).toBe(a);
      run(sim, rush, RUSH.relic.holdMin + 0.05);
    };
    // midfield: just loose
    pickUp();
    sim.teleport(a, 0, -4);
    expect(rush.throwRelic(a, { x: 8, z: -4 })).toBe(true);
    run(sim, rush, 3, () => rush.relic.phase === 'loose');
    expect(rush.relic.phase).toBe('loose');
    expect(rush.beats.miss).toBe(0);
    // wide of the chaos gate (order attacks it), out past the mouth a shot must go through
    pickUp();
    sim.teleport(a, 7, -14);
    const gate = RUSH.gates.chaos;
    expect(rush.throwRelic(a, { x: gate.x + 6, z: gate.z + 1.5 })).toBe(true);
    run(sim, rush, 3, () => rush.relic.phase === 'loose');
    expect(rush.relic.phase).toBe('loose');
    expect(rush.score.order).toBe(0);
    expect(Math.hypot(rush.relic.x - gate.x, rush.relic.z - gate.z)).toBeLessThanOrEqual(RUSH.nearMiss);
    expect(rush.beats.miss).toBe(1);
    expect(rush.lastBeat?.kind).toBe('miss');
    expect(rush.lastBeat?.unit).toBe(a);
    const guest = match();
    guest.rush.join([god(guest.sim, zeus, 'order', 0), god(guest.sim, thor, 'chaos', 0)]);
    guest.rush.applyNet(JSON.parse(JSON.stringify(rush.netState())));
    expect(guest.rush.beats.miss).toBe(1);
    expect(guest.rush.lastBeat?.kind).toBe('miss');
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

  it('a juke sidesteps the carrier, beats a stun in its guard, keeps the relic, and waits out its cooldown', () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const t = god(sim, thor, 'chaos', 0);
    const mate = god(sim, odin, 'order', 1);
    rush.begin([a, t, mate]);
    run(sim, rush, RUSH.countdown + 0.1);
    // only the carrier can juke
    expect(rush.juke(mate, { x: 1, z: 0 })).toBe(false);
    sim.teleport(a, 0, 1.6);
    run(sim, rush, 0.2);
    expect(rush.holder).toBe(a);
    sim.teleport(t, 0, 3.6, 0);
    t.aim.x = a.x;
    t.aim.z = a.z;
    const slot = t.combatant.loadout.indexOf('thor.mjolnir-slam');
    const x0 = a.x;
    const beats = rush.beats.juke;
    // a juke as the slam lands: it moves the carrier, and the stun can't land in its guard
    expect(rush.juke(a, { x: 1, z: 0 })).toBe(true);
    expect(rush.beats.juke).toBe(beats + 1);
    expect(rush.lastJuke).toBe(a);
    expect(sim.cast(t, slot)).toBeNull();
    run(sim, rush, RUSH.juke.time + 0.05);
    expect(a.x - x0).toBeCloseTo(RUSH.juke.distance, 0);
    expect(rush.holder).toBe(a);
    expect(rush.lines.get(t)!.tackles).toBe(0);
    // the slam it beat is called as a dodge, Thor's tackle juked
    expect(rush.beats.dodge).toBe(1);
    expect(rush.lastBeat).toEqual({ kind: 'dodge', unit: a, by: t });
    // the guard ends on time
    run(sim, rush, RUSH.juke.guard);
    expect(rush.isJuking(a)).toBe(false);
    expect(a.combatant.ccImmune).toBe(false);
    // and the juke waits out its cooldown
    expect(rush.jukeLeft(a)).toBeGreaterThan(RUSH.juke.cooldown - 1);
    expect(rush.juke(a, { x: -1, z: 0 })).toBe(false);
    // a guest sees how long until it's ready, and who juked
    const guest = match();
    const gods = [god(guest.sim, zeus, 'order', 0), god(guest.sim, thor, 'chaos', 0), god(guest.sim, odin, 'order', 1)];
    guest.rush.join(gods);
    guest.rush.applyNet(JSON.parse(JSON.stringify(rush.netState())));
    expect(guest.rush.jukeLeft(gods[0]!)).toBeCloseTo(rush.jukeLeft(a), 1);
    expect(guest.rush.lastJuke).toBe(gods[0]);
    expect(guest.rush.beats.juke).toBe(rush.beats.juke);
    expect(guest.rush.beats.dodge).toBe(1);
    expect(guest.rush.lastBeat).toEqual({ kind: 'dodge', unit: gods[0], by: gods[1] });
    // without a juke, the same slam knocks it loose
    const left = rush.jukeLeft(a);
    run(sim, rush, left + 0.1);
    t.combatant.resetCooldowns();
    sim.teleport(t, a.x, a.z + 2, 0);
    t.aim.x = a.x;
    t.aim.z = a.z;
    expect(sim.cast(t, slot)).toBeNull();
    run(sim, rush, 0.05);
    expect(rush.holder).toBeNull();
    // (and no dodge is called for it)
    expect(rush.beats.dodge).toBe(1);
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

  it('tells what each goal did to the score', () => {
    const { rush } = match();
    const story = (team: 'order' | 'chaos', order: number, chaos: number) => {
      rush.score.order = order;
      rush.score.chaos = chaos;
      rush.lastGoal = { team, scorer: null as never, assist: null, kind: 'dunk', at: 0 };
      return rush.goalStory;
    };
    expect(story('order', 1, 0)).toBe('opener');
    expect(story('chaos', 1, 1)).toBe('level');
    expect(story('chaos', 1, 2)).toBe('lead');
    expect(story('chaos', 1, 3)).toBe('extend');
    expect(story('order', 2, 3)).toBe('back');
    rush.lastGoal = null;
    expect(rush.goalStory).toBeNull();
  });

  it("a god's third goal is a hat trick, and a guest sees it too", () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const t = god(sim, thor, 'chaos', 0);
    rush.begin([a, t]);
    const hats: boolean[] = [];
    for (let k = 0; k < 3; k++) {
      run(sim, rush, RUSH.countdown + 0.1, () => rush.phase === 'play');
      sim.teleport(a, 0, 1.6);
      run(sim, rush, 0.4, () => rush.holder === a);
      sim.teleport(a, 0, RUSH.gates.chaos.z);
      run(sim, rush, 0.05);
      expect(rush.score.order).toBe(k + 1);
      hats.push(rush.hatTrick);
      run(sim, rush, RUSH.celebrate + 0.1, () => rush.phase === 'kickoff');
    }
    expect(hats).toEqual([false, false, true]);
    // 3-0: the first opened it, and each after stretched the lead
    expect(rush.goalStory).toBe('extend');
    const guest = match();
    const gods = [god(guest.sim, zeus, 'order', 0), god(guest.sim, thor, 'chaos', 0)];
    guest.rush.join(gods);
    guest.rush.applyNet(JSON.parse(JSON.stringify(rush.netState())));
    expect(guest.rush.hatTrick).toBe(true);
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
    const moves: { unit: Unit; quiet?: boolean }[] = [];
    sim.listeners.push((e) => e.type === 'teleport' && moves.push(e));
    run(sim, rush, RUSH.celebrate + 0.1);
    expect(rush.phase).toBe('kickoff');
    expect(rush.relic.phase).toBe('center');
    expect(a.z).toBeCloseTo(RUSH.kickoff.order[0]!.z, 1);
    // the reset happens under the HUD's dip to dark, so it raises no teleport flashes
    expect(moves.map((m) => m.unit)).toContain(a);
    expect(moves.every((m) => m.quiet)).toBe(true);
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

  it('the throw preview calls a shot on target exactly when the throw would score', () => {
    const gz = RUSH.gates.chaos.z;
    const calls: string[] = [];
    let wrong = 0;
    let onTarget = 0;
    for (const [x, z] of [[0, -6], [0, -12], [0, -18], [-7, -13], [8, -16], [3, -21], [0, 4]] as const) {
      for (const aim of [{ x: 0, z: gz }, { x: 2.6, z: gz }, { x: -3.6, z: gz }, { x: 0, z: gz - 9 }, { x: 0, z: gz + 3 }, { x: 9, z: gz }]) {
        const { sim, rush } = match();
        const a = god(sim, loki, 'order', 0);
        rush.begin([a]);
        run(sim, rush, RUSH.countdown + 0.1);
        sim.teleport(a, x, z);
        Object.assign(rush.relic, { phase: 'loose', x, z });
        run(sim, rush, 0.4);
        expect(rush.holder).toBe(a);
        const called = rush.shotOnTarget(a, aim);
        expect(rush.throwRelic(a, aim)).toBe(true);
        run(sim, rush, 3, () => rush.phase !== 'play');
        const scored = rush.score.order === 1;
        if (called) onTarget++;
        if (called !== scored) {
          wrong++;
          calls.push(`from ${x},${z} at ${aim.x},${aim.z}: called ${called}, scored ${scored}`);
        }
      }
    }
    expect(calls).toEqual([]);
    expect(wrong).toBe(0);
    // the grid has both kinds of throw in it
    expect(onTarget).toBeGreaterThan(5);
    expect(onTarget).toBeLessThan(36);
  });

  it('the pass read names who catches a throw: a teammate, an enemy cutting it off, a keeper, or nobody', () => {
    const gz = RUSH.gates.chaos.z;
    const wrong: string[] = [];
    const seen = { mate: 0, foe: 0, goal: 0, none: 0 };
    const spots = [[0, -10], [-6, -14], [5, -18], [0, gz + 2], [-3, -4], [9, -8]] as const;
    for (const [mx, mz] of spots) {
      // the enemy elsewhere, off the pitch, or on the line: just short of the teammate, or right in front of the thrower
      const d = Math.hypot(mx, mz - 2);
      const along = (k: number) => [(mx * k) / d, 2 + ((mz - 2) * k) / d] as const;
      for (const [fx, fz] of [...spots, [30, 0], along(d - 1.6), along(2.2)] as const) {
        for (const moving of [false, true]) {
          const { sim, rush } = match();
          const a = god(sim, loki, 'order', 0);
          const mate = god(sim, thor, 'order', 1);
          const foe = god(sim, anubis, 'chaos', 0);
          rush.begin([a, mate, foe]);
          run(sim, rush, RUSH.countdown + 0.1);
          sim.teleport(a, 0, 2);
          sim.teleport(mate, mx, mz);
          sim.teleport(foe, fx, fz);
          Object.assign(rush.relic, { phase: 'loose', x: 0, z: 2 });
          run(sim, rush, 0.4);
          expect(rush.holder).toBe(a);
          if (moving) {
            mate.move = { x: 0.6, z: -0.8 };
            foe.move = { x: -1, z: 0 };
            run(sim, rush, 0.3);
          }
          {
            const aim = { x: mate.x, z: mate.z };
            const read = rush.passRead(a, aim);
            expect(rush.throwRelic(a, aim)).toBe(true);
            run(sim, rush, 3, () => rush.phase !== 'play' || rush.relic.phase !== 'flying');
            const goal = rush.score.order === 1;
            const caught = rush.relic.phase === 'held' ? rush.holder : null;
            const said = read.goal ? 'goal' : read.catcher?.name ?? 'nobody';
            const was = goal ? 'goal' : caught?.name ?? 'nobody';
            seen[read.goal ? 'goal' : read.catcher === mate ? 'mate' : read.catcher === foe ? 'foe' : 'none']++;
            if (said !== was) wrong.push(`mate ${mx},${mz} foe ${fx},${fz}${moving ? ' moving' : ''}: read ${said}, was ${was}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    // the grid has every kind of outcome in it
    expect(seen.mate).toBeGreaterThan(5);
    expect(seen.foe).toBeGreaterThan(5);
    expect(seen.goal + seen.none).toBeGreaterThan(0);
  });

  it('a shot caught on its way in is a save (and travels to guests); a pass cut off in the open is a steal', () => {
    const gz = RUSH.gates.chaos.z;
    const setup = (keeperAt: readonly [number, number], aim: { x: number; z: number }) => {
      const { sim, rush } = match();
      const a = god(sim, loki, 'order', 0);
      const mate = god(sim, thor, 'order', 1);
      const k = god(sim, anubis, 'chaos', 0);
      rush.begin([a, mate, k]);
      run(sim, rush, RUSH.countdown + 0.1);
      sim.teleport(a, 0, gz + 12);
      sim.teleport(mate, -12, gz + 16);
      sim.teleport(k, keeperAt[0], keeperAt[1]);
      Object.assign(rush.relic, { phase: 'loose', x: a.x, z: a.z });
      run(sim, rush, 0.4);
      expect(rush.holder).toBe(a);
      expect(rush.throwRelic(a, aim)).toBe(true);
      run(sim, rush, 3, () => rush.relic.phase !== 'flying');
      return { rush, a, k };
    };
    // the keeper on their line takes a shot that was going in
    const shot = { x: 0, z: gz - 2 };
    {
      const { rush, a, k } = setup([0.4, gz + 1.5], shot);
      expect(rush.holder).toBe(k);
      expect(rush.score.order).toBe(0);
      expect(rush.beats.save).toBe(1);
      expect(rush.beats.steal).toBe(0);
      expect(rush.lastBeat).toMatchObject({ kind: 'save', unit: k, by: a });
      // it counts with the keeper's steals
      expect(rush.lines.get(k)?.steals).toBe(1);
      const guest = match();
      const gods = [god(guest.sim, loki, 'order', 0), god(guest.sim, thor, 'order', 1), god(guest.sim, anubis, 'chaos', 0)];
      guest.rush.join(gods);
      guest.rush.applyNet(JSON.parse(JSON.stringify(rush.netState())));
      expect(guest.rush.beats.save).toBe(1);
      expect(guest.rush.lastBeat?.kind).toBe('save');
    }
    // the same enemy cutting off a pass out on the field: a steal
    {
      const { rush, k } = setup([-9.4, gz + 15.1], { x: -12, z: gz + 16 });
      expect(rush.holder).toBe(k);
      expect(rush.beats.steal).toBe(1);
      expect(rush.beats.save).toBe(0);
    }
  });

  it('match point: a side one goal from the win, both at four apiece, and never in golden-relic overtime', () => {
    const { sim, rush } = match();
    const a = god(sim, loki, 'order', 0);
    const b = god(sim, anubis, 'chaos', 0);
    rush.begin([a, b]);
    expect(rush.matchPoint).toBeNull();
    rush.score.order = RUSH.goals - 1;
    expect(rush.matchPoint).toBe('order');
    rush.score.chaos = RUSH.goals - 1;
    expect(rush.matchPoint).toBe('both');
    rush.overtime = true;
    expect(rush.matchPoint).toBeNull();
  });

  it('the pass assist leads a running teammate aimed at, and leaves shots and throws into open space alone', () => {
    let led = 0;
    for (const [mx, mz, dx, dz] of [[6, -10, 1, 0], [-4, -7, 0.6, -0.8], [8, -4, -1, 0], [0, -14, 0, 1]] as const) {
      const { sim, rush } = match();
      const a = god(sim, loki, 'order', 0);
      const mate = god(sim, thor, 'order', 1);
      const foe = god(sim, anubis, 'chaos', 0);
      rush.begin([a, mate, foe]);
      run(sim, rush, RUSH.countdown + 0.1);
      sim.teleport(a, 0, 2);
      sim.teleport(mate, mx, mz);
      sim.teleport(foe, 30, 0);
      Object.assign(rush.relic, { phase: 'loose', x: 0, z: 2 });
      run(sim, rush, 0.4);
      expect(rush.holder).toBe(a);
      mate.move = { x: dx, z: dz };
      run(sim, rush, 0.3);
      // aimed at where the runner is now, a throw would land behind them
      const raw = { x: mate.x, z: mate.z };
      const at = rush.assistAim(a, raw);
      if (rush.passRead(a, raw).catcher !== mate) led++;
      expect(rush.passRead(a, at).catcher, `a run from ${mx},${mz}`).toBe(mate);
      expect(rush.throwRelic(a, at)).toBe(true);
      run(sim, rush, 3, () => rush.relic.phase !== 'flying');
      expect(rush.holder).toBe(mate);
    }
    // most of those runs would have been missed without it
    expect(led).toBeGreaterThan(1);

    const { sim, rush } = match();
    const a = god(sim, loki, 'order', 0);
    const mate = god(sim, thor, 'order', 1);
    const foe = god(sim, anubis, 'chaos', 0);
    rush.begin([a, mate, foe]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(a, 0, RUSH.gates.chaos.z + 12);
    sim.teleport(mate, 2.5, RUSH.gates.chaos.z + 3);
    sim.teleport(foe, 30, 0);
    Object.assign(rush.relic, { phase: 'loose', x: a.x, z: a.z });
    run(sim, rush, 0.4);
    expect(rush.holder).toBe(a);
    // a shot on goal stays a shot, even with a teammate by the gate
    const shot = { x: 0, z: RUSH.gates.chaos.z - 2 };
    expect(rush.shotOnTarget(a, shot)).toBe(true);
    expect(rush.assistAim(a, shot)).toBe(shot);
    // and a throw into open space, away from everyone, goes where it was aimed
    const open = { x: -12, z: a.z + 4 };
    expect(rush.assistAim(a, open)).toBe(open);
    // enemies never pull a throw toward them
    sim.teleport(foe, -12, a.z + 4);
    expect(rush.assistAim(a, open)).toBe(open);
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

  it('knows whether the last goal won it (the fifth, or a golden one) or the clock did, and a guest knows too', () => {
    const score = (sim: Sim, rush: Rush, a: Unit) => {
      run(sim, rush, RUSH.countdown + 0.1, () => rush.phase === 'play');
      sim.teleport(a, 0, 1.6);
      run(sim, rush, 0.4, () => rush.holder === a);
      sim.teleport(a, 0, RUSH.gates.chaos.z);
      run(sim, rush, 0.05);
    };
    // the fifth goal
    const five = match();
    const a = god(five.sim, zeus, 'order', 0);
    five.rush.begin([a, god(five.sim, thor, 'chaos', 0)]);
    five.rush.score.order = RUSH.goals - 1;
    score(five.sim, five.rush, a);
    expect(five.rush.winner).toBe('order');
    expect(five.rush.wonOnGoal).toBe(true);
    const guest = match();
    guest.rush.join([god(guest.sim, zeus, 'order', 0), god(guest.sim, thor, 'chaos', 0)]);
    guest.rush.applyNet(JSON.parse(JSON.stringify(five.rush.netState())));
    expect(guest.rush.wonOnGoal).toBe(true);
    // ahead when the clock runs out, though the last goal was the winners' own
    const clock = match();
    const b = god(clock.sim, zeus, 'order', 0);
    clock.rush.begin([b, god(clock.sim, thor, 'chaos', 0)]);
    score(clock.sim, clock.rush, b);
    run(clock.sim, clock.rush, RUSH.celebrate + 0.1, () => clock.rush.phase === 'kickoff');
    run(clock.sim, clock.rush, RUSH.countdown + 0.1, () => clock.rush.phase === 'play');
    clock.rush.clock = 0.05;
    run(clock.sim, clock.rush, 0.1);
    expect(clock.rush.winner).toBe('order');
    expect(clock.rush.lastGoal?.team).toBe('order');
    expect(clock.rush.wonOnGoal).toBe(false);
    // a golden-relic goal at 0-0
    const gold = match();
    const c = god(gold.sim, zeus, 'order', 0);
    gold.rush.begin([c, god(gold.sim, thor, 'chaos', 0)]);
    run(gold.sim, gold.rush, RUSH.countdown + 0.1);
    gold.rush.clock = 0.05;
    run(gold.sim, gold.rush, 0.1);
    expect(gold.rush.overtime).toBe(true);
    expect(gold.rush.wonOnGoal).toBe(false);
    score(gold.sim, gold.rush, c);
    expect(gold.rush.winner).toBe('order');
    expect(gold.rush.score.order).toBe(1);
    expect(gold.rush.wonOnGoal).toBe(true);
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

describe('Relic Rush: calling for the pass', () => {
  it('a call shows for a moment, can not be spammed, and ends when the caller gets the relic', () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const b = god(sim, odin, 'order', 1);
    rush.begin([a, b]);
    // not during the kickoff
    expect(rush.call(b)).toBe(false);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(a, 0, 1.6);
    sim.teleport(b, 8, 1.6);
    run(sim, rush, 0.3);
    expect(rush.holder).toBe(a);
    // the carrier has nobody to call to
    expect(rush.call(a)).toBe(false);
    expect(rush.call(b)).toBe(true);
    expect(rush.call(b)).toBe(false);
    run(sim, rush, 0.5);
    expect(rush.calledAgo(b)).toBeCloseTo(0.5, 1);
    expect(rush.throwRelic(a, { x: b.x, z: b.z })).toBe(true);
    run(sim, rush, 2, () => rush.holder !== null);
    expect(rush.holder).toBe(b);
    expect(rush.calledAgo(b)).toBeNull();
    // and a call times out on its own
    expect(rush.call(a)).toBe(true);
    run(sim, rush, RUSH.call.time + 0.1);
    expect(rush.calledAgo(a)).toBeNull();
  });

  it("a guest sees the host's calls", () => {
    const host = match();
    const guest = match();
    const hg = [god(host.sim, zeus, 'order', 0), god(host.sim, odin, 'order', 1)];
    const gg = [god(guest.sim, zeus, 'order', 0), god(guest.sim, odin, 'order', 1)];
    host.rush.begin(hg);
    guest.rush.join(gg);
    run(host.sim, host.rush, RUSH.countdown + 0.1);
    expect(host.rush.call(hg[1]!)).toBe(true);
    run(host.sim, host.rush, 0.4);
    guest.rush.applyNet(JSON.parse(JSON.stringify(host.rush.netState())));
    expect(guest.rush.calledAgo(gg[1]!)).toBeCloseTo(0.4, 1);
    expect(guest.rush.calledAgo(gg[0]!)).toBeNull();
  });

  it('a bot carrier passes to a teammate who calls, and an open bot calls to a carrier who is not a bot', () => {
    const { sim, rush } = match();
    const coach = new RushCoach(sim, rush);
    const bot = god(sim, zeus, 'order', 0);
    const me = god(sim, odin, 'order', 1);
    const foe = god(sim, thor, 'chaos', 0);
    bot.brain = new RushBot(sim, bot, rush, coach, null);
    rush.begin([bot, me, foe]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(bot, 0, 1.6);
    sim.teleport(foe, 25, 25);
    run(sim, rush, 0.4, () => rush.holder === bot);
    expect(rush.holder).toBe(bot);
    // the player, off to the side and behind: a bot wouldn't choose this pass alone
    sim.teleport(me, -9, 6);
    run(sim, rush, 0.5);
    expect(rush.holder).toBe(bot);
    expect(rush.call(me)).toBe(true);
    run(sim, rush, 2, () => rush.holder === me);
    expect(rush.holder).toBe(me);
    expect(rush.lines.get(bot)!.passes).toBe(1);
    // now the player carries: the bot runs ahead and, once open, calls for it
    run(sim, rush, 6, () => rush.calledAgo(bot) !== null);
    expect(rush.calledAgo(bot)).not.toBeNull();
  });

  it('a goal is celebrated: the scorer cheers twice and holds their spot while a bot teammate runs over', () => {
    const { sim, rush } = match();
    const coach = new RushCoach(sim, rush);
    const me = god(sim, zeus, 'order', 0);
    const mate = god(sim, odin, 'order', 1);
    const foe = god(sim, thor, 'chaos', 0);
    mate.brain = new RushBot(sim, mate, rush, coach, null);
    rush.begin([me, mate, foe]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(foe, 25, 25);
    sim.teleport(me, 0, 1.6);
    run(sim, rush, 0.4, () => rush.holder === me);
    expect(rush.holder).toBe(me);
    sim.teleport(mate, 8, -12);
    sim.teleport(me, 0, RUSH.gates.chaos.z);
    run(sim, rush, 0.05, () => rush.phase === 'goal');
    expect(rush.phase).toBe('goal');
    expect(me.sinceAction).toBeLessThan(0.1);
    const apart = Math.hypot(mate.x - me.x, mate.z - me.z);
    run(sim, rush, RUSH.cheer.again + 0.05);
    // the second fist pump
    expect(me.sinceAction).toBeLessThan(0.1);
    run(sim, rush, RUSH.cheer.mobUntil - RUSH.cheer.again - 0.2);
    expect(Math.hypot(mate.x - me.x, mate.z - me.z)).toBeLessThan(Math.min(apart - 3, 3.5));
  });
});
