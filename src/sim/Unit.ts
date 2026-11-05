import type { BasicShot, Combatant, ResolvedSkill, Side, Team } from '../game/combatant';
import type { PingKind } from './Pings';

/**
 * Rules-engine distances are authored at roughly Smite's proportions; the
 * arena is built at a larger physical scale (the placeholder god is 2.45 m
 * tall and runs 6.6 m/s). Every engine distance and speed is multiplied by
 * this when it enters the world.
 */
export const WORLD_SCALE = 1.75;

/** Engine move speed (100 units = 1 engine m/s) to arena meters per second. */
export function worldSpeed(moveSpeed: number): number {
  return (moveSpeed / 100) * WORLD_SCALE;
}

/**
 * `weakpoint` is a breakable part of a bigger unit (the Jötunn's knees and
 * wrists): its mode moves it with the body it belongs to. `brazier` is a
 * mode's fixture that only basic attacks can break.
 */
export type UnitKind = 'god' | 'dummy' | 'summon' | 'minion' | 'tower' | 'phoenix' | 'titan' | 'monster' | 'weakpoint' | 'brazier';

/** Towers, Phoenixes, Titans and braziers: never move, take only basic attacks, and never respawn on their own. */
export function isStructure(u: { kind: UnitKind }): boolean {
  return u.kind === 'tower' || u.kind === 'phoenix' || u.kind === 'titan' || u.kind === 'brazier';
}

/**
 * Where a unit is. Bots own a plain object; the player's body is an adapter
 * over the PlayerController so the controller keeps owning normal movement.
 * Yaw 0 faces -Z; forward is (-sin yaw, -cos yaw).
 */
export interface Body {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Instant moves (recall, respawn) that should not be interpolated. */
  teleport?(x: number, z: number, yaw?: number): void;
}

export interface Point {
  x: number;
  z: number;
}

/** Movement the simulation drives: dashes, leaps, knockbacks, pulls. */
export interface Forced {
  vx: number;
  vz: number;
  remaining: number;
  total: number;
  /** Peak height of a leap arc, 0 for ground movement. */
  arc: number;
  /** Leaps fly over walls; dashes and knockbacks are stopped by them. */
  collide: boolean;
  /** A dash that hits units it passes through. */
  sweep?: { cast: ResolvedSkill; width: number; hit: Set<Unit> };
  land?: () => void;
}

/** How a unit was made, so a networked copy of the match can make the same one (see src/net). */
export type SpawnOrigin =
  | { f: 'god'; god: string }
  | { f: 'dummy' }
  | { f: 'summon'; kind: string; index: number }
  | { f: 'minion'; type: string; wave: number; empowered: boolean }
  | { f: 'monster'; type: string; minutes: number }
  | { f: 'structure' }
  /** A unit a game mode makes itself; a guest builds it with the mode's NetMatch.netSpawn. */
  | { f: 'mode'; kind: string; data?: unknown };

/** Decides what a sim-driven unit does each step. */
export interface Brain {
  update(dt: number): void;
}

let nextId = 1;

export class Unit {
  readonly id = nextId++;
  /** Facing direction the simulation wants for sim-driven units, as a unit vector or null. */
  move: Point | null = null;
  /** Ground point the unit is aiming at (crosshair for the player, target for bots). */
  readonly aim: Point = { x: 0, z: 0 };
  forced: Forced | null = null;
  stealth = 0;
  untargetable = 0;
  /** Seconds left on a recall channel; 0 when not recalling. */
  recall = 0;
  /** Seconds left before a summon expires. */
  lifetime = Infinity;
  owner: Unit | null = null;
  brain: Brain | null = null;
  readonly marks = new Map<string, { stacks: number; remaining: number }>();
  /** Last step's horizontal velocity, for animation. */
  vx = 0;
  vz = 0;
  /** Seconds since the last cast or attack, for the cast pose. */
  sinceAction = 99;
  wasAlive = true;
  /** Gods respawn at home; minions are removed a moment after death and structures stay as rubble. */
  respawns = true;
  /** A god lying downed until a teammate revives them (Underworld Descent). */
  downed = false;
  /** A structure that cannot be damaged yet (the one in front of it still stands). */
  shielded: () => boolean = () => false;
  /** The last time this unit damaged an enemy god, for tower aggro. */
  lastGodHit: { victim: Unit; at: number } | null = null;
  /** Enemy gods that damaged this unit and when, for assists. */
  readonly damagedBy = new Map<Unit, number>();
  /** Seconds until a wound-up attack lands (the Titan's slam), 0 when idle. */
  windup = 0;
  /** Seconds since death, for units that do not respawn. */
  deadFor = 0;
  /** XP and favor a jungle monster gives the god who kills it. */
  bounty: { xp: number; favor: number } | null = null;
  /** Free-form tag the match uses (lane, minion type). */
  tag = '';
  /** Others can't walk through it, as with structures (the Jötunn's legs). */
  blocks = false;
  /** Meters of rubble and low wall it strides over without being stopped (the Jötunn). */
  stepOver = 0;
  /** Set by the factory functions. */
  origin: SpawnOrigin | null = null;

