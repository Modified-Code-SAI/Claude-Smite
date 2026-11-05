import type { Side } from '../game/combatant';
import type { CCKind } from '../game/types';
import { Arena } from '../scene/ArenaLayout';
import { hypot } from '../core/math';
import type { Sim, SimTerrain } from './Sim';
import type { Point, SimEvent, Unit } from './Unit';

/**
 * Relic Rush: a 3v3 sport on the temple plaza. Carry the Sun Relic through
 * the enemy's gateway to score. The carrier moves slower and can't fight or
 * cast, but can throw the relic as an aimed pass (or a shot through the
 * gate). Any stun, knockback or pull on the carrier knocks the relic loose.
 * Nobody dies: a god who takes too much damage is dazed for a few seconds and
 * comes back at their own gate. First to five goals; a tie when the clock
 * runs out goes to a golden-relic overtime, where the next goal wins.
 */
const GATE_Z = Arena.plaza.baseRadius + 4.5;

export const RUSH = {
  goals: 5,
  /** Seconds of play (the clock stops for kickoffs and goals). */
  clock: 300,
  startLevel: 10,
  startFavor: 700,
  /** Passive XP and Favor a second, so levels and tree points keep coming. */
  xpRate: 16,
  favorRate: 10,
  /** Seconds a god stays dazed (the mode's death) before standing up at their gate. */
  daze: 3,
  /** Everyone deals this much less damage: the mode is about moving people, not felling them. */
  damageCut: 0.6,
  /** Knockbacks throw this far (arena meters; 3.5 elsewhere). */
  knockback: 7,
  /** The carrier's move speed penalty. */
  carrierSlow: 0.15,
  countdown: 3,
  /** Seconds between a goal and the next kickoff. */
  celebrate: 3.5,
  /** The field is a circle around the temple; nothing walks or lands beyond it. */
  pitchRadius: 32,
  /** The gateway each team defends: the relic carried (or thrown low) through it scores. */
  gates: {
    order: { x: 0, z: GATE_Z },
    chaos: { x: 0, z: -GATE_Z },
  },
  /** The gate's mouth between its pillars, and how deep its scoring zone reaches either way. */
  gateHalfWidth: 4.3,
  gateDepth: 1.2,
  /** A throw must pass through the middle of the mouth to score. */
  shotHalfWidth: 3,
  /** A defender near their own gate catches like a keeper: farther and higher. */
  keeper: { halfWidth: 5.5, depth: 4.5, reach: 1.5, height: 3.8 },
  /** Lined up on each side of the relic for a kickoff. */
  kickoff: {
    order: [{ x: -6, z: 9, yaw: 0 }, { x: 0, z: 10.5, yaw: 0 }, { x: 6, z: 9, yaw: 0 }],
    chaos: [{ x: 6, z: -9, yaw: Math.PI }, { x: 0, z: -10.5, yaw: Math.PI }, { x: -6, z: -9, yaw: Math.PI }],
  },
  /** Where dazed gods stand up again: just behind their own gate. */
  homes: {
    order: [{ x: -2.4, z: GATE_Z + 5, yaw: 0 }, { x: 0, z: GATE_Z + 6, yaw: 0 }, { x: 2.4, z: GATE_Z + 5, yaw: 0 }],
    chaos: [{ x: 2.4, z: -GATE_Z - 5, yaw: Math.PI }, { x: 0, z: -GATE_Z - 6, yaw: Math.PI }, { x: -2.4, z: -GATE_Z - 5, yaw: Math.PI }],
  },
  /** The fountain behind each gate: fast healing, and skills can be swapped there. */
  bases: {
    order: { x: 0, z: GATE_Z + 5.5, radius: 3.5 },
    chaos: { x: 0, z: -GATE_Z - 5.5, radius: 3.5 },
  },
  relic: {
    /** Height above the ground the relic is carried at (over the carrier's head). */
    carryHeight: 3,
    /** Height a loose relic hovers at. */
    looseHeight: 0.9,
    /** At kickoff it hovers over the temple's pedestal. */
    centerHeight: 1.3,
    /** A god catches the relic within its radius plus this, while the relic is no higher than catchHeight. */
    catchReach: 0.9,
    centerReach: 1.15,
    catchHeight: 3.1,
    minThrow: 4,
    maxThrow: 21,
    /** Meters a second along the ground. */
    speed: 20,
    /** Seconds the carrier must hold it before throwing (no instant pass-backs). */
    holdMin: 0.25,
    /** A fumbled relic hops this far, and its carrier can't grab it again for a moment. */
    hop: 3.5,
    regrab: 0.9,
    /** A passer can't catch their own throw for this long. */
    selfCatch: 0.45,
    /** Thrown relics only score while this low (under the gate's lintel). */
    shotHeight: 3,
  },
  /** A pass counts as an assist if its catcher scores within this long. */
  assistWindow: 8,
} as const;

