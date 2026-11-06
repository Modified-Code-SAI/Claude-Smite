import { describe, expect, it } from 'vitest';
import { GODS } from '../game/gods';
import { BotComms } from './BotComms';
import { Jotunn, JOTUNN } from './Jotunn';
import { jotunnBots, WardenBot, WardenCalls } from './JotunnBots';
import { Sim, type SimTerrain } from './Sim';
import type { SimEvent, Unit } from './Unit';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };

/** You (the first player) as a god beside three bot gods, against a bot giant; the bots' calls and answers running as in a match. */
function setup() {
  const sim = new Sim(flat, { order: { ...JOTUNN.bases.order }, chaos: { ...JOTUNN.bases.chaos } }, () => 0.5);
  const players = GODS.map((g, i) => ({ name: g.name, id: i === 0 ? '' : null, god: g }));
  const mode = new Jotunn(sim, players, { order: [1], brains: jotunnBots(sim) });
  const comms = new BotComms(sim);
  const calls = new WardenCalls(sim, mode);
  const pings: Extract<SimEvent, { type: 'ping' }>[] = [];
  sim.listeners.push((e) => {
    if (e.type === 'ping') pings.push(e);
  });
  mode.begin();
  const run = (s: number) => {
    for (let i = 0; i < Math.round(s * 60); i++) {
      mode.step(1 / 60);
      sim.step(1 / 60);
      comms.step();
      calls.step();
    }
  };
  const me = mode.players[0]!.god;
  const part = (id: 'kneeL' | 'kneeR' | 'crown' | 'wristL') => mode.parts.get(id)!;
  const kneel = () => {
    sim.strike(me, part('kneeL'), 1e5, 'true');
    sim.strike(me, part('kneeR'), 1e5, 'true');
    run(0.2);
  };
  return { sim, mode, run, me, part, pings, kneel };
}

const wardens = (mode: Jotunn) => mode.gods.filter((u) => u.brain instanceof WardenBot);

describe('Jötunn bot calls', () => {
  it('has the bot nearest the giant call the crown when it kneels, once per kneel', () => {
    const { mode, run, part, pings, kneel } = setup();
    run(JOTUNN.countdown + 0.5);
    expect(pings).toEqual([]);
    kneel();
    const calls = pings.filter((p) => p.subject === part('crown'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('attack');
    const g = mode.giant;
    const nearest = wardens(mode).sort((a, b) => Math.hypot(a.x - g.x, a.z - g.z) - Math.hypot(b.x - g.x, b.z - g.z))[0];
    expect(calls[0]!.unit).toBe(nearest);
    run(2);
    expect(pings.filter((p) => p.subject === part('crown'))).toHaveLength(1);
  });

  it('has the nearest bots answer your call on a weak point and go for it, until the crown opens', () => {
    const { mode, sim, run, me, part, pings, kneel } = setup();
    run(JOTUNN.countdown + 0.5);
    const knee = part('kneeL');
    expect(sim.ping(me, 'attack', knee.x, knee.z, knee)).toBe(true);
    const answering = wardens(mode).filter((u) => (u.brain as WardenBot).inner.order?.subject === knee);
    expect(answering).toHaveLength(2);
    // they say they're coming, a beat apart
    run(2.5);
    expect(new Set(pings.filter((p) => p.kind === 'omw').map((p) => p.unit))).toEqual(new Set(answering));
    kneel();
    // the open crown matters more than any old call
    run(0.1);
    for (const u of answering) expect((u.brain as WardenBot).inner.order).toBeNull();
  });

  it('never has bots answer each other', () => {
    const { mode, sim, run, part } = setup();
    run(JOTUNN.countdown + 0.5);
    const [a] = wardens(mode) as [Unit];
    const knee = part('kneeL');
    sim.ping(a, 'attack', knee.x, knee.z, knee);
    for (const u of wardens(mode)) expect((u.brain as WardenBot).inner.order).toBeNull();
  });
});
