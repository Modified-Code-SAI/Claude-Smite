import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GodModel } from './GodModel';
import { JOTUNN } from '../sim/Jotunn';
import { abs, attribute, color, float, mix, mx_noise_float, normalView, positionLocal, positionView, pow, saturate, sin, smoothstep, time, uniform } from '../render/tsl';

/** How much larger than its model (built at a god's height) the Jötunn is drawn. */
export const GIANT_SCALE = 8;

/** What the giant is winding up: each has its own motion, timed to land as the attack does. */
export type GiantAct = 'club' | 'stomp' | 'boulder' | 'slam' | 'roar' | 'breath' | 'avalanche' | 'hail';

/** The motion for each attack (the sim's warning flash names the skill, 'basic' for the club). */
export const GIANT_ACTS: Record<string, GiantAct> = {
  basic: 'club',
  'jotunn.stomp': 'stomp',
  'jotunn.boulder': 'boulder',
  'jotunn.slam': 'slam',
  'jotunn.roar': 'roar',
  'jotunn.frost-breath': 'breath',
  'jotunn.avalanche': 'avalanche',
  'jotunn.hailstorm': 'hail',
};

export type GiantPart = 'kneeL' | 'kneeR' | 'rune' | 'wristL' | 'wristR' | 'crown';
const PART_LIST: GiantPart[] = ['kneeL', 'kneeR', 'rune', 'wristL', 'wristR', 'crown'];

/** What the giant is doing this frame, from the sim. */
export interface GiantState {
  /** Ground speed, m/s, and its direction relative to facing (x right, y forward). */
  speed: number;
  localDir: THREE.Vector2;
  /** The attack winding up: which, seconds until it lands, and the ground it strikes (world). */
  windup: { act: GiantAct; left: number; at: THREE.Vector3 } | null;
  /** Down on both knees (both knees broken). */
  kneel: boolean;
  /** A fist planted after a slam, and where (world). */
  plant: { hand: 'L' | 'R'; at: THREE.Vector3 } | null;
  /** The back rune just broke: it can't cast for a moment. */
  silenced: boolean;
  /** A wrist just broke. */
  staggered: 'L' | 'R' | null;
  dead: boolean;
}

/** One weak point, from its sim unit. */
export interface GiantPartState {
  alive: boolean;
  /** Can be struck right now. */
  exposed: boolean;
  /** 0..1 */
  health: number;
}

// ---------------------------------------------------------------------------
// Motion: keyframed pose layers on top of the walk and idle clips.
//
// A channel is a bone and a model-space axis (+Y up, +Z forward, the giant's
// right hand toward -X): 'spine3.x' bends the chest forward, 'armR.z' < 0
// raises the right arm out to the side, 'armR.x' < 0 swings it forward,
// 'shinR.x' > 0 bends the knee. 'drop' lowers the body (model meters).
// Keys are seconds from the moment the blow lands (negative while winding up)
// and are authored for the right hand; left-handed moves are mirrored.

