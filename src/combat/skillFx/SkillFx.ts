import * as THREE from 'three/webgpu';
import type { Sim } from '../../sim/Sim';
import { PROJECTILE_HEIGHT } from '../../sim/Sim';
import type { Flash, Projectile, SimEvent, Unit } from '../../sim/Unit';
import { ArcView } from '../Arcs';
import { paletteOf, type GodPalette } from '../palette';
import { hypot } from '../../core/math';
import { lookFor, type FxKit, type ShotLook, type SkillLook } from '../skillLooks';
import { Beam, type BeamOpts } from './Beam';
import { Funnel, type FunnelOpts } from './Funnel';
import { Pool, Running, type Live } from './pool';
import { Prop, PROP_KINDS, type PropKind } from './Props';
import { Ribbon, type RibbonOpts } from './Ribbon';
import { Shards, type ShardKind } from './Shards';
import { Sigil, type SigilOpts } from './Sigil';
import { Swarm, type SwarmOpts } from './Swarm';

type Ground = (x: number, z: number) => number;

/** What the director borrows from the shared effects (CombatVfx): bursts, clouds, columns of light. */
export interface BaseFx {
  burst(p: GodPalette, x: number, y: number, z: number, power: number): void;
  cloud(color: number, x: number, y: number, z: number, power: number, swirl: number): void;
  pillar(p: GodPalette, x: number, z: number, size: number, width: number): void;
  /** A glowing trail riding on a unit for `life` seconds. */
  comet(p: GodPalette, u: Unit, life: number, size: number, crackle: boolean): void;
}

/** A lightning bolt that lives a moment, re-forking while it does. */
class Bolt implements Live {
  readonly arc = new ArcView();
  readonly group = this.arc.group;
  private age = 0;
  private life = 0.2;
  private every = 0.05;
  private last = -1;
  private width = 0.3;
  private forks = 2;
  private jag = 0.18;
  private sky = false;
  readonly a = new THREE.Vector3();
  readonly b = new THREE.Vector3();

  start(p: { vfx: number; core: number }, a: THREE.Vector3, b: THREE.Vector3, width: number, life: number, forks: number, jag: number, sky: boolean): this {
    this.arc.setColors(p.vfx, p.core);
    this.a.copy(a);
    this.b.copy(b);
    this.width = width;
    this.life = life;
    this.forks = forks;
    this.jag = jag;
    this.sky = sky;
    this.every = sky ? 0.06 : 0.045;
    this.age = 0;
    this.last = -1;
    this.redraw();
    return this;
  }

  private redraw(): void {
    const a = this.arc;
    a.clear();
    if (this.sky) a.strike(this.a, this.b, this.width, this.forks, this.jag);
    else a.bolt(this.a, this.b, this.width, this.jag, 1, 3);
  }

  update(dt: number): boolean {
    const k = (this.age += dt);
    const step = Math.floor(k / this.every);
    if (step !== this.last && k < this.life * 0.7) {
      this.last = step;
      this.redraw();
    }
    // a hot flash, then a flicker out
    this.arc.values.fade = k < 0.05 ? 1 : Math.max(0, 1 - (k - 0.05) / Math.max(0.01, this.life - 0.05)) * (0.75 + 0.25 * Math.sin(k * 90));
    if (k >= this.life) this.arc.clear();
    return k < this.life;
  }
}

/** Lightning crawling over and around a unit: short arcs re-struck every `every` seconds. */
class Crackle implements Live {
  readonly arc = new ArcView();
  readonly group = this.arc.group;
  private age = 0;
  private life = 1;
  private every = 0.08;
  private last = -1;
  private radius = 1;
  private height = 2;
  private width = 0.11;
  private readonly at = new THREE.Vector3();

  start(p: { vfx: number; core: number }, life: number, radius: number, height: number, every: number, width: number): this {
    this.arc.setColors(p.vfx, p.core);
    this.arc.clear();
    this.age = 0;
    this.last = -1;
    this.life = life;
    this.radius = radius;
    this.height = height;
    this.every = every;
    this.width = width;
    return this;
  }