/** Crowd control that knocks the relic out of its carrier's hands. */
export const FUMBLE_CC: ReadonlySet<CCKind> = new Set<CCKind>(['stun', 'knockup', 'knockback', 'pull', 'grab', 'fear', 'mesmerize', 'polymorph', 'banish', 'disorient']);

export type RushPhase = 'kickoff' | 'play' | 'goal' | 'over';
export type RelicPhase = 'center' | 'held' | 'flying' | 'loose' | 'gone';

export interface RushRelic {
  phase: RelicPhase;
  holder: Unit | null;
  /** Ground position, and height above the ground. */
  x: number;
  z: number;
  h: number;
  /** In flight: from, to, seconds flown of `duration`, arc height, start height. */
  fx: number;
  fz: number;
  tx: number;
  tz: number;
  t: number;
  duration: number;
  arc: number;
  h0: number;
  /** Who threw it (null for a fumble's hop). */
  thrower: Unit | null;
  /** The team that had it last. */
  team: Side | null;
  /** Sim time the current holder caught it. */
  since: number;
}

/** One god's sport tallies, for the end screen. */
export interface RushLine {
  goals: number;
  assists: number;
  /** Took the relic from the other team: an interception or a fumble recovered. */
  steals: number;
  /** Knocked the relic out of a carrier's hands. */
  tackles: number;
  passes: number;
  /** Times this god was dazed. */
  dazed: number;
}

export interface RushGoal {
  team: Side;
  scorer: Unit;
  assist: Unit | null;
  kind: 'dunk' | 'shot';
  at: number;
}

/** Rush's state on the wire (see Rush.netState): gods travel as their index in the line-up, -1 for none. */
export interface RushNet {
  s: [number, number];
  p: RushPhase;
  t: number;
  c: number;
  o: 0 | 1;
  w: Side | null;
  g: number;
  lg: [Side, number, number, 'dunk' | 'shot', number] | null;
  b: [number, number, number, number];
  lb: ['fumble' | 'steal' | 'catch', number, number] | null;
  r: [RelicPhase, number, number, number, number, number, number, number, number, number, number, number, number, number, Side | null, number];
  l: [number, number, number, number, number, number][];
  ps: [number, number];
}

const other = (t: Side): Side => (t === 'order' ? 'chaos' : 'order');

/** Keeps a point inside the pitch, `margin` from its edge. */
export function clampToPitch(x: number, z: number, margin = 0): Point {
  const d = hypot(x, z);
  const max = RUSH.pitchRadius - margin;
  if (d <= max) return { x, z };
  return { x: (x / d) * max, z: (z / d) * max };
}

/** The map's terrain with the pitch's edge as a wall. */
export function pitchTerrain(base: SimTerrain): SimTerrain {
  return {
    groundAt: (x, z) => base.groundAt(x, z),
    resolve: (x, z, r, y) => {
      const p = base.resolve(x, z, r, y);
      return clampToPitch(p.x, p.z, r);
    },
  };
}

/** Whether (x, z) is in the scoring mouth of the gate `team` defends (or a box of another size around it). */
export function inGate(team: Side, x: number, z: number, halfWidth: number = RUSH.gateHalfWidth, depth: number = RUSH.gateDepth): boolean {
  const g = RUSH.gates[team];
  return Math.abs(x - g.x) <= halfWidth && Math.abs(z - g.z) <= depth;
}

