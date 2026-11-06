import { describe, expect, it } from 'vitest';
import { godById } from '../game/gods';
import { body, godUnit } from '../sim/factory';
import { LaneBot, spawnPoint } from '../sim/LaneBot';
import { conquestBases, Match } from '../sim/Match';
import { Sim, type SimTerrain } from '../sim/Sim';
import { thrownLean } from '../combat/UnitViews';
import { Unit, type SimEvent } from '../sim/Unit';
import { Combatant } from '../game/combatant';
import { GuestSync, HostSync, SNAPSHOT_EVERY, type NetMatch, type Roster, type Snapshot } from './Replica';
import { roster, type NetPlayer } from './roster';
import { encode } from './Session';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };
const DT = 1 / 60;
const players: NetPlayer[] = [
  { id: 'h', name: 'Player 1', god: 'zeus', team: 'order' },
  { id: 'g', name: 'Player 2', god: 'thor', team: 'chaos' },
];

function build(bots: boolean) {
  const sim = new Sim(flat, conquestBases(), () => 0.5);
  const match = new Match(sim, godById('zeus')!);
  const slots = roster(players);
  const units = slots.map((s) => {
    const u = godUnit(godById(s.god)!, s.team, spawnPoint(s.team, s.spot));
    if (bots) u.brain = new LaneBot(sim, match, u, s.role);
    return u;
  });
  for (const u of units) match.addGod(u);
  const r: Roster = { slots: units, structures: match.structures };
  return { sim, match, roster: r, slots };
}

