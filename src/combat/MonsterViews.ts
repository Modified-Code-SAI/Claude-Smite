import * as THREE from 'three/webgpu';
import { abs, attribute, float, materialSheen, mix, mx_noise_float, mx_worley_noise_float, normalView, normalWorld, positionGeometry, positionView, pow, saturate, sin, smoothstep, time, uniform, uv, vec2, vec3, vec4 } from '../render/tsl';
import type { Palette } from '../map/UnderworldLayout';
import { spriteQuads } from '../render/shared';
import type { CampKind } from '../map/ConquestLayout';
import { skinRigid } from '../scene/merge';
import { BUFF_COLOR } from '../scene/conquest/Props';
import { CINDER, DescentMonsterBrain } from '../sim/Descent';
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
 *  - Cinderlings and Slag Brutes, the Ashen Depths' own: imps of cinder
 *    that burst into flame when they fall, and knuckle-walking heaps of
 *    cooled slag with a furnace in their chests that slam the floor.
 *  - The Drowned Halls' own: bloated Drowned Thralls that grab and hold,
 *    Lantern Jellies of cold soul light, and Tide Lurkers, lure-headed fish
 *    that swim under the floor and burst up beneath the gods.
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

/**
 * Seconds after death each body starts going down into the ground (the rigs
 * below sink on these), so whatever marks the ground taking it lands as it goes.
 */
const SINKS = { thornback: 1.6, warden: 1.4, treasureWyrm: 1.8, shade: 1.3, gravekeeper: 1.6, ossuaryKing: 2.4, cinderling: 1.4, slagBrute: 1.5, drownedThrall: 1.5, lanternJelly: 1.2, tideLurker: 1.6, gravehound: 1.3, packleader: 1.6 } as const;

/** When a monster's body starts sinking into the ground, in seconds after it died. */
export function sinksAfter(tag: string): number {
  const type = tag.split(':')[1] ?? '';
  if (type === 'warden' || type === 'moltenColossus') return SINKS.warden;
  return type in SINKS ? SINKS[type as keyof typeof SINKS] : SINKS.thornback;
}

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

/**
 * The Underworld Descent's depth on the beasts that live there (ember, soul,
 * spirit weights; all 0 on the battlefields, which keep the mossy jungle
 * look): scorched with cinders in the Ashen Depths, wet and pale with algae
 * in the Drowned Halls, faded to grey ghosts lit green in the Abyss. Uniforms,
 * so going down a depth builds no shader.
 */
const depthOn = uniform(new THREE.Vector3());
/** The amber glows (Thornback eyes, the Alpha's crest), which take each depth's light. */
const amberGlows: { value: THREE.Color }[] = [];
/** The amber glows' color at each depth: forge fire, the Drowned Halls' cold soul light, the Abyss's green. */
export const DEPTH_EYES: Record<Palette, number> = { ember: 0xff8a2a, soul: 0x8fd8ff, spirit: 0x7affb0 };

/** Dresses the monsters for a Descent depth, or back in their jungle look (null). */
export function setMonsterDepth(p: Palette | null): void {
  depthOn.value.set(p === 'ember' ? 1 : 0, p === 'soul' ? 1 : 0, p === 'spirit' ? 1 : 0);
  for (const c of amberGlows) c.value.setHex(p ? DEPTH_EYES[p] : AMBER);
}

/** The depth the monsters are dressed for (its weights) and the color their amber glows took (for tests). */
export function monsterDepth(): { weights: [number, number, number]; glows: number[] } {
  return { weights: depthOn.value.toArray() as [number, number, number], glows: amberGlows.map((c) => c.value.getHex()) };
}

/** The jungle look, or each depth's own in its place. */
function depthed(jungle: any, ember: any, drowned: any, ghost: any): any {
  const [e, d, g] = [depthOn.x, depthOn.y, depthOn.z];
  return mix(jungle, ember.mul(e).add(drowned.mul(d)).add(ghost.mul(g)), e.add(d).add(g));
}

function n(s: number, p = positionGeometry) {
  return mx_noise_float(p.mul(s)).mul(0.5).add(0.5);
}

function buildShared() {
  // shaggy fur: dark umber with moss-green tips, darker underneath
  const fur = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.92, sheen: 0.6, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x8fa060) });
  const streak = mx_noise_float(vec3(positionGeometry.x.mul(18), positionGeometry.y.mul(5), positionGeometry.z.mul(18))).mul(0.5).add(0.5);
  const top = smoothstep(-0.2, 0.8, normalWorld.y);
  const patchy = n(4).mul(top);
  const coat = streak.mul(0.6).add(top.mul(0.4));
  const furFor = (under: any, back: any, tips: any) => mix(under, mix(back, tips, patchy), coat);
  const crust = smoothstep(0.3, 0.14, mx_worley_noise_float(positionGeometry.mul(6))).mul(top);
  // an Abyss beast's outline lit green, the way a ghost shows against the dark
  const rim = pow(float(1).sub(saturate(normalView.dot(positionView.normalize().negate()))), 2.5);
  fur.colorNode = depthed(
    furFor(vec3(0.09, 0.06, 0.035), vec3(0.24, 0.16, 0.08), vec3(0.3, 0.34, 0.12)),
    // singed to char, rust where it caught
    furFor(vec3(0.02, 0.014, 0.01), vec3(0.06, 0.035, 0.022), vec3(0.2, 0.075, 0.03)),
    // matted wet slate, weed growing down the back and pale crusts of shell along it
    mix(furFor(vec3(0.025, 0.04, 0.045), vec3(0.07, 0.11, 0.12), vec3(0.12, 0.24, 0.18)), vec3(0.42, 0.44, 0.38), crust.mul(0.85)),
    // faded to ash grey, as if half gone already
    furFor(vec3(0.07, 0.065, 0.085), vec3(0.21, 0.2, 0.25), vec3(0.34, 0.38, 0.38)),
  );
  // soaked fur shines; the moss sheen goes with the moss
  fur.roughnessNode = depthed(float(0.92), float(0.9), float(0.42), float(0.85));
  fur.sheenNode = depthed(materialSheen, vec3(0.25, 0.12, 0.06), vec3(0.18, 0.3, 0.32), vec3(0.3, 0.42, 0.38));
  // cinders still glowing in the singed streaks, breathing; the Abyss's lit round their edges
  const cinders = smoothstep(0.62, 0.8, streak).mul(top.mul(0.8).add(0.2)).mul(sin(time.mul(2.2).add(positionGeometry.x.mul(9))).mul(0.3).add(0.7));
  const ghostLight = vec3(0.25, 1, 0.6).mul(rim.mul(0.9).add(patchy.mul(0.15)).mul(depthOn.z));
  fur.emissiveNode = vec3(1, 0.32, 0.06).mul(cinders.mul(2.4).mul(depthOn.x)).add(ghostLight);
  // bare hide on the snout and legs
  const hide = new THREE.MeshStandardNodeMaterial({ roughness: 0.75 });
  const n14 = n(14);
  hide.colorNode = depthed(
    mix(vec3(0.2, 0.12, 0.08), vec3(0.34, 0.22, 0.15), n14),
    mix(vec3(0.07, 0.04, 0.03), vec3(0.16, 0.08, 0.05), n14),
    mix(vec3(0.22, 0.25, 0.24), vec3(0.36, 0.4, 0.37), n14),
    mix(vec3(0.16, 0.14, 0.18), vec3(0.3, 0.28, 0.33), n14),
  );
  hide.roughnessNode = depthed(float(0.75), float(0.8), float(0.4), float(0.7));
  // the forge's hide cracked through to the fire under it
  const veins = smoothstep(0.035, 0.0, abs(n14.sub(0.5)));
  hide.emissiveNode = vec3(1, 0.35, 0.06).mul(veins.mul(2.4).mul(depthOn.x)).add(vec3(0.25, 1, 0.6).mul(rim.mul(0.9).mul(depthOn.z)));
  // bone that heats up toward its tip (cone uv.y is 1 at the tip): amber, forge-hot, cold soul light, green
  const bone = new THREE.MeshStandardNodeMaterial({ roughness: 0.45 });
  const tip = smoothstep(0.45, 1, uv().y);
  bone.colorNode = mix(
    depthed(vec3(0.82, 0.76, 0.6), vec3(0.5, 0.42, 0.34), vec3(0.68, 0.74, 0.7), vec3(0.86, 0.86, 0.8)),
    depthed(vec3(1, 0.62, 0.22), vec3(1, 0.5, 0.15), vec3(0.6, 0.85, 1), vec3(0.5, 1, 0.7)),
    tip,
  );
  bone.emissiveNode = depthed(vec3(2.2, 0.99, 0.22), vec3(3.2, 1.2, 0.2), vec3(0.63, 1.26, 1.8), vec3(0.66, 2.2, 1.2)).mul(tip.mul(tip));
  const hoof = new THREE.MeshStandardNodeMaterial({ color: 0x1b1410, roughness: 0.5 });
  // the Gilded Thornback's coat: the same plain material as the hooves, so no new shader
  const gold = new THREE.MeshStandardNodeMaterial({ color: 0xe0a93a, metalness: 1, roughness: 0.3 });
  // weathered stone with moss on every upward face
  const stone = new THREE.MeshStandardNodeMaterial({ roughness: 0.88 });
  // object space, so the stone's pattern stays on the Warden as it walks and swings
  const big = n(3.5);
  const grain = big.mul(0.6).add(n(14).mul(0.4));
  const moss = smoothstep(0.2, 0.7, normalWorld.y.add(n(2.2).sub(0.5).mul(0.7)));
  const n9 = n(9);
  const stoneFor = (dark: any, light: any, coat0: any, coat1: any) => mix(mix(dark, light, grain), mix(coat0, coat1, n9), moss.mul(0.92));
  stone.colorNode = depthed(
    stoneFor(vec3(0.16, 0.16, 0.19), vec3(0.38, 0.35, 0.32), vec3(0.17, 0.3, 0.07), vec3(0.32, 0.46, 0.12)),
    // basalt under a drift of ash
    stoneFor(vec3(0.08, 0.065, 0.065), vec3(0.24, 0.18, 0.15), vec3(0.28, 0.27, 0.25), vec3(0.42, 0.4, 0.37)),
    // wet limestone grown over with slime
    stoneFor(vec3(0.12, 0.15, 0.16), vec3(0.3, 0.33, 0.33), vec3(0.08, 0.2, 0.15), vec3(0.18, 0.34, 0.24)),
    // dark glassy rock under grave dust
    stoneFor(vec3(0.05, 0.05, 0.07), vec3(0.17, 0.16, 0.2), vec3(0.26, 0.28, 0.27), vec3(0.36, 0.38, 0.36)),
  );
  stone.roughnessNode = depthed(float(0.95), float(0.92), float(0.55), float(0.6)).sub(moss.mul(0.1));
  // a crack running through the stone, lava in the forge and green soul fire in the Abyss
  const crack = smoothstep(0.03, 0.0, abs(big.sub(0.5))).mul(smoothstep(0.45, 0.62, n(1.2))).mul(float(1).sub(moss));
  const stoneRim = pow(float(1).sub(saturate(normalView.dot(positionView.normalize().negate()))), 2.5);
  stone.emissiveNode = vec3(1, 0.35, 0.06).mul(crack.mul(2.6).mul(depthOn.x)).add(vec3(0.3, 1, 0.55).mul(crack.mul(1.3).add(stoneRim.mul(0.6)).mul(depthOn.z)));
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
    const color = uniform(new THREE.Color(hex));
    if (hex === AMBER) amberGlows.push(color);
    g.colorNode = color.mul(uniform(strength).mul(n(30).mul(0.4).add(0.8)));
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
        body.position.y = 0.72 - t * 0.35 - Math.max(0, deathTime - SINKS.thornback) * 0.5;
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
        hips.position.y = 1.25 - k * k * 1.0 - Math.max(0, deathTime - SINKS.warden) * 0.8;
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
// Cinderling

/** A Cinderling's fire: its eyes, mouth, the tuft on its head and the flare it bursts in. */
export const CINDER_GLOW = 0xff7a1e;
let cinderSkin: THREE.Material | null = null;

/**
 * A Cinderling's hide: charred crust flaking over a body still burning
 * inside, the fire showing through a web of cracks that flickers, hottest
 * underneath. In the rig's space, so the cracks stay put as it scurries.
 */
