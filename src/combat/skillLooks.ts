import * as THREE from 'three/webgpu';
import type { ResolvedSkill } from '../game/combatant';
import type { FlashShape, Unit } from '../sim/Unit';
import type { GodPalette } from './palette';
import type { Beam, BeamOpts } from './skillFx/Beam';
import type { Funnel, FunnelOpts } from './skillFx/Funnel';
import type { Live } from './skillFx/pool';
import type { PropKind } from './skillFx/Props';
import type { Ribbon, RibbonOpts } from './skillFx/Ribbon';
import type { ShardKind } from './skillFx/Shards';
import type { Glyph, Sigil, SigilOpts } from './skillFx/Sigil';
import type { Swarm, SwarmOpts } from './skillFx/Swarm';

/*
 * Every skill's own look, keyed by skill id. The shared effects (CombatVfx)
 * still draw each shot's glowing orb and trail, each area's ground glow and
 * each shape's flash in the god's colors; a look adds what makes the skill
 * read as itself: Mjolnir spinning out and flying home, ravens, a tornado, a
 * ring of spears bursting up, a hand of the dead, a beam of death. A skill
 * without an entry keeps the shared look.
 *
 * Hooks run once per event (never every frame): `cast` when it is cast,
 * `flash` when its shape resolves (lines, cones, landings), `hit` on each
 * target it damages, `impact` where its shot or area strikes, and
 * `zone.extra` once when its lingering area appears. Each draws with the kit
 * below, whose pieces are pooled and prepared while loading.
 */

type Colors = Pick<GodPalette, 'vfx' | 'core'>;

/** What looks draw with (src/combat/skillFx/SkillFx.ts). */
export interface FxKit {
  readonly t: number;
  readonly units: readonly Unit[];
  ground(x: number, z: number): number;
  ribbon(o: RibbonOpts): Ribbon;
  beam(o: BeamOpts): Beam;
  funnel(o: FunnelOpts): Funnel;
  sigil(o: SigilOpts): Sigil;
  swarm(o: SwarmOpts): Swarm;
  shard(kind: ShardKind, x: number, z: number, yaw: number, size: number, delay: number, hold: number, glow: number, strength?: number): void;
  strike(p: Colors, x: number, z: number, opts?: { height?: number; width?: number; life?: number; forks?: number; spread?: number }): void;
  bolt(p: Colors, from: THREE.Vector3, to: THREE.Vector3, width?: number, life?: number, jag?: number): void;
  burst(p: GodPalette, x: number, y: number, z: number, power: number): void;
  cloud(color: number, x: number, y: number, z: number, power: number, swirl?: number): void;
  pillar(p: GodPalette, x: number, z: number, size: number, width: number): void;
  /** A glowing trail riding on a unit (through a dash or a leap). */
  comet(p: GodPalette, u: Unit, life: number, size: number, crackle?: boolean): void;
  /** Lightning crawling around a unit (or a point when `u` is null). */
  crackle(p: Colors, u: Unit, life: number, radius: number, height: number, every?: number, width?: number): void;
  fly(kind: PropKind, glow: number, size: number, from: THREE.Vector3, to: THREE.Vector3, time: number, arc?: number, spin?: number): { onLand: ((x: number, y: number, z: number) => void) | null };
  /** Keeps an effect on a unit for `life` seconds (or while `keep` holds), `dy` above its feet. */
  attach(fx: Live, u: Unit, dy: number, life: number, move: (x: number, y: number, z: number) => void, keep?: (u: Unit) => boolean): void;
  /** Living units of `team` within `r` of (x, z). */
  near(x: number, z: number, r: number, team: string, kind?: string): Unit[];
  /** Where a unit's skill shot is flying (null when none is). */
  shotOf(owner: Unit, skill: string): THREE.Vector3 | null;
}

export interface CastCtx {
  owner: Unit;
  p: GodPalette;
  /** Where it was aimed (the landing point of a leap, the ally of an ally skill). */
  x: number;
  z: number;
  yaw: number;
  cast: ResolvedSkill;
}

export interface FlashCtx {
  owner: Unit;
  p: GodPalette;
  shape: FlashShape;
}

export interface HitCtx {
  owner: Unit;
  p: GodPalette;
  target: Unit;
  amount: number;
}

export interface ImpactCtx {
  owner: Unit;
  p: GodPalette;
  x: number;
  z: number;
  big: boolean;
}

export interface ZoneCtx {
  owner: Unit;
  p: GodPalette;
  x: number;
  z: number;
  radius: number;
  /** Seconds left. */
  duration: number;
  /** Keeps an effect on the area: it moves with it and fades when the area does. */
  keep(fx: Live & { stop?(): void; strength?: number }, move: (x: number, y: number, z: number) => void): void;
}

/** How a skill shot looks in flight. */
export interface ShotLook {
  /** A solid thrown thing riding the shot. */
  prop?: PropKind;
  /** How many (a flock of ravens). */
  count?: number;
  size?: number;
  /** Turns a second end over end, and about its length. */
  spin?: number;
  roll?: number;
  /** Meters above the shot's usual height. */
  lift?: number;
  /** A glyph riding the shot, turning. */
  sigil?: Glyph;
  /** Size of the shared glowing orb (1 as is, 0 hides it), and of its trail. */
  orb?: number;
  trail?: number;
  /** Lightning crackling off it (lightning gods' shots do anyway). */
  crackle?: boolean;
  /** Width of a lash from the caster's hand to the shot. */
  tether?: number;
  /** Lightning chaining through every bounce. */
  chain?: boolean;
  /** Flies back to the caster when it is done. */
  returns?: boolean;
}

/** How a lingering area looks. */
export interface ZoneLook {
  /** Cloud color over the shared one (null: no cloud). */
  puff?: number | null;
  /** Meters the cloud is lifted (a storm overhead). */
  puffLift?: number;
  /** Strength of the shared ground glow (1 as is). */
  decal?: number;
  /** Whether a lightning god's area keeps striking at random. */
  strikes?: boolean;
  /** Whether motes rise through it. */
  motes?: boolean;
  extra?(k: FxKit, z: ZoneCtx): void;
}

export interface SkillLook {
  /** Colors over the god's own. */
  colors?: Colors;
  shot?: ShotLook;
  zone?: ZoneLook;
  /** Strength of the shared flash decal when its shape resolves (1 as is). */
  decal?: number;
  /** Lightning arcs over its flash shape (lightning gods' flashes have them). */
  flashArcs?: boolean;
  /** Strength of the shared burst where it impacts (1 as is, 0: none). */
  burst?: number;
  cast?(k: FxKit, c: CastCtx): void;
  flash?(k: FxKit, f: FlashCtx): void;
  hit?(k: FxKit, h: HitCtx): void;
  impact?(k: FxKit, i: ImpactCtx): void;
}

// ---------------------------------------------------------------------------
// Shared moves

const UP = new THREE.Vector3(0, 1, 0);
const NORTH = new THREE.Vector3(0, 0, -1);
const EAST = new THREE.Vector3(1, 0, 0);
const FWD = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const TILT = new THREE.Vector3();
const P1 = new THREE.Vector3();
const P2 = new THREE.Vector3();

const DEG = Math.PI / 180;

/** Forward and right on the ground for a yaw (0 faces -Z). */
function basis(yaw: number): void {
  FWD.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  RIGHT.set(Math.cos(yaw), 0, -Math.sin(yaw));
}

/** Where a shape's far end or focus lies, for its kind. */
function along(s: FlashShape, k: number): { x: number; z: number } {
  if (s.type === 'circle') return { x: s.x, z: s.z };
  const d = s.type === 'line' ? s.length * k : s.range * k;
  return { x: s.x - Math.sin(s.yaw) * d, z: s.z - Math.cos(s.yaw) * d };
}

const yawOf = (s: FlashShape) => (s.type === 'circle' ? 0 : s.yaw);

/** A blade's slash: a crescent sweeping across `angle` degrees in front, at chest height. */
function slash(k: FxKit, c: Colors, x: number, z: number, yaw: number, o: { radius: number; width: number; angle: number; y?: number; sweep?: number; life?: number; reverse?: boolean; tail?: number; delay?: number }): Ribbon {
  basis(yaw);
  const half = (o.angle * DEG) / 2;
  return k.ribbon({
    x, y: k.ground(x, z) + (o.y ?? 1.2), z, main: c.vfx, hot: c.core, ax: FWD, ay: RIGHT, an: UP,
    radius: o.radius, a0: o.reverse ? half : -half, span: o.reverse ? -2 * half : 2 * half, width: o.width,
    sweep: o.sweep ?? 0.13, tail: o.tail ?? 0.75, taper: 0.2, life: o.life ?? 0.42, delay: o.delay,
  });
}

/** An overhead blow: an arc in the upright plane through the facing, from behind the shoulder down to the ground in front. */
function swing(k: FxKit, c: Colors, x: number, z: number, yaw: number, o: { radius: number; width: number; y?: number; sweep?: number; life?: number }): Ribbon {
  basis(yaw);
  return k.ribbon({
    x, y: k.ground(x, z) + (o.y ?? 1.3), z, main: c.vfx, hot: c.core, ax: FWD, ay: UP, an: RIGHT,
    radius: o.radius, a0: 125 * DEG, span: -150 * DEG, width: o.width, sweep: o.sweep ?? 0.12, tail: 0.6, taper: 0.25, life: o.life ?? 0.4,
  });
}

