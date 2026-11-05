import { Combatant, type Side } from '../game/combatant';
import { jotunn } from '../game/gods/jotunn';
import { XP_TABLE } from '../game/progression';
import type { GodDef, StatKey } from '../game/types';
import { hypot } from '../core/math';
import { body, godUnit, variant } from './factory';
import type { BaseZone, Sim } from './Sim';
import { Unit, type Brain, type Point, type SimEvent } from './Unit';

/**
 * Jötunn: one player is a frost giant about eight times a god's height; the
 * other four are gods. The giant wins by smashing three of the four braziers
 * on the temple plaza with its club. The gods win by bringing it down, which
 * only its weak points allow: break both knees and it kneels, crown exposed;
 * break the rune on its back and it can't use skills for a moment; strike
 * the wrist it plants after a Glacial Slam and the slam is spent. Shrines in
 * the valley give the giant a new ultimate attack. Rounds rotate who plays
 * the giant, and every round won scores for whoever won it.
 */
export const JOTUNN = {
  gods: 4,
  godLevel: 12,
  giantLevel: 20,
  /** The giant's health: its Might. */
  might: { base: 40000, perGod: 20000 },
  /** Damage reduction of the giant's hide: blows to the body do a tenth of their damage. */
  hide: 0.8,
  bodyRadius: 1.6,
  /** Rubble and low walls it strides over. */
  stepOver: 2.5,
  /** Club blows a brazier takes (its health is set from the club's damage). */
  brazierHits: 14,
  braziersToWin: 3,
  godRespawn: 7,
  /** Share of max health a second a god heals at the fountain. */
  fountain: 0.12,
  countdown: 5,
  /** Between rounds. */
  pause: 7,
  kneel: 7,
  /** How long a slam's hand stays planted (wrist exposed, giant rooted). */
  plant: 2.5,
  /** One broken knee slows the giant this much until it grows back. */
  limp: 0.3,
  runeSilence: 4,
  wristStagger: 1.5,
  /** A broken wrist keeps the slam on cooldown this long. */
  wristLock: 20,
  /** From this point in a round the giant hits harder every minute, so no round stalls. */
  furyAfter: 300,
  furyPerMinute: 0.15,
  shrineRadius: 5,
  /** Seconds the giant stands in a shrine (without gods in it) to claim it. */
  claimTime: 3,
  shrineRearm: 60,
  /** Each claimed shrine: more damage for the rest of the round, and some Might back. */
  shrineDamage: 0.08,
  shrineHeal: 0.06,
  giantSpawn: { x: 0, z: -64, yaw: Math.PI },
  godSpawns: [
    { x: 0, z: 36, yaw: 0 },
    { x: -3, z: 38, yaw: 0 },
    { x: 3, z: 38, yaw: 0 },
    { x: -6, z: 40, yaw: 0 },
    { x: 6, z: 40, yaw: 0 },
  ],
  bases: {
    order: { x: 0, z: 39, radius: 8 },
    chaos: { x: 0, z: -66, radius: 6 },
  } satisfies Record<Side, BaseZone>,
  /** The four braziers on the temple platform, between the columns (as Temple.ts places them). */
  braziers: [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4].map((a) => ({ x: Math.cos(a) * 9.5, z: Math.sin(a) * 9.5 })),
  brazierRadius: 0.8,
} as const;

export type PartId = 'kneeL' | 'kneeR' | 'rune' | 'wristL' | 'wristR' | 'crown';

export interface PartDef {
  name: string;
  health: number;
  radius: number;
  /** Where it sits on the giant: meters to its right and ahead of its center. */
  right: number;
  fwd: number;
  /** Height of the spot above the ground, for views and aiming. */
  height: number;
  /** How much of each blow it passes on to the giant's Might. */
  mult: number;
  /** Fraction of the giant's Might lost when it breaks. */
  shatter: number;
  /** Seconds until it grows back after breaking (0: only the mode restores it). */
  regrow: number;
}