function cinderSkinMaterial(): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  const p = positionGeometry;
  const flake = n(9, p).mul(0.6).add(n(23, p).mul(0.4));
  m.colorNode = mix(vec3(0.025, 0.02, 0.02), vec3(0.13, 0.09, 0.075), flake);
  // the web of cracks: noise zero crossings, a coarse set and a fine one
  const wide = smoothstep(0.045, 0.0, abs(mx_noise_float(p.mul(3.4))));
  const fine = smoothstep(0.025, 0.0, abs(mx_noise_float(p.mul(8).add(5)))).mul(0.5);
  const crack = wide.add(fine).clamp(0, 1);
  // hotter underneath (the belly, the insides of the limbs) than on the crust that faces up
  const under = smoothstep(0.3, -0.6, normalWorld.y);
  const flicker = mx_noise_float(vec3(p.x.mul(4), p.y.mul(4).sub(time.mul(2.4)), p.z.mul(4))).mul(0.35).add(0.85);
  const heat = crack.mul(flicker).mul(under.mul(0.6).add(0.5));
  m.emissiveNode = mix(vec3(1, 0.2, 0.02), vec3(1, 0.5, 0.14), crack.pow(3)).mul(heat.mul(2.4));
  m.roughnessNode = float(0.95).sub(crack.mul(0.35));
  return m;
}

let cinderFlame: THREE.Material | null = null;

/**
 * Living flame for a Cinderling's hair and tail: white-gold at the root,
 * orange licking up to nothing at the tip, flickering. Added over what's
 * behind it, never hiding it.
 */
function cinderFlameMaterial(): THREE.Material {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  // (a cone's uv.y runs from 0 at its base to 1 at its tip)
  const h = uv().y;
  const p = positionGeometry;
  const lick = mx_noise_float(vec3(p.x.mul(14), p.y.mul(9).sub(time.mul(6)), p.z.mul(14))).mul(0.5).add(0.5);
  const body = smoothstep(1, 0.2, h.add(lick.mul(0.4)));
  m.colorNode = mix(vec3(1, 0.28, 0.04), vec3(1, 0.75, 0.35), smoothstep(0.55, 0, h)).mul(body.mul(2.4));
  m.opacityNode = body;
  return m;
}

/**
 * Cinderlings: knee-high imps of cinder that swarm the Ashen Depths. A
 * charred crust cracked over the fire inside, long raking arms, hot horns,
 * a tuft of flame for hair. They skitter low and fast, rake with one claw
 * then the other, and when one falls it curls up round its swelling fire
 * and bursts.
 */
function cinderling(): MonsterView {
  const skin = (cinderSkin ??= cinderSkinMaterial());
  const horn = mats().bone;
  const fire = glow(CINDER_GLOW, 4.5);
  const flameMat = (cinderFlame ??= cinderFlameMaterial());
  const root = new THREE.Group();
  const s = 1.15;
  const rig = pivot(root, 0, 0, 0);
  rig.scale.setScalar(s);
  const hips = pivot(rig, 0, 0.5, 0);
  mesh(hips, geo('cl-pelvis', () => new THREE.SphereGeometry(0.15, 16, 12).scale(1.1, 0.8, 0.9)), skin);
  // a whip of a tail, a flame at its tip
  const tail = pivot(hips, 0, 0.02, -0.11);
  mesh(tail, geo('cl-tail', () => new THREE.ConeGeometry(0.05, 0.4, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.2)), skin);
  const tailFlame = mesh(tail, geo('cl-tail-flame', () => new THREE.ConeGeometry(0.05, 0.24, 8, 1, true).translate(0, 0.12, 0)), flameMat, 0, 0.01, -0.38, -0.6, 0, 0, false);
  // crouched digitigrade legs on splayed, clawed feet
  const toe = geo('cl-toe', () => new THREE.ConeGeometry(0.018, 0.09, 6).rotateX(Math.PI / 2).translate(0, 0, 0.045));
  const legs: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const leg = pivot(hips, sx * 0.1, -0.02, 0);
    mesh(leg, geo('cl-thigh', () => new THREE.CapsuleGeometry(0.06, 0.16, 4, 10)), skin, 0, -0.11, 0.06, -0.5);
    mesh(leg, geo('cl-shin', () => new THREE.CapsuleGeometry(0.045, 0.14, 4, 8)), skin, 0, -0.315, 0.075, 0.57);
    mesh(leg, geo('cl-foot', () => new THREE.SphereGeometry(0.06, 10, 8).scale(0.9, 0.5, 1.6)), skin, 0, -0.45, 0.08);
    for (let i = -1; i <= 1; i++) mesh(leg, toe, horn, i * 0.035, -0.465, 0.15, 0, i * 0.3, 0, false);
    legs.push(leg);
  }
  // a hunched body pitched forward over the hips
  const torso = pivot(hips, 0, 0.06, 0);
  mesh(torso, geo('cl-chest', () => new THREE.SphereGeometry(0.2, 18, 14).scale(1.05, 1.15, 0.85)), skin, 0, 0.2, 0);
  mesh(torso, geo('cl-belly', () => new THREE.SphereGeometry(0.14, 14, 10)), skin, 0, 0.05, 0.05);
  // knobs of hot horn down its spine
  const knob = geo('cl-knob', () => new THREE.ConeGeometry(0.035, 0.12, 6).translate(0, 0.06, 0));
  for (let i = 0; i < 4; i++) mesh(torso, knob, horn, 0, 0.36 - i * 0.09, -0.15 + i * 0.012, -1.1 - i * 0.12, 0, 0).scale.setScalar(1 - i * 0.15);
  // the fire inside, hidden in its chest until it falls and the fire swells out of it
  const core = mesh(torso, geo('cl-core', () => new THREE.SphereGeometry(0.1, 16, 12)), fire, 0, 0.16, 0.04, 0, 0, 0, false);
  const head = pivot(torso, 0, 0.4, 0.1);
  mesh(head, geo('cl-skull', () => new THREE.SphereGeometry(0.13, 16, 12).scale(1, 0.85, 1.15)), skin, 0, 0.02, 0.04);
  // a hinged jaw over a mouthful of fire
  const jaw = pivot(head, 0, -0.03, 0);
  mesh(jaw, geo('cl-jaw', () => new THREE.SphereGeometry(0.1, 14, 10).scale(1.1, 0.5, 1.2)), skin, 0, -0.05, 0.08);
  mesh(head, geo('cl-mouth', () => new THREE.SphereGeometry(0.07, 12, 8).scale(1.2, 0.4, 1)), fire, 0, -0.05, 0.12, 0, 0, 0, false);
  for (const sx of [-1, 1]) {
    mesh(head, geo('cl-eye', () => new THREE.SphereGeometry(0.026, 10, 8).scale(1.4, 0.7, 0.7)), fire, sx * 0.055, 0.035, 0.155, 0, 0, sx * 0.3, false);
    mesh(head, geo('cl-horn', () => new THREE.ConeGeometry(0.03, 0.2, 7).translate(0, 0.1, 0)), horn, sx * 0.08, 0.08, 0, -0.9, 0, -sx * 0.45);
  }
  // a tuft of flame for hair, licking back off the skull
  const flames: THREE.Mesh[] = [];
  const flame = geo('cl-flame', () => new THREE.ConeGeometry(0.07, 0.3, 10, 1, true).translate(0, 0.15, 0));
  for (let i = 0; i < 3; i++) flames.push(mesh(head, flame, flameMat, (i - 1) * 0.04, 0.08, -0.02 - i * 0.04, -0.5 - i * 0.25, 0, (i - 1) * 0.35, false));
  // long thin arms ending in raking claws
  const claw = geo('cl-claw', () => new THREE.ConeGeometry(0.016, 0.12, 6).rotateX(Math.PI).translate(0, -0.06, 0));
  const arms: THREE.Group[] = [];
  const elbows: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const arm = pivot(torso, sx * 0.21, 0.3, 0.02);
    mesh(arm, geo('cl-upper', () => new THREE.CapsuleGeometry(0.045, 0.2, 4, 8)), skin, 0, -0.14, 0);
    const elbow = pivot(arm, 0, -0.27, 0);
    mesh(elbow, geo('cl-fore', () => new THREE.CapsuleGeometry(0.04, 0.2, 4, 8)), skin, 0, -0.13, 0);
    mesh(elbow, geo('cl-hand', () => new THREE.SphereGeometry(0.05, 10, 8).scale(1, 0.8, 1.1)), skin, 0, -0.28, 0.01);
    for (let i = -1; i <= 1; i++) mesh(elbow, claw, horn, i * 0.026, -0.31, 0.03, 0.3, 0, i * 0.25, false);
    arms.push(arm);
    elbows.push(elbow);
  }
  skinRigid(root, 'cinderling', rig, [core, tailFlame, ...flames], bounds(1.1 * s));
  const flameTilt = flames.map((f) => f.rotation.x);

  let phase = Math.random() * 10;
  let clock = Math.random() * 10;
  let lean = 0;
  let look = 0;
  let glance = 0;
  let glanceIn = 0;
  let side = 1;
  let last = 9;
  return {
    root,
    height: 1.05 * s,
    linger: 2.6,
    animate(u, dt, deathTime, wobble) {
      clock += dt;
      const speed = hypot(u.vx, u.vz);
      const gait = Math.min(1, speed / 2.5);
      phase += dt * (4 + speed * 3.2);
      lean += (gait - lean) * Math.min(1, dt * 6);
      // a skittering run: quick short strides, body low and pitched forward, arms swept back
      const sw = Math.sin(phase);
      legs[0]!.rotation.x = sw * 0.85 * gait;
      legs[1]!.rotation.x = -sw * 0.85 * gait;
      hips.position.y = 0.5 - lean * 0.05 + Math.abs(Math.cos(phase)) * 0.05 * gait + Math.sin(clock * 3.1) * 0.008;
      torso.rotation.set(0.55 + lean * 0.35 + wobble * 0.12, -sw * 0.14 * gait, sw * 0.06 * gait + wobble * 0.08);
      tail.rotation.set(0.15 + Math.sin(clock * 3.3) * 0.15 - lean * 0.2, Math.sin(clock * 5 + lean) * 0.45, 0);
      // a head that snaps about between still moments, like a bird's
      if ((glanceIn -= dt) <= 0) {
        glanceIn = 0.35 + Math.random() * 0.9;
        glance = (Math.random() - 0.5) * 1.1;
      }
      look += (glance * (1 - gait) - look) * Math.min(1, dt * 18);
      head.rotation.set(-0.45 - lean * 0.3, look, 0);
      // the rake: one arm whips down across its foe, the other the next time
      const a = u.sinceAction;
      if (a < last) side = -side;
      last = a;
      const rake = a < 0.16 ? -1.7 + (a / 0.16) * 2.3 : a < 0.5 ? 0.6 * (1 - (a - 0.16) / 0.34) : 0;
      jaw.rotation.x = (a < 0.4 ? Math.sin((a / 0.4) * Math.PI) * 0.55 : 0) + 0.06 + Math.sin(clock * 2.6) * 0.04;
      arms.forEach((arm, i) => {
        const sx = i ? 1 : -1;
        const striking = sx === side;
        arm.rotation.x = -0.75 + lean * 0.9 + sw * 0.3 * gait * sx + (striking ? rake : 0);
        arm.rotation.z = sx * (0.25 + (striking && a < 0.3 ? 0.25 : 0));
        elbows[i]!.rotation.x = -0.5 - lean * 0.3 + (striking && a < 0.16 ? -0.6 : 0);
      });
      // the fire on its head and tail licks and gutters
      flames.forEach((f, i) => {
        f.rotation.x = flameTilt[i]! - lean * 0.6;
        f.scale.set(1, 0.75 + 0.35 * Math.sin(clock * (11 + i * 3) + i * 2) + lean * 0.35, 1);
      });
      tailFlame.scale.set(1, 0.8 + 0.3 * Math.sin(clock * 13), 1);
      core.scale.setScalar(0.01);
      if (deathTime >= 0) {
        // it drops to its knees and curls up round the fire swelling out of it, bursts, and is ash
        const t = Math.min(1, deathTime / 0.35);
        const burnt = Math.max(0, Math.min(1, (deathTime - CINDER.warn) / 0.5));
        hips.position.y = 0.5 - t * 0.24 - Math.max(0, deathTime - SINKS.cinderling) * 0.4;
        torso.rotation.x = 0.55 + t * 0.55;
        for (const l of legs) l.rotation.x = -t * 0.9;
        arms.forEach((arm, i) => {
          arm.rotation.x = -0.75 - t * 0.6;
          arm.rotation.z = (i ? 1 : -1) * (0.25 - t * 0.4);
          elbows[i]!.rotation.x = -0.5 - t * 1.2;
        });
        head.rotation.x = -0.45 + t * 0.4;
        const swell = Math.min(1, deathTime / CINDER.warn);
        core.scale.setScalar(
          deathTime < CINDER.warn ? (0.6 + swell * swell * 3) * (1 + Math.sin(deathTime * 38) * 0.1 * swell) : Math.max(0.01, 3.6 * (1 - (deathTime - CINDER.warn) / 0.1)),
        );
        // what's left: a cooling husk, crumbling, the fire in it gone out
        rig.scale.set(s, s * (1 - burnt * 0.45), s);
        const out = Math.max(0.01, 1 - burnt * 2);
        for (const f of flames) f.scale.setScalar(out);
        tailFlame.scale.setScalar(out);
      } else rig.scale.setScalar(s);
    },
  };
}

