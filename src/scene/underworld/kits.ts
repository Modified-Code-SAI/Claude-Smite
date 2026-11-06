import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng } from '../../core/random';
import { chamberField, GATE, type ChamberDef } from '../../map/UnderworldLayout';
import { boulder, chippedBlock, lathe, merge } from '../Architecture';

/** The materials a chamber's dressing can use (see underworldMaterials). */
export interface KitMaterials {
  obsidian: THREE.Material;
  forgeStone: THREE.Material;
  basalt: THREE.Material;
  bronze: THREE.Material;
  coals: THREE.Material;
  crystal: THREE.Material;
  iron: THREE.Material;
  slag: THREE.Material;
  furnace: THREE.Material;
  flameBed: THREE.Material;
}

/** What a kit builds one chamber's dressing with, in the chamber's local frame. */
export interface KitBuild {
  readonly c: ChamberDef;
  readonly index: number;
  readonly random: () => number;
  readonly mats: KitMaterials;
  /** The dressing's group (local frame), for parts placed as a set. */
  readonly group: THREE.Group;
  add(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, cast?: boolean): THREE.Mesh;
  /** A light that shows with this dressing (the pool lights the nearest few). */
  light(color: number, intensity: number, distance: number, x: number, y: number, z: number): void;
}

/** A chamber's dressing for one depth: its columns, the vessels of its fires, and what lines its walls. */
export type Kit = (k: KitBuild) => void;

/** Height of the flame over each brazier spot, the same in every depth (the fires belong to the chamber, not its dressing). */
export const FLAME_Y = 1.5;

/** A spot at the foot of the wall: where it is, the way out into the rock, and its angle round the chamber. */
interface WallSpot {
  x: number;
  z: number;
  dx: number;
  dz: number;
  a: number;
  r: number;
}

/** The foot of the wall at an angle round the chamber (radians, 0 = east), or null in a gate's doorway or by the pit. */
function wallAt(c: ChamberDef, a: number): WallSpot | null {
  const dx = Math.cos(a);
  const dz = Math.sin(a);
  // walk out from the middle to the wall
  let r = 2;
  while (r < 40 && chamberField(c, dx * r, dz * r) > -0.4) r += 0.35;
  const x = dx * r;
  const z = dz * r;
  if (Math.abs(x) < GATE.halfWidth + 2.5 && Math.abs(z) > c.extent - 6) return null;
  if (c.pit && r < c.pit + 1) return null;
  return { x, z, dx, dz, a, r };
}

/** Turns a part whose front faces +z to face the chamber's middle from a wall spot. */
const facingIn = (s: WallSpot): number => Math.atan2(-s.dx, -s.dz);

// ---------------------------------------------------------------------------
// The caverns: obsidian monoliths, bronze bowls, fallen rock and soul crystals

/** The underworld's first dressing, kept for the depths that have no kit of their own yet. */
export const cavernKit: Kit = (k) => {
  const { c, index, random, mats, add } = k;
  // obsidian columns: faceted, tapering monoliths with a carved collar
  for (const [x, z, r] of c.pillars) {
    const h = 9 + random() * 3.5;
    const column = add(obsidianColumn(r, h, Math.floor(random() * 1e5)), mats.obsidian, x, 0, z);
    column.rotation.y = random() * Math.PI;
  }
  // braziers against the walls
  const plinth = chippedBlock(1.1, 0.7, 1.1, 4100);
  const bowl = brazierBowl();
  for (const [x, z] of c.fires) {
    add(plinth, mats.obsidian, x, 0.3, z).rotation.y = random() * Math.PI;
    add(bowl, mats.bronze, x, 0.65, z);
    add(COALS, mats.coals, x, 0.65 + 0.84, z, false);
  }
  // fallen rock and soul crystals along the foot of the walls
  const rocks = Array.from({ length: 6 }, (_, i) => boulder(1, 4500 + i * 13, 3));
  const crystal = crystalCluster(4600 + index);
  const steps = 72;
  for (let s = 0; s < steps; s++) {
    const spot = wallAt(c, (s / steps) * Math.PI * 2 + random() * 0.05);
    if (!spot) continue;
    const { x, z, dx, dz } = spot;
    if (s % 9 === 4) {
      const cr = add(crystal, mats.crystal, x * 1.01, -0.2, z * 1.01, false);
      cr.rotation.set((random() - 0.5) * 0.5, random() * Math.PI, (random() - 0.5) * 0.5);
      cr.scale.setScalar(0.8 + random() * 0.7);
      continue;
    }
    const sz = 1.1 + random() * 1.9;
    const rock = add(rocks[s % rocks.length]!, mats.basalt, x + dx * sz * 0.45, sz * 0.05, z + dz * sz * 0.45);
    rock.scale.set(sz, sz * (0.7 + random() * 0.6), sz);
    rock.rotation.y = random() * Math.PI * 2;
  }
  if (c.boss) throne(k);
};

