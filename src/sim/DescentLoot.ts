import { hypot } from '../core/math';
import type { ChamberDef } from '../map/UnderworldLayout';
import type { Sim } from './Sim';
import type { Point, Unit } from './Unit';

/**
 * What makes a descent an extraction run: treasure, the traps that guard it,
 * and the choice at each depth's end to climb out with the haul or carry it
 * deeper.
 *
 * - Every beast slain drops a little treasure, and every chamber hides a
 *   chest or two off the straight way through, often out by the brink. A god
 *   opens one by standing over it; some are cursed, and burst as they open.
 *   A depth's master leaves its hoard.
 * - Pressure plates lie in the floor, hard to see until the torch is on
 *   them. A step on one and it clicks, then goes off: fire in the Ashen
 *   Depths, a snare of frost in the Drowned Halls, spikes of bone in the
 *   Abyss. They catch beasts as surely as gods.
 * - The haul is only carried until it is brought out. Each master that
 *   falls opens the way back up beside the way down: climb out and the haul
 *   is banked, or go deeper, where everything found is worth more. A team
 *   that dies down there loses all but a keepsake of it.
 */
export const LOOT = {
  /** Treasure a beast drops, by how hard it is to kill (a master's is its hoard chest). */
  kill: { body: 3, heavy: 8, champion: 25 },
  chest: {
    /** How close a god stands to open one, and how long it takes. */
    range: 2.1,
    time: 1.6,
    /** What a chest holds, before the depth's worth: a plain one, and a master's hoard. */
    value: [28, 46] as const,
    hoard: [110, 150] as const,
    /** The share of plain chests that are cursed, and what one does as it opens: a burst about it after `warn` seconds. */
    cursed: 0.28,
    burst: { warn: 0.7, radius: 3, damage: 0.14 },
    /** A cursed chest holds this much more, for those who take the burst or step clear of it. */
    cursedBonus: 1.6,
  },
  trap: {
    /** A plate's radius, how long it clicks before it goes off, how far that reaches, and how long until it is set again. */
    plate: 0.95,
    delay: 0.5,
    radius: 1.7,
    reset: 10,
    /** Its bite, as a share of the most health: gods, beasts, and a master. */
    damage: [0.15, 0.08, 0.12] as const,
    beast: 0.3,
    master: 0.03,
    /** The Drowned Halls' snare roots, the Abyss's spikes stun (seconds). */
    root: 1.4,
    stun: 0.6,
    /** How many a hall holds besides the one by each chest. */
    count: [2, 3] as const,
  },
  /** How much more everything found is worth in each depth. */
  worth: [1, 1.5, 2.25] as const,
  /** The share of the haul a team that dies keeps: what was in their pockets. */
  keepsake: 0.1,
  /** Clearing the last chamber pays the whole haul and this much again. */
  crown: 0.5,
} as const;

export type TrapKind = 'flame' | 'frost' | 'spikes';
export const DEPTH_TRAP: readonly TrapKind[] = ['flame', 'frost', 'spikes'];

export interface Chest {
  id: number;
  x: number;
  z: number;
  /** Which way its front faces (radians): toward the floor it is reached from. */
  yaw: number;
  hoard: boolean;
  cursed: boolean;
  value: number;
  /** How far it is opened (0..1), and whether it has been (its treasure taken). */
  open: number;
  opened: boolean;
  /** A cursed one: seconds until it bursts once opened (negative: not counting, or done). */
  burst: number;
}

export interface Trap {
  id: number;
  x: number;
  z: number;
  kind: TrapKind;
  /** Seconds until it goes off once stepped on (negative: not sprung). */
  fuse: number;
  /** Seconds until it is set again after going off (0: set). */
  rest: number;
  /** Times it has gone off (for the view's cue). */
  fired: number;
}