// ---------------------------------------------------------------------------
// Slag Brute

/**
 * Slag Brutes: the Ashen Depths' heavies. A hunched ape of a thing, as wide
 * as it is tall, poured from the forge's slag and cooled to a cracked black
 * crust that still runs molten in the seams, ash-grey plates of basalt on
 * its shoulders, and a split down its chest where the furnace inside it
 * shows. It walks on its knuckles, hauls one fist back over its shoulder to
 * punch, and with a god close raises both over its head and slams the floor.
 */
function slagBrute(): MonsterView {
  const crust = lavaStone();
  const plate = mats().stone;
  const lit = glow(0xff6a1a, 4);
  const root = new THREE.Group();
  const rig = pivot(root, 0, 0, 0);
  const hips = pivot(rig, 0, 0.9, 0);
  mesh(hips, geo('sb-pelvis', () => rock(0.45, 31).scale(1.2, 0.8, 1)), crust);
  const legs: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const leg = pivot(hips, sx * 0.42, -0.05, 0);
    mesh(leg, geo('sb-thigh', () => rock(0.3, 32).scale(1, 1.3, 1)), crust, 0, -0.32, 0);
    mesh(leg, geo('sb-foot', () => rock(0.33, 33).scale(1.15, 0.55, 1.35)), crust, 0, -0.68, 0.1);
    legs.push(leg);
  }
  // a gut and a great hump of a back, pitched forward over the hips
  const torso = pivot(hips, 0, 0.15, 0);
  mesh(torso, geo('sb-gut', () => rock(0.62, 34).scale(1.2, 1, 0.95)), crust, 0, 0.55, 0.05);
  mesh(torso, geo('sb-hump', () => rock(0.7, 35).scale(1.35, 0.95, 1.05)), crust, 0, 1.0, -0.25);
  // the split down its chest, crust ribs either side, and the furnace showing through it
  const core = mesh(torso, geo('sb-core', () => new THREE.SphereGeometry(0.22, 18, 12).scale(0.5, 1.45, 0.55)), lit, 0, 0.6, 0.5, 0, 0, 0, false);
  for (const sx of [-1, 1]) mesh(torso, geo('sb-rib', () => rock(0.24, 46).scale(0.85, 1.5, 0.7)), crust, sx * 0.25, 0.6, 0.5, 0, 0, sx * 0.12);
  // cooled basalt plates over the shoulders and down the back
  for (const sx of [-1, 1]) mesh(torso, geo('sb-pauldron', () => rock(0.38, 36).scale(1.3, 0.45, 1.1)), plate, sx * 0.78, 1.28, -0.05, 0, 0, sx * 0.45);
  mesh(torso, geo('sb-back', () => rock(0.45, 37).scale(1.4, 0.4, 1.2)), plate, 0, 1.45, -0.42, -0.3, 0, 0);
  mesh(torso, geo('sb-spine', () => rock(0.3, 44).scale(1.2, 0.4, 1)), plate, 0, 1.15, -0.85, -0.9, 0, 0);
  // a small head sunk low between the shoulders
  const head = pivot(torso, 0, 1.0, 0.62);
  mesh(head, geo('sb-skull', () => rock(0.26, 38).scale(1.05, 0.9, 1.1)), crust, 0, 0, 0);
  mesh(head, geo('sb-brow', () => rock(0.18, 45).scale(1.7, 0.45, 0.8)), plate, 0, 0.12, 0.12, 0.2, 0, 0);
  const jaw = pivot(head, 0, -0.1, 0);
  mesh(jaw, geo('sb-jaw', () => rock(0.2, 39).scale(1.25, 0.6, 1)), crust, 0, -0.07, 0.1);
  mesh(head, geo('sb-maw', () => new THREE.SphereGeometry(0.11, 12, 8).scale(1.3, 0.45, 0.8)), lit, 0, -0.12, 0.18, 0, 0, 0, false);
  for (const sx of [-1, 1]) mesh(head, geo('sb-eye', () => new THREE.BoxGeometry(0.08, 0.035, 0.03)), lit, sx * 0.1, 0.04, 0.24, 0, 0, -sx * 0.25, false);
  // arms like pillars to the ground, fists with molten knuckles
  const arms: THREE.Group[] = [];
  const elbows: THREE.Group[] = [];
  const knuckle = geo('sb-knuckle', () => new THREE.SphereGeometry(0.085, 10, 8).scale(1, 0.7, 0.8));
  for (const sx of [-1, 1]) {
    mesh(torso, geo('sb-shoulder', () => rock(0.42, 40)), crust, sx * 0.92, 1.05, 0.05);
    const arm = pivot(torso, sx * 1.0, 0.95, 0.1);
    mesh(arm, geo('sb-upper', () => rock(0.27, 41).scale(1, 1.6, 1)), crust, 0, -0.36, 0);
    const elbow = pivot(arm, 0, -0.7, 0);
    mesh(elbow, geo('sb-fore', () => rock(0.31, 42).scale(1, 1.5, 1)), crust, 0, -0.3, 0.03);
    mesh(elbow, geo('sb-fist', () => rock(0.42, 43).scale(1.1, 0.95, 1.15)), crust, 0, -0.75, 0.06);
    for (let i = -1; i <= 1; i++) mesh(elbow, knuckle, lit, i * 0.15, -0.8, 0.42, 0, 0, 0, false);
    arms.push(arm);
    elbows.push(elbow);
  }
  const embers = makeEmbers(rig);
  skinRigid(root, 'slag-brute', rig, [core], bounds(2.6));

  let phase = Math.random() * 10;
  let t = Math.random() * 10;
  /** How far each fist is hauled back for a punch, and both up for the slam. */
  let haul = 0;
  let raise = 0;
  let side = 1;
  let winding = false;
  let slammed = false;
  return {
    root,
    height: 2.6,
    animate(u, dt, deathTime, wobble) {
      t += dt;
      const special = u.brain instanceof MonsterBrain ? u.brain.specialProgress : 0;
      const speed = hypot(u.vx, u.vz);
      const gait = Math.min(1, speed / 1.8);
      phase += dt * (2 + speed * 1.6);
      const sw = Math.sin(phase);
      // a rolling knuckle walk: the legs and the opposite fists swing together, the hump sways
      legs[0]!.rotation.x = sw * 0.5 * gait;
      legs[1]!.rotation.x = -sw * 0.5 * gait;
      hips.position.y = 0.9 + Math.abs(Math.cos(phase)) * 0.06 * gait + Math.sin(t * 1.2) * 0.02;
      // a punch winding up: a new one swaps fists
      if (u.windup > 0 && !winding) {
        side = -side;
        slammed = false;
      }
      winding = u.windup > 0;
      if (special > 0) slammed = true;
      haul += ((winding ? 1 : 0) - haul) * (1 - Math.exp(-dt * (winding ? 8 : 24)));
      raise += ((special > 0 ? 1 : 0) - raise) * (1 - Math.exp(-dt * (special > 0 ? 7 : 24)));
      const a = u.sinceAction;
      const blow = a < 0.32 ? Math.sin((a / 0.32) * Math.PI) : 0;
      arms.forEach((arm, i) => {
        const sx = i ? 1 : -1;
        const punch = sx === side && !slammed;
        let x = -0.9 - sw * 0.35 * gait * sx;
        if (punch) x += -haul * 1.9 + blow * 0.55;
        x += -raise * (2.3 + special * 0.35) + (slammed ? blow * 0.95 : 0);
        arm.rotation.x = x;
        arm.rotation.z = sx * (0.12 + raise * 0.35 + (punch ? haul * 0.25 : 0));
        elbows[i]!.rotation.x = -0.25 - (punch ? haul * 0.7 : 0) - raise * 0.4;
      });
      torso.rotation.set(
        0.6 - raise * 0.5 - special * 0.1 + (slammed ? blow * 0.45 : blow * 0.15) + wobble * 0.04,
        sw * 0.1 * gait + (slammed ? 0 : side * haul * 0.3),
        sw * 0.07 * gait + wobble * 0.04,
      );
      hips.position.y -= raise * 0.12 + (slammed ? blow * 0.2 : 0);
      head.rotation.x = -0.5 + raise * 0.4;
      jaw.rotation.x = 0.08 + raise * 0.45 + haul * 0.2;
      core.scale.setScalar(1 + Math.sin(t * 2.5) * 0.06 + raise * 0.4 + haul * 0.15);
      embers.step(dt, deathTime >= 0 ? 0 : 0.6 + raise * 2.4);
      if (deathTime >= 0) {
        // it slumps forward onto its fists and knees, the furnace dying, and crumbles into the ground
        const k = Math.min(1, deathTime / 1.0);
        hips.position.y = 0.9 - k * k * 0.5 - Math.max(0, deathTime - SINKS.slagBrute) * 0.6;
        torso.rotation.x = 0.6 + k * 0.5;
        for (const l of legs) l.rotation.x = -k * 0.7;
        for (const [i, arm] of arms.entries()) {
          arm.rotation.x = -0.9 * (1 - k) - k * 0.2;
          elbows[i]!.rotation.x = -0.25 - k * 0.4;
        }
        core.scale.setScalar(Math.max(0.01, 1 - k));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Drowned Thrall

/** The cold soul light in the Drowned Halls' beasts: a Thrall's eyes, a Jelly's bell, a Lurker's lure. */
export const DROWNED_GLOW = 0x7fe0ff;
export const DROWNED_CORE = 0xe2fbff;
let thrallSkin: THREE.Material | null = null;

/**
 * Drowned flesh: bloated grey-green going blue in bruised blotches, slick
 * and shining, barnacles crusting whatever faces up, and a faint cold light
 * in the veins under it.
 */
function thrallSkinMaterial(): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.55 });
  const p = positionGeometry;
  const mottle = n(3, p).mul(0.6).add(n(11, p).mul(0.4));
  // waterlogged flesh, grey-green and blotched, a green scum of weed toward the feet
  const flesh = mix(mix(vec3(0.07, 0.12, 0.11), vec3(0.26, 0.32, 0.27), mottle), vec3(0.08, 0.17, 0.09), smoothstep(0.7, 0.1, p.y).mul(n(7, p.add(3))).mul(0.8));
  const bruise = smoothstep(0.55, 0.75, n(5, p.add(13)));
  const shell = smoothstep(0.32, 0.14, mx_worley_noise_float(p.mul(14))).mul(smoothstep(0.1, 0.6, normalWorld.y.add(n(2, p).sub(0.5))));
  m.colorNode = mix(mix(flesh, vec3(0.13, 0.15, 0.25), bruise.mul(0.65)), vec3(0.6, 0.58, 0.5), shell);
  m.roughnessNode = mix(float(0.42).add(mottle.mul(0.25)), float(0.9), shell);
  // fine veins of cold light, only in patches (lit all over they read as a pattern, not a body)
  const veins = smoothstep(0.012, 0.0, abs(n(9, p).sub(0.5))).mul(smoothstep(0.36, 0.6, n(2.5, p.add(7))));
  const rim = pow(float(1).sub(saturate(normalView.dot(positionView.normalize().negate()))), 3);
  m.emissiveNode = vec3(0.3, 0.85, 1).mul(veins.mul(0.9).add(rim.mul(0.2)));
  return m;
}

