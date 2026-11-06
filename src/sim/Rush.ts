import type { Side } from '../game/combatant';
import { CAPTAIN_SPEED, PLAYMAKER } from '../game/sport';
import type { CCKind, GodDef, SkillDef } from '../game/types';
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
  /**
   * The celebration: the scorer pumps a fist to the sky as it goes in and again
   * this many seconds later, holding their spot for `scorerHold` seconds while
   * their teammates run over to them (bots; see RushBot).
   */
  cheer: { again: 0.9, scorerHold: 1.6, mobUntil: 2.6 },
  /**
   * Seconds the winning moment plays (the goal cam on whoever won it, the
   * winners pumping their fists) before the result comes up over it; the
   * world stills at 4 s.
   */
  result: 3.3,
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
  /** A throw that comes down loose within this far of the gate it went at is a near miss (the crowd gasps). */
  nearMiss: 7,
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
  /** A call for the pass shows (and bots answer it) this long, and can't be repeated sooner than `gap`. */
  call: { time: 2.5, gap: 1.2 },
  /**
   * Pass assist for people: a throw landing within `reach` meters (or
   * `share` of the pass's length, if more) of a teammate's run goes to them,
   * leading it. The run counts from `lag` seconds back.
   */
  assist: { reach: 3, share: 0.22, lag: 0.3 },
  /**
   * The carrier's juke (Space): a quick sidestep of `distance` meters over
   * `time` seconds, the way they're running. For `guard` seconds from the
   * press, crowd control can't land on them, so a well-timed juke beats a
   * tackle. Once every `cooldown` seconds, ready again at each kickoff.
   */
  juke: { distance: 3.4, time: 0.18, guard: 0.3, cooldown: 7 },
} as const;

/** Crowd control that knocks the relic out of its carrier's hands: anything that takes their legs or their will away. */
export const FUMBLE_CC: ReadonlySet<CCKind> = new Set<CCKind>(['stun', 'knockup', 'knockback', 'pull', 'grab', 'fear', 'taunt', 'mesmerize', 'polymorph', 'banish', 'disorient']);

/** Whether a skill's own effects knock the relic loose: a tackle. */
export function tackles(skill: SkillDef): boolean {
  return skill.effects.some((e) => e.kind === 'cc' && FUMBLE_CC.has(e.cc));
}

/**
 * The skills a bot brings to Relic Rush: its god's own bar, unless that bar
 * wins or loses too often in bot matches. Each god needs a tackle among its
 * regular skills (a bar with none won about a third of the time).
 */
const RUSH_BARS: Readonly<Record<string, readonly string[]>> = {
  // no tackle of their own: Odin swaps in Gungnir Sweep, Loki Decoy
  odin: ['odin.gungnir-sweep', 'odin.ravens', 'odin.lunge', 'odin.ring-of-spears'],
  loki: ['loki.decoy', 'loki.vanish', 'loki.backstab', 'loki.assassinate'],
  // two stuns, kept for the carrier, won 62%: one is enough
  anubis: ['anubis.mummify', 'anubis.locust-swarm', 'anubis.sand-step', 'anubis.sandstorm'],
  // 37% on his own bar: Poppy Haze's slow catches carriers (Final Rest put them to sleep so often his team won 60%)
  thanatos: ['thanatos.claim', 'thanatos.wingbeat', 'thanatos.poppy-haze', 'thanatos.kiss-of-death'],
  // 35% on his own bar, the slowest god on the pitch: Green Ooze slows the carrier he chases
  cthulhu: ['cthulhu.green-ooze', 'cthulhu.reaching-feelers', 'cthulhu.wrong-angles', 'cthulhu.stars-are-right'],
  // 57-59% once his bots held Static Discharge for a full Charge; Aegis of Clouds in place of Storm Step: 46-50%
  zeus: ['zeus.arc-bolt', 'zeus.static-discharge', 'zeus.aegis-of-clouds', 'zeus.skyfall-storm'],
};

