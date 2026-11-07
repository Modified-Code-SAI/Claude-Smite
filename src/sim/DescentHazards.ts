import { hypot } from '../core/math';
import { BRINK_FAR, type ChamberDef } from '../map/UnderworldLayout';
import type { Sim } from './Sim';
import type { Point, Unit } from './Unit';

/**
 * Each depth's own dangers, live while a chamber is being fought:
 *
 * - The Ashen Depths: magma vents in the open floor glow and then blast a
 *   column of fire (it burns beasts as well as gods, so a team can lure them
 *   onto one), and the lava spits globs of slag that land near whoever stands
 *   close to it and burn and slow anyone in the puddle while it cools.
 * - The Drowned Halls: the water rises. Every so often it floods the floor
 *   near it for a few seconds, slowing gods wading in it and dragging them
 *   toward the deep, where the undertow pulls at them.
 * - The Abyss: the floor near the void cracks under a god's feet and falls
 *   away (anyone on it drops, and the dark flings them back up hurt and
 *   dazed; a beast caught on it is gone), and in its halls the dark creeps
 *   in from the void the longer a fight runs, burning whoever it covers.
 *   Each kill drives it back a little.
 *
 * Shares are of the god's most health, cut by its damage reduction.
 */
export const HAZARDS = {
  vent: { every: [6.5, 9.5] as const, first: [2.5, 5.5] as const, warn: 1.6, radius: 2.4, damage: 0.12, beast: 0.3, master: 0.03 },
  slag: { every: 5, first: 3, flight: 1.1, radius: 2.1, life: 5, burn: 0.04, slow: -0.3, near: 7.5, max: 5 },
  tide: { calm: 13, rise: 2.5, high: 6, ebb: 2.5, first: 7, reach: 3.6, slow: -0.3, pull: 1, deep: 1.1, drown: 0.03 },
  crumble: { every: 6, first: 4, warn: 1.3, radius: 2.3, down: 8, rise: 1.4, near: 4, damage: 0.12, stun: 0.4, max: 3 },
  dark: { after: 18, creep: 0.15, keep: 0.5, burn: 0.025, kill: 0.8, recede: 2.5 },
} as const;

/** One of the forge's magma vents: `t` seconds until it blows (it glows for the last `HAZARDS.vent.warn` of them). */
export interface Vent {
  x: number;
  z: number;
  t: number;
}

/** A glob of slag: in the air while `fly` > 0, then a puddle for `left` seconds more. `fx, fz` is the lava it was spat from. */
export interface Slag {
  id: number;
  x: number;
  z: number;
  fx: number;
  fz: number;
  fly: number;
  left: number;
}

/** A patch of the Abyss's brink: cracking until `t` reaches the warning, then fallen away, then rising back. */
export interface Gap {
  id: number;
  x: number;
  z: number;
  r: number;
  t: number;
}

