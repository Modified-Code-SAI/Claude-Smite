import { describe, expect, it } from 'vitest';
import { anubis, cthulhu, GODS, kukulkan, loki, odin, thanatos, thor, zeus } from '../game/gods';
import { normalizeLoadout, skillById, ULTIMATE_SLOT, validateLoadout } from '../game/loadout';
import type { GodDef } from '../game/types';
import { XP_TABLE } from '../game/progression';
import { godUnit } from './factory';
import { Nav } from './Nav';
import { Rush, RUSH, rushBar, tackles } from './Rush';
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
  it('two gods reaching the pedestal together: a coin toss decides the first kickoff, then the side that conceded', () => {
    for (const [coin, first] of [[0.2, 'order'], [0.7, 'chaos']] as const) {
      const { sim, rush } = match(flat, () => coin);
      const a = god(sim, zeus, 'order', 0);
      const b = god(sim, zeus, 'chaos', 0);
      rush.begin([a, b]);
      run(sim, rush, RUSH.countdown + 0.1);
      // the same distance from the relic, on the same frame (the first in the line-up used to take every one)
      sim.teleport(a, 0, 1.6);
      sim.teleport(b, 0, -1.6);
      run(sim, rush, 0.05);
      expect(rush.holder!.team).toBe(first);
      const scorer = rush.holder!;
      sim.teleport(scorer, 0, RUSH.gates[first === 'order' ? 'chaos' : 'order'].z);
      run(sim, rush, 0.05);
      expect(rush.score[first]).toBe(1);
      run(sim, rush, RUSH.celebrate + RUSH.countdown + 0.2, () => rush.phase === 'play');
      run(sim, rush, 0.05);
      sim.teleport(a, 0, 1.6);
      sim.teleport(b, 0, -1.6);
      run(sim, rush, 0.05);
      // the next tie goes to the side that just conceded
      expect(rush.holder!.team).not.toBe(first);
    }
  });

  it('steps the gods forward one frame and backward the next, so neither team always moves on fresher news', () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const b = god(sim, thor, 'chaos', 0);
    rush.begin([a, b]);
    const seen: string[] = [];
    a.brain = { update: () => seen.push('order') };
    b.brain = { update: () => seen.push('chaos') };
    for (let i = 0; i < 4; i++) sim.step(1 / 60);
    // a god stepped later sees where the others went this frame (a fixed order gave the team stepped second 54% of bot matches)
    expect(seen).toEqual(['chaos', 'order', 'order', 'chaos', 'chaos', 'order', 'order', 'chaos']);
  });

  it('identical bot line-ups race to the pedestal the same way from either half of the plaza', () => {
    const terrain = rushTestField();
    const { sim, rush } = match(terrain);
    const nav = new Nav({ groundAt: (x, z) => terrain.groundAt(x, z), resolve: (x, z, r, y) => sim.solid(x, z, r, y) }, RUSH.pitchRadius + 2);
    const coach = new RushCoach(sim, rush);
    const gods: Unit[] = [];
    for (const side of ['order', 'chaos'] as const) {
      [zeus, thor, zeus].forEach((d, i) => {
        const u = god(sim, d, side, i);
        u.brain = new RushBot(sim, u, rush, coach, nav);
        gods.push(u);
      });
    }
    rush.begin(gods);
    run(sim, rush, RUSH.countdown + 0.05);
    // each Order god runs the mirror image of its Chaos twin's run (the pathfinder once sent both teams round the same side of the pedestal)
    let worst = 0;
    for (let i = 0; i < 240 && !rush.holder; i++) {
      run(sim, rush, 1 / 60);
      if (rush.holder) break;
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.hypot(gods[k]!.x + gods[k + 3]!.x, gods[k]!.z + gods[k + 3]!.z));
    }
    expect(rush.holder).not.toBeNull();
    expect(worst).toBeLessThan(0.05);
  });

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

  it('knows who a pass is about to reach in the moment before it does (never the thrower letting it go)', () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const b = god(sim, odin, 'order', 1);
    const c = god(sim, thor, 'chaos', 0);
    rush.begin([a, b, c]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(a, 0, 1.6);
    sim.teleport(b, 14, 1.6);
    sim.teleport(c, -20, 20);
    run(sim, rush, 0.5);
    const inc = { unit: null as Unit | null, eta: 0, x: 0, z: 0, h: 0 };
    // carried: nothing on its way
    expect(rush.incoming(0.45, inc)).toBe(false);
    expect(rush.throwRelic(a, { x: 14, z: 1.6 })).toBe(true);
    // just let go, right by the thrower: still a long way from anyone
    expect(rush.incoming(0.45, inc)).toBe(false);
    let first = -1;
    let at = { x: 0, h: 0 };
    run(sim, rush, 2, () => {
      if (first < 0 && rush.incoming(0.45, inc)) {
        first = sim.time;
        at = { x: inc.x, h: inc.h };
        expect(inc.unit).toBe(b);
      }
      return rush.holder !== null;
    });
    expect(rush.holder).toBe(b);
    // seen coming about the lead asked for, where it then met them: in reach of the catcher and low enough to take
    const lead = sim.time - first;
    expect(lead).toBeGreaterThan(0.3);
    expect(lead).toBeLessThan(0.55);
    expect(Math.abs(at.x - b.x)).toBeLessThan(b.radius + RUSH.relic.catchReach + 0.05);
    expect(at.h).toBeLessThanOrEqual(RUSH.relic.catchHeight);
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

  it("a taunt knocks the relic loose too: Loki's Decoy is his tackle", () => {
    const { sim, rush } = match();
    const a = god(sim, zeus, 'order', 0);
    const t = god(sim, loki, 'chaos', 0);
    t.combatant.loadout = normalizeLoadout(loki, rushBar(loki));
    rush.begin([a, t]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(a, 0, 1.6);
    run(sim, rush, 0.2);
    expect(rush.holder).toBe(a);
    sim.teleport(t, 0, 5, 0);
    t.aim.x = a.x;
    t.aim.z = a.z;
    const slot = t.combatant.loadout.indexOf('loki.decoy');
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(sim.cast(t, slot)).toBeNull();
    run(sim, rush, 0.05);
    expect(rush.holder).toBeNull();
    expect(rush.lines.get(t)!.tackles).toBe(1);
  });

  it('every god brings a tackle to Relic Rush: bots whose own bar has none swap one in', () => {
    const count = (g: GodDef, bar: readonly string[]) => bar.slice(0, ULTIMATE_SLOT).filter((id) => tackles(skillById(g, id)!)).length;
    for (const g of GODS) {
      const bar = rushBar(g);
      expect(validateLoadout(g, bar), g.id).toBeNull();
      expect(count(g, bar), g.id).toBeGreaterThan(0);
    }
    expect(count(odin, odin.defaultLoadout)).toBe(0);
    expect(count(loki, loki.defaultLoadout)).toBe(0);
    // most bring exactly one, so no bot team fields a stack of stuns (Cthulhu, the slowest, keeps his two)
    for (const g of [zeus, thor, odin, loki, anubis, thanatos, kukulkan]) expect(count(g, rushBar(g)), g.id).toBe(1);
  });

  it('a bot keeps its stun for whoever carries the relic', () => {
    // `carrier` takes the relic at the center; Thor, a bot on the order side, stands at the shoulder of `other`
    const play = (carrierTeam: 'order' | 'chaos') => {
      const { sim, rush } = match();
      const coach = new RushCoach(sim, rush);
      const mate = god(sim, zeus, 'order', 0);
      const bot = god(sim, thor, 'order', 1);
      const foe = god(sim, loki, 'chaos', 0);
      bot.brain = new RushBot(sim, bot, rush, coach, null, { aggression: 1 });
      rush.begin([mate, bot, foe]);
      run(sim, rush, RUSH.countdown + 0.1);
      const carrier = carrierTeam === 'order' ? mate : foe;
      sim.teleport(carrier, 0, 1.6);
      run(sim, rush, 0.4, () => rush.holder === carrier);
      expect(rush.holder).toBe(carrier);
      const slam = bot.combatant.loadout.indexOf('thor.mjolnir-slam');
      for (let i = 0; i < 20 && bot.combatant.cooldownOf(slam) === 0; i++) {
        // the enemy at our carrier's side (or carrying), within the slam's reach
        sim.teleport(foe, mate.x + 1.2, mate.z - 1);
        sim.teleport(bot, mate.x + 1.2, mate.z + 1.2);
        run(sim, rush, 0.1);
      }
      return { used: bot.combatant.cooldownOf(slam) > 0, holder: rush.holder, foe };
    };
    // knocking defenders off our carrier, the bot holds the stun back
    expect(play('order').used).toBe(false);
    // on the enemy carrier it goes in, and knocks the relic loose
    const d = play('chaos');
    expect(d.used).toBe(true);
    expect(d.holder).not.toBe(d.foe);
  });

  it('a bot sets off a mark-detonating tackle on the carrier only at full stacks, when it stuns', () => {
    const { sim, rush } = match();
    const coach = new RushCoach(sim, rush);
    const carrier = god(sim, thor, 'order', 0);
    const bot = god(sim, zeus, 'chaos', 0);
    rush.begin([carrier, bot]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(carrier, 0, 1.6);
    run(sim, rush, 0.4, () => rush.holder === carrier);
    expect(rush.holder).toBe(carrier);
    bot.brain = new RushBot(sim, bot, rush, coach, null, { aggression: 1 });
    const discharge = bot.combatant.loadout.indexOf('zeus.static-discharge');
    // one Charge on the carrier: setting it off now would only sting, and spend the Charge
    sim.teleport(bot, carrier.x + 4, carrier.z);
    for (let i = 0; i < 30; i++) {
      carrier.marks.set('charge', { stacks: 1, remaining: 5 });
      run(sim, rush, 1 / 60);
    }
    expect(bot.combatant.cooldownOf(discharge)).toBe(0);
    // at three it stuns, and the relic comes loose
    carrier.marks.set('charge', { stacks: 3, remaining: 5 });
    run(sim, rush, 0.5, () => rush.holder !== carrier);
    expect(bot.combatant.cooldownOf(discharge)).toBeGreaterThan(0);
    expect(rush.holder).not.toBe(carrier);
  });

  it('a bot pressing the carrier marks them at arm’s length instead of standing inside them', () => {
    const { sim, rush } = match();
    const coach = new RushCoach(sim, rush);
    const carrier = god(sim, zeus, 'order', 0);
    const bot = god(sim, thor, 'chaos', 0);
    // (no crowd control: this is about where it stands)
    bot.brain = new RushBot(sim, bot, rush, coach, null, { aggression: 0 });
    rush.begin([carrier, bot]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(carrier, 0, 1.6);
    run(sim, rush, 0.4, () => rush.holder === carrier);
    expect(rush.holder).toBe(carrier);
    // the carrier stops to look for a pass; the presser comes out to them
    sim.teleport(bot, 1, -9);
    run(sim, rush, 2, () => Math.hypot(bot.x - carrier.x, bot.z - carrier.z) < 1.6);
    let closest = Infinity;
    for (let i = 0; i < 120; i++) {
      run(sim, rush, 1 / 60);
      closest = Math.min(closest, Math.hypot(bot.x - carrier.x, bot.z - carrier.z));
    }
    expect(rush.holder).toBe(carrier);
    // two gods' radii are 1.2 m: it used to stand on the carrier's spot
    expect(closest).toBeGreaterThan(1);
  });

  it('a carrier bot steers round a defender ahead on the far side from them', () => {
    const pass = (off: number) => {
      const { sim, rush } = match();
      const coach = new RushCoach(sim, rush);
      const carrier = god(sim, zeus, 'order', 0);
      const foe = god(sim, thor, 'chaos', 0);
      carrier.brain = new RushBot(sim, carrier, rush, coach, null);
      rush.begin([carrier, foe]);
      run(sim, rush, RUSH.countdown + 0.1);
      sim.teleport(carrier, 0, 1.6);
      run(sim, rush, 0.4, () => rush.holder === carrier);
      expect(rush.holder).toBe(carrier);
      expect(rush.juke(carrier, { x: 0, z: -1 })).toBe(true);
      run(sim, rush, 0.3);
      // running for the chaos gate (toward -z), a defender standing a little off its line 6 m on
      sim.teleport(carrier, 0, -2);
      sim.teleport(foe, off, -8);
      run(sim, rush, 2, () => carrier.z < foe.z || rush.holder !== carrier);
      return carrier.x - foe.x;
    };
    // it goes by on the open side: left of a defender off to its right, and right of one off to its left
    expect(pass(0.8)).toBeLessThan(-1);
    expect(pass(-0.8)).toBeGreaterThan(1);
  });

  it('a carrier bot with defenders on both shoulders breaks to one side instead of freezing', () => {
    const { sim, rush } = match();
    const coach = new RushCoach(sim, rush);
    const carrier = god(sim, zeus, 'order', 0);
    const a = god(sim, thor, 'chaos', 0);
    const b = god(sim, zeus, 'chaos', 1);
    carrier.brain = new RushBot(sim, carrier, rush, coach, null);
    rush.begin([carrier, a, b]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(carrier, 0, 1.6);
    run(sim, rush, 0.4, () => rush.holder === carrier);
    expect(rush.holder).toBe(carrier);
    // its juke spent, so only its running can get it out
    expect(rush.juke(carrier, { x: 1, z: 0 })).toBe(true);
    run(sim, rush, 0.3);
    // as a match left them: the carrier (heading for the chaos gate) with two defenders a few centimeters off, one either side of its run
    sim.teleport(carrier, -0.15, -15.2);
    sim.teleport(a, -0.1, -15.23);
    sim.teleport(b, -0.17, -15.23);
    // it used to stand there for seconds: the two pushes away from them cancelled out (now it breaks free, and may well shoot once clear)
    let got = 0;
    for (let i = 0; i < 60 && rush.holder === carrier; i++) {
      run(sim, rush, 1 / 60);
      got = Math.max(got, Math.hypot(carrier.x + 0.15, carrier.z + 15.2));
    }
    expect(got).toBeGreaterThan(2);
  });

  it('a carrier bot just in front of a gate pillar works its way into the mouth instead of turning on the spot', () => {
    const { sim, rush } = match();
    const coach = new RushCoach(sim, rush);
    const carrier = god(sim, zeus, 'chaos', 0);
    const keeper = god(sim, zeus, 'order', 0);
    const a = god(sim, zeus, 'order', 1);
    const b = god(sim, zeus, 'order', 2);
    carrier.brain = new RushBot(sim, carrier, rush, coach, null);
    rush.begin([carrier, keeper, a, b]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(carrier, 0, -1.6);
    run(sim, rush, 0.4, () => rush.holder === carrier);
    expect(rush.holder).toBe(carrier);
    expect(rush.juke(carrier, { x: 1, z: 0 })).toBe(true);
    run(sim, rush, 0.3);
    // as a bot match left them: wide of the order gate's mouth, 3 m out (where stepping round the pillar and heading
    // for the mouth met), a defender at its back and one at its side, the keeper home
    sim.teleport(carrier, -5.74, 21.3);
    let far = 0;
    for (let i = 0; i < 120 && rush.holder === carrier; i++) {
      sim.teleport(keeper, -2.57, 21.96);
      sim.teleport(a, carrier.x - 0.23, carrier.z - 1.25);
      sim.teleport(b, carrier.x - 1.31, carrier.z - 0.26);
      run(sim, rush, 1 / 60);
      far = Math.max(far, Math.hypot(carrier.x + 5.74, carrier.z - 21.3));
    }
    // it used to turn about every step and stay put
    expect(rush.holder !== carrier || far > 1.5).toBe(true);
  });

  it("a carrier bot pressed against a gate pillar's face slides along it toward the mouth instead of turning about", () => {
    const { sim, rush } = match(rushTestField());
    const coach = new RushCoach(sim, rush);
    const carrier = god(sim, cthulhu, 'chaos', 0);
    const keeper = god(sim, kukulkan, 'order', 0);
    const press = god(sim, kukulkan, 'order', 1);
    const back = god(sim, kukulkan, 'order', 2);
    carrier.brain = new RushBot(sim, carrier, rush, coach, null);
    rush.begin([carrier, keeper, press, back]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(carrier, 0, -1.6);
    run(sim, rush, 0.4, () => rush.holder === carrier);
    expect(rush.holder).toBe(carrier);
    expect(rush.juke(carrier, { x: 1, z: 0 })).toBe(true);
    run(sim, rush, 0.3);
    // as a bot match left them: up against the front of the order gate's east pillar, the keeper home, a defender
    // in front and to the side and one further back (their push sent the carrier into the pillar, and backing off the face it turned about every step)
    sim.teleport(carrier, 5.61, 22.65);
    let turns = 0;
    let last: { x: number; z: number } | null = null;
    for (let i = 0; i < 40 && rush.holder === carrier; i++) {
      sim.teleport(keeper, 2.18, 21.67);
      sim.teleport(press, carrier.x + 0.62, carrier.z - 1.19);
      sim.teleport(back, 3.31, 17.02);
      run(sim, rush, 1 / 60);
      const m = carrier.move;
      if (!m) continue;
      const l = Math.hypot(m.x, m.z) || 1;
      if (last && (last.x * m.x + last.z * m.z) / l < -0.5) turns++;
      last = { x: m.x / l, z: m.z / l };
    }
    expect(turns).toBeLessThanOrEqual(2);
    // and gaining ground on the mouth along the face, it carries it in
    expect(rush.score.chaos).toBe(1);
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
    // (a defender left battered by the run)
    t.combatant.health = t.combatant.stats.maxHealth * 0.2;
    t.combatant.mana = 0;
    run(sim, rush, RUSH.celebrate + 0.1);
    expect(rush.phase).toBe('kickoff');
    // every point starts fresh
    expect(t.combatant.health).toBe(t.combatant.stats.maxHealth);
    expect(t.combatant.mana).toBe(t.combatant.stats.maxMana);
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

describe('Relic Rush: the relic against stone', () => {
  /** A temple-plaza match past its kickoff, with `a` holding the relic and `c` left out of the way. */
  function holding() {
    const { sim, rush } = match(rushTestField());
    const a = god(sim, zeus, 'order', 0);
    const c = god(sim, thor, 'chaos', 0);
    rush.begin([a, c]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(c, -24, 4);
    sim.teleport(a, rush.relic.x + 1.6, rush.relic.z);
    run(sim, rush, 0.6, () => rush.holder === a);
    expect(rush.holder).toBe(a);
    run(sim, rush, RUSH.relic.holdMin + 0.05);
    return { sim, rush, a, c };
  }

  it('a throw into a gate pillar bounces back off its face and comes down loose in front of it, scoring nothing', () => {
    const { sim, rush, a } = holding();
    sim.teleport(a, 5.4, -14);
    const at = { x: 5.4, z: -27 };
    // the carrier's read says so before the throw (its preview turns red), and the bots read the same
    const read = rush.passRead(a, at);
    expect(read.goal).toBe(false);
    expect(read.catcher).toBeNull();
    expect(read.stone).not.toBeNull();
    expect(read.stone!.z).toBeGreaterThan(-23.35);
    expect(read.stone!.z).toBeLessThan(-22);
    expect(rush.passRead(a, { x: 0, z: -20 }).stone).toBeNull();
    expect(rush.throwRelic(a, at)).toBe(true);
    let inside = 0;
    for (let i = 0; i < 180 && rush.relic.phase === 'flying'; i++) {
      run(sim, rush, 1 / 60);
      if (rush.relic.phase === 'flying' && rush.stoneAt(rush.relic.x, rush.relic.z, rush.relic.h)) inside++;
    }
    expect(inside).toBe(0);
    expect(rush.relic.phase).toBe('loose');
    expect(rush.beats.post).toBeGreaterThanOrEqual(1);
    expect(rush.lastBeat).toMatchObject({ kind: 'post', unit: a });
    // back off the face, toward the thrower
    expect(rush.relic.z).toBeGreaterThan(-23.35 + RUSH.relic.radius);
    expect(rush.relic.z).toBeLessThan(-18);
    expect(rush.stoneAt(rush.relic.x, rush.relic.z, rush.relic.h)).toBeNull();
    expect(rush.score.order).toBe(0);
    expect(rush.beats.miss).toBe(0);
  });

  it('a throw passes over the pedestal and the low braziers, but not through a column', () => {
    const { sim, rush, a } = holding();
    // straight over the middle, high in its arc
    sim.teleport(a, 0, 8);
    expect(rush.passRead(a, { x: 0, z: -8 }).stone).toBeNull();
    // over a brazier's bowl
    sim.teleport(a, 0, 6.72);
    expect(rush.passRead(a, { x: 13.4, z: 6.72 }).stone).toBeNull();
    // into a whole column on the ring, at head height
    sim.teleport(a, 6.16, 6);
    const col = rush.passRead(a, { x: 6.16, z: 16 }).stone;
    expect(col).not.toBeNull();
    expect(Math.hypot(col!.x - 6.16, col!.z - 12.79)).toBeLessThan(0.68 + RUSH.relic.radius + 0.4);
  });

  it('wherever a fumble sends it, the relic never flies through stone or comes to rest inside it', () => {
    // (pedestal, a brazier, a whole column, a broken one, a gate pillar)
    const stones = [[0, 0, 0.95], [6.72, 6.72, 0.75], [6.16, 12.79, 0.68], [-6.16, -12.79, 0.68], [5.4, -24.35, 1.42]] as const;
    let bounced = 0;
    for (const [sx, sz, sr] of stones) {
      for (let k = 0; k < 8; k++) {
        const { sim, rush, a, c } = holding();
        const ang = (k / 8) * Math.PI * 2;
        const dx = Math.cos(ang);
        const dz = Math.sin(ang);
        // the carrier beside the stone, knocked toward it by someone on their far side
        sim.teleport(a, sx + dx * (sr + 1.2), sz + dz * (sr + 1.2));
        sim.teleport(c, a.x + dx * 2, a.z + dz * 2);
        (rush as unknown as { fumble(u: Unit, by: Unit): void }).fumble(a, c);
        for (let i = 0; i < 240 && rush.relic.phase === 'flying'; i++) {
          run(sim, rush, 1 / 60);
          if (rush.relic.phase === 'flying') expect(rush.stoneAt(rush.relic.x, rush.relic.z, rush.relic.h)).toBeNull();
        }
        if (rush.relic.phase !== 'loose') continue;
        expect(rush.stoneAt(rush.relic.x, rush.relic.z, rush.relic.h)).toBeNull();
        bounced += rush.beats.post;
      }
    }
    expect(bounced).toBeGreaterThan(10);
  });

  it('tells online guests about each bounce', () => {
    const { sim, rush, a } = holding();
    sim.teleport(a, 5.4, -14);
    rush.throwRelic(a, { x: 5.4, z: -27 });
    run(sim, rush, 2, () => rush.beats.post > 0);
    const guest = match(rushTestField());
    const ga = god(guest.sim, zeus, 'order', 0);
    const gc = god(guest.sim, thor, 'chaos', 0);
    guest.rush.begin([ga, gc]);
    guest.rush.applyNet(JSON.parse(JSON.stringify(rush.netState())));
    expect(guest.rush.beats.post).toBe(rush.beats.post);
    expect(guest.rush.lastBeat).toMatchObject({ kind: 'post', unit: ga });
    // between snapshots a guest's relic flying at the pillar stops at its face (the host's next snapshot has the bounce)
    const g = guest.rush;
    Object.assign(g.relic, { phase: 'flying', holder: null, fx: 5.4, fz: -14, tx: 5.4, tz: -27, t: 0, duration: Rush.flightTime(13), arc: 0.8 + 13 * 0.14, h0: RUSH.relic.carryHeight });
    for (let i = 0; i < 60; i++) {
      g.follow(1 / 60);
      expect(g.stoneAt(g.relic.x, g.relic.z, g.relic.h)).toBeNull();
    }
    expect(g.relic.z).toBeGreaterThan(-23.35);
    expect(g.relic.z).toBeLessThan(-22.5);
  });
});

describe('Relic Rush: bots among the temple’s stones', () => {
  it('a bot sent for a relic lying behind the fallen column’s drums walks round to its side of them and takes it', () => {
    const terrain = rushTestField();
    const { sim, rush } = match(terrain);
    const nav = new Nav({ groundAt: (x, z) => terrain.groundAt(x, z), resolve: (x, z, r, y) => sim.solid(x, z, r, y) }, RUSH.pitchRadius + 2);
    const coach = new RushCoach(sim, rush);
    const chaser = god(sim, thor, 'chaos', 0);
    const far = god(sim, zeus, 'order', 0);
    chaser.brain = new RushBot(sim, chaser, rush, coach, nav);
    rush.begin([chaser, far]);
    run(sim, rush, RUSH.countdown + 0.1);
    // the drums lie in a low wall across the steps; the relic came down on their north side, the bot stands on the south
    sim.teleport(far, 20, 20);
    far.brain = null;
    sim.teleport(chaser, -15.6, -5.6);
    Object.assign(rush.relic, { phase: 'loose', holder: null, x: -17.01, z: -2.8, h: RUSH.relic.looseHeight, thrower: null, team: 'order' });
    run(sim, rush, 8, () => rush.holder === chaser);
    expect(rush.holder).toBe(chaser);
  });

  it('a carrier bot wedged between a gate pillar and the fallen lintel behind it, a defender at the open side, finds its way out', () => {
    const terrain = rushTestField();
    const { sim, rush } = match(terrain);
    const nav = new Nav({ groundAt: (x, z) => terrain.groundAt(x, z), resolve: (x, z, r, y) => sim.solid(x, z, r, y) }, RUSH.pitchRadius + 2);
    const coach = new RushCoach(sim, rush);
    const carrier = god(sim, thanatos, 'chaos', 0);
    const press = god(sim, kukulkan, 'order', 0);
    const keeper = god(sim, kukulkan, 'order', 1);
    carrier.brain = new RushBot(sim, carrier, rush, coach, nav);
    rush.begin([carrier, press, keeper]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(carrier, 0, -1.6);
    run(sim, rush, 0.4, () => rush.holder === carrier);
    expect(rush.holder).toBe(carrier);
    // as a bot match left them: against the outer face of the order gate's west pillar, the lintel lying behind it
    sim.teleport(carrier, -7.0, 24.4);
    const start = { x: carrier.x, z: carrier.z };
    let moved = 0;
    for (let i = 0; i < 180 && rush.holder === carrier; i++) {
      sim.teleport(press, -7.5, 23.1);
      sim.teleport(keeper, -2.9, 22);
      run(sim, rush, 1 / 60);
      moved = Math.max(moved, Math.hypot(carrier.x - start.x, carrier.z - start.z));
    }
    expect(moved).toBeGreaterThan(2);
  });

  it('a carrier bot coming at a gate from wide of its mouth, a defender on its heels, curves in front of the mouth without turning back and forth', () => {
    const { sim, rush } = match(rushTestField());
    const coach = new RushCoach(sim, rush);
    const carrier = god(sim, thor, 'chaos', 0);
    const keeper = god(sim, kukulkan, 'order', 0);
    const press = god(sim, kukulkan, 'order', 1);
    const far = god(sim, kukulkan, 'order', 2);
    carrier.brain = new RushBot(sim, carrier, rush, coach, null);
    rush.begin([carrier, keeper, press, far]);
    run(sim, rush, RUSH.countdown + 0.1);
    sim.teleport(carrier, 0, -1.6);
    run(sim, rush, 0.4, () => rush.holder === carrier);
    expect(rush.holder).toBe(carrier);
    expect(rush.juke(carrier, { x: 1, z: 0 })).toBe(true);
    run(sim, rush, 0.3);
    // as a bot match left them: well wide of the order gate's mouth and closing on it, the keeper home, a defender on its heels
    // (stepping out in front of the mouth carried it past where that ended, so it headed back for the mouth, came beside the pillar
    // again and stepped out again: about face every half second, for as long as the defender let it)
    sim.teleport(carrier, -8.5, 20.7);
    let turns = 0;
    let last: { x: number; z: number } | null = null;
    for (let i = 0; i < 150 && rush.holder === carrier; i++) {
      sim.teleport(keeper, -2.8, 21.8);
      sim.teleport(press, carrier.x - 0.4, carrier.z - 1.7);
      sim.teleport(far, 0, 0);
      run(sim, rush, 1 / 60);
      const m = carrier.move;
      if (!m || i % 6) continue;
      const l = Math.hypot(m.x, m.z) || 1;
      if (last && (last.x * m.x + last.z * m.z) / l < -0.5) turns++;
      last = { x: m.x / l, z: m.z / l };
    }
    expect(turns).toBeLessThanOrEqual(1);
  });
});
