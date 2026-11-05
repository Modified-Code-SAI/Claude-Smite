import * as THREE from 'three/webgpu';
import { abs, attribute, float, mix, mx_noise_float, mx_worley_noise_float, normalView, normalWorld, positionGeometry, positionView, pow, saturate, sin, smoothstep, time, uniform, uv, vec2, vec3, vec4 } from '../render/tsl';
import { spriteQuads } from '../render/shared';
import type { CampKind } from '../map/ConquestLayout';
import { skinRigid } from '../scene/merge';
import { BUFF_COLOR } from '../scene/conquest/Props';
import { MonsterBrain } from '../sim/Jungle';
import type { Unit } from '../sim/Unit';
import { hypot } from '../core/math';

/**
 * Jungle monsters. Two original designs:
 *  - Thornbacks: stocky tusked boars with a ridge of bone spines whose tips
 *    glow amber, mossy fur, ember eyes. The camp's Alpha is half again as big
 *    with an extra crest of crystal shards.
 *  - Wardens: hulking mossy stone guardians that keep the buff altars, with
 *    a crystal heart, eye slit and rune bands lit in the buff's color, and
 *    shards orbiting their heads. They wind up a two-fisted slam.
 *  - Shades: hooded wraiths of tattered black cloth that float over the
 *    floor of the deeper underworld, lit from inside by violet soul fire
 *    that licks up from the hem, eyes burning in an empty hood. They gather
 *    a soul between their spectral claws and hurl it, and fold into their
 *    own fire to blink away from anyone who closes in.
 *  - Gravekeepers: stooped antlered skeletons in grave-linen rags, haunting
 *    the Abyss with a crooked staff and a lantern of amber soul fire. They
 *    hang back, lift the lantern and pour souls into the most hurt monster
 *    near them, an ember of their own soul glowing in their open ribs.
 * Each monster is a small hierarchy of rigid parts posed every frame, drawn
 * as one skinned mesh per material (`skinRigid`): the pivots are its bones.
 * Materials read `positionGeometry`, the part's unposed position, so patterns
 * stay on the body as it moves.
 */

/** Buff camp colors: the map's altar crystal colors, so a Warden matches its altar. */
export const BUFF_GLOW: Partial<Record<string, number>> = { ...BUFF_COLOR, fury: 0xff6a1a };

const AMBER = 0xffa53a;
export const GILDED_GLOW = 0xffd25a;
/** The Thornspitter's acid: its sacs, eyes and spit. */
export const ACID = 0x8cff3a;
/** The Shade's soul fire: its eyes, claws, hem and bolts. */
export const SHADE_GLOW = 0x8458ff;
export const SHADE_CORE = 0xeadcff;
/** The Gravekeeper's lantern: a warm corpse-candle flame in the cold green Abyss. */
export const KEEPER_GLOW = 0xffa83a;
export const KEEPER_CORE = 0xfff0c8;

export interface MonsterView {
  root: THREE.Group;
  height: number;
  /** Seconds the body stays after death (3 if unset). */
  linger?: number;
  /** Pose for this frame. `windup` is the sim's slam windup, `wobble` the hit spring. */
  animate(u: Unit, dt: number, deathTime: number, wobble: number): void;
}

// ---------------------------------------------------------------------------
// Materials (shared by every monster)

let shared: ReturnType<typeof buildShared> | null = null;
const glowCache = new Map<number, THREE.Material>();

function n(s: number, p = positionGeometry) {
  return mx_noise_float(p.mul(s)).mul(0.5).add(0.5);
}

function buildShared() {
  // shaggy fur: dark umber with moss-green tips, darker underneath
  const fur = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.92, sheen: 0.6, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x8fa060) });
  const streak = mx_noise_float(vec3(positionGeometry.x.mul(18), positionGeometry.y.mul(5), positionGeometry.z.mul(18))).mul(0.5).add(0.5);
  const top = smoothstep(-0.2, 0.8, normalWorld.y);
  fur.colorNode = mix(vec3(0.09, 0.06, 0.035), mix(vec3(0.24, 0.16, 0.08), vec3(0.3, 0.34, 0.12), n(4).mul(top)), streak.mul(0.6).add(top.mul(0.4)));
  // bare hide on the snout and legs
  const hide = new THREE.MeshStandardNodeMaterial({ roughness: 0.75 });
  hide.colorNode = mix(vec3(0.2, 0.12, 0.08), vec3(0.34, 0.22, 0.15), n(14));
  // bone that heats up to amber toward its tip (cone uv.y is 1 at the tip)
  const bone = new THREE.MeshStandardNodeMaterial({ roughness: 0.45 });
  const tip = smoothstep(0.45, 1, uv().y);
  bone.colorNode = mix(vec3(0.82, 0.76, 0.6), vec3(1, 0.62, 0.22), tip);
  bone.emissiveNode = vec3(1, 0.45, 0.1).mul(tip.mul(tip).mul(2.2));
  const hoof = new THREE.MeshStandardNodeMaterial({ color: 0x1b1410, roughness: 0.5 });
  // the Gilded Thornback's coat: the same plain material as the hooves, so no new shader
  const gold = new THREE.MeshStandardNodeMaterial({ color: 0xe0a93a, metalness: 1, roughness: 0.3 });
  // weathered stone with moss on every upward face
  const stone = new THREE.MeshStandardNodeMaterial({ roughness: 0.88 });
  // object space, so the stone's pattern stays on the Warden as it walks and swings
  const grain = n(3.5).mul(0.6).add(n(14).mul(0.4));
  const moss = smoothstep(0.2, 0.7, normalWorld.y.add(n(2.2).sub(0.5).mul(0.7)));
  const rockCol = mix(vec3(0.16, 0.16, 0.19), vec3(0.38, 0.35, 0.32), grain);
  stone.colorNode = mix(rockCol, mix(vec3(0.17, 0.3, 0.07), vec3(0.32, 0.46, 0.12), n(9)), moss.mul(0.92));
  stone.roughnessNode = float(0.95).sub(moss.mul(0.1));
  return { fur, hide, bone, hoof, stone, gold };
}

function mats() {
  return (shared ??= buildShared());
}

/** Unlit HDR glow so bloom picks it up. */
function glow(hex: number, strength = 4): THREE.Material {
  const key = hex * 16 + strength;
  let m = glowCache.get(key);
  if (!m) {
    const g = new THREE.MeshBasicNodeMaterial();
    // uniforms rather than constants, so every glow colour shares one shader
    g.colorNode = uniform(new THREE.Color(hex)).mul(uniform(strength).mul(n(30).mul(0.4).add(0.8)));
    glowCache.set(key, (m = g));
  }
  return m;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) geoCache.set(key, (g = make()));
  return g;
}

/**
 * A chunky rock for the Warden's body: a round lump with soft facets, not
 * squashed flat like the map's boulders, so the parts overlap into one body.
 */
function rock(radius: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius, 3);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const f = (x: number, y: number, z: number) =>
    Math.sin(x * 2.1 + seed) * Math.sin(y * 2.3 + seed * 1.7) * Math.sin(z * 1.9 + seed * 0.6);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).divideScalar(radius);
    let d = 1 + f(v.x * 1.5, v.y * 1.5, v.z * 1.5) * 0.16 + f(v.x * 4, v.y * 4, v.z * 4) * 0.05;
    // a few flat fractured faces
    d -= Math.max(0, Math.abs(v.x * 0.8 + v.z * 0.5 + Math.sin(seed)) - 0.75) * 0.5;
    v.multiplyScalar(d * radius);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function mesh(parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, shadow = true): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.rotation.set(rx, ry, rz);
  o.castShadow = shadow;
  o.receiveShadow = true;
  parent.add(o);
  return o;
}

/** Room for every pose of a monster `height` tall: raised fists, a lunge, a tail sweep. */
function bounds(height: number): THREE.Sphere {
  return new THREE.Sphere(new THREE.Vector3(0, height / 2, 0), height * 0.9 + 1);
}