  constructor(
    readonly kind: UnitKind,
    readonly name: string,
    readonly combatant: Combatant,
    /** Swapped only when control of the unit changes hands (a mode moving the player to another unit). */
    public body: Body,
    readonly radius: number,
    readonly home: { x: number; z: number; yaw: number },
  ) {}

  get team(): Team {
    return this.combatant.team;
  }

  /** The side of a god, minion or structure; never call it on a jungle monster. */
  get side(): Side {
    return this.combatant.team as Side;
  }

  get alive(): boolean {
    return this.combatant.alive;
  }

  get x(): number {
    return this.body.x;
  }

  get z(): number {
    return this.body.z;
  }

  /** Visible and hittable by enemies. */
  get targetable(): boolean {
    return this.alive && this.untargetable <= 0;
  }

  get forward(): Point {
    return { x: -Math.sin(this.body.yaw), z: -Math.cos(this.body.yaw) };
  }
}

/** A projectile in flight: a skill shot or a ranged basic attack. */
export interface Projectile {
  readonly id: number;
  owner: Unit;
  cast: ResolvedSkill | null;
  shot: BasicShot | null;
  x: number;
  z: number;
  dx: number;
  dz: number;
  speed: number;
  traveled: number;
  range: number;
  radius: number;
  pierce: boolean;
  bounces: number;
  /** Structure shots home in on their target. */
  homing: Unit | null;
  readonly hit: Set<Unit>;
  alive: boolean;
}

/** A lingering area that applies a skill on every tick. */
export interface Zone {
  readonly id: number;
  owner: Unit;
  cast: ResolvedSkill;
  x: number;
  z: number;
  radius: number;
  ticks: number;
  interval: number;
  timer: number;
  /** 'caster' stays on the caster, 'aim' drifts toward the caster's aim point. */
  follow: 'caster' | 'aim' | null;
  /** Max distance from the caster when following the aim. */
  range: number;
  age: number;
  duration: number;
}

/** A one-shot shape drawn for a moment when an instant skill resolves. */
export type FlashShape =
  | { type: 'circle'; x: number; z: number; radius: number }
  | { type: 'line'; x: number; z: number; yaw: number; length: number; width: number }
  | { type: 'cone'; x: number; z: number; yaw: number; range: number; angle: number };

export interface Flash {
  readonly id: number;
  shape: FlashShape;
  owner: Unit;
  age: number;
  life: number;
  /** A warning: the shape is struck when the flash ends (an attack winding up). */
  warn?: boolean;
  /** What a warning winds up: the skill id, or 'basic'. */
  act?: string;
}

export type SimEvent =
  | { type: 'damage'; target: Unit; source: Unit | null; amount: number; crit: boolean; ability: boolean }
  | { type: 'heal'; target: Unit; amount: number }
  | { type: 'cast'; unit: Unit; cast: ResolvedSkill; x: number; z: number }
  | { type: 'basic'; unit: Unit; melee: boolean }
  | { type: 'impact'; x: number; z: number; owner: Unit; big: boolean }
  | { type: 'death'; unit: Unit; killer: Unit | null; assists: Unit[] }
  | { type: 'respawn'; unit: Unit }
  | { type: 'levelUp'; unit: Unit; level: number }
  | { type: 'reward'; unit: Unit; xp: number; favor: number }
  /** `quiet`: a move the mode hides itself (Relic Rush's kickoff reset), so no flash or sound. */
  | { type: 'teleport'; unit: Unit; fromX: number; fromZ: number; quiet?: boolean }
  | { type: 'recall'; unit: Unit; state: 'start' | 'cancel' | 'done' }
  /**
   * A quick call to the pinger's team, marked at (x, z) or on `subject`.
   * `ult` is what an ultimate ping reports (see Pings.ts). Never sent to the other team.
   */
  | { type: 'ping'; unit: Unit; kind: PingKind; x: number; z: number; subject: Unit | null; ult?: number }
  /** A god's taunt: `line` picks which of its lines (wrapped to how many it has), so everyone hears the same one. */
  | { type: 'taunt'; unit: Unit; line: number };

export function nextEntityId(): number {
  return nextId++;
}