describe('networked match copy', () => {
  it('fills slots with humans first and bots on the gods left over', () => {
    const slots = roster(players);
    expect(slots).toHaveLength(10);
    expect(slots.filter((s) => s.player)).toHaveLength(2);
    expect(slots.find((s) => s.player === 'h')).toMatchObject({ team: 'order', spot: 1, god: 'zeus' });
    const order = slots.filter((s) => s.team === 'order').map((s) => s.god);
    expect(new Set(order).size).toBe(5);
  });

  it("follows the host's match on a delay: positions, health, units, events and score", () => {
    const host = build(true);
    const guest = build(false);
    // the guest's match never reacts to events itself
    guest.sim.listeners.length = 0;
    const self = guest.roster.slots[guest.slots.findIndex((s) => s.player === 'g')]!;
    const sync = new HostSync(host.sim, host.match, host.roster, () => 0);
    sync.addGuest('g');
    const copy = new GuestSync(guest.sim, guest.match, guest.roster, self);

    const hostDeaths: SimEvent[] = [];
    host.sim.listeners.push((e) => e.type === 'death' && hostDeaths.push(e));
    let guestDeaths = 0;
    guest.sim.listeners.push((e) => e.type === 'death' && guestDeaths++);

    // the host's picture at each snapshot, to compare against the guest's delayed one
    const history: { t: number; at: Map<number, { x: number; z: number; hp: number }> }[] = [];
    const steps = Math.round(100 / DT);
    let bytes = 0;
    for (let i = 1; i <= steps; i++) {
      host.match.step(DT);
      host.sim.step(DT);
      if (i % SNAPSHOT_EVERY === 0) {
        for (const [, snap] of sync.snapshots()) {
          const text = encode(snap);
          if (i > steps / 2) bytes += text.length;
          copy.receive(JSON.parse(text) as Snapshot);
        }
        history.push({ t: host.sim.time, at: new Map(host.sim.units.map((u) => [u.id, { x: u.x, z: u.z, hp: u.combatant.health }])) });
      }
      copy.step(DT);
    }

    // minions and jungle camps were made on the guest's side too
    const kinds = (units: Unit[]) => units.filter((u) => u.kind === 'minion' || u.kind === 'monster').length;
    expect(kinds(guest.sim.units)).toBeGreaterThan(20);
    expect(Math.abs(kinds(guest.sim.units) - kinds(host.sim.units))).toBeLessThan(15);

    // every unit stands where the host had it at the guest's (delayed) clock
    const rt = guest.sim.time;
    const k = history.findIndex((h) => h.t > rt);
    const [a, b] = [history[k - 1]!, history[k]!];
    const w = (rt - a.t) / (b.t - a.t);
    const byId = (copy as unknown as { byId: Map<number, Unit> }).byId;
    let compared = 0;
    for (const [id, u] of byId) {
      if (u === self) continue;
      const pa = a.at.get(id);
      const pb = b.at.get(id);
      if (!pa || !pb) continue;
      expect(Math.abs(u.x - (pa.x + (pb.x - pa.x) * w))).toBeLessThan(0.05);
      expect(Math.abs(u.z - (pa.z + (pb.z - pa.z) * w))).toBeLessThan(0.05);
      expect(Math.abs(u.combatant.health - (pa.hp + (pb.hp - pa.hp) * w))).toBeLessThan(1);
      compared++;
    }
    expect(compared).toBeGreaterThan(40);

    // deaths reached the guest's effects (all but the last fraction of a second's)
    expect(guestDeaths).toBeGreaterThan(hostDeaths.length * 0.9);
    // the score and clock match the host's
    const kills = (m: Match) => m.gods.map((g) => m.stats.get(g)!.kills + m.stats.get(g)!.minions);
    expect(kills(guest.match).reduce((x, y) => x + y)).toBeGreaterThan(0);
    expect(Math.abs(guest.match.time - host.match.time)).toBeLessThan(0.5);
    // a guest's download stays modest: well under 100 KB/s once the match is busy
    expect(bytes / 50).toBeLessThan(100_000);
  }, 30_000);

  it('copies any mode: its own state, its own units and a god roster of any size', () => {
    /** A made-up mode: a score, and totems it raises itself. */
    class Totems implements NetMatch {
      score = 0;
      constructor(readonly sim: Sim) {}
      raise(x: number, z: number): Unit {
        const u = totem(x, z);
        this.sim.add(u);
        return u;
      }
      netState() {
        return { score: this.score };
      }
      applyNet(s: unknown) {
        this.score = (s as { score: number }).score;
      }
      netSpawn(o: { kind: string; data?: unknown }, _team: unknown, at: { x: number; z: number }) {
        return o.kind === 'totem' ? totem(at.x, at.z) : null;
      }
    }
    const totem = (x: number, z: number) => {
      const u = new Unit('dummy', 'Totem', new Combatant(godById('zeus')!, 'neutral'), body(x, z), 1, { x, z, yaw: 0 });
      u.origin = { f: 'mode', kind: 'totem' };
      return u;
    };
    const make = () => {
      const sim = new Sim(flat, conquestBases(), () => 0.5);
      const mode = new Totems(sim);
      // three gods: a 1 + 2 roster, nothing like Conquest's ten
      const gods = ['zeus', 'thor', 'odin'].map((id, i) => sim.add(godUnit(godById(id)!, 'order', { x: i * 3, z: 0, yaw: 0 })));
      return { sim, mode, roster: { slots: gods, structures: new Map() } as Roster };
    };
    const host = make();
    const guest = make();
    guest.sim.listeners.length = 0;
    const sync = new HostSync(host.sim, host.mode, host.roster, () => 0);
    sync.addGuest('g');
    const copy = new GuestSync(guest.sim, guest.mode, guest.roster, guest.roster.slots[1]!);
    host.mode.raise(5, -5);
    host.mode.score = 7;
    host.roster.slots[0]!.body.x = 4;
    for (let i = 1; i <= 60; i++) {
      host.sim.step(DT);
      if (i % SNAPSHOT_EVERY === 0) for (const [, snap] of sync.snapshots()) copy.receive(JSON.parse(encode(snap)) as Snapshot);
      copy.step(DT);
    }
    expect(guest.mode.score).toBe(7);
    expect(guest.sim.units.filter((u) => u.name === 'Totem').map((u) => [u.x, u.z])).toEqual([[5, -5]]);
    expect(guest.roster.slots[0]!.x).toBeCloseTo(4, 1);
  });
  it("shows a guest the host's throws as they fly: progress, direction and whether it is a throw or a leap", () => {
    const make = () => {
      const sim = new Sim(flat, conquestBases(), () => 0.5);
      const mode: NetMatch = { netState: () => null, applyNet: () => {} };
      const gods = ['zeus', 'thor', 'odin'].map((id, i) => sim.add(godUnit(godById(id)!, 'order', { x: i * 6, z: 0, yaw: 0 })));
      return { sim, mode, roster: { slots: gods, structures: new Map() } as Roster };
    };
    const host = make();
    const guest = make();
    guest.sim.listeners.length = 0;
    const sync = new HostSync(host.sim, host.mode, host.roster, () => 0);
    sync.addGuest('g');
    const self = guest.roster.slots[2]!;
    const copy = new GuestSync(guest.sim, guest.mode, guest.roster, self);
    const [thrown, leaper] = host.roster.slots as [Unit, Unit];
    const at = (u: Unit) => guest.roster.slots[host.roster.slots.indexOf(u)]!;
    const progress: { t: number; p: number }[] = [];
    const out = { pitch: 0, roll: 0 };
    const leans: { host: number; guest: number }[] = [];
    for (let i = 1; i <= 120; i++) {
      if (i === 10) {
        // thrown sideways off its feet, and a leap of the same height
        thrown.forced = { vx: 6, vz: 0, remaining: 1, total: 1, arc: 3, collide: true };
        leaper.forced = { vx: 0, vz: 6, remaining: 1, total: 1, arc: 3, collide: false };
      }
      host.sim.step(DT);
      const f = thrown.forced;
      progress.push({ t: host.sim.time, p: f ? 1 - f.remaining / f.total : -1 });
      if (i % SNAPSHOT_EVERY === 0) for (const [, snap] of sync.snapshots()) copy.receive(JSON.parse(encode(snap)) as Snapshot);
      copy.step(DT);
      const g = at(thrown).forced;
      if (!g) continue;
      expect(g.collide).toBe(true);
      expect(g.arc).toBeCloseTo(3, 1);
      // where the host had it at the guest's (delayed) clock
      const near = progress.reduce((a, b) => (Math.abs(b.t - guest.sim.time) < Math.abs(a.t - guest.sim.time) ? b : a));
      if (near.p >= 0) expect(Math.abs(1 - g.remaining / g.total - near.p)).toBeLessThan(0.08);
      expect(g.vx).toBeCloseTo(6, 0);
      const hp = near.p >= 0 ? thrownLean({ ...g, remaining: 1 - near.p, total: 1 }, 0, out).roll : 0;
      leans.push({ host: hp, guest: thrownLean(g, 0, out).roll });
      expect(at(leaper).forced?.collide).toBe(false);
    }
    // the guest saw the whole flight, leaning the way the host's god did
    expect(leans.length).toBeGreaterThan(40);
    expect(Math.max(...leans.map((l) => l.guest))).toBeGreaterThan(0.3);
    for (const l of leans) expect(Math.abs(l.guest - l.host)).toBeLessThan(0.12);
    expect(at(thrown).forced).toBeNull();
  });
});