/** A ring rolling out over the ground (`wall`: a standing band, a shout's wave). */
function shock(k: FxKit, c: Colors, x: number, z: number, from: number, to: number, o: { life?: number; width?: number; wall?: boolean; y?: number } = {}): Ribbon {
  return k.ribbon({
    x, y: k.ground(x, z) + (o.y ?? (o.wall ? 0.35 : 0.2)), z, main: c.vfx, hot: c.core, ax: NORTH, ay: EAST, an: UP,
    radius: from, radiusTo: to, a0: 0, span: Math.PI * 2, width: o.width ?? 0.9, wall: o.wall ? 1 : 0, sweep: 0, life: o.life ?? 0.5,
  });
}

/** Bands wound round a god and climbing (burial wraps, a swirl of smoke). */
function wrap(k: FxKit, c: Colors, u: Unit, life: number, o: { radius?: number; height?: number; turns?: number; width?: number; sweep?: number; spin?: number; taper?: number; hold?: boolean } = {}): void {
  const turns = o.turns ?? 3;
  const r = k.ribbon({
    x: u.x, y: u.body.y + 0.15, z: u.z, main: c.vfx, hot: c.core, ax: NORTH, ay: EAST, an: UP,
    radius: o.radius ?? u.radius + 0.25, a0: Math.random() * 6, span: turns * Math.PI * 2, width: o.width ?? 0.32, wall: 1,
    sweep: o.sweep ?? 0.3, tail: 1, taper: o.taper, lift: o.height ?? 2.1, life, spin: o.spin, hold: o.hold,
  });
  k.attach(r, u, 0.15, life, (x, y, z) => r.follow(x, y, z));
}

/** A spinning band round a god at `dy` (a hammer whirled at arm's length). */
function whirl(k: FxKit, c: Colors, x: number, y: number, z: number, o: { radius: number; width: number; spin: number; life: number }): Ribbon {
  return k.ribbon({
    x, y, z, main: c.vfx, hot: c.core, ax: NORTH, ay: EAST, an: UP,
    radius: o.radius, a0: 0, span: 1.6 * Math.PI, width: o.width, wall: 1, sweep: 0, tail: 1, taper: 0.15, spin: o.spin, life: o.life,
  });
}

/** Rocks bursting up in a ring, leaning out. */
function rockRing(k: FxKit, x: number, z: number, r: number, n: number, glow: number, o: { size?: number; hold?: number; delay?: number } = {}): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
    const rr = r * (0.8 + Math.random() * 0.35);
    // leaning away from the center (+Z of a shard points along its yaw)
    k.shard('rock', x + Math.sin(a) * rr, z + Math.cos(a) * rr, a, (o.size ?? 0.7) * (0.75 + Math.random() * 0.5), (o.delay ?? 0) + Math.random() * 0.05, o.hold ?? 0.55, glow);
  }
}

/** A lightning god's sparks crawling over a struck body. */
function zap(k: FxKit, c: Colors, u: Unit, n = 3, width = 0.08): void {
  for (let i = 0; i < n; i++) {
    const y = u.body.y + 0.5 + Math.random() * 1.6;
    const a = Math.random() * Math.PI * 2;
    P1.set(u.x + Math.sin(a) * 0.5, y, u.z + Math.cos(a) * 0.5);
    P2.set(u.x - Math.sin(a) * 0.6, y + (Math.random() - 0.3) * 0.8, u.z - Math.cos(a) * 0.6);
    k.bolt(c, P1, P2, width, 0.16, 0.35);
  }
}

/** Glyphs that read upright only (an eye, a sleeping moon, a heart). */
const STILL = new Set<Glyph>(['eye', 'moon', 'heart']);

/** A glyph floating over a god while `life` lasts (or while `keep` holds). */
function brand(k: FxKit, c: Colors, u: Unit, glyph: Glyph, life: number, size = 0.85, keep?: (u: Unit) => boolean): void {
  const dy = u.radius * 3.6 + 0.75;
  // a touch larger than asked: a brand has to read over a god from across a fight
  const s = k.sigil({ x: u.x, y: u.body.y + dy, z: u.z, glyph, size: size * 1.25, main: c.vfx, hot: c.core, life, spin: STILL.has(glyph) ? 0 : 0.15 });
  k.attach(s, u, dy, life, (x, y, z) => s.follow(x, y, z), keep);
}

/** The god nearest a point (an ally skill's target). */
function godAt(k: FxKit, x: number, z: number, team: string): Unit | null {
  let best: Unit | null = null;
  let bestD = 2.5;
  for (const u of k.units) {
    if (!u.alive || u.team !== team || (u.kind !== 'god' && u.kind !== 'dummy')) continue;
    const d = Math.hypot(u.x - x, u.z - z);
    if (d < bestD) {
      best = u;
      bestD = d;
    }
  }
  return best;
}

/** Point `d` meters ahead of a unit at height `h`. */
function ahead(out: THREE.Vector3, u: Unit, yaw: number, d: number, h: number): THREE.Vector3 {
  return out.set(u.x - Math.sin(yaw) * d, u.body.y + h, u.z - Math.cos(yaw) * d);
}

const LEFT = new THREE.Vector3();

/**
 * One beat of a pair of great wings at a god's shoulders: a feathered fan on
 * each side sweeping down from over the head, riding with the god. Seen from
 * behind (the camera's view of a dash) they spread across the screen.
 */
function wings(k: FxKit, c: Colors, u: Unit, yaw: number, o: WingOpts & { dy?: number }): void {
  basis(yaw);
  const dy = o.dy ?? 1.75;
  // a little behind the shoulders (numbers, not FWD: the follower runs after other looks reuse it)
  const bx = -FWD.x * 0.3;
  const bz = -FWD.z * 0.3;
  for (const r of wingsAt(k, c, u.x + bx, u.body.y + dy, u.z + bz, yaw, o)) k.attach(r, u, dy, o.life + (o.delay ?? 0), (x, y, z) => r.follow(x + bx, y, z + bz));
}

interface WingOpts {
  span: number;
  sweep?: number;
  life: number;
  delay?: number;
  hold?: boolean;
  /** Angle the beat starts from over the horizontal, and how far down it sweeps (degrees). */
  from?: number;
  arc?: number;
}

const WINGS: [Ribbon, Ribbon] = [null!, null!];

/** A pair of wing fans spreading left and right from a point, in the upright plane across `yaw`. */
function wingsAt(k: FxKit, c: Colors, x: number, y: number, z: number, yaw: number, o: WingOpts): readonly Ribbon[] {
  basis(yaw);
  LEFT.copy(RIGHT).negate();
  for (let i = 0; i < 2; i++) {
    WINGS[i] = k.ribbon({
      x, y, z, main: c.vfx, hot: c.core, ax: i === 0 ? RIGHT : LEFT, ay: UP, an: FWD,
      radius: 0.2 + o.span / 2, a0: (o.from ?? 80) * DEG, span: -(o.arc ?? 105) * DEG, width: o.span, sweep: o.sweep ?? 0.16, tail: 1, taper: 0.6,
      life: o.life, hold: o.hold, delay: o.delay,
    });
  }
  return WINGS;
}

/** Black feathers thrown off and drifting down. */
function feathers(k: FxKit, x: number, y: number, z: number, range: number, o: { size?: number; life?: number; count?: number } = {}): Swarm {
  return k.swarm({ x, y, z, mode: 'scatter', main: 0x14111c, hot: 0x5a7cc8, range, spread: 0, size: o.size ?? 0.22, life: o.life ?? 1.5, count: o.count ?? 0.45 });
}

/** A crescent and a Z over a god for as long as they sleep. */
function asleep(k: FxKit, u: Unit, life: number): void {
  if (u.combatant.cc.has('mesmerize')) brand(k, MOON, u, 'moon', life, 0.85, (t) => t.combatant.cc.has('mesmerize'));
}

// ---------------------------------------------------------------------------
// Colors a skill burns in when its god's own would not tell it apart

const GOLD_BOLT = { vfx: 0xffb42a, core: 0xfff3c4 };
const STORM = { vfx: 0x7fc8ff, core: 0xffffff };
const DAWN = { vfx: 0xffb84a, core: 0xfff4dc };
const FURY = { vfx: 0xff4a24, core: 0xffd0a0 };
const WELL = { vfx: 0x40c8ff, core: 0xe4fbff };
const RUNE = { vfx: 0xffcf5a, core: 0xfff7da };
const VENOM = { vfx: 0x9cff2a, core: 0xf2ffc8 };
const SHADOW = { vfx: 0x6a3cff, core: 0xe6dcff };
const CHAOS = { vfx: 0x46ff5a, core: 0xfff0a0 };
const SPIRIT = { vfx: 0x5af0d8, core: 0xe8fffa };
const LINEN = { vfx: 0xe9dcc0, core: 0xfff4d6 };
const DREAD = { vfx: 0xa070ff, core: 0xf0e6ff };
const GAZE = { vfx: 0xff5418, core: 0xfff0b0 };
const MAAT = { vfx: 0xffc23a, core: 0xfff6d4 };

const SMOKE = 0x3a4a3e;

// Thanatos: black wings, the cold fire of an upturned torch, night, poppies, an iron heart and sleep
const WING = { vfx: 0x1a1628, core: 0x4f7cc8 };
const BLADE = { vfx: 0x2a66ff, core: 0xd6eaff };
const COLD_FIRE = { vfx: 0x1ab4ff, core: 0xeafcff };
const NIGHT = { vfx: 0x4c3cc0, core: 0xd2caff };
const POPPY = { vfx: 0xe8243a, core: 0xffd4c4 };
const IRON = { vfx: 0x2c3646, core: 0x9cb6dc };
const HEART = { vfx: 0xff2414, core: 0xff9a6a };
const REST = { vfx: 0x6a3cff, core: 0xeee6ff };
const MOON = { vfx: 0x7a8aff, core: 0xeef0ff };
const LIFE = { vfx: 0x2ad8ff, core: 0xffffff };