function pivot(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

// ---------------------------------------------------------------------------
// Thornback

function thornback(alpha: boolean, spitter = false, gilded = false): MonsterView {
  const base = mats();
  // the Gilded Thornback: a coat of gold and glowing golden spines
  const m = gilded ? { ...base, fur: base.gold, bone: glow(GILDED_GLOW, 2.5) } : base;
  const root = new THREE.Group();
  const s = alpha ? 1.8 : spitter ? 1.1 : gilded ? 1.15 : 1.25;
  const eye = spitter ? ACID : gilded ? GILDED_GLOW : AMBER;
  const rig = pivot(root, 0, 0, 0);
  rig.scale.setScalar(s);
  const body = pivot(rig, 0, 0.72, 0);
  // barrel body with a hump over the shoulders, front sitting higher
  mesh(body, geo('tb-body', () => new THREE.SphereGeometry(0.5, 24, 16).scale(0.62, 0.55, 1)), m.fur, 0, 0, -0.05, 0.08);
  mesh(body, geo('tb-hump', () => new THREE.SphereGeometry(0.42, 20, 14).scale(0.85, 0.85, 1)), m.fur, 0, 0.12, 0.25);
  mesh(body, geo('tb-tail', () => new THREE.ConeGeometry(0.06, 0.3, 8)), m.hide, 0, 0.08, -0.55, -2.2);
  // ridge of spines along the back, tilted toward the tail
  const spines = alpha ? 11 : 7;
  for (let i = 0; i < spines; i++) {
    const k = i / (spines - 1);
    const len = (0.32 + Math.sin(k * Math.PI) * 0.28) * (alpha ? 1.15 : 1);
    const g = geo(`tb-spine-${len.toFixed(2)}`, () => new THREE.ConeGeometry(0.05, len, 7).translate(0, len / 2, 0));
    const z = 0.42 - k * 0.85;
    const y = 0.26 + Math.sin(k * Math.PI) * 0.08 + (1 - k) * 0.04;
    mesh(body, g, m.bone, 0, y, z, -0.55 - k * 0.4, 0, 0);
    // smaller side rows
    if (i % 2 === 0 && i > 0 && i < spines - 1) {
      for (const sx of [-1, 1]) mesh(body, g, m.bone, sx * 0.17, y - 0.08, z, -0.6 - k * 0.3, 0, sx * 0.5).scale.setScalar(0.6);
    }
  }
  if (alpha) {
    // the Alpha's crest: amber crystal shards over the shoulders
    const shard = geo('tb-shard', () => new THREE.OctahedronGeometry(0.1, 0).scale(0.6, 1.8, 0.6).translate(0, 0.16, 0));
    for (let i = 0; i < 5; i++) {
      const a = (i - 2) * 0.32;
      mesh(body, shard, glow(AMBER, 3), Math.sin(a) * 0.32, 0.38 + Math.cos(a) * 0.04, 0.3, -0.3, 0, -a * 1.2);
    }
  }
  // the Spitter's acid sacs swell along its back and pulse as it breathes
  const sacs: THREE.Mesh[] = [];
  if (spitter) {
    const sac = geo('tb-sac', () => new THREE.SphereGeometry(0.11, 14, 10).scale(1, 0.8, 1.2));
    for (const [x, z, k] of [[-0.2, 0.15, 1], [0.2, 0.0, 0.9], [-0.18, -0.2, 0.8], [0.17, -0.32, 0.7]] as const) {
      const o = mesh(body, sac, glow(ACID, 2.6), x, 0.2, z, 0, 0, 0, false);
      o.scale.setScalar(k);
      sacs.push(o);
    }
  }
  // head on a neck pivot so it can bob and thrust
  const head = pivot(body, 0, 0.05, 0.55);
  if (spitter) {
    // a swollen glowing throat that empties when it spits
    sacs.push(mesh(head, geo('tb-throat', () => new THREE.SphereGeometry(0.15, 16, 12).scale(1, 0.85, 1.1)), glow(ACID, 2.2), 0, -0.2, 0.18, 0, 0, 0, false));
  }
  mesh(head, geo('tb-skull', () => new THREE.SphereGeometry(0.27, 20, 14).scale(0.9, 0.82, 1.15)), m.fur, 0, 0, 0.1);
  // tapering snout ending in a leathery nose pad with nostrils
  mesh(head, geo('tb-snout', () => new THREE.CylinderGeometry(0.1, 0.16, 0.3, 14).rotateX(Math.PI / 2).scale(1.1, 0.9, 1)), m.hide, 0, -0.07, 0.36);
  mesh(head, geo('tb-nose', () => new THREE.SphereGeometry(0.11, 14, 10).scale(1.15, 0.85, 0.45)), m.hide, 0, -0.07, 0.51);
  for (const sx of [-1, 1]) mesh(head, geo('tb-nostril', () => new THREE.SphereGeometry(0.025, 8, 6)), m.hoof, sx * 0.045, -0.06, 0.555, 0, 0, 0, false);
  const tusk = geo('tb-tusk', () => new THREE.ConeGeometry(0.035, 0.26, 8).translate(0, 0.13, 0));
  for (const sx of [-1, 1]) {
    mesh(head, tusk, m.bone, sx * 0.12, -0.12, 0.42, -0.5, 0, -sx * 0.35);
    mesh(head, geo('tb-eye', () => new THREE.SphereGeometry(0.035, 10, 8)), glow(eye, 6), sx * 0.13, 0.07, 0.28, 0, 0, 0, false);
    mesh(head, geo('tb-ear', () => new THREE.ConeGeometry(0.07, 0.18, 6).translate(0, 0.09, 0)), m.fur, sx * 0.17, 0.16, 0.02, -0.7, 0, -sx * 0.6);
  }
  // four legs hanging from hip pivots
  const legs: THREE.Group[] = [];
  for (const [x, z] of [[-0.22, 0.32], [0.22, 0.32], [-0.22, -0.34], [0.22, -0.34]] as const) {
    const leg = pivot(body, x, -0.12, z);
    mesh(leg, geo('tb-thigh', () => new THREE.CapsuleGeometry(0.1, 0.22, 4, 10)), m.fur, 0, -0.14, 0);
    mesh(leg, geo('tb-shin', () => new THREE.CapsuleGeometry(0.065, 0.24, 4, 8)), m.hide, 0, -0.38, 0.02);
    mesh(leg, geo('tb-hoof', () => new THREE.CylinderGeometry(0.07, 0.085, 0.08, 10)), m.hoof, 0, -0.56, 0.03);
    legs.push(leg);
  }
  skinRigid(root, alpha ? 'thornback-alpha' : spitter ? 'thornback-spitter' : gilded ? 'thornback-gilded' : 'thornback', rig, sacs, bounds(1.25 * s));
  const sacSize = sacs.map((o) => o.scale.x);

  let phase = Math.random() * 10;
  let breath = Math.random() * 10;
  return {
    root,
    height: 1.25 * s,
    animate(u, dt, deathTime, wobble) {
      const speed = hypot(u.vx, u.vz);
      phase += dt * (3 + speed * 2.2);
      breath += dt * 2.2;
      const gait = Math.min(1, speed / 2);
      // trot: diagonal pairs swing together
      const sw = Math.sin(phase) * 0.7 * gait;
      legs[0]!.rotation.x = sw;
      legs[3]!.rotation.x = sw;
      legs[1]!.rotation.x = -sw;
      legs[2]!.rotation.x = -sw;
      body.position.y = 0.72 + Math.abs(Math.cos(phase)) * 0.05 * gait + Math.sin(breath) * 0.01;
      // gore: dip the head, then toss the tusks up
      const a = u.sinceAction;
      const gore = a < 0.45 ? Math.sin((a / 0.45) * Math.PI) : 0;
      head.rotation.x = gore * 0.55 - Math.sin(breath * 0.5) * 0.05 + (a < 0.2 ? 0.25 : 0) * (1 - a / 0.2);
      head.position.z = 0.55 + gore * 0.12;
      body.rotation.x = -gore * 0.08 + wobble * 0.05;
      // sacs swell between spits and empty in one squeeze as the acid flies
      const fill = (a < 0.25 ? 0.6 + a * 1.6 : 1) + Math.sin(breath * 1.6) * 0.06;
      sacs.forEach((o, i) => o.scale.setScalar(sacSize[i]! * (deathTime >= 0 ? Math.max(0.01, 1 - deathTime) : fill)));
      body.rotation.z = wobble * 0.08;
      if (deathTime >= 0) {
        // keel over on its side, then sink into the ground
        const t = Math.min(1, deathTime / 0.5);
        body.rotation.z = t * t * 1.5;
        body.position.y = 0.72 - t * 0.35 - Math.max(0, deathTime - 1.6) * 0.5;
        for (const l of legs) l.rotation.x *= 1 - t;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Warden

interface GiantOptions {
  /** Color of the heart, eyes and runes. */
  glow: number;
  /** Body material. */
  stone: THREE.Material;
  scale: number;
  /** The Colossus: a crown of basalt horns, spiked shoulders and a light in its chest. */
  molten?: boolean;
}

/**
 * Stone giants: the Warden, and at twice the size in molten basalt the
 * Molten Colossus. Same rig: stomping walk, two-fist slam, a crumbling death.
 */
function giant(o: GiantOptions): MonsterView {
  const lit = glow(o.glow, 5);
  const dim = glow(o.glow, 2.2);
  const stone = o.stone;
  const root = new THREE.Group();
  const body = pivot(root, 0, 0, 0);
  body.scale.setScalar(o.scale);
  const hips = pivot(body, 0, 1.25, 0);
  mesh(hips, geo('wd-pelvis', () => rock(0.66, 11)), stone, 0, 0, 0);
  const legs: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const leg = pivot(hips, sx * 0.55, -0.05, 0);
    mesh(leg, geo('wd-thigh', () => rock(0.46, 12).scale(1, 1.6, 1)), stone, 0, -0.45, 0);
    mesh(leg, geo('wd-foot', () => rock(0.5, 13).scale(1.1, 0.75, 1.35)), stone, 0, -1.0, 0.12);
    legs.push(leg);
  }
  // torso leans forward from the waist
  const torso = pivot(hips, 0, 0.25, 0);
  torso.rotation.x = 0.18;
  mesh(torso, geo('wd-chest', () => rock(1.05, 14).scale(1.3, 1.25, 0.95)), stone, 0, 0.9, 0);
  mesh(torso, geo('wd-back', () => rock(0.75, 15)), stone, 0, 1.35, -0.45);
  // the crystal heart in a ring of runes
  const heart = mesh(torso, geo('wd-heart', () => new THREE.OctahedronGeometry(0.26, 0).scale(0.8, 1.3, 0.6)), lit, 0, 0.95, 0.82, 0, 0, 0, false);
  const ring = mesh(torso, geo('wd-ring', () => new THREE.TorusGeometry(0.42, 0.035, 6, 32)), dim, 0, 0.95, 0.78, 0, 0, 0, false);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    mesh(torso, geo('wd-rune', () => new THREE.BoxGeometry(0.05, 0.16, 0.04)), dim, Math.cos(a) * 0.56, 0.95 + Math.sin(a) * 0.56, 0.72, 0, 0, a, false);
  }
  // small head sunk between the shoulders, with a glowing eye slit
  const head = pivot(torso, 0, 1.75, 0.35);
  mesh(head, geo('wd-head', () => rock(0.4, 16).scale(1, 1.05, 1)), stone, 0, 0, 0);
  mesh(head, geo('wd-brow', () => new THREE.BoxGeometry(0.46, 0.06, 0.08)), lit, 0, 0.03, 0.3, 0, 0, 0, false);
  // shards orbiting the head
  const orbit = pivot(head, 0, 0.35, 0);
  const shard = geo('wd-shard', () => new THREE.OctahedronGeometry(0.1, 0).scale(0.6, 1.6, 0.6));
  const shards = [0, 1, 2].map((i) => mesh(orbit, shard, lit, Math.cos((i / 3) * Math.PI * 2) * 0.7, 0, Math.sin((i / 3) * Math.PI * 2) * 0.7, 0, 0, 0, false));
  // arms: shoulder boulder, upper arm, forearm and a huge fist, with rune bands
  const arms: THREE.Group[] = [];
  // a soft halo instead of a real light: adding a light mid-match makes every lit shader recompile
  let core: THREE.Sprite | null = null;
  let embers: Embers | null = null;
  if (o.molten) {
    // a crown of basalt horns with molten tips, spiked shoulders, a fire in its chest
    const horn = geo('mc-horn', () => new THREE.ConeGeometry(0.11, 0.7, 7).translate(0, 0.35, 0));
    for (let i = 0; i < 5; i++) {
      const a = (i - 2) * 0.42;
      mesh(head, horn, stone, Math.sin(a) * 0.3, 0.3, -0.05 + Math.cos(a) * 0.05, -0.35, 0, -a * 0.9);
      mesh(head, geo('mc-horn-tip', () => new THREE.ConeGeometry(0.05, 0.2, 6).translate(0, 0.62, 0)), lit, Math.sin(a) * 0.3, 0.3, -0.05 + Math.cos(a) * 0.05, -0.35, 0, -a * 0.9, false);
    }
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 3; i++) mesh(torso, geo('mc-spike', () => new THREE.ConeGeometry(0.14, 0.75, 7).translate(0, 0.37, 0)), stone, sx * (1.15 + i * 0.18), 1.95 - i * 0.12, -0.1 - i * 0.12, -0.3, 0, -sx * (0.5 + i * 0.2));
    }
    embers = makeEmbers(body);
    core = new THREE.Sprite(emberMat!);
    core.position.set(0, 0.95, 0.95);
    torso.add(core);
  }
  for (const sx of [-1, 1]) {
    mesh(torso, geo('wd-shoulder', () => rock(0.66, 17)), stone, sx * 1.22, 1.5, 0);
    const arm = pivot(torso, sx * 1.35, 1.35, 0.05);
    arm.rotation.z = sx * 0.12;
    mesh(arm, geo('wd-upper', () => rock(0.44, 18).scale(1, 1.9, 1)), stone, 0, -0.55, 0);
    mesh(arm, geo('wd-band', () => new THREE.TorusGeometry(0.36, 0.035, 6, 24).rotateX(Math.PI / 2)), dim, 0, -0.85, 0, 0, 0, 0, false);
    mesh(arm, geo('wd-fore', () => rock(0.5, 19).scale(1, 1.7, 1)), stone, 0, -1.3, 0.05);
    mesh(arm, geo('wd-fist', () => rock(0.64, 20).scale(1.05, 0.95, 1.1)), stone, 0, -1.95, 0.1);
    arms.push(arm);
  }
  skinRigid(root, o.molten ? 'colossus' : 'warden', body, [heart, ring, ...shards], bounds(3.6 * o.scale));

  let phase = Math.random() * 10;
  let t = Math.random() * 10;
  let raise = 0;
  return {
    root,
    height: 3.6 * o.scale,
    animate(u, dt, deathTime, wobble) {
      t += dt;
      // a boss's area attack: crouch and raise both fists high, then smash
      const special = u.brain instanceof MonsterBrain ? u.brain.specialProgress : 0;
      const speed = hypot(u.vx, u.vz);
      const gait = Math.min(1, speed / 1.5);
      phase += dt * (1.5 + speed * 1.4);
      // heavy stomping walk with a side-to-side sway
      legs[0]!.rotation.x = Math.sin(phase) * 0.45 * gait;
      legs[1]!.rotation.x = -Math.sin(phase) * 0.45 * gait;
      hips.position.y = 1.25 + Math.abs(Math.cos(phase)) * 0.08 * gait + Math.sin(t * 1.3) * 0.03;
      torso.rotation.z = Math.sin(phase) * 0.06 * gait + wobble * 0.03;
      // slam: raise both fists overhead during the windup, then bring them down
      const a = u.sinceAction;
      const goal = u.windup > 0 || special > 0 ? 1 : 0;
      raise += (goal - raise) * (1 - Math.exp(-dt * (goal ? 9 : 26)));
      const smash = a < 0.35 ? Math.sin((a / 0.35) * Math.PI) : 0;
      for (const [i, arm] of arms.entries()) {
        const sx = i === 0 ? -1 : 1;
        const swing = Math.sin(phase + i * Math.PI) * 0.35 * gait;
        arm.rotation.x = -raise * (2.6 + special * 0.4) + smash * 0.7 + swing;
        arm.rotation.z = sx * (0.12 + raise * 0.3 - special * 0.2);
      }
      torso.rotation.x = 0.18 - raise * 0.25 + smash * 0.35 - special * 0.15;
      hips.position.y -= special * 0.25;
      core?.scale.setScalar(1.3 + raise * 0.9 + Math.sin(t * 5) * 0.12);
      embers?.step(dt, deathTime >= 0 ? 0 : 1 + raise * 2);
      // living crystal: the heart pulses, the shards orbit, the head looks about
      const pulse = 1 + Math.sin(t * 3) * 0.08 + raise * 0.25;
      heart.scale.setScalar(pulse);
      heart.rotation.y = t * 0.8;
      ring.rotation.z = t * 0.4;
      orbit.rotation.y = t * 1.2;
      for (const [i, s] of shards.entries()) s.position.y = Math.sin(t * 2 + i * 2) * 0.12;
      head.rotation.y = Math.sin(t * 0.4) * 0.25 * (1 - gait);
      if (deathTime >= 0) {
        // crumble: the body slumps and sinks, the arms drop, the light goes out
        const k = Math.min(1, deathTime / 1.1);
        hips.position.y = 1.25 - k * k * 1.0 - Math.max(0, deathTime - 1.4) * 0.8;
        torso.rotation.x = 0.18 + k * 0.7;
        for (const arm of arms) arm.rotation.x = k * 0.8;
        heart.scale.setScalar(Math.max(0.01, 1 - k));
        core?.scale.setScalar(Math.max(0.001, 1.3 * (1 - k)));
        // (the shards are skinned: shrink them away rather than hiding the pivot)
        orbit.scale.setScalar(k < 0.4 ? 1 : 1e-4);
      } else orbit.scale.setScalar(1);
    },
  };
}

// ---------------------------------------------------------------------------
// Molten Colossus material

const EMBERS = 26;
let emberMat: THREE.SpriteNodeMaterial | null = null;
let sparkMat: THREE.SpriteNodeMaterial | null = null;

/** A soft molten spark; `at`, when given, places each instance (xyz, size). */
function emberMaterial(at?: any): THREE.SpriteNodeMaterial {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const r = uv().sub(0.5).length().mul(2);
  const f = smoothstep(1, 0, r).pow(2);
  m.colorNode = vec4(vec3(1, 0.42, 0.08).mul(6).add(smoothstep(0.3, 0, r).mul(4)).mul(f), 1);
  m.opacityNode = f;
  if (at) {
    m.positionNode = at.xyz;
    m.scaleNode = vec2(at.w, at.w);
  }
  return m;
}

interface Embers {
  /** Advance the sparks; `rate` scales how fast they rise and how many show (0 lets them die out). */
  step(dt: number, rate: number): void;
}

/** Sparks that drift up off the Colossus's body and wink out, all in one draw. */
function makeEmbers(parent: THREE.Object3D): Embers {
  emberMat ??= emberMaterial();
  sparkMat ??= emberMaterial(attribute('spark', 'vec4'));
  const sprite = new THREE.Sprite(sparkMat);
  sprite.geometry = spriteQuads(EMBERS, true);
  // each spark's xyz (in `parent`'s space) and size; a hidden one has size 0
  const at = new THREE.InstancedBufferAttribute(new Float32Array(EMBERS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  sprite.geometry.setAttribute('spark', at);
  sprite.frustumCulled = false;
  parent.add(sprite);
  const sparks = Array.from({ length: EMBERS }, () => ({ age: Math.random() * 2.5, life: 1.6 + Math.random() * 1.4, x: 0, y: 0, z: 0, vx: 0, vz: 0 }));
  const respawn = (p: (typeof sparks)[number]) => {
    const a = Math.random() * Math.PI * 2;
    const r = 0.5 + Math.random() * 1.1;
    p.x = Math.cos(a) * r;
    p.z = Math.sin(a) * r * 0.7;
    p.y = 0.6 + Math.random() * 2.2;
    p.vx = (Math.random() - 0.5) * 0.3;
    p.vz = (Math.random() - 0.5) * 0.3;
    p.age = 0;
  };
  for (const p of sparks) respawn(p);
  return {
    step(dt, rate) {
      for (const [i, p] of sparks.entries()) {
        p.age += dt * Math.max(0.5, rate);
        if (p.age > p.life) {
          if (rate <= 0) {
            at.setW(i, 0);
            continue;
          }
          respawn(p);
        }
        const k = p.age / p.life;
        // flare in, then shrink to nothing
        at.setXYZW(i, p.x + p.vx * p.age + Math.sin(p.age * 3 + p.life) * 0.08, p.y + p.age * 0.9, p.z + p.vz * p.age, 0.14 * Math.min(1, k * 6) * (1 - k));
      }
      at.needsUpdate = true;
    },
  };
}

let lava: THREE.Material | null = null;

/** Black basalt split by a network of glowing molten cracks that throb slowly. */
function lavaStone(): THREE.Material {
  if (lava) return lava;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  // object space, so the cracks stay put on the Colossus's body as it moves
  const p = positionGeometry;
  const basalt = mix(vec3(0.05, 0.04, 0.04), vec3(0.17, 0.13, 0.12), n(2.5, p).mul(0.7).add(n(11, p).mul(0.3)));
  // noise zero-crossings make a branching crack network; a finer octave adds hairline cracks
  const wide = smoothstep(0.06, 0.0, abs(mx_noise_float(p.mul(0.9))));
  const fine = smoothstep(0.03, 0.0, abs(mx_noise_float(p.mul(2.6).add(7)))).mul(0.45);
  const crack = wide.add(fine).clamp(0, 1);
  const throb = sin(time.mul(1.8).add(n(0.6, p).mul(6))).mul(0.25).add(0.85);
  m.colorNode = mix(basalt, vec3(1, 0.45, 0.12), crack.mul(0.6));
  m.emissiveNode = mix(vec3(1, 0.22, 0.02), vec3(1, 0.7, 0.25), crack.pow(3)).mul(crack.mul(throb).mul(4));
  m.roughnessNode = float(0.92).sub(crack.mul(0.4));
  return (lava = m);
}

// ---------------------------------------------------------------------------
// Treasure Wyrm

const WYRM_SEGMENTS = 36;
const FORWARD = new THREE.Vector3(0, 0, 1);
/** Where the coil ends and the neck rises, along the body (0 = tail tip, 1 = head). */
const COIL_END = 0.62;

/** Body thickness along the wyrm: a thin tail, a heavy coil, a tapering neck. */
function wyrmRadius(s: number): number {
  if (s < COIL_END) return 0.12 + 0.68 * Math.min(1, s / 0.45) ** 0.7;
  return 0.8 - ((s - COIL_END) / (1 - COIL_END)) * 0.3;
}

function bezier(out: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, t: number): THREE.Vector3 {
  const u = 1 - t;
  return out
    .copy(a)
    .multiplyScalar(u * u * u)
    .addScaledVector(b, 3 * u * u * t)
    .addScaledVector(c, 3 * u * t * t)
    .addScaledVector(d, t * t * t);
}

let wyrmMats: ReturnType<typeof wyrmMaterials> | null = null;

/**
 * The Treasure Wyrm's scales and ivory, built once: a material made anew for
 * each wyrm gets a shader of its own, so the boss would build one as it rose
 * instead of reusing the one the loading warm-up drew.
 */
function wyrmMaterials() {
  const scales = new THREE.MeshPhysicalNodeMaterial({ metalness: 0.8, roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.3 });
  // object space: the coils move every frame, and world-space scales would slide across them
  const cell = mx_worley_noise_float(positionGeometry.mul(3.2));
  const rim = smoothstep(0.15, 0.55, cell);
  const belly = smoothstep(-0.05, -0.45, normalWorld.y);
  const gold = mix(vec3(1, 0.8, 0.32), vec3(0.5, 0.27, 0.06), rim);
  scales.colorNode = mix(gold, vec3(0.95, 0.86, 0.62), belly.mul(0.85));
  scales.roughnessNode = float(0.22).add(rim.mul(0.3)).add(belly.mul(0.3));
  scales.metalnessNode = float(0.9).sub(belly.mul(0.6));
  const ivory = new THREE.MeshStandardNodeMaterial({ color: 0xf2e6c8, roughness: 0.4 });
  return { scales, ivory };
}

/**
 * A great golden serpent coiled on its hoard: overlapping gold scales with a
 * cream belly, turquoise crystal fins down its spine, a horned head with a
 * ruby set in its brow. It sways, lunges to bite, lifts its tail and whirls
 * for its sweep, and slumps onto its coils when slain.
 */
function wyrm(): MonsterView {
  const { scales, ivory } = (wyrmMats ??= wyrmMaterials());
  const fin = glow(0x2fe8d0, 2.6);
  const finHot = glow(0x8ffff0, 4);
  const ruby = glow(0xff2a4a, 5);

  const root = new THREE.Group();
  const body = pivot(root, 0, 0, 0);
  const seg = geo('wy-seg', () => new THREE.SphereGeometry(1, 20, 14));
  const finGeo = geo('wy-fin', () => new THREE.ConeGeometry(0.16, 1, 4).translate(0, 0.5, 0).scale(0.5, 1, 1.6));
  const segs = Array.from({ length: WYRM_SEGMENTS }, () => mesh(body, seg, scales));
  const fins = segs.map((_, i) => (i % 2 === 0 && i > 2 ? mesh(body, finGeo, i > WYRM_SEGMENTS * 0.8 ? finHot : fin, 0, 0, 0, 0, 0, 0, false) : null));

  // the head: skull, snout, jaw on a hinge, horns, frills, eyes and the brow ruby (front is +Z)
  const head = pivot(body, 0, 0, 0);
  mesh(head, geo('wy-skull', () => new THREE.SphereGeometry(0.62, 22, 16).scale(0.95, 0.75, 1.15)), scales, 0, 0.05, 0);
  mesh(head, geo('wy-snout', () => new THREE.SphereGeometry(0.42, 18, 12).scale(0.85, 0.55, 1.6)), scales, 0, 0.0, 0.75);
  mesh(head, geo('wy-brow', () => new THREE.SphereGeometry(0.2, 10, 8).scale(1, 0.6, 1)), ruby, 0, 0.42, 0.3, 0, 0, 0, false);
  for (const sx of [-1, 1]) {
    mesh(head, geo('wy-eye', () => new THREE.SphereGeometry(0.09, 10, 8).scale(1, 0.7, 1.3)), finHot, sx * 0.4, 0.2, 0.45, 0, 0, 0, false);
    const horn = geo('wy-horn', () => new THREE.ConeGeometry(0.11, 1.5, 9).translate(0, 0.75, 0));
    mesh(head, horn, ivory, sx * 0.32, 0.35, -0.25, -1.9, 0, -sx * 0.35);
    mesh(head, geo('wy-horn2', () => new THREE.ConeGeometry(0.07, 0.8, 8).translate(0, 0.4, 0)), ivory, sx * 0.5, 0.15, -0.3, -1.7, 0, -sx * 0.9);
    // crystal frills fanning back from the jaw
    for (let i = 0; i < 3; i++) mesh(head, finGeo, fin, sx * 0.55, -0.05 - i * 0.12, -0.15 - i * 0.1, -1.4 - i * 0.15, 0, -sx * (1.1 + i * 0.25), false).scale.set(1, 0.7 - i * 0.12, 0.6);
    for (let i = 0; i < 4; i++) mesh(head, geo('wy-tooth', () => new THREE.ConeGeometry(0.035, 0.16, 6)), ivory, sx * (0.12 + i * 0.07), -0.2, 1.15 - i * 0.18, Math.PI, 0, 0);
  }
  const jaw = pivot(head, 0, -0.15, 0.15);
  mesh(jaw, geo('wy-jaw', () => new THREE.SphereGeometry(0.36, 16, 10).scale(0.85, 0.35, 1.7)), scales, 0, -0.1, 0.5);
  for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) mesh(jaw, geo('wy-tooth', () => new THREE.ConeGeometry(0.035, 0.16, 6)), ivory, sx * (0.12 + i * 0.07), 0.02, 0.95 - i * 0.18);
  skinRigid(root, 'wyrm', root, [...segs, ...fins.filter((f) => f !== null)], bounds(5.6));

  const P = Array.from({ length: WYRM_SEGMENTS }, () => new THREE.Vector3());
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const up = new THREE.Vector3();
  const side = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  let t = Math.random() * 10;
  let bite = 0;
  let spin = 0;
  return {
    root,
    height: 5.6,
    animate(u, dt, deathTime, wobble) {
      t += dt;
      const special = u.brain instanceof MonsterBrain ? u.brain.specialProgress : 0;
      const since = u.sinceAction;
      // bite: wind up (rear back) then lunge forward and down
      const goal = u.windup > 0 ? -0.4 : since < 0.35 ? Math.sin((since / 0.35) * Math.PI) : 0;
      bite += (goal - bite) * (1 - Math.exp(-dt * 14));
      // tail sweep: after the special lands, the whole wyrm whirls once
      const whirl = since < 0.6 && special === 0 && u.windup <= 0 && spin > 0 ? since / 0.6 : 0;
      if (special > 0) spin = 1;
      if (since >= 0.6) spin = 0;
      body.rotation.y = whirl > 0 ? (1 - (1 - whirl) ** 3) * Math.PI * 2 : 0;
      const dead = deathTime >= 0 ? Math.min(1, deathTime / 1.2) : 0;
      // the coil, spiraling out from the tail tip to the back of the hoard
      const coilN = Math.round(WYRM_SEGMENTS * COIL_END);
      for (let i = 0; i < coilN; i++) {
        const s = i / (WYRM_SEGMENTS - 1);
        const k = s / COIL_END;
        const phi = Math.PI - (1 - k) * Math.PI * 2 * 1.45;
        const R = 0.9 + 2.7 * k;
        const lift = special * Math.max(0, 1 - k * 2.2) * 2.2 + Math.sin(t * 2 + k * 9) * 0.05 * (1 - k);
        P[i]!.set(Math.sin(phi) * R, wyrmRadius(s) * 0.85 + lift * (1 - dead), Math.cos(phi) * R);
      }
      // the neck: a curve rising from the back of the coil, swaying, lunging for bites
      const end = P[coilN - 1]!;
      a.copy(end);
      b.set(end.x - 2, end.y + 0.6, end.z + 0.4);
      c.set(-0.4 + Math.sin(t * 0.9) * 0.5 + wobble * 0.1, 5.6 - special * 0.6, -1.2 + bite * 1.0 - special * 0.8);
      d.set(Math.sin(t * 1.1) * 0.4, 4.7 - bite * 1.9 + special * 0.6 + Math.sin(t * 1.7) * 0.15, 1.4 + bite * 2.3 - special * 1.2);
      if (dead > 0) {
        // slump: the neck falls forward across the coils
        c.lerp(b.clone().setY(0.9), dead);
        d.lerp(new THREE.Vector3(d.x, 0.7, 3.2), dead);
      }
      for (let i = coilN; i < WYRM_SEGMENTS; i++) {
        const k = (i - coilN + 1) / (WYRM_SEGMENTS - coilN);
        bezier(P[i]!, a, b, c, d, k);
      }
      // place each scale segment along the curve, stretched along it so they overlap
      for (let i = 0; i < WYRM_SEGMENTS; i++) {
        const p = P[i]!;
        tan.subVectors(P[Math.min(WYRM_SEGMENTS - 1, i + 1)]!, P[Math.max(0, i - 1)]!).normalize();
        up.set(0, 1, 0);
        if (Math.abs(tan.y) > 0.9) up.set(0, 0, -1);
        side.crossVectors(up, tan).normalize();
        up.crossVectors(tan, side).normalize();
        basis.makeBasis(side, up, tan);
        const r = wyrmRadius(i / (WYRM_SEGMENTS - 1));
        const sm = segs[i]!;
        sm.position.copy(p);
        sm.quaternion.setFromRotationMatrix(basis);
        sm.scale.set(r, r * 0.92, r * 1.55);
        const f = fins[i];
        if (f) {
          f.position.copy(p).addScaledVector(up, r * 0.8);
          f.quaternion.setFromRotationMatrix(basis);
          f.rotateX(-0.5);
          f.scale.setScalar(0.5 + r * 1.1);
        }
      }
      // the head rides the end of the neck, looking along it and a little down
      const last = P[WYRM_SEGMENTS - 1]!;
      tan.subVectors(last, P[WYRM_SEGMENTS - 2]!).normalize();
      head.position.copy(last).addScaledVector(tan, 0.4);
      // (in the body's own frame: lookAt would want world space)
      head.quaternion.setFromUnitVectors(FORWARD, tan.setY(tan.y * 0.3 - 0.35).normalize());
      jaw.rotation.x = Math.max(0, bite) * 0.7 + Math.max(0, -bite) * 0.4 + special * 0.5 + (dead > 0 ? 0.3 : 0);
      root.position.y = -Math.max(0, deathTime - 1.8) * 0.6;
    },
  };
}

// ---------------------------------------------------------------------------
// Shade

/** How high a Shade's hem floats over the floor. */
const SHADE_HOVER = 0.45;
let shadeRobe: THREE.Material | null = null;

/**
 * Near-black cloth lit from inside: violet soul fire flickers up from the
 * hem and a cold rim of the same light runs along every edge. In the rig's
 * space (the Shade's height), so the fire stays on the cloth as it drifts.
 */
function shadeRobeMaterial(): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, side: THREE.DoubleSide });
  const p = positionGeometry;
  const weave = mx_noise_float(vec3(p.x.mul(9), p.y.mul(2.2), p.z.mul(9))).mul(0.5).add(0.5);
  m.colorNode = mix(vec3(0.008, 0.006, 0.016), vec3(0.045, 0.03, 0.07), weave);
  const flame = mx_noise_float(vec3(p.x.mul(5), p.y.mul(3.5).sub(time.mul(1.8)), p.z.mul(5))).mul(0.5).add(0.5);
  const hem = smoothstep(1.05, 0.2, p.y.add(flame.mul(0.4)));
  const rim = pow(float(1).sub(saturate(normalView.dot(positionView.normalize().negate()))), 4);
  const fire = vec3(0.52, 0.34, 1);
  m.emissiveNode = fire.mul(hem.mul(hem).mul(3.4).add(rim.mul(0.35)));
  return m;
}