  /** Where the unit's feet are now. */
  move(x: number, y: number, z: number): void {
    this.at.set(x, y, z);
  }

  update(dt: number): boolean {
    const k = (this.age += dt);
    const step = Math.floor(k / this.every);
    if (step !== this.last) {
      this.last = step;
      const a = this.arc;
      a.clear();
      const r = this.radius;
      for (let i = 0; i < 3; i++) {
        const y = this.at.y + 0.2 + Math.random() * this.height;
        const ang = Math.random() * Math.PI * 2;
        const turn = 0.8 + Math.random() * 1.4;
        A.set(this.at.x + Math.sin(ang) * r, y, this.at.z + Math.cos(ang) * r);
        B.set(this.at.x + Math.sin(ang + turn) * r, y + (Math.random() - 0.5) * 0.9, this.at.z + Math.cos(ang + turn) * r);
        a.bolt(A, B, this.width, 0.35, 0.8, 3);
      }
    }
    const left = this.life - k;
    this.arc.values.fade = Math.min(1, left / 0.3) * (0.55 + 0.45 * Math.max(0, 1 - (k - step * this.every) / this.every));
    if (left <= 0) this.arc.clear();
    return left > 0;
  }

  stop(): void {
    this.life = Math.min(this.life, this.age + 0.2);
  }
}

/** A prop flying on its own (not a sim projectile): daggers fanning out, Mjolnir coming home, a lobbed bomb. */
class Flight implements Live {
  readonly prop = new Prop();
  readonly group = this.prop.group;
  private readonly from = new THREE.Vector3();
  private readonly to = new THREE.Vector3();
  private age = 0;
  private time = 0.3;
  private arc = 0;
  private spin = 0;
  /** Flies back to this unit instead of to a fixed point. */
  home: Unit | null = null;
  onLand: ((x: number, y: number, z: number) => void) | null = null;

  start(kind: PropKind, glow: number, size: number, from: THREE.Vector3, to: THREE.Vector3, time: number, arc: number, spin: number): this {
    this.prop.dress(kind, glow, size);
    this.from.copy(from);
    this.to.copy(to);
    this.time = time;
    this.arc = arc;
    this.spin = spin;
    this.age = 0;
    this.home = null;
    this.onLand = null;
    this.update(0);
    return this;
  }

  update(dt: number): boolean {
    const k = Math.min(1, (this.age += dt) / this.time);
    if (this.home) this.to.set(this.home.x, this.home.body.y + 1.4, this.home.z);
    const f = this.from;
    const t = this.to;
    const x = f.x + (t.x - f.x) * k;
    const z = f.z + (t.z - f.z) * k;
    const y = f.y + (t.y - f.y) * k + Math.sin(k * Math.PI) * this.arc;
    const yaw = Math.atan2(-(t.x - f.x), -(t.z - f.z));
    this.prop.aim(x, y, z, yaw);
    if (this.spin) this.prop.mesh.rotation.x = -this.age * this.spin * Math.PI * 2;
    if (k >= 1) {
      this.onLand?.(x, y, z);
      return false;
    }
    return true;
  }
}

/** A skill shot's own dressing while it flies: props, a tether to the caster, a chain through its bounces. */
class ShotFx {
  readonly props: Prop[] = [];
  sigil: Sigil | null = null;
  readonly tether = new ArcView();
  readonly chain = new ArcView();
  /** Bounce points, for a chain of lightning through them. */
  readonly kinks: THREE.Vector3[] = [];
  id = 0;
  seen = 0;
  look!: ShotLook;
  owner!: Unit;
  palette!: GodPalette;
  lastDx = 0;
  lastDz = 0;
  redrawn = 0;
  readonly at = new THREE.Vector3();
}

/** An effect kept on a unit: it follows them and is hidden while they hide from the viewer. */
interface Follower {
  fx: Live;
  unit: Unit;
  dy: number;
  until: number;
  move: (x: number, y: number, z: number) => void;
  keep?: (u: Unit) => boolean;
  /** The effect's run when it was attached: a pooled effect that ended and was reused is someone else's. */
  gen: number;
}