const BONES: Record<string, string> = {
  hips: 'DEF-hips', spine1: 'DEF-spine.001', spine2: 'DEF-spine.002', spine3: 'DEF-spine.003', neck: 'DEF-neck', head: 'DEF-head',
  armL: 'DEF-upper_arm.L', armR: 'DEF-upper_arm.R', foreL: 'DEF-forearm.L', foreR: 'DEF-forearm.R', handL: 'DEF-hand.L', handR: 'DEF-hand.R',
  thighL: 'DEF-thigh.L', thighR: 'DEF-thigh.R', shinL: 'DEF-shin.L', shinR: 'DEF-shin.R', footL: 'DEF-foot.L', footR: 'DEF-foot.R',
};
/** Parents before children, so each rotation sees its parent's. */
const ORDER = ['hips', 'spine1', 'spine2', 'spine3', 'neck', 'head', 'armL', 'armR', 'foreL', 'foreR', 'handL', 'handR', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR'];

type Pose = Record<string, number>;
type Ease = 'in' | 'out' | 'io';
interface Key { t: number; p: Pose; e?: Ease }
interface Motion {
  /** The windup the keys are authored for; a different one stretches the keys before the blow. */
  windup: number;
  keys: Key[];
}

/** Exported for tuning in the `?giant` view. */
export const MOTIONS: Record<GiantAct, Motion> = {
  // the club comes up over the right shoulder, then sweeps across the front
  club: {
    windup: 0.5,
    keys: [
      { t: -0.5, p: {} },
      { t: -0.1, e: 'io', p: { 'spine2.y': -0.5, 'spine3.y': -0.25, 'spine3.x': -0.08, 'armR.z': -0.9, 'armR.y': -0.5, 'foreR.x': -0.5, 'head.y': 0.3, drop: 0.03 } },
      { t: 0, e: 'in', p: { 'spine2.y': 0.45, 'spine3.y': 0.3, 'spine3.x': 0.42, 'spine2.x': 0.18, 'armR.z': 0.2, 'armR.y': 1.1, 'foreR.x': -0.05, 'head.y': -0.2, 'head.x': -0.2, 'thighL.x': -0.3, 'shinL.x': 0.45, 'thighR.x': -0.2, 'shinR.x': 0.35, drop: 0.13 } },
      { t: 0.28, e: 'out', p: { 'spine2.y': 0.62, 'spine3.y': 0.35, 'spine3.x': 0.4, 'spine2.x': 0.15, 'armR.z': 0.25, 'armR.y': 1.35, 'foreR.x': 0.1, 'head.y': -0.25, 'head.x': -0.18, 'thighL.x': -0.28, 'shinL.x': 0.42, 'thighR.x': -0.18, 'shinR.x': 0.3, drop: 0.12 } },
      { t: 0.95, e: 'io', p: {} },
    ],
  },
  // the right foot comes up high, then down
  stomp: {
    windup: 0.6,
    keys: [
      { t: -0.6, p: {} },
      { t: -0.12, e: 'io', p: { 'thighR.x': -1.15, 'shinR.x': 1.25, 'footR.x': -0.25, 'spine3.x': -0.14, 'spine1.z': -0.1, 'armL.z': 0.55, 'armR.z': -0.45, 'head.x': -0.1 } },
      { t: 0, e: 'in', p: { 'thighR.x': -0.25, 'shinR.x': 0.35, 'thighL.x': -0.3, 'shinL.x': 0.5, 'spine3.x': 0.28, 'spine2.x': 0.1, 'armL.z': 0.3, 'armR.z': -0.25, drop: 0.12 } },
      { t: 0.35, e: 'out', p: { 'thighR.x': -0.2, 'shinR.x': 0.3, 'thighL.x': -0.25, 'shinL.x': 0.42, 'spine3.x': 0.22, 'armL.z': 0.25, 'armR.z': -0.2, drop: 0.1 } },
      { t: 1.0, e: 'io', p: {} },
    ],
  },
  // tear a boulder out of the ground with the left hand, heave it overhead, throw
  boulder: {
    windup: 0.9,
    keys: [
      { t: -0.9, p: {} },
      { t: -0.58, e: 'io', p: { 'spine3.x': 0.6, 'spine2.x': 0.35, 'spine2.y': -0.2, 'thighL.x': -0.55, 'shinL.x': 0.85, 'thighR.x': -0.3, 'shinR.x': 0.55, 'armL.x': -1.1, 'armL.z': 0.25, 'foreL.x': -0.15, drop: 0.28 } },
      { t: -0.36, e: 'io', p: { 'spine3.x': -0.22, 'spine2.y': 0.35, 'armL.z': 2.5, 'armL.x': -0.35, 'foreL.x': -1.1, 'head.x': -0.15, drop: 0.02 } },
      { t: -0.28, e: 'in', p: { 'spine3.x': 0.3, 'spine2.y': -0.45, 'armL.z': 1.0, 'armL.x': -1.6, 'foreL.x': -0.1, 'head.x': 0.05, drop: 0.06 } },
      { t: 0.2, e: 'out', p: { 'spine3.x': 0.25, 'spine2.y': -0.4, 'armL.z': 0.7, 'armL.x': -1.2, 'foreL.x': -0.2, drop: 0.05 } },
      { t: 0.9, e: 'io', p: {} },
    ],
  },
  // fist raised high, then down into the ground (the fist is placed on its mark by IK)
  slam: {
    windup: 0.85,
    keys: [
      { t: -0.85, p: {} },
      { t: -0.15, e: 'io', p: { 'spine3.x': -0.3, 'spine2.x': -0.12, 'spine2.y': -0.15, 'armR.z': -2.4, 'armR.x': -0.4, 'foreR.x': -0.9, 'head.x': -0.15, drop: 0.04 } },
      // a deep lunge, leaning onto the club side, so the fist reaches the ground in front
      { t: 0, e: 'in', p: { 'spine3.x': 0.6, 'spine2.x': 0.5, 'spine1.x': 0.4, 'spine2.y': 0.2, 'spine2.z': 0.4, 'thighL.x': -1.0, 'shinL.x': 1.5, 'thighR.x': 0.1, 'shinR.x': 1.5, 'armR.x': -1.0, 'armL.z': 0.4, drop: 0.55 } },
      { t: 0.8, e: 'io', p: {} },
    ],
  },
  // chest thrown back and arms wide, then the roar: everything thrust forward
  roar: {
    windup: 0.8,
    keys: [
      { t: -0.8, p: {} },
      { t: -0.22, e: 'io', p: { 'spine3.x': -0.35, 'spine2.x': -0.2, 'head.x': -0.45, 'armL.z': 0.9, 'armR.z': -0.9, 'armL.x': 0.5, 'armR.x': 0.5 } },
      { t: 0, e: 'in', p: { 'spine3.x': 0.32, 'spine2.x': 0.15, 'neck.x': 0.15, 'head.x': 0.2, 'armL.z': 0.75, 'armR.z': -0.75, 'armL.x': -0.25, 'armR.x': -0.25, 'foreL.x': -1.3, 'foreR.x': -1.3, 'thighL.x': -0.2, 'shinL.x': 0.35, 'thighR.x': -0.2, 'shinR.x': 0.35, drop: 0.1 } },
      { t: 0.85, e: 'out', p: { 'spine3.x': 0.28, 'spine2.x': 0.12, 'neck.x': 0.12, 'head.x': 0.15, 'armL.z': 0.7, 'armR.z': -0.7, 'armL.x': -0.2, 'armR.x': -0.2, 'foreL.x': -1.2, 'foreR.x': -1.2, 'thighL.x': -0.18, 'shinL.x': 0.3, 'thighR.x': -0.18, 'shinR.x': 0.3, drop: 0.09 } },
      { t: 1.5, e: 'io', p: {} },
    ],
  },
  // a deep breath back, then a long blast of frost swept across the cone
  breath: {
    windup: 0.7,
    keys: [
      { t: -0.7, p: {} },
      { t: -0.12, e: 'io', p: { 'spine3.x': -0.35, 'spine2.x': -0.1, 'neck.x': -0.15, 'head.x': -0.45, 'armL.z': 0.4, 'armR.z': -0.4 } },
      { t: 0, e: 'in', p: { 'spine3.x': 0.35, 'neck.x': 0.2, 'head.x': 0.3, 'spine2.y': -0.28, 'armL.z': 0.25, 'armR.z': -0.25, drop: 0.05 } },
      { t: 2.0, e: 'io', p: { 'spine3.x': 0.32, 'neck.x': 0.18, 'head.x': 0.28, 'spine2.y': 0.28, 'armL.z': 0.25, 'armR.z': -0.25, drop: 0.05 } },
      { t: 2.6, e: 'io', p: {} },
    ],
  },
  // both fists high, then down: the wall of ice runs out along the line
  avalanche: {
    windup: 1.0,
    keys: [
      { t: -1, p: {} },
      { t: -0.2, e: 'io', p: { 'spine3.x': -0.35, 'spine2.x': -0.1, 'armL.z': 2.5, 'armR.z': -2.5, 'armL.x': -0.6, 'armR.x': -0.6, 'foreL.x': -0.7, 'foreR.x': -0.7, 'head.x': -0.2 } },
      { t: 0, e: 'in', p: { 'spine3.x': 0.75, 'spine2.x': 0.4, 'armL.z': 0.4, 'armR.z': -0.4, 'armL.x': -1.5, 'armR.x': -1.5, 'thighL.x': -0.7, 'shinL.x': 1.0, 'thighR.x': -0.7, 'shinR.x': 1.0, drop: 0.32 } },
      { t: 0.6, e: 'out', p: { 'spine3.x': 0.7, 'spine2.x': 0.38, 'armL.z': 0.38, 'armR.z': -0.38, 'armL.x': -1.4, 'armR.x': -1.4, 'thighL.x': -0.65, 'shinL.x': 0.95, 'thighR.x': -0.65, 'shinR.x': 0.95, drop: 0.3 } },
      { t: 1.4, e: 'io', p: {} },
    ],
  },
  // the left hand calls the storm down from the sky, then points it at its mark
  hail: {
    windup: 0.6,
    keys: [
      { t: -0.6, p: {} },
      { t: -0.05, e: 'io', p: { 'armL.z': 2.7, 'armL.x': -0.4, 'foreL.x': -0.2, 'spine3.x': -0.25, 'spine2.y': 0.15, 'head.x': -0.4 } },
      { t: 0.15, e: 'in', p: { 'armL.z': 1.1, 'armL.x': -1.5, 'foreL.x': -0.1, 'spine3.x': 0.12, 'spine2.y': 0.1, 'head.x': 0 } },
      { t: 1.0, e: 'out', p: { 'armL.z': 1.0, 'armL.x': -1.45, 'spine3.x': 0.1 } },
      { t: 1.6, e: 'io', p: {} },
    ],
  },
};

/** Both knees broken: down on them, head hung low over the crown. */
const KNEEL: Pose = {
  drop: 0.56, 'thighL.x': -0.12, 'thighR.x': -0.12, 'shinL.x': 1.5, 'shinR.x': 1.5, 'footL.x': 0.55, 'footR.x': 0.55,
  'spine1.x': 0.2, 'spine2.x': 0.28, 'spine3.x': 0.25, 'head.x': 0.3, 'armL.x': -0.55, 'armR.x': -0.55, 'armL.z': 0.15, 'armR.z': -0.15, 'foreL.x': -0.3, 'foreR.x': -0.3,
};
/** The back rune breaks: an arch of pain, a hand clawing back toward it. */
const SILENCED: Pose = { 'spine3.x': -0.32, 'spine2.x': -0.12, 'head.x': -0.35, 'armL.x': 0.6, 'armL.z': 0.5, 'foreL.x': -1.2, 'armR.z': -0.5 };
/** A wrist breaks: that arm is flung back, the body recoils. */
const STAGGER: Pose = { 'spine2.y': 0.32, 'spine3.x': -0.15, 'armR.x': 0.9, 'armR.z': -0.6, 'foreR.x': -0.4, 'head.x': -0.2, 'head.y': -0.2, drop: 0.05 };
/** Leaning into the walk. */
const STRIDE: Pose = { 'spine3.x': 0.1, 'spine2.x': 0.04, 'head.x': -0.06 };

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

/** The same pose on the other side: left and right swap, rotations about Y and Z flip. */
export function mirror(p: Pose): Pose {
  const out: Pose = {};
  for (const [ch, a] of Object.entries(p)) {
    if (ch === 'drop') {
      out[ch] = a;
      continue;
    }
    const [b, ax] = ch.split('.') as [string, string];
    const nb = b.endsWith('L') ? `${b.slice(0, -1)}R` : b.endsWith('R') ? `${b.slice(0, -1)}L` : b;
    out[`${nb}.${ax}`] = ax === 'x' ? a : -a;
  }
  return out;
}

/**
 * Left-handed versions. The stance is not symmetric (the club leg is back),
 * so a mirrored pose twists it wrong: the left slam keeps the same lunge and
 * leans the other way, and holds the club arm still against the bend.
 */
export const MIRRORED: Partial<Record<GiantAct, Motion>> = {
  slam: {
    windup: MOTIONS.slam.windup,
    keys: [
      { t: -0.85, p: {} },
      { t: -0.15, e: 'io', p: { 'spine3.x': -0.3, 'spine2.x': -0.12, 'spine2.y': 0.15, 'armL.z': 2.4, 'armL.x': -1.1, 'foreL.x': -0.9, 'head.x': -0.15, 'armR.x': 0.42, drop: 0.04 } },
      { t: 0, e: 'in', p: { 'spine3.x': 0.6, 'spine2.x': 0.5, 'spine1.x': 0.4, 'spine2.y': -0.2, 'spine2.z': -0.4, 'thighL.x': -1.0, 'shinL.x': 1.5, 'thighR.x': 0.1, 'shinR.x': 1.5, 'armL.x': -1.0, 'armR.x': -1.5, 'armR.y': 0.2, 'armR.z': 0.4, drop: 0.55 } },
      { t: 0.8, e: 'io', p: {} },
    ],
  },
};

function ease(u: number, e: Ease | undefined): number {
  if (e === 'in') return u * u * u;
  if (e === 'out') return 1 - (1 - u) ** 3;
  return u * u * (3 - 2 * u);
}

/** The pose a motion holds `t` seconds from its blow. */
function sample(m: Motion, t: number, out: Pose, weight: number): void {
  const keys = m.keys;
  let i = 0;
  while (i < keys.length - 2 && t >= keys[i + 1]!.t) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const u = THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1);
  const k = ease(u, b.e);
  for (const ch of new Set([...Object.keys(a.p), ...Object.keys(b.p)])) {
    const v = (a.p[ch] ?? 0) + ((b.p[ch] ?? 0) - (a.p[ch] ?? 0)) * k;
    out[ch] = (out[ch] ?? 0) + v * weight;
  }
}