/**
 * Drowned Thralls: the Drowned Halls' many. Bloated husks of the drowned,
 * hunched under drapes of kelp, barnacled, jaws hanging slack, a cold light
 * in their sunken eyes. They shamble in on a dragging leg and lunge to grab
 * with both hands, and what they grab they hold onto.
 */
function drownedThrall(): MonsterView {
  const skin = (thrallSkin ??= thrallSkinMaterial());
  const kelp = mats().fur;
  const eye = glow(DROWNED_GLOW, 5);
  const root = new THREE.Group();
  const s = 1.15;
  const rig = pivot(root, 0, 0, 0);
  rig.scale.setScalar(s);
  const hips = pivot(rig, 0, 0.95, 0);
  mesh(hips, geo('dt-pelvis', () => new THREE.SphereGeometry(0.22, 16, 12).scale(1.2, 0.8, 0.9)), skin);
  const legs: THREE.Group[] = [];
  const knees: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const leg = pivot(hips, sx * 0.14, -0.05, 0);
    mesh(leg, geo('dt-thigh', () => new THREE.CapsuleGeometry(0.09, 0.3, 4, 10)), skin, 0, -0.21, 0);
    const knee = pivot(leg, 0, -0.42, 0);
    mesh(knee, geo('dt-shin', () => new THREE.CapsuleGeometry(0.075, 0.28, 4, 10)), skin, 0, -0.2, 0);
    mesh(knee, geo('dt-foot', () => new THREE.SphereGeometry(0.09, 10, 8).scale(0.9, 0.5, 1.6)), skin, 0, -0.42, 0.06);
    legs.push(leg);
    knees.push(knee);
  }
  const torso = pivot(hips, 0, 0.1, 0);
  mesh(torso, geo('dt-belly', () => new THREE.SphereGeometry(0.3, 20, 14).scale(1.05, 0.95, 0.95)), skin, 0, 0.2, 0.05);
  mesh(torso, geo('dt-chest', () => new THREE.SphereGeometry(0.28, 20, 14).scale(1.2, 0.9, 0.85)), skin, 0, 0.5, -0.02);
  // kelp draped over the shoulders and hanging down the back
  const strand = geo('dt-kelp', () => new THREE.ConeGeometry(0.06, 0.7, 6).rotateX(Math.PI).translate(0, -0.35, 0));
  for (let i = 0; i < 7; i++) {
    const a = (i / 6 - 0.5) * 2.6;
    mesh(torso, strand, kelp, Math.sin(a) * 0.3, 0.68, -Math.cos(a) * 0.12 - 0.05, -0.15 - Math.abs(a) * 0.05, 0, a * 0.15).scale.set(1, 0.7 + ((i * 7) % 5) * 0.12, 1);
  }
  // a rotted net of weed hanging from the hips, and a ragged drape of it down the back
  mesh(hips, geo('dt-rags', () => tattered([[0.3, -0.42], [0.28, -0.2], [0.25, -0.04], [0.2, 0.06]], 8, 0.2, 1.7, 28)), kelp);
  mesh(torso, geo('dt-drape', () => tattered([[0.42, 0.12], [0.38, 0.38], [0.33, 0.6], [0.2, 0.74]], 7, 0.22, 2.9, 28, Math.PI * 0.5, Math.PI)), kelp);
  const head = pivot(torso, 0, 0.78, 0.1);
  mesh(head, geo('dt-skull', () => new THREE.SphereGeometry(0.17, 16, 12).scale(0.95, 1.05, 1)), skin, 0, 0, 0);
  const jaw = pivot(head, 0, -0.06, 0.02);
  mesh(jaw, geo('dt-jaw', () => new THREE.SphereGeometry(0.12, 12, 10).scale(1, 0.55, 1.1)), skin, 0, -0.08, 0.06);
  for (const sx of [-1, 1]) mesh(head, geo('dt-eye', () => new THREE.SphereGeometry(0.03, 10, 8)), eye, sx * 0.06, 0.03, 0.15, 0, 0, 0, false);
  // weed for hair, hanging lank over the skull
  for (let i = 0; i < 5; i++) mesh(head, strand, kelp, (i - 2) * 0.06, 0.13, -0.04 - Math.abs(i - 2) * 0.02, -0.5, 0, (i - 2) * 0.2).scale.set(0.6, 0.55, 0.6);
  const arms: THREE.Group[] = [];
  const elbows: THREE.Group[] = [];
  const finger = geo('dt-finger', () => new THREE.ConeGeometry(0.025, 0.14, 6).rotateX(Math.PI).translate(0, -0.07, 0));
  for (const sx of [-1, 1]) {
    const arm = pivot(torso, sx * 0.36, 0.6, 0);
    mesh(arm, geo('dt-upper', () => new THREE.CapsuleGeometry(0.08, 0.3, 4, 10)), skin, 0, -0.2, 0);
    const elbow = pivot(arm, 0, -0.4, 0);
    mesh(elbow, geo('dt-fore', () => new THREE.CapsuleGeometry(0.07, 0.3, 4, 10)), skin, 0, -0.18, 0);
    mesh(elbow, geo('dt-hand', () => new THREE.SphereGeometry(0.1, 12, 8).scale(1, 1.2, 0.6)), skin, 0, -0.42, 0.02);
    for (let i = -1; i <= 1; i++) mesh(elbow, finger, skin, i * 0.05, -0.52, 0.03, 0.2, 0, i * 0.15, false);
    // a trailing frond of kelp caught round the wrist
    mesh(elbow, strand, kelp, 0, -0.28, -0.06, 0.2, 0, 0).scale.set(0.5, 0.5, 0.5);
    arms.push(arm);
    elbows.push(elbow);
  }
  skinRigid(root, 'drowned-thrall', rig, [], bounds(2 * s));

  let phase = Math.random() * 10;
  let clock = Math.random() * 10;
  return {
    root,
    height: 1.9 * s,
    animate(u, dt, deathTime, wobble) {
      clock += dt;
      const speed = hypot(u.vx, u.vz);
      const gait = Math.min(1, speed / 1.6);
      phase += dt * (2 + speed * 1.5);
      const sw = Math.sin(phase);
      // a shamble: the left leg steps, the right drags after it, the whole body lurching over each step
      legs[0]!.rotation.x = sw * 0.55 * gait;
      legs[1]!.rotation.x = -sw * 0.28 * gait - 0.1 * gait;
      knees[0]!.rotation.x = Math.max(0, -sw) * 0.7 * gait;
      knees[1]!.rotation.x = 0.1 * gait;
      hips.position.y = 0.95 + Math.abs(Math.cos(phase)) * 0.04 * gait - gait * 0.03;
      // the lunge: both arms thrown forward to grab, the body after them, the jaw gaping
      const a = u.sinceAction;
      const grab = a < 0.55 ? Math.sin(Math.min(1, a / 0.55) * Math.PI) : 0;
      torso.rotation.set(0.35 + gait * 0.1 + grab * 0.35 + wobble * 0.1, Math.sin(clock * 0.6) * 0.08, sw * 0.13 * gait + Math.sin(clock * 0.9) * 0.04 + wobble * 0.08);
      head.rotation.set(-0.15 - grab * 0.3, Math.sin(clock * 0.5) * 0.2, Math.sin(clock * 0.7) * 0.16);
      jaw.rotation.x = 0.25 + Math.sin(clock * 1.3) * 0.05 + grab * 0.45;
      arms.forEach((arm, i) => {
        const sx = i ? 1 : -1;
        arm.rotation.x = -0.55 + Math.sin(phase + i * Math.PI) * 0.22 * gait - grab * 1.15;
        arm.rotation.z = sx * (0.12 - grab * 0.2);
        elbows[i]!.rotation.x = -0.35 + grab * 0.3 + Math.sin(clock * 1.1 + i) * 0.05;
      });
      if (deathTime >= 0) {
        // it pitches forward onto its face and goes under
        const t = Math.min(1, deathTime / 0.7);
        const k = t * t;
        hips.position.y = 0.95 - k * 0.55 - Math.max(0, deathTime - SINKS.drownedThrall) * 0.45;
        torso.rotation.x = 0.35 + k * 1.05;
        for (const l of legs) l.rotation.x = -k * 0.4;
        for (const kn of knees) kn.rotation.x = k * 1.2;
        for (const arm of arms) arm.rotation.x = -0.55 - k * 1.3;
        jaw.rotation.x = 0.25 + k * 0.3;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Lantern Jelly

let jellyBell: THREE.Material | null = null;

/** A jellyfish's bell: clear, glowing cold at its rim and along canals of light inside, breathing. */
function jellyBellMaterial(): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.15 });
  const p = positionGeometry;
  const rim = pow(float(1).sub(saturate(abs(normalView.dot(positionView.normalize().negate())))), 2);
  const canals = smoothstep(0.045, 0.0, abs(n(5, p).sub(0.5)));
  const breathe = sin(time.mul(2.4)).mul(0.15).add(0.9);
  m.colorNode = vec3(0.3, 0.7, 0.9);
  m.emissiveNode = vec3(0.3, 0.85, 1).mul(rim.mul(1.5).add(canals.mul(0.9)).add(0.12)).mul(breathe);
  m.opacityNode = rim.mul(0.55).add(canals.mul(0.25)).add(0.18);
  return m;
}

const JELLY_HOVER = 1.5;

/**
 * Lantern Jellies: the Drowned Halls' shooters. A clear bell of cold soul
 * light drifting at head height, canals of light inside it, a bright core
 * that gathers each bolt, frilled arms and long glowing tentacles trailing
 * behind. It pulses as it swims; to shoot it clenches hard and the core
 * flares.
 */