/** What a zone's look keeps going while the zone lasts. */
interface ZoneFx {
  id: number;
  fx: (Live & { stop?(): void; strength?: number })[];
  move: ((x: number, y: number, z: number) => void)[];
  seen: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const A = new THREE.Vector3();
const B = new THREE.Vector3();

/**
 * Plays each skill's own look (src/combat/skillLooks.ts) on top of the shared
 * effects: what its shot looks like in flight, what it does when it resolves,
 * where it hits, and what stays on the gods it touched. Everything is pooled
 * and drawn once while loading, so no cast builds a shader.
 */
export class SkillFx implements FxKit {
  readonly group = new THREE.Group();
  private readonly ribbons: Running<Ribbon>;
  private readonly beams: Running<Beam>;
  private readonly funnels: Running<Funnel>;
  private readonly sigils: Running<Sigil>;
  private readonly swarms: Running<Swarm>;
  private readonly bolts: Running<Bolt>;
  private readonly flights: Running<Flight>;
  private readonly crackles: Running<Crackle>;
  private sim: Sim | null = null;
  private readonly propPool: Pool<Prop>;
  private readonly shotPool: { free: ShotFx[] };
  private readonly rocks = new Shards('rock');
  private readonly spears = new Shards('spear', 96);
  /** The dressed shots by projectile id, and the same as a list (walked every frame without allocating). */
  private readonly shots = new Map<number, ShotFx>();
  private readonly shotList: ShotFx[] = [];
  private readonly followers: Follower[] = [];
  private readonly zoneFx = new Map<number, ZoneFx>();
  private readonly zoneList: ZoneFx[] = [];
  private frameNo = 0;
  t = 0;
  units: readonly Unit[] = [];
  /** Who may see a unit (stealthed enemies hide their auras). */
  visible: (u: Unit) => boolean = () => true;
  /** The view camera, so floating sigils face it. */
  camera: THREE.Camera | null = null;

  constructor(
    parent: THREE.Object3D,
    readonly ground: Ground,
    private readonly base: BaseFx,
  ) {
    this.group.name = 'skill-fx';
    parent.add(this.group);
    const g = this.group;
    this.ribbons = new Running(new Pool(g, () => new Ribbon(), 6));
    this.beams = new Running(new Pool(g, () => new Beam(), 4));
    this.funnels = new Running(new Pool(g, () => new Funnel(), 2));
    this.sigils = new Running(new Pool(g, () => new Sigil(), 4));
    this.swarms = new Running(new Pool(g, () => new Swarm(), 3));
    this.bolts = new Running(new Pool(g, () => new Bolt(), 8));
    this.flights = new Running(new Pool(g, () => new Flight(), 5));
    this.crackles = new Running(new Pool(g, () => new Crackle(), 3));
    this.propPool = new Pool(g, () => new Prop(), PROP_KINDS.length);
    this.shotPool = { free: [] };
    g.add(this.rocks.mesh, this.spears.mesh);
  }

  /** Shows every pooled piece once (each prop in its own shape) so loading prepares their shaders. */
  prime(): () => void {
    // dress the idle props as every kind, so each shape is drawn once
    const props: Prop[] = [];
    for (const k of PROP_KINDS) props.push(this.propPool.take().dress(k, 0xffffff, 1));
    for (const p of props) p.aim(0, -60, 0, 0);
    const bolt = this.bolts.pool.take();
    bolt.start({ vfx: 0xffffff, core: 0xffffff }, A.set(0, -60, 0), B.set(1, -59, 0), 0.2, 1, 1, 0.2, false);
    this.bolts.pool.release(bolt);
    const restore = [this.ribbons.pool, this.beams.pool, this.funnels.pool, this.sigils.pool, this.swarms.pool, this.bolts.pool, this.flights.pool, this.crackles.pool].map((p) => p.prime());
    const shards = [this.rocks.prime(), this.spears.prime()];
    return () => {
      for (const r of restore) r();
      for (const r of shards) r();
      for (const p of props) this.propPool.release(p);
    };
  }