/** The boss arena's dais and broken colossi along the walls. */
function throne({ c, mats, add }: KitBuild): void {
  // a low round dais under the boss's spot
  const dais = lathe([[0, 0], [7.4, 0], [7.4, 0.12], [7.1, 0.2], [0, 0.2]], 64);
  add(dais, mats.obsidian, 0, -0.08, -c.extent * 0.35, false);
  // four great broken statues' plinths and stumps against the walls
  for (const a of [35, 145, 215, 325]) {
    const rad = (a * Math.PI) / 180;
    const x = Math.cos(rad) * (c.extent - 2.6);
    const z = Math.sin(rad) * (c.extent - 2.6);
    add(chippedBlock(3.2, 2.2, 3.2, 4700 + a), mats.obsidian, x, 1.1, z).rotation.y = -rad;
    add(obsidianColumn(1.2, 5 + (a % 3), 4800 + a), mats.obsidian, x, 2.2, z).rotation.y = rad;
  }
}

const COALS = new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.25, 1);

/** A faceted obsidian monolith: an eight-sided shaft tapering up from a collar, with a flared cap. */
function obsidianColumn(radius: number, height: number, seed: number): THREE.BufferGeometry {
  const random = rng(seed);
  const pts: [number, number][] = [
    [radius * 1.35, 0], [radius * 1.35, 0.5], [radius * 1.12, 0.62], [radius * 1.05, 1.1], [radius * 1.18, 1.25],
    [radius * 1.0, 1.4], [radius * 0.82, height * 0.82], [radius * 0.98, height * 0.86], [radius * 0.86, height * 0.9],
    [radius * 1.15, height - 0.35], [radius * 1.2, height], [0, height],
  ];
  const geo = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 8);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  // a slight lean and uneven facets, so no two columns match
  const lean = (random() - 0.5) * 0.06;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setX(i, pos.getX(i) * (1 + (random() - 0.5) * 0.03) + lean * y);
  }
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

function brazierBowl(): THREE.BufferGeometry {
  return lathe([
    [0, 0], [0.22, 0], [0.25, 0.05], [0.12, 0.1], [0.1, 0.55], [0.18, 0.62], [0.55, 0.72], [0.72, 0.9],
    [0.76, 1.0], [0.7, 1.02], [0.52, 0.86], [0, 0.82],
  ], 32);
}

/** A cluster of long crystals leaning out from one root. */
function crystalCluster(seed: number): THREE.BufferGeometry {
  const random = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const h = 1.2 + random() * 2.2;
    const geo = new THREE.OctahedronGeometry(1, 0).scale(0.22 + random() * 0.14, h, 0.22 + random() * 0.14);
    geo.translate(0, h * 0.75, 0);
    const tilt = new THREE.Euler((random() - 0.5) * 0.9, random() * Math.PI * 2, (random() - 0.5) * 0.9);
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(tilt));
    geo.translate((random() - 0.5) * 0.7, 0, (random() - 0.5) * 0.7);
    parts.push(geo.index ? geo.toNonIndexed() : geo);
  }
  const merged = positionsOnly(parts);
  merged.computeVertexNormals();
  return merged;
}