/**
 * Cloth turned on a lathe from (radius, height) pairs, its lower edge torn
 * into tails: the bottom rings hang down in points around the hem.
 */
function tattered(profile: readonly (readonly [number, number])[], tails: number, depth: number, seed: number, around = 40, phiStart = 0, phiLength = Math.PI * 2): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), around, phiStart, phiLength);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const low = Math.min(...profile.map(([, y]) => y));
  const high = Math.max(...profile.map(([, y]) => y));
  const reach = (high - low) * 0.35;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const a = Math.atan2(x, z);
    const k = Math.max(0, 1 - (y - low) / reach);
    // pointed tails of uneven length, and a ripple through the cloth
    const tail = Math.max(0, Math.sin(a * tails + seed)) ** 0.7 * (0.65 + 0.35 * Math.sin(a * 3 + seed * 2.1));
    const ripple = 1 + Math.sin(a * 5 + y * 4 + seed) * 0.05 * (0.4 + k);
    p.setXYZ(i, x * ripple, y - tail * depth * k * k, z * ripple);
  }
  g.computeVertexNormals();
  return g;
}

function shade(): MonsterView {
  const robe = (shadeRobe ??= shadeRobeMaterial());
  const fire = glow(SHADE_GLOW, 2);
  const root = new THREE.Group();
  const s = 1.15;
  const rig = pivot(root, 0, 0, 0);
  rig.scale.setScalar(s);
  const body = pivot(rig, 0, SHADE_HOVER, 0);
  // two layers of robe, the inner one's longer tails showing between the outer's
  const outer = geo('sh-robe', () => tattered([[0.6, 0], [0.58, 0.06], [0.53, 0.18], [0.43, 0.42], [0.33, 0.72], [0.3, 0.98], [0.33, 1.16], [0.2, 1.3], [0.08, 1.36]], 7, 0.34, 0.4));
  const inner = geo('sh-robe-in', () => tattered([[0.51, -0.06], [0.5, 0.02], [0.47, 0.15], [0.38, 0.4], [0.29, 0.7], [0.26, 1.0]], 9, 0.42, 2.3));
  mesh(body, outer, robe);
  mesh(body, inner, robe, 0, 0, 0, 0, 0.35, 0);
  // a ragged mantle over the shoulders
  mesh(body, geo('sh-mantle', () => tattered([[0.47, 0.96], [0.46, 1.02], [0.42, 1.14], [0.3, 1.3], [0.12, 1.4]], 6, 0.16, 1.1, 32)), robe);
  // the hood: open at the front onto a black void with two eyes burning in it
  const head = pivot(body, 0, 1.47, 0.04);
  const open = 1.5;
  mesh(head, geo('sh-hood', () => new THREE.SphereGeometry(0.26, 24, 16, Math.PI / 2 + open / 2, Math.PI * 2 - open, 0, Math.PI * 0.78).scale(1, 1.18, 1.12)), robe);
  mesh(head, geo('sh-hood-tip', () => new THREE.ConeGeometry(0.15, 0.34, 12).rotateX(-1.9).translate(0, 0.12, -0.22)), robe);
  mesh(head, geo('sh-void', () => new THREE.SphereGeometry(0.22, 18, 12).scale(0.95, 1.1, 1)), glow(0x000000, 0), 0, -0.02, -0.03, 0, 0, 0, false);
  const eyes: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const e = mesh(head, geo('sh-eye', () => new THREE.SphereGeometry(0.034, 10, 8).scale(1.5, 0.6, 0.6)), glow(SHADE_CORE, 5), sx * 0.085, -0.02, 0.205, 0, 0, sx * 0.25, false);
    eyes.push(e);
  }
  // bell sleeves on shoulder pivots, spectral claws reaching out of them
  const arms: THREE.Group[] = [];
  const sleeve = geo('sh-sleeve', () => tattered([[0.15, -0.6], [0.12, -0.42], [0.08, -0.15], [0.07, 0]], 5, 0.12, 0.9, 20));
  const claw = geo('sh-claw', () => new THREE.ConeGeometry(0.022, 0.26, 6).translate(0, -0.13, 0));
  for (const sx of [-1, 1]) {
    const arm = pivot(body, sx * 0.31, 1.2, 0.02);
    mesh(arm, sleeve, robe);
    for (let i = 0; i < 4; i++) mesh(arm, claw, fire, sx * (i - 1.5) * 0.04, -0.6, 0.02, 0.25 - Math.abs(i - 1.5) * 0.1, 0, sx * (i - 1.5) * 0.16, false);
    arms.push(arm);
  }
  // the soul it gathers between its claws, swelling until it throws
  const orb = mesh(body, geo('sh-orb', () => new THREE.SphereGeometry(0.12, 16, 12)), glow(SHADE_CORE, 5), 0, 0.92, 0.5, 0, 0, 0, false);
  // wisps of soul fire trailing from under the hem
  const trails: THREE.Group[] = [];
  const trail = geo('sh-trail', () => new THREE.ConeGeometry(0.06, 0.6, 7).rotateX(Math.PI).translate(0, -0.3, 0));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const t = pivot(body, Math.sin(a) * 0.3, 0.1, Math.cos(a) * 0.3);
    mesh(t, trail, fire, 0, 0, 0, 0, 0, 0, false);
    trails.push(t);
  }
  skinRigid(root, 'shade', rig, [...eyes, orb], bounds(2.3 * s));

  let clock = Math.random() * 10;
  let lean = 0;
  let appear = 1;
  let lastX = NaN;
  let lastZ = NaN;
  return {
    root,
    height: 2.2 * s,
    linger: 2.4,
    animate(u, dt, deathTime, wobble) {
      clock += dt;
      lean += (Math.min(1, hypot(u.vx, u.vz) / 4) - lean) * Math.min(1, dt * 5);
      // a blink: it folds into its own fire and unfolds where it lands
      if (hypot(u.x - lastX, u.z - lastZ) > 3) appear = 0;
      lastX = u.x;
      lastZ = u.z;
      appear = Math.min(1, appear + dt / 0.3);
      const k = 1 - (1 - appear) ** 2;
      rig.scale.set(s * (0.35 + 0.65 * k), s * (0.15 + 0.85 * k), s * (0.35 + 0.65 * k));
      rig.rotation.y = (1 - k) * 3;
      body.position.y = SHADE_HOVER + Math.sin(clock * 1.7) * 0.07;
      body.rotation.x = lean * 0.3 + wobble * 0.06;
      body.rotation.z = Math.sin(clock * 1.1) * 0.035 + wobble * 0.08;
      // the throw: both claws thrust forward as the soul leaves, then it gathers another
      const a = u.sinceAction;
      const thrust = a < 0.45 ? Math.sin(Math.min(1, a / 0.45) * Math.PI) : 0;
      const fill = Math.min(1, a / 1.1);
      orb.scale.setScalar(0.2 + 0.8 * fill * fill + Math.sin(clock * 9) * 0.06);
      orb.position.z = 0.5 + thrust * 0.25;
      arms.forEach((arm, i) => {
        const sx = i ? 1 : -1;
        arm.rotation.x = -0.95 - thrust * 0.55 + Math.sin(clock * 1.7 + i) * 0.05;
        arm.rotation.z = -sx * 0.12 * (1 - thrust * 0.5);
      });
      head.rotation.x = 0.12 - thrust * 0.15 + Math.sin(clock * 0.9) * 0.04;
      trails.forEach((t, i) => {
        t.rotation.x = lean * 0.8 + Math.sin(clock * 3 + i * 1.7) * 0.2;
        t.rotation.z = Math.sin(clock * 2.3 + i) * 0.18;
        t.scale.y = 0.8 + Math.sin(clock * 4 + i * 2.1) * 0.25;
      });
      if (deathTime >= 0) {
        // it collapses into its robe and the fire inside goes out
        const t = Math.min(1, deathTime / 0.8);
        body.position.y = SHADE_HOVER * (1 - t) - Math.max(0, deathTime - 1.3) * 0.5;
        rig.scale.y = s * (1 - t * 0.75);
        rig.rotation.y = t * t * 0.8;
        orb.scale.setScalar(Math.max(0.01, 1 - t * 2));
        for (const e of eyes) e.scale.setScalar(Math.max(0.01, 1 - t * 1.5));
        for (const arm of arms) arm.rotation.x = -0.95 * (1 - t) - 0.2 * t;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Gravekeeper

let keeperShroud: THREE.Material | null = null;

/** Grave linen: pale, coarse and fraying, grimed darker toward its hem. */
function keeperShroudMaterial(): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, side: THREE.DoubleSide });
  const p = positionGeometry;
  const weave = mx_noise_float(vec3(p.x.mul(16), p.y.mul(5), p.z.mul(16))).mul(0.5).add(0.5);
  const grime = smoothstep(1.1, 0.35, p.y.add(n(6).sub(0.5).mul(0.3)));
  m.colorNode = mix(vec3(0.2, 0.19, 0.15), vec3(0.05, 0.05, 0.035), grime.mul(0.75).add(weave.mul(0.25)));
  return m;
}