export const PARTS: Record<PartId, PartDef> = {
  kneeL: { name: 'Left Knee', health: 3500, radius: 1, right: -1.35, fwd: 0.55, height: 5.4, mult: 1, shatter: 0.015, regrow: 12 },
  kneeR: { name: 'Right Knee', health: 3500, radius: 1, right: 1.35, fwd: 0.55, height: 5.4, mult: 1, shatter: 0.015, regrow: 12 },
  rune: { name: 'Back Rune', health: 4000, radius: 1.25, right: 0, fwd: -1.75, height: 11.5, mult: 1, shatter: 0.03, regrow: 25 },
  wristL: { name: 'Left Wrist', health: 1500, radius: 1.1, right: -2.2, fwd: 4, height: 0.8, mult: 1.5, shatter: 0.03, regrow: 0 },
  wristR: { name: 'Right Wrist', health: 1500, radius: 1.1, right: 2.2, fwd: 4, height: 0.8, mult: 1.5, shatter: 0.03, regrow: 0 },
  crown: { name: 'Crown', health: 1e6, radius: 1.5, right: 0, fwd: 2.8, height: 8.5, mult: 2, shatter: 0, regrow: 0 },
};

export const PART_IDS = Object.keys(PARTS) as PartId[];

export interface ShrineDef {
  id: string;
  name: string;
  x: number;
  z: number;
  /** The ultimate it gives the giant. */
  ult: string;
}

/** On the north lane (the giant's way in) and on the dirt paths west and east. */
export const SHRINES: readonly ShrineDef[] = [
  { id: 'rime', name: 'Rime Shrine', x: 0, z: -46, ult: 'jotunn.frost-breath' },
  { id: 'avalanche', name: 'Avalanche Shrine', x: -42, z: 2, ult: 'jotunn.avalanche' },
  { id: 'hail', name: 'Hail Shrine', x: 44, z: -3, ult: 'jotunn.hailstorm' },
];

export interface ShrineState {
  readonly def: ShrineDef;
  /** 0..1 of the giant's claim. */
  progress: number;
  /** A god stands in it, holding the claim. */
  contested: boolean;
  /** Seconds until it can be claimed again (0: ready). */
  dormant: number;
}

/** Someone taking part: they play their god, and the giant in their round. */
export interface JotunnPlayer {
  name: string;
  /** Their peer id online, '' for the local player, null for a bot. */
  id: string | null;
  god: Unit;
  wins: number;
  /** How their round as the giant went, once it has. */
  giantRound: { braziers: number; time: number; won: boolean } | null;
}

export type JotunnPhase = 'countdown' | 'fight' | 'over' | 'done';

/** What starts a round's bots, so the rules don't depend on how they play. */
export interface JotunnBrains {
  giant(mode: Jotunn): Brain;
  god(mode: Jotunn, u: Unit): Brain;
}

export class Jotunn {
  readonly giant: Unit;
  readonly parts = new Map<PartId, Unit>();
  readonly braziers: Unit[] = [];
  readonly shrines: ShrineState[] = SHRINES.map((def) => ({ def, progress: 0, contested: false, dormant: 0 }));
  readonly players: JotunnPlayer[];
  /** Which player is the giant in each round (indices into players). */
  readonly order: number[];
  round = 0;
  phase: JotunnPhase = 'countdown';
  /** Seconds left in the countdown or pause; seconds into the round while fighting. */
  timer = 0;
  /** Who took the last round. */
  lastRound: 'giant' | 'gods' | null = null;
  /** Seconds left kneeling (both knees broken, crown exposed), 0 when standing. */
  kneeling = 0;
  /** The hand planted after a slam: the wrist that is exposed, where, and for how long. */
  planted: { part: 'wristL' | 'wristR'; x: number; z: number; left: number } | null = null;
  /** Seconds until each broken part grows back. */
  readonly regrow = new Map<PartId, number>();
  /** Shrines the giant has claimed this round. */
  claims = 0;
  /** Called as each round starts, so the game can hand the giant (and the gods) to whoever plays them. */
  onRound: ((giant: JotunnPlayer) => void) | null = null;
  private readonly brains: JotunnBrains | null;
  private readonly bonus: Partial<Record<StatKey, number>> = {};
  private nextHand: 'wristL' | 'wristR' = 'wristR';
  private readonly might: number;
  private readonly club: number;

