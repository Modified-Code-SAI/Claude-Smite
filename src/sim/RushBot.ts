import type { Side } from '../game/combatant';
import { SLOT_COUNT, ULTIMATE_SLOT } from '../game/loadout';
import { PLAYMAKER } from '../game/sport';
import { treeOrder } from '../game/trees';
import { hypot } from '../core/math';
import { reachOf, skillRole } from './Bot';
import type { Nav } from './Nav';
import { clampToPitch, FUMBLE_CC, inGate, Rush, RUSH } from './Rush';
import { MARK_MAX, type Sim } from './Sim';
import { WORLD_SCALE, type Brain, type FlashShape, type Point, type Unit } from './Unit';

const SLOTS = Array.from({ length: SLOT_COUNT }, (_, i) => i);

/**
 * What a sport bot is doing this moment. The team shares them out every
 * step: with the relic loose two chase it and one guards the gate; with a
 * teammate carrying, one escorts and one runs ahead for a pass; against an
 * enemy carrier, one presses, one cuts off the way to the gate and one keeps
 * the gate.
 */
export type RushRole = 'carry' | 'escort' | 'lead' | 'chase' | 'support' | 'guard' | 'press' | 'cut' | 'goalie';

/**
 * Elbow room: gods don't block each other, so without it a defender pressing
 * the carrier stood inside their body about half the time someone carried.
 * Bots step apart from any god within `room` meters (center to center; two
 * god radii are 1.2), and a presser within `close` meters of the carrier goes
 * at them and stops `gap` meters short of touching. A carrier steers around
 * defenders ahead, but one within `near` meters counts only `nearWeight` as
 * much: dodging hard around a marker at arm's length boxed carriers in,
 * dancing in front of them for seconds.
 */
const MARK = { room: 1.3, gap: 0.15, close: 4, near: 2.2, nearWeight: 0.7 } as const;

/** A defender less than this far (meters) to either side of the carrier's line counts as dead ahead. */
const DEAD_AHEAD = 0.6;

/** How far ahead (meters) a carrier feels for scenery in the way it means to break. */
const PROBE = 0.6;

const other = (t: Side): Side => (t === 'order' ? 'chaos' : 'order');
const dist = (a: Point, b: Point) => hypot(a.x - b.x, a.z - b.z);
/** (x, z) as a unit direction, or null if it has no length to speak of. */
const unit = (x: number, z: number): Point | null => {
  const d = hypot(x, z);
  return d > 1e-3 ? { x: x / d, z: z / d } : null;
};

/** Shares the roles out for both teams once per step. */
export class RushCoach {
  private readonly roles = new Map<Unit, RushRole>();
  private at = -1;

  constructor(
    private readonly sim: Sim,
    private readonly rush: Rush,
  ) {}

  roleOf(u: Unit): RushRole {
    if (this.at !== this.sim.time) {
      this.at = this.sim.time;
      this.assign();
    }
    return this.roles.get(u) ?? 'chase';
  }

  private assign(): void {
    this.roles.clear();
    const rush = this.rush;
    const holder = rush.holder;
    for (const side of ['order', 'chaos'] as const) {
      const gods = rush.team(side).filter((g) => g.alive);
      const gate = RUSH.gates[side];
      const nearest = (list: Unit[], p: Point) => list.reduce<Unit | null>((b, g) => (!b || dist(g, p) < dist(b, p) ? g : b), null);
      const set = (g: Unit | null, r: RushRole) => g && this.roles.set(g, r);
      if (holder && holder.team === side) {
        this.roles.set(holder, 'carry');
        const rest = gods.filter((g) => g !== holder);
        const escort = nearest(rest, holder);
        set(escort, 'escort');
        for (const g of rest) if (g !== escort) set(g, 'lead');
      } else if (holder) {
        // one presses the carrier; whoever is nearest our gate keeps it (from the moment they take the relic, so a quick break finds someone home); the last cuts the way in
        const press = nearest(gods, holder)!;
        set(press, 'press');
        const rest = gods.filter((g) => g !== press);
        const threat = dist(holder, gate);
        const keeper = nearest(rest, gate);
        set(keeper, 'goalie');
        for (const g of rest) if (g !== keeper) set(g, threat < 12 ? 'press' : 'cut');
      } else {
        const t = rush.target;
        const chase = nearest(gods, t)!;
        set(chase, 'chase');
        const rest = gods.filter((g) => g !== chase);
        const guard = rest.length > 1 ? nearest(rest, gate) : dist(rest[0] ?? t, t) > 11 ? rest[0]! : null;
        set(guard, 'guard');
        for (const g of rest) if (g !== guard) set(g, dist(g, t) < 11 ? 'chase' : 'support');
      }
    }
  }
}

