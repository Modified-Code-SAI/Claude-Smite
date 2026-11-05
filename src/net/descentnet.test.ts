import { describe, expect, it } from 'vitest';
import { godById } from '../game/gods';
import { addUnderworldColliders } from '../map/UnderworldLayout';
import { CollisionWorld } from '../scene/Collision';
import { Descent, type DescentNet } from '../sim/Descent';
import { DescentBot } from '../sim/DescentBot';
import { godUnit } from '../sim/factory';
import { Sim } from '../sim/Sim';
import { descentRoster } from './descentRoster';
import { GuestSync, HostSync, SNAPSHOT_EVERY, type Roster, type Snapshot } from './Replica';
import type { NetPlayer } from './roster';
import { encode } from './Session';

const DT = 1 / 60;
const BASES = { order: { x: 0, z: 900, radius: 1 }, chaos: { x: 0, z: -900, radius: 1 } };
const players: NetPlayer[] = [
  { id: 'h', name: 'Player 1', god: 'zeus', team: 'order' },
  { id: 'g', name: 'Player 2', god: 'thor', team: 'order' },
];

function build(host: boolean) {
  const walls = new CollisionWorld(() => 0);
  addUnderworldColliders(walls);
  let s = 11;
  const sim = new Sim(walls, { order: { ...BASES.order }, chaos: { ...BASES.chaos } }, () => ((s = (s * 16807) % 2147483647) / 2147483647));
  const run = new Descent(sim, godById('zeus')!);
  const slots = descentRoster(players);
  const gods = slots.map((sl) => sim.add(godUnit(godById(sl.god)!, 'order', { x: 0, z: 0, yaw: 0 })));
  // every god plays itself on the host here (the humans' bots stand in for their inputs)
  if (host) for (const u of gods) u.brain = new DescentBot(sim, u, run);
  const humans = gods.filter((_, i) => slots[i]!.player);
  const roster: Roster = { slots: gods, structures: new Map() };
  return { sim, run, gods, humans, roster };
}

describe('online Underworld Descent', () => {
  it('fills the team to three with bots, and lets four friends play', () => {
    expect(descentRoster(players).map((s) => s.player)).toEqual(['h', 'g', null]);
    const four = [...players, { ...players[0]!, id: 'c', god: 'odin' }, { ...players[0]!, id: 'd', god: 'loki' }];
    expect(descentRoster(four)).toHaveLength(4);
    expect(descentRoster(four).every((s) => s.player)).toBe(true);
    // the bots' gods are ones no human took, the same on every end
    const bot = descentRoster(players)[2]!;
    expect(['zeus', 'thor']).not.toContain(bot.god);
    expect(descentRoster(players)).toEqual(descentRoster(players));
  });

  it("copies the host's run to a guest: chambers, monsters, rewards, drafts and learned skills", () => {
    const host = build(true);
    const guest = build(false);
    guest.sim.listeners.length = 0;
    for (const u of host.gods) host.run.addGod(u, host.humans.includes(u));
    host.run.begin();
    guest.run.join(guest.gods, guest.humans);
    const me = guest.gods[1]!;
    const sync = new HostSync(host.sim, host.run, host.roster, () => 0);
    sync.addGuest('g');
    const copy = new GuestSync(guest.sim, guest.run, guest.roster, me);

    let sawMonsters = 0;
    let sawOffer = false;
    let sawDraft = false;
    let bytes = 0;
    let snaps = 0;
    const hostThor = host.gods[1]!;
    let waited = 0;
    let was = '';
    for (let i = 1; i <= Math.round(150 / DT) && host.run.chamber < 3; i++) {
      // the humans take the Forgotten Rite and the first skill after a moment's thought
      waited = host.run.phase === was ? waited + DT : 0;
      was = host.run.phase;
      if (waited > 1 && host.run.phase === 'reward') for (const h of host.humans) host.run.vote(h, Math.max(0, host.run.offer!.findIndex((r) => r.kind === 'skill')));
      if (waited > 1 && host.run.phase === 'draft') for (const h of host.humans) host.run.draft(h, 0);
      host.run.step(DT);
      host.sim.step(DT);
      if (i % SNAPSHOT_EVERY === 0) {
        for (const [, snap] of sync.snapshots()) {
          const text = encode(snap);
          bytes += text.length;
          snaps++;
          copy.receive(JSON.parse(text) as Snapshot);
        }
      }
      copy.step(DT);
      guest.run.follow(DT);
      if (guest.run.phase === 'fight') sawMonsters = Math.max(sawMonsters, guest.run.monsters.length);
      if (guest.run.offer) sawOffer = true;
      if (guest.run.drafts.get(me)) sawDraft = true;
    }
    expect(host.run.chamber).toBeGreaterThanOrEqual(2);
    expect(guest.run.chamber).toBeGreaterThanOrEqual(2);
    expect(guest.run.current.layout).toBe(host.run.plan[guest.run.chamber - 1]!.layout);
    expect(sawMonsters).toBeGreaterThan(0);
    expect(sawOffer).toBe(true);
    expect(guest.run.kills).toBeGreaterThan(0);
    // the guest learns whatever its god learned on the host
    expect(sawDraft).toBe(true);
    {
      const learned = [1, 2, 3].filter((slot) => !hostThor.combatant.sealed.has(slot));
      expect(learned.length).toBeGreaterThan(0);
      for (const slot of learned) {
        expect(me.combatant.sealed.has(slot)).toBe(false);
        expect(me.combatant.loadout[slot]).toBe(hostThor.combatant.loadout[slot]);
      }
    }
    // the mode's own state stays small on the wire
    const state = JSON.stringify(host.run.netState() satisfies DescentNet);
    expect(state.length).toBeLessThan(1200);
    expect(bytes / snaps).toBeLessThan(6000);
  });
});