/** What a chamber's dangers send over the wire (Descent's netState). */
export interface HazardsNet {
  v?: number[];
  s?: [number, number, number, number, number, number, number][];
  g?: [number, number, number, number, number][];
  td?: number;
  dk?: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export class Hazards {
  vents: Vent[] = [];
  readonly slag: Slag[] = [];
  readonly gaps: Gap[] = [];
  /** Seconds into the tide's cycle (calm, rising, high, ebbing). */
  tide = 0;
  /** How far (m) the creeping dark reaches in from the void. */
  dark = 0;
  /** The chamber they belong to. */
  private c: ChamberDef | null = null;
  private fought = 0;
  private spitIn = 0;
  private crumbleIn = 0;
  private nextId = 1;
  /** Damage dealt a little at a time, shown as one number every half second. */
  private readonly owed = new Map<Unit, number>();
  private owedFor = 0;
  /** How far the dark may reach in each chamber (it always leaves a share of the floor clear). */
  private static readonly darkCaps = new Map<string, number>();

  constructor(private readonly sim: Sim) {
    sim.terrain.cut?.((x, z) => this.gapField(x, z));
  }

  /** The depth's danger names, for the HUD and the herald. */
  static of(depth: number): readonly string[] {
    return depth === 0 ? ['vents', 'slag'] : depth === 1 ? ['tide'] : ['crumble', 'dark'];
  }

  /** A new chamber: everything quiet, the vents set to their first blasts. */
  enter(c: ChamberDef): void {
    this.c = c;
    this.slag.length = 0;
    this.gaps.length = 0;
    this.dark = 0;
    this.fought = 0;
    this.owed.clear();
    this.tide = HAZARDS.tide.calm - HAZARDS.tide.first;
    this.spitIn = HAZARDS.slag.first;
    this.crumbleIn = HAZARDS.crumble.first;
    const rng = this.sim.rng;
    const [a, b] = HAZARDS.vent.first;
    this.vents = c.vents.map(([x, z]) => ({ x: c.x + x, z: c.z + z, t: a + rng() * (b - a) }));
  }

  /** How high the water stands (0 calm, 1 at the full flood). */
  get flood(): number {
    if (this.c?.depth !== 1) return 0;
    const { calm, rise, high, ebb } = HAZARDS.tide;
    const t = this.tide;
    if (t < calm) return 0;
    if (t < calm + rise) return smooth((t - calm) / rise);
    if (t < calm + rise + high) return 1;
    return 1 - smooth(Math.min(1, (t - calm - rise - high) / ebb));
  }

  /** How far (m) the flood reaches in from the water's edge. */
  get floodReach(): number {
    return this.flood * HAZARDS.tide.reach;
  }

  /** A glowing vent's warmth: 0 cold, 1 about to blow. */
  heat(v: Vent): number {
    return Math.max(0, 1 - v.t / HAZARDS.vent.warn);
  }

  /** How far a patch has dropped (m below the floor): 0 while it cracks, the void's depth while it is gone, back to 0 as it rises. */
  static drop(g: Gap): number {
    const { warn, down, rise } = HAZARDS.crumble;
    if (g.t < warn) return 0;
    if (g.t < warn + down) return 30 * smooth(Math.min(1, (g.t - warn) / 1.6));
    return 30 * (1 - smooth(Math.min(1, (g.t - warn - down) / rise)));
  }

  /** Whether a patch is open (nothing walks onto it). */
  static open(g: Gap): boolean {
    const { warn, down, rise } = HAZARDS.crumble;
    return g.t >= warn && g.t < warn + down + rise * 0.7;
  }

  /** Positive inside a fallen patch: cut out of the walkable floor (see SimTerrain.cut). */
  private gapField(x: number, z: number): number {
    let f = -1e3;
    if (!this.gaps.length) return f;
    for (const g of this.gaps) if (Hazards.open(g)) f = Math.max(f, g.r - hypot(x - g.x, z - g.z));
    return f;
  }

  /** A beast falling dead pushes the dark back a step. */
  onKill(): void {
    this.dark = Math.max(0, this.dark - HAZARDS.dark.kill);
  }

  /**
   * One step. While `active` (a fight under way, no boss rising or falling)
   * the dangers come; otherwise what is already happening plays out and the
   * rest settles: the water drains, the dark draws back, the ground mends.
   */
  step(dt: number, active: boolean, gods: readonly Unit[], monsters: readonly Unit[], master: (m: Unit) => boolean): void {
    const c = this.c;
    if (!c) return;
    if (c.depth === 0) this.stepForge(dt, active, gods, monsters, master);
    else if (c.depth === 1) this.stepTide(dt, active, gods);
    else this.stepAbyss(dt, active, gods, monsters, master);
    this.owedFor += dt;
    if (this.owedFor >= 0.5) {
      this.owedFor = 0;
      for (const [g, amount] of this.owed) if (amount > 0) this.sim.inject({ type: 'damage', target: g, source: null, amount, crit: false, ability: true });
      this.owed.clear();
    }
  }

  // -------------------------------------------------------------------------
  // The Ashen Depths

  private stepForge(dt: number, active: boolean, gods: readonly Unit[], monsters: readonly Unit[], master: (m: Unit) => boolean): void {
    const c = this.c!;
    const V = HAZARDS.vent;
    const rng = this.sim.rng;
    for (const v of this.vents) {
      // a vent that has started to glow always blows; a cold one waits for the fighting
      if (!active && v.t > V.warn) continue;
      v.t -= dt;
      if (v.t > 0) continue;
      v.t = active ? V.every[0] + rng() * (V.every[1] - V.every[0]) : V.warn + 1;
      this.blast(v, gods, monsters, master);
    }
    const S = HAZARDS.slag;
    for (let i = this.slag.length - 1; i >= 0; i--) {
      const s = this.slag[i]!;
      if (s.fly > 0) {
        s.fly -= dt;
        continue;
      }
      s.left -= dt;
      if (s.left <= 0) {
        this.slag.splice(i, 1);
        continue;
      }
      // the puddle burns less as it cools
      const heat = Math.min(1, s.left / (S.life * 0.6));
      for (const g of gods) {
        if (!g.alive || g.untargetable > 0 || g.forced?.arc || hypot(g.x - s.x, g.z - s.z) > S.radius + g.radius * 0.5) continue;
        this.burn(g, S.burn * heat * dt);
        g.combatant.refreshTimedMod('bonusMoveSpeed', S.slow, 0.25);
      }
    }
    if (!active) return;
    this.spitIn -= dt;
    if (this.spitIn > 0 || this.slag.length >= S.max) return;
    this.spitIn = S.every * (0.75 + rng() * 0.5);
    // at a god standing near the lava, a little ahead of where they are going
    const near = gods.filter((g) => g.alive && c.brink(g.x - c.x, g.z - c.z) < S.near);
    const g = near[Math.floor(rng() * near.length)];
    if (!g) return;
    const x = g.x + g.vx * 0.5 + (rng() - 0.5) * 2;
    const z = g.z + g.vz * 0.5 + (rng() - 0.5) * 2;
    if (c.sd(x - c.x, z - c.z) < 0.3) return;
    const from = this.toEdge(x, z, -1.2);
    this.slag.push({ id: this.nextId++, x, z, fx: from.x, fz: from.z, fly: S.flight, left: S.life });
  }

  /** A vent blows: gods in it are burned, beasts too (a master hardly). */
  private blast(v: Vent, gods: readonly Unit[], monsters: readonly Unit[], master: (m: Unit) => boolean): void {
    const V = HAZARDS.vent;
    for (const g of gods) if (g.alive && g.untargetable <= 0 && hypot(g.x - v.x, g.z - v.z) <= V.radius + g.radius) this.hurt(g, V.damage);
    for (const m of monsters) {
      if (!m.alive || hypot(m.x - v.x, m.z - v.z) > V.radius + m.radius) continue;
      const amount = m.combatant.stats.maxHealth * (master(m) ? V.master : V.beast);
      if (amount >= m.combatant.health) {
        // a kill counts for the nearest god (its souls, its team's tally)
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

  // -------------------------------------------------------------------------
  // The Drowned Halls

  private stepTide(dt: number, active: boolean, gods: readonly Unit[]): void {
    const T = HAZARDS.tide;
    const period = T.calm + T.rise + T.high + T.ebb;
    // between fights a flood under way drains away; the next fight starts calm
    if (active) this.tide = (this.tide + dt) % period;
    else if (this.tide >= T.calm) {
      // (from wherever it stands, straight into the ebb)
      const ebbFrom = T.calm + T.rise + T.high;
      this.tide = Math.max(this.tide + dt, ebbFrom + T.ebb * (1 - this.flood));
      if (this.tide >= period) this.tide = T.calm - T.first;
    }
    const level = this.flood;
    if (level < 0.05) return;
    const c = this.c!;
    const reach = level * T.reach;
    for (const g of gods) {
      if (!g.alive || g.untargetable > 0 || g.forced) continue;
      const lx = g.x - c.x;
      const lz = g.z - c.z;
      const b = c.brink(lx, lz);
      if (b >= reach) continue;
      g.combatant.refreshTimedMod('bonusMoveSpeed', T.slow, 0.25);
      if (b < T.deep && level > 0.6) this.burn(g, T.drown * dt);
      // the water drags them toward the deep
      const [gx, gz] = gradient(c.brink, lx, lz);
      const step = T.pull * level * dt;
      const p = this.sim.solid(g.x - gx * step, g.z - gz * step, g.radius, g.body.y + g.stepOver, g, this.sim.terrain, g);
      g.body.x = p.x;
      g.body.z = p.z;
    }
  }

  // -------------------------------------------------------------------------
  // The Abyss

  private stepAbyss(dt: number, active: boolean, gods: readonly Unit[], monsters: readonly Unit[], master: (m: Unit) => boolean): void {
    const c = this.c!;
    const C = HAZARDS.crumble;
    for (let i = this.gaps.length - 1; i >= 0; i--) {
      const g = this.gaps[i]!;
      const was = g.t;
      g.t += dt;
      if (was < C.warn && g.t >= C.warn) this.fall(g, gods, monsters, master);
      if (g.t >= C.warn + C.down + C.rise) this.gaps.splice(i, 1);
    }
    const D = HAZARDS.dark;
    // (not in the Ossuary King's own hall: his Soul Rain is his)
    if (active && !c.boss) {
      this.fought += dt;
      if (this.fought > D.after) this.dark = Math.min(this.darkCap(c), this.dark + D.creep * dt);
    } else this.dark = Math.max(0, this.dark - D.recede * dt);
    if (this.dark > 0.05) {
      for (const g of gods) {
        if (!g.alive || g.untargetable > 0 || g.forced?.arc) continue;
        if (c.brink(g.x - c.x, g.z - c.z) < this.dark) this.burn(g, D.burn * dt);
      }
    }
    if (!active) return;
    this.crumbleIn -= dt;
    if (this.crumbleIn > 0 || this.gaps.length >= C.max) return;
    this.crumbleIn = C.every * (0.8 + this.sim.rng() * 0.4);
    const rng = this.sim.rng;
    const near = gods.filter((g) => g.alive && !g.forced && c.brink(g.x - c.x, g.z - c.z) < C.near);
    const g = near[Math.floor(rng() * near.length)];
    if (!g) return;
    const lx = g.x - c.x;
    const lz = g.z - c.z;
    const b = Math.max(0, c.brink(lx, lz));
    const [gx, gz] = gradient(c.brink, lx, lz);
    // never where it would cut a narrow way through: there has to be broad floor behind it
    if (c.brink(lx + gx * 6, lz + gz * 6) < 2.5 || c.sd(lx + gx * 6, lz + gz * 6) < 1) return;
    // reaching from the god to the edge
    const x = g.x - gx * b * 0.5;
    const z = g.z - gz * b * 0.5;
    if (this.gaps.some((o) => hypot(o.x - x, o.z - z) < o.r + C.radius + 0.5)) return;
    this.gaps.push({ id: this.nextId++, x, z, r: C.radius, t: 0 });
  }

  /** A patch gives way: gods on it drop and are flung back up onto solid floor, hurt and dazed; beasts on it are gone. */
  private fall(gap: Gap, gods: readonly Unit[], monsters: readonly Unit[], master: (m: Unit) => boolean): void {
    const C = HAZARDS.crumble;
    for (const g of gods) {
      if (!g.alive || g.forced?.arc || hypot(g.x - gap.x, g.z - gap.z) > gap.r) continue;
      if (g.untargetable <= 0) this.hurt(g, C.damage);
      if (!g.alive) continue;
      const to = this.safeSpot(gap, g);
      const time = 0.8;
      g.forced = { vx: (to.x - g.x) / time, vz: (to.z - g.z) / time, remaining: time, total: time, arc: 2.6, collide: false };
      g.combatant.cc.apply('stun', time + C.stun, 0, 0, false, 'descent:fall');
    }
    for (const m of monsters) {
      if (!m.alive || master(m) || hypot(m.x - gap.x, m.z - gap.z) > gap.r) continue;
      const by = nearest(gods, m);
      if (by) this.sim.slay(by, m);
    }
  }

  /** The nearest solid floor clear of a fallen patch, from where a god stood on it. */
  private safeSpot(gap: Gap, g: Unit): Point {
    const c = this.c!;
    let best: Point = { x: c.x + c.hold[0], z: c.z + c.hold[1] };
    let bd = Infinity;
    for (let r = 0.5; r <= 9; r += 0.5) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = g.x + Math.sin(a) * r;
        const z = g.z + Math.cos(a) * r;
        if (hypot(x - gap.x, z - gap.z) < gap.r + 1 || c.sd(x - c.x, z - c.z) < 1.4) continue;
        if (this.gaps.some((o) => o !== gap && Hazards.open(o) && hypot(x - o.x, z - o.z) < o.r + 1)) continue;
        const d = hypot(x - g.x, z - g.z);
        if (d < bd) [bd, best] = [d, { x, z }];
      }
      if (bd < Infinity) break;
    }
    return best;
  }

  /** How far the dark may reach in a chamber: as far as leaves `keep` of its floor clear. */
  private darkCap(c: ChamberDef): number {
    const known = Hazards.darkCaps.get(c.name);
    if (known !== undefined) return known;
    const b: number[] = [];
    for (let x = -c.extent; x <= c.extent; x += 1) for (let z = -c.extent; z <= c.extent; z += 1) if (c.sd(x, z) >= 0) b.push(c.brink(x, z));
    b.sort((p, q) => p - q);
    const cap = Math.min(BRINK_FAR, b[Math.floor(b.length * (1 - HAZARDS.dark.keep))] ?? 0);
    Hazards.darkCaps.set(c.name, cap);
    return cap;
  }

  // -------------------------------------------------------------------------

  /**
   * Which way a god at (x, z) should step to be out of harm's way, if it is
   * in it or about to be: out of a vent about to blow, a glob about to land,
   * a slag puddle or a cracking patch, or (`soft`, a danger worth braving to
   * finish a fight) the flood or the dark.
   */
  threat(x: number, z: number, radius: number): (Point & { soft?: boolean }) | null {
    const c = this.c;
    if (!c) return null;
    const away = (cx: number, cz: number, r: number): Point | null => {
      const dx = x - cx;
      const dz = z - cz;
      const d = hypot(dx, dz);
      if (d > r + radius + 0.3) return null;
      return d > 0.05 ? { x: dx / d, z: dz / d } : { x: 1, z: 0 };
    };
    for (const v of this.vents) {
      if (v.t > HAZARDS.vent.warn * 0.9) continue;
      const a = away(v.x, v.z, HAZARDS.vent.radius);
      if (a) return a;
    }
    for (const s of this.slag) {
      if (s.fly > 0.8) continue;
      const a = away(s.x, s.z, HAZARDS.slag.radius);
      if (a) return a;
    }
    for (const g of this.gaps) {
      if (g.t > HAZARDS.crumble.warn) continue;
      const a = away(g.x, g.z, g.r);
      if (a) return a;
    }
    // the flood rising or the dark coming: inland
    const lx = x - c.x;
    const lz = z - c.z;
    const reach = c.depth === 1 ? (this.tide >= HAZARDS.tide.calm - 1 ? HAZARDS.tide.reach * Math.max(0.6, this.flood) : 0) : this.dark > 0.05 ? this.dark + 0.6 : 0;
    if (reach > 0 && c.brink(lx, lz) < reach + 0.4) {
      const [gx, gz] = gradient(c.brink, lx, lz);
      return { x: gx, z: gz, soft: true };
    }
    return null;
  }

  private hurt(g: Unit, share: number): void {
    const c = g.combatant;
    const amount = c.stats.maxHealth * share * (1 - Math.min(0.9, c.stats.damageReduction));
    c.takeDamage(amount);
    this.sim.inject({ type: 'damage', target: g, source: null, amount, crit: false, ability: true });
  }

  private burn(g: Unit, share: number): void {
    const c = g.combatant;
    const amount = c.stats.maxHealth * share * (1 - Math.min(0.9, c.stats.damageReduction));
    c.takeDamage(amount);
    this.owed.set(g, (this.owed.get(g) ?? 0) + amount);
  }

  /** The nearest point of the hole's edge to (x, z), `past` meters out over it. */
  private toEdge(x: number, z: number, past: number): Point {
    const c = this.c!;
    let lx = x - c.x;
    let lz = z - c.z;
    for (let k = 0; k < 6; k++) {
      const b = c.brink(lx, lz);
      const [gx, gz] = gradient(c.brink, lx, lz);
      lx -= gx * (b - past);
      lz -= gz * (b - past);
    }
    return { x: c.x + lx, z: c.z + lz };
  }

  // -------------------------------------------------------------------------
  // The wire

  netState(): HazardsNet | null {
    if (!this.c) return null;
    const out: HazardsNet = {};
    if (this.vents.length) out.v = this.vents.map((v) => r2(v.t));
    if (this.slag.length) out.s = this.slag.map((s) => [s.id, r2(s.x), r2(s.z), r2(s.fx), r2(s.fz), r2(s.fly), r2(s.left)]);
    if (this.gaps.length) out.g = this.gaps.map((g) => [g.id, r2(g.x), r2(g.z), g.r, r2(g.t)]);
    if (this.c.depth === 1) out.td = r2(this.tide);
    if (this.dark > 0) out.dk = r2(this.dark);
    return out;
  }

  /** On a guest: the host's dangers, for the view (and the gaps for walking). */
  applyNet(c: ChamberDef, s: HazardsNet | undefined): void {
    if (this.c !== c) this.enter(c);
    s ??= {};
    s.v?.forEach((t, i) => {
      const v = this.vents[i];
      if (v) v.t = t;
    });
    this.slag.length = 0;
    for (const [id, x, z, fx, fz, fly, left] of s.s ?? []) this.slag.push({ id, x, z, fx, fz, fly, left });
    this.gaps.length = 0;
    for (const [id, x, z, r, t] of s.g ?? []) this.gaps.push({ id, x, z, r, t });
    this.tide = s.td ?? this.tide;
    this.dark = s.dk ?? 0;
  }

  /** On a guest, between snapshots: the clocks run on so the glow and the falls stay smooth. */
  follow(dt: number): void {
    for (const v of this.vents) v.t = Math.max(0, v.t - dt);
    for (const s of this.slag) {
      if (s.fly > 0) s.fly = Math.max(0, s.fly - dt);
      else s.left = Math.max(0, s.left - dt);
    }
    for (const g of this.gaps) g.t += dt;
  }
}

function smooth(t: number): number {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
}

/** The direction a field rises fastest at a point (a unit vector, or 0, 0 where it is flat). */
function gradient(f: (x: number, z: number) => number, x: number, z: number): [number, number] {
  const e = 0.25;
  const gx = f(x + e, z) - f(x - e, z);
  const gz = f(x, z + e) - f(x, z - e);
  const g = hypot(gx, gz);
  return g > 1e-6 ? [gx / g, gz / g] : [0, 0];
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