// ---------------------------------------------------------------------------
// The looks

export const SKILL_LOOKS: Record<string, SkillLook> = {
  // ----- Zeus: blue storm light; each power a different kind of lightning -----

  'zeus.arc-bolt': {
    shot: { orb: 0.9, crackle: true, chain: true },
    burst: 0.6,
    hit: (k, h) => zap(k, h.p, h.target, 3),
  },
  'zeus.storm-step': {
    decal: 0.6,
    flash: (k, f) => {
      const s = f.shape;
      const end = along(s, 1);
      k.strike(f.p, end.x, end.z, { width: 0.55, height: 16, forks: 3 });
      shock(k, f.p, end.x, end.z, 0.3, 3, { life: 0.35, width: 0.5 });
    },
  },
  'zeus.thundering-presence': {
    decal: 0.7,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.random() * 0.3;
        k.strike(f.p, s.x + Math.sin(a) * s.radius * 0.85, s.z + Math.cos(a) * s.radius * 0.85, { width: 0.3, height: 12, forks: 2, spread: 1.5 });
      }
      shock(k, f.p, s.x, s.z, 0.5, s.radius * 1.15, { life: 0.4, width: 0.6, wall: true });
    },
    cast: (k, c) => k.crackle(c.p, c.owner, 4, 0.7, 2, 0.18),
  },
  'zeus.static-discharge': {
    // its circle covers the whole field: the strikes on each charged god show it instead
    decal: 0,
    flashArcs: false,
    flash: (k, f) => {
      const o = f.owner;
      shock(k, f.p, o.x, o.z, 0.5, 9, { life: 0.45, width: 0.7, wall: true });
      k.strike(f.p, o.x, o.z, { width: 0.5, height: 14, forks: 4, spread: 1 });
    },
    hit: (k, h) => {
      const t = h.target;
      k.strike(h.p, t.x, t.z, { width: 0.7, height: 22, forks: 4, spread: 1 });
      P1.set(h.owner.x, h.owner.body.y + 2, h.owner.z);
      P2.set(t.x, t.body.y + 1.3, t.z);
      k.bolt(h.p, P1, P2, 0.16, 0.25, 0.2);
      zap(k, h.p, t, 4, 0.1);
    },
  },
  'zeus.aegis-of-clouds': {
    colors: STORM,
    cast: (k, c) => {
      const u = c.owner;
      k.cloud(0xdbe6f0, u.x, u.body.y + 0.8, u.z, 1.3, 0.8);
      const f = k.funnel({ x: u.x, y: u.body.y, z: u.z, main: 0xc9d6e4, hot: 0xffffff, bottom: 1.05, top: 1.35, height: 2.6, twist: 2.6, density: 0.42, glow: 0.25, sway: 0.05, life: 4 });
      k.attach(f, u, 0, 4, (x, y, z) => f.move(x, y, z));
      k.crackle(c.p, u, 4, 1.1, 2.4, 0.3);
    },
  },
  'zeus.ball-lightning': {
    shot: { orb: 2.1, crackle: true, trail: 1.4 },
    burst: 0.5,
    hit: (k, h) => {
      // the orb lashes out at everyone near it as it rolls by
      const at = k.shotOf(h.owner, 'zeus.ball-lightning');
      if (at) k.bolt(h.p, at, P2.set(h.target.x, h.target.body.y + 1.2, h.target.z), 0.18, 0.2, 0.3);
      zap(k, h.p, h.target, 2);
    },
  },
  'zeus.wrath-mark': {
    colors: GOLD_BOLT,
    shot: { sigil: 'bolt', orb: 0.6, size: 1.1 },
    hit: (k, h) => {
      brand(k, h.p, h.target, 'bolt', 5, 0.9);
      k.strike(h.p, h.target.x, h.target.z, { width: 0.4, height: 10, forks: 2, spread: 0.5 });
    },
  },
  'zeus.cyclone': {
    zone: {
      strikes: false,
      decal: 0.7,
      motes: false,
      extra: (k, z) => {
        const f = k.funnel({ x: z.x, y: k.ground(z.x, z.z), z: z.z, main: 0xbfe0f4, hot: 0xffffff, bottom: 0.45, top: z.radius * 1.05, height: 7.5, twist: 7, density: 0.62, glow: 0.35, sway: 0.12, life: z.duration + 0.3 });
        z.keep(f, (x, y, zz) => f.move(x, y, zz));
        const s = k.swarm({ x: z.x, y: k.ground(z.x, z.z), z: z.z, mode: 'orbit', main: 0x8e8a7a, hot: 0xe8f6ff, range: z.radius * 0.9, spread: 6, size: 0.2, life: z.duration + 0.3, count: 0.7 });
        z.keep(s, (x, y, zz) => s.move(x, y, zz));
      },
    },
    impact: (k, i) => {
      // the funnel spits a bolt now and then as it pulls
      const r = 1.5 + Math.random() * 2;
      const a = Math.random() * Math.PI * 2;
      P1.set(i.x, k.ground(i.x, i.z) + 6.5, i.z);
      P2.set(i.x + Math.sin(a) * r, k.ground(i.x, i.z) + 0.3, i.z + Math.cos(a) * r);
      k.bolt(i.p, P1, P2, 0.2, 0.2, 0.25);
    },
    burst: 0.4,
  },
  'zeus.skyfall-storm': {
    zone: {
      strikes: false,
      puff: null,
      decal: 0.85,
      extra: (k, z) => {
        // a storm wheel turning overhead
        const f = k.funnel({ x: z.x, y: k.ground(z.x, z.z) + 9, z: z.z, main: 0x2c3646, hot: 0x9fd8ff, bottom: z.radius * 0.35, top: z.radius * 1.3, height: 3.2, twist: 1.4, density: 0.95, glow: 0.2, sway: 0.04, life: z.duration + 0.4, grow: 0.5 });
        z.keep(f, (x, y, zz) => f.move(x, y + 9, zz));
      },
    },
    burst: 0.8,
    impact: (k, i) => {
      // each of its five blows is three great bolts out of the wheel
      for (let n = 0; n < 3; n++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * 6;
        k.strike(i.p, i.x + Math.sin(a) * r, i.z + Math.cos(a) * r, { width: 0.75, height: 10, forks: 4, spread: 2.5, life: 0.28 });
      }
    },
  },
  'zeus.olympian-spear': {
    colors: STORM,
    decal: 0.55,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'line') return;
      const o = f.owner;
      const end = along(s, 1);
      const gy = k.ground(s.x, s.z);
      P1.set(s.x, gy + 1.7, s.z);
      P2.set(end.x, k.ground(end.x, end.z) + 1.4, end.z);
      k.beam({ from: P1, to: P2, width: 0.85, main: f.p.vfx, hot: f.p.core, reach: 0.2, hold: 0.25, fadeOut: 0.55, flow: 40 });
      k.beam({ from: P1, to: P2, width: 0.3, main: 0xffffff, hot: 0xffffff, reach: 0.2, hold: 0.1, fadeOut: 0.3, flow: 60 });
      k.fly('spearhead', f.p.vfx, 3.2, P1, P2, 0.2);
      // lightning racing along the shaft
      for (let i = 0; i < 4; i++) {
        const a = along(s, i / 4);
        const b = along(s, (i + 1) / 4);
        k.bolt(f.p, P1.set(a.x, k.ground(a.x, a.z) + 1.6, a.z), P2.set(b.x, k.ground(b.x, b.z) + 1.5, b.z), 0.3, 0.45, 0.1);
      }
      k.strike(f.p, end.x, end.z, { width: 0.6, height: 14 });
      k.burst(f.p, end.x, k.ground(end.x, end.z) + 1.2, end.z, 2);
      shock(k, f.p, o.x, o.z, 0.3, 2.4, { life: 0.3, width: 0.5 });
    },
    hit: (k, h) => zap(k, h.p, h.target, 4, 0.12),
  },
  'zeus.ascension': {
    zone: { strikes: false, puff: 0x343e4e, puffLift: 10, decal: 0.8 },
    cast: (k, c) => {
      const u = c.owner;
      k.strike(c.p, u.x, u.z, { width: 0.8, height: 24, forks: 4, spread: 0.5 });
      const f = k.funnel({ x: u.x, y: u.body.y, z: u.z, main: 0x5ac8ff, hot: 0xffffff, bottom: 0.9, top: 1.4, height: 16, twist: 4, density: 0.55, glow: 1.6, sway: 0, life: 4 });
      // the column lasts while he is in the air (it ends as he lands)
      let flew = false;
      k.attach(f, u, 0, 4, (x, y, z) => f.move(x, y, z), (g) => {
        if (g.forced) flew = true;
        return !flew || g.forced !== null;
      });
      shock(k, c.p, u.x, u.z, 0.5, 5, { life: 0.5, wall: true });
    },
    impact: (k, i) => k.strike(i.p, i.x, i.z, { width: 0.6, height: 20, forks: 3, spread: 1.5 }),
  },

  // ----- Thor: the hammer, the earth and the storm -----

  'thor.hammer-throw': {
    shot: { prop: 'hammer', size: 1.5, spin: 2.6, orb: 0.35, trail: 0.7, crackle: true, returns: true },
    burst: 0.8,
    hit: (k, h) => zap(k, h.p, h.target, 2),
  },
  'thor.tempest-leap': {
    decal: 0.7,
    cast: (k, c) => k.comet(c.p, c.owner, 0.9, 0.5, true),
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      shock(k, f.p, s.x, s.z, 0.4, s.radius * 1.25, { life: 0.45, width: 1.1 });
      rockRing(k, s.x, s.z, s.radius * 0.75, 8, f.p.vfx, { size: 0.6 });
      k.strike(f.p, s.x, s.z, { width: 0.5, height: 14, forks: 3, spread: 1 });
    },
  },
  'thor.mjolnir-slam': {
    decal: 0.55,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'cone') return;
      const o = f.owner;
      swing(k, f.p, o.x, o.z, s.yaw, { radius: 2.3, width: 1.1 });
      const hit = along(s, 0.7);
      for (let i = 0; i < 6; i++) {
        const a = s.yaw + (Math.random() - 0.5) * 1.6;
        const r = 0.4 + Math.random() * 1.6;
        k.shard('rock', hit.x - Math.sin(a) * r, hit.z - Math.cos(a) * r, a + Math.PI, 0.45 + Math.random() * 0.3, 0.08 + Math.random() * 0.04, 0.5, f.p.vfx);
      }
      k.strike(f.p, hit.x, hit.z, { width: 0.6, height: 12, forks: 3, spread: 0.5, life: 0.25 });
      shock(k, f.p, hit.x, hit.z, 0.3, 3.2, { life: 0.4, width: 0.8 });
      k.cloud(0xb8ab98, hit.x, k.ground(hit.x, hit.z) + 0.4, hit.z, 1.1);
    },
  },
  'thor.berserker-spin': {
    zone: {
      decal: 0.45,
      strikes: false,
      motes: false,
      extra: (k, z) => {
        const gy = k.ground(z.x, z.z);
        const a = whirl(k, z.p, z.x, gy + 0.9, z.z, { radius: z.radius * 0.8, width: 0.8, spin: 2.8, life: z.duration + 0.2 });
        const b = whirl(k, z.p, z.x, gy + 1.5, z.z, { radius: z.radius * 0.6, width: 0.35, spin: 3.4, life: z.duration + 0.2 });
        z.keep(a, (x, y, zz) => a.follow(x, y + 0.9, zz));
        z.keep(b, (x, y, zz) => b.follow(x, y + 1.5, zz));
      },
    },
    burst: 0.5,
  },
  'thor.lightning-dash': {
    cast: (k, c) => {
      const u = c.owner;
      k.comet(c.p, u, 0.5, 0.6, true);
      P1.set(u.x, u.body.y + 1.2, u.z);
      ahead(P2, u, c.yaw, 12.25, 1.2);
      k.beam({ from: P1, to: P2, width: 0.32, main: c.p.vfx, hot: c.p.core, reach: 0.44, hold: 0.08, fadeOut: 0.35, flow: 30 });
      k.crackle(c.p, u, 0.5, 0.7, 2, 0.04);
    },
  },
  'thor.thunder-guard': {
    cast: (k, c) => {
      const u = c.owner;
      shock(k, c.p, u.x, u.z, 0.4, 2.6, { life: 0.35, wall: true, width: 0.7 });
      k.crackle(c.p, u, 4, 1.15, 2.6, 0.09, 0.13);
      wrap(k, c.p, u, 4, { radius: u.radius + 0.55, height: 2.4, turns: 1.5, width: 0.16, sweep: 0.25, spin: 0.9, taper: 0.3, hold: true });
    },
  },
  'thor.call-of-asgard': {
    colors: FURY,
    cast: (k, c) => {
      const u = c.owner;
      shock(k, c.p, u.x, u.z, 0.5, 4.5, { life: 0.5, wall: true, width: 1 });
      shock(k, c.p, u.x, u.z, 0.3, 3, { life: 0.4 });
      const s = k.swarm({ x: u.x, y: u.body.y, z: u.z, mode: 'orbit', main: 0xff5a1e, hot: 0xffd08a, range: 1.1, spread: 2.9, size: 0.2, life: 5, count: 0.7 });
      k.attach(s, u, 0, 5, (x, y, z) => s.move(x, y, z));
      wrap(k, c.p, u, 5, { radius: u.radius + 0.6, height: 0.5, turns: 1, width: 0.22, sweep: 0.2, spin: -0.7, hold: true });
    },
  },
  'thor.storm-chain': {
    shot: { tether: 0.26, orb: 0.55, crackle: true },
    hit: (k, h) => {
      // the chain coils round the god's legs while they are held
      k.crackle(h.p, h.target, 1.2, 0.85, 0.7, 0.07, 0.14);
      zap(k, h.p, h.target, 3);
    },
  },
  'thor.anvil-of-dawn': {
    colors: DAWN,
    decal: 0.65,
    cast: (k, c) => {
      const u = c.owner;
      k.pillar(c.p, u.x, u.z, 0.8, 0.8);
      k.comet(c.p, u, 1.15, 0.8, true);
      // where it will land: a ring closing in until the blow
      k.ribbon({ x: c.x, y: k.ground(c.x, c.z) + 0.25, z: c.z, main: c.p.vfx, hot: c.p.core, ax: NORTH, ay: EAST, an: UP, radius: 11, radiusTo: 6.5, a0: 0, span: Math.PI * 2, width: 0.5, sweep: 0, life: 1.1 });
    },
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      shock(k, f.p, s.x, s.z, 0.5, s.radius * 1.5, { life: 0.6, width: 1.8 });
      shock(k, f.p, s.x, s.z, 0.5, s.radius * 1.05, { life: 0.5, wall: true, width: 1.4 });
      rockRing(k, s.x, s.z, s.radius * 0.7, 12, f.p.vfx, { size: 0.95, hold: 0.8 });
      k.strike(f.p, s.x, s.z, { width: 1.1, height: 30, forks: 5, spread: 0.5, life: 0.3 });
      k.pillar(f.p, s.x, s.z, 0.35, 2.4);
      k.cloud(0xc0ac90, s.x, k.ground(s.x, s.z) + 0.5, s.z, 2.4);
    },
  },
  'thor.worldbreaker': {
    decal: 0.45,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'line') return;
      const n = Math.round(s.length / 1.35);
      basis(s.yaw);
      for (let i = 0; i < n; i++) {
        const d = (i + 0.5) * (s.length / n);
        const side = (i % 2 ? 1 : -1) * (0.35 + Math.random() * 0.5) * s.width * 0.5;
        const x = s.x + FWD.x * d + RIGHT.x * side;
        const z = s.z + FWD.z * d + RIGHT.z * side;
        // the chips lean out from the split, front to back
        k.shard('rock', x, z, s.yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2) + (Math.random() - 0.5) * 0.6, 0.8 + Math.random() * 0.45, i * 0.02, 0.75, f.p.vfx);
      }
      // the glowing split itself, a seam of lightning on the ground
      P1.set(s.x, k.ground(s.x, s.z) + 0.08, s.z);
      const end = along(s, 1);
      P2.set(end.x, k.ground(end.x, end.z) + 0.08, end.z);
      k.beam({ from: P1, to: P2, width: 0.22, main: f.p.vfx, hot: f.p.core, reach: n * 0.02, hold: 0.6, fadeOut: 0.5, flow: 12 });
      for (let i = 0; i < 3; i++) {
        const a = along(s, i / 3);
        const b = along(s, (i + 1) / 3);
        k.bolt(f.p, P1.set(a.x, k.ground(a.x, a.z) + 0.3, a.z), P2.set(b.x, k.ground(b.x, b.z) + 0.3, b.z), 0.22, 0.4, 0.2);
      }
      const mid = along(s, 0.5);
      k.cloud(0xb8ab98, mid.x, k.ground(mid.x, mid.z) + 0.4, mid.z, 1.8);
    },
  },
  'thor.thunder-god': {
    cast: (k, c) => {
      const u = c.owner;
      k.strike(c.p, u.x, u.z, { width: 0.9, height: 26, forks: 5, spread: 0.4, life: 0.3 });
      shock(k, c.p, u.x, u.z, 0.5, 6, { life: 0.55, width: 1.3 });
      k.crackle(c.p, u, 8, 1.0, 2.7, 0.06, 0.15);
      wrap(k, c.p, u, 8, { radius: u.radius + 0.7, height: 3, turns: 2, width: 0.18, sweep: 0.35, spin: 1.1, taper: 0.25, hold: true });
      const s = k.swarm({ x: u.x, y: u.body.y, z: u.z, mode: 'orbit', main: 0x6aa8ff, hot: 0xffffff, range: 1.3, spread: 3.2, size: 0.17, life: 8, count: 0.7 });
      k.attach(s, u, 0, 8, (x, y, z) => s.move(x, y, z));
    },
  },

  // ----- Odin: gold, runes, ravens and the spear -----

  'odin.spear-thrust': {
    decal: 0.35,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'line') return;
      const end = along(s, 1);
      const gy = k.ground(s.x, s.z);
      P1.set(s.x, gy + 1.3, s.z);
      P2.set(end.x, k.ground(end.x, end.z) + 1.2, end.z);
      k.beam({ from: P1, to: P2, width: 0.42, main: f.p.vfx, hot: f.p.core, reach: 0.09, chase: 0.12, hold: 0.1, fadeOut: 0.3, flow: 24 });
      k.fly('spearhead', f.p.vfx, 1.8, P1, P2, 0.1);
      // a short twist of air where the spear leaves the hand
      slash(k, f.p, s.x, s.z, s.yaw, { radius: 1.1, angle: 70, width: 0.45, y: 1.25, sweep: 0.08, life: 0.3 });
      k.burst(f.p, end.x, P2.y, end.z, 0.7);
    },
  },
  'odin.ravens': {
    shot: { prop: 'raven', count: 3, size: 1.25, orb: 0.3, trail: 0.5 },
    burst: 0.5,
    cast: (k, c) => {
      const u = c.owner;
      k.swarm({ x: u.x, y: u.body.y + 1.6, z: u.z, mode: 'scatter', main: 0x18161e, hot: 0x6a5a90, range: 1.2, spread: 0, size: 0.17, life: 1.2, count: 0.3 });
    },
    hit: (k, h) => {
      const t = h.target;
      k.swarm({ x: t.x, y: t.body.y + 1, z: t.z, mode: 'scatter', main: 0x18161e, hot: 0x6a5a90, range: 1.6, spread: 0, size: 0.16, life: 1.3, count: 0.35 });
    },
  },
  'odin.war-cry': {
    colors: { vfx: 0xff9a2a, core: 0xfff0c8 },
    decal: 0.45,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      shock(k, f.p, s.x, s.z, 0.6, s.radius, { life: 0.55, wall: true, width: 1.1 });
      shock(k, f.p, s.x, s.z, 0.4, s.radius * 0.7, { life: 0.7, wall: true, width: 0.5 });
      for (const a of k.near(s.x, s.z, s.radius, f.owner.team)) brand(k, RUNE, a, 'tiwaz', 1.4, 0.7);
    },
  },
  'odin.lunge': {
    cast: (k, c) => {
      const u = c.owner;
      k.comet(c.p, u, 0.45, 0.45);
      P1.set(u.x, u.body.y + 1.2, u.z);
      ahead(P2, u, c.yaw, 10.5, 1.2);
      k.beam({ from: P1, to: P2, width: 0.22, main: c.p.vfx, hot: c.p.core, reach: 0.38, hold: 0.05, fadeOut: 0.3, flow: 20 });
    },
    hit: (k, h) => k.burst(h.p, h.target.x, h.target.body.y + 1.3, h.target.z, 0.8),
  },
  'odin.gungnir-sweep': {
    decal: 0.4,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'cone') return;
      slash(k, f.p, s.x, s.z, s.yaw, { radius: s.range * 0.6, width: s.range * 0.62, angle: s.angle + 15, sweep: 0.15 });
      slash(k, { vfx: f.p.core, core: 0xffffff }, s.x, s.z, s.yaw, { radius: s.range * 0.92, width: 0.22, angle: s.angle + 15, sweep: 0.15, y: 1.25 });
      const mid = along(s, 0.6);
      k.cloud(0xc8b89a, mid.x, k.ground(mid.x, mid.z) + 0.3, mid.z, 0.9);
    },
  },
  'odin.wisdom': {
    colors: WELL,
    cast: (k, c) => {
      const u = c.owner;
      shock(k, c.p, u.x, u.z, 0.3, 2.2, { life: 0.8, width: 0.7 });
      const f = k.funnel({ x: u.x, y: u.body.y, z: u.z, main: 0x40c8ff, hot: 0xe8fcff, bottom: 0.9, top: 0.45, height: 3, twist: 3, density: 0.5, glow: 1.2, sway: 0, life: 1.4 });
      k.attach(f, u, 0, 1.4, (x, y, z) => f.move(x, y, z));
      const s = k.swarm({ x: u.x, y: u.body.y, z: u.z, mode: 'orbit', main: 0x40c8ff, hot: 0xffffff, range: 1, spread: 2.6, size: 0.12, life: 2, count: 0.6 });
      k.attach(s, u, 0, 2, (x, y, z) => s.move(x, y, z));
    },
  },
  'odin.rune-ward': {
    colors: RUNE,
    decal: 0.6,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      k.sigil({ x: s.x, y: k.ground(s.x, s.z) + 0.15, z: s.z, glyph: 'algiz', size: Math.min(9, s.radius * 0.9), main: f.p.vfx, hot: f.p.core, life: 1.4, flat: true, spin: 0.05, open: 0.35 });
      for (const a of k.near(s.x, s.z, s.radius, f.owner.team)) brand(k, f.p, a, 'algiz', 1.8, 0.75);
    },
  },
  'odin.einherjar': {
    colors: RUNE,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      k.sigil({ x: s.x, y: k.ground(s.x, s.z) + 0.15, z: s.z, glyph: 'tiwaz', size: 4, main: f.p.vfx, hot: f.p.core, life: 1.6, flat: true, open: 0.3 });
      basis(yawOf(s) || f.owner.body.yaw);
      for (const side of [-1, 1]) k.pillar(f.p, s.x + RIGHT.x * side * 0.9, s.z + RIGHT.z * side * 0.9, 0.45, 0.55);
      shock(k, f.p, s.x, s.z, 0.3, s.radius + 0.8, { life: 0.5, wall: true, width: 0.9 });
      // the fallen rise: motes of rune light climbing out of the circle
      k.swarm({ x: s.x, y: k.ground(s.x, s.z), z: s.z, mode: 'orbit', main: f.p.vfx, hot: f.p.core, range: s.radius, spread: 3.2, size: 0.2, life: 1.8, count: 0.6 });
    },
  },
  'odin.ring-of-spears': {
    decal: 0.6,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      const n = Math.round(s.radius * 1.7);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        // each spear leans out a little, the ring rising round from one side
        k.shard('spear', s.x + Math.sin(a) * s.radius, s.z + Math.cos(a) * s.radius, a, 1.35 + Math.random() * 0.2, i * 0.012, 1.6, f.p.vfx);
      }
      shock(k, f.p, s.x, s.z, s.radius * 0.6, s.radius * 1.05, { life: 0.5, width: 0.6 });
    },
  },
  'odin.valhallas-call': {
    colors: { vfx: 0xffc84a, core: 0xfffbe6 },
    decal: 0.35,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      k.pillar(f.p, s.x, s.z, 0.75, 0.6);
      shock(k, f.p, s.x, s.z, 1, s.radius, { life: 0.9, wall: true, width: 1.4 });
      shock(k, f.p, s.x, s.z, 0.5, s.radius * 0.6, { life: 0.7, width: 1 });
      for (const a of k.near(s.x, s.z, s.radius, f.owner.team)) if (a !== f.owner) k.pillar(f.p, a.x, a.z, 0.45, 0.55);
    },
  },
  'odin.all-seeing-eye': {
    // its circle is the whole map: the eye over Odin and over every god it sees tell it
    decal: 0,
    flash: (k, f) => {
      const o = f.owner;
      const eye = k.sigil({ x: o.x, y: o.body.y + 5, z: o.z, glyph: 'eye', size: 3.4, main: f.p.vfx, hot: f.p.core, life: 2.2, open: 0.45, rise: 0.6 });
      k.attach(eye, o, 5, 2.2, (x, y, z) => eye.follow(x, y, z));
      shock(k, f.p, o.x, o.z, 0.5, 8, { life: 0.6, wall: true, width: 0.8 });
      for (const u of k.units) {
        if (u.team === o.team || u.kind !== 'god' || !u.alive) continue;
        brand(k, f.p, u, 'eye', 6, 0.9, (t) => t.marks.has('all-seeing'));
      }
    },
  },

  // ----- Loki: green smoke, poison and tricks -----

  'loki.dagger-fan': {
    decal: 0.25,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'cone') return;
      const o = f.owner;
      const gy = k.ground(s.x, s.z);
      for (let i = 0; i < 5; i++) {
        const yaw = s.yaw + ((i - 2) / 2) * (s.angle / 2) * DEG;
        P1.set(s.x - Math.sin(yaw) * 0.6, gy + 1.35, s.z - Math.cos(yaw) * 0.6);
        ahead(P2, o, yaw, s.range * 0.95, 1.25);
        k.fly('dagger', f.p.vfx, 2, P1, P2, 0.17 + i * 0.008);
        k.beam({ from: P1, to: P2, width: 0.08, main: f.p.vfx, hot: f.p.core, reach: 0.17, chase: 0.09, hold: 0, fadeOut: 0.16, flow: 30 });
      }
    },
  },
  'loki.vanish': {
    cast: (k, c) => {
      const u = c.owner;
      k.cloud(0x2c3830, u.x, u.body.y + 0.6, u.z, 1.8, 0.5);
      k.cloud(0x4a7a52, u.x, u.body.y + 1, u.z, 1.1, 0.3);
      k.swarm({ x: u.x, y: u.body.y + 1, z: u.z, mode: 'scatter', main: 0x3dff7a, hot: 0xdcffe2, range: 2.4, spread: 0, size: 0.1, life: 1.2, count: 0.5 });
    },
  },
  'loki.decoy': {
    decal: 0.5,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      k.cloud(0x3c5a44, s.x, k.ground(s.x, s.z) + 0.6, s.z, 1.4, 0.4);
      shock(k, f.p, s.x, s.z, 0.4, s.radius * 1.1, { life: 0.5, wall: true, width: 0.7 });
      const mock = k.sigil({ x: s.x, y: k.ground(s.x, s.z) + 3.4, z: s.z, glyph: 'eye', size: 1.1, main: f.p.vfx, hot: f.p.core, life: 1.4, open: 0.2 });
      void mock;
    },
  },
  'loki.poison-blade': {
    colors: VENOM,
    cast: (k, c) => {
      const u = c.owner;
      k.burst(c.p, u.x, u.body.y + 1.3, u.z, 0.9);
      const s = k.swarm({ x: u.x, y: u.body.y + 1.2, z: u.z, mode: 'drip', main: 0x7cff2a, hot: 0xeaffb0, range: 0.55, spread: 0, size: 0.11, life: 6, count: 0.35 });
      k.attach(s, u, 1.2, 6, (x, y, z) => s.move(x, y, z));
    },
    hit: (k, h) => k.burst(h.p, h.target.x, h.target.body.y + 1.2, h.target.z, 0.35),
  },
  'loki.backstab': {
    shot: { prop: 'dagger', size: 1.8, orb: 0.45, trail: 0.8 },
    cast: (k, c) => k.cloud(SMOKE, c.owner.x, c.owner.body.y + 0.8, c.owner.z, 1.1, 0.3),
    hit: (k, h) => {
      const t = h.target;
      k.cloud(SMOKE, t.x, t.body.y + 0.8, t.z, 1, 0.3);
      slash(k, h.p, t.x, t.z, h.owner.body.yaw + Math.PI, { radius: 0.9, width: 0.9, angle: 140, sweep: 0.1, life: 0.3 });
    },
  },
  'loki.tricksters-mark': {
    shot: { sigil: 'eye', orb: 0.45, size: 1 },
    hit: (k, h) => brand(k, h.p, h.target, 'eye', 6, 0.85),
  },
  'loki.smoke-bomb': {
    decal: 0.5,
    zone: { motes: false },
    cast: (k, c) => {
      const u = c.owner;
      P1.set(u.x, u.body.y + 1.6, u.z);
      P2.set(c.x, k.ground(c.x, c.z) + 0.3, c.z);
      k.fly('bomb', 0x7dff6a, 1.2, P1, P2, 0.4, 2.6, 1.5);
    },
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      k.cloud(0x56625a, s.x, k.ground(s.x, s.z) + 0.5, s.z, 2.6, 0.35);
      k.cloud(0x3a5a42, s.x, k.ground(s.x, s.z) + 0.8, s.z, 1.6, 0.2);
      k.burst(f.p, s.x, k.ground(s.x, s.z) + 0.6, s.z, 1.2);
      shock(k, f.p, s.x, s.z, 0.4, s.radius * 1.15, { life: 0.45, width: 0.8 });
    },
  },
  'loki.shapeshift': {
    cast: (k, c) => {
      const u = c.owner;
      k.cloud(0x3c6a48, u.x, u.body.y + 0.6, u.z, 1.2, 0.6);
      wrap(k, c.p, u, 0.7, { radius: u.radius + 0.5, height: 2.4, turns: 2, width: 0.55, sweep: 0.35 });
      k.swarm({ x: u.x, y: u.body.y + 0.8, z: u.z, mode: 'scatter', main: 0x3dff7a, hot: 0xffffff, range: 1.8, spread: 0, size: 0.09, life: 1, count: 0.45 });
    },
  },
  'loki.assassinate': {
    colors: SHADOW,
    shot: { prop: 'dagger', size: 2.4, orb: 0.55, trail: 1.1 },
    cast: (k, c) => k.cloud(0x241c34, c.owner.x, c.owner.body.y + 0.8, c.owner.z, 1.5, 0.5),
    hit: (k, h) => {
      const t = h.target;
      // two crossing cuts across the back
      basis(h.owner.body.yaw);
      for (const side of [-1, 1]) {
        TILT.copy(UP).multiplyScalar(0.7).addScaledVector(RIGHT, side * 0.7).normalize();
        k.ribbon({ x: t.x, y: t.body.y + 1.3, z: t.z, main: h.p.vfx, hot: h.p.core, ax: FWD, ay: TILT, an: P1.crossVectors(FWD, TILT).normalize(), radius: 1.1, a0: 1.9, span: -3.8, width: 0.55, sweep: 0.09 + (side > 0 ? 0.05 : 0), tail: 0.8, taper: 0.15, life: 0.4 });
      }
      k.cloud(0x241c34, t.x, t.body.y + 0.8, t.z, 1.3, 0.4);
      k.burst(h.p, t.x, t.body.y + 1.3, t.z, 1.6);
    },
  },
  'loki.mirror-legion': {
    colors: { vfx: 0x8affc8, core: 0xf0fff8 },
    zone: { decal: 0.3, motes: false },
    cast: (k, c) => {
      const u = c.owner;
      k.cloud(SMOKE, u.x, u.body.y + 0.7, u.z, 1.4, 0.4);
      for (const s of k.units) {
        if (s.kind !== 'summon' || s.owner !== u) continue;
        k.cloud(0x46705a, s.x, s.body.y + 0.7, s.z, 1, 0.4);
        k.burst(c.p, s.x, s.body.y + 1.3, s.z, 0.9);
      }
    },
  },
  'loki.ragnarok-rift': {
    colors: CHAOS,
    zone: {
      puff: 0x253622,
      decal: 1.15,
      extra: (k, z) => {
        // the world caving in: a dark vortex pulling down into the tear
        const f = k.funnel({ x: z.x, y: k.ground(z.x, z.z) - 0.3, z: z.z, main: 0x16301a, hot: 0x8aff5a, bottom: z.radius * 0.95, top: 0.6, height: 4.2, twist: -2.4, density: 0.8, glow: 0.9, sway: 0.03, life: z.duration + 0.4 });
        z.keep(f, (x, y, zz) => f.move(x, y - 0.3, zz));
        const s = k.swarm({ x: z.x, y: k.ground(z.x, z.z), z: z.z, mode: 'orbit', main: 0x5aff3a, hot: 0xffd060, range: z.radius * 0.8, spread: 4, size: 0.12, life: z.duration + 0.4, count: 0.8 });
        z.keep(s, (x, y, zz) => s.move(x, y, zz));
      },
    },
    impact: (k, i) => shock(k, i.p, i.x, i.z, 0.5, 7.5, { life: 0.5, width: 0.6 }),
    burst: 0.6,
  },

  // ----- Anubis: sand, the dead, and judgment -----

  'anubis.soul-shield': {
    colors: SPIRIT,
    cast: (k, c) => {
      const u = c.owner;
      const a = godAt(k, c.x, c.z, u.team) ?? u;
      if (a !== u) {
        P1.set(u.x, u.body.y + 1.6, u.z);
        P2.set(a.x, a.body.y + 1.4, a.z);
        k.beam({ from: P1, to: P2, width: 0.18, main: c.p.vfx, hot: c.p.core, reach: 0.14, hold: 0.1, fadeOut: 0.4, flow: 10 });
      }
      brand(k, c.p, a, 'ankh', 4, 0.8, (t) => t.combatant.shieldTotal > 0.5);
      k.burst(c.p, a.x, a.body.y + 1.3, a.z, 0.9);
      shock(k, c.p, a.x, a.z, 0.3, 1.6, { life: 0.5, wall: true, width: 1.4 });
    },
  },
  'anubis.locust-swarm': {
    decal: 0.3,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'cone') return;
      k.swarm({ x: s.x, y: k.ground(s.x, s.z), z: s.z, yaw: s.yaw, mode: 'stream', main: 0x2a2010, hot: 0xffb040, range: s.range, spread: Math.tan((s.angle / 2) * DEG), size: 0.36, life: 2.6, bugs: true });
      // the dust they raise, drifting down the cone
      const g = k.ground(s.x, s.z);
      for (let i = 1; i <= 3; i++) {
        const d = (s.range * i) / 4;
        k.cloud(0xc8a060, s.x - Math.sin(s.yaw) * d, g + 0.4, s.z - Math.cos(s.yaw) * d, 0.55 + i * 0.15, 0.4);
      }
    },
  },
  'anubis.mummify': {
    colors: LINEN,
    decal: 0.35,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'line') return;
      const end = along(s, 1);
      P1.set(s.x, k.ground(s.x, s.z) + 1.4, s.z);
      P2.set(end.x, k.ground(end.x, end.z) + 1.3, end.z);
      k.beam({ from: P1, to: P2, width: 0.6, main: f.p.vfx, hot: 0xffc23a, reach: 0.18, chase: 0.16, hold: 0.12, fadeOut: 0.3, flow: 6, wraps: true });
    },
    hit: (k, h) => wrap(k, { vfx: LINEN.vfx, core: 0xffc23a }, h.target, 1.3, { turns: 4, width: 0.42, sweep: 0.3 }),
  },
  'anubis.scales-of-maat': {
    colors: MAAT,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      const gy = k.ground(s.x, s.z);
      k.sigil({ x: s.x, y: gy + 0.15, z: s.z, glyph: 'scales', size: s.radius * 1.7, main: f.p.vfx, hot: f.p.core, life: 1.3, flat: true, open: 0.3 });
      k.sigil({ x: s.x, y: gy + 3.6, z: s.z, glyph: 'scales', size: 1.7, main: f.p.vfx, hot: f.p.core, life: 1.4, rise: 0.5 });
      k.swarm({ x: s.x, y: gy, z: s.z, mode: 'orbit', main: 0xffc23a, hot: 0xffffff, range: s.radius * 0.8, spread: 3, size: 0.12, life: 1.4, count: 0.6 });
    },
  },
  'anubis.grave-grasp': {
    colors: { vfx: 0xffa040, core: 0xfff0d0 },
    shot: { prop: 'claw', size: 2.1, orb: 0.4, trail: 0.8, tether: 0.22 },
    hit: (k, h) => k.cloud(0xd9b072, h.target.x, h.target.body.y + 0.5, h.target.z, 1, 1),
  },
  'anubis.sand-step': {
    cast: (k, c) => {
      const u = c.owner;
      k.cloud(0xd9b072, u.x, u.body.y + 0.4, u.z, 1.2, 1);
      k.comet(c.p, u, 0.42, 0.5);
      P1.set(u.x, u.body.y + 0.4, u.z);
      ahead(P2, u, c.yaw, 10.5, 0.4);
      k.beam({ from: P1, to: P2, width: 0.4, main: 0xe0b77e, hot: 0xfff0c8, reach: 0.38, hold: 0.1, fadeOut: 0.5, flow: 12 });
    },
  },
  'anubis.jackal-howl': {
    colors: DREAD,
    decal: 0.3,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'cone') return;
      basis(s.yaw);
      const half = (s.angle * DEG) / 2;
      const gy = k.ground(s.x, s.z);
      for (let i = 0; i < 3; i++) {
        k.ribbon({ x: s.x, y: gy + 0.9 + i * 0.25, z: s.z, main: f.p.vfx, hot: f.p.core, ax: FWD, ay: RIGHT, an: UP, radius: 0.6 + i * 0.2, radiusTo: s.range * (0.85 + i * 0.12), a0: -half, span: 2 * half, width: 1.1 - i * 0.2, wall: 1, sweep: 0, life: 0.45 + i * 0.15 });
      }
    },
  },
  'anubis.embalm': {
    colors: LINEN,
    cast: (k, c) => {
      const u = c.owner;
      const a = godAt(k, c.x, c.z, u.team) ?? u;
      wrap(k, { vfx: LINEN.vfx, core: 0xffc23a }, a, 1.8, { turns: 3, width: 0.5, sweep: 0.5, hold: true });
      const s = k.swarm({ x: a.x, y: a.body.y, z: a.z, mode: 'orbit', main: 0xffc23a, hot: 0xfff0c0, range: 1, spread: 2.6, size: 0.16, life: 4, count: 0.5 });
      k.attach(s, a, 0, 4, (x, y, z) => s.move(x, y, z));
    },
  },
  'anubis.death-gaze': {
    colors: GAZE,
    decal: 0.3,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'line') return;
      const o = f.owner;
      const len = s.length;
      const yaw = s.yaw;
      const place = (b: Beam, h: number) => (x: number, y: number, z: number) => {
        P1.set(x - Math.sin(yaw) * 0.5, y + h, z - Math.cos(yaw) * 0.5);
        P2.set(x - Math.sin(yaw) * len, y + h - 0.3, z - Math.cos(yaw) * len);
        b.place(P1, P2);
      };
      const end = along(s, 1);
      P1.set(s.x, k.ground(s.x, s.z) + 2, s.z);
      P2.set(end.x, k.ground(end.x, end.z) + 1.7, end.z);
      // a three second channel: the beam stays on the god's eyes as they move
      const outer = k.beam({ from: P1, to: P2, width: 0.95, main: f.p.vfx, hot: f.p.core, reach: 0.12, hold: 2.9, fadeOut: 0.35, flow: 16 });
      const inner = k.beam({ from: P1, to: P2, width: 0.32, main: 0xffe0a0, hot: 0xffffff, reach: 0.12, hold: 2.9, fadeOut: 0.3, flow: 24 });
      k.attach(outer, o, 0, 3.2, place(outer, 2));
      k.attach(inner, o, 0, 3.2, place(inner, 2));
      const sw = k.swarm({ x: end.x, y: k.ground(end.x, end.z) + 1, z: end.z, mode: 'orbit', main: 0xff7a1a, hot: 0xffe0a0, range: 1.4, spread: 1.5, size: 0.14, life: 3, count: 0.5 });
      void sw;
    },
    hit: (k, h) => k.burst(h.p, h.target.x, h.target.body.y + 1.4, h.target.z, 0.5),
  },
  'anubis.sandstorm': {
    zone: {
      decal: 0.45,
      motes: false,
      extra: (k, z) => {
        const f = k.funnel({ x: z.x, y: k.ground(z.x, z.z), z: z.z, main: 0xd2a868, hot: 0xfff0c8, bottom: z.radius * 0.95, top: z.radius * 1.2, height: 6, twist: 1.7, density: 0.6, glow: 0.05, sway: 0.06, life: z.duration + 0.4, grow: 0.6 });
        z.keep(f, (x, y, zz) => f.move(x, y, zz));
        const s = k.swarm({ x: z.x, y: k.ground(z.x, z.z), z: z.z, mode: 'orbit', main: 0x9a7a4a, hot: 0xfff0c8, range: z.radius, spread: 4.5, size: 0.22, life: z.duration + 0.4 });
        z.keep(s, (x, y, zz) => s.move(x, y, zz));
      },
    },
  },
  'anubis.judgment': {
    colors: { vfx: 0xffc23a, core: 0xfff8e0 },
    decal: 0.35,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      const o = f.owner;
      const ankh = k.sigil({ x: o.x, y: o.body.y + 5.2, z: o.z, glyph: 'ankh', size: 3.8, main: f.p.vfx, hot: f.p.core, life: 2.4, rise: 1.2, open: 0.5 });
      k.attach(ankh, o, 5.2, 2.4, (x, y, z) => ankh.follow(x, y, z));
      shock(k, f.p, s.x, s.z, 1, s.radius, { life: 0.9, wall: true, width: 1.5 });
      for (const a of k.near(s.x, s.z, s.radius, o.team)) {
        k.pillar(SPIRIT_PALETTE(f.p), a.x, a.z, 0.45, 0.55);
        brand(k, f.p, a, 'ankh', 5, 0.75, (t) => t.combatant.shieldTotal > 0.5);
      }
    },
  },

  // ----- Thanatos: the gentle death; black wings, cold fire, poppies and sleep -----

  'thanatos.pitiless-edge': {
    decal: 0.35,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'cone') return;
      // two sweeps of the leaf blade, the second back the other way as the second hit lands
      for (let i = 0; i < 2; i++) {
        const o = { angle: s.angle + 10, sweep: 0.1, life: 0.34, reverse: i === 1, y: 1.3 - i * 0.25, delay: i * 0.3 };
        slash(k, BLADE, s.x, s.z, s.yaw, { ...o, radius: s.range * 0.5, width: s.range * 0.55 });
        slash(k, { vfx: BLADE.core, core: 0xffffff }, s.x, s.z, s.yaw, { ...o, radius: s.range * 0.8, width: 0.26, y: o.y + 0.05 });
      }
    },
    hit: (k, h) => k.burst({ ...h.p, ...BLADE }, h.target.x, h.target.body.y + 1.2, h.target.z, 0.45),
  },
  'thanatos.snuff-out': {
    colors: COLD_FIRE,
    decal: 0.7,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'line') return;
      const end = along(s, 1);
      const gy = k.ground(s.x, s.z);
      // the torch driven down, and its cold fire running out along the ground
      P1.set(s.x - Math.sin(s.yaw) * 0.9, gy + 0.25, s.z - Math.cos(s.yaw) * 0.9);
      P2.set(end.x, k.ground(end.x, end.z) + 0.25, end.z);
      k.beam({ from: P1, to: P2, width: 1.1, main: f.p.vfx, hot: f.p.core, reach: 0.3, hold: 0.4, fadeOut: 0.5, flow: 16 });
      k.beam({ from: P1, to: P2, width: 0.36, main: 0xbaf0ff, hot: 0xffffff, reach: 0.3, hold: 0.3, fadeOut: 0.4, flow: 24 });
      k.swarm({ x: P1.x, y: P1.y - 0.4, z: P1.z, yaw: s.yaw, mode: 'stream', main: f.p.vfx, hot: f.p.core, range: s.length, spread: 0.08, size: 0.42, life: 1.1, count: 1 });
      shock(k, f.p, P1.x, P1.z, 0.3, 1.6, { life: 0.3, width: 0.5 });
      k.burst(f.p, end.x, P2.y + 0.4, end.z, 0.6);
    },
    hit: (k, h) => {
      // cold flames licking round the silenced god while it lasts
      const t = h.target;
      const s = k.swarm({ x: t.x, y: t.body.y, z: t.z, mode: 'orbit', main: h.p.vfx, hot: h.p.core, range: 0.6, spread: 2.3, size: 0.2, life: 1.1, count: 0.55 });
      k.attach(s, t, 0, 1.1, (x, y, z) => s.move(x, y, z));
    },
  },
  'thanatos.wingbeat': {
    cast: (k, c) => {
      const u = c.owner;
      wings(k, WING, u, c.yaw, { span: 2.1, sweep: 0.14, life: 0.55 });
      k.comet(c.p, u, 0.45, 0.45);
      feathers(k, u.x, u.body.y + 1.6, u.z, 1.8, { count: 0.4 });
      // the gust of the beat, rushing ahead along the path
      P1.set(u.x, u.body.y + 1.1, u.z);
      ahead(P2, u, c.yaw, 12.25, 1.1);
      k.beam({ from: P1, to: P2, width: 0.3, main: 0x8eb8ff, hot: 0xffffff, reach: 0.42, hold: 0.04, fadeOut: 0.3, flow: 26 });
    },
    hit: (k, h) => {
      const t = h.target;
      feathers(k, t.x, t.body.y + 1.2, t.z, 1.2, { count: 0.25, life: 1.1, size: 0.18 });
      k.burst(h.p, t.x, t.body.y + 1.2, t.z, 0.45);
    },
  },
  'thanatos.claim': {
    colors: NIGHT,
    shot: { tether: 0.28, orb: 0.55, trail: 0.9 },
    hit: (k, h) => {
      const t = h.target;
      const o = h.owner;
      // the ribbon winds round them and reels them in to his side
      wrap(k, h.p, t, 0.8, { turns: 2.5, width: 0.34, sweep: 0.2 });
      const b = k.beam({ from: P1.set(o.x, o.body.y + 1.4, o.z), to: P2.set(t.x, t.body.y + 1.2, t.z), width: 0.24, main: h.p.vfx, hot: h.p.core, reach: 0, hold: 0.4, fadeOut: 0.25, flow: -14 });
      k.attach(b, t, 0, 0.65, (x, y, z) => b.place(P1.set(o.x, o.body.y + 1.4, o.z), P2.set(x, y + 1.2, z)));
    },
  },
  'thanatos.veil-of-night': {
    colors: NIGHT,
    cast: (k, c) => {
      const u = c.owner;
      // the wings fold round him and he is gone into his mother's dark
      k.cloud(0x1a1630, u.x, u.body.y + 0.8, u.z, 1.7, 0.6);
      wrap(k, WING, u, 0.8, { radius: u.radius + 0.4, height: 2.5, turns: 1.2, width: 0.95, sweep: 0.28, taper: 0.5 });
      feathers(k, u.x, u.body.y + 1.3, u.z, 2.2, { count: 0.5 });
      k.swarm({ x: u.x, y: u.body.y + 1.2, z: u.z, mode: 'scatter', main: c.p.vfx, hot: 0xffffff, range: 2.6, spread: 0, size: 0.1, life: 1.2, count: 0.35 });
    },
  },
  'thanatos.poppy-haze': {
    colors: POPPY,
    zone: {
      puff: 0xc05064,
      decal: 0.6,
      motes: false,
      extra: (k, z) => {
        const gy = k.ground(z.x, z.z);
        // the poppies scattered as it lands, then petals drifting round the haze
        k.swarm({ x: z.x, y: gy + 2.2, z: z.z, mode: 'scatter', main: 0xd81428, hot: 0xffa08a, range: z.radius * 0.8, spread: 0, size: 0.3, life: 1.6, count: 0.8 });
        const s = k.swarm({ x: z.x, y: gy, z: z.z, mode: 'orbit', main: 0xd01830, hot: 0xff9a7a, range: z.radius * 0.95, spread: 1.8, size: 0.3, life: z.duration + 0.3, count: 0.9, rate: 0.18 });
        z.keep(s, (x, y, zz) => s.move(x, y, zz));
      },
    },
  },
  'thanatos.iron-heart': {
    colors: IRON,
    cast: (k, c) => {
      const u = c.owner;
      shock(k, c.p, u.x, u.z, 0.4, 2.4, { life: 0.35, wall: true, width: 0.8 });
      // two iron hoops turning opposite ways about the chest, and the heart over him while the shield holds
      for (let i = 0; i < 2; i++) {
        const dy = 0.95 + i * 0.6;
        const r = k.ribbon({
          x: u.x, y: u.body.y + dy, z: u.z, main: c.p.vfx, hot: c.p.core, ax: NORTH, ay: EAST, an: UP,
          radius: u.radius + 0.5 - i * 0.08, a0: i * 2, span: 1.6 * Math.PI, width: 0.3, wall: 1, sweep: 0.2, tail: 1, taper: 0.3, spin: i === 0 ? 0.7 : -0.9, life: 4, hold: true,
        });
        k.attach(r, u, dy, 4, (x, y, z) => r.follow(x, y, z), (t) => t.combatant.shieldTotal > 0.5);
      }
      brand(k, HEART, u, 'heart', 4, 0.9, (t) => t.combatant.shieldTotal > 0.5);
      k.burst({ ...c.p, ...HEART }, u.x, u.body.y + 1.4, u.z, 0.6);
    },
  },
  'thanatos.final-rest': {
    colors: REST,
    decal: 0.35,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'cone') return;
      // one slow, merciful cut
      slash(k, f.p, s.x, s.z, s.yaw, { radius: s.range * 0.5, width: s.range * 0.6, angle: s.angle + 12, sweep: 0.26, life: 0.65, y: 1.25, tail: 0.9 });
      slash(k, { vfx: f.p.core, core: 0xffffff }, s.x, s.z, s.yaw, { radius: s.range * 0.82, width: 0.28, angle: s.angle + 12, sweep: 0.26, life: 0.65, y: 1.3, tail: 0.9 });
    },
    hit: (k, h) => {
      const t = h.target;
      k.burst(h.p, t.x, t.body.y + 1.3, t.z, 0.6);
      asleep(k, t, 2);
    },
  },
  'thanatos.long-sleep': {
    colors: NIGHT,
    decal: 0.5,
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      const gy = k.ground(s.x, s.z);
      // great wings spreading over the field from beyond it (behind the sleepers, as he sees them),
      // feathers falling, and the seal of sleep on the ground
      const yaw = Math.atan2(f.owner.x - s.x, f.owner.z - s.z);
      const back = s.radius * 0.75;
      wingsAt(k, WING, s.x - Math.sin(yaw) * back, gy + 0.6, s.z - Math.cos(yaw) * back, yaw, { span: s.radius * 0.9, sweep: 0.4, life: 1.8, hold: true, from: 88, arc: 80 });
      feathers(k, s.x, gy + 2.6, s.z, s.radius * 0.85, { size: 0.34, life: 2.2, count: 0.8 });
      k.sigil({ x: s.x, y: gy + 0.15, z: s.z, glyph: 'moon', size: s.radius * 1.5, main: f.p.vfx, hot: f.p.core, life: 2.2, flat: true, open: 0.4 });
      shock(k, f.p, s.x, s.z, 0.6, s.radius * 1.05, { life: 0.6, wall: true, width: 1.2 });
    },
    hit: (k, h) => asleep(k, h.target, 3),
  },
  'thanatos.kiss-of-death': {
    cast: (k, c) => {
      const u = c.owner;
      wings(k, WING, u, c.yaw, { span: 2.8, sweep: 0.12, life: 0.75, hold: true });
      k.comet(c.p, u, 0.65, 0.7);
      feathers(k, u.x, u.body.y + 1.6, u.z, 2.4, { count: 0.6, size: 0.26 });
      P1.set(u.x, u.body.y + 1.3, u.z);
      ahead(P2, u, c.yaw, 17.5, 1.3);
      k.beam({ from: P1, to: P2, width: 0.5, main: 0x2a2250, hot: c.p.vfx, reach: 0.6, hold: 0.06, fadeOut: 0.4, flow: 30 });
    },
    hit: (k, h) => {
      const t = h.target;
      const o = h.owner;
      // a cut as he passes, and their life drawn out of them into him
      slash(k, h.p, t.x, t.z, o.body.yaw + Math.PI, { radius: 1, width: 1, angle: 150, sweep: 0.09, life: 0.32, y: 1.4 });
      const b = k.beam({ from: P1.set(t.x, t.body.y + 1.3, t.z), to: P2.set(o.x, o.body.y + 1.3, o.z), width: 0.18, main: LIFE.vfx, hot: LIFE.core, reach: 0.2, hold: 0.35, fadeOut: 0.35, flow: 18 });
      k.attach(b, t, 0, 0.9, (x, y, z) => b.place(P1.set(x, y + 1.3, z), P2.set(o.x, o.body.y + 1.3, o.z)));
      feathers(k, t.x, t.body.y + 1.3, t.z, 1.4, { count: 0.3, life: 1.2 });
      k.burst(h.p, t.x, t.body.y + 1.3, t.z, 1.1);
    },
  },
  'thanatos.carried-home': {
    decal: 0.5,
    burst: 0.5,
    cast: (k, c) => {
      const u = c.owner;
      // two slow beats of the wings through the flight
      wings(k, WING, u, c.yaw, { span: 2.6, sweep: 0.22, life: 0.5 });
      wings(k, WING, u, c.yaw, { span: 2.6, sweep: 0.22, life: 0.55, delay: 0.45 });
      k.comet(c.p, u, 1, 0.5);
    },
    flash: (k, f) => {
      const s = f.shape;
      if (s.type !== 'circle') return;
      const o = f.owner;
      const gy = k.ground(s.x, s.z);
      shock(k, f.p, s.x, s.z, 0.6, s.radius, { life: 0.6, wall: true, width: 1.2 });
      feathers(k, s.x, gy + 3.5, s.z, s.radius * 0.55, { size: 0.28, life: 1.9, count: 0.7 });
      for (const a of k.near(s.x, s.z, s.radius, o.team)) {
        k.pillar(f.p, a.x, a.z, 0.45, 0.55);
        wrap(k, f.p, a, 2.5, { radius: a.radius + 0.5, height: 2.2, turns: 1.5, width: 0.16, sweep: 0.3, spin: 0.8, taper: 0.3, hold: true });
      }
    },
  },
};

/** Judgment's columns: the spirit teal over the gold. */
function SPIRIT_PALETTE(p: GodPalette): GodPalette {
  return { ...p, ...SPIRIT };
}

export function lookFor(skill: string | undefined): SkillLook | undefined {
  return skill === undefined ? undefined : SKILL_LOOKS[skill];
}

export { UP as LOOK_UP, along, yawOf };