  constructor(
    private readonly sim: Sim,
    players: readonly { name: string; id: string | null; god: GodDef | Unit }[],
    opts: { rounds?: number; order?: number[]; brains?: JotunnBrains } = {},
  ) {
    this.brains = opts.brains ?? null;
    const gods = Math.max(1, Math.min(JOTUNN.gods, players.length - 1));
    this.might = JOTUNN.might.base + JOTUNN.might.perGod * gods;
    this.giant = giantUnit(this.might);
    this.club = jotunn.base.attackPower * 0.3;
    sim.add(this.giant);
    this.setBonus('damageReduction', JOTUNN.hide);
    for (const id of PART_IDS) {
      const p = partUnit(id, this.giant);
      this.parts.set(id, p);
      sim.add(p);
    }
    JOTUNN.braziers.forEach((at, i) => {
      const b = brazierUnit(i, at, this.club * JOTUNN.brazierHits);
      this.braziers.push(b);
      sim.add(b);
    });
    this.players = players.map((p, i) => {
      const spawn = JOTUNN.godSpawns[i % JOTUNN.godSpawns.length]!;
      const god = p.god instanceof Unit ? p.god : godUnit(p.god, 'order', { ...spawn });
      god.home.x = spawn.x;
      god.home.z = spawn.z;
      god.home.yaw = spawn.yaw;
      return { name: p.name, id: p.id, god, wins: 0, giantRound: null };
    });
    for (const p of this.players) if (!sim.units.includes(p.god)) sim.add(p.god);
    this.order = opts.order ?? defaultOrder(this.players, opts.rounds);
    sim.listeners.push((e) => this.on(e));
  }

  /** The player who is the giant this round. */
  get giantPlayer(): JotunnPlayer {
    return this.players[this.order[Math.max(0, this.round - 1)]!]!;
  }

  /** The gods fighting this round (every player's god but the giant's). */
  get gods(): Unit[] {
    const g = this.giantPlayer;
    return this.players.filter((p) => p !== g).map((p) => p.god);
  }

  get rounds(): number {
    return this.order.length;
  }

  get braziersLeft(): number {
    return this.braziers.filter((b) => b.alive).length;
  }

  /** How much harder the giant hits now (fury plus shrines), as a fraction. */
  get fury(): number {
    return Math.max(0, (this.timer - JOTUNN.furyAfter) / 60) * JOTUNN.furyPerMinute;
  }

  /** The player (or players, on a tie) with the most rounds won, once the match is over. */
  get champions(): JotunnPlayer[] {
    if (this.phase !== 'done') return [];
    const best = Math.max(...this.players.map((p) => p.wins));
    return this.players.filter((p) => p.wins === best);
  }

  begin(): void {
    this.startRound(1);
  }

  private on(e: SimEvent): void {
    if (this.phase === 'done') return;
    // a slam that lands leaves its fist planted where it struck
    if (e.type === 'cast' && e.unit === this.giant && e.cast.skill.id === 'jotunn.slam' && this.phase === 'fight') {
      this.plant(e.x, e.z);
      return;
    }
    if (e.type === 'damage') {
      const id = this.partOf(e.target);
      if (id && this.giant.alive && this.phase === 'fight') this.giant.combatant.takeDamage(e.amount * PARTS[id].mult);
      return;
    }
    if (e.type !== 'death') return;
    const id = this.partOf(e.unit);
    if (id) this.broke(id);
    else if (this.players.some((p) => p.god === e.unit)) e.unit.combatant.respawnTimer = JOTUNN.godRespawn;
  }

  private partOf(u: Unit): PartId | null {
    if (u.kind !== 'weakpoint') return null;
    for (const [id, p] of this.parts) if (p === u) return id;
    return null;
  }

  /** A weak point gives way: Might torn away, and what that part does. */
  private broke(id: PartId): void {
    const def = PARTS[id];
    const g = this.giant;
    if (g.alive && def.shatter > 0) g.combatant.takeDamage(this.might * def.shatter);
    if (def.regrow > 0) this.regrow.set(id, def.regrow);
    switch (id) {
      case 'kneeL':
      case 'kneeR':
        if (!this.parts.get('kneeL')!.alive && !this.parts.get('kneeR')!.alive) this.kneel();
        break;
      case 'rune':
        g.combatant.cc.apply('silence', JOTUNN.runeSilence, 0, 0, false, 'jotunn:rune');
        break;
      case 'wristL':
      case 'wristR': {
        this.planted = null;
        this.sim.cancelWindup(g);
        g.combatant.cc.apply('stun', JOTUNN.wristStagger, 0, 0, false, 'jotunn:wrist');
        g.combatant.setCooldown('jotunn.slam', JOTUNN.wristLock);
        break;
      }
    }
  }

