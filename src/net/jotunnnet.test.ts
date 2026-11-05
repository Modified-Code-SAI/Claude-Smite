import { describe, expect, it } from 'vitest';
import { GODS, godById } from '../game/gods';
import { Jotunn, JOTUNN } from '../sim/Jotunn';
import { jotunnBots } from '../sim/JotunnBots';
import { Sim, type SimTerrain } from '../sim/Sim';
import type { Unit } from '../sim/Unit';
import { jotunnRoster } from './jotunnRoster';
import { GuestSync, HostSync, SNAPSHOT_EVERY, type Roster, type Snapshot } from './Replica';
import type { NetPlayer } from './roster';
import { encode } from './Session';

const DT = 1 / 60;
const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };
const players: NetPlayer[] = [
  { id: 'h', name: 'Player 1', god: 'zeus', team: 'order' },
  { id: 'g', name: 'Player 2', god: 'thor', team: 'order' },
];

function build(host: boolean) {
  let s = 7;
  const sim = new Sim(flat, { order: { ...JOTUNN.bases.order }, chaos: { ...JOTUNN.bases.chaos } }, () => ((s = (s * 16807) % 2147483647) / 2147483647));
  const slots = jotunnRoster(players);
  const brains = host ? jotunnBots(sim) : undefined;
  const mode = new Jotunn(
    sim,
    slots.map((x) => ({ name: x.name, id: x.player, god: godById(x.god)! })),
    { brains },
  );
  const structures = new Map<string, Unit>([['giant', mode.giant]]);
  for (const [id, u] of mode.parts) structures.set(id, u);
  mode.braziers.forEach((b, i) => structures.set(`brazier${i}`, b));
  const roster: Roster = { slots: mode.players.map((p) => p.god), structures };
  return { sim, mode, roster, brains };
}

describe('online Jötunn', () => {
  it('fills the match to five with bots, the same on every end', () => {
    const slots = jotunnRoster(players);
    expect(slots.map((s) => s.player)).toEqual(['h', 'g', null, null, null]);
    expect(new Set(slots.map((s) => s.god)).size).toBe(GODS.length);
    expect(jotunnRoster(players)).toEqual(slots);
    const crowd = [...players, ...['c', 'd', 'e', 'f'].map((id) => ({ ...players[0]!, id }))];
    expect(jotunnRoster(crowd).every((s) => s.player)).toBe(true);
    expect(jotunnRoster(crowd)).toHaveLength(5);
  });

  it("copies the host's rounds to a guest, who drives the giant on their turn", () => {
    const host = build(true);
    const guest = build(false);
    guest.sim.listeners.length = 0;
    // every human's part is played by a bot on the host here, standing in for their inputs
    host.mode.onRound = (p) => {
      for (const x of host.mode.players) {
        if (x === p || x.id === null) continue;
        x.god.brain = host.brains!.god(host.mode, x.god);
      }
      if (p.id !== null) host.mode.giant.brain = host.brains!.giant(host.mode);
      sync?.setSelf('g', p.id === 'g' ? host.mode.giant : host.mode.players[1]!.god);
    };
    let sync: HostSync | null = null;
    host.mode.begin();
    sync = new HostSync(host.sim, host.mode, host.roster, () => 0);
    sync.addGuest('g');
    const me = guest.mode.players[1]!.god;
    const copy = new GuestSync(guest.sim, guest.mode, guest.roster, me);
    copy.steered = (u) => u === guest.mode.giant;
    const rounds: number[] = [];
    guest.mode.onRound = () => rounds.push(guest.mode.round);

    const hostGod = guest.mode.players[0]!.god;
    let sawBenched = false;
    let sawBack = false;
    let drove = 0;
    let bytes = 0;
    let snaps = 0;
    for (let i = 1; i <= Math.round(900 / DT) && !(host.mode.round === 2 && host.mode.timer > 20 && host.mode.phase === 'fight'); i++) {
      host.mode.step(DT);
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
      // round 1: Player 1 is the giant, so their god sits it out on every end
      if (guest.mode.round === 1 && guest.mode.phase === 'fight' && !guest.sim.units.includes(hostGod)) sawBenched = true;
      if (guest.mode.round === 2 && guest.sim.units.includes(hostGod)) sawBack = true;
      // round 2: the guest is the giant; it is drawn from the host's snapshots, not left where it stood
      if (guest.mode.round === 2 && copy.controlled === guest.mode.giant && guest.mode.phase === 'fight') {
        const d = Math.hypot(guest.mode.giant.x - host.mode.giant.x, guest.mode.giant.z - host.mode.giant.z);
        expect(d).toBeLessThan(4);
        drove++;
      }
    }
    expect(host.mode.round).toBe(2);
    expect(rounds).toEqual([1, 2]);
    expect(sawBenched).toBe(true);
    // the same unit comes back, so the guest's own god (and its controller) is never replaced
    expect(sawBack).toBe(true);
    expect(drove).toBeGreaterThan(60);
    expect(guest.mode.phase).toBe(host.mode.phase);
    expect(guest.mode.players.map((p) => p.wins)).toEqual(host.mode.players.map((p) => p.wins));
    expect(guest.mode.players[0]!.giantRound).toEqual({ ...host.mode.players[0]!.giantRound!, time: Math.round(host.mode.players[0]!.giantRound!.time) });
    expect(Math.abs(guest.mode.timer - host.mode.timer)).toBeLessThan(0.5);
    expect(guest.mode.shrines.map((s) => s.dormant > 0)).toEqual(host.mode.shrines.map((s) => s.dormant > 0));
    for (const [id, u] of host.mode.parts) expect(guest.mode.parts.get(id)!.alive).toBe(u.alive);
    // the giant's build is the host's even while the guest drives it (its shrine ultimates)
    expect(guest.mode.giant.combatant.loadout).toEqual(host.mode.giant.combatant.loadout);
    // a match stays light on the wire
    expect(bytes / snaps).toBeLessThan(3000);
  }, 120000);
});