  /** Ends everything that is playing (the dev stage, between shots). */
  reset(): void {
    for (const r of [this.ribbons, this.beams, this.funnels, this.sigils, this.swarms, this.bolts, this.flights, this.crackles] as Running<Live>[]) r.clear();
    this.followers.length = 0;
    for (const fx of this.shotList) {
      for (const p of fx.props) this.propPool.release(p);
      fx.props.length = 0;
      fx.sigil = null;
      fx.tether.clear();
      fx.chain.clear();
      this.group.remove(fx.tether.group, fx.chain.group);
      this.shotPool.free.push(fx);
    }
    this.shotList.length = 0;
    this.shots.clear();
    this.zoneList.length = 0;
    this.zoneFx.clear();
    this.rocks.clear();
    this.spears.clear();
  }

  // -------------------------------------------------------------------------
  // The kit the looks draw with

  ribbon(o: RibbonOpts): Ribbon {
    return this.ribbons.start().start(o);
  }

  beam(o: BeamOpts): Beam {
    return this.beams.start().start(o);
  }

  funnel(o: FunnelOpts): Funnel {
    return this.funnels.start().start(o);
  }

  sigil(o: SigilOpts): Sigil {
    return this.sigils.start().start(o);
  }

  swarm(o: SwarmOpts): Swarm {
    return this.swarms.start().start(o);
  }

  shard(kind: ShardKind, x: number, z: number, yaw: number, size: number, delay: number, hold: number, glow: number, strength = 1): void {
    (kind === 'rock' ? this.rocks : this.spears).add(x, this.ground(x, z), z, yaw, size, delay, hold, glow, strength);
  }

  /** A bolt from the sky onto (x, z). */
  strike(p: { vfx: number; core: number }, x: number, z: number, opts: { height?: number; width?: number; life?: number; forks?: number; spread?: number } = {}): void {
    const g = this.ground(x, z);
    const s = opts.spread ?? 3;
    A.set(x + (Math.random() - 0.5) * s, g + (opts.height ?? 18), z + (Math.random() - 0.5) * s);
    B.set(x, g + 0.1, z);
    this.bolts.start().start(p, A, B, opts.width ?? 0.45, opts.life ?? 0.22, opts.forks ?? 3, 0.16, true);
  }

  /** A jagged bolt between two points. */
  bolt(p: { vfx: number; core: number }, from: THREE.Vector3, to: THREE.Vector3, width = 0.2, life = 0.18, jag = 0.22): void {
    this.bolts.start().start(p, from, to, width, life, 0, jag, false);
  }

  burst(p: GodPalette, x: number, y: number, z: number, power: number): void {
    this.base.burst(p, x, y, z, power);
  }

  cloud(color: number, x: number, y: number, z: number, power: number, swirl = 0.15): void {
    this.base.cloud(color, x, y, z, power, swirl);
  }

  pillar(p: GodPalette, x: number, z: number, size: number, width: number): void {
    this.base.pillar(p, x, z, size, width);
  }

  /** A prop flying from one point to another on its own. */
  fly(kind: PropKind, glow: number, size: number, from: THREE.Vector3, to: THREE.Vector3, time: number, arc = 0, spin = 0): Flight {
    return this.flights.start().start(kind, glow, size, from, to, time, arc, spin);
  }

  /** Keeps an effect on a unit for `life` seconds, `dy` above its feet. */
  attach(fx: Live, unit: Unit, dy: number, life: number, move: (x: number, y: number, z: number) => void, keep?: (u: Unit) => boolean): void {
    this.followers.push({ fx, unit, dy, until: this.t + life, move, keep, gen: fx.gen ?? 0 });
    move(unit.x, unit.body.y + dy, unit.z);
  }

  comet(p: GodPalette, u: Unit, life: number, size: number, crackle = false): void {
    this.base.comet(p, u, life, size, crackle);
  }

