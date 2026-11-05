import type { Allocation } from '../game/trees';
import type { PlayerController } from '../player/PlayerController';
import { isPingKind, type PingKind } from '../sim/Pings';
import type { Sim } from '../sim/Sim';
import type { Unit } from '../sim/Unit';
import { F, GuestSync, HostSync, SNAPSHOT_EVERY, type NetMatch, type Roster, type Snapshot } from './Replica';
import { encode, type Msg, type NetSession } from './Session';
import { showNetStatus } from './status';
import { hypot } from '../core/math';

/** The host starts without guests that are still loading after this long; they catch up when ready. */
const READY_TIMEOUT = 180;
/** Inputs queued beyond this are stale (a burst after a stall) and dropped. */
const MAX_QUEUED = 4;

interface Input {
  /** The authority sequence the guest had applied when it sent this. */
  s: number;
  p: [number, number, number, number];
  a: [number, number];
  b: 0 | 1;
}

/** A guest's unit on the host: moved by the guest's inputs, one per step. */
class RemotePlayer {
  readonly inputs: Input[] = [];
  /**
   * Bumped whenever the host moves the unit itself (a teleport, a dash or
   * knockback ending, or the mode handing the player another unit); older
   * inputs no longer move it.
   */
  seq = 0;
  basic = false;
  wasForced = false;
  constructor(
    readonly id: string,
    public unit: Unit,
  ) {}
}

/**
 * The hosting end of a networked match: applies guests' inputs to their units
 * before each step and sends snapshots after. Any mode can use it: the mode
 * builds its units, hands each guest theirs with `assign`, then calls `bind`.
 */
export class NetHost {
  private readonly remotes = new Map<string, RemotePlayer>();
  private sync: HostSync | null = null;
  private readonly waiting = new Set<string>();
  private steps = 0;
  private waited = 0;
  private localReady = false;
  started = false;
  /**
   * Carries out a guest's held basic attack each step. A mode can take it over
   * (a relic carrier's click throws instead of attacking).
   */
  basic: (u: Unit) => void = (u) => void this.sim.basic(u);
  /** A mode's own messages from guests (`NetGuest.act`), with the unit that guest controls. */
  onAct: ((u: Unit, msg: Msg, from: string) => void) | null = null;
  /**
   * Units the mode walks itself from a guest's intent (sent with `act`; the
   * Jötunn's giant): their inputs carry only aim and the basic attack.
   */
  steered: ((u: Unit) => boolean) | null = null;

  constructor(
    private readonly session: NetSession,
    private readonly sim: Sim,
    /** A guest left mid-match: hand the unit they controlled to a bot. */
    private readonly toBot: (u: Unit, player: string) => void,
    private readonly toast: (text: string) => void,
  ) {
    for (const id of session.guests) this.waiting.add(id);
    session.listen((from, msg) => this.onMessage(from, msg));
    session.onLeave = (id) => this.left(id);
    // the host moving a guest's unit itself (respawn, recall, blink, a mode's teleport) makes their older inputs stale
    sim.listeners.push((e) => {
      if (e.type !== 'teleport') return;
      for (const rp of this.remotes.values()) if (rp.unit === e.unit) rp.seq++;
    });
  }

  /**
   * Give a guest control of a unit: at the start, or later when the mode moves
   * them to another one (the guest is told with their next snapshot).
   */
  assign(player: string, u: Unit): void {
    const rp = this.remotes.get(player);
    if (!rp) {
      this.remotes.set(player, new RemotePlayer(player, u));
      return;
    }
    if (rp.unit === u) return;
    rp.unit = u;
    rp.seq++;
    rp.inputs.length = 0;
    rp.basic = false;
    rp.wasForced = !!u.forced;
    this.sync?.setSelf(player, u);
  }

  /** The unit a guest controls, if they are still in the match. */
  unitOf(player: string): Unit | undefined {
    return this.remotes.get(player)?.unit;
  }

  /** Called once every guest has their unit (see `assign`). */
  bind(match: NetMatch, roster: Roster): void {
    this.sync = new HostSync(this.sim, match, roster, (u) => this.seqOf(u), (id) => this.remotes.get(id)?.unit.team ?? null);
    // a guest who left while everyone loaded becomes a bot right away
    for (const rp of [...this.remotes.values()]) if (!this.session.guests.includes(rp.id)) this.left(rp.id);
  }

  /** This end has finished loading. */
  ready(): void {
    this.localReady = true;
    this.tryStart();
  }