function lanternJelly(): MonsterView {
  const bell = (jellyBell ??= jellyBellMaterial());
  const strand = glow(DROWNED_GLOW, 1.8);
  const core = glow(DROWNED_CORE, 5);
  const root = new THREE.Group();
  const rig = pivot(root, 0, 0, 0);
  const body = pivot(rig, 0, JELLY_HOVER, 0);
  const dome = pivot(body, 0, 0, 0);
  mesh(dome, geo('lj-bell', () => tattered([[0.47, -0.06], [0.5, 0.02], [0.49, 0.14], [0.42, 0.3], [0.3, 0.42], [0.15, 0.48], [0.02, 0.5]], 8, 0.09, 0.7)), bell, 0, 0, 0, 0, 0, 0, false);
  mesh(dome, geo('lj-inner', () => new THREE.SphereGeometry(0.3, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(1, 0.75, 1)), bell, 0, 0.04, 0, 0, 0, 0, false);
  const heart = mesh(dome, geo('lj-core', () => new THREE.SphereGeometry(0.13, 14, 10).scale(1, 0.8, 1)), core, 0, 0.18, 0, 0, 0, 0, false);
  // four lobes of light round the core
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    mesh(dome, geo('lj-lobe', () => new THREE.TorusGeometry(0.07, 0.018, 6, 14)), strand, Math.cos(a) * 0.17, 0.14, Math.sin(a) * 0.17, Math.PI / 2, 0, a, false);
  }
  // frilled arms from the middle, long fine tentacles from the margin
  const arms: THREE.Group[] = [];
  // (each a thin ribbon curling as it hangs, splayed out from the next so the four never read as one bar)
  const frill = geo('lj-arm', () => {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      pts.push(new THREE.Vector3(t * 0.13 + Math.sin(t * 11) * 0.045 * t, -t * 0.82, Math.cos(t * 9) * 0.04 * t));
    }
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 28, 0.018, 5, false);
  });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.3;
    const arm = pivot(body, Math.cos(a) * 0.1, -0.02, Math.sin(a) * 0.1);
    mesh(arm, frill, strand, 0, 0, 0, 0, -a, 0, false);
    arms.push(arm);
  }
  const tentacles: THREE.Group[] = [];
  const line = geo('lj-tentacle', () => new THREE.ConeGeometry(0.014, 1.3, 5).rotateX(Math.PI).translate(0, -0.65, 0));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const t = pivot(body, Math.cos(a) * 0.44, -0.04, Math.sin(a) * 0.44);
    mesh(t, line, strand, 0, 0, 0, 0, 0, 0, false);
    t.scale.y = 0.75 + ((i * 3) % 4) * 0.12;
    tentacles.push(t);
  }
  skinRigid(root, 'lantern-jelly', rig, [heart], bounds(2.4));
  const lengths = tentacles.map((t) => t.scale.y);

  let clock = Math.random() * 10;
  let lean = 0;
  return {
    root,
    height: 2.1,
    linger: 2.6,
    animate(u, dt, deathTime, wobble) {
      clock += dt;
      lean += (Math.min(1, hypot(u.vx, u.vz) / 3) - lean) * Math.min(1, dt * 4);
      // swimming: the bell clenches and opens, lifting it a little each beat
      const a = u.sinceAction;
      const spit = a < 0.35 ? Math.sin((a / 0.35) * Math.PI) : 0;
      const beat = Math.sin(clock * 2.6);
      const squeeze = Math.max(0, beat) * 0.09 + spit * 0.2;
      dome.scale.set(1 - squeeze, 1 + squeeze * 0.9, 1 - squeeze);
      body.position.y = JELLY_HOVER + Math.sin(clock * 2.6 - 0.8) * 0.06 + Math.sin(clock * 0.7) * 0.08;
      body.rotation.set(lean * 0.35 + wobble * 0.1, 0, Math.sin(clock * 0.9) * 0.05 + wobble * 0.08);
      // the core gathers light between bolts and flares as one leaves
      heart.scale.setScalar(0.7 + Math.min(1, a / 1.2) * 0.4 + spit * 0.7 + Math.max(0, beat) * 0.06);
      // tentacles trail and wave, swept back as it swims
      tentacles.forEach((t, i) => {
        t.rotation.x = lean * 0.7 + Math.sin(clock * 1.8 + i * 0.9) * 0.14;
        t.rotation.z = Math.sin(clock * 1.4 + i * 1.7) * 0.14;
        t.scale.y = lengths[i]! * (1 - squeeze * 0.6);
      });
      arms.forEach((arm, i) => {
        arm.rotation.x = lean * 0.5 + Math.sin(clock * 1.2 + i * 1.6) * 0.1;
        arm.rotation.z = Math.sin(clock * 1.5 + i) * 0.1;
      });
      if (deathTime >= 0) {
        // the light goes out of it and it settles to the floor, deflating
        const t = Math.min(1, deathTime / 1.1);
        body.position.y = JELLY_HOVER * (1 - t) + 0.15 * t - Math.max(0, deathTime - SINKS.lanternJelly) * 0.3;
        dome.scale.set(1 + t * 0.35, Math.max(0.2, 1 - t * 0.75), 1 + t * 0.35);
        heart.scale.setScalar(Math.max(0.01, 1 - t * 1.4));
        for (const tt of tentacles) tt.rotation.x = t * 1.2;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tide Lurker

let lurkerSkin: THREE.Material | null = null;

/** A deep-water fish's hide: near-black blue-green on its back, pale underneath, wet, with rows of cold lights down its flanks that pulse. */
function lurkerSkinMaterial(): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.4 });
  const p = positionGeometry;
  const top = smoothstep(-0.35, 0.35, normalWorld.y);
  const mottle = n(4, p).mul(0.6).add(n(13, p).mul(0.4));
  // dark banding across the back, as on a deep-water fish
  const bands = smoothstep(0.35, 0.65, sin(p.z.mul(7).add(n(3, p).mul(4))).mul(0.5).add(0.5));
  const back = mix(mix(vec3(0.02, 0.045, 0.06), vec3(0.07, 0.13, 0.14), mottle), vec3(0.01, 0.02, 0.03), bands.mul(0.6));
  m.colorNode = mix(mix(vec3(0.36, 0.4, 0.36), vec3(0.52, 0.55, 0.48), mottle), back, top);
  // rows of cold lights down its flanks, pulsing in a wave from head to tail
  const spots = smoothstep(0.2, 0.08, mx_worley_noise_float(p.mul(7))).mul(smoothstep(0.8, 0.2, abs(normalWorld.y)));
  m.emissiveNode = vec3(0.3, 0.9, 1).mul(spots.mul(sin(time.mul(1.7).add(p.z.mul(3))).mul(0.45).add(1)).mul(1.8));
  m.roughnessNode = float(0.32).add(mottle.mul(0.25));
  return m;
}

/** How far under the floor a Tide Lurker swims: only the tall fin on its back cuts through. */
const LURK_DEPTH = 1.45;

/**
 * Tide Lurkers: the Drowned Halls' heavies. A great flat-headed fish that
 * hauls itself along on its fore-fins, a jaw of needle teeth jutting under
 * a glowing lure, cold lights down its flanks and a tall fin on its back.
 * It sinks into the floor and swims beneath it, only that fin showing,
 * and bursts up under its prey with its jaws wide.
 */