  crackle(p: { vfx: number; core: number }, u: Unit, life: number, radius: number, height: number, every = 0.08, width = 0.11): void {
    const c = this.crackles.start().start(p, life, radius, height, every, width);
    this.attach(c, u, 0, life, (x, y, z) => c.move(x, y, z));
  }

  private readonly shotAt = new THREE.Vector3();

  shotOf(owner: Unit, skill: string): THREE.Vector3 | null {
    for (const p of this.sim?.projectiles ?? []) {
      if (p.owner !== owner || p.cast?.skill.id !== skill) continue;
      return this.shotAt.set(p.x, this.ground(p.x, p.z) + PROJECTILE_HEIGHT, p.z);
    }
    return null;
  }

  /** Living units of a team within `r` of (x, z), for skills that touch a crowd (rallies, team shields). */
  near(x: number, z: number, r: number, team: string, kind = 'god'): Unit[] {
    const out: Unit[] = [];
    for (const u of this.units) if (u.alive && u.team === team && u.kind === kind && hypot(u.x - x, u.z - z) <= r + u.radius) out.push(u);
    return out;
  }

  // -------------------------------------------------------------------------
  // Hooks from CombatVfx

  /** A skill's cast, at the caster (and its target, for skills on an ally). */
  onEvent(e: SimEvent): void {
    switch (e.type) {
      case 'cast': {
        const look = lookFor(e.cast.skill.id);
        if (!look?.cast) return;
        look.cast(this, { owner: e.unit, p: this.palette(look, e.unit), x: e.x, z: e.z, yaw: e.unit.body.yaw, cast: e.cast });
        return;
      }
      case 'damage': {
        if (!e.skill || !e.source || e.amount <= 0) return;
        const look = lookFor(e.skill);
        if (!look?.hit) return;
        look.hit(this, { owner: e.source, p: this.palette(look, e.source), target: e.target, amount: e.amount });
        return;
      }
      case 'impact': {
        if (!e.skill) return;
        const look = lookFor(e.skill);
        if (!look?.impact) return;
        look.impact(this, { owner: e.owner, p: this.palette(look, e.owner), x: e.x, z: e.z, big: e.big });
        return;
      }
      default:
        return;
    }
  }

  /** A skill's shape resolving. Returns how strongly to show the shared flash decal (0..1). */
  onFlash(f: Flash): number {
    if (!f.skill) return 1;
    const look = lookFor(f.skill);
    if (!look) return 1;
    look.flash?.(this, { owner: f.owner, p: this.palette(look, f.owner), shape: f.shape });
    return look.decal ?? 1;
  }

  /** The palette a skill's effects use: its god's, with the look's own colors over it. */
  palette(look: SkillLook | undefined, u: Unit): GodPalette {
    const p = paletteOf(u);
    if (!look?.colors) return p;
    let c = this.recolored.get(look);
    if (!c || c.base !== p) this.recolored.set(look, (c = { base: p, out: { ...p, ...look.colors } }));
    return c.out;
  }

  private readonly recolored = new WeakMap<SkillLook, { base: GodPalette; out: GodPalette }>();

  // -------------------------------------------------------------------------
  // Every frame

  frame(sim: Sim, dt: number, t: number): void {
    this.t = t;
    this.sim = sim;
    this.units = sim.units;
    this.frameNo++;
    this.syncShots(sim, t);
    this.syncZones(sim);
    this.ribbons.update(dt, t);
    this.beams.update(dt, t);
    this.funnels.update(dt, t);
    this.sigils.update(dt, t);
    this.swarms.update(dt, t);
    this.bolts.update(dt, t);
    this.flights.update(dt, t);
    this.crackles.update(dt, t);
    this.rocks.update(dt);
    this.spears.update(dt);
    this.syncFollowers(t);
    const cam = this.camera;
    if (cam) for (const s of this.sigils.list) if (s.facing) s.group.quaternion.copy(cam.quaternion);
  }