  /** Each step before the match starts: give up on slow guests after a while. */
  wait(dt: number): void {
    this.waited += dt;
    if (this.localReady && this.waited > READY_TIMEOUT) this.begin();
  }

  /** Before the simulation steps: move guests' gods to where their inputs say. */
  beforeStep(): void {
    for (const rp of this.remotes.values()) {
      const u = rp.unit;
      this.before.set(u, { x: u.x, z: u.z });
      while (rp.inputs.length > MAX_QUEUED) rp.inputs.shift();
      const i = rp.inputs.shift();
      if (!i) continue;
      u.aim.x = i.a[0];
      u.aim.z = i.a[1];
      rp.basic = i.b === 1;
      if (i.s !== rp.seq || !u.alive || !this.sim.canMove(u) || this.steered?.(u)) continue;
      const moved = hypot(i.p[0] - u.x, i.p[2] - u.z);
      u.body.x = i.p[0];
      u.body.y = i.p[1];
      u.body.z = i.p[2];
      u.body.yaw = i.p[3];
      // the simulation only sees its own steps' movement, so a walking guest cancels their recall here
      if (moved > 0.02) this.sim.interruptRecall(u);
    }
    for (const rp of this.remotes.values()) if (rp.basic && rp.unit.alive) this.basic(rp.unit);
  }

  /** Where each guest's god stood before its input moved it, for its walking speed. */
  private readonly before = new Map<Unit, { x: number; z: number }>();

  /** After the simulation steps: guests' walking speed, authority changes, and snapshots. */
  afterStep(dt: number): void {
    if (!this.started) return;
    for (const rp of this.remotes.values()) {
      const u = rp.unit;
      const b = this.before.get(u);
      // input moved the god before the step, which the simulation's own velocity misses
      if (b) {
        u.vx = (u.x - b.x) / dt;
        u.vz = (u.z - b.z) / dt;
      }
      if (rp.wasForced && !u.forced) rp.seq++;
      rp.wasForced = !!u.forced;
    }
    if (++this.steps % SNAPSHOT_EVERY !== 0 || !this.sync) return;
    for (const [id, snap] of this.sync.snapshots()) this.session.send(id, encode(snap));
  }

  private seqOf(u: Unit): number {
    for (const rp of this.remotes.values()) if (rp.unit === u) return rp.seq;
    return 0;
  }

  private onMessage(from: string, msg: Msg): void {
    const rp = this.remotes.get(from);
    switch (msg.t) {
      case 'ready':
        this.waiting.delete(from);
        if (this.started) this.addGuest(from);
        this.tryStart();
        return;
      case 'in':
        rp?.inputs.push(msg as unknown as Input);
        return;
      case 'cast': {
        if (!rp || !this.started) return;
        const [ax, az] = msg.a as [number, number];
        rp.unit.aim.x = ax;
        rp.unit.aim.z = az;
        this.sim.cast(rp.unit, msg.slot as number);
        return;
      }
      case 'recall':
        if (rp && this.started) this.sim.startRecall(rp.unit);
        return;
      case 'build':
        rp?.unit.combatant.setBuild(msg.loadout as readonly string[], msg.allocation as Allocation);
        return;
      case 'act':
        if (rp && this.started) this.onAct?.(rp.unit, msg, from);
        return;
      case 'ping': {
        if (!rp || !this.started || !isPingKind(msg.k)) return;
        const subject = typeof msg.s === 'number' && msg.s > 0 ? (this.sim.units.find((u) => u.id === msg.s) ?? null) : null;
        this.sim.ping(rp.unit, msg.k, Number(msg.x), Number(msg.z), subject);
        return;
      }
      default:
        return;
    }
  }

  private tryStart(): void {
    if (this.started) return;
    const names = this.session.players.filter((p) => this.waiting.has(p.id)).map((p) => p.name);
    if (this.localReady && names.length === 0) this.begin();
    else if (this.localReady) showNetStatus(`Waiting for ${names.join(' and ')} to finish loading…`);
  }

  private begin(): void {
    this.started = true;
    showNetStatus(null);
    for (const id of this.session.guests) if (!this.waiting.has(id)) this.addGuest(id);
    this.session.broadcast({ t: 'go' });
  }

  private addGuest(id: string): void {
    this.sync?.addGuest(id);
    // a guest who finished loading after the mode moved them is told where they are
    const u = this.remotes.get(id)?.unit;
    if (u) this.sync?.setSelf(id, u);
  }