export interface RushBotOptions {
  /** Chance per decision (about four a second) to use a ready skill. */
  aggression: number;
}

/**
 * A Relic Rush bot: plays its team role, steers around defenders while
 * carrying, passes to open teammates when pressed, shoots when the gate is
 * open, and spends its crowd control on whoever holds the relic.
 */
export class RushBot implements Brain {
  private decide = 0;
  private passCheck = 0;
  private jukeCheck = 0;
  private callCheck = 0;
  private lastCall = -99;
  /** The order this bot spends tree points, chosen once the line-up is known (see plan). */
  private build: string[] | null = null;
  /** Which flank this bot runs when leading the attack. */
  private readonly side: number;
  private route: { goal: Point; next: Point; at: number } | null = null;
  /** Which way (+1 or -1) the carrier breaks past a defender dead ahead, kept until one shows a clear side. */
  private veer = 1;
  /** Carrying: steering out from beside a gate pillar to the front of its mouth (see mouth). */
  private besidePillar = false;
  /** Scratch for elbowRoom. */
  private readonly room = { x: 0, z: 0 };

  constructor(
    private readonly sim: Sim,
    private readonly u: Unit,
    private readonly rush: Rush,
    private readonly coach: RushCoach,
    private readonly nav: Nav | null,
    readonly options: RushBotOptions = { aggression: 0.45 },
  ) {
    this.side = u.combatant.uid % 2 === 0 ? 1 : -1;
  }

  /**
   * The wings of each line-up (first and third) are playmakers who fill the
   * sport tree first; the middle fights first and adds sport after, so both
   * teams field the same mix.
   */
  private plan(): string[] {
    const c = this.u.combatant;
    const main = treeOrder(c.god.trees[c.uid % 3]!, true);
    const wing = this.rush.team(this.u.team as Side).indexOf(this.u) !== 1;
    return wing ? [...treeOrder(PLAYMAKER, true), ...main] : [...main, ...treeOrder(PLAYMAKER, false)];
  }

  update(dt: number): void {
    const { u, rush } = this;
    u.move = null;
    const c = u.combatant;
    this.build ??= this.plan();
    while (c.unspentPoints > 0 && this.build.some((id) => c.allocate(id) === null));
    if (!u.alive || u.forced || rush.frozen) return;
    if (rush.phase === 'goal') {
      // the celebration: the scorer stands and cheers while their team runs over to them, then everyone drifts back toward the kickoff line
      const g = rush.lastGoal;
      const t = RUSH.celebrate - rush.timer;
      if (g && g.scorer === u && t < RUSH.cheer.scorerHold) return;
      if (g && g.team === u.team && g.scorer !== u && t < RUSH.cheer.mobUntil) {
        this.walkTo(g.scorer, 2.2);
        return;
      }
      this.walkTo({ x: u.x * 0.6, z: (u.team === 'order' ? 1 : -1) * 9 }, 2);
      return;
    }
    const role = this.coach.roleOf(u);
    if (role === 'carry') {
      this.carry(dt);
      return;
    }
    const goal = this.goalFor(role);
    // (a presser's spot is the carrier, nobody else's)
    this.walkTo(goal, this.stopFor(role), { shared: role !== 'press' });
    this.fight(dt, role);
    this.maybeCall(dt);
  }

  // -------------------------------------------------------------------------
  // Positions