export class Rush {
  readonly score: Record<Side, number> = { order: 0, chaos: 0 };
  phase: RushPhase = 'kickoff';
  /** Seconds left in a kickoff countdown or goal celebration. */
  timer: number = RUSH.countdown;
  /** Seconds of play left on the clock. */
  clock: number = RUSH.clock;
  /** Golden-relic overtime: the next goal wins. */
  overtime = false;
  winner: Side | null = null;
  readonly relic: RushRelic = {
    phase: 'center', holder: null, x: 0, z: 0, h: RUSH.relic.centerHeight,
    fx: 0, fz: 0, tx: 0, tz: 0, t: 0, duration: 0, arc: 0, h0: 0, thrower: null, team: null, since: 0,
  };
  readonly lines = new Map<Unit, RushLine>();
  /** Seconds each team has held the relic. */
  readonly possession: Record<Side, number> = { order: 0, chaos: 0 };
  /** The latest goal, for the herald and the HUD. */
  lastGoal: RushGoal | null = null;
  /** Counts every goal, so watchers can tell a new one from the last. */
  goalCount = 0;
  /** Bumped on each fumble, interception and catch, for sounds and banners. */
  readonly beats = { fumble: 0, steal: 0, catch: 0, kickoff: 0 };
  /** The latest of those beats, with who did it. */
  lastBeat: { kind: 'fumble' | 'steal' | 'catch'; unit: Unit; by: Unit | null } | null = null;
  private readonly squad: Unit[] = [];
  /** Gods who can't touch the relic until a sim time. */
  private readonly noCatch = new Map<Unit, number>();
  private noCatchAll = 0;
  /** The last completed pass, for assists. */
  private lastPass: { from: Unit; to: Unit; at: number } | null = null;

  constructor(private readonly sim: Sim) {
    sim.listeners.push((e) => this.on(e));
    sim.knockback = RUSH.knockback;
    // the carrier only throws (CombatGame and the bots call `throwRelic`)
    sim.intercept = (u) => this.relic.holder === u;
  }

  /** The gods taking part (call once all are in the sim); the first kickoff begins. */
  begin(gods: readonly Unit[]): void {
    this.join(gods);
    for (const g of gods) g.combatant.addPerk('damageBonus', -RUSH.damageCut);
    this.startKickoff();
  }

  /**
   * Only list the gods taking part: a networked guest's copy, which takes
   * everything else from the host. Same order on every end (see netState).
   */
  join(gods: readonly Unit[]): void {
    for (const g of gods) {
      this.squad.push(g);
      this.lines.set(g, { goals: 0, assists: 0, steals: 0, tackles: 0, passes: 0, dazed: 0 });
    }
  }

  get holder(): Unit | null {
    return this.relic.holder;
  }

  /** Nobody moves during a kickoff countdown. */
  get frozen(): boolean {
    return this.phase === 'kickoff' || this.phase === 'over';
  }

  /** Where the relic is going to be: the landing spot of a throw, otherwise where it is. */
  get target(): Point {
    const r = this.relic;
    return r.phase === 'flying' ? { x: r.tx, z: r.tz } : { x: r.x, z: r.z };
  }

  /** The gods on a team, in the order they joined. */
  team(side: Side): Unit[] {
    return this.squad.filter((g) => g.team === side);
  }

  private on(e: SimEvent): void {
    if (e.type !== 'death' || !this.squad.includes(e.unit)) return;
    // a daze, not a death: back on their feet at their gate in a moment
    e.unit.combatant.respawnTimer = RUSH.daze;
    this.lines.get(e.unit)!.dazed++;
    if (this.relic.holder === e.unit) {
      const by = e.killer ? (e.killer.owner ?? e.killer) : null;
      this.fumble(e.unit, by && by.team !== e.unit.team ? by : null);
    }
  }

  step(dt: number): void {
    if (this.phase === 'over') return;
    for (const g of this.squad) if (g.alive) this.sim.grant(g, RUSH.xpRate * dt, RUSH.favorRate * dt);
    if (this.phase === 'kickoff') {
      this.timer -= dt;
      this.hold();
      if (this.timer <= 0) {
        this.phase = 'play';
        this.timer = 0;
      }
      return;
    }
    if (this.phase === 'goal') {
      this.timer -= dt;
      if (this.timer <= 0) this.startKickoff();
      return;
    }
    if (!this.overtime) {
      this.clock = Math.max(0, this.clock - dt);
      if (this.clock <= 0) {
        this.timeUp();
        return;
      }
    }
    this.stepRelic(dt);
  }

  /** The carrier throws toward `at` (clamped to the throw's range and the pitch). */
  throwRelic(u: Unit, at: Point): boolean {
    const r = this.relic;
    const R = RUSH.relic;
    if (this.phase !== 'play' || r.phase !== 'held' || r.holder !== u || !u.alive) return false;
    if (this.sim.time - r.since < R.holdMin) return false;
    const to = this.throwTarget(u, at);
    this.launch(u, to.x, to.z, u, R.carryHeight);
    this.noCatch.set(u, this.sim.time + R.selfCatch);
    return true;
  }