function addPose(out: Pose, p: Pose, w: number): void {
  if (w <= 1e-3) return;
  for (const [ch, a] of Object.entries(p)) out[ch] = (out[ch] ?? 0) + a * w;
}

interface Action {
  act: GiantAct;
  motion: Motion;
  /** Seconds since the blow (negative while winding up), on the motion's own clock. */
  t: number;
  /** Real windup over authored windup, for the keys before the blow. */
  stretch: number;
  weight: number;
  fading: boolean;
  hand: 'L' | 'R';
  aim: THREE.Vector3;
  landed: boolean;
}

// ---------------------------------------------------------------------------
// Weak points: ice that glows, cracks as it takes damage, shatters and grows back.

export function crystalGeometry(length: number, radius: number, sides = 6, seed = 1): THREE.BufferGeometry {
  const tip = 0.6 + ((seed * 0.37) % 0.15);
  const pts = [
    new THREE.Vector2(0.0001, -0.15 * length), new THREE.Vector2(radius * 0.9, -0.1 * length), new THREE.Vector2(radius, 0),
    new THREE.Vector2(radius * 0.8, length * tip), new THREE.Vector2(0.0001, length),
  ];
  const g = new THREE.LatheGeometry(pts, sides, seed, Math.PI * 2).toNonIndexed();
  g.computeVertexNormals();
  return g;
}

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A clump of crystals around +Y. */
export function clusterGeometry(count: number, length: number, radius: number, spread: number, seed: number): THREE.BufferGeometry {
  const r = random(seed);
  const parts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < count; i++) {
    const big = i === 0 ? 1 : 0.5 + r() * 0.45;
    const g = crystalGeometry(length * big, radius * big, 6, i + seed);
    const a = r() * Math.PI * 2;
    const tilt = i === 0 ? r() * 0.2 : spread * (0.4 + r() * 0.6);
    const dir = new THREE.Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
    const off = i === 0 ? 0 : radius * (0.6 + r() * 0.8);
    g.translate(Math.cos(a) * off, 0, Math.sin(a) * off);
    parts.push(g);
  }
  return mergeGeometries(parts, false)!;
}

/** A TSL uniform: a node in the shader graph whose value is set from code. */
type U = { value: number } & Record<string, any>;
interface IceUniforms {
  glow: U;
  crack: U;
  flash: U;
}

function iceMaterial(shared?: IceUniforms): { material: THREE.Material; u: IceUniforms } {
  const u: IceUniforms = shared ?? { glow: uniform(0.3), crack: uniform(0), flash: uniform(0) };
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 });
  const facing = saturate(normalView.dot(positionView.normalize().negate()));
  const rimk = pow(float(1).sub(facing), 2.2);
  // deep blue at the heart, pale where it thins at the edges
  m.colorNode = mix(color(0x1c58a8), color(0xc4ecff), rimk.mul(0.8));
  // cracks spread through it as it is damaged: thin lines along two noise fields' zero crossings
  const l1 = float(1).sub(smoothstep(0.0, 0.05, abs(mx_noise_float(positionLocal.mul(38)))));
  const l2 = float(1).sub(smoothstep(0.0, 0.04, abs(mx_noise_float(positionLocal.mul(71).add(3.1)))));
  const cracks = l1.mul(smoothstep(0.15, 0.35, u.crack)).max(l2.mul(smoothstep(0.5, 0.75, u.crack)));
  const pulse = sin(time.mul(5)).mul(0.25).add(1);
  const glow = float(0.35).add(u.glow.mul(pulse).mul(2.6));
  m.emissiveNode = color(0x52d8ff).mul(glow.mul(rimk.mul(0.7).add(0.35))).add(color(0xeefbff).mul(cracks.mul(u.glow.mul(3).add(1.2)))).add(color(0xffffff).mul(u.flash.mul(4)));
  return { material: m, u };
}