  private syncFollowers(t: number): void {
    const f = this.followers;
    for (let i = f.length - 1; i >= 0; i--) {
      const a = f[i]!;
      const u = a.unit;
      if ((a.fx.gen ?? 0) !== a.gen) {
        f[i] = f[f.length - 1]!;
        f.pop();
        continue;
      }
      const done = t >= a.until || !u.alive || (a.keep !== undefined && !a.keep(u));
      if (done) {
        const stoppable = a.fx as { stop?: () => void };
        if (stoppable.stop) stoppable.stop();
        else a.fx.group.visible = false;
        f[i] = f[f.length - 1]!;
        f.pop();
        continue;
      }
      a.fx.group.visible = this.visible(u);
      a.move(u.x, u.body.y + a.dy, u.z);
    }
  }

  private syncShots(sim: Sim, t: number): void {
    const n = this.frameNo;
    for (const p of sim.projectiles) {
      if (!p.cast) continue;
      const look = lookFor(p.cast.skill.id);
      const s = look?.shot;
      if (!s || (!s.prop && !s.tether && !s.chain && !s.sigil)) continue;
      let fx = this.shots.get(p.id);
      if (!fx) {
        fx = this.takeShot(p, look!, s);
        fx.id = p.id;
        this.shots.set(p.id, fx);
        this.shotList.push(fx);
      }
      fx.seen = n;
      this.dressShot(fx, p, t);
    }
    const l = this.shotList;
    for (let i = l.length - 1; i >= 0; i--) {
      const fx = l[i]!;
      if (fx.seen === n) continue;
      l[i] = l[l.length - 1]!;
      l.pop();
      this.shots.delete(fx.id);
      this.endShot(fx);
    }
  }

  private takeShot(p: Projectile, look: SkillLook, s: ShotLook): ShotFx {
    const fx = this.shotPool.free.pop() ?? new ShotFx();
    fx.look = s;
    fx.owner = p.owner;
    fx.palette = this.palette(look, p.owner);
    fx.lastDx = p.dx;
    fx.lastDz = p.dz;
    fx.kinks.length = 0;
    fx.redrawn = -1;
    const c = fx.palette;
    if (s.prop) {
      for (let i = 0; i < (s.count ?? 1); i++) fx.props.push(this.propPool.take().dress(s.prop, c.vfx, s.size ?? 1));
    }
    for (const a of [fx.tether, fx.chain]) {
      a.setColors(c.vfx, c.core);
      a.clear();
      this.group.add(a.group);
    }
    if (s.chain) fx.kinks.push(new THREE.Vector3(p.owner.x, p.owner.body.y + 1.6, p.owner.z));
    fx.sigil = s.sigil ? this.sigil({ x: p.x, y: PROJECTILE_HEIGHT, z: p.z, glyph: s.sigil, size: s.size ?? 1, main: c.vfx, hot: c.core, life: Infinity, spin: 1.2, open: 0.1 }) : null;
    return fx;
  }