  /** Where a throw toward `at` would land. */
  throwTarget(u: Unit, at: Point): Point {
    const R = RUSH.relic;
    let dx = at.x - u.x;
    let dz = at.z - u.z;
    let d = hypot(dx, dz);
    if (d < 1e-3) {
      dx = u.forward.x;
      dz = u.forward.z;
      d = 1;
    }
    const len = Math.min(R.maxThrow, Math.max(R.minThrow, d));
    return clampToPitch(u.x + (dx / d) * len, u.z + (dz / d) * len, 1.2);
  }

  /** How long a throw of this length flies. */
  static flightTime(dist: number): number {
    return 0.2 + dist / RUSH.relic.speed;
  }

  private launch(from: Point, tx: number, tz: number, thrower: Unit | null, h0: number, arc?: number, duration?: number): void {
    const r = this.relic;
    const d = hypot(tx - from.x, tz - from.z);
    r.phase = 'flying';
    r.holder = null;
    r.fx = r.x = from.x;
    r.fz = r.z = from.z;
    r.tx = tx;
    r.tz = tz;
    r.t = 0;
    r.duration = duration ?? Rush.flightTime(d);
    r.arc = arc ?? 0.8 + d * 0.14;
    r.h0 = r.h = h0;
    r.thrower = thrower;
  }

  /** The relic in flight at fraction p: its height above the ground. */
  static flightHeight(r: Pick<RushRelic, 'h0' | 'arc'>, p: number): number {
    return r.h0 * (1 - p) + RUSH.relic.looseHeight * p + r.arc * 4 * p * (1 - p);
  }

  private stepRelic(dt: number): void {
    const r = this.relic;
    const R = RUSH.relic;
    if (r.phase === 'held') {
      const u = r.holder!;
      r.x = u.x;
      r.z = u.z;
      r.h = R.carryHeight;
      if (r.team) this.possession[r.team] += dt;
      const knocked = this.fumbleCause(u);
      if (knocked !== undefined) {
        this.fumble(u, knocked);
        return;
      }
      if (u.recall > 0) this.sim.interruptRecall(u);
      u.combatant.refreshTimedMod('bonusMoveSpeed', -RUSH.carrierSlow, 0.25);
      if (inGate(other(u.team as Side), u.x, u.z)) this.goal(u.team as Side, u, 'dunk');
      return;
    }
    if (r.phase === 'flying') {
      r.t += dt;
      const p = Math.min(1, r.t / r.duration);
      r.x = r.fx + (r.tx - r.fx) * p;
      r.z = r.fz + (r.tz - r.fz) * p;
      r.h = Rush.flightHeight(r, p);
      // a throw that passes low through the middle of the enemy's gate scores
      if (r.thrower && r.h <= R.shotHeight) {
        const attack = r.thrower.team as Side;
        if (inGate(other(attack), r.x, r.z, RUSH.shotHalfWidth)) {
          this.goal(attack, r.thrower, 'shot');
          return;
        }
      }
      if (this.tryCatch(R.catchReach, r.h)) return;
      if (p >= 1) {
        r.phase = 'loose';
        r.h = R.looseHeight;
      }
      return;
    }
    if (r.phase === 'loose' || r.phase === 'center') this.tryCatch(r.phase === 'center' ? R.centerReach : R.catchReach, 0);
  }