  private left(id: string): void {
    const rp = this.remotes.get(id);
    this.waiting.delete(id);
    this.sync?.removeGuest(id);
    if (!rp || !rp.unit) {
      this.tryStart();
      return;
    }
    this.remotes.delete(id);
    const name = this.session.players.find((p) => p.id === id)?.name ?? 'A player';
    this.toBot(rp.unit, id);
    this.toast(`${name} left; a bot took over their god`);
    this.tryStart();
  }
}

/**
 * A guest's end of a networked match: draws the host's snapshots and sends
 * this player's movement, aim and actions.
 */
export class NetGuest {
  private readonly sync: GuestSync;
  private applied = 0;
  private lastBuild = '';
  /** Whether the basic attack button is held, as CombatGame decides it. */
  basic = false;
  /**
   * The host moved this player to another unit (a mode's rotation). The
   * handler must move the controller's body onto it before returning.
   */
  onSelf: ((u: Unit) => void) | null = null;

  constructor(
    private readonly session: NetSession,
    sim: Sim,
    match: NetMatch,
    roster: Roster,
    private self: Unit,
    private readonly ctrl: PlayerController,
  ) {
    this.sync = new GuestSync(sim, match, roster, self);
    this.sync.onSelf = (u) => {
      this.self = u;
      this.lastBuild = '';
      this.onSelf?.(u);
    };
    session.listen((_from, msg) => {
      if (msg.t === 'snap') {
        this.sync.receive(msg as Snapshot);
        if (this.sync.live) showNetStatus(null);
      }
    });
    session.onLeave = () => showNetStatus('The host left the match.', { label: 'Back to the title screen', run: () => location.assign(location.pathname) });
  }

  ready(): void {
    this.session.send('host', { t: 'ready' });
    if (!this.sync.live) showNetStatus('Waiting for the other players to finish loading…');
  }

  get live(): boolean {
    return this.sync.live;
  }

  /** Structures and what they shoot at, for the targeting beams. */
  targets(): Iterable<readonly [Unit, Unit | null]> {
    return this.sync.targets;
  }

  /** Each fixed step: place the match's units, correct this player's god when the host moved it, and send input. */
  step(dt: number): void {
    this.sync.step(dt);
    const u = this.self;
    const f = this.sync.latestSelf;
    const ctrl = this.ctrl;
    if (f && f[F.seq]! > this.applied && f[F.arc] === 0) {
      this.applied = f[F.seq]!;
      // respawns and recalls face the god down the lane; anything else keeps the camera's aim
      const home = hypot(f[F.x]! - u.home.x, f[F.z]! - u.home.z) < 0.01;
      ctrl.spawn(f[F.x]!, f[F.z]!, home ? f[F.yaw]! : ctrl.yaw);
    }
    const lerp = this.sync.selfPlace;
    if (u.forced && lerp) ctrl.position.set(lerp.x, lerp.y, lerp.z);
    if (!this.sync.live) return;
    const p = ctrl.position;
    this.session.send('host', { t: 'in', s: this.applied, p: [p.x, p.y, p.z, ctrl.yaw], a: [u.aim.x, u.aim.z], b: this.basic ? 1 : 0 });
  }

  cast(slot: number): void {
    this.session.send('host', { t: 'cast', slot, a: [this.self.aim.x, this.self.aim.z] });
  }

  recall(): void {
    this.session.send('host', { t: 'recall' });
  }

  /** Units the host walks from this player's intent: drawn from snapshots even while this player controls one (see NetHost.steered). */
  set steered(fn: ((u: Unit) => boolean) | null) {
    this.sync.steered = fn;
  }

  /** A quick call to this player's team: the host checks it and passes it on to them. */
  ping(kind: PingKind, x: number, z: number, subject: Unit | null): void {
    this.session.send('host', { t: 'ping', k: kind, x, z, s: subject ? this.sync.hostId(subject) : 0 });
  }

  /** A mode's own message to the host (its `NetHost.onAct` gets it, with this player's unit). */
  act(msg: Record<string, unknown>): void {
    this.session.send('host', { ...msg, t: 'act' });
  }

  /** Send this player's loadout and tree points when the skills menu changed them. */
  syncBuild(): void {
    // the host keeps the build of a unit it runs for this player (see steered)
    if (this.sync.steered?.(this.self)) return;
    const c = this.self.combatant;
    const build = JSON.stringify([c.loadout, c.allocation]);
    if (build === this.lastBuild) return;
    this.lastBuild = build;
    this.session.send('host', { t: 'build', loadout: c.loadout, allocation: c.allocation });
  }
}