/** What the loot sends over the wire. */
export interface LootNet {
  h: number;
  b: number;
  c: [number, number, number, number, number, number, number, number][];
  t: [number, number, number, number, number, number][];
  g?: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Floor spots of a chamber (local x, z) that pass a test, a meter apart. */
function floorSpots(c: ChamberDef, keep: (x: number, z: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  const e = c.extent;
  for (let z = -e + 3; z <= e - 3; z += 1) for (let x = -e; x <= e; x += 1) if (keep(x, z)) out.push([x, z]);
  return out;
}

const clearOf = (list: readonly (readonly [number, number, number?])[], x: number, z: number, gap: number) => list.every(([px, pz, r = 0]) => hypot(x - px, z - pz) >= r + gap);

/** Whether a spot is out of both gates' lanes: the straight walk in, and the walk out. */
function offTheWay(c: ChamberDef, x: number, z: number, gap: number): boolean {
  const e = c.extent;
  return hypot(x, z - (e - 3.5)) > gap && hypot(x, z + e - 1) > gap * 0.7;
}

export class Loot {
  readonly chests: Chest[] = [];
  readonly traps: Trap[] = [];
  /** Treasure carried, not yet brought out: lost (but for a keepsake) if the team dies. */
  haul = 0;
  /** Treasure brought out of the underworld: the run's score, set as it ends. */
  banked = 0;
  /** The latest gain, for the view and the HUD: how much, where, and a count that goes up with each. */
  readonly gain = { n: 0, amount: 0, x: 0, z: 0, chest: false };
  private c: ChamberDef | null = null;
  private depth = 0;
  private nextId = 1;

  constructor(private readonly sim: Sim) {}

  /** How much more a find is worth this deep. */
  get worth(): number {
    return LOOT.worth[this.depth] ?? 1;
  }

  /**
   * A new chamber: its chests and its traps laid, the same on every machine
   * for the same run (it draws on the sim's dice). A master's chamber has no
   * plain chest and no trap: its hoard comes when it falls.
   */
  enter(c: ChamberDef, depth: number, boss: boolean): void {
    this.c = c;
    this.depth = depth;
    this.chests.length = 0;
    this.traps.length = 0;
    if (boss) return;
    const rng = this.sim.rng;
    const blocked: (readonly [number, number, number])[] = [...c.pillars, ...c.fires.map(([x, z]) => [x, z, 0.7] as const), ...c.vents.map(([x, z]) => [x, z, 2.4] as const)];
    // chests: off the way through, with room to stand before them; out by the brink first, where there is one
    const cands = floorSpots(c, (x, z) => c.sd(x, z) >= 1.5 && c.sd(x, z) <= 4.5 && clearOf(blocked, x, z, 1.8) && offTheWay(c, x, z, 13));
    const want = 1 + (rng() < 0.55 ? 1 : 0);
    const picked: [number, number][] = [];
    for (let k = 0; k < want && cands.length; k++) {
      const score = ([x, z]: [number, number]) =>
        (picked.length ? Math.min(...picked.map(([px, pz]) => hypot(x - px, z - pz))) : Math.abs(x) * 0.5) - Math.max(0, c.brink(x, z) - 2) * 0.6 + rngAt(x, z, c.x) * 3;
      let best = 0;
      for (let i = 1; i < cands.length; i++) if (score(cands[i]!) > score(cands[best]!)) best = i;
      picked.push(cands.splice(best, 1)[0]!);
    }
    for (const [x, z] of picked) {
      // facing the broad floor: up the field's slope
      const e = 0.5;
      const gx = c.sd(x + e, z) - c.sd(x - e, z);
      const gz = c.sd(x, z + e) - c.sd(x, z - e);
      const cursed = rng() < LOOT.chest.cursed;
      const [lo, hi] = LOOT.chest.value;
      const value = Math.round((lo + rng() * (hi - lo)) * (cursed ? LOOT.chest.cursedBonus : 1));
      this.chests.push({ id: this.nextId++, x: c.x + x, z: c.z + z, yaw: Math.atan2(gx, gz), hoard: false, cursed, value, open: 0, opened: false, burst: -1 });
    }
    // traps: one on the approach to each chest, the rest out on the floor the fight will cross
    const T = LOOT.trap;
    const kind = DEPTH_TRAP[depth] ?? 'flame';
    const spots: [number, number][] = [];
    const free = (x: number, z: number, gap = 4) =>
      c.sd(x, z) >= T.plate + 0.5 && clearOf(blocked, x, z, T.plate + 0.6) && offTheWay(c, x, z, 9) && clearOf(spots, x, z, gap) && hypot(x - c.hold[0], z - c.hold[1]) > 2.5;
    for (const ch of this.chests) {
      const lx = ch.x - c.x;
      const lz = ch.z - c.z;
      const reach = 2.6 + rng() * 1.2;
      const a0 = ch.yaw + (rng() - 0.5) * 1.2;
      for (let k = 0; k < 8; k++) {
        const a = a0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.45;
        const x = lx + Math.sin(a) * reach;
        const z = lz + Math.cos(a) * reach;
        if (!free(x, z, 2.5)) continue;
        spots.push([x, z]);
        break;
      }
    }
    const open = floorSpots(c, (x, z) => free(x, z, 0) && c.sd(x, z) >= 2);
    const more = T.count[0] + Math.floor(rng() * (T.count[1] - T.count[0] + 1));
    for (let k = 0; k < more && open.length; k++) {
      // spread apart, and toward the middle of the hall, where feet go
      const score = ([x, z]: [number, number]) => (spots.length ? Math.min(14, ...spots.map(([px, pz]) => hypot(x - px, z - pz))) : 6) - hypot(x, z) * 0.2 + rngAt(x, z, c.z) * 4;
      let best = 0;
      for (let i = 1; i < open.length; i++) if (score(open[i]!) > score(open[best]!)) best = i;
      const s = open.splice(best, 1)[0]!;
      if (free(s[0], s[1])) spots.push(s);
    }
    for (const [x, z] of spots) this.traps.push({ id: this.nextId++, x: c.x + x, z: c.z + z, kind, fuse: -1, rest: 0, fired: 0 });
  }

  /** A master has fallen: its hoard stands where it fell (or on the nearest broad floor). */
  hoard(at: Point): void {
    const c = this.c;
    if (!c) return;
    let x = at.x - c.x;
    let z = at.z - c.z;
    if (c.sd(x, z) < 2) [x, z] = c.hold;
    const [lo, hi] = LOOT.chest.hoard;
    this.chests.push({ id: this.nextId++, x: c.x + x, z: c.z + z, yaw: 0, hoard: true, cursed: false, value: Math.round(lo + this.sim.rng() * (hi - lo)), open: 0, opened: false, burst: -1 });
  }

  /** Treasure found, at this depth's worth. */
  find(amount: number, at: Point, chest = false): void {
    const got = Math.round(amount * this.worth);
    if (got <= 0) return;
    this.haul += got;
    this.gain.n++;
    this.gain.amount = got;
    this.gain.x = at.x;
    this.gain.z = at.z;
    this.gain.chest = chest;
  }

  /** The team climbs out, or clears the last chamber (`crowned`): the haul is theirs. */
  bank(crowned = false): number {
    this.banked = Math.round(this.haul * (crowned ? 1 + LOOT.crown : 1));
    this.haul = 0;
    return this.banked;
  }

  /** The team dies below: all but a keepsake is lost. */
  lose(): number {
    this.banked = Math.floor(this.haul * LOOT.keepsake);
    this.haul = 0;
    return this.banked;
  }

  /**
   * One step. Gods standing at a chest open it (only `openers` may: the
   * humans, or everyone on a team of bots); plates under their feet or a
   * beast's click and go off; cursed chests burst.
   */
  step(dt: number, gods: readonly Unit[], openers: readonly Unit[], monsters: readonly Unit[], master: (m: Unit) => boolean): void {
    const C = LOOT.chest;
    for (const ch of this.chests) {
      if (ch.burst >= 0) {
        ch.burst -= dt;
        if (ch.burst < 0) this.burst(ch, gods);
      }
      if (ch.opened) continue;
      const by = openers.find((g) => g.alive && !g.forced && !g.combatant.cc.locks().move && hypot(g.x - ch.x, g.z - ch.z) <= C.range + g.radius);
      if (!by) {
        ch.open = Math.max(0, ch.open - dt / C.time);
        continue;
      }
      ch.open = Math.min(1, ch.open + dt / C.time);
      if (ch.open < 1) continue;
      ch.opened = true;
      this.find(ch.value, ch, true);
      if (ch.cursed) ch.burst = C.burst.warn;
    }
    const T = LOOT.trap;
    for (const t of this.traps) {
      if (t.rest > 0) {
        t.rest = Math.max(0, t.rest - dt);
        continue;
      }
      if (t.fuse >= 0) {
        t.fuse -= dt;
        if (t.fuse < 0) this.fire(t, gods, monsters, master);
        continue;
      }
      const on = (u: Unit) => u.alive && !u.forced?.arc && u.untargetable <= 0 && hypot(u.x - t.x, u.z - t.z) <= T.plate + u.radius * 0.4;
      // (bots know the floor: only a human's feet, or a beast's, set one off)
      if (openers.some(on) || monsters.some((m) => !master(m) && on(m))) t.fuse = T.delay;
    }
  }

  private burst(ch: Chest, gods: readonly Unit[]): void {
    const B = LOOT.chest.burst;
    for (const g of gods) if (g.alive && g.untargetable <= 0 && hypot(g.x - ch.x, g.z - ch.z) <= B.radius + g.radius) this.hurt(g, B.damage);
  }

  private fire(t: Trap, gods: readonly Unit[], monsters: readonly Unit[], master: (m: Unit) => boolean): void {
    const T = LOOT.trap;
    t.rest = T.reset;
    t.fired++;
    const i = DEPTH_TRAP.indexOf(t.kind);
    for (const g of gods) {
      if (!g.alive || g.untargetable > 0 || g.forced?.arc || hypot(g.x - t.x, g.z - t.z) > T.radius + g.radius) continue;
      this.hurt(g, T.damage[i] ?? 0.12);
      if (!g.alive) continue;
      if (t.kind === 'frost') g.combatant.receiveCC('root', T.root, 0, 'descent:trap');
      else if (t.kind === 'spikes') g.combatant.receiveCC('stun', T.stun, 0, 'descent:trap');
    }
    for (const m of monsters) {
      if (!m.alive || hypot(m.x - t.x, m.z - t.z) > T.radius + m.radius) continue;
      const amount = m.combatant.stats.maxHealth * (master(m) ? T.master : T.beast);
      if (amount >= m.combatant.health) {
        const by = nearest(gods, m);
        if (by) {
          this.sim.slay(by, m);
          continue;
        }
      }
      m.combatant.takeDamage(amount);
      this.sim.inject({ type: 'damage', target: m, source: null, amount, crit: false, ability: true });
    }
  }

  private hurt(g: Unit, share: number): void {
    const c = g.combatant;
    const amount = c.stats.maxHealth * share * (1 - Math.min(0.9, c.stats.damageReduction));
    c.takeDamage(amount);
    this.sim.inject({ type: 'damage', target: g, source: null, amount, crit: false, ability: true });
  }

  /**
   * Which way a god at (x, z) should step to be clear of a plate about to go
   * off or a cursed chest about to burst.
   */
  threat(x: number, z: number, radius: number): Point | null {
    const away = (cx: number, cz: number, r: number): Point | null => {
      const dx = x - cx;
      const dz = z - cz;
      const d = hypot(dx, dz);
      if (d > r + radius + 0.3) return null;
      return d > 0.05 ? { x: dx / d, z: dz / d } : { x: 1, z: 0 };
    };
    for (const t of this.traps) {
      if (t.rest > 0) continue;
      const a = t.fuse >= 0 ? away(t.x, t.z, LOOT.trap.radius) : null;
      if (a) return a;
    }
    for (const ch of this.chests) {
      if (ch.burst < 0) continue;
      const a = away(ch.x, ch.z, LOOT.chest.burst.radius);
      if (a) return a;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // The wire

  netState(): LootNet {
    return {
      h: this.haul,
      b: this.banked,
      c: this.chests.map((c) => [c.id, r2(c.x), r2(c.z), r2(c.yaw), (c.hoard ? 1 : 0) + (c.cursed ? 2 : 0) + (c.opened ? 4 : 0), r2(c.open), r2(c.burst), c.value]),
      t: this.traps.map((t) => [t.id, r2(t.x), r2(t.z), r2(t.fuse), r2(t.rest), t.fired]),
      ...(this.gain.n ? { g: this.gain.n } : {}),
    };
  }

  /** On a guest: the host's chests, traps and haul. */
  applyNet(c: ChamberDef, depth: number, s: LootNet | undefined): void {
    if (!s) return;
    this.c = c;
    this.depth = depth;
    const gained = s.h - this.haul;
    this.haul = s.h;
    this.banked = s.b;
    this.chests.length = 0;
    for (const [id, x, z, yaw, bits, open, burst, value] of s.c) this.chests.push({ id, x, z, yaw, hoard: !!(bits & 1), cursed: !!(bits & 2), opened: !!(bits & 4), open, burst, value });
    const kind = DEPTH_TRAP[depth] ?? 'flame';
    this.traps.length = 0;
    for (const [id, x, z, fuse, rest, fired] of s.t) this.traps.push({ id, x, z, kind, fuse, rest, fired });
    if ((s.g ?? 0) > this.gain.n && gained > 0) {
      const from = this.chests.find((ch) => ch.opened && ch.open >= 1);
      this.gain.amount = gained;
      this.gain.chest = gained >= LOOT.chest.value[0];
      if (from && this.gain.chest) [this.gain.x, this.gain.z] = [from.x, from.z];
    }
    this.gain.n = s.g ?? this.gain.n;
  }

  /** On a guest, between snapshots: the fuses run on. */
  follow(dt: number): void {
    for (const t of this.traps) {
      if (t.fuse >= 0) t.fuse = Math.max(0, t.fuse - dt);
      else if (t.rest > 0) t.rest = Math.max(0, t.rest - dt);
    }
    for (const c of this.chests) if (c.burst >= 0) c.burst = Math.max(0, c.burst - dt);
  }
}

/** A fixed scatter by place, so a pick among equal spots is the same on every machine without spending the sim's dice. */
function rngAt(x: number, z: number, salt: number): number {
  const v = Math.sin(x * 12.9898 + z * 78.233 + salt * 0.37) * 43758.5453;
  return v - Math.floor(v);
}

function nearest(gods: readonly Unit[], m: Unit): Unit | null {
  let best: Unit | null = null;
  let bd = Infinity;
  for (const g of gods) {
    if (!g.alive) continue;
    const d = hypot(g.x - m.x, g.z - m.z);
    if (d < bd) [bd, best] = [d, g];
  }
  return best;
}