function tideLurker(): MonsterView {
  const skin = (lurkerSkin ??= lurkerSkinMaterial());
  const tooth = mats().bone;
  const lure = glow(DROWNED_CORE, 5);
  const root = new THREE.Group();
  const rig = pivot(root, 0, 0, 0);
  const body = pivot(rig, 0, 0.75, 0);
  mesh(body, geo('tl-body', () => new THREE.SphereGeometry(0.6, 24, 16).scale(1, 0.72, 1.45)), skin, 0, 0, -0.15);
  // the fin along its back, the front one tall enough to cut the floor while it swims under it
  const fin = geo('tl-fin', () => new THREE.ConeGeometry(0.55, 1, 4, 1).scale(0.06, 1, 1).translate(0, 0.5, 0));
  mesh(body, fin, skin, 0, 0.3, 0.05, -0.55, 0, 0).scale.set(1, 1.15, 1);
  mesh(body, fin, skin, 0, 0.28, -0.55, -0.8, 0, 0).scale.set(1, 0.6, 0.7);
  for (let i = 0; i < 5; i++) mesh(body, geo('tl-spine', () => new THREE.ConeGeometry(0.03, 0.5, 6).translate(0, 0.25, 0)), tooth, 0, 0.3 + i * 0.02, 0.3 - i * 0.18, -0.55 - i * 0.08, 0, 0).scale.setScalar(1.6 - i * 0.2);
  // a wide flat head and the underbite of a jaw full of needles
  const head = pivot(body, 0, 0.05, 0.75);
  mesh(head, geo('tl-skull', () => new THREE.SphereGeometry(0.55, 22, 14).scale(1.15, 0.6, 0.9)), skin, 0, 0.06, 0.22);
  const upper = geo('tl-fang', () => new THREE.ConeGeometry(0.03, 0.2, 6).rotateX(Math.PI).translate(0, -0.1, 0));
  for (let i = 0; i < 7; i++) {
    const a = (i / 6 - 0.5) * 2.2;
    mesh(head, upper, tooth, Math.sin(a) * 0.48, -0.08, 0.22 + Math.cos(a) * 0.38, 0, 0, 0, false).scale.setScalar(1 - Math.abs(a) * 0.2);
  }
  const jaw = pivot(head, 0, -0.1, -0.05);
  mesh(jaw, geo('tl-jaw', () => new THREE.SphereGeometry(0.5, 20, 12, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55).scale(1.12, 0.6, 1.05)), skin, 0, 0.02, 0.32);
  const lower = geo('tl-tooth', () => new THREE.ConeGeometry(0.035, 0.28, 6).translate(0, 0.14, 0));
  for (let i = 0; i < 9; i++) {
    const a = (i / 8 - 0.5) * 2.4;
    mesh(jaw, lower, tooth, Math.sin(a) * 0.52, -0.02, 0.32 + Math.cos(a) * 0.46, 0.25, 0, -Math.sin(a) * 0.2, false).scale.setScalar(1 - Math.abs(a) * 0.18);
  }
  for (const sx of [-1, 1]) mesh(head, geo('tl-eye', () => new THREE.SphereGeometry(0.06, 10, 8)), lure, sx * 0.4, 0.22, 0.3, 0, 0, 0, false);
  // the lure: a stalk curling up and forward off its brow, a bulb of light at the end
  const stalk = pivot(head, 0, 0.3, 0.12);
  mesh(stalk, geo('tl-stalk', () => new THREE.CylinderGeometry(0.025, 0.04, 0.7, 6).translate(0, 0.35, 0)), tooth, 0, 0, 0, 0.35);
  const tip = pivot(stalk, 0, 0.66, 0.24);
  mesh(tip, geo('tl-stalk-tip', () => new THREE.CylinderGeometry(0.015, 0.025, 0.4, 6).translate(0, 0.2, 0)), tooth, 0, 0, 0, 1.2);
  const bulb = mesh(tip, geo('tl-bulb', () => new THREE.SphereGeometry(0.1, 14, 10)), lure, 0, 0.34, 0.15, 0, 0, 0, false);
  // fore-fins it hauls itself along on
  const fins: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const f = pivot(body, sx * 0.5, -0.3, 0.35);
    mesh(f, geo('tl-flipper', () => new THREE.SphereGeometry(0.32, 14, 8).scale(0.45, 0.16, 1).translate(0, 0, 0.18)), skin, sx * 0.12, -0.08, 0, 0, 0, sx * 0.3);
    fins.push(f);
  }
  // a tail in three joints, ending in a fan
  const tail: THREE.Group[] = [];
  let parent: THREE.Object3D = body;
  for (let i = 0; i < 3; i++) {
    const seg = pivot(parent, 0, i ? 0 : 0.02, i ? -0.42 : -0.95);
    const r = 0.36 - i * 0.09;
    mesh(seg, geo(`tl-tail-${i}`, () => new THREE.SphereGeometry(r, 14, 10).scale(0.85, 0.75, 1.5)), skin, 0, 0, -0.2);
    tail.push(seg);
    parent = seg;
  }
  mesh(parent, geo('tl-fan', () => new THREE.ConeGeometry(0.45, 0.7, 4, 1).scale(0.06, 1, 1).rotateX(-Math.PI / 2).translate(0, 0, -0.55)), skin, 0, 0, -0.1);
  skinRigid(root, 'tide-lurker', rig, [bulb], bounds(3));

  let phase = Math.random() * 10;
  let clock = Math.random() * 10;
  /** How far under the floor it is (0 up, 1 swimming under with only its fin out). */
  let under = 0;
  /** Seconds since it burst up out of the floor. */
  let leapt = 9;
  let was: 'up' | 'under' | 'rising' = 'up';
  return {
    root,
    height: 1.7,
    animate(u, dt, deathTime, wobble) {
      clock += dt;
      const state = u.brain instanceof DescentMonsterBrain ? u.brain.lurkState : u.untargetable > 0 ? 'under' : 'up';
      if (was !== 'up' && state === 'up') leapt = 0;
      was = state;
      leapt += dt;
      const goal = state === 'up' ? 0 : 1;
      under += (goal - under) * Math.min(1, dt * (goal ? 5 : 30));
      const speed = hypot(u.vx, u.vz);
      const gait = Math.min(1, speed / 2);
      phase += dt * (2.4 + speed * 1.8);
      const sw = Math.sin(phase);
      // hauling itself along: the fore-fins pull by turns, the body rolls and the tail sweeps
      fins.forEach((f, i) => {
        const sx = i ? 1 : -1;
        f.rotation.x = Math.sin(phase + i * Math.PI) * 0.6 * gait;
        f.rotation.z = sx * (0.1 + Math.max(0, Math.sin(phase + i * Math.PI)) * 0.3 * gait) - sx * under * 0.6;
      });
      tail.forEach((t, i) => (t.rotation.y = Math.sin(clock * 2.2 + phase * 0.6 - i * 0.9) * (0.2 + gait * 0.15 + under * 0.25)));
      // a burst out of the floor: it leaps clear with its jaws wide, then thumps down
      const leap = leapt < 0.55 ? Math.sin((leapt / 0.55) * Math.PI) : 0;
      const tremble = state === 'rising' ? Math.sin(clock * 50) * 0.05 : 0;
      rig.position.y = -under * LURK_DEPTH + leap * 0.9 + tremble;
      body.position.y = 0.75 + Math.abs(Math.cos(phase)) * 0.04 * gait;
      // the bite: the jaw drops wide and snaps shut
      const a = u.sinceAction;
      const bite = a < 0.35 ? Math.sin((a / 0.35) * Math.PI) : 0;
      jaw.rotation.x = 0.06 + bite * 0.75 + leap * 0.9 + Math.sin(clock * 1.1) * 0.04;
      head.rotation.set(-bite * 0.25 - leap * 0.7, Math.sin(clock * 0.8) * 0.1 * (1 - gait), Math.sin(phase) * 0.06 * gait);
      body.rotation.set(-leap * 0.5 + wobble * 0.05, 0, sw * 0.07 * gait + wobble * 0.06);
      stalk.rotation.x = 0.35 + Math.sin(clock * 1.6) * 0.12 + gait * 0.2;
      tip.rotation.x = 1.2 + Math.sin(clock * 2.3) * 0.15;
      bulb.scale.setScalar(1 + Math.sin(clock * 3.1) * 0.15);
      if (deathTime >= 0) {
        // it rolls over belly-up, the lure guttering out, and sinks
        const t = Math.min(1, deathTime / 0.9);
        body.rotation.z = t * t * 2.6;
        rig.position.y = -Math.max(0, deathTime - SINKS.tideLurker) * 0.5;
        jaw.rotation.x = 0.06 + t * 0.4;
        bulb.scale.setScalar(Math.max(0.01, 1 - t));
        for (const f of fins) f.rotation.x *= 1 - t;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Gravehound and Packleader

/** The Abyss's soul fire, in a Gravehound's eyes and mane. */
export const HOUND_GLOW = 0x5dffa0;
export const HOUND_CORE = 0xdcffe8;

let houndFlame: THREE.Material | null = null;

/** Soul fire licking up off a cone (uv.y 0 at its base, 1 at its tip): pale at the root, green, guttering to nothing. */
function houndFlameMaterial(): THREE.Material {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const h = uv().y;
  const p = positionGeometry;
  const lick = mx_noise_float(vec3(p.x.mul(11), p.y.mul(7).sub(time.mul(4.5)), p.z.mul(11))).mul(0.5).add(0.5);
  const body = smoothstep(1, 0.15, h.add(lick.mul(0.45)));
  m.colorNode = mix(vec3(0.12, 1, 0.5), vec3(0.75, 1, 0.85), smoothstep(0.5, 0, h)).mul(body.mul(1.9));
  m.opacityNode = body;
  return m;
}

/**
 * Gravehounds, the Abyss's many, and the Packleader that runs them: gaunt
 * hounds with grave-grey hide stretched over the chest and haunches and the
 * ribs bare between, a long bone skull with soul fire in its sockets, and a
 * mane of the same green fire down the neck. They lope in, crouch and
 * pounce. The Packleader stands half as tall again under a crown of bone
 * antlers, its mane a blaze and a soul burning in its ribs, and throws its
 * head back to howl the pack into a frenzy.
 */
function gravehound(leader: boolean): MonsterView {
  const m = mats();
  const ivory = (wyrmMats ??= wyrmMaterials()).ivory;
  const flame = (houndFlame ??= houndFlameMaterial());
  const eye = glow(HOUND_GLOW, 6);
  const root = new THREE.Group();
  const s = leader ? 1.7 : 1.15;
  const rig = pivot(root, 0, 0, 0);
  rig.scale.setScalar(s);
  const BODY = 0.78;
  const body = pivot(rig, 0, BODY, 0);
  // a deep keel of a chest under high shoulders, lean haunches set lower, grave-grey hide hanging off both in
  // tatters; between them only the ribs
  mesh(body, geo('gh-chest', () => new THREE.SphereGeometry(0.25, 20, 14).scale(0.56, 0.82, 1)), m.fur, 0, 0.01, 0.32);
  mesh(body, geo('gh-withers', () => new THREE.SphereGeometry(0.18, 16, 12).scale(0.74, 0.62, 1.05)), m.fur, 0, 0.15, 0.3);
  mesh(body, geo('gh-haunch', () => new THREE.SphereGeometry(0.18, 16, 12).scale(0.72, 0.78, 1.05)), m.fur, 0, 0.04, -0.38);
  mesh(body, geo('gh-chest-rags', () => tattered([[0.2, -0.24], [0.21, -0.1], [0.19, 0.04], [0.14, 0.16], [0.05, 0.24]], 7, 0.1, 3.3, 24).scale(0.64, 1, 1.22)), m.fur, 0, 0.03, 0.3);
  mesh(body, geo('gh-haunch-rags', () => tattered([[0.16, -0.18], [0.17, -0.06], [0.15, 0.06], [0.1, 0.16], [0.04, 0.2]], 6, 0.08, 5.1, 22).scale(0.78, 1, 1.25)), m.fur, 0, 0.03, -0.38);
  const vert = geo('gh-vert', () => new THREE.SphereGeometry(0.042, 8, 6).scale(1, 0.75, 1.35));
  for (let i = 0; i < 10; i++) {
    const k = i / 9;
    // (the spine runs down from the shoulders to the haunches)
    mesh(body, vert, ivory, 0, 0.27 - k * 0.07 + Math.sin(k * Math.PI) * 0.015, 0.3 - k * 0.68);
  }
  // shoulder blades standing out of the hide
  for (const sx of [-1, 1]) mesh(body, geo('gh-scapula', () => new THREE.SphereGeometry(0.08, 10, 8).scale(0.3, 1.1, 0.8)), ivory, sx * 0.095, 0.16, 0.32, -0.35, 0, sx * 0.25);
  ([[0.12, 0.17], [0.04, 0.165], [-0.04, 0.155], [-0.12, 0.14], [-0.19, 0.12]] as const).forEach(([z, r]) => {
    // (each rib an open hoop round the chest, the gap underneath)
    const g = geo(`gh-rib-${r}`, () => new THREE.TorusGeometry(r, 0.013, 6, 18, Math.PI * 1.45).rotateZ(-Math.PI * 0.225).scale(0.7, 0.8, 1));
    mesh(body, g, ivory, 0, 0.1 - (0.12 - z) * 0.2, z);
  });
  // a soul guttering in the ribcage (the Packleader's a blaze)
  const soul = geo('gh-soul', () => new THREE.ConeGeometry(0.09, 0.3, 7, 1, true).translate(0, 0.15, 0));
  mesh(body, soul, flame, 0, -0.07, -0.03, 0, 0, 0, false).scale.setScalar(leader ? 1.5 : 1);
  // neck and mane
  const neck = pivot(body, 0, 0.12, 0.5);
  mesh(neck, geo('gh-neck', () => new THREE.CapsuleGeometry(0.085, 0.2, 4, 10).rotateX(-0.9)), m.fur, 0, 0.08, 0.06);
  const mane = pivot(neck, 0, 0.1, -0.02);
  const lick = geo('gh-flame', () => new THREE.ConeGeometry(0.055, 0.34, 6, 1, true).translate(0, 0.17, 0));
  const tufts = leader ? 9 : 6;
  for (let i = 0; i < tufts; i++) {
    const k = i / (tufts - 1);
    const o = mesh(mane, lick, flame, Math.sin(i * 2.3) * 0.03, 0.08 - k * 0.1, 0.12 - k * 0.42, -0.9 - k * 0.3, 0, Math.sin(i * 1.7) * 0.2, false);
    o.scale.setScalar((leader ? 1.4 : 1) * (0.75 + Math.sin(k * Math.PI) * 0.45));
  }
  // a long bone skull: sockets lit, a snout of fangs, the lower jaw on its own hinge
  const head = pivot(neck, 0, 0.2, 0.16);
  mesh(head, geo('gh-skull', () => new THREE.SphereGeometry(0.13, 16, 12).scale(0.9, 0.78, 1.25)), ivory, 0, 0, 0.02);
  mesh(head, geo('gh-snout', () => new THREE.CylinderGeometry(0.038, 0.08, 0.32, 10).rotateX(Math.PI / 2).scale(1, 0.72, 1)), ivory, 0, -0.03, 0.23);
  mesh(head, geo('gh-brow', () => new THREE.SphereGeometry(0.05, 10, 8).scale(2.3, 0.6, 1.3)), m.fur, 0, 0.07, 0.03);
  // grave-hide still clinging over the back of the skull, torn off the muzzle
  mesh(head, geo('gh-scalp', () => new THREE.SphereGeometry(0.125, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.42).scale(0.95, 0.85, 1.1)), m.fur, 0, 0.012, -0.04, -0.5, 0, 0);
  const fang = geo('gh-fang', () => new THREE.ConeGeometry(0.012, 0.065, 5).rotateX(Math.PI));
  for (const sx of [-1, 1]) {
    mesh(head, geo('gh-eye', () => new THREE.SphereGeometry(0.026, 10, 8)), eye, sx * 0.058, 0.025, 0.11, 0, 0, 0, false);
    mesh(head, geo('gh-cheek', () => new THREE.SphereGeometry(0.035, 8, 6).scale(0.7, 0.8, 1.6)), ivory, sx * 0.085, -0.035, 0.08);
    mesh(head, geo('gh-ear', () => new THREE.ConeGeometry(0.045, 0.18, 5).translate(0, 0.09, 0)), m.fur, sx * 0.065, 0.075, -0.06, -1.05, 0, -sx * 0.3);
    for (let i = 0; i < 3; i++) mesh(head, fang, ivory, sx * 0.03, -0.07, 0.15 + i * 0.075, 0, 0, 0, false);
  }
  const jaw = pivot(head, 0, -0.06, 0.04);
  mesh(jaw, geo('gh-jaw', () => new THREE.CylinderGeometry(0.03, 0.055, 0.3, 10).rotateX(Math.PI / 2).scale(1, 0.5, 1)), ivory, 0, -0.02, 0.17);
  const lower = geo('gh-lower', () => new THREE.ConeGeometry(0.01, 0.05, 5));
  for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) mesh(jaw, lower, ivory, sx * 0.025, 0.01, 0.09 + i * 0.08, 0, 0, 0, false);
  if (leader) {
    // a crown of bone antlers, branching back over the neck
    const beam = geo('pl-beam', () => new THREE.ConeGeometry(0.03, 0.5, 7).translate(0, 0.25, 0));
    const tine = geo('pl-tine', () => new THREE.ConeGeometry(0.018, 0.2, 6).translate(0, 0.1, 0));
    for (const sx of [-1, 1]) {
      const a = pivot(head, sx * 0.06, 0.08, -0.04);
      a.rotation.set(-0.7, 0, -sx * 0.55);
      mesh(a, beam, ivory, 0, 0, 0);
      mesh(a, tine, ivory, 0, 0.16, 0, 0.9, 0, sx * 0.3);
      mesh(a, tine, ivory, 0, 0.3, 0, 0.7, 0, -sx * 0.5);
      mesh(a, tine, ivory, 0, 0.4, 0, -0.5, 0, sx * 0.6);
    }
  }
  // four long legs: hide-wrapped muscle above, bare bone below, a splay of claws; the hind legs bent back at the hock
  const legs: THREE.Group[] = [];
  const knees: THREE.Group[] = [];
  const claw = geo('gh-claw', () => new THREE.ConeGeometry(0.014, 0.07, 5).rotateX(Math.PI / 2));
  for (const [x, z, hind] of [[-0.11, 0.36, false], [0.11, 0.36, false], [-0.12, -0.4, true], [0.12, -0.4, true]] as const) {
    const leg = pivot(body, x, hind ? -0.09 : -0.06, z);
    if (hind) mesh(leg, geo('gh-thigh-h', () => new THREE.SphereGeometry(0.095, 12, 10).scale(0.7, 1.6, 1)), m.fur, 0, -0.12, 0.01);
    else mesh(leg, geo('gh-thigh', () => new THREE.CapsuleGeometry(0.058, 0.2, 4, 8)), m.fur, 0, -0.14, 0);
    const knee = pivot(leg, 0, hind ? -0.3 : -0.32, 0);
    mesh(knee, geo('gh-joint', () => new THREE.SphereGeometry(0.035, 8, 6)), ivory, 0, 0, 0);
    mesh(knee, geo('gh-shin', () => new THREE.CylinderGeometry(0.02, 0.028, 0.36, 7).translate(0, -0.18, 0)), ivory, 0, 0, 0);
    mesh(knee, geo('gh-paw', () => new THREE.SphereGeometry(0.04, 10, 8).scale(1, 0.55, 1.4)), ivory, 0, -0.38, 0.02);
    for (let i = -1; i <= 1; i++) mesh(knee, claw, ivory, i * 0.022, -0.39, 0.07, 0, 0, 0, false);
    legs.push(leg);
    knees.push(knee);
  }
  // a whip of bare vertebrae for a tail, a lick of fire off its tip
  const tail = pivot(body, 0, 0.14, -0.56);
  for (let i = 0; i < 6; i++) mesh(tail, vert, ivory, 0, -0.03 - i * 0.035, -0.04 - i * 0.06).scale.setScalar(1 - i * 0.1);
  mesh(tail, lick, flame, 0, -0.2, -0.4, -2.1, 0, 0, false).scale.setScalar(0.8);
  skinRigid(root, leader ? 'packleader' : 'gravehound', rig, [], bounds((leader ? 1.25 : 0.95) * s));

  let phase = Math.random() * 10;
  let breath = Math.random() * 10;
  let crouch = 0;
  let howl = 0;
  return {
    root,
    height: (leader ? 1.25 : 0.95) * s,
    animate(u, dt, deathTime, wobble) {
      const brain = u.brain instanceof DescentMonsterBrain ? u.brain : null;
      const gather = brain?.gathering ?? 0;
      const air = u.forced !== null;
      // ease in and out of the crouch and the howl rather than snapping
      crouch += ((!leader && gather > 0 ? 1 : 0) - crouch) * Math.min(1, dt * 14);
      howl += ((leader && gather > 0 ? 1 : 0) - howl) * Math.min(1, dt * (gather > 0 ? 6 : 3));
      const speed = hypot(u.vx, u.vz);
      phase += dt * (4.5 + speed * 2.4);
      breath += dt * 2.6;
      const gait = air ? 0 : Math.min(1, speed / 2.5);
      // a bounding lope: the forelegs reach together, then the hind legs drive
      const fore = Math.sin(phase) * 0.75 * gait;
      const hind = Math.sin(phase + 2.2) * 0.75 * gait;
      const leap = air ? 1 : 0;
      for (const i of [0, 1]) {
        legs[i]!.rotation.x = fore - leap * 0.9 + crouch * 0.35;
        knees[i]!.rotation.x = Math.max(0, -fore) * 0.6 - crouch * 0.6 + leap * 0.3;
      }
      for (const i of [2, 3]) {
        // (at rest the thigh reaches forward and the shin slants back to the hock)
        legs[i]!.rotation.x = -0.3 + hind + leap * 1.1 - crouch * 0.6;
        knees[i]!.rotation.x = 0.55 - Math.max(0, hind) * 0.5 + crouch * 1.0 - leap * 0.4;
      }
      body.position.y = BODY + Math.abs(Math.cos(phase)) * 0.05 * gait - crouch * 0.2 + Math.sin(breath) * 0.008;
      // it pitches with the lope, crouches nose down and rump up, flies flat out, and rears to howl
      body.rotation.x = Math.sin(phase + 1) * 0.07 * gait + crouch * 0.12 - howl * 0.22 + wobble * 0.05;
      body.rotation.z = wobble * 0.08;
      // the bite: head driven forward, jaws snapping; the howl: head thrown back, jaws wide
      const a = u.sinceAction;
      const bite = a < 0.35 && !air ? Math.sin((a / 0.35) * Math.PI) : 0;
      neck.rotation.x = bite * 0.35 + crouch * 0.45 - howl * 0.95 - leap * 0.25 + Math.sin(breath * 0.5) * 0.04;
      head.rotation.x = -bite * 0.15 - howl * 0.35 + crouch * 0.1;
      jaw.rotation.x = bite * 0.75 + howl * 0.9 + leap * 0.55 + crouch * 0.2 + Math.max(0, Math.sin(breath * 1.3)) * 0.06;
      mane.scale.setScalar(1 + howl * 0.45 + crouch * 0.15);
      tail.rotation.x = -0.35 + Math.sin(phase * 0.5) * 0.15 * gait + leap * 0.5 - crouch * 0.3;
      tail.rotation.y = Math.sin(breath * 0.9) * 0.25 + Math.sin(phase) * 0.2 * gait;
      if (deathTime >= 0) {
        // the legs give and it falls on its side, the fire going out of it as it sinks
        const t = Math.min(1, deathTime / 0.45);
        body.rotation.z = t * t * 1.45;
        body.position.y = BODY - t * 0.42 - Math.max(0, deathTime - SINKS.gravehound) * 0.5;
        neck.rotation.x = t * 0.5;
        jaw.rotation.x = t * 0.4;
        mane.scale.setScalar(Math.max(0.01, 1 - deathTime * 0.8));
        for (const l of legs) l.rotation.x *= 1 - t;
      }
    },
  };
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
      root.position.y = -Math.max(0, deathTime - SINKS.treasureWyrm) * 0.6;
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
        body.position.y = SHADE_HOVER * (1 - t) - Math.max(0, deathTime - SINKS.shade) * 0.5;
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
  const ember = mesh(torso, geo('gk-ember', () => new THREE.SphereGeometry(0.038, 12, 10)), glow(KEEPER_GLOW, 1.5), 0, 0.33, 0.02, 0, 0, 0, false);
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
  mesh(staff, geo('gk-staff', () => new THREE.CylinderGeometry(0.016, 0.022, 1.5, 7).translate(0, 0.25, 0)), iron);
  mesh(staff, geo('gk-crook', () => new THREE.TorusGeometry(0.09, 0.016, 6, 14, Math.PI).rotateY(Math.PI / 2).translate(0, 1.0, 0.09)), iron);
  const lantern = pivot(staff, 0, 1.0, 0.18);
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
      shoulders[1]!.rotation.x = -0.95 - lift * 0.75;
      elbows[1]!.rotation.x = -0.55 + lift * 0.35;
      shoulders[1]!.rotation.z = 0.12;
      // the staff stays upright whatever the arm does, tipping toward the patient as the lantern lifts
      staff.rotation.x = -(torso.rotation.x + shoulders[1]!.rotation.x + elbows[1]!.rotation.x) + lift * 0.45;
      shoulders[0]!.rotation.x = -0.85 + Math.sin(phase + Math.PI) * 0.25 * gait - lift * 0.5;
      elbows[0]!.rotation.x = -0.5 - lift * 0.3;
      shoulders[0]!.rotation.z = -0.15;
      // (the lantern hangs plumb from the crook, cancelling the staff's tip, and trails a little as it walks)
      lantern.rotation.x = Math.sin(clock * 1.9) * 0.12 - lean * 0.35 - lift * 0.45;
      lantern.rotation.z = Math.sin(clock * 1.4) * 0.1;
      const flick = 0.9 + Math.sin(clock * 13) * 0.12 + Math.sin(clock * 29 + 1) * 0.08;
      flame.scale.setScalar(flick * (1 + lift * 0.9));
      ember.scale.setScalar(0.85 + Math.sin(clock * 2.4) * 0.15 + lift * 0.3);
      if (deathTime >= 0) {
        // it falls apart into a heap of bones, the flame and ember going out
        const t = Math.min(1, deathTime / 0.7);
        const k = t * t;
        hips.position.y = HIP * (1 - k * 0.82) - Math.max(0, deathTime - SINKS.gravekeeper) * 0.4;
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

// ---------------------------------------------------------------------------
// Ossuary King

/**
 * The lord of the Abyss: a towering crowned skeleton in a royal mantle, iron
 * pauldrons spiked with bone, a soul fire burning amber in its ribs and a
 * great soul-forged blade. It swings the blade overhead and down, raises it
 * high in both hands and drives it into the floor for its Grave Toll, and
 * kneels and sinks when it falls. Every material is one the other monsters
 * already use, so it builds no shader when it rises.
 */
function ossuaryKing(): MonsterView {
  const { ivory, scales: gold } = (wyrmMats ??= wyrmMaterials());
  const iron = mats().hoof;
  const shroud = (keeperShroud ??= keeperShroudMaterial());
  const fire = glow(KEEPER_GLOW, 1.6);
  const root = new THREE.Group();
  const S = 2.5;
  const rig = pivot(root, 0, 0, 0);
  rig.scale.setScalar(S);
  const HIP = 0.95;
  const hips = pivot(rig, 0, HIP, 0);
  mesh(hips, geo('ok-pelvis', () => new THREE.SphereGeometry(0.16, 16, 12).scale(1.4, 0.7, 0.9)), ivory);
  // a royal tabard about the hips under a gold belt
  mesh(hips, geo('ok-tabard', () => tattered([[0.3, -0.66], [0.28, -0.36], [0.24, -0.12], [0.2, 0.05]], 7, 0.2, 3.1, 32)), shroud);
  mesh(hips, geo('ok-belt', () => new THREE.TorusGeometry(0.205, 0.022, 6, 28).rotateX(Math.PI / 2).scale(1, 1, 0.85)), gold, 0, 0.02, 0);
  const thighs: THREE.Group[] = [];
  const knees: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const hip = pivot(hips, sx * 0.13, -0.03, 0);
    bone(hip, ivory, v3(0, 0, 0), v3(0, -0.45, 0), 0.045, 0.036);
    const knee = pivot(hip, 0, -0.45, 0);
    mesh(knee, geo('ok-kneecap', () => new THREE.SphereGeometry(0.05, 10, 8)), ivory, 0, 0, 0.015);
    bone(knee, ivory, v3(0, 0, 0), v3(0, -0.45, 0), 0.038, 0.03);
    // iron greaves over the shins
    mesh(knee, geo('ok-greave', () => new THREE.CylinderGeometry(0.06, 0.05, 0.3, 10, 1, true)), iron, 0, -0.2, 0.01);
    mesh(knee, geo('ok-foot', () => new THREE.SphereGeometry(0.07, 10, 8).scale(1, 0.5, 2.1)), ivory, 0, -0.46, 0.08);
    thighs.push(hip);
    knees.push(knee);
  }
  // spine and a great open ribcage around the soul fire
  const torso = pivot(hips, 0, 0.04, 0);
  for (let i = 0; i < 8; i++) mesh(torso, geo('ok-vertebra', () => new THREE.SphereGeometry(0.045, 10, 8).scale(1.2, 0.8, 1)), ivory, 0, 0.05 + i * 0.08, -0.09 - Math.sin((i / 7) * Math.PI) * 0.03);
  [0.17, 0.21, 0.235, 0.235, 0.215, 0.18].forEach((r, i) => {
    const g = geo(`ok-rib-${r}`, () => new THREE.TorusGeometry(r, 0.019, 6, 22, Math.PI * 1.7).rotateX(Math.PI / 2).rotateY(Math.PI * 1.35).scale(1, 1, 0.8));
    mesh(torso, g, ivory, 0, 0.2 + i * 0.075, 0.0, 0.14, 0, 0);
  });
  mesh(torso, geo('ok-sternum', () => new THREE.BoxGeometry(0.05, 0.3, 0.03)), ivory, 0, 0.42, 0.19, -0.12, 0, 0);
  const heart = mesh(torso, geo('ok-heart', () => new THREE.SphereGeometry(0.075, 14, 10)), fire, 0, 0.42, 0.02, 0, 0, 0, false);
  const core = mesh(torso, geo('ok-core', () => new THREE.SphereGeometry(0.036, 10, 8)), glow(KEEPER_CORE, 5), 0, 0.42, 0.06, 0, 0, 0, false);
  bone(torso, ivory, v3(-0.3, 0.69, -0.02), v3(0.3, 0.69, -0.02), 0.024, 0.024);
  mesh(torso, geo('ok-collar', () => new THREE.TorusGeometry(0.11, 0.025, 6, 22).rotateX(Math.PI / 2)), gold, 0, 0.72, 0.0);
  // the mantle: from the shoulders to the floor behind it
  mesh(torso, geo('ok-mantle', () => tattered([[0.52, -0.92], [0.46, -0.5], [0.4, -0.1], [0.36, 0.3], [0.32, 0.6], [0.2, 0.74]], 9, 0.24, 4.4, 36, Math.PI * 0.45, Math.PI * 1.1)), shroud);
  // iron pauldrons rimmed in gold, bristling with bone
  for (const sx of [-1, 1]) {
    const p = pivot(torso, sx * 0.33, 0.68, 0);
    p.rotation.z = -sx * 0.25;
    mesh(p, geo('ok-pauldron', () => new THREE.SphereGeometry(0.17, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1.15, 0.85, 1.1)), iron);
    mesh(p, geo('ok-pauldron-rim', () => new THREE.TorusGeometry(0.17, 0.016, 6, 26).rotateX(Math.PI / 2).scale(1.15, 1, 1.1)), gold, 0, 0.026, 0);
    for (let i = 0; i < 3; i++) {
      const at = v3(sx * (0.03 + i * 0.055), 0.12 - i * 0.02, -0.05 + i * 0.05);
      bone(p, ivory, at, at.clone().add(v3(sx * (0.06 + i * 0.03), 0.2 - i * 0.04, -0.03)), 0.022, 0.004);
    }
  }
  // the skull under its crown, embers deep in the sockets, the jaw on a hinge
  const head = pivot(torso, 0, 0.79, 0.03);
  mesh(head, geo('ok-skull', () => new THREE.SphereGeometry(0.15, 20, 16).scale(0.88, 1, 1.05)), ivory, 0, 0.1, 0);
  mesh(head, geo('ok-maxilla', () => new THREE.SphereGeometry(0.09, 14, 10).scale(1, 0.62, 1.05)), ivory, 0, 0.01, 0.09);
  const jaw = pivot(head, 0, 0.015, 0);
  mesh(jaw, geo('ok-jaw', () => new THREE.SphereGeometry(0.088, 12, 8, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55).scale(1, 0.7, 1.15)), ivory, 0, -0.012, 0.075);
  const eyes: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    mesh(head, geo('ok-socket', () => new THREE.SphereGeometry(0.038, 10, 8)), glow(0x000000, 0), sx * 0.055, 0.1, 0.112, 0, 0, 0, false);
    eyes.push(mesh(head, geo('ok-eye', () => new THREE.SphereGeometry(0.016, 8, 6)), glow(KEEPER_CORE, 6), sx * 0.055, 0.1, 0.137, 0, 0, 0, false));
  }
  mesh(head, geo('ok-crown', () => new THREE.CylinderGeometry(0.135, 0.125, 0.06, 24, 1, true)), gold, 0, 0.215, -0.005);
  for (let i = 0; i < 7; i++) {
    const a = ((i - 3) / 3.5) * Math.PI * 0.95;
    const tall = 0.24 - Math.abs(i - 3) * 0.035;
    const x = Math.sin(a) * 0.132;
    const z = Math.cos(a) * 0.132 - 0.005;
    mesh(head, geo(`ok-spike-${i}`, () => new THREE.ConeGeometry(0.022, tall, 6).translate(0, tall / 2, 0)), gold, x, 0.24, z, Math.cos(a) * 0.18, 0, -Math.sin(a) * 0.18);
  }
  mesh(head, geo('ok-gem', () => new THREE.OctahedronGeometry(0.026, 0).scale(0.8, 1.2, 0.6)), glow(KEEPER_GLOW, 4), 0, 0.215, 0.135, 0, 0, 0, false);
  // arms with iron bracers and bone claws; the right one wields the blade
  const shoulders: THREE.Group[] = [];
  const elbows: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const sh = pivot(torso, sx * 0.37, 0.62, 0);
    bone(sh, ivory, v3(0, 0, 0), v3(0, -0.4, 0), 0.036, 0.03);
    const el = pivot(sh, 0, -0.4, 0);
    mesh(el, geo('ok-elbow', () => new THREE.SphereGeometry(0.04, 10, 8)), ivory);
    bone(el, ivory, v3(0, 0, 0), v3(0, -0.38, 0), 0.03, 0.025);
    mesh(el, geo('ok-bracer', () => new THREE.CylinderGeometry(0.048, 0.042, 0.18, 10, 1, true)), iron, 0, -0.22, 0);
    mesh(el, geo('ok-hand', () => new THREE.SphereGeometry(0.04, 10, 8).scale(1.1, 0.8, 1)), ivory, 0, -0.4, 0);
    for (let i = 0; i < 4; i++) bone(el, ivory, v3((i - 1.5) * 0.02, -0.41, 0.01), v3((i - 1.5) * 0.035, -0.53, 0.045), 0.011, 0.004);
    shoulders.push(sh);
    elbows.push(el);
  }
  // the blade: +y runs from the grip to the point, a seam of soul fire down its middle
  const sword = pivot(elbows[1]!, 0, -0.41, 0.02);
  mesh(sword, geo('ok-grip', () => new THREE.CylinderGeometry(0.022, 0.022, 0.22, 8)), iron, 0, -0.02, 0);
  mesh(sword, geo('ok-pommel', () => new THREE.SphereGeometry(0.036, 10, 8)), gold, 0, -0.15, 0);
  mesh(sword, geo('ok-guard', () => new THREE.BoxGeometry(0.3, 0.045, 0.055)), gold, 0, 0.1, 0);
  mesh(sword, geo('ok-blade', () => new THREE.BoxGeometry(0.12, 1.12, 0.024).translate(0, 0.68, 0)), iron);
  mesh(sword, geo('ok-tip', () => new THREE.ConeGeometry(0.06, 0.22, 4).scale(1, 1, 0.2).translate(0, 1.35, 0)), iron);
  mesh(sword, geo('ok-seam', () => new THREE.BoxGeometry(0.022, 1.02, 0.03).translate(0, 0.68, 0)), glow(KEEPER_GLOW, 2.4), 0, 0, 0, 0, 0, 0, false);
  skinRigid(root, 'ossuaryKing', rig, [heart, core, ...eyes], bounds(2.5 * S));

  let clock = Math.random() * 10;
  let phase = Math.random() * 10;
  let raise = 0;
  let lift = 0;
  let slamAt = -9;
  let tolling = false;
  const mx = (a: number, b: number, t: number) => a + (b - a) * t;
  return {
    root,
    height: 2.35 * S,
    linger: 4.5,
    animate(u, dt, deathTime, wobble) {
      clock += dt;
      const speed = hypot(u.vx, u.vz);
      phase += dt * (1.3 + speed * 1.1);
      const gait = Math.min(1, speed / 1.4);
      // the Grave Toll: the blade lifts high in both hands through the windup (the host's
      // brain knows it; guests see the slam land), then comes down into the floor
      const special = u.brain instanceof MonsterBrain ? u.brain.specialProgress : 0;
      if (tolling && special <= 0) slamAt = clock;
      tolling = special > 0;
      lift += ((tolling ? 1 : 0) - lift) * (1 - Math.exp(-dt * (tolling ? 5 : 30)));
      const st = clock - slamAt;
      const slam = st < 1.3 ? Math.min(1, st / 0.1) * (st < 0.75 ? 1 : 1 - (st - 0.75) / 0.55) : 0;
      // a basic swing: back over the shoulder through the windup, then down across the body
      const goal = u.windup > 0 ? 1 : 0;
      raise += (goal - raise) * (1 - Math.exp(-dt * (goal ? 8 : 20)));
      const a = u.sinceAction;
      const strike = slam > 0 ? 0 : a < 0.5 ? Math.sin(Math.min(1, a / 0.5) * Math.PI * 0.5) * (1 - Math.max(0, a - 0.3) / 0.2) : 0;
      const walk = Math.sin(phase);
      // a slow, heavy stride; it braces for the toll and crouches into the slam
      thighs.forEach((t, i) => {
        const sw = Math.sin(phase + i * Math.PI);
        t.rotation.x = mx(mx(sw * 0.42 * gait, -0.15, lift), -0.5, slam);
        knees[i]!.rotation.x = mx(mx(Math.max(0, -sw) * 0.55 * gait + 0.08, 0.3, lift), 0.8, slam);
      });
      hips.position.y = HIP + Math.abs(Math.cos(phase)) * 0.025 * gait + Math.sin(clock * 1.1) * 0.006 - lift * 0.04 - slam * 0.16;
      torso.rotation.x = mx(mx(0.1 + Math.sin(clock * 1.1) * 0.015 + wobble * 0.04 - raise * 0.12 + strike * 0.22, -0.08, lift), 0.5, slam);
      torso.rotation.y = (raise * 0.35 - strike * 0.4) * (1 - lift) * (1 - slam);
      torso.rotation.z = walk * 0.04 * gait;
      head.rotation.x = mx(mx(-0.12 + Math.sin(clock * 0.6) * 0.04 - raise * 0.1, -0.3, lift), -0.35, slam);
      head.rotation.y = Math.sin(clock * 0.37) * 0.25 * (1 - gait) * (1 - raise) * (1 - lift);
      jaw.rotation.x = 0.05 + raise * 0.25 + lift * 0.3 + slam * 0.4;
      // the arms: the sword arm swings, both rise for the toll and drive down together
      const sh = shoulders[1]!;
      const el = elbows[1]!;
      const off = shoulders[0]!;
      const oel = elbows[0]!;
      sh.rotation.x = mx(mx(-0.35 + walk * 0.15 * gait - raise * 2.2 + strike * 1.6, -2.75, lift), -1.15, slam);
      sh.rotation.z = mx(mx(0.12 + raise * 0.35, -0.12, lift), -0.1, slam);
      el.rotation.x = mx(mx(-0.55 - raise * 0.6 + strike * 0.5, -0.35, lift), -0.25, slam);
      off.rotation.x = mx(mx(-0.25 - walk * 0.15 * gait + raise * 0.3, -2.6, lift), -1.0, slam);
      off.rotation.z = mx(mx(-0.18, 0.14, lift), 0.12, slam);
      oel.rotation.x = mx(mx(-0.45, -0.6, lift), -0.3, slam);
      // the blade's angle in the body (0 points straight up, pi straight down), whatever the arm does
      const blade = mx(mx(2.05 - raise * 2.6 + strike * 2.7, 0.15, lift), 2.95, slam);
      sword.rotation.x = blade - (torso.rotation.x + sh.rotation.x + el.rotation.x);
      const flare = 1 + Math.sin(clock * 2.2) * 0.08 + raise * 0.2 + lift * 0.5 + slam * 0.8;
      heart.scale.setScalar(flare);
      core.scale.setScalar(flare * (0.9 + Math.sin(clock * 9) * 0.1));
      if (deathTime >= 0) {
        // it sinks to its knees, slumps over its blade and goes down into the dark
        const t = Math.min(1, deathTime / 1.4);
        const k = t * t * (3 - 2 * t);
        hips.position.y = HIP * (1 - k * 0.5) - Math.max(0, deathTime - SINKS.ossuaryKing) * 0.35;
        for (const th of thighs) th.rotation.x = -k * 1.3;
        for (const kn of knees) kn.rotation.x = k * 2.0;
        torso.rotation.x = 0.1 + k * 0.6;
        head.rotation.x = -0.12 + k * 0.6;
        sh.rotation.x = -0.35 - k * 0.6;
        off.rotation.x = -0.25 + k * 0.2;
        sword.rotation.x = 2.9 - (torso.rotation.x + sh.rotation.x + el.rotation.x);
        const out = Math.max(0.01, 1 - Math.max(0, deathTime - 0.6) / 1.2);
        heart.scale.setScalar(out);
        core.scale.setScalar(out);
        for (const e of eyes) e.scale.setScalar(out);
      }
    },
  };
}

/** The camp kind is encoded in the monster's tag: `<team>-<kind>-<i>:<type>`. */
function campKindOf(u: Pick<Unit, 'tag'>): CampKind {
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
    ossuaryKing(),
    cinderling(),
    slagBrute(),
    drownedThrall(),
    lanternJelly(),
    tideLurker(),
    gravehound(false),
    gravehound(true),
  ].map((v) => v.root);
}