  /** Both knees broken: down on them, crown exposed, until they grow back. */
  private kneel(): void {
    const g = this.giant;
    this.kneeling = JOTUNN.kneel;
    this.planted = null;
    this.sim.cancelWindup(g);
    g.combatant.cc.apply('stun', JOTUNN.kneel, 0, 0, false, 'jotunn:kneel');
    // the knees come back when it stands, not on their own clocks
    this.regrow.delete('kneeL');
    this.regrow.delete('kneeR');
  }

  step(dt: number): void {
    if (this.phase === 'done') return;
    if (this.phase === 'countdown') {
      this.timer -= dt;
      this.hold();
      this.placeParts();
      if (this.timer <= 0) {
        this.phase = 'fight';
        this.timer = 0;
      }
      return;
    }
    if (this.phase === 'over') {
      this.timer -= dt;
      this.placeParts();
      if (this.timer <= 0) {
        if (this.round >= this.rounds) this.phase = 'done';
        else this.startRound(this.round + 1);
      }
      return;
    }
    this.timer += dt;
    // gods heal fast at their fountain, so a retreat is a short trip
    for (const u of this.gods) if (u.alive && this.sim.inBase(u)) u.combatant.heal(u.combatant.stats.maxHealth * JOTUNN.fountain * dt);
    this.stepParts(dt);
    this.stepShrines(dt);
    this.setBonus('damageBonus', this.fury + this.claims * JOTUNN.shrineDamage);
    const limping = this.kneeling <= 0 && (!this.parts.get('kneeL')!.alive || !this.parts.get('kneeR')!.alive);
    this.setBonus('bonusMoveSpeed', limping ? -JOTUNN.limp : 0);
    this.placeParts();
    if (!this.giant.alive) this.endRound('gods');
    else if (JOTUNN.braziers.length - this.braziersLeft >= JOTUNN.braziersToWin) this.endRound('giant');
  }

  private stepParts(dt: number): void {
    for (const [id, left] of this.regrow) {
      const t = left - dt;
      if (t > 0) {
        this.regrow.set(id, t);
        continue;
      }
      this.regrow.delete(id);
      this.restore(id);
    }
    if (this.kneeling > 0) {
      this.kneeling = Math.max(0, this.kneeling - dt);
      if (this.kneeling <= 0) {
        this.restore('kneeL');
        this.restore('kneeR');
      }
    }
    if (this.planted) {
      this.planted.left -= dt;
      if (this.planted.left <= 0 || !this.giant.alive) this.planted = null;
    }
  }

  private restore(id: PartId): void {
    const c = this.parts.get(id)!.combatant;
    if (!c.alive) c.respawn();
    else c.health = c.stats.maxHealth;
  }

  private plant(x: number, z: number): void {
    const part = this.nextHand;
    this.nextHand = part === 'wristR' ? 'wristL' : 'wristR';
    const wrist = this.parts.get(part)!;
    if (!wrist.alive) wrist.combatant.respawn();
    this.planted = { part, x, z, left: JOTUNN.plant };
    this.giant.combatant.cc.apply('root', JOTUNN.plant, 0, 0, false, 'jotunn:plant');
  }

  /** Each weak point follows the body; the ones not exposed right now can't be hit. */
  private placeParts(): void {
    const g = this.giant;
    const f = g.forward;
    for (const [id, p] of this.parts) {
      const def = PARTS[id];
      let x = g.x + -f.z * def.right + f.x * def.fwd;
      let z = g.z + f.x * def.right + f.z * def.fwd;
      let exposed = g.alive && this.phase !== 'countdown';
      if (id === 'crown') exposed &&= this.kneeling > 0;
      if (id === 'wristL' || id === 'wristR') {
        exposed &&= this.planted?.part === id;
        if (this.planted?.part === id) {
          x = this.planted.x;
          z = this.planted.z;
        }
      }
      p.body.x = x;
      p.body.z = z;
      p.body.y = g.body.y;
      p.body.yaw = g.body.yaw;
      // a large finite number: Infinity doesn't survive a snapshot
      p.untargetable = exposed ? 0 : 1e4;
    }
  }