function positionsOnly(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    const a = p.getAttribute('position').array as Float32Array;
    pos.set(a, o);
    o += a.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

// ---------------------------------------------------------------------------
// The Ashen Depths: a forge of the dead

/**
 * The Ashen Depths' dressing: masonry piers of black basalt bound in iron,
 * iron fire baskets on splayed legs, barred furnace mouths set into the walls,
 * smithies of anvils and ingots, heaps of glowing slag, and chains and cages
 * hanging out of the dark.
 */
export const forgeKit: Kit = (k) => {
  const { c, index, random, mats, add } = k;
  // piers: a plinth, four drums of basalt bound with iron at two joints, a wide capital
  for (const [x, z, r] of c.pillars) {
    const h = 9 + random() * 3;
    const turn = random() * (Math.PI / 2);
    const w = r * 1.8;
    const seed = 5000 + index * 101 + Math.round((x + 40) * 7 + (z + 40) * 3);
    add(chippedBlock(w * 1.4, 0.9, w * 1.4, seed, 0.05), mats.forgeStone, x, 0.4, z).rotation.y = turn;
    const drum = (h - 1.7) / 4;
    let y = 0.85;
    for (let d = 0; d < 4; d++) {
      const s = 1 - d * 0.035;
      const m = add(chippedBlock(w * s, drum - 0.05, w * s, seed + d + 1, 0.05), mats.forgeStone, x, y + drum / 2, z);
      m.rotation.y = turn + (random() - 0.5) * 0.1;
      y += drum;
      if (d === 0 || d === 2) add(band(w * s * 1.08, 0.34, 0.07), mats.iron, x, y - 0.05, z).rotation.y = turn;
    }
    add(chippedBlock(w * 1.32, 0.85, w * 1.32, seed + 9, 0.05), mats.forgeStone, x, y + 0.4, z).rotation.y = turn;
    add(band(w * 1.38, 0.2, 0.08), mats.iron, x, y + 0.05, z).rotation.y = turn;
  }

  // fire baskets on splayed iron legs, the flame where every depth's flame is
  const basket = fireBasket();
  for (const [x, z] of c.fires) {
    const turn = random() * Math.PI;
    add(basket, mats.iron, x, 0, z).rotation.y = turn;
    add(COALS, mats.coals, x, FLAME_Y - 0.13, z, false);
    // a bed of flame across the whole basket under the fire's tall lick
    add(FLAME_BED, mats.flameBed, x, FLAME_Y - 0.12, z, false).rotation.y = turn;
  }

  // the walls: two furnaces facing each other across the hall, smithies, slag and rock
  const used: number[] = [];
  const near = (a: number, gap: number) => used.some((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < gap);
  for (const a of [0, Math.PI]) {
    const spot = wallAt(c, a + (random() - 0.5) * 0.3);
    if (!spot) continue;
    furnace(k, spot);
    used.push(spot.a);
  }
  const smithies = c.boss ? 2 : 3;
  for (let s = 0, tries = 0; s < smithies && tries < 40; tries++) {
    const spot = wallAt(c, random() * Math.PI * 2);
    if (!spot || near(spot.a, 0.55)) continue;
    smithy(k, spot);
    used.push(spot.a);
    s++;
  }
  const rocks = Array.from({ length: 5 }, (_, i) => boulder(1, 5300 + i * 17, 3));
  const steps = 64;
  for (let s = 0; s < steps; s++) {
    const spot = wallAt(c, (s / steps) * Math.PI * 2 + random() * 0.05);
    if (!spot || near(spot.a, 0.22)) continue;
    const { x, z, dx, dz } = spot;
    // every fourth heap is slag still glowing from the furnaces
    const slag = s % 4 === 1;
    const sz = (slag ? 0.8 : 1.1) + random() * (slag ? 1.1 : 1.7);
    const rock = add(rocks[s % rocks.length]!, slag ? mats.slag : mats.forgeStone, x + dx * sz * 0.45, sz * 0.05, z + dz * sz * 0.45, !slag);
    rock.scale.set(sz, sz * (0.55 + random() * 0.5), sz);
    rock.rotation.y = random() * Math.PI * 2;
    if (slag && random() < 0.6) {
      const t = sz * 0.55;
      const lump = add(rocks[(s + 2) % rocks.length]!, mats.slag, x + dx * sz * 0.2 - dz * sz * 0.7, 0, z + dz * sz * 0.2 + dx * sz * 0.7, false);
      lump.scale.set(t, t * 0.6, t);
    }
  }

  // chains out of the dark, some with hooks, two with cages
  const link = chainLink();
  for (let n = 0, tries = 0; n < 9 && tries < 200; tries++) {
    const x = (random() * 2 - 1) * 34;
    const z = (random() * 2 - 1) * 34;
    const f = chamberField(c, x, z);
    // over the floor, not too far out from the walls (the middle stays clear above the fight)
    if (f < 1.5 || f > 9) continue;
    const bottom = 6.5 + random() * 4;
    chain(k, link, x, z, bottom, 23);
    if (n < 2) cage(k, x, z, bottom);
    else add(HOOK, mats.iron, x, bottom - 0.15, z, false).rotation.y = random() * Math.PI;
    n++;
  }
  if (c.boss) throne(k);
};

/** A square iron collar round a pier: four flat bars. */
function band(w: number, h: number, t: number): THREE.BufferGeometry {
  const half = w / 2 - t / 2;
  return merge([
    new THREE.BoxGeometry(w, h, t).translate(0, 0, half),
    new THREE.BoxGeometry(w, h, t).translate(0, 0, -half),
    new THREE.BoxGeometry(t, h, w - 2 * t).translate(half, 0, 0),
    new THREE.BoxGeometry(t, h, w - 2 * t).translate(-half, 0, 0),
  ]);
}

/** Three crossed sheets of flame (see the flameBed material), as wide as a basket's mouth, rising from y = 0. */
const FLAME_BED = mergeGeometries([0, 1, 2].map((i) => new THREE.PlaneGeometry(1.35, 1.15).translate(0, 0.575, 0).rotateY((i / 3) * Math.PI)))!;

/** A wide, shallow iron basket on three splayed legs, its rim just under FLAME_Y. */
function fireBasket(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    // feet out, tops in under the bowl
    const leg = new THREE.BoxGeometry(0.08, 1.45, 0.08).translate(0, 0.72, 0);
    leg.applyMatrix4(new THREE.Matrix4().makeRotationZ(0.18));
    leg.translate(0.58, 0, 0);
    leg.applyMatrix4(new THREE.Matrix4().makeRotationY(a));
    parts.push(leg);
    parts.push(new THREE.BoxGeometry(0.22, 0.06, 0.16).translate(0.6, 0.03, 0).applyMatrix4(new THREE.Matrix4().makeRotationY(a)));
  }
  parts.push(new THREE.TorusGeometry(0.47, 0.03, 6, 24).rotateX(Math.PI / 2).translate(0, 0.62, 0));
  parts.push(lathe([[0, 0.98], [0.3, 1.0], [0.62, 1.18], [0.78, FLAME_Y - 0.08], [0.72, FLAME_Y - 0.06], [0.56, 1.24], [0, 1.16]], 24));
  parts.push(new THREE.TorusGeometry(0.76, 0.045, 6, 28).rotateX(Math.PI / 2).translate(0, FLAME_Y - 0.07, 0));
  // straps down the bowl's side
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const strap = new THREE.BoxGeometry(0.05, 0.62, 0.06);
    strap.applyMatrix4(new THREE.Matrix4().makeRotationZ(-0.85));
    strap.translate(0.58, 1.19, 0);
    parts.push(strap.applyMatrix4(new THREE.Matrix4().makeRotationY(a)));
  }
  return merge(parts);
}