/**
 * What a view built ahead of its monster must match to stand in for it: the
 * type, a Warden's glow and a Champion's size (see createMonsterView).
 */
export function monsterViewKey(u: Pick<Unit, 'tag' | 'name'>): string {
  const type = u.tag.split(':')[1] ?? '';
  return `${type}${type === 'warden' ? `@${campKindOf(u)}` : ''}${u.name.startsWith('Champion ') ? '+' : ''}`;
}

/** Builds a monster's model from its tag and name alone, so it can be built before the monster exists. */
export function createMonsterView(u: Pick<Unit, 'tag' | 'name'>): MonsterView {
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

function createView(u: Pick<Unit, 'tag'>): MonsterView {
  const type = u.tag.split(':')[1];
  if (type === 'warden') return giant({ glow: BUFF_GLOW[campKindOf(u)] ?? 0xffffff, stone: mats().stone, scale: 1 });
  if (type === 'moltenColossus') return giant({ glow: 0xff6a1a, stone: lavaStone(), scale: 2.1, molten: true });
  if (type === 'treasureWyrm') return wyrm();
  if (type === 'shade') return shade();
  if (type === 'gravekeeper') return gravekeeper();
  if (type === 'ossuaryKing') return ossuaryKing();
  if (type === 'cinderling') return cinderling();
  if (type === 'slagBrute') return slagBrute();
  if (type === 'drownedThrall') return drownedThrall();
  if (type === 'lanternJelly') return lanternJelly();
  if (type === 'tideLurker') return tideLurker();
  if (type === 'gravehound' || type === 'packleader') return gravehound(type === 'packleader');
  return thornback(type === 'thornbackAlpha', type === 'thornSpitter', type === 'gildedThornback');
}