  private stepShrines(dt: number): void {
    const g = this.giant;
    for (const s of this.shrines) {
      if (s.dormant > 0) {
        s.dormant = Math.max(0, s.dormant - dt);
        continue;
      }
      const inside = (u: Unit) => u.alive && hypot(u.x - s.def.x, u.z - s.def.z) <= JOTUNN.shrineRadius + u.radius;
      s.contested = this.gods.some(inside);
      const claiming = inside(g) && this.kneeling <= 0;
      if (!claiming) s.progress = Math.max(0, s.progress - dt / JOTUNN.claimTime);
      else if (!s.contested) s.progress = Math.min(1, s.progress + dt / JOTUNN.claimTime);
      if (s.progress >= 1) this.claim(s);
    }
  }

  /** The shrine's attack takes the giant's ultimate slot, ready to use, and its power stays for the round. */
  private claim(s: ShrineState): void {
    const c = this.giant.combatant;
    s.progress = 0;
    s.dormant = JOTUNN.shrineRearm;
    this.claims++;
    c.loadout = [c.loadout[0], c.loadout[1], c.loadout[2], s.def.ult];
    c.setCooldown(s.def.ult, 0);
    c.heal(this.might * JOTUNN.shrineHeal);
  }

  /** Set one of the giant's mode bonuses to `value` (they are permanent perks, kept exact by deltas). */
  private setBonus(stat: StatKey, value: number): void {
    const now = this.bonus[stat] ?? 0;
    if (Math.abs(now - value) < 1e-9) return;
    this.giant.combatant.addPerk(stat, value - now);
    this.bonus[stat] = value;
  }

  private endRound(winner: 'giant' | 'gods'): void {
    this.lastRound = winner;
    const g = this.giantPlayer;
    g.giantRound = { braziers: JOTUNN.braziers.length - this.braziersLeft, time: this.timer, won: winner === 'giant' };
    if (winner === 'giant') g.wins++;
    else for (const p of this.players) if (p !== g) p.wins++;
    this.phase = 'over';
    this.timer = JOTUNN.pause;
    this.planted = null;
    this.kneeling = 0;
    this.sim.cancelWindup(this.giant);
    // everyone stands down until the next round
    this.giant.brain = null;
    for (const p of this.players) p.god.brain = null;
    for (const u of [this.giant, ...this.gods]) u.move = null;
  }

  private startRound(n: number): void {
    this.round = n;
    this.phase = 'countdown';
    this.timer = JOTUNN.countdown;
    this.lastRound = null;
    this.kneeling = 0;
    this.planted = null;
    this.claims = 0;
    this.regrow.clear();
    const sim = this.sim;
    const giantP = this.giantPlayer;
    // the giant's own god sits the round out
    for (const p of this.players) {
      const playing = p !== giantP;
      const inSim = sim.units.includes(p.god);
      if (playing && !inSim) sim.add(p.god);
      if (!playing && inSim) sim.remove(p.god);
    }
    const g = this.giant;
    const gc = g.combatant;
    sim.cancelWindup(g);
    if (!gc.alive) gc.respawn();
    gc.health = gc.stats.maxHealth;
    gc.cc.reset();
    gc.resetCooldowns();
    gc.loadout = [...jotunn.defaultLoadout];
    this.setBonus('damageBonus', 0);
    this.setBonus('bonusMoveSpeed', 0);
    g.wasAlive = true;
    sim.teleport(g, JOTUNN.giantSpawn.x, JOTUNN.giantSpawn.z, JOTUNN.giantSpawn.yaw);
    for (const id of PART_IDS) this.restore(id);
    for (const b of this.braziers) {
      if (!b.alive) b.combatant.respawn();
      b.combatant.health = b.combatant.stats.maxHealth;
      b.deadFor = 0;
    }
    for (const s of this.shrines) {
      s.progress = 0;
      s.contested = false;
      s.dormant = 0;
    }
    const level = Math.min(XP_TABLE.length, JOTUNN.godLevel);
    for (const u of this.gods) {
      const c = u.combatant;
      const need = XP_TABLE[level - 1]! - c.xp;
      if (need > 0) c.gainXp(need);
      c.resetCooldowns();
      if (!c.alive) c.respawnTimer = 0;
      else {
        c.health = c.stats.maxHealth;
        c.mana = c.stats.maxMana;
      }
      sim.teleport(u, u.home.x, u.home.z, u.home.yaw);
    }
    g.brain = giantP.id === null && this.brains ? this.brains.giant(this) : null;
    for (const p of this.players) {
      if (p === giantP) continue;
      p.god.brain = p.id === null && this.brains ? this.brains.god(this, p.god) : null;
    }
    this.placeParts();
    this.onRound?.(giantP);
  }