export function rushBar(god: GodDef): readonly string[] {
  return RUSH_BARS[god.id] ?? god.defaultLoadout;
}

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
  b: [number, number, number, number, number, number, number, number, number];
  lb: [RushBeat, number, number] | null;
  r: [RelicPhase, number, number, number, number, number, number, number, number, number, number, number, number, number, Side | null, number];
  l: [number, number, number, number, number, number][];
  ps: [number, number];
  /** Seconds since each god called for the pass, -1 for none lately. */
  cl: number[];
  /** Seconds until each god's juke is ready, and the latest juker. */
  j: number[];
  lj: number;
}

/**
 * A moment the HUD, sounds and effects mark: `shrug` is a Captain keeping the
 * relic through a hit, `dodge` a juke that slipped a tackle, `miss` a throw
 * that came down loose by the gate it went at.
 */
export type RushBeat = 'fumble' | 'steal' | 'catch' | 'shrug' | 'save' | 'dodge' | 'miss';

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
  /** What the last goal did to the score: opened it, drew level, took or stretched the lead, or pulled one back. */
  get goalStory(): 'opener' | 'level' | 'lead' | 'extend' | 'back' | null {
    const g = this.lastGoal;
    if (!g) return null;
    const us = this.score[g.team];
    const them = this.score[g.team === 'order' ? 'chaos' : 'order'];
    if (us === 1 && them === 0) return 'opener';
    if (us === them) return 'level';
    if (us === them + 1) return 'lead';
    return us > them ? 'extend' : 'back';
  }

  /** Whether the last goal was its scorer's third of the match. */
  get hatTrick(): boolean {
    const g = this.lastGoal;
    return !!g && this.lines.get(g.scorer)?.goals === 3;
  }

  /**
   * Whether the match was won by its last goal (the fifth, or any golden-relic
   * goal) rather than on the clock. Read from the score, so guests know too.
   */
  get wonOnGoal(): boolean {
    const g = this.lastGoal;
    return !!this.winner && !!g && g.team === this.winner && (this.overtime || this.score[this.winner] >= RUSH.goals);
  }
  /** Counts every goal, so watchers can tell a new one from the last. */
  goalCount = 0;
  /** Bumped on each fumble, interception, catch, Captain's shrug, save (a shot caught on its way in), juke, dodge and near miss, for sounds and banners. */
  readonly beats = { fumble: 0, steal: 0, catch: 0, kickoff: 0, shrug: 0, save: 0, juke: 0, dodge: 0, miss: 0 };
  /** Who juked last (see `beats.juke`), for the streak and the whoosh. */
  lastJuke: Unit | null = null;
  /** The latest of those beats, with who did it. */
  lastBeat: { kind: RushBeat; unit: Unit; by: Unit | null } | null = null;
  private readonly squad: Unit[] = [];
  /** Gods who can't touch the relic until a sim time. */
  private readonly noCatch = new Map<Unit, number>();
  private noCatchAll = 0;
  /** The last completed pass, for assists. */
  private lastPass: { from: Unit; to: Unit; at: number } | null = null;
  /** Sim time each god last called for the pass. */
  private readonly calls = new Map<Unit, number>();
  /** The Captain keystone: spent for this possession, and the sim time its shrugged-off hit wears off. */
  private shrugUsed = false;
  private shrugUntil = 0;
  /** Sim time each god's juke is ready again. */
  private readonly jukeReady = new Map<Unit, number>();
  /**
   * Jukes under way: the sidestep's own forced movement (not a hit, so no
   * fumble), when its guard ends, and the carrier's count of turned-away
   * crowd control at the press (one that knocks the relic loose since then
   * is a tackle slipped).
   */
  private readonly juking = new Map<Unit, { forced: NonNullable<Unit['forced']>; until: number; blocked: number; dodged: boolean }>();

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
      // the sport tree opens next to the god's own three
      g.combatant.addTree(PLAYMAKER);
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
    e.unit.combatant.respawnTimer = Math.max(1, RUSH.daze - e.unit.combatant.sport('dazeCut'));
    this.lines.get(e.unit)!.dazed++;
    if (this.relic.holder === e.unit) {
      const by = e.killer ? (e.killer.owner ?? e.killer) : null;
      this.fumble(e.unit, by && by.team !== e.unit.team ? by : null);
    }
  }

  step(dt: number): void {
    if (this.phase === 'over') return;
    for (const g of this.squad) if (g.alive) this.sim.grant(g, RUSH.xpRate * dt, RUSH.favorRate * dt);
    this.stepJukes();
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
      const was = RUSH.celebrate - this.timer;
      this.timer -= dt;
      // the scorer's second fist pump, drawn as an action like the first (see goal())
      if (this.lastGoal && was < RUSH.cheer.again && RUSH.celebrate - this.timer >= RUSH.cheer.again) this.lastGoal.scorer.sinceAction = 0;
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
    const d = hypot(to.x - u.x, to.z - u.z);
    // the thrower turns into the throw, and the views play it as a swing
    if (d > 0.1) u.body.yaw = Math.atan2(-(to.x - u.x), -(to.z - u.z));
    u.sinceAction = 0;
    this.launch(u, to.x, to.z, u, R.carryHeight, undefined, Rush.flightTime(d, u.combatant.sport('throwSpeed')));
    this.noCatch.set(u, this.sim.time + R.selfCatch);
    return true;
  }

  /**
   * A god calls for the pass (F, or a bot that is open): their teammates see
   * it over their head, and a bot carrier passes to them if it can.
   */
  call(u: Unit): boolean {
    if (this.phase !== 'play' || !u.alive || this.relic.holder === u || !this.squad.includes(u)) return false;
    const last = this.calls.get(u);
    if (last !== undefined && this.sim.time - last < RUSH.call.gap) return false;
    this.calls.set(u, this.sim.time);
    return true;
  }

  /**
   * The carrier jukes: a quick sidestep toward `dir` (or the way they're
   * running, else where they face), with a moment where crowd control can't
   * land (see RUSH.juke).
   */
  juke(u: Unit, dir: Point | null = null): boolean {
    const J = RUSH.juke;
    if (this.phase !== 'play' || this.relic.holder !== u || !this.sim.canMove(u)) return false;
    if (this.jukeLeft(u) > 0) return false;
    let dx = dir?.x ?? 0;
    let dz = dir?.z ?? 0;
    if (hypot(dx, dz) < 1e-3) [dx, dz] = hypot(u.vx, u.vz) > 1 ? [u.vx, u.vz] : [u.forward.x, u.forward.z];
    const d = hypot(dx, dz) || 1;
    const speed = J.distance / J.time;
    const forced = { vx: (dx / d) * speed, vz: (dz / d) * speed, remaining: J.time, total: J.time, arc: 0, collide: true };
    u.forced = forced;
    u.combatant.ccImmune = true;
    this.juking.set(u, { forced, until: this.sim.time + J.guard, blocked: u.combatant.ccBlocked, dodged: false });
    this.jukeReady.set(u, this.sim.time + J.cooldown);
    this.beats.juke++;
    this.lastJuke = u;
    return true;
  }

  /** Seconds until this god can juke again (0: ready). */
  jukeLeft(u: Unit): number {
    return Math.max(0, (this.jukeReady.get(u) ?? 0) - this.sim.time);
  }

  /** Whether this god is in a juke's guard (crowd control can't land). */
  isJuking(u: Unit): boolean {
    return this.juking.has(u);
  }

  /** A juke that turns away a tackle is called (the `dodge` beat); its guard ends on time, or as soon as the juker no longer has the relic. */
  private stepJukes(): void {
    for (const [u, j] of this.juking) {
      const c = u.combatant;
      if (!j.dodged && c.ccBlocked > j.blocked && c.blockedKind && FUMBLE_CC.has(c.blockedKind) && u.alive && this.relic.holder === u) {
        j.dodged = true;
        this.beats.dodge++;
        this.lastBeat = { kind: 'dodge', unit: u, by: this.sourceOf(c.blockedSource) };
      }
      if (this.sim.time < j.until && u.alive && this.relic.holder === u) continue;
      u.combatant.ccImmune = false;
      this.juking.delete(u);
    }
  }

  /** Seconds since this god's call for the pass, or null when they haven't called lately. */
  calledAgo(u: Unit): number | null {
    const at = this.calls.get(u);
    if (at === undefined) return null;
    const ago = this.sim.time - at;
    return ago >= 0 && ago < RUSH.call.time ? ago : null;
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
    const len = Math.min(Rush.maxThrow(u), Math.max(R.minThrow, d));
    return clampToPitch(u.x + (dx / d) * len, u.z + (dz / d) * len, 1.2);
  }

  /**
   * Whether a throw toward `at` would pass low through the enemy's gate, so
   * score as a shot unless somebody cuts it off. Follows the same arc as
   * `throwRelic` (the carrier's throw preview lights up for it).
   */
  shotOnTarget(u: Unit, at: Point): boolean {
    const R = RUSH.relic;
    const to = this.throwTarget(u, at);
    const d = hypot(to.x - u.x, to.z - u.z);
    const arc = { h0: R.carryHeight, arc: 0.8 + d * 0.14 };
    const foe = other(u.team as Side);
    const steps = Math.max(8, Math.ceil(d / 0.25));
    for (let i = 1; i <= steps; i++) {
      const p = i / steps;
      if (Rush.flightHeight(arc, p) > R.shotHeight) continue;
      if (inGate(foe, u.x + (to.x - u.x) * p, u.z + (to.z - u.z) * p, RUSH.shotHalfWidth)) return true;
    }
    return false;
  }

  /**
   * What a throw toward `at` would do if everybody kept running as they are
   * now: score (`goal`), be caught (`catcher`: a teammate taking the pass, or
   * an enemy cutting it off), or neither and land loose. Steps the same
   * flight as `throwRelic` at the sim's 60 Hz with the relic's own catch rules
   * (keepers included); the thrower is left out. The carrier's throw preview
   * marks the catcher.
   */
  passRead(u: Unit, at: Point): { goal: boolean; catcher: Unit | null } {
    const R = RUSH.relic;
    const K = RUSH.keeper;
    const to = this.throwTarget(u, at);
    const d = hypot(to.x - u.x, to.z - u.z);
    const arc = { h0: R.carryHeight, arc: 0.8 + d * 0.14 };
    const time = Rush.flightTime(d, u.combatant.sport('throwSpeed'));
    const foe = other(u.team as Side);
    const dt = 1 / 60;
    for (let i = 1; ; i++) {
      const t = i * dt;
      const p = Math.min(1, t / time);
      const x = u.x + (to.x - u.x) * p;
      const z = u.z + (to.z - u.z) * p;
      const h = Rush.flightHeight(arc, p);
      if (h <= R.shotHeight && inGate(foe, x, z, RUSH.shotHalfWidth)) return { goal: true, catcher: null };
      let best: Unit | null = null;
      let bestD = Infinity;
      for (const g of this.squad) {
        if (g === u || !g.alive) continue;
        // the relic moves before the gods do each step
        const gx = g.x + g.vx * (t - dt);
        const gz = g.z + g.vz * (t - dt);
        const keeper = inGate(g.team as Side, gx, gz, K.halfWidth, K.depth);
        if (h > (keeper ? K.height : R.catchHeight)) continue;
        const dd = hypot(gx - x, gz - z);
        if (dd <= g.radius + g.combatant.sport('catchReach') + (keeper ? Math.max(R.catchReach, K.reach) : R.catchReach) && dd < bestD) [best, bestD] = [g, dd];
      }
      if (best) return { goal: false, catcher: best };
      if (p >= 1) return { goal: false, catcher: null };
    }
  }

  /**
   * Pass assist for a person's throw (bots lead their own): aimed close to
   * a teammate, or anywhere along the run they'll make while it flies, the
   * throw goes to where they'll be when it comes down. Shots on goal and
   * throws into open space stay where they were aimed. Returns the point to
   * throw at.
   */
  assistAim(u: Unit, at: Point): Point {
    if (this.shotOnTarget(u, at)) return at;
    const to = this.throwTarget(u, at);
    const speed = u.combatant.sport('throwSpeed');
    const A = RUSH.assist;
    let best: Point | null = null;
    let bestOff = Infinity;
    for (const t of this.squad) {
      if (t === u || !t.alive || t.team !== u.team || t.forced) continue;
      // where they'll be when it lands (twice: the flight's length depends on where that is)
      let lead: Point = t;
      for (let k = 0; k < 2; k++) {
        const time = Rush.flightTime(hypot(lead.x - u.x, lead.z - u.z), speed);
        lead = clampToPitch(t.x + t.vx * time, t.z + t.vz * time, 1.5);
      }
      const d = hypot(lead.x - u.x, lead.z - u.z);
      if (d < RUSH.relic.minThrow || d > Rush.maxThrow(u)) continue;
      // aimed anywhere along their run: a step behind them (a crosshair chasing a sprinter lags), at them, ahead, or right on the lead
      const bx = t.x - t.vx * A.lag;
      const bz = t.z - t.vz * A.lag;
      const rx = lead.x - bx;
      const rz = lead.z - bz;
      const len2 = rx * rx + rz * rz;
      const k = len2 > 1e-6 ? Math.max(0, Math.min(1, ((to.x - bx) * rx + (to.z - bz) * rz) / len2)) : 0;
      const off = hypot(bx + rx * k - to.x, bz + rz * k - to.z);
      if (off > Math.max(A.reach, d * A.share) || off >= bestOff) continue;
      best = lead;
      bestOff = off;
    }
    return best ?? at;
  }

  /** How long a throw of this length flies (`faster`: the thrower's Bullet Pass). */
  static flightTime(dist: number, faster = 0): number {
    return 0.2 + dist / (RUSH.relic.speed * (1 + faster));
  }

  /** The longest pass this god throws (Long Arm adds to it). */
  static maxThrow(u: Unit): number {
    return RUSH.relic.maxThrow + u.combatant.sport('throwRange');
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
      const knocked = this.sim.time < this.shrugUntil ? undefined : this.fumbleCause(u);
      if (knocked !== undefined) {
        if (this.shrugUsed || u.combatant.sport('captain') <= 0) {
          this.fumble(u, knocked);
          return;
        }
        // a Captain keeps it through the first hit, for as long as that hit lasts
        this.shrugUsed = true;
        this.shrugUntil = this.sim.time + this.knockTime(u);
        this.beats.shrug++;
        this.lastBeat = { kind: 'shrug', unit: u, by: knocked };
      }
      if (u.recall > 0) this.sim.interruptRecall(u);
      const slow = RUSH.carrierSlow * Math.max(0, 1 - u.combatant.sport('carrierSpeed'));
      if (slow > 0) u.combatant.refreshTimedMod('bonusMoveSpeed', -slow, 0.25);
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
        // a throw that comes down loose by the gate it went at: wide, short, or over the top
        const t = r.thrower;
        const gate = t ? RUSH.gates[other(t.team as Side)] : null;
        if (t && gate && hypot(r.x - gate.x, r.z - gate.z) <= RUSH.nearMiss) {
          this.beats.miss++;
          this.lastBeat = { kind: 'miss', unit: t, by: null };
        }
      }
      return;
    }
    if (r.phase === 'loose' || r.phase === 'center') this.tryCatch(r.phase === 'center' ? R.centerReach : R.catchReach, 0);
  }

  /** The nearest god close enough takes the relic (`h`: its height above the ground). */
  private tryCatch(reach: number, h: number): boolean {
    const now = this.sim.time;
    if (now < this.noCatchAll) return false;
    const best = this.catcherAt(this.relic.x, this.relic.z, h, reach, now);
    if (!best) return false;
    this.take(best);
    return true;
  }

  /** The nearest god who could take the relic at (x, z), `h` above the ground, at sim time `at`. */
  private catcherAt(x: number, z: number, h: number, reach: number, at: number): Unit | null {
    const K = RUSH.keeper;
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const g of this.squad) {
      if (!g.alive) continue;
      const block = this.noCatch.get(g);
      if (block !== undefined && at < block) continue;
      // a keeper in front of their own gate reaches farther and higher
      const keeper = inGate(g.team as Side, g.x, g.z, K.halfWidth, K.depth);
      if (h > (keeper ? K.height : RUSH.relic.catchHeight)) continue;
      const d = hypot(g.x - x, g.z - z);
      const hands = g.combatant.sport('catchReach');
      if (d <= g.radius + hands + (keeper ? Math.max(reach, K.reach) : reach) && d < bestD) [best, bestD] = [g, d];
    }
    return best;
  }

  /**
   * Who is about to catch the relic in flight, by the catching rules from
   * where everyone stands now, within `ahead` seconds: how soon, and where
   * (height above the ground) it meets their hands. Null when it isn't flying
   * or nobody will. Every end can ask (a guest has the flight too); the views
   * reach the catcher's hand out to meet it.
   */
  incoming(ahead: number, out: { unit: Unit | null; eta: number; x: number; z: number; h: number }): boolean {
    const r = this.relic;
    out.unit = null;
    if (r.phase !== 'flying' || r.duration <= 0 || this.phase !== 'play') return false;
    const R = RUSH.relic;
    const now = this.sim.time;
    const steps = 10;
    for (let i = 0; i <= steps; i++) {
      const dt = (ahead * i) / steps;
      if (now + dt < this.noCatchAll) continue;
      const p = Math.min(1, (r.t + dt) / r.duration);
      const x = r.fx + (r.tx - r.fx) * p;
      const z = r.fz + (r.tz - r.fz) * p;
      const h = Rush.flightHeight(r, p);
      const g = this.catcherAt(x, z, h, R.catchReach, now + dt);
      // (a guest doesn't know who can't catch it yet: the thrower just let it go)
      if (g && !(g === r.thrower && r.t + dt < R.selfCatch)) {
        out.unit = g;
        out.eta = dt;
        out.x = x;
        out.z = z;
        out.h = h;
        return true;
      }
      if (p >= 1) break;
    }
    return false;
  }

  /** The team one goal from the win ('both' at four apiece), or null. Never in golden-relic overtime, where any goal wins. */
  get matchPoint(): Side | 'both' | null {
    if (this.winner || this.overtime) return null;
    const order = this.score.order >= RUSH.goals - 1;
    const chaos = this.score.chaos >= RUSH.goals - 1;
    return order && chaos ? 'both' : order ? 'order' : chaos ? 'chaos' : null;
  }

  /** Whether the relic in flight would still go in low through `side`'s gate (score against it) if nobody caught it. */
  private goingIn(side: Side): boolean {
    const r = this.relic;
    const p0 = r.duration > 0 ? Math.min(1, r.t / r.duration) : 1;
    const left = hypot(r.tx - r.fx, r.tz - r.fz) * (1 - p0);
    const steps = Math.max(4, Math.ceil(left / 0.25));
    for (let i = 0; i <= steps; i++) {
      const p = p0 + ((1 - p0) * i) / steps;
      if (Rush.flightHeight(r, p) > RUSH.relic.shotHeight) continue;
      if (inGate(side, r.fx + (r.tx - r.fx) * p, r.fz + (r.tz - r.fz) * p, RUSH.shotHalfWidth)) return true;
    }
    return false;
  }

  private take(u: Unit): void {
    const r = this.relic;
    const team = u.team as Side;
    const thrower = r.thrower;
    const line = this.lines.get(u);
    if (r.team && r.team !== team) {
      line && line.steals++;
      // a shot that was going in, caught: a save (counted with the steals)
      const save = r.phase === 'flying' && !!thrower && this.goingIn(team);
      this.beats[save ? 'save' : 'steal']++;
      this.lastBeat = { kind: save ? 'save' : 'steal', unit: u, by: save ? thrower : null };
      this.lastPass = null;
    } else if (thrower && thrower !== u && thrower.team === team && r.phase === 'flying') {
      const tl = this.lines.get(thrower);
      if (tl) tl.passes++;
      this.lastPass = { from: thrower, to: u, at: this.sim.time };
      this.beats.catch++;
      this.lastBeat = { kind: 'catch', unit: u, by: thrower };
      if (thrower.combatant.sport('captain') > 0) u.combatant.addTimedMod('bonusMoveSpeed', CAPTAIN_SPEED.pct, CAPTAIN_SPEED.duration);
    }
    this.shrugUsed = false;
    this.shrugUntil = 0;
    // the call is answered
    this.calls.delete(u);
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
    // the carrier's own juke is movement, not a hit
    if (!cc && (!u.forced || this.juking.get(u)?.forced === u.forced)) return undefined;
    const by = this.sourceOf(cc?.source);
    return by && by.team !== u.team ? by : null;
  }

  /** The god behind a crowd-control source ("uid:skill"), or null. */
  private sourceOf(source: string | undefined): Unit | null {
    const uid = source ? Number(source.split(':')[0]) : NaN;
    const by = Number.isFinite(uid) ? this.sim.unitByCombatantUid(uid) : undefined;
    return by ? (by.owner ?? by) : null;
  }

  /** How long the hit on a carrier lasts: its crowd control, or the shove it's riding. */
  private knockTime(u: Unit): number {
    let t = u.forced?.remaining ?? 0;
    for (const c of u.combatant.cc.active) if (FUMBLE_CC.has(c.kind)) t = Math.max(t, c.remaining);
    return t + 0.1;
  }

  /**
   * The relic pops out of the carrier's hands, hopping away from whoever
   * knocked it loose (or toward them, with Strip Tackle).
   */
  private fumble(u: Unit, by: Unit | null): void {
    const R = RUSH.relic;
    const strip = !!by && by.combatant.sport('strip') > 0;
    let dx = by ? (strip ? by.x - u.x : u.x - by.x) : Math.sin(this.sim.time * 7.3);
    let dz = by ? (strip ? by.z - u.z : u.z - by.z) : Math.cos(this.sim.time * 7.3);
    const d = hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    // a strip lands at the tackler's feet, never past them
    const hop = strip ? Math.max(1, Math.min(R.hop, d - by!.radius - 0.4)) : R.hop;
    const to = clampToPitch(u.x + dx * hop, u.z + dz * hop, 1.2);
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
    // the scorer's cheer is drawn as an action (see RushMode), so it reaches guests with the god's state
    scorer.sinceAction = 0;
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
    this.calls.clear();
    this.lastPass = null;
    this.jukeReady.clear();
    for (const u of this.juking.keys()) u.combatant.ccImmune = false;
    this.juking.clear();
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
        // every point starts fresh: the beaten-up line up at full strength too (under the dip, so the bars refill unseen)
        c.health = c.stats.maxHealth;
        c.mana = c.stats.maxMana;
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
      b: [this.beats.fumble, this.beats.steal, this.beats.catch, this.beats.kickoff, this.beats.shrug, this.beats.save, this.beats.juke, this.beats.dodge, this.beats.miss],
      lb: b ? [b.kind, at(b.unit), at(b.by)] : null,
      r: [r.phase, at(r.holder), n(r.x), n(r.z), n(r.h), n(r.fx), n(r.fz), n(r.tx), n(r.tz), n(r.t), n(r.duration), n(r.arc), n(r.h0), at(r.thrower), r.team, n(r.since)],
      l: this.squad.map((u) => {
        const l = this.lines.get(u)!;
        return [l.goals, l.assists, l.steals, l.tackles, l.passes, l.dazed];
      }),
      ps: [n(this.possession.order), n(this.possession.chaos)],
      cl: this.squad.map((u) => {
        const ago = this.calledAgo(u);
        return ago === null ? -1 : n(ago);
      }),
      j: this.squad.map((u) => n(this.jukeLeft(u))),
      lj: at(this.lastJuke),
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
    [this.beats.fumble, this.beats.steal, this.beats.catch, this.beats.kickoff, this.beats.shrug, this.beats.save, this.beats.juke, this.beats.dodge, this.beats.miss] = s.b;
    this.lastJuke = god(s.lj);
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
    this.calls.clear();
    s.cl.forEach((ago, i) => {
      const g = this.squad[i];
      if (g && ago >= 0) this.calls.set(g, this.sim.time - ago);
    });
    s.j.forEach((left, i) => {
      const g = this.squad[i];
      if (g) this.jukeReady.set(g, this.sim.time + left);
    });
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

  /** Onto their kickoff mark, quietly: the screen dips to dark over the reset (see RushHud), so it needs no flash. */
  private place(g: Unit, i: number): void {
    const spots = RUSH.kickoff[g.team as Side];
    const at = spots[i % spots.length]!;
    if (hypot(g.x - at.x, g.z - at.z) > 0.05) this.sim.teleport(g, at.x, at.z, at.yaw, true);
  }

  /** During the countdown the gods stand at their marks (only moved when they step off). */
  private hold(): void {
    for (const side of ['order', 'chaos'] as const) this.team(side).forEach((g, i) => g.alive && this.place(g, i));
  }
}