  private goalFor(role: RushRole): Point {
    const { u, rush } = this;
    const mine = u.team as Side;
    const ownGate = RUSH.gates[mine];
    const theirGate = RUSH.gates[other(mine)];
    const holder = rush.holder;
    const t = rush.target;
    switch (role) {
      case 'chase':
        return t;
      case 'support': {
        // a step toward their gate from the relic, ready for a quick pass
        const dx = theirGate.x - t.x;
        const dz = theirGate.z - t.z;
        const d = hypot(dx, dz) || 1;
        return clampToPitch(t.x + (dx / d) * 9 + this.side * 5, t.z + (dz / d) * 9, 2);
      }
      case 'guard': {
        const dx = t.x - ownGate.x;
        const dz = t.z - ownGate.z;
        const d = hypot(dx, dz) || 1;
        const k = Math.min(8, d * 0.5);
        return { x: ownGate.x + (dx / d) * k, z: ownGate.z + (dz / d) * k };
      }
      case 'escort': {
        if (!holder) return t;
        // between the carrier and the nearest enemy, or just ahead of the carrier
        const foe = this.nearestEnemy(holder, 12);
        if (foe) {
          const dx = foe.x - holder.x;
          const dz = foe.z - holder.z;
          const d = hypot(dx, dz) || 1;
          return { x: holder.x + (dx / d) * 2.6, z: holder.z + (dz / d) * 2.6 };
        }
        const dx = theirGate.x - holder.x;
        const dz = theirGate.z - holder.z;
        const d = hypot(dx, dz) || 1;
        return { x: holder.x + (dx / d) * 3 - this.side * (dz / d) * 2, z: holder.z + (dz / d) * 3 + this.side * (dx / d) * 2 };
      }
      case 'lead': {
        if (!holder) return t;
        // ahead of the carrier on a flank, open for a pass
        const dx = theirGate.x - holder.x;
        const dz = theirGate.z - holder.z;
        const d = hypot(dx, dz) || 1;
        const ahead = Math.min(11, d);
        let side = this.side;
        const p = (s: number) => clampToPitch(holder.x + (dx / d) * ahead - s * (dz / d) * 6, holder.z + (dz / d) * ahead + s * (dx / d) * 6, 2);
        // run the flank with more room
        if (this.crowd(p(side)) > this.crowd(p(-side)) + 1) side = -side;
        return p(side);
      }
      case 'press':
        if (!holder) return t;
        // from afar, lead their run; close by, go at them (and stop at arm's length, see stopFor)
        return dist(u, holder) > MARK.close ? { x: holder.x + holder.vx * 0.3, z: holder.z + holder.vz * 0.3 } : { x: holder.x, z: holder.z };
      case 'cut': {
        if (!holder) return t;
        // well back on the way in: the carrier has to get past them, not just round them
        return { x: holder.x + (ownGate.x - holder.x) * 0.6, z: holder.z + (ownGate.z - holder.z) * 0.6 };
      }
      case 'goalie': {
        // in the gate's mouth, a step toward the plaza, shading toward the threat
        const s = Math.sign(-ownGate.z);
        const threat = holder ?? t;
        const x = Math.max(-2.5, Math.min(2.5, threat.x * 0.3));
        return { x, z: ownGate.z + s * 1.6 };
      }
      default:
        return t;
    }
  }

  /** How near its spot a bot in this role stops. */
  private stopFor(role: RushRole): number {
    if (role === 'goalie' || role === 'guard') return 1.2;
    const h = this.rush.holder;
    if (role === 'press' && h && dist(this.u, h) <= MARK.close) return h.radius + this.u.radius + MARK.gap;
    return 0.4;
  }

  /** How many enemies stand within 5 m of a point. */
  private crowd(p: Point): number {
    let n = 0;
    for (const e of this.enemies()) if (dist(e, p) < 5) n++;
    return n;
  }

  private enemies(): Unit[] {
    return this.rush.team(other(this.u.team as Side)).filter((g) => g.alive);
  }

  private allies(): Unit[] {
    return this.rush.team(this.u.team as Side).filter((g) => g.alive && g !== this.u);
  }