  /** During the countdown everyone waits at their mark. */
  private hold(): void {
    const at = JOTUNN.giantSpawn;
    const g = this.giant;
    if (hypot(g.x - at.x, g.z - at.z) > 0.05) this.sim.teleport(g, at.x, at.z, at.yaw);
    for (const u of this.gods) {
      if (u.alive && hypot(u.x - u.home.x, u.z - u.home.z) > 0.05) this.sim.teleport(u, u.home.x, u.home.z, u.home.yaw);
    }
  }

  /** Whether a point lies in a giant's shrine's circle. */
  shrineAt(p: Point): ShrineState | null {
    return this.shrines.find((s) => hypot(p.x - s.def.x, p.z - s.def.z) <= JOTUNN.shrineRadius) ?? null;
  }
}

/** Solo: a bot is the giant first, then you. With more people, each takes a turn. */
function defaultOrder(players: readonly JotunnPlayer[], rounds?: number): number[] {
  const humans = players.map((p, i) => (p.id !== null ? i : -1)).filter((i) => i >= 0);
  const bots = players.map((p, i) => (p.id === null ? i : -1)).filter((i) => i >= 0);
  if (humans.length >= 2) return humans.slice(0, rounds ?? humans.length);
  const order = [bots[0] ?? 0, humans[0] ?? 1];
  return order.slice(order.length - Math.max(1, Math.min(order.length, rounds ?? order.length)));
}

function giantUnit(might: number): Unit {
  const def = { ...jotunn, base: { ...jotunn.base, maxHealth: might } };
  const at = JOTUNN.giantSpawn;
  const u = new Unit('god', def.name, new Combatant(def, 'chaos'), body(at.x, at.z, at.yaw), JOTUNN.bodyRadius, { ...at });
  const c = u.combatant;
  c.ccImmune = true;
  c.gainXp(XP_TABLE[JOTUNN.giantLevel - 1]!);
  u.respawns = false;
  u.stepOver = JOTUNN.stepOver;
  u.tag = 'jotunn';
  u.origin = { f: 'mode', kind: 'jotunn:giant' };
  return u;
}

function partUnit(id: PartId, giant: Unit): Unit {
  const p = PARTS[id];
  const def = variant(jotunn, `jotunn:${id}`, p.name, { maxHealth: p.health, physicalProtection: 30, magicalProtection: 30, attackPower: 0 });
  const u = new Unit('weakpoint', p.name, new Combatant(def, 'chaos'), body(giant.x, giant.z, giant.body.yaw), p.radius, { x: giant.x, z: giant.z, yaw: 0 });
  u.combatant.ccImmune = true;
  u.respawns = false;
  u.owner = giant;
  // the knees are the giant's legs: nothing walks through them
  u.blocks = id === 'kneeL' || id === 'kneeR';
  u.tag = id;
  u.origin = { f: 'mode', kind: `jotunn:${id}` };
  return u;
}

function brazierUnit(i: number, at: Point, health: number): Unit {
  const def = variant(jotunn, 'jotunn:brazier', 'Brazier', { maxHealth: health, physicalProtection: 0, magicalProtection: 0, attackPower: 0 });
  const u = new Unit('brazier', 'Brazier', new Combatant(def, 'order'), body(at.x, at.z, 0), JOTUNN.brazierRadius, { x: at.x, z: at.z, yaw: 0 });
  u.respawns = false;
  u.tag = `brazier${i}`;
  u.origin = { f: 'mode', kind: 'jotunn:brazier', data: i };
  return u;
}