function runeStoneMaterials(): { stone: THREE.Material; rune: THREE.Material; u: IceUniforms } {
  const u: IceUniforms = { glow: uniform(0.3), crack: uniform(0), flash: uniform(0) };
  const stone = new THREE.MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0.1 });
  const grain = mx_noise_float(positionLocal.mul(40)).mul(0.5).add(0.5);
  stone.colorNode = mix(color(0x1a2433), color(0x3c4c62), grain);
  const l1 = float(1).sub(smoothstep(0.0, 0.05, abs(mx_noise_float(positionLocal.mul(30)))));
  stone.emissiveNode = color(0x7fe6ff).mul(l1.mul(smoothstep(0.2, 0.6, u.crack)).mul(u.glow.mul(3).add(1))).add(color(0xffffff).mul(u.flash.mul(2)));
  const rune = new THREE.MeshBasicNodeMaterial();
  const pulse = sin(time.mul(4)).mul(0.3).add(1);
  rune.colorNode = color(0x66e0ff).mul(float(1.2).add(u.glow.mul(pulse).mul(5))).add(color(0xffffff).mul(u.flash.mul(5)));
  return { stone, rune, u };
}

interface PartView {
  /** Follows the bone; scaled for regrowth. */
  group: THREE.Group;
  u: IceUniforms;
  alive: boolean;
  grow: number;
  flash: number;
  /** Where its bar and the shatter come from. */
  center: THREE.Object3D;
}

/** Ice shards from a broken weak point, in world space. */
class ShardBurst {
  readonly mesh: THREE.InstancedMesh;
  private readonly shards: { p: THREE.Vector3; v: THREE.Vector3; axis: THREE.Vector3; spin: number; angle: number; size: number; life: number }[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private static readonly MAX = 120;

  constructor() {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.1, metalness: 0 });
    mat.colorNode = color(0x9fdcff);
    mat.emissiveNode = color(0x52d8ff).mul(1.6);
    this.mesh = new THREE.InstancedMesh(crystalGeometry(1, 0.28, 5, 3), mat, ShardBurst.MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
  }

  burst(at: THREE.Vector3, size: number, count: number): void {
    const r = Math.random;
    for (let i = 0; i < count; i++) {
      if (this.shards.length >= ShardBurst.MAX) this.shards.shift();
      const a = r() * Math.PI * 2;
      const up = 0.3 + r() * 0.9;
      const sp = (4 + r() * 9) * size;
      this.shards.push({
        p: at.clone(),
        v: new THREE.Vector3(Math.cos(a) * sp, up * sp * 1.2, Math.sin(a) * sp),
        axis: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(),
        spin: 4 + r() * 10,
        angle: r() * 6,
        size: size * (0.35 + r() * 0.9),
        life: 1.2 + r() * 0.8,
      });
    }
  }