/** A bone from `a` toward `b` (a tapered cylinder), as a child of `parent`. */
function bone(parent: THREE.Object3D, m: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, r0: number, r1 = r0 * 0.8): THREE.Mesh {
  const len = a.distanceTo(b);
  const key = `gk-bone-${len.toFixed(2)}-${r0.toFixed(3)}-${r1.toFixed(3)}`;
  const o = mesh(parent, geo(key, () => new THREE.CylinderGeometry(r1, r0, len, 7).translate(0, len / 2, 0)), m, a.x, a.y, a.z);
  o.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  return o;
}
const UP = new THREE.Vector3(0, 1, 0);
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function gravekeeper(): MonsterView {
  const ivory = (wyrmMats ??= wyrmMaterials()).ivory;
  const iron = mats().hoof;
  const shroud = (keeperShroud ??= keeperShroudMaterial());
  const flameMat = glow(KEEPER_GLOW, 6);
  const root = new THREE.Group();
  const s = 1.15;
  const rig = pivot(root, 0, 0, 0);
  rig.scale.setScalar(s);
  const HIP = 0.78;
  const hips = pivot(rig, 0, HIP, 0);
  mesh(hips, geo('gk-pelvis', () => new THREE.SphereGeometry(0.11, 14, 10).scale(1.35, 0.7, 0.85)), ivory);
  // rags about the hips
  mesh(hips, geo('gk-rags', () => tattered([[0.25, -0.42], [0.23, -0.22], [0.2, -0.06], [0.16, 0.04]], 6, 0.16, 0.7, 28)), shroud);
  // legs: hip and knee pivots, a bent stance
  const thighs: THREE.Group[] = [];
  const knees: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const hip = pivot(hips, sx * 0.1, -0.02, 0);
    bone(hip, ivory, v3(0, 0, 0), v3(0, -0.4, 0), 0.03, 0.024);
    const knee = pivot(hip, 0, -0.4, 0);
    mesh(knee, geo('gk-kneecap', () => new THREE.SphereGeometry(0.036, 10, 8)), ivory, 0, 0, 0.01);
    bone(knee, ivory, v3(0, 0, 0), v3(0, -0.4, 0), 0.025, 0.02);
    mesh(knee, geo('gk-foot', () => new THREE.SphereGeometry(0.05, 10, 8).scale(0.9, 0.5, 2.1)), ivory, 0, -0.41, 0.06);
    thighs.push(hip);
    knees.push(knee);
  }
  // a hunched spine and an open ribcage, an ember of its soul inside
  const torso = pivot(hips, 0, 0.05, 0);
  for (let i = 0; i < 7; i++) mesh(torso, geo('gk-vertebra', () => new THREE.SphereGeometry(0.034, 10, 8).scale(1.2, 0.8, 1)), ivory, 0, 0.05 + i * 0.075, -0.06 - Math.sin((i / 6) * Math.PI) * 0.04);
  const ribs = [0.12, 0.145, 0.155, 0.15, 0.125];
  ribs.forEach((r, i) => {
    const g = geo(`gk-rib-${r}`, () => new THREE.TorusGeometry(r, 0.013, 6, 20, Math.PI * 1.65).rotateX(Math.PI / 2).rotateY(Math.PI * 1.325).scale(1, 1, 0.82));
    mesh(torso, g, ivory, 0, 0.22 + i * 0.065, 0.02, 0.18, 0, 0);
  });
  const ember = mesh(torso, geo('gk-ember', () => new THREE.SphereGeometry(0.05, 12, 10)), glow(KEEPER_GLOW, 3.5), 0, 0.33, 0.02, 0, 0, 0, false);
  bone(torso, ivory, v3(-0.2, 0.55, -0.02), v3(0.2, 0.55, -0.02), 0.018, 0.018);
  // a ragged cloak over the back
  mesh(torso, geo('gk-cloak', () => tattered([[0.42, -0.25], [0.36, 0.08], [0.31, 0.36], [0.26, 0.56], [0.16, 0.62]], 7, 0.22, 2.2, 28, Math.PI * 0.5, Math.PI)), shroud);
  // the skull, antlered, its jaw on a hinge and two embers deep in its sockets
  const head = pivot(torso, 0, 0.66, 0.04);
  mesh(head, geo('gk-skull', () => new THREE.SphereGeometry(0.115, 18, 14).scale(0.9, 1, 1.05)), ivory, 0, 0.08, 0);
  mesh(head, geo('gk-maxilla', () => new THREE.SphereGeometry(0.07, 14, 10).scale(1, 0.62, 1.05)), ivory, 0, 0.0, 0.07);
  const jaw = pivot(head, 0, 0.01, 0.0);
  mesh(jaw, geo('gk-jaw', () => new THREE.SphereGeometry(0.068, 12, 8, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55).scale(1, 0.7, 1.15)), ivory, 0, -0.01, 0.06);
  const eyes: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    mesh(head, geo('gk-socket', () => new THREE.SphereGeometry(0.03, 10, 8)), glow(0x000000, 0), sx * 0.043, 0.075, 0.088, 0, 0, 0, false);
    eyes.push(mesh(head, geo('gk-eye', () => new THREE.SphereGeometry(0.012, 8, 6)), glow(KEEPER_CORE, 6), sx * 0.043, 0.075, 0.108, 0, 0, 0, false));
    // antlers: a sweeping beam with two tines
    const o = v3(sx * 0.07, 0.16, -0.03);
    const d = v3(sx * 0.62, 0.72, -0.32).normalize();
    bone(head, ivory, o, o.clone().addScaledVector(d, 0.34), 0.022, 0.01);
    for (const [at, len] of [[0.12, 0.13], [0.24, 0.1]] as const) {
      const b = o.clone().addScaledVector(d, at);
      bone(head, ivory, b, b.clone().add(v3(sx * 0.03, len, len * 0.45)), 0.011, 0.005);
    }
  }
  // arms: the right holds the staff, the left reaches out with its claws
  const shoulders: THREE.Group[] = [];
  const elbows: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const sh = pivot(torso, sx * 0.19, 0.53, -0.01);
    bone(sh, ivory, v3(0, 0, 0), v3(0, -0.3, 0), 0.022, 0.018);
    const el = pivot(sh, 0, -0.3, 0);
    bone(el, ivory, v3(0, 0, 0), v3(0, -0.27, 0), 0.018, 0.014);
    for (let i = 0; i < 3; i++) bone(el, ivory, v3((i - 1) * 0.015, -0.27, 0), v3((i - 1) * 0.03, -0.37, 0.03), 0.007, 0.003);
    shoulders.push(sh);
    elbows.push(el);
  }
  // the staff, with a crook at the top and the lantern swinging from it
  const staff = pivot(elbows[1]!, 0, -0.27, 0);
  mesh(staff, geo('gk-staff', () => new THREE.CylinderGeometry(0.016, 0.022, 1.75, 7).translate(0, 0.32, 0)), iron);
  mesh(staff, geo('gk-crook', () => new THREE.TorusGeometry(0.09, 0.016, 6, 14, Math.PI).rotateY(Math.PI / 2).translate(0, 1.195, 0.09)), iron);
  const lantern = pivot(staff, 0, 1.2, 0.18);
  mesh(lantern, geo('gk-chain', () => new THREE.CylinderGeometry(0.005, 0.005, 0.12, 4).translate(0, -0.06, 0)), iron, 0, 0, 0, 0, 0, 0, false);
  mesh(lantern, geo('gk-cap', () => new THREE.ConeGeometry(0.07, 0.06, 6).translate(0, -0.15, 0)), iron);
  mesh(lantern, geo('gk-base', () => new THREE.CylinderGeometry(0.055, 0.06, 0.02, 6).translate(0, -0.36, 0)), iron);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    mesh(lantern, geo('gk-bar', () => new THREE.CylinderGeometry(0.005, 0.005, 0.2, 4).translate(0, -0.26, 0)), iron, Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05, 0, 0, 0, false);
  }
  const flame = mesh(lantern, geo('gk-flame', () => new THREE.SphereGeometry(0.04, 12, 10).scale(1, 1.7, 1)), flameMat, 0, -0.26, 0, 0, 0, 0, false);
  skinRigid(root, 'gravekeeper', rig, [ember, flame, ...eyes], bounds(2 * s));

  let clock = Math.random() * 10;
  let phase = Math.random() * 10;
  let lean = 0;
  return {
    root,
    height: 1.75 * s,
    animate(u, dt, deathTime, wobble) {
      clock += dt;
      const speed = hypot(u.vx, u.vz);
      phase += dt * (2.2 + speed * 2.6);
      const gait = Math.min(1, speed / 1.8);
      lean += (gait - lean) * Math.min(1, dt * 5);
      // a shuffling walk, knees never straight
      thighs.forEach((t, i) => {
        const sw = Math.sin(phase + i * Math.PI);
        t.rotation.x = -0.25 + sw * 0.5 * gait;
        knees[i]!.rotation.x = 0.45 + Math.max(0, -sw) * 0.65 * gait;
      });
      hips.position.y = HIP + Math.abs(Math.cos(phase)) * 0.03 * gait + Math.sin(clock * 1.6) * 0.008;
      // the mend: it straightens, lifts the lantern high toward its patient and its flame flares
      const a = u.sinceAction;
      const lift = a < 0.8 ? Math.sin(Math.min(1, a / 0.8) * Math.PI) : 0;
      torso.rotation.x = 0.55 + Math.sin(clock * 1.6) * 0.03 + wobble * 0.06 - lift * 0.25 + lean * 0.1;
      torso.rotation.z = Math.sin(phase) * 0.05 * gait + wobble * 0.05;
      head.rotation.x = -0.45 + Math.sin(clock * 0.7) * 0.05 + lift * 0.15;
      head.rotation.y = Math.sin(clock * 0.43) * 0.3 * (1 - lift);
      jaw.rotation.x = 0.06 + lift * 0.35 + (Math.sin(clock * 3.1) > 0.85 ? Math.abs(Math.sin(clock * 40)) * 0.12 : 0);
      shoulders[1]!.rotation.x = -0.95 - lift * 1.1;
      elbows[1]!.rotation.x = -0.55 + lift * 0.35;
      shoulders[1]!.rotation.z = 0.12;
      // the staff stays upright whatever the arm does, tipping toward the patient as the lantern lifts
      staff.rotation.x = -(torso.rotation.x + shoulders[1]!.rotation.x + elbows[1]!.rotation.x) + lift * 0.45;
      shoulders[0]!.rotation.x = -0.85 + Math.sin(phase + Math.PI) * 0.25 * gait - lift * 0.5;
      elbows[0]!.rotation.x = -0.5 - lift * 0.3;
      shoulders[0]!.rotation.z = -0.15;
      lantern.rotation.x = Math.sin(clock * 1.9) * 0.12 - lean * 0.35 - staff.rotation.x * 0.6;
      lantern.rotation.z = Math.sin(clock * 1.4) * 0.1;
      const flick = 0.9 + Math.sin(clock * 13) * 0.12 + Math.sin(clock * 29 + 1) * 0.08;
      flame.scale.setScalar(flick * (1 + lift * 0.9));
      ember.scale.setScalar(0.85 + Math.sin(clock * 2.4) * 0.15 + lift * 0.3);
      if (deathTime >= 0) {
        // it falls apart into a heap of bones, the flame and ember going out
        const t = Math.min(1, deathTime / 0.7);
        const k = t * t;
        hips.position.y = HIP * (1 - k * 0.82) - Math.max(0, deathTime - 1.6) * 0.4;
        torso.rotation.x = 0.55 + k * 1.0;
        head.rotation.x = -0.45 + k * 0.9;
        for (const kn of knees) kn.rotation.x = 0.45 + k * 1.6;
        for (const th of thighs) th.rotation.x = -0.25 - k * 1.1;
        jaw.rotation.x = 0.06 + k * 0.5;
        const out = Math.max(0.01, 1 - t * 1.4);
        flame.scale.setScalar(out);
        ember.scale.setScalar(out);
        for (const e of eyes) e.scale.setScalar(out);
      }
    },
  };
}