/**
 * A furnace set into the wall: a barred mouth in a masonry frame, a fire
 * roaring behind the bars, a hood and chimney climbing into the rock, and a
 * light thrown out across the floor.
 */
function furnace(k: KitBuild, s: WallSpot): void {
  const { mats, index } = k;
  const g = new THREE.Group();
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, cast = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const seed = 5600 + index * 13 + Math.round(s.a * 10);
  part(chippedBlock(1.2, 3.8, 2.2, seed, 0.05), mats.forgeStone, -1.85, 1.9, 0);
  part(chippedBlock(1.2, 3.8, 2.2, seed + 1, 0.05), mats.forgeStone, 1.85, 1.9, 0);
  part(chippedBlock(5.2, 1.1, 2.5, seed + 2, 0.05), mats.forgeStone, 0, 4.3, 0.05);
  part(chippedBlock(4.2, 2.6, 2.0, seed + 3, 0.05), mats.forgeStone, 0, 6.1, -0.35);
  part(chippedBlock(2.8, 3.2, 1.6, seed + 4, 0.05), mats.forgeStone, 0, 8.9, -0.6);
  part(chippedBlock(3.2, 0.6, 2.0, seed + 5, 0.05), mats.forgeStone, 0, 0.1, 0.1);
  part(chippedBlock(3.4, 4.0, 0.6, seed + 6, 0.04), mats.forgeStone, 0, 2.0, -1.0);
  // the fire behind the bars, and its coals
  part(new THREE.PlaneGeometry(2.6, 3.4), mats.furnace, 0, 2.05, -0.66, false);
  part(boulder(0.9, seed + 7, 2), mats.coals, 0, 0.35, -0.2, false).scale.set(1.3, 0.45, 0.7);
  // the bars, and a crossbar
  const bars: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) bars.push(new THREE.BoxGeometry(0.09, 3.6, 0.09).translate(-1.2 + i * 0.4, 2.0, 0.85));
  bars.push(new THREE.BoxGeometry(2.7, 0.12, 0.12).translate(0, 2.4, 0.85));
  bars.push(new THREE.BoxGeometry(2.7, 0.12, 0.12).translate(0, 0.5, 0.85));
  part(merge(bars), mats.iron, 0, 0, 0);
  // set back into the rock, so its front stands at the floor's edge
  const back = 0.7;
  g.position.set(s.x + s.dx * back, 0, s.z + s.dz * back);
  g.rotation.y = facingIn(s);
  k.group.add(g);
  // the light it throws out of its mouth
  const out = 2.2 - back;
  k.light(0xff7a2e, 55, 17, s.x - s.dx * out, 1.7, s.z - s.dz * out);
}