  update(dt: number, ground: number): void {
    let n = 0;
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i]!;
      s.life -= dt;
      if (s.life <= 0) {
        this.shards.splice(i, 1);
        continue;
      }
      s.v.y -= 22 * dt;
      s.p.addScaledVector(s.v, dt);
      if (s.p.y < ground + 0.1) {
        s.p.y = ground + 0.1;
        s.v.multiplyScalar(0.35);
        s.v.y = Math.abs(s.v.y) * 0.4;
        s.spin *= 0.5;
      }
      s.angle += s.spin * dt;
    }
    for (const s of this.shards) {
      this.q.setFromAxisAngle(s.axis, s.angle);
      const k = s.size * Math.min(1, s.life / 0.4);
      this.s.set(k, k, k);
      this.m.compose(s.p, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** A fading ribbon behind the club head while it swings. */
class Trail {
  readonly mesh: THREE.Mesh;
  private readonly n = 22;
  private readonly tips: THREE.Vector3[] = [];
  private readonly bases: THREE.Vector3[] = [];
  private readonly pos: Float32Array;
  private readonly alpha: Float32Array;
  private readonly geo = new THREE.BufferGeometry();
  strength = 0;

  constructor() {
    this.pos = new Float32Array(this.n * 2 * 3);
    this.alpha = new Float32Array(this.n * 2);
    const idx: number[] = [];
    for (let i = 0; i < this.n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('trail', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const a = attribute('trail', 'float');
    m.colorNode = color(0x9fe8ff).mul(a.mul(1.1));
    m.opacityNode = a.mul(0.6);
    this.mesh = new THREE.Mesh(this.geo, m);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
  }

  push(tip: THREE.Vector3, base: THREE.Vector3): void {
    this.tips.unshift(tip.clone());
    this.bases.unshift(base.clone());
    if (this.tips.length > this.n) {
      this.tips.pop();
      this.bases.pop();
    }
    const n = this.tips.length;
    for (let i = 0; i < this.n; i++) {
      const t = this.tips[Math.min(i, n - 1)]!;
      const b = this.bases[Math.min(i, n - 1)]!;
      this.pos.set([t.x, t.y, t.z], i * 6);
      this.pos.set([b.x, b.y, b.z], i * 6 + 3);
      const k = (1 - i / (this.n - 1)) ** 1.5 * this.strength;
      this.alpha[i * 2] = k;
      this.alpha[i * 2 + 1] = 0;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.trail as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = this.strength > 0.01;
  }
}

/** A boulder torn up and thrown: in the left hand while lifted, then in flight to its mark. */
class Boulder {
  readonly mesh: THREE.Mesh;
  private from = new THREE.Vector3();
  private to = new THREE.Vector3();
  private flight = 0;
  private t = 0;
  /** 'hand' while carried, 'air' in flight. */
  state: 'none' | 'hand' | 'air' = 'none';

  constructor() {
    const g = new THREE.IcosahedronGeometry(1, 2);
    const p = g.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const n = 1 + 0.22 * Math.sin(v.x * 3.1 + v.y * 1.7) * Math.cos(v.z * 2.3 - v.y) + 0.1 * Math.sin(v.x * 7 + v.z * 5);
      v.multiplyScalar(n);
      v.y *= 0.82;
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    const top = smoothstep(0.2, 0.8, positionLocal.normalize().y.add(mx_noise_float(positionLocal.mul(2.5)).mul(0.4)));
    m.colorNode = mix(mix(color(0x4a4e57), color(0x6c717c), mx_noise_float(positionLocal.mul(4)).mul(0.5).add(0.5)), color(0xe8f2ff), top.mul(0.85));
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.visible = false;
    this.mesh.castShadow = true;
  }

  carry(at: THREE.Vector3, size: number): void {
    this.state = 'hand';
    this.mesh.visible = true;
    this.mesh.position.copy(at);
    this.mesh.scale.setScalar(size);
  }

  throw(to: THREE.Vector3, seconds: number): void {
    this.state = 'air';
    this.from.copy(this.mesh.position);
    this.to.copy(to);
    this.flight = Math.max(0.1, seconds);
    this.t = 0;
  }

  /** True on the frame it lands. */
  update(dt: number): boolean {
    if (this.state !== 'air') return false;
    this.t += dt;
    const u = Math.min(1, this.t / this.flight);
    this.mesh.position.lerpVectors(this.from, this.to, u);
    this.mesh.position.y += Math.sin(u * Math.PI) * (4 + this.from.distanceTo(this.to) * 0.25);
    this.mesh.rotation.x += dt * 5;
    this.mesh.rotation.z += dt * 3;
    if (u >= 1) {
      this.state = 'none';
      this.mesh.visible = false;
      return true;
    }
    return false;
  }

  drop(): void {
    this.state = 'none';
    this.mesh.visible = false;
  }
}

// ---------------------------------------------------------------------------

/** How far short of a slam's mark the hand joint stops, so the fist covers the mark. */
const FIST = 1.2;

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();

/**
 * The Jötunn's body: its forged model drawn GIANT_SCALE times larger, with
 * keyframed pose layers for every attack timed to the sim's windups, a kneel,
 * a stagger and a fall, a fist placed on its mark by IK after a slam, heavy
 * footfalls, a club trail, a thrown boulder, and its weak points as ice that
 * glows when it can be struck, cracks as it is damaged, shatters and regrows.
 *
 * `root` sits at the feet and faces +Z, like a GodModel's. `fx` holds the
 * world-space effects (shards, trail, boulder); the owner adds it to the scene.
 */
export class GiantModel {
  readonly root = new THREE.Group();
  readonly fx = new THREE.Group();
  readonly god: GodModel;
  /** Top of the head when standing, meters. */
  readonly height: number;
  /** A foot came down: where (world, its ankle), how hard (0..1) and which (0 left, 1 right). */
  onStep: ((at: THREE.Vector3, strength: number, foot: 0 | 1) => void) | null = null;
  /** The visual moment a blow lands: what and where (world). */
  onImpact: ((act: GiantAct, at: THREE.Vector3) => void) | null = null;
  /** A weak point shattered (world). */
  onShatter: ((part: GiantPart, at: THREE.Vector3) => void) | null = null;
  /** Its knees hit the ground, or its body did (world). */
  onFall: ((at: THREE.Vector3, strength: number) => void) | null = null;

  private readonly pivot = new THREE.Group();
  private readonly bones = new Map<string, THREE.Bone>();
  private readonly parts = new Map<GiantPart, PartView>();
  private readonly actions: Action[] = [];
  private readonly pose: Pose = {};
  private kneel = 0;
  private silenced = 0;
  private stagger = 0;
  private staggerHand: 'L' | 'R' = 'R';
  private plant = 0;
  private plantHand: 'L' | 'R' = 'R';
  private readonly plantAt = new THREE.Vector3();
  private death = -1;
  private stride = 0;
  private readonly shards = new ShardBurst();
  private readonly trail = new Trail();
  private readonly boulder = new Boulder();
  private readonly clubTip = new THREE.Object3D();
  private readonly clubBase = new THREE.Object3D();
  private readonly feet: THREE.Bone[] = [];
  /** Which foot it stands on (the lower one), -1 before it is known. */
  private planted = -1;
  private lastStep = 0;
  /** When it last walked, and how fast: the foot that comes down as it stops is a step too. */
  private walkedAt = -1;
  private pace = 0;
  private clock = 0;
  private state: GiantState | null = null;
  private wasKneeling = false;
  private readonly tilt = new THREE.Quaternion();
  /** Turns the head bone's frame into the model's (+Z forward) at rest, for `mouth`. */
  private readonly headRest = new THREE.Quaternion();

  constructor() {
    this.god = new GodModel('jotunn', undefined, { idle: 'Sword_Idle', fullStride: 0.12 });
    this.height = this.god.height * GIANT_SCALE * 0.92;
    this.god.root.scale.setScalar(GIANT_SCALE);
    this.pivot.add(this.god.root);
    this.root.add(this.pivot);
    this.root.name = 'jotunn';
    for (const [k, n] of Object.entries(BONES)) {
      const b = this.god.bone(n);
      if (b) this.bones.set(k, b);
    }
    this.fx.name = 'jotunn-fx';
    this.fx.add(this.shards.mesh, this.trail.mesh, this.boulder.mesh);
    // hidden until a blow uses them: drawn while the loader prepares shaders, so the first boulder doesn't build one mid-fight
    for (const m of [this.shards.mesh, this.trail.mesh, this.boulder.mesh]) m.userData.shownLater = true;
    this.buildParts();
    for (const s of ['L', 'R']) {
      const b = this.god.bone(`DEF-foot.${s}`);
      if (b) this.feet.push(b);
    }
    this.god.poseHook = (dt) => this.layer(dt);
    // the head bone's rest orientation in the model, from the skin's bind
    const head = this.god.bone('DEF-head');
    if (head) {
      const q = new THREE.Quaternion();
      new THREE.Matrix4().copy(this.boneInverse('DEF-head')).invert().decompose(new THREE.Vector3(), q, new THREE.Vector3());
      this.headRest.copy(q).invert();
    }
  }

  private boneInverse(boneName: string): THREE.Matrix4 {
    const bone = this.god.bone(boneName)!;
    let mesh: THREE.SkinnedMesh | null = null;
    this.god.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!mesh && m.isSkinnedMesh && m.skeleton.bones.includes(bone)) mesh = m;
    });
    const sk = (mesh as unknown as THREE.SkinnedMesh).skeleton;
    return sk.boneInverses[sk.bones.indexOf(bone)]!;
  }

  // ------------------------------------------------------------- weak points

  /** A child of `bone` placed at a point and orientation given in the model's bind space. */
  private attach(boneName: string, at: THREE.Vector3, quat = new THREE.Quaternion()): THREE.Group {
    const bone = this.god.bone(boneName)!;
    const g = new THREE.Group();
    // the skin's bind: vertex world = bone.matrixWorld * boneInverse * bindMatrix * v
    let skinned: THREE.SkinnedMesh | null = null;
    this.god.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!skinned && m.isSkinnedMesh && m.skeleton.bones.includes(bone)) skinned = m;
    });
    const mesh = skinned! as THREE.SkinnedMesh;
    const i = mesh.skeleton.bones.indexOf(bone);
    const local = new THREE.Matrix4().multiplyMatrices(mesh.skeleton.boneInverses[i]!, mesh.bindMatrix).multiply(new THREE.Matrix4().compose(at, quat, new THREE.Vector3(1, 1, 1)));
    local.decompose(g.position, g.quaternion, g.scale);
    bone.add(g);
    return g;
  }

  /** A bone's bind-pose position in model space. */
  private bindHead(boneName: string): THREE.Vector3 {
    const bone = this.god.bone(boneName)!;
    let mesh: THREE.SkinnedMesh | null = null;
    this.god.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!mesh && m.isSkinnedMesh && m.skeleton.bones.includes(bone)) mesh = m;
    });
    const sk = (mesh as unknown as THREE.SkinnedMesh).skeleton;
    const inv = sk.boneInverses[sk.bones.indexOf(bone)]!;
    const bind = new THREE.Matrix4().copy((mesh as unknown as THREE.SkinnedMesh).bindMatrix).invert().multiply(inv.clone().invert());
    return new THREE.Vector3().setFromMatrixPosition(bind);
  }

  private buildParts(): void {
    const up = new THREE.Vector3(0, 1, 0);
    const meta = (this.god as unknown as { asset: { meta: { rune?: number[]; clubTip?: number[] } } }).asset.meta;
    // knees: a crust of crystals over each kneecap, pointing out and up
    for (const s of ['L', 'R'] as const) {
      const knee = this.bindHead(`DEF-shin.${s}`);
      const at = knee.clone().add(new THREE.Vector3(0, 0.03, 0.1));
      const dir = new THREE.Vector3(s === 'L' ? 0.25 : -0.25, 0.55, 1).normalize();
      const { material, u } = iceMaterial();
      const g = this.attach(`DEF-shin.${s}`, at, new THREE.Quaternion().setFromUnitVectors(up, dir));
      const mesh = new THREE.Mesh(clusterGeometry(7, 0.16, 0.04, 0.9, s === 'L' ? 11 : 23), material);
      g.add(mesh);
      this.addPart(s === 'L' ? 'kneeL' : 'kneeR', g, u, mesh);
    }
    // the back rune: a hexagonal slab of dark ice-stone set between the shoulder blades
    {
      const c = new THREE.Vector3().fromArray(meta.rune ?? [0, 1.68, -0.12]);
      const { stone, rune, u } = runeStoneMaterials();
      const g = this.attach('DEF-spine.003', c.add(new THREE.Vector3(0, 0, -0.025)), new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 0.15, -1).normalize()));
      const slab = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.06, 6, 1).toNonIndexed(), stone);
      slab.geometry.computeVertexNormals();
      g.add(slab);
      const bars: THREE.BufferGeometry[] = [];
      const bar = (x: number, y: number, len: number, a: number) => {
        const b = new THREE.BoxGeometry(0.018, 0.004, len);
        b.rotateY(a);
        b.translate(x, 0.032, y);
        bars.push(b);
      };
      // an original rune: a stave with two branching arms and a crossing hook
      bar(0, 0, 0.19, 0);
      bar(0.035, -0.04, 0.09, 0.7);
      bar(-0.035, -0.04, 0.09, -0.7);
      bar(0.03, 0.05, 0.07, -0.6);
      bar(-0.02, 0.065, 0.05, 1.2);
      const glyph = new THREE.Mesh(mergeGeometries(bars, false)!, rune);
      g.add(glyph);
      // crystals ring the stone
      // the ring crystals share the stone's uniforms
      const ice = iceMaterial(u);
      const ring: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        const cg = crystalGeometry(0.07 + (i % 2) * 0.03, 0.022, 5, i + 3);
        cg.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(Math.cos(a), 1.2, Math.sin(a)).normalize()));
        cg.translate(Math.cos(a) * 0.15, 0.0, Math.sin(a) * 0.15);
        ring.push(cg);
      }
      const ringMesh = new THREE.Mesh(mergeGeometries(ring, false)!, ice.material);
      g.add(ringMesh);
      this.addPart('rune', g, u, slab);
    }
    // wrists: a band of glowing ice just above each shackle
    for (const s of ['L', 'R'] as const) {
      const fa = this.bindHead(`DEF-forearm.${s}`);
      const hand = this.bindHead(`DEF-hand.${s}`);
      const at = fa.clone().lerp(hand, 0.74);
      const axis = hand.clone().sub(fa).normalize();
      const { material, u } = iceMaterial();
      const g = this.attach(`DEF-forearm.${s}`, at, new THREE.Quaternion().setFromUnitVectors(up, axis));
      const parts: THREE.BufferGeometry[] = [new THREE.TorusGeometry(0.085, 0.022, 8, 24).rotateX(Math.PI / 2)];
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const cg = crystalGeometry(0.06 + (i % 3) * 0.015, 0.016, 5, i + 9);
        cg.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(Math.cos(a), 0.35, Math.sin(a)).normalize()));
        cg.translate(Math.cos(a) * 0.09, 0, Math.sin(a) * 0.09);
        parts.push(cg);
      }
      const mesh = new THREE.Mesh(mergeGeometries(parts.map((p) => p.index ? p.toNonIndexed() : p), false)!, material);
      g.add(mesh);
      this.addPart(s === 'L' ? 'wristL' : 'wristR', g, u, mesh);
    }
    // the crown: a jagged circlet of ice spikes on its brow
    {
      const head = this.bindHead('DEF-head');
      const { material, u } = iceMaterial();
      const g = this.attach('DEF-head', head.clone().add(new THREE.Vector3(0, 0.13, 0.0)));
      const parts: THREE.BufferGeometry[] = [new THREE.TorusGeometry(0.1, 0.014, 6, 28).rotateX(Math.PI / 2).toNonIndexed()];
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const front = Math.max(0, Math.cos(a));
        const cg = crystalGeometry(0.07 + front * 0.09, 0.018 + front * 0.01, 5, i + 31);
        cg.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(Math.sin(a) * 0.4, 1, Math.cos(a) * 0.4).normalize()));
        cg.translate(Math.sin(a) * 0.1, 0, Math.cos(a) * 0.1);
        parts.push(cg);
      }
      const mesh = new THREE.Mesh(mergeGeometries(parts, false)!, material);
      g.add(mesh);
      this.addPart('crown', g, u, mesh);
    }
    // the club's head, for its trail
    const tip = new THREE.Vector3().fromArray(meta.clubTip ?? [0, 0, 0]);
    const hand = this.bindHead('DEF-hand.R');
    const t = this.attach('DEF-hand.R', tip);
    t.add(this.clubTip);
    const b = this.attach('DEF-hand.R', hand.clone().lerp(tip, 0.72));
    b.add(this.clubBase);
  }

  private addPart(id: GiantPart, group: THREE.Group, u: IceUniforms, center: THREE.Object3D): void {
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    this.parts.set(id, { group, u, alive: true, grow: 1, flash: 0, center });
  }

  /** World position of a weak point (for its bar and effects). */
  partPosition(id: GiantPart, out: THREE.Vector3): THREE.Vector3 {
    return this.parts.get(id)!.center.getWorldPosition(out);
  }

  /** Where its breath leaves its mouth, and the way its face points (world). */
  mouth(at: THREE.Vector3, dir: THREE.Vector3): void {
    const head = this.bones.get('head');
    if (!head) {
      at.copy(this.root.position).setY(this.root.position.y + this.height);
      dir.set(0, 0, 1).applyQuaternion(this.root.quaternion);
      return;
    }
    head.getWorldQuaternion(tmpQ);
    dir.set(0, 0, 1).applyQuaternion(this.headRest).applyQuaternion(tmpQ);
    head.getWorldPosition(at);
    at.addScaledVector(dir, 0.11 * GIANT_SCALE).y += 0.04 * GIANT_SCALE;
  }

  /** A blow landed on a weak point. */
  hit(id: GiantPart, strength: number): void {
    const p = this.parts.get(id);
    if (!p) return;
    p.flash = Math.min(1, p.flash + 0.4 + strength);
    this.god.flinch(Math.min(0.4, 0.1 + strength * 0.3));
  }

  // ------------------------------------------------------------------ frame

  /** Poses the giant for this frame. Call after placing `root`. */
  update(dt: number, s: GiantState, parts: Record<GiantPart, GiantPartState>): void {
    this.clock += dt;
    this.state = s;
    this.root.updateMatrixWorld(true);
    this.track(dt, s);
    const ground = this.root.position.y;
    this.god.animate(dt, {
      speed: s.dead || this.kneel > 0.5 ? 0 : s.speed / GIANT_SCALE,
      localDir: s.localDir,
      grounded: true,
      verticalSpeed: 0,
    });
    this.updateParts(dt, parts);
    this.footfalls(s);
    // club trail during the swings that use it
    let trail = 0;
    for (const a of this.actions) if (a.act === 'club' || a.act === 'slam' || a.act === 'avalanche') trail = Math.max(trail, a.weight * (a.t > -0.08 && a.t < 0.18 ? 1 : 0));
    this.trail.strength += (trail - this.trail.strength) * Math.min(1, dt * 20);
    this.trail.push(this.clubTip.getWorldPosition(tmpV), this.clubBase.getWorldPosition(tmpV2));
    this.shards.update(dt, ground);
    if (this.boulder.state === 'hand') this.boulder.mesh.position.copy(this.bone('handL')?.getWorldPosition(tmpV) ?? tmpV);
    if (this.boulder.update(dt)) this.onImpact?.('boulder', this.boulder.mesh.position.clone().setY(ground));
  }

  private bone(k: string): THREE.Bone | undefined {
    return this.bones.get(k);
  }

  /** Starts, advances and retires the attack motions and state layers. */
  private track(dt: number, s: GiantState): void {
    const w = s.windup;
    const cur = this.actions.find((a) => !a.fading);
    if (w && (!cur || cur.act !== w.act || (cur.t >= 0 && cur.landed))) {
      // a new windup: fade out whatever is still recovering
      for (const a of this.actions) a.fading = true;
      const hand = w.act === 'slam' ? this.nextHand(w.at) : 'R';
      const motion = hand === 'L' && MIRRORED[w.act] ? MIRRORED[w.act]! : MOTIONS[w.act];
      const stretch = Math.max(0.2, w.left / motion.windup);
      this.actions.push({ act: w.act, motion, t: -w.left / stretch, stretch, weight: 1, fading: false, hand, aim: w.at.clone(), landed: false });
      if (w.act === 'boulder') this.boulder.drop();
    }
    const live = this.actions.find((a) => !a.fading);
    if (live && w && live.t < 0) {
      // stay locked to the sim's clock while winding up
      live.t = -w.left / live.stretch;
      live.aim.copy(w.at);
    } else if (live && !w && live.t < -0.06 / live.stretch) {
      // cancelled (stunned or broken) before it landed
      live.fading = true;
      if (live.act === 'boulder') this.boulder.drop();
    }
    for (const a of this.actions) {
      const before = a.t;
      // the slam's fist stays down while it is planted
      const hold = a.act === 'slam' && !a.fading && a.t >= 0 && s.plant;
      if (!hold) a.t += a.t < 0 ? dt / a.stretch : dt;
      if (a.act === 'boulder' && !a.fading) {
        if (before < -0.55 && a.t >= -0.55) this.boulder.carry(this.bone('handL')!.getWorldPosition(tmpV), 2.2);
        if (before < -0.3 && a.t >= -0.3) this.boulder.throw(a.aim, 0.3 * a.stretch);
      }
      if (!a.landed && a.t >= 0 && !a.fading) {
        a.landed = true;
        if (a.act !== 'boulder') this.onImpact?.(a.act, this.impactPoint(a));
        this.god.hitStop(a.act === 'club' ? 0.05 : 0.08);
      }
      if (a.fading) a.weight -= dt / 0.25;
    }
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const a = this.actions[i]!;
      if (a.weight <= 0 || a.t > a.motion.keys[a.motion.keys.length - 1]!.t) this.actions.splice(i, 1);
    }

    // states: kneel and death settle fast and heavily, the rest ease
    const kneelGoal = s.kneel || s.dead ? 1 : 0;
    const was = this.kneel;
    // (held where it is once there: easing away from 1 and back would land the fall again every other frame)
    if (kneelGoal > this.kneel) this.kneel = Math.min(1, this.kneel + dt / 0.55);
    else if (kneelGoal < this.kneel) this.kneel = Math.max(0, this.kneel - dt / 1.1);
    if (was < 1 && this.kneel >= 1) this.onFall?.(this.root.position.clone(), s.dead ? 0.8 : 1);
    if (!this.wasKneeling && s.kneel) for (const a of this.actions) a.fading = true;
    this.wasKneeling = s.kneel;
    if (s.silenced) this.silenced = Math.min(1, this.silenced + dt / 0.15);
    else this.silenced = Math.max(0, this.silenced - dt / 0.8);
    if (s.staggered) {
      this.staggerHand = s.staggered;
      this.stagger = Math.min(1, this.stagger + dt / 0.1);
    } else this.stagger = Math.max(0, this.stagger - dt / 0.7);
    if (s.plant) {
      this.plantHand = s.plant.hand;
      // the sim's spot is the wrist; the hand joint sits a little beyond it, the fist on the mark
      this.outward(this.plantAt.copy(s.plant.at), JOTUNN.wristShort - FIST);
    }
    this.plant += ((s.plant ? 1 : 0) - this.plant) * Math.min(1, dt * (s.plant ? 30 : 4));
    const moving = THREE.MathUtils.clamp(s.speed / 3, 0, 1);
    this.stride += (moving - this.stride) * Math.min(1, dt * 3);
    if (s.dead) {
      if (this.death < 0) this.death = 0;
      this.death += dt;
    } else this.death = -1;
  }

  /** Which fist a slam comes down with: the one on the side of its mark (as the sim decides). */
  private nextHand(at: THREE.Vector3): 'L' | 'R' {
    const local = this.root.worldToLocal(tmpV.copy(at));
    return local.x > 0 ? 'L' : 'R';
  }

  private impactPoint(a: Action): THREE.Vector3 {
    if (a.act === 'stomp' || a.act === 'roar') return this.root.position.clone();
    return a.aim.clone();
  }

  /** The pose layers, run inside GodModel.animate after the clips. */
  private layer(_dt: number): void {
    const pose = this.pose;
    for (const k of Object.keys(pose)) delete pose[k];
    addPose(pose, STRIDE, this.stride * (1 - this.kneel));
    for (const a of this.actions) {
      const t = a.t;
      sample(a.motion, t, pose, Math.max(0, a.weight) * (1 - this.kneel));
    }
    addPose(pose, KNEEL, this.kneel);
    addPose(pose, SILENCED, this.silenced * (1 - this.kneel));
    addPose(pose, this.staggerHand === 'R' ? STAGGER : mirror(STAGGER), this.stagger * (1 - this.kneel));
    // apply, parents first
    for (const b of ORDER) {
      const bone = this.bones.get(b);
      if (!bone) continue;
      for (const ax of ['x', 'y', 'z'] as const) {
        const a = pose[`${b}.${ax}`];
        if (a) this.god.rotateBone(bone, AXES[ax], a);
      }
    }
    this.god.root.position.y = -(pose.drop ?? 0) * GIANT_SCALE;
    // the fall: from its knees, forward onto its face
    const fall = this.death < 0 ? 0 : THREE.MathUtils.smoothstep(this.death, 0.7, 1.9);
    const was = this.pivot.quaternion.angleTo(this.tilt.identity());
    this.pivot.position.set(0, 0, 0.35 * GIANT_SCALE);
    this.god.root.position.z = -0.35 * GIANT_SCALE;
    this.pivot.quaternion.setFromAxisAngle(AXES.x, fall * fall * 1.35);
    if (was < 1.3 && fall * fall * 1.35 >= 1.3) this.onFall?.(this.root.localToWorld(new THREE.Vector3(0, 0, 1.4 * GIANT_SCALE)), 1);
    this.pivot.updateMatrixWorld(true);
    // the planted fist is placed on its mark
    if (this.plant > 0.01) this.reach(this.plantHand, this.plantAt, this.plant);
    else {
      const slam = this.actions.find((x) => x.act === 'slam' && !x.fading);
      if (slam && slam.t > -0.12) this.reach(slam.hand, this.outward(tmpV2.copy(slam.aim), -FIST), THREE.MathUtils.clamp((slam.t + 0.12) / 0.12, 0, 1));
    }
  }

  /** Moves a point `d` meters further from the giant, along the ground. */
  private outward(p: THREE.Vector3, d: number): THREE.Vector3 {
    const dx = p.x - this.root.position.x;
    const dz = p.z - this.root.position.z;
    const len = Math.hypot(dx, dz);
    if (len > 0.01) {
      const k = Math.max(0, len + d) / len;
      p.x = this.root.position.x + dx * k;
      p.z = this.root.position.z + dz * k;
    }
    return p;
  }

  /** Two-bone IK: bends the arm so the fist meets `target` (world), blended by `w`. */
  private reach(hand: 'L' | 'R', target: THREE.Vector3, w: number): void {
    const upper = this.bones.get(`arm${hand}`);
    const fore = this.bones.get(`fore${hand}`);
    const wrist = this.bones.get(`hand${hand}`);
    if (!upper || !fore || !wrist) return;
    const S = upper.getWorldPosition(new THREE.Vector3());
    const E = fore.getWorldPosition(new THREE.Vector3());
    const W = wrist.getWorldPosition(new THREE.Vector3());
    // aim the wrist a little above the ground, so the fist sits on it
    const T = target.clone();
    T.y = this.root.position.y + 0.12 * GIANT_SCALE;
    const a = S.distanceTo(E);
    const b = E.distanceTo(W);
    const toT = T.clone().sub(S);
    const d = THREE.MathUtils.clamp(toT.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
    const dir = toT.normalize();
    // the elbow bends out and back, in the plane of the current bend
    const pole = E.clone().sub(S);
    pole.addScaledVector(dir, -pole.dot(dir));
    if (pole.lengthSq() < 1e-6) pole.set(hand === 'R' ? -1 : 1, 0, 0);
    pole.normalize();
    const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const E2 = S.clone().addScaledVector(dir, a * cosA).addScaledVector(pole, a * Math.sqrt(1 - cosA * cosA));
    this.rotateWorld(upper, tmpQ.setFromUnitVectors(E.clone().sub(S).normalize(), E2.clone().sub(S).normalize()), w);
    const E3 = fore.getWorldPosition(new THREE.Vector3());
    const W3 = wrist.getWorldPosition(new THREE.Vector3());
    const T2 = S.clone().addScaledVector(dir, d);
    this.rotateWorld(fore, tmpQ.setFromUnitVectors(W3.sub(E3).normalize(), T2.sub(E3).normalize()), w);
  }

  /** Applies a world-space rotation to a bone, scaled by `w`. */
  private rotateWorld(bone: THREE.Object3D, q: THREE.Quaternion, w: number): void {
    tmpQ2.identity().slerp(q, w);
    const parent = bone.parent!;
    const p = parent.getWorldQuaternion(new THREE.Quaternion());
    bone.quaternion.premultiply(p.clone().invert().multiply(tmpQ2).multiply(p));
    bone.updateMatrixWorld(true);
  }

  private updateParts(dt: number, states: Record<GiantPart, GiantPartState>): void {
    for (const id of PART_LIST) {
      const p = this.parts.get(id)!;
      const st = states[id];
      if (p.alive && !st.alive) {
        // shattered
        p.alive = false;
        const at = p.center.getWorldPosition(new THREE.Vector3());
        this.shards.burst(at, id === 'rune' ? 1.3 : id === 'crown' ? 1.1 : 0.9, id === 'rune' ? 40 : 28);
        this.onShatter?.(id, at);
      } else if (!p.alive && st.alive) {
        // grows back
        p.alive = true;
        p.grow = 0;
        p.flash = 1;
      }
      if (p.alive) p.grow = Math.min(1, p.grow + dt / 0.8);
      const g = p.grow;
      // overshoot a little as it locks back into place
      const k = g >= 1 ? 1 : 1 - (1 - g) ** 3 + Math.sin(g * Math.PI) * 0.15;
      p.group.visible = p.alive;
      p.group.scale.setScalar(Math.max(0.001, k));
      p.flash = Math.max(0, p.flash - dt * 4);
      const glowGoal = st.exposed ? 1 : 0.12;
      p.u.glow.value += (glowGoal - p.u.glow.value) * Math.min(1, dt * 6);
      p.u.crack.value = p.alive ? 1 - st.health : 0;
      p.u.flash.value = p.flash;
    }
  }

  /**
   * A step lands each time the swinging foot comes down past the one it stood
   * on. Comparing the two feet (not a fixed height) catches every step at any
   * frame rate and on any slope.
   */
  private footfalls(s: GiantState): void {
    const [a, b] = this.feet;
    if (!a || !b || s.dead || this.kneel > 0.2) {
      this.planted = -1;
      return;
    }
    if (s.speed > 0.5) {
      this.walkedAt = this.clock;
      this.pace = s.speed;
    }
    const ya = a.getWorldPosition(tmpV).y;
    const yb = b.getWorldPosition(tmpV2).y;
    const margin = 0.03 * GIANT_SCALE;
    const low = ya < yb - margin ? 0 : yb < ya - margin ? 1 : this.planted;
    if (low === this.planted) return;
    const was = this.planted;
    this.planted = low;
    if (was < 0 || this.clock - this.walkedAt > 0.6 || this.clock - this.lastStep < 0.25) return;
    // a stomp's foot lands with the blow's own sound
    if (this.actions.some((x) => x.act === 'stomp' && x.weight > 0.1)) return;
    this.lastStep = this.clock;
    const at = (low === 0 ? tmpV : tmpV2).clone().setY(this.root.position.y);
    this.onStep?.(at, THREE.MathUtils.clamp(this.pace / 5, 0.4, 1), low as 0 | 1);
  }

  /** Where a foot is now (world; 0 left, 1 right), false before the model has feet. */
  footAt(foot: 0 | 1, out: THREE.Vector3): boolean {
    const b = this.feet[foot];
    if (!b) return false;
    b.getWorldPosition(out);
    return true;
  }

  get windupAct(): GiantAct | null {
    return this.state?.windup?.act ?? null;
  }
}