/** The camp kind is encoded in the monster's tag: `<team>-<kind>-<i>:<type>`. */
function campKindOf(u: Unit): CampKind {
  return u.tag.split(':')[0]!.split('-')[1] as CampKind;
}

/**
 * One of every monster, for drawing once while the match loads so their
 * shaders are compiled before the first camp appears instead of mid-fight.
 */
export function monsterWarmup(): THREE.Object3D[] {
  const buffs = ['might', 'wisdom', 'swiftness', 'insight'] as const;
  return [
    thornback(false),
    thornback(true),
    thornback(false, true),
    thornback(false, false, true),
    ...buffs.map((b) => giant({ glow: BUFF_GLOW[b] ?? 0xffffff, stone: mats().stone, scale: 1 })),
    giant({ glow: 0xff6a1a, stone: lavaStone(), scale: 2.1, molten: true }),
    wyrm(),
    shade(),
    gravekeeper(),
  ].map((v) => v.root);
}

export function createMonsterView(u: Unit): MonsterView {
  const v = createView(u);
  if (u.name.startsWith('Champion ')) {
    // Temple Siege Champions stand taller than the rest of the horde (a Warden
    // is already a giant, so it grows less and doesn't swallow the camera)
    const k = u.tag.endsWith('warden') ? 1.18 : 1.35;
    v.root.scale.setScalar(k);
    v.height *= k;
  }
  return v;
}

function createView(u: Unit): MonsterView {
  const type = u.tag.split(':')[1];
  if (type === 'warden') return giant({ glow: BUFF_GLOW[campKindOf(u)] ?? 0xffffff, stone: mats().stone, scale: 1 });
  if (type === 'moltenColossus') return giant({ glow: 0xff6a1a, stone: lavaStone(), scale: 2.1, molten: true });
  if (type === 'treasureWyrm') return wyrm();
  if (type === 'shade') return shade();
  if (type === 'gravekeeper') return gravekeeper();
  return thornback(type === 'thornbackAlpha', type === 'thornSpitter', type === 'gildedThornback');
}