  private dressShot(fx: ShotFx, p: Projectile, t: number): void {
    const s = fx.look;
    const y = this.ground(p.x, p.z) + PROJECTILE_HEIGHT;
    fx.at.set(p.x, y, p.z);
    const yaw = Math.atan2(-p.dx, -p.dz);
    const flock = fx.props.length;
    for (let i = 0; i < flock; i++) {
      const prop = fx.props[i]!;
      if (flock === 1) {
        prop.aim(p.x, y + (s.lift ?? 0), p.z, yaw);
      } else {
        // a loose flock: each one weaving round the shot's path on its own beat
        const a = t * 3.1 + i * 2.1;
        const side = Math.cos(yaw);
        const fwd = Math.sin(yaw);
        const off = (i - (flock - 1) / 2) * 0.9 + Math.sin(a) * 0.25;
        prop.aim(p.x + side * off + fwd * Math.sin(a * 0.7) * 0.4, y + 0.3 + Math.sin(a * 1.3) * 0.35 + (i % 2) * 0.3, p.z - fwd * off + side * Math.cos(a * 0.7) * 0.4, yaw + Math.sin(a) * 0.25);
      }
      if (s.spin) prop.mesh.rotation.x = -t * s.spin * Math.PI * 2;
      if (s.roll) prop.mesh.rotation.z = t * s.roll * Math.PI * 2;
    }
    fx.sigil?.follow(p.x, y, p.z);
    // a lash of lightning (or sand) from the caster's hand to the shot
    if (s.tether && fx.redrawn !== Math.floor(t / 0.05)) {
      const o = fx.owner;
      A.set(o.x, o.body.y + 1.5, o.z);
      fx.tether.clear();
      fx.tether.bolt(A, fx.at, s.tether, 0.12, 0.8, 3);
      fx.tether.values.fade = 0.9;
    }
    if (s.chain) {
      // each bounce leaves a kink the chain runs through
      if (p.dx * fx.lastDx + p.dz * fx.lastDz < 0.9) {
        fx.kinks.push(fx.at.clone());
        fx.lastDx = p.dx;
        fx.lastDz = p.dz;
      }
      if (fx.redrawn !== Math.floor(t / 0.05)) {
        const c = fx.chain;
        c.clear();
        const k = fx.kinks;
        for (let i = 0; i < k.length; i++) c.bolt(k[i]!, i + 1 < k.length ? k[i + 1]! : fx.at, 0.2, 0.2, 0.9, 3);
        c.values.fade = 0.85;
      }
    }
    fx.redrawn = Math.floor(t / 0.05);
  }

  private endShot(fx: ShotFx): void {
    const s = fx.look;
    // Mjolnir flies home to the hand that threw it
    if (s.returns && fx.owner.alive) {
      const o = fx.owner;
      const fl = this.fly(s.prop ?? 'hammer', fx.palette.vfx, s.size ?? 1, fx.at, B.set(o.x, o.body.y + 1.4, o.z), 0.32, 0.4, s.spin ?? 0);
      fl.home = o;
    }
    // the whole chain flashes once more as it finishes, then fades
    if (s.chain) {
      const k = fx.kinks;
      for (let i = 0; i < k.length; i++) this.bolt(fx.palette, k[i]!, i + 1 < k.length ? k[i + 1]! : fx.at, 0.26, 0.32, 0.24);
    }
    for (const p of fx.props) this.propPool.release(p);
    fx.props.length = 0;
    fx.sigil?.stop();
    fx.sigil = null;
    fx.tether.clear();
    fx.chain.clear();
    this.group.remove(fx.tether.group, fx.chain.group);
    this.shotPool.free.push(fx);
  }

  private syncZones(sim: Sim): void {
    const n = this.frameNo;
    for (const z of sim.zones) {
      const look = lookFor(z.cast.skill.id);
      const extra = look?.zone?.extra;
      if (!extra) continue;
      let fx = this.zoneFx.get(z.id);
      const fade = Math.min(1, z.age / 0.25) * Math.min(1, Math.max(0, (z.duration + 0.4 - z.age) / 0.6));
      const gy = this.ground(z.x, z.z);
      if (!fx) {
        const made: ZoneFx = { id: z.id, fx: [], move: [], seen: n };
        extra(this, { owner: z.owner, p: this.palette(look, z.owner), x: z.x, z: z.z, radius: z.radius, duration: z.duration - z.age, keep: (f, move) => { made.fx.push(f); made.move.push(move); } });
        this.zoneFx.set(z.id, (fx = made));
        this.zoneList.push(made);
      }
      fx.seen = n;
      for (let i = 0; i < fx.fx.length; i++) {
        const f = fx.fx[i]!;
        if (f.strength !== undefined) f.strength = fade;
        fx.move[i]!(z.x, gy, z.z);
      }
    }
    const l = this.zoneList;
    for (let i = l.length - 1; i >= 0; i--) {
      const fx = l[i]!;
      if (fx.seen === n) continue;
      l[i] = l[l.length - 1]!;
      l.pop();
      this.zoneFx.delete(fx.id);
      for (const f of fx.fx) f.stop?.();
    }
  }
}

export { UP };