  /** The nearest god close enough takes the relic (`h`: its height above the ground). */
  private tryCatch(reach: number, h: number): boolean {
    const r = this.relic;
    const now = this.sim.time;
    if (now < this.noCatchAll) return false;
    const K = RUSH.keeper;
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const g of this.squad) {
      if (!g.alive) continue;
      const block = this.noCatch.get(g);
      if (block !== undefined && now < block) continue;
      // a keeper in front of their own gate reaches farther and higher
      const keeper = inGate(g.team as Side, g.x, g.z, K.halfWidth, K.depth);
      if (h > (keeper ? K.height : RUSH.relic.catchHeight)) continue;
      const d = hypot(g.x - r.x, g.z - r.z);
      if (d <= g.radius + (keeper ? Math.max(reach, K.reach) : reach) && d < bestD) [best, bestD] = [g, d];
    }
    if (!best) return false;
    this.take(best);
    return true;
  }

  private take(u: Unit): void {
    const r = this.relic;
    const team = u.team as Side;
    const thrower = r.thrower;
    const line = this.lines.get(u);
    if (r.team && r.team !== team) {
      line && line.steals++;
      this.beats.steal++;
      this.lastBeat = { kind: 'steal', unit: u, by: null };
      this.lastPass = null;
    } else if (thrower && thrower !== u && thrower.team === team && r.phase === 'flying') {
      const tl = this.lines.get(thrower);
      if (tl) tl.passes++;
      this.lastPass = { from: thrower, to: u, at: this.sim.time };
      this.beats.catch++;
      this.lastBeat = { kind: 'catch', unit: u, by: thrower };
    }
    r.phase = 'held';
    r.holder = u;
    r.team = team;
    r.thrower = null;
    r.since = this.sim.time;
    r.x = u.x;
    r.z = u.z;
    r.h = RUSH.relic.carryHeight;
    // a god mid-recall drops it at once otherwise; a carrier never needs to recall
    if (u.recall > 0) this.sim.interruptRecall(u);
  }

  /**
   * Why the carrier should lose the relic right now: the unit whose crowd
   * control did it (null when unknown), or undefined while they keep it.
   */
  private fumbleCause(u: Unit): Unit | null | undefined {
    const cc = u.combatant.cc.active.find((c) => FUMBLE_CC.has(c.kind));
    if (!cc && !u.forced) return undefined;
    const uid = cc?.source ? Number(cc.source.split(':')[0]) : NaN;
    const by = Number.isFinite(uid) ? this.sim.unitByCombatantUid(uid) : undefined;
    return by && by.team !== u.team ? (by.owner ?? by) : null;
  }

  /** The relic pops out of the carrier's hands, hopping away from whoever knocked it loose. */
  private fumble(u: Unit, by: Unit | null): void {
    const R = RUSH.relic;
    let dx = by ? u.x - by.x : Math.sin(this.sim.time * 7.3);
    let dz = by ? u.z - by.z : Math.cos(this.sim.time * 7.3);
    const d = hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    const to = clampToPitch(u.x + dx * R.hop, u.z + dz * R.hop, 1.2);
    this.launch(u, to.x, to.z, null, R.carryHeight, 1.1, 0.55);
    this.relic.team = u.team as Side;
    this.noCatch.set(u, this.sim.time + R.regrab);
    this.noCatchAll = this.sim.time + 0.12;
    this.lastPass = null;
    if (by) {
      const l = this.lines.get(by);
      if (l) l.tackles++;
    }
    this.beats.fumble++;
    this.lastBeat = { kind: 'fumble', unit: u, by };
  }

  private goal(team: Side, scorer: Unit, kind: 'dunk' | 'shot'): void {
    const r = this.relic;
    r.phase = 'gone';
    r.holder = null;
    r.thrower = null;
    this.score[team]++;
    const line = this.lines.get(scorer);
    if (line) line.goals++;
    const pass = this.lastPass;
    const assist = pass && pass.to === scorer && pass.from !== scorer && this.sim.time - pass.at <= RUSH.assistWindow ? pass.from : null;
    if (assist) this.lines.get(assist)!.assists++;
    this.lastPass = null;
    this.lastGoal = { team, scorer, assist, kind, at: this.sim.time };
    this.goalCount++;
    if (this.overtime || this.score[team] >= RUSH.goals) {
      this.winner = team;
      this.phase = 'over';
      return;
    }
    this.phase = 'goal';
    this.timer = RUSH.celebrate;
  }

  private timeUp(): void {
    if (this.score.order !== this.score.chaos) {
      this.winner = this.score.order > this.score.chaos ? 'order' : 'chaos';
      this.phase = 'over';
      this.relic.phase = 'gone';
      this.relic.holder = null;
      return;
    }
    // a tie: one more kickoff with the golden relic, and the next goal wins
    this.overtime = true;
    this.startKickoff();
  }

  private startKickoff(): void {
    this.phase = 'kickoff';
    this.timer = RUSH.countdown;
    this.beats.kickoff++;
    const r = this.relic;
    Object.assign(r, { phase: 'center', holder: null, x: 0, z: 0, h: RUSH.relic.centerHeight, thrower: null, team: null, t: 0 });
    this.noCatch.clear();
    this.lastPass = null;
    for (const side of ['order', 'chaos'] as const) {
      this.team(side).forEach((g, i) => {
        const c = g.combatant;
        if (!c.alive) {
          // stood up here rather than at their gate (the sim's own respawn would move them there)
          c.respawnTimer = 0;
          c.respawn();
          g.wasAlive = true;
          this.sim.inject({ type: 'respawn', unit: g });
        }
        g.forced = null;
        c.cc.reset();
        this.place(g, i);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Online play: the host's state, copied to guests (see NetMatch in src/net/Replica.ts)

  /** Everything a guest draws, with gods as their place in the line-up (the same on every end). */
  netState(): RushNet {
    const r = this.relic;
    const at = (u: Unit | null) => (u ? this.squad.indexOf(u) : -1);
    const n = (v: number) => Math.round(v * 100) / 100;
    const g = this.lastGoal;
    const b = this.lastBeat;
    return {
      s: [this.score.order, this.score.chaos],
      p: this.phase,
      t: n(this.timer),
      c: n(this.clock),
      o: this.overtime ? 1 : 0,
      w: this.winner,
      g: this.goalCount,
      lg: g ? [g.team, at(g.scorer), at(g.assist), g.kind, n(g.at)] : null,
      b: [this.beats.fumble, this.beats.steal, this.beats.catch, this.beats.kickoff],
      lb: b ? [b.kind, at(b.unit), at(b.by)] : null,
      r: [r.phase, at(r.holder), n(r.x), n(r.z), n(r.h), n(r.fx), n(r.fz), n(r.tx), n(r.tz), n(r.t), n(r.duration), n(r.arc), n(r.h0), at(r.thrower), r.team, n(r.since)],
      l: this.squad.map((u) => {
        const l = this.lines.get(u)!;
        return [l.goals, l.assists, l.steals, l.tackles, l.passes, l.dazed];
      }),
      ps: [n(this.possession.order), n(this.possession.chaos)],
    };
  }

  applyNet(state: unknown): void {
    const s = state as RushNet;
    const god = (i: number) => this.squad[i] ?? null;
    [this.score.order, this.score.chaos] = s.s;
    this.phase = s.p;
    this.timer = s.t;
    this.clock = s.c;
    this.overtime = s.o === 1;
    this.winner = s.w;
    this.goalCount = s.g;
    const lg = s.lg;
    const scorer = lg && god(lg[1]);
    this.lastGoal = lg && scorer ? { team: lg[0], scorer, assist: god(lg[2]), kind: lg[3], at: lg[4] } : null;
    [this.beats.fumble, this.beats.steal, this.beats.catch, this.beats.kickoff] = s.b;
    const lb = s.lb;
    const unit = lb && god(lb[1]);
    this.lastBeat = lb && unit ? { kind: lb[0], unit, by: god(lb[2]) } : null;
    const r = this.relic;
    const [phase, holder, x, z, h, fx, fz, tx, tz, t, duration, arc, h0, thrower, team, since] = s.r;
    Object.assign(r, { phase, holder: god(holder), x, z, h, fx, fz, tx, tz, t, duration, arc, h0, thrower: god(thrower), team, since });
    s.l.forEach((row, i) => {
      const l = this.squad[i] && this.lines.get(this.squad[i]!);
      if (l) [l.goals, l.assists, l.steals, l.tackles, l.passes, l.dazed] = row;
    });
    [this.possession.order, this.possession.chaos] = s.ps;
  }

  /** On a guest, between the host's snapshots: a thrown relic keeps flying, a carried one stays with its carrier. */
  follow(dt: number): void {
    const r = this.relic;
    if (r.phase === 'held' && r.holder) {
      r.x = r.holder.x;
      r.z = r.holder.z;
    } else if (r.phase === 'flying' && r.duration > 0) {
      r.t = Math.min(r.duration, r.t + dt);
      const p = r.t / r.duration;
      r.x = r.fx + (r.tx - r.fx) * p;
      r.z = r.fz + (r.tz - r.fz) * p;
      r.h = Rush.flightHeight(r, p);
    }
  }

  private place(g: Unit, i: number): void {
    const spots = RUSH.kickoff[g.team as Side];
    const at = spots[i % spots.length]!;
    if (hypot(g.x - at.x, g.z - at.z) > 0.05) this.sim.teleport(g, at.x, at.z, at.yaw);
  }

  /** During the countdown the gods stand at their marks (only moved when they step off). */
  private hold(): void {
    for (const side of ['order', 'chaos'] as const) this.team(side).forEach((g, i) => g.alive && this.place(g, i));
  }
}