/** A smithy at the wall: an anvil on a stump, a hammer, a stack of ingots and a quenching trough. */
function smithy(k: KitBuild, s: WallSpot): void {
  const { mats, random } = k;
  const g = new THREE.Group();
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const seed = 5800 + Math.round(s.a * 100);
  part(chippedBlock(0.95, 0.75, 0.75, seed, 0.06), mats.forgeStone, 0, 0.37, 0);
  part(ANVIL, mats.iron, 0, 0.75, 0).rotation.y = (random() - 0.5) * 0.5;
  const hammer = part(HAMMER, mats.iron, 0.75, 0, 0.35);
  hammer.rotation.set(0, random() * Math.PI, 0.32);
  // ingots, stacked crosswise in three layers of three
  for (let layer = 0; layer < 3; layer++) {
    for (let i = 0; i < 3; i++) {
      const off = (i - 1) * 0.15;
      const across = layer % 2 === 1;
      const bar = part(INGOT, mats.slag, -1.25 + (across ? off : 0), 0.045 + layer * 0.088, 0.5 + (across ? 0 : off));
      bar.rotation.y = across ? Math.PI / 2 : 0;
    }
  }
  part(chippedBlock(1.7, 0.6, 0.8, seed + 1, 0.04), mats.forgeStone, 1.6, 0.3, -0.4).rotation.y = 0.2;
  // against the wall, the stump just inside the floor's edge
  const back = 0.15;
  g.position.set(s.x + s.dx * back, 0, s.z + s.dz * back);
  g.rotation.y = facingIn(s);
  k.group.add(g);
}