  private nearestEnemy(from: Point, within: number): Unit | null {
    let best: Unit | null = null;
    let bestD = within;
    for (const e of this.enemies()) {
      const d = dist(e, from);
      if (d < bestD) [best, bestD] = [e, d];
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Carrying

  private carry(dt: number): void {
    const { u, rush } = this;
    const mine = u.team as Side;
    const gate = RUSH.gates[other(mine)];
    const toGate = dist(u, gate);
    this.passCheck -= dt;
    if (this.passCheck <= 0 && this.sim.time - rush.relic.since > RUSH.relic.holdMin) {
      this.passCheck = 0.2;
      if (this.tryShot(gate, toGate) || this.answerCall() || this.tryPass(gate, toGate)) return;
    }
    this.jukeCheck -= dt;
    if (this.jukeCheck <= 0) {
      this.jukeCheck = 0.12;
      if (this.tryJuke(gate)) return;
    }
    // run at the gate's mouth, steering around defenders in the way
    const aim = this.mouth(gate);
    let dx = aim.x - u.x;
    let dz = aim.z - u.z;
    const d = hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    let ax = 0;
    let az = 0;
    for (const e of this.enemies()) {
      const ex = e.x - u.x;
      const ez = e.z - u.z;
      const ed = hypot(ex, ez);
      if (ed > 8 || ed < 1e-3) continue;
      const ahead = (ex * dx + ez * dz) / ed;
      if (ahead < -0.3) continue;
      // push sideways, away from the defender's side of the line (this once pushed toward it); one dead ahead is passed the way the carrier was already breaking (choosing afresh each step, it jittered left and right in place)
      const across = ex * dz - ez * dx;
      const side = Math.abs(across) < DEAD_AHEAD ? this.veer : across > 0 ? 1 : -1;
      if (ed < 4 && Math.abs(across) >= DEAD_AHEAD) this.veer = side;
      const w = ((8 - ed) / 8) * (0.6 + ahead) * (ed < MARK.near ? MARK.nearWeight : 1);
      ax += -dz * side * w * 1.6 - (ex / ed) * w * 0.5;
      az += dx * side * w * 1.6 - (ez / ed) * w * 0.5;
    }
    // close to the gate, go straight in
    const k = toGate < 5 ? 0.2 : 1;
    let sx = dx + ax * k;
    let sz = dz + az * k;
    if (hypot(sx, sz) < 0.4) {
      // hemmed in, defenders on both shoulders cancel out: break the way it was breaking (toward the middle near the pitch's edge), as standing still only invites the tackle
      if (hypot(u.x, u.z) > RUSH.pitchRadius - 4) this.veer = -dz * -u.x + dx * -u.z >= 0 ? 1 : -1;
      sx = dx * 0.5 - dz * this.veer;
      sz = dz * 0.5 + dx * this.veer;
    }
    if (this.blocked(sx, sz)) {
      // breaking into a column or pillar: break the other way past them, or failing that run straight on
      const lat = sx * -dz + sz * dx;
      const mx = sx + 2 * lat * dz;
      const mz = sz - 2 * lat * dx;
      if (!this.blocked(mx, mz)) {
        [sx, sz] = [mx, mz];
        this.veer = -this.veer;
      } else [sx, sz] = [dx, dz];
    }
    const step = clampToPitch(u.x + sx * 3, u.z + sz * 3, 1.5);
    // (straight at the step, not through the pathfinder: the steering and the scenery probe above see to what's in the way, and the grid's tie-breaks
    // round pillars favor one way of the world, which gave Order's carriers, running at the other gate, an edge: Order won 60% of bot matches)
    this.walkTo(step, 0.1, { face: true, direct: true });
  }

  /** Whether scenery stops most of a short step this way (a column or pillar right there). */
  private blocked(x: number, z: number): boolean {
    const { u, sim } = this;
    const d = hypot(x, z);
    if (d < 1e-3) return false;
    const nx = u.x + (x / d) * PROBE;
    const nz = u.z + (z / d) * PROBE;
    const r = sim.solid(nx, nz, u.radius, u.body.y + u.stepOver, u, sim.terrain, u);
    return hypot(r.x - u.x, r.z - u.z) < PROBE * 0.5;
  }

  /**
   * Juke a tackle about to land: an enemy's crowd control winding up over
   * the carrier, a stunning shot about to arrive, or (less often, as it's a
   * guess) an enemy in reach with crowd control ready. Sidesteps away from
   * them, still toward the gate.
   */
  private tryJuke(gate: Point): boolean {
    const { u, rush, sim } = this;
    if (rush.jukeLeft(u) > 0) return false;
    const threat = this.incoming();
    let foe: Unit | null = threat;
    if (!foe) {
      for (const e of this.enemies()) if (dist(e, u) < 2.4 && !e.forced && this.hasReadyCC(e)) foe = e;
      if (!foe || sim.rng() > 0.2) return false;
    } else if (sim.rng() > 0.75) return false;
    let gx = gate.x - u.x;
    let gz = gate.z - u.z;
    const g = hypot(gx, gz) || 1;
    gx /= g;
    gz /= g;
    // sideways, away from the tackler's side of the run, and a little on toward the gate
    const ex = foe.x - u.x;
    const ez = foe.z - u.z;
    const side = ex * gz - ez * gx > 0 ? -1 : 1;
    return rush.juke(u, { x: -gz * side + gx * 0.5, z: gx * side + gz * 0.5 });
  }

  /** The enemy whose crowd control is about to hit this bot: a wind-up over it, or a shot on its way in. */
  private incoming(): Unit | null {
    const { u, sim } = this;
    const soon = RUSH.juke.guard * 0.9;
    for (const f of sim.flashes) {
      if (!f.warn || f.owner.team === u.team || f.life - f.age > soon || f.act === 'basic') continue;
      if (inShape(f.shape, u.x, u.z, u.radius + 0.4) && this.stuns(f.owner)) return f.owner;
    }
    // a ground blast's warning circle, about to land
    for (const z of sim.zones) {
      if (z.ticks !== 0 || z.timer <= 0 || z.timer > soon || z.owner.team === u.team) continue;
      if (hypot(u.x - z.x, u.z - z.z) > z.radius + u.radius + 0.3) continue;
      if (z.cast.hits.some((h) => h.kind === 'cc' && FUMBLE_CC.has(h.cc))) return z.owner.owner ?? z.owner;
    }
    for (const p of sim.projectiles) {
      if (!p.alive || !p.cast || p.owner.team === u.team || p.hit.has(u)) continue;
      if (!p.cast.hits.some((h) => h.kind === 'cc' && FUMBLE_CC.has(h.cc))) continue;
      // closest approach along its flight, and how soon
      const rx = u.x - p.x;
      const rz = u.z - p.z;
      const along = rx * p.dx + rz * p.dz;
      if (along < 0 || along > p.range - p.traveled || along / p.speed > soon) continue;
      if (Math.abs(rx * p.dz - rz * p.dx) < p.radius + u.radius + 0.3) return p.owner.owner ?? p.owner;
    }
    return null;
  }

  /** Whether a god's wound-up skill knocks the relic loose. */
  private stuns(e: Unit): boolean {
    const f = this.sim.flashes.find((x) => x.owner === e && x.warn);
    const id = f?.act;
    if (!id) return false;
    const c = e.combatant;
    for (const s of SLOTS) {
      const r = c.resolve(s);
      if (r.skill.id === id) return r.hits.some((h) => h.kind === 'cc' && FUMBLE_CC.has(h.cc));
    }
    return true;
  }

  /** The point to run at to pass through the gate: its center, from whichever side the carrier is on. */
  private mouth(gate: Point): Point {
    const { u } = this;
    const out = Math.sign(gate.z);
    // from behind the gate (beyond it, seen from the temple), come back through it
    const behind = (u.z - gate.z) * out > RUSH.gateDepth;
    const x = Math.max(-3, Math.min(3, u.x * 0.5));
    // beside a pillar: step in front of the mouth first, and keep at it until in line with the mouth (at the region's
    // edge the two aims point opposite ways, and a carrier on it, pushed back and forth by defenders, turned about every step)
    this.besidePillar = Math.abs(u.x) > RUSH.gateHalfWidth + 0.5 && Math.abs(u.z - gate.z) < (this.besidePillar ? 5 : 3);
    if (this.besidePillar) return { x: 0, z: gate.z - out * 3.5 * (behind ? -1 : 1) };
    return { x, z: gate.z + out * (behind ? -0.2 : 0.4) };
  }

  /** Throw through the gate when close and nobody is in its mouth to catch it. */
  private tryShot(gate: Point, toGate: number): boolean {
    const { u, rush } = this;
    if (toGate > 11 || toGate < 4.5) return false;
    // only from in front of the gate: a throw from the side hits a pillar's line
    const out = Math.sign(gate.z);
    if ((gate.z - u.z) * out < 3 || Math.abs(u.x) > Math.abs(gate.z - u.z) * 0.9) return false;
    const target = { x: gate.x + (u.x > 0 ? 0.8 : -0.8), z: gate.z };
    for (const e of this.enemies()) {
      if (dist(e, target) < 4.5) return false;
      // a defender standing on the throw's line, close to the thrower, blocks it
      if (this.onLine(e, target, 1.4)) return false;
    }
    if (!rush.passRead(u, target).goal) return false;
    return rush.throwRelic(u, target);
  }

  /** Whether an enemy stands near the low ends of a throw to `to` (from this bot, or from `u`). */
  private onLine(e: Unit, to: Point, width: number, u: Point = this.u): boolean {
    const dx = to.x - u.x;
    const dz = to.z - u.z;
    const len = hypot(dx, dz) || 1;
    const along = ((e.x - u.x) * dx + (e.z - u.z) * dz) / len;
    if (along < 0 || along > len) return false;
    const side = Math.abs((e.x - u.x) * dz - (e.z - u.z) * dx) / len;
    // the middle of a long throw flies too high to block
    const p = along / len;
    const low = len < 9 || p < 0.25 || p > 0.75;
    return low && side < width + e.radius;
  }

  /** A teammate called for the pass: throw it to them (leading their run) unless an enemy stands on the line. */
  private answerCall(): boolean {
    const { u, rush } = this;
    let best: { at: Point; ago: number } | null = null;
    for (const t of this.allies()) {
      const ago = rush.calledAgo(t);
      if (ago === null || t.forced) continue;
      const guess = Rush.flightTime(dist(u, t), u.combatant.sport('throwSpeed'));
      const at = clampToPitch(t.x + t.vx * guess, t.z + t.vz * guess, 1.5);
      const d = dist(u, at);
      if (d < RUSH.relic.minThrow || d > Rush.maxThrow(u)) continue;
      if (this.enemies().some((e) => this.onLine(e, at, 0.9) || dist(e, at) < 3)) continue;
      if (rush.passRead(u, at).catcher !== t) continue;
      // the latest call wins
      if (!best || ago < best.ago) best = { at, ago };
    }
    return !!best && rush.throwRelic(u, best.at);
  }

  /**
   * Off the relic while a teammate who isn't a bot carries it (the player, or
   * a friend online): call for the pass when open and ahead of them.
   */
  private maybeCall(dt: number): void {
    const { u, rush } = this;
    this.callCheck -= dt;
    if (this.callCheck > 0) return;
    this.callCheck = 0.5;
    const h = rush.holder;
    if (!h || h.team !== u.team || h === u || h.brain instanceof RushBot || rush.calledAgo(u) !== null) return;
    if (this.sim.time - this.lastCall < 4) return;
    const gate = RUSH.gates[other(u.team as Side)];
    const d = dist(u, h);
    const ahead = dist(h, gate) - dist(u, gate);
    const open = !this.nearestEnemy(u, 5) && !this.enemies().some((e) => this.onLine(e, u, 1, h));
    if (open && ahead > 2 && d > RUSH.relic.minThrow + 2 && d < Rush.maxThrow(h) - 1 && rush.call(u)) this.lastCall = this.sim.time;
  }

  /** Pass to the most open teammate when pressed, or long to a runner well ahead. */
  private tryPass(gate: Point, toGate: number): boolean {
    const { u, rush } = this;
    const R = RUSH.relic;
    const foe = this.nearestEnemy(u, 9);
    const pressure = foe ? dist(foe, u) : Infinity;
    // a stun is coming if an enemy close by has crowd control ready
    const danger = foe !== null && (pressure < 4.5 || (pressure < 8 && this.hasReadyCC(foe)));
    let best: { at: Point; score: number } | null = null;
    for (const t of this.allies()) {
      if (t.forced) continue;
      const guess = Rush.flightTime(dist(u, t), u.combatant.sport('throwSpeed'));
      const at = clampToPitch(t.x + t.vx * guess, t.z + t.vz * guess, 1.5);
      const d = dist(u, at);
      if (d < R.minThrow + 1 || d > Rush.maxThrow(u)) continue;
      let open = Infinity;
      for (const e of this.enemies()) {
        open = Math.min(open, dist(e, at));
        if (this.onLine(e, at, 1.2)) open = 0;
      }
      const progress = toGate - dist(at, gate);
      const score = Math.min(open, 9) + progress * 0.35;
      if (open < 3.5 || progress < -6) continue;
      if (rush.passRead(u, at).catcher !== t) continue;
      if (!best || score > best.score) best = { at, score };
    }
    if (!best) return false;
    const long = !danger && best.score > 9 && toGate > 14;
    if (!danger && !long) return false;
    return rush.throwRelic(u, best.at);
  }

  private hasReadyCC(e: Unit): boolean {
    const c = e.combatant;
    for (const s of SLOTS) {
      if (c.canCast(s) !== null) continue;
      if (c.resolve(s).hits.some((h) => h.kind === 'cc' && FUMBLE_CC.has(h.cc))) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Fighting

  /** Basic attacks on whoever is in reach (the carrier first), and skills now and then. */
  private fight(dt: number, role: RushRole): void {
    const { u, sim, rush } = this;
    const c = u.combatant;
    const holder = rush.holder;
    const enemyCarrier = holder && holder.team !== u.team ? holder : null;
    const basic = c.god.basicAttack;
    const reach = basic.range * WORLD_SCALE;
    // the carrier when there is one; otherwise whoever is closest to the relic or our carrier
    const focus: Point = enemyCarrier ?? holder ?? rush.target;
    let target: Unit | null = enemyCarrier && dist(enemyCarrier, u) <= reach + enemyCarrier.radius + 2 ? enemyCarrier : null;
    if (!target) {
      let bestD = Infinity;
      for (const e of this.enemies()) {
        const d = dist(e, u);
        if (d > reach + e.radius + 1 || e.stealth > 0) continue;
        const score = d + dist(e, focus) * 0.5;
        if (score < bestD) [target, bestD] = [e, score];
      }
    }
    if (target) {
      this.aimAt(target);
      sim.basic(u);
    }
    this.decide -= dt;
    if (this.decide > 0) return;
    this.decide = 0.25;
    if (sim.rng() > this.options.aggression) return;
    this.castSomething(role, enemyCarrier);
  }

  private castSomething(role: RushRole, enemyCarrier: Unit | null): void {
    const { u, sim, rush } = this;
    const c = u.combatant;
    const hp = c.health / c.stats.maxHealth;
    const ready = SLOTS.filter((s) => c.canCast(s) === null);
    if (!ready.length) return;
    const holder = rush.holder;
    // 1. crowd control on the enemy carrier
    if (enemyCarrier && enemyCarrier.targetable) {
      const d = dist(enemyCarrier, u);
      for (const s of ready) {
        const cast = c.resolve(s);
        if (!cast.hits.some((h) => h.kind === 'cc' && FUMBLE_CC.has(h.cc))) continue;
        // a tackle that sets off a mark only knocks the relic loose at full stacks (fewer is damage, and spends the mark)
        if (cast.skill.detonates && (enemyCarrier.marks.get(cast.skill.detonates)?.stacks ?? 0) < MARK_MAX) continue;
        if (reachOf(u, s) + enemyCarrier.radius < d) continue;
        // a keeper doesn't dash out of its gate after a carrier still far off
        const moves = cast.targeting.type === 'dash' || cast.targeting.type === 'leap' || cast.hits.some((h) => h.kind === 'movement');
        if (role === 'goalie' && moves && d > 6) continue;
        this.aimAt(enemyCarrier);
        if (sim.cast(u, s) === null) return;
      }
      // a tackle that waits on a mark (Zeus's Static Discharge on a Charge): put the mark on the carrier first
      for (const s of ready) {
        const mark = c.resolve(s).skill.detonates;
        if (!mark || (enemyCarrier.marks.get(mark)?.stacks ?? 0) >= MARK_MAX || !c.resolve(s).hits.some((h) => h.kind === 'cc' && FUMBLE_CC.has(h.cc))) continue;
        for (const p of ready) {
          if (p === s || reachOf(u, p) + enemyCarrier.radius < d) continue;
          if (!c.resolve(p).hits.some((h) => h.kind === 'mark' && h.mark === mark)) continue;
          this.aimAt(enemyCarrier);
          if (sim.cast(u, p) === null) return;
        }
      }
    }
    // 2. close the distance to the relic or the carrier with a dash or leap
    if (role === 'chase' || role === 'press') {
      const to = role === 'press' && enemyCarrier ? enemyCarrier : rush.target;
      const d = dist(to, u);
      for (const s of ready) {
        const cast = c.resolve(s);
        const t = cast.targeting.type;
        if (t !== 'dash' && t !== 'leap' && !cast.hits.some((h) => h.kind === 'movement')) continue;
        const r = reachOf(u, s);
        if (d < 6 || d > r + 4) continue;
        u.aim.x = to.x;
        u.aim.z = to.z;
        u.body.yaw = Math.atan2(-(to.x - u.x), -(to.z - u.z));
        if (sim.cast(u, s) === null) return;
      }
    }
    // 3. sustain when hurt
    if (hp < 0.5) {
      for (const s of ready) {
        if (skillRole(c.resolve(s).skill) !== 'sustain') continue;
        if (sim.cast(u, s) === null) return;
      }
    }
    // 4. knock defenders off our carrier, or anyone near the relic, with whatever reaches
    // (a keeper only swings at someone at its gate: no leaping out of it)
    const posted = role === 'goalie' || role === 'guard';
    const near = holder && holder.team === u.team ? holder : rush.target;
    let foe: Unit | null = null;
    let bestD = Infinity;
    for (const e of this.enemies()) {
      if (e.stealth > 0) continue;
      const d = dist(e, near) + dist(e, u) * 0.5;
      if (d < bestD) [foe, bestD] = [e, d];
    }
    if (!foe) return;
    const d = dist(foe, u);
    const offense = ready.filter((s) => {
      const cast = c.resolve(s);
      if (skillRole(cast.skill) !== 'offense') return false;
      // a stun that would knock the relic loose is kept for whoever carries it: spent on anyone else, it is cooling when the carrier comes
      const tackle = cast.hits.some((h) => h.kind === 'cc' && FUMBLE_CC.has(h.cc));
      if (foe !== enemyCarrier && tackle) return false;
      if (posted && (cast.targeting.type === 'dash' || cast.targeting.type === 'leap' || cast.hits.some((h) => h.kind === 'movement')) && d > 5) return false;
      if (cast.skill.detonates && (foe!.marks.get(cast.skill.detonates)?.stacks ?? 0) < (tackle ? MARK_MAX : 1)) return false;
      return reachOf(u, s) + foe!.radius >= d;
    });
    if (!offense.length) return;
    // save the ultimate for a carrier unless it is the only thing ready
    const pick = offense.filter((s) => s !== ULTIMATE_SLOT);
    const slot = (pick.length ? pick : offense)[Math.floor(sim.rng() * (pick.length || offense.length))]!;
    if (slot === ULTIMATE_SLOT && !enemyCarrier && sim.rng() < 0.7) return;
    this.aimAt(foe);
    sim.cast(u, slot);
  }

  private aimAt(t: Unit): void {
    const { u } = this;
    const d = dist(t, u);
    const lead = Math.min(0.5, d / 40);
    u.aim.x = t.x + t.vx * lead;
    u.aim.z = t.z + t.vz * lead;
    u.body.yaw = Math.atan2(-(t.x - u.x), -(t.z - u.z));
  }

  // -------------------------------------------------------------------------
  // Walking

  /**
   * Walks toward `goal` until within `stopAt`, by the pathfinder unless
   * `direct`, turning to face the way it walks if `face`. A `shared` spot (a
   * role's, which a teammate may hold already) also counts as reached when a
   * teammate stands on it.
   */
  private walkTo(goal: Point, stopAt: number, { face = false, shared = false, direct = false } = {}): void {
    const { u } = this;
    const room = this.elbowRoom();
    if (dist(goal, u) <= stopAt || (shared && this.taken(goal, stopAt))) {
      // there already, but standing in someone: step out of them
      if (room.x !== 0 || room.z !== 0) u.move = unit(room.x, room.z);
      return;
    }
    let p = goal;
    if (this.nav && !direct) {
      const r = this.route;
      if (!r || dist(r.goal, goal) > 1.5 || this.sim.time - r.at > 0.4) this.route = { goal: { ...goal }, next: this.nav.next(u, goal), at: this.sim.time };
      p = this.route!.next;
    }
    const dx = p.x - u.x;
    const dz = p.z - u.z;
    const d = hypot(dx, dz);
    if (d < 0.05) return;
    u.move = unit(dx / d + room.x, dz / d + room.z);
    if (face || !this.facingTarget()) u.body.yaw = Math.atan2(-dx, -dz);
  }

  /** A teammate already stands on the spot and this bot is as near it as elbow room lets it get (two cutters, say): stop here. */
  private taken(goal: Point, stopAt: number): boolean {
    const { u } = this;
    const mine = dist(u, goal);
    if (mine > MARK.room + stopAt + 0.3) return false;
    for (const g of this.allies()) if (dist(g, goal) <= stopAt + 0.3 && dist(g, goal) < mine) return true;
    return false;
  }

  /** Away from every god standing closer than MARK.room, harder the closer they are (zero with room to spare). */
  private elbowRoom(): Point {
    const { u } = this;
    const out = this.room;
    out.x = out.z = 0;
    for (const g of this.sim.units) {
      if (g === u || g.kind !== 'god' || !g.alive) continue;
      const ex = u.x - g.x;
      const ez = u.z - g.z;
      const d = hypot(ex, ez);
      if (d >= MARK.room) continue;
      const w = (MARK.room - d) / MARK.room;
      // dead on top of each other: part one each way
      const [nx, nz] = d > 1e-3 ? [ex / d, ez / d] : [u.combatant.uid > g.combatant.uid ? 1 : -1, 0];
      out.x += nx * w * 2;
      out.z += nz * w * 2;
    }
    return out;
  }

  /** While swinging at someone the bot keeps facing them. */
  private facingTarget(): boolean {
    return this.u.sinceAction < 0.35;
  }
}

/** For tests and tuning: whether a god stands in the scoring mouth of the gate it attacks. */
export function inEnemyGate(u: Unit): boolean {
  return inGate(other(u.team as Side), u.x, u.z);
}

/** Whether (x, z) lies within a struck shape, grown by `pad` meters. */
function inShape(s: FlashShape, x: number, z: number, pad: number): boolean {
  const dx = x - s.x;
  const dz = z - s.z;
  if (s.type === 'circle') return hypot(dx, dz) <= s.radius + pad;
  // shapes face along yaw: forward is (-sin, -cos)
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  const along = dx * fx + dz * fz;
  const across = Math.abs(dx * fz - dz * fx);
  if (s.type === 'line') return along >= -pad && along <= s.length + pad && across <= s.width / 2 + pad;
  const d = hypot(dx, dz);
  if (d > s.range + pad) return false;
  return d < pad + 0.5 || Math.acos(Math.max(-1, Math.min(1, along / (d || 1)))) <= (s.angle * Math.PI) / 360 + pad / Math.max(1, d);
}