/** An anvil, its face at y 0.55 above its foot. */
const ANVIL = merge([
  new THREE.BoxGeometry(0.7, 0.16, 0.46).translate(0, 0.08, 0),
  new THREE.BoxGeometry(0.4, 0.26, 0.3).translate(0, 0.29, 0),
  new THREE.BoxGeometry(0.95, 0.2, 0.4).translate(0, 0.52, 0),
  new THREE.ConeGeometry(0.17, 0.55, 10).rotateZ(-Math.PI / 2).translate(0.74, 0.53, 0),
  new THREE.BoxGeometry(0.18, 0.15, 0.32).translate(-0.56, 0.54, 0),
]);

/** A smith's hammer, lying with its handle along x. */
const HAMMER = merge([
  new THREE.CylinderGeometry(0.03, 0.035, 0.75, 6).rotateZ(Math.PI / 2).translate(0, 0.05, 0),
  new THREE.BoxGeometry(0.12, 0.13, 0.26).translate(0.4, 0.07, 0),
]);

const INGOT = chippedBlock(0.3, 0.085, 0.12, 5900, 0.01, [3, 2, 2]);

/** One link of a chain, long in y. */
function chainLink(): THREE.BufferGeometry {
  return new THREE.TorusGeometry(0.12, 0.034, 5, 9).scale(1, 1.6, 1);
}

/** Link spacing down a chain. */
const LINK = 0.3;

/** A chain hanging straight down from `top` to `bottom` at (x, z), every other link turned a quarter. */
function chain(k: KitBuild, link: THREE.BufferGeometry, x: number, z: number, bottom: number, top: number): void {
  const parts: THREE.BufferGeometry[] = [];
  for (let y = bottom, i = 0; y < top; y += LINK, i++) {
    const g = link.clone();
    if (i % 2) g.rotateY(Math.PI / 2);
    parts.push(g.translate(0, y, 0));
  }
  k.add(merge(parts), k.mats.iron, x, 0, z, false);
}

const HOOK = merge([
  new THREE.TorusGeometry(0.2, 0.045, 6, 12, Math.PI * 1.3).rotateZ(Math.PI * 0.85).translate(0, -0.2, 0),
  new THREE.CylinderGeometry(0.04, 0.04, 0.3, 6).translate(0, 0.02, 0),
]);

/** A gibbet cage on the end of a chain: two rings, bars between, a cap and a floor. */
function cage(k: KitBuild, x: number, z: number, top: number): void {
  const h = 1.7;
  const r = 0.55;
  const parts: THREE.BufferGeometry[] = [
    new THREE.TorusGeometry(r, 0.035, 5, 20).rotateX(Math.PI / 2).translate(0, -0.15, 0),
    new THREE.TorusGeometry(r, 0.035, 5, 20).rotateX(Math.PI / 2).translate(0, -h, 0),
    new THREE.CylinderGeometry(r, r, 0.05, 16).translate(0, -h, 0),
    new THREE.ConeGeometry(r * 1.02, 0.45, 12, 1, true).translate(0, 0.08, 0),
  ];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    parts.push(new THREE.BoxGeometry(0.04, h - 0.15, 0.04).translate(Math.cos(a) * r, -(h + 0.15) / 2, Math.sin(a) * r));
  }
  const m = k.add(merge(parts), k.mats.iron, x, top, z, true);
  m.rotation.y = k.random() * Math.PI;
}
