import * as THREE from 'three/webgpu';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm2, rng, simplex2, smoothstep } from '../../core/random';
import { chamberField, GATE, type ChamberDef } from '../../map/UnderworldLayout';
import { boulder, brokenCap, brokenShaft, chippedBlock, columnBase, columnCapital, flutedShaft, lathe, merge } from '../Architecture';

/** The materials a chamber's dressing can use (see underworldMaterials). */
export interface KitMaterials {
  obsidian: THREE.Material;
  forgeStone: THREE.Material;
  coals: THREE.Material;
  iron: THREE.Material;
  slag: THREE.Material;
  furnace: THREE.Material;
  flameBed: THREE.Material;
  tideStone: THREE.Material;
  verdigris: THREE.Material;
  waterfall: THREE.Material;
  pool: THREE.Material;
  bone: THREE.Material;
  gold: THREE.Material;
  molten: THREE.Material;
  bronze: THREE.Material;
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

/** A point in a wall spot's frame (x along the wall, z out toward the middle), set `back` into the rock, in the chamber's frame. */
function fromSpot(s: WallSpot, back: number, x: number, z: number): [number, number] {
  const t = facingIn(s);
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return [s.x + s.dx * back + x * cos + z * sin, s.z + s.dz * back - x * sin + z * cos];
}

/** Parts of a set piece in its own frame, each casting a shadow unless told not to. */
function setPiece(): { g: THREE.Group; part: (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, cast?: boolean) => THREE.Mesh } {
  const g = new THREE.Group();
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, cast = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  return { g, part };
}

/** Stands a set piece at a wall spot, `back` into the rock, facing the chamber's middle. */
function standAt(k: KitBuild, g: THREE.Group, s: WallSpot, back: number): void {
  g.position.set(s.x + s.dx * back, 0, s.z + s.dz * back);
  g.rotation.y = facingIn(s);
  k.group.add(g);
}

const COALS = new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.25, 1);

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
  if (c.boss) hoard(k, used);
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
function chain(k: KitBuild, link: THREE.BufferGeometry, x: number, z: number, bottom: number, top: number, mat: THREE.Material = k.mats.iron): void {
  const parts: THREE.BufferGeometry[] = [];
  for (let y = bottom, i = 0; y < top; y += LINK, i++) {
    const g = link.clone();
    if (i % 2) g.rotateY(Math.PI / 2);
    parts.push(g.translate(0, y, 0));
  }
  k.add(merge(parts), mat, x, 0, z, false);
}

const HOOK = merge([
  new THREE.TorusGeometry(0.2, 0.045, 6, 12, Math.PI * 1.3).rotateZ(Math.PI * 0.85).translate(0, -0.2, 0),
  new THREE.CylinderGeometry(0.04, 0.04, 0.3, 6).translate(0, 0.02, 0),
]);

/** A gibbet cage on the end of a chain: two rings, bars between, a cap and a floor. */
function cage(k: KitBuild, x: number, z: number, top: number, mat: THREE.Material = k.mats.iron): void {
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
  const m = k.add(merge(parts), mat, x, top, z, true);
  m.rotation.y = k.random() * Math.PI;
}

// ---------------------------------------------------------------------------
// The Treasure Wyrm's arena: its hoard

/**
 * The Treasure Wyrm's hoard: heaps of gold piled against the walls, the two
 * greatest either side of the way on, with strongboxes burst open, chalices,
 * stacked bars, a shield and a sword thrust into the gold, coins spilled
 * across the foot of the walls, and warm light glinting off it all.
 */
function hoard(k: KitBuild, used: number[]): void {
  for (const [deg, size] of [[-110, 1], [-70, 1], [-146, 0.75], [-34, 0.75], [146, 0.55], [34, 0.55]] as const) {
    const s = wallAt(k.c, (deg * Math.PI) / 180);
    if (!s) continue;
    goldHeap(k, s, size);
    used.push(s.a);
  }
}

/** One heap of the hoard at a wall spot, `size` 1 for the greatest. */
function goldHeap(k: KitBuild, s: WallSpot, size: number): void {
  const { mats, random } = k;
  const { g, part } = setPiece();
  const seed = 8000 + Math.round(s.a * 100);
  const w = 4 + size * 6.5;
  const { geo, at } = coinHeap(w, 1.4 + size * 3, seed);
  part(geo, mats.gold, 0, 0, 0);

  // coins spilled over the floor at its toe, and a few little stacks
  const coins: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 40 + size * 60; i++) {
    const x = (random() - 0.5) * (w + 1.5);
    const z = 0.6 + random() * random() * (1.6 + size * 1.4);
    coins.push(COIN.clone().rotateX((random() - 0.5) * 0.5).rotateY(random() * Math.PI).translate(x, Math.max(0.014, at(x, z) + 0.01), z));
  }
  for (let i = 0; i < 2 + size * 3; i++) {
    const x = (random() - 0.5) * w * 0.8;
    const z = 1.4 + random() * 0.8;
    const n = 3 + Math.floor(random() * 6);
    for (let j = 0; j < n; j++) coins.push(COIN.clone().translate(x + (random() - 0.5) * 0.02, 0.014 + j * 0.026, z + (random() - 0.5) * 0.02));
  }
  part(merge(coins), mats.gold, 0, 0, 0, false);

  // a strongbox burst open at each end, a chalice or two, and a stack of bars
  for (const end of [-1, 1]) {
    if (size < 0.7 && end > 0) continue;
    const x = end * w * (0.3 + random() * 0.08);
    const z = 0.7 + random() * 0.4;
    strongbox(k, g, x, Math.max(0, at(x, z) - 0.35), z, end * (0.3 + random() * 0.4), seed + end);
  }
  for (let i = 0; i < 1 + Math.round(size); i++) {
    const x = (random() - 0.5) * w * 0.6;
    const z = 0.9 + random() * 0.5;
    const cup = part(CHALICE, mats.gold, x, Math.max(0, at(x, z) - 0.08), z);
    cup.rotation.set((random() - 0.5) * 0.3, 0, (random() - 0.5) * 0.3);
    if (random() < 0.4) cup.rotation.set(Math.PI / 2 - 0.2, random() * Math.PI, 0);
  }
  {
    const x = -w * 0.12 + (random() - 0.5);
    const z = 1.75;
    for (let layer = 0; layer < 3; layer++) {
      for (let i = 0; i < 3 - layer; i++) {
        const across = layer % 2 === 1;
        const off = (i - (2 - layer) / 2) * 0.22;
        const bar = part(GOLD_BAR, mats.gold, x + (across ? 0 : off), 0.065 + layer * 0.13, z + (across ? off : 0));
        bar.rotation.y = across ? Math.PI / 2 : 0;
      }
    }
  }

  // on the greatest heaps, a sword thrust into the gold and a shield leaning on it
  if (size >= 1) {
    const sx = w * 0.12 * (random() < 0.5 ? -1 : 1);
    const sz = -0.2;
    const sword = new THREE.Group();
    sword.position.set(sx, at(sx, sz) + 0.5, sz);
    sword.rotation.set(-0.25, random() * Math.PI, 0.2);
    for (const [geo, mat] of [[SWORD_BLADE, mats.iron], [SWORD_HILT, mats.gold]] as const) {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      sword.add(m);
    }
    g.add(sword);
    const hx = -sx * 1.4;
    const shield = part(SHIELD, mats.gold, hx, 0.62, 1.05);
    shield.rotation.set(-0.42, (random() - 0.5) * 0.6, (random() - 0.5) * 0.3);
  }
  standAt(k, g, s, 0);
  if (size >= 0.7) {
    const [lx, lz] = fromSpot(s, 0, 0, 3.2);
    k.light(0xffb25a, 24 + size * 22, 14, lx, 2.8, lz);
  }
}

/**
 * A heap of coins piled against the wall, `w` wide along it and `h` high at
 * its crest, the wall's foot at z = 0 and its toe out on the floor toward +z.
 * Returns it and the height of its surface at a point.
 */
function coinHeap(w: number, h: number, seed: number): { geo: THREE.BufferGeometry; at: (x: number, z: number) => number } {
  const n = simplex2(seed);
  const at = (x: number, z: number): number => {
    const across = Math.max(0, 1 - (x / (w / 2)) ** 2);
    // broad mounds where it has been heaped, and the roughness of loose coins over them
    const mounds = 1 + fbm2(n, x * 0.3, z * 0.3, 2) * 0.28;
    const rough = fbm2(n, x * 1.7 + 40, z * 1.7, 2) * 0.05;
    // steep against the wall, then a long slope out to its toe on the floor
    const rise = smoothstep(1.6, -0.9, z);
    return (h * Math.pow(across, 0.6) * mounds + rough) * rise - 0.04;
  };
  const geo = new THREE.PlaneGeometry(w, 4.6, 44, 20).rotateX(-Math.PI / 2).translate(0, 0, -0.7);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, at(pos.getX(i), pos.getZ(i)));
  geo.deleteAttribute('uv');
  geo.computeVertexNormals();
  return { geo, at };
}

const COIN = new THREE.CylinderGeometry(0.1, 0.1, 0.024, 10);

/** A cup on a stem, 0.55 m tall. */
const CHALICE = lathe([
  [0, 0], [0.2, 0], [0.21, 0.03], [0.06, 0.08], [0.045, 0.28], [0.08, 0.31], [0.2, 0.37], [0.23, 0.55], [0.205, 0.55], [0.17, 0.39], [0, 0.37],
], 16);

const GOLD_BAR = chippedBlock(0.44, 0.13, 0.2, 8100, 0.012, [3, 2, 2]);

/** A round shield, its face toward +z. */
const SHIELD = merge([
  new THREE.CylinderGeometry(0.72, 0.72, 0.07, 32).rotateX(Math.PI / 2),
  new THREE.TorusGeometry(0.72, 0.05, 6, 32),
  new THREE.SphereGeometry(0.18, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2).translate(0, 0, 0.03),
]);

/** A sword standing point down: the blade, then its guard, grip and pommel (y 0 at the guard). */
const SWORD_BLADE = merge([
  new THREE.BoxGeometry(0.11, 1.55, 0.025).translate(0, -0.78, 0),
  new THREE.ConeGeometry(0.078, 0.16, 4).rotateX(Math.PI).rotateY(Math.PI / 4).scale(1, 1, 0.23).translate(0, -1.63, 0),
]);
const SWORD_HILT = merge([
  new THREE.BoxGeometry(0.6, 0.07, 0.08),
  new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8).translate(0, 0.18, 0),
  new THREE.SphereGeometry(0.06, 10, 8).translate(0, 0.36, 0),
]);

/** An iron strongbox at (x, y, z) in a set piece, its lid thrown back and gold heaped inside. */
function strongbox(k: KitBuild, g: THREE.Group, x: number, y: number, z: number, turn: number, seed: number): void {
  const { mats } = k;
  const box = new THREE.Group();
  box.position.set(x, y, z);
  box.rotation.y = turn;
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, px: number, py: number, pz: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  part(chippedBlock(1.2, 0.62, 0.76, seed, 0.02, [4, 3, 3]), mats.iron, box, 0, 0.31, 0);
  part(STRAPS, mats.iron, box, 0, 0.31, 0);
  part(GOLD_FILL, mats.gold, box, 0, 0.58, 0);
  const lid = new THREE.Group();
  lid.position.set(0, 0.62, -0.38);
  lid.rotation.x = -1.95;
  box.add(lid);
  part(LID, mats.iron, lid, 0, 0, 0.38);
  g.add(box);
}

const STRAPS = merge([-0.38, 0, 0.38].map((x) => new THREE.BoxGeometry(0.08, 0.64, 0.8).translate(x, 0, 0)));
const LID = merge([
  new THREE.CylinderGeometry(0.38, 0.38, 1.2, 14, 1, false, 0, Math.PI).rotateZ(Math.PI / 2),
  new THREE.BoxGeometry(1.2, 0.04, 0.76),
]);
const GOLD_FILL = new THREE.SphereGeometry(0.5, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.12, 0.42, 0.7);

// ---------------------------------------------------------------------------
// The Drowned Halls: a flooded crypt

/**
 * The Drowned Halls' dressing: a colonnade of fluted limestone, every third
 * column fallen to a stump; stone fonts of soul fire; water falling from high
 * in the walls into black pools; sarcophagi with their lids pushed aside;
 * hooded mourners keeping watch from their plinths; urns of green bronze; and
 * soul lanterns hanging on chains.
 */
export const drownedKit: Kit = (k) => {
  const { c, index, random, mats, add } = k;
  // columns on moulded bases, the broken ones with their drums in pieces at their feet
  c.pillars.forEach(([x, z, r], i) => {
    const cr = r * 0.85;
    const seed = 6000 + index * 97 + i * 13;
    add(columnBase(cr), mats.tideStone, x, 0, z);
    if ((i + index) % 3 === 1) {
      const h = 2.6 + random() * 2.4;
      add(brokenShaft(cr, h, seed), mats.tideStone, x, 0.6, z);
      add(brokenCap(cr, seed), mats.tideStone, x, 0.6 + h, z, false);
      for (let p = 0; p < 3; p++) {
        const a = random() * Math.PI * 2;
        const sz = 0.35 + random() * 0.35;
        const chunk = add(chippedBlock(sz * 1.4, sz, sz, seed + 50 + p, 0.08), mats.tideStone, x + Math.cos(a) * cr * 1.35, sz * 0.4, z + Math.sin(a) * cr * 1.35);
        chunk.rotation.set(random() * 0.6, random() * Math.PI, random() * 0.6);
      }
    } else {
      const h = 8.5 + random() * 3;
      add(flutedShaft(cr, h, 20, 80, 10), mats.tideStone, x, 0.6, z).rotation.y = random() * Math.PI;
      add(columnCapital(cr), mats.tideStone, x, 0.6 + h, z).rotation.y = random() * (Math.PI / 2);
    }
  });

  // fonts of soul fire: a basin on a pedestal, its lip bound in green bronze
  const font = FONT;
  for (const [x, z] of c.fires) {
    const turn = random() * Math.PI;
    add(chippedBlock(1.3, 0.3, 1.3, 6100 + index, 0.04), mats.tideStone, x, 0.15, z).rotation.y = turn;
    add(font, mats.tideStone, x, 0, z).rotation.y = turn;
    add(FONT_RIM, mats.verdigris, x, 0, z, false);
    add(COALS, mats.coals, x, FLAME_Y - 0.13, z, false);
    add(FLAME_BED, mats.flameBed, x, FLAME_Y - 0.12, z, false).rotation.y = turn;
  }

  // the walls: two falls of water facing each other across the hall, then
  // the dead's furniture, then rubble and urns
  const used: number[] = [];
  const near = (a: number, gap: number) => used.some((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < gap);
  for (const a of [0, Math.PI]) {
    const spot = wallAt(c, a + (random() - 0.5) * 0.3);
    if (!spot) continue;
    waterfall(k, spot);
    used.push(spot.a);
  }
  const place = (count: number, gap: number, build: (s: WallSpot) => void) => {
    for (let n = 0, tries = 0; n < count && tries < 60; tries++) {
      const spot = wallAt(c, random() * Math.PI * 2);
      if (!spot || near(spot.a, gap)) continue;
      build(spot);
      used.push(spot.a);
      n++;
    }
  };
  if (c.boss) foundry(k, used);
  place(c.boss ? 3 : 2, 0.5, (s) => mourner(k, s));
  place(c.boss ? 1 : 3, 0.45, (s) => sarcophagus(k, s));
  const rocks = Array.from({ length: 5 }, (_, i) => boulder(1, 6200 + i * 19, 3));
  const urns = [urn(0.55, 1.1), urn(0.4, 0.8), urn(0.32, 1.0)];
  const steps = 48;
  for (let s = 0; s < steps; s++) {
    const spot = wallAt(c, (s / steps) * Math.PI * 2 + random() * 0.05);
    if (!spot || near(spot.a, 0.2)) continue;
    const { x, z, dx, dz } = spot;
    if (s % 5 === 2) {
      // urns in a huddle, one knocked over
      for (let u = 0; u < 3; u++) {
        const side = (u - 1) * 0.85;
        const ux = x - dz * side - dx * 0.3;
        const uz = z + dx * side - dz * 0.3;
        const m = add(urns[(s + u) % urns.length]!, mats.verdigris, ux, 0, uz);
        m.rotation.y = random() * Math.PI * 2;
        if (u === 2 && random() < 0.5) {
          m.rotation.set(Math.PI / 2 - 0.15, random() * Math.PI, 0);
          m.position.y = 0.42;
        }
      }
      continue;
    }
    const sz = 0.9 + random() * 1.5;
    const rock = add(rocks[s % rocks.length]!, mats.tideStone, x + dx * sz * 0.45, sz * 0.05, z + dz * sz * 0.45);
    rock.scale.set(sz, sz * (0.5 + random() * 0.5), sz);
    rock.rotation.y = random() * Math.PI * 2;
  }

  // soul lanterns hanging over the floor on green chains
  const link = chainLink();
  for (let n = 0, tries = 0; n < 7 && tries < 200; tries++) {
    const x = (random() * 2 - 1) * 34;
    const z = (random() * 2 - 1) * 34;
    const f = chamberField(c, x, z);
    if (f < 1.5 || f > 9) continue;
    const bottom = 5.5 + random() * 4;
    chain(k, link, x, z, bottom, 23, mats.verdigris);
    lantern(k, x, z, bottom);
    if (n < 2) k.light(0x5aa8ff, 16, 11, x, bottom - 0.8, z);
    n++;
  }
};

/** A font's basin on its pedestal, the lip just under FLAME_Y. */
const FONT = lathe([
  [0, 0.3], [0.42, 0.3], [0.42, 0.42], [0.3, 0.5], [0.24, 0.95], [0.34, 1.02], [0.66, 1.16], [0.8, FLAME_Y - 0.1],
  [0.82, FLAME_Y - 0.04], [0.72, FLAME_Y - 0.03], [0.6, 1.3], [0, 1.24],
], 28);
const FONT_RIM = new THREE.TorusGeometry(0.8, 0.05, 6, 28).rotateX(Math.PI / 2).translate(0, FLAME_Y - 0.06, 0);

/**
 * Water falling from high in the wall into a black pool: two sheets bowing
 * out from the rock as they fall, the pool ringed with stones, and the cold
 * light the falling water throws.
 */
function waterfall(k: KitBuild, s: WallSpot): void {
  const { mats, random } = k;
  const g = new THREE.Group();
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, cast = false) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const H = 16;
  const foot = 1.7;
  const sheet = (w: number, out: number) => {
    const geo = new THREE.PlaneGeometry(w, H, 1, 24).translate(0, H / 2, 0);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const t = 1 - pos.getY(i) / H;
      pos.setX(i, pos.getX(i) * (1 + t * 0.4));
      pos.setZ(i, 0.3 + t * t * out);
    }
    return geo;
  };
  part(sheet(3.2, foot), mats.waterfall, 0, 0, 0);
  part(sheet(2.1, foot + 0.35), mats.waterfall, 0.45, 0, 0.12);
  part(new THREE.CircleGeometry(3.4, 40).rotateX(-Math.PI / 2), mats.pool, 0, 0.04, foot + 0.3);
  // stones round the pool's rim
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * (0.05 + (i / 8) * 0.9);
    const sz = 0.45 + random() * 0.4;
    const st = part(boulder(sz, 6300 + k.index * 11 + i, 2), mats.tideStone, Math.cos(a) * 3.5, sz * 0.15, foot + 0.3 + Math.sin(a) * 3.3, true);
    st.scale.y = 0.6;
  }
  const back = 0.5;
  g.position.set(s.x + s.dx * back, 0, s.z + s.dz * back);
  g.rotation.y = facingIn(s);
  k.group.add(g);
  const out = foot + 0.3 - back;
  k.light(0x6ab8ff, 34, 15, s.x - s.dx * out, 1.4, s.z - s.dz * out);
}

/** A hooded mourner on a plinth, head bowed, two points of soul light in the dark of the hood. */
function mourner(k: KitBuild, s: WallSpot): void {
  const { mats } = k;
  const g = new THREE.Group();
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, cast = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  part(chippedBlock(1.45, 1.1, 1.45, 6400 + Math.round(s.a * 100), 0.05), mats.tideStone, 0, 0.55, 0);
  part(ROBE, mats.tideStone, 0, 1.1, 0);
  const head = new THREE.Group();
  head.position.set(0, 1.1 + 2.3, 0.02);
  head.rotation.x = 0.35;
  g.add(head);
  const hood = new THREE.Mesh(HOOD, mats.tideStone);
  hood.castShadow = true;
  hood.receiveShadow = true;
  const face = new THREE.Mesh(FACE, mats.obsidian);
  face.position.set(0, 0.2, 0.03);
  const eyes = new THREE.Mesh(EYES, mats.coals);
  head.add(hood, face, eyes);
  // out from the rock (the wall can lean over its foot), the plinth's front just short of where anyone walks
  const back = -0.45;
  g.position.set(s.x + s.dx * back, 0, s.z + s.dz * back);
  g.rotation.y = facingIn(s);
  k.group.add(g);
  // a cold light on the mourner from the floor in front
  const out = 2.2 - back;
  k.light(0x7ab8ff, 14, 8, s.x - s.dx * out, 1.0, s.z - s.dz * out);
}

/** A robe falling in folds from narrow shoulders to a wide hem, 2.45 m tall. */
const ROBE = (() => {
  const geo = lathe([
    [0, 0], [0.66, 0], [0.64, 0.12], [0.55, 0.7], [0.46, 1.4], [0.44, 1.85], [0.47, 2.1], [0.4, 2.28], [0.2, 2.42], [0, 2.45],
  ], 36);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const fold = 1 + 0.07 * Math.sin(a * 9) * Math.max(0, 1 - y / 2.2);
    // broad at the shoulders, flat front to back
    pos.setXYZ(i, x * fold * 1.12, y, z * fold * 0.82);
  }
  geo.computeVertexNormals();
  return geo;
})();

/** A hood open at the front (+z), its crown at y 0.55. */
const HOOD = (() => {
  const gap = 1.0;
  const geo = new THREE.SphereGeometry(0.36, 20, 12, Math.PI / 2 + gap, Math.PI * 2 - gap * 2, 0, Math.PI * 0.78);
  geo.scale(1, 1.3, 1.15).translate(0, 0.2, 0);
  return geo;
})();
const FACE = new THREE.SphereGeometry(0.27, 12, 8).scale(1, 1.2, 0.9);
const EYES = merge([-0.085, 0.085].map((x) => new THREE.SphereGeometry(0.032, 6, 4).translate(x, 0.24, 0.25)));

/** A stone coffin on a low plinth, its carved lid pushed askew or fallen against its side. */
function sarcophagus(k: KitBuild, s: WallSpot): void {
  const { mats, random } = k;
  const g = new THREE.Group();
  const part = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mats.tideStone);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const seed = 6500 + Math.round(s.a * 100);
  part(chippedBlock(2.8, 0.22, 1.4, seed, 0.03), 0, 0.11, 0);
  part(chippedBlock(2.5, 0.95, 1.12, seed + 1, 0.04), 0, 0.69, 0);
  const lid = new THREE.Group();
  for (const [geo, y] of [[chippedBlock(2.6, 0.26, 1.22, seed + 2, 0.03), 0], [chippedBlock(1.7, 0.14, 0.56, seed + 3, 0.05), 0.19]] as const) {
    const m = new THREE.Mesh(geo, mats.tideStone);
    m.position.y = y;
    m.castShadow = true;
    m.receiveShadow = true;
    lid.add(m);
  }
  if (random() < 0.5) {
    lid.position.set(0.4, 1.3, 0.18);
    lid.rotation.y = 0.16;
  } else {
    lid.position.set(0.1, 0.62, 0.95);
    lid.rotation.set(-1.15, 0.05, 0);
  }
  g.add(lid);
  const back = 0.2;
  g.position.set(s.x + s.dx * back, 0, s.z + s.dz * back);
  g.rotation.y = facingIn(s);
  k.group.add(g);
}

/** A funeral urn: a round belly, a narrow neck and a flared lip. */
function urn(r: number, h: number): THREE.BufferGeometry {
  return lathe([
    [0, 0], [r * 0.45, 0], [r * 0.5, h * 0.06], [r * 0.95, h * 0.35], [r, h * 0.5], [r * 0.8, h * 0.72], [r * 0.38, h * 0.84],
    [r * 0.36, h * 0.92], [r * 0.55, h], [r * 0.48, h * 1.02], [0, h * 0.95],
  ], 20);
}

/** A soul lantern on the end of a chain: a green bronze cage round a glowing orb. */
function lantern(k: KitBuild, x: number, z: number, top: number): void {
  cage(k, x, z, top, k.mats.verdigris);
  k.add(ORB, k.mats.coals, x, top - 0.95, z, false);
}

const ORB = new THREE.SphereGeometry(0.24, 14, 10);

// ---------------------------------------------------------------------------
// The Molten Colossus's arena: its foundry

/**
 * The Molten Colossus's sunken foundry: two great crucibles hanging on
 * chains either side of the way on, tipped to pour white-hot metal into
 * casting troughs at the foot of the walls, their orange light thrown across
 * the cold halls; and two pairs of broken bronze legs on their plinths, all
 * that is left of the colossi this place once cast.
 */
function foundry(k: KitBuild, used: number[]): void {
  for (const deg of [-126, -54]) {
    const s = wallAt(k.c, (deg * Math.PI) / 180);
    if (!s) continue;
    // each pours away from the way on
    const side = deg < -90 ? -1 : 1;
    crucible(k, s, side);
    used.push(s.a, s.a + side * 0.13);
  }
  for (const deg of [-150, -30]) {
    const s = wallAt(k.c, (deg * Math.PI) / 180);
    if (!s) continue;
    bronzeLegs(k, s);
    used.push(s.a);
  }
}

/** How far a crucible is tipped on its trunnions, and where they hang (over the wall's foot). */
const TIP = 0.9;
const PIVOT = { y: 5.6, z: 1.3 } as const;
/** How much bigger than its model a crucible is built, and where its spout ends in its own frame (the pivot at the origin, the spout toward +x). */
const POT = 1.3;
const SPOUT = new THREE.Vector3(2.3, 1.36, 0).multiplyScalar(POT);

/** A crucible hanging by its trunnions on two chains, tipped toward `side` (+-1 along the wall) to pour into a trough. */
function crucible(k: KitBuild, s: WallSpot, side: number): void {
  const { mats } = k;
  const { g, part } = setPiece();
  const pot = new THREE.Group();
  pot.position.set(0, PIVOT.y, PIVOT.z);
  pot.rotation.z = -TIP * side;
  pot.scale.setScalar(POT);
  g.add(pot);
  for (const [geo, mat, cast] of [[CRUCIBLE, mats.iron, true], [CRUCIBLE_MELT, mats.molten, false]] as const) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    // the spout toward the side it pours
    if (side < 0) m.rotation.y = Math.PI;
    pot.add(m);
  }
  part(AXLE, mats.iron, 0, PIVOT.y, PIVOT.z);

  // the stream from its spout down into the trough, and the trough brimming
  const tip = SPOUT.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), -TIP);
  const at = 4.2 * side;
  const from = new THREE.Vector3(tip.x * side, PIVOT.y + tip.y, PIVOT.z);
  const curve = new THREE.QuadraticBezierCurve3(from, new THREE.Vector3(from.x + side * 0.9, from.y - 0.1, PIVOT.z), new THREE.Vector3(at, 0.6, PIVOT.z));
  part(new THREE.TubeGeometry(curve, 24, 0.24, 8), mats.molten, 0, 0, 0, false);
  part(SPLASH, mats.molten, at, 0.6, PIVOT.z, false);
  part(chippedBlock(3.1, 0.62, 1.55, 8200 + Math.round(s.a * 100), 0.04), mats.tideStone, at, 0.31, 0.75);
  part(TROUGH_MELT, mats.molten, at, 0.63, 0.75, false);
  // where it has brimmed over and run along the foot of the wall, cooling
  part(SPILL, mats.molten, at + side * 2.3, 0.025, 0.35, false).rotation.y = side * 0.4;
  standAt(k, g, s, 0);

  // the chains it hangs from, out of the dark
  const link = chainLink();
  for (const end of [-1, 1]) {
    const [x, z] = fromSpot(s, 0, 0, PIVOT.z + end * 2.25 * POT);
    chain(k, link, x, z, PIVOT.y + 0.1, 23);
  }
  const [lx, lz] = fromSpot(s, 0, at, 2.6);
  k.light(0xff7a2a, 60, 17, lx, 1.8, lz);
  // and the glow of its mouth
  const [sx, sz] = fromSpot(s, 0, from.x + side * 0.4, PIVOT.z + 0.8);
  k.light(0xff8a3a, 18, 7, sx, from.y - 0.6, sz);
}

/** A great crucible of iron, banded, its pivot at the origin and its spout toward +x. */
const CRUCIBLE = merge([
  lathe([
    [0, -1.3], [0.85, -1.3], [1.3, -1.05], [1.6, -0.4], [1.75, 0.5], [1.8, 1.2], [1.98, 1.28], [1.95, 1.42],
    [1.7, 1.4], [1.6, 0.5], [1.45, -0.4], [1.05, -0.95], [0, -1.0],
  ], 28),
  new THREE.TorusGeometry(1.7, 0.08, 6, 28).rotateX(Math.PI / 2).translate(0, 0.0, 0),
  new THREE.TorusGeometry(1.79, 0.08, 6, 28).rotateX(Math.PI / 2).translate(0, 0.9, 0),
  // the spout
  new THREE.BoxGeometry(0.62, 0.12, 0.7).translate(2.0, 1.32, 0),
  new THREE.BoxGeometry(0.5, 0.22, 0.08).translate(2.02, 1.42, 0.33),
  new THREE.BoxGeometry(0.5, 0.22, 0.08).translate(2.02, 1.42, -0.33),
  // the trunnions
  new THREE.CylinderGeometry(0.3, 0.3, 0.5, 10).rotateX(Math.PI / 2).translate(0, 0, 1.95),
  new THREE.CylinderGeometry(0.3, 0.3, 0.5, 10).rotateX(Math.PI / 2).translate(0, 0, -1.95),
]);
/** The metal inside, brimming at the lip. */
const CRUCIBLE_MELT = new THREE.CircleGeometry(1.62, 28).rotateX(-Math.PI / 2).translate(0, 1.18, 0);
const AXLE = new THREE.CylinderGeometry(0.2, 0.2, 4.7 * POT, 10).rotateX(Math.PI / 2);
const SPLASH = new THREE.SphereGeometry(0.42, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.45, 1);
const TROUGH_MELT = new THREE.PlaneGeometry(2.75, 1.2).rotateX(-Math.PI / 2);
const SPILL = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2).scale(1.5, 1, 0.55);

/** A colossus's legs broken off above the knees, old bronze streaked green, striding on a plinth against the wall. */
function bronzeLegs(k: KitBuild, s: WallSpot): void {
  const { mats } = k;
  const { g, part } = setPiece();
  const seed = 8300 + Math.round(s.a * 100);
  part(chippedBlock(6, 1.5, 3.2, seed, 0.04), mats.tideStone, 0, 0.75, -0.5);
  part(chippedBlock(6.6, 0.35, 3.5, seed + 1, 0.04), mats.tideStone, 0, 0.17, -0.45);
  for (const side of [-1, 1]) {
    // one foot a stride ahead of the other
    const z = -0.75 + side * 0.35;
    part(FOOT, mats.bronze, side * 1.4, 1.5, z).scale.setScalar(1.15);
    part(colossusLeg(seed + side), mats.bronze, side * 1.4, 1.5 + 0.55, z - 0.05).rotation.y = side * 0.08;
  }
  standAt(k, g, s, 0);
  // a cold light from the floor in front, catching the bronze
  const [lx, lz] = fromSpot(s, 0, 0, 3.4);
  k.light(0x7ab8ff, 9, 10, lx, 1.2, lz);
}

/** A foot on its sole, toes toward +z, the ankle over its heel at y 0.5. */
const FOOT = merge([
  chippedBlock(1.25, 0.55, 2.0, 8400, 0.05).translate(0, 0.275, 0.45),
  ...[0, 1, 2, 3].map((t) => new THREE.SphereGeometry(0.19 - t * 0.02, 10, 6).scale(1, 0.75, 1.3).translate(-0.4 + t * 0.27, 0.16, 1.5 - t * 0.05)),
  new THREE.SphereGeometry(0.55, 14, 8).scale(1, 0.7, 1.1).translate(0, 0.45, -0.1),
]);

/** A leg from the ankle to a jagged break above the knee, the calf swelling behind and the knee ahead. */
function colossusLeg(seed: number): THREE.BufferGeometry {
  const n = simplex2(seed);
  const top = 6.8;
  const geo = lathe(([
    [0, 0], [0.5, 0], [0.48, 0.5], [0.6, 1.2], [0.8, 2.1], [0.76, 2.9], [0.6, 3.6], [0.64, 4.0], [0.82, 4.7], [0.9, 5.4], [0, 5.1],
  ] as [number, number][]).map(([r, y]) => [r * 1.18, y * (top / 5.4)]), 24);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    let y = pos.getY(i);
    // the break: each point of the rim higher or lower round it
    if (y > top - 0.05) y += n(Math.cos(Math.atan2(z, x)) * 1.6, Math.sin(Math.atan2(z, x)) * 1.6) * 0.6;
    const calf = -0.17 * Math.exp(-(((y - 2.8) / 1.0) ** 2));
    const knee = 0.13 * Math.exp(-(((y - 4.65) / 0.45) ** 2));
    pos.setXYZ(i, x, y, z + calf + knee);
  }
  return smooth(geo);
}

/** Welds a reshaped part's seams and shades it smooth. */
function smooth(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.deleteAttribute('uv');
  geo.deleteAttribute('normal');
  const welded = mergeVertices(geo, 1e-4);
  welded.computeVertexNormals();
  return welded;
}

// ---------------------------------------------------------------------------
// The Abyss: an ossuary at the bottom of the world

/**
 * The Abyss's dressing: spines of stacked vertebrae for columns, crowned with
 * horns; baskets of curved ribs holding the spirit fire; ossuary walls of
 * skulls in their niches; heaps of bones along the foot of the walls; a
 * giant's ribcage sunk into the rock, its ribs sweeping out over the hall;
 * and spirit lanterns hanging on chains.
 */
export const abyssKit: Kit = (k) => {
  const { c, index, random, mats, add } = k;
  // spines: a black plinth, vertebrae stacked and tapering, a crown of horns
  c.pillars.forEach(([x, z, r], i) => {
    const seed = 7000 + index * 89 + i * 17;
    const h = 8.5 + random() * 3;
    add(chippedBlock(r * 2.6, 0.8, r * 2.6, seed, 0.05), mats.obsidian, x, 0.4, z).rotation.y = random() * Math.PI;
    add(spine(r, h, seed), mats.bone, x, 0.8, z).rotation.y = random() * Math.PI;
    add(hornCrown(r, seed), mats.bone, x, 0.8 + h, z).rotation.y = random() * Math.PI;
  });

  // rib baskets for the spirit fire, on a short spine
  const basket = ribBasket();
  for (const [x, z] of c.fires) {
    const turn = random() * Math.PI;
    add(basket, mats.bone, x, 0, z).rotation.y = turn;
    add(COALS, mats.coals, x, FLAME_Y - 0.13, z, false);
    add(FLAME_BED, mats.flameBed, x, FLAME_Y - 0.12, z, false).rotation.y = turn;
  }

  // the walls: the giant's ribcage, ossuary panels, then heaps of bones
  const used: number[] = [];
  const near = (a: number, gap: number) => used.some((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < gap);
  {
    const spot = wallAt(c, (index % 2 ? 0 : Math.PI) + (random() - 0.5) * 0.3);
    if (spot) {
      ribcage(k, spot);
      used.push(spot.a);
    }
  }
  if (c.boss) court(k, used);
  for (let n = 0, tries = 0; n < (c.boss ? 2 : 3) && tries < 60; tries++) {
    const spot = wallAt(c, random() * Math.PI * 2);
    if (!spot || near(spot.a, 0.42)) continue;
    ossuary(k, spot);
    used.push(spot.a);
    n++;
  }
  const piles = [bonePile(7100 + index), bonePile(7200 + index)];
  const rocks = Array.from({ length: 4 }, (_, i) => boulder(1, 7300 + i * 23, 3));
  const steps = 56;
  for (let s = 0; s < steps; s++) {
    const spot = wallAt(c, (s / steps) * Math.PI * 2 + random() * 0.05);
    if (!spot || near(spot.a, 0.2)) continue;
    const { x, z, dx, dz } = spot;
    if (s % 3 === 0) {
      const p = add(piles[s % 2]!, mats.bone, x + dx * 0.2, 0, z + dz * 0.2, false);
      p.rotation.y = random() * Math.PI * 2;
      p.scale.setScalar(0.8 + random() * 0.5);
      continue;
    }
    const sz = 1 + random() * 1.6;
    const rock = add(rocks[s % rocks.length]!, mats.obsidian, x + dx * sz * 0.45, sz * 0.05, z + dz * sz * 0.45);
    rock.scale.set(sz, sz * (0.6 + random() * 0.6), sz);
    rock.rotation.y = random() * Math.PI * 2;
  }

  // spirit lanterns on iron chains
  const link = chainLink();
  for (let n = 0, tries = 0; n < 6 && tries < 200; tries++) {
    const x = (random() * 2 - 1) * 34;
    const z = (random() * 2 - 1) * 34;
    const f = chamberField(c, x, z);
    if (f < 1.5 || f > 9) continue;
    const bottom = 6 + random() * 4;
    chain(k, link, x, z, bottom, 23);
    cage(k, x, z, bottom);
    k.add(ORB, mats.coals, x, bottom - 0.95, z, false);
    if (n < 2) k.light(0x5aff8a, 14, 10, x, bottom - 0.8, z);
    n++;
  }
};

/**
 * Bends a part built up the y axis (0 to `length`) into an arc curling
 * toward +x, turning through `curl` radians over its length.
 */
function bend(geo: THREE.BufferGeometry, length: number, curl: number): THREE.BufferGeometry {
  if (Math.abs(curl) < 1e-4) return geo;
  const R = length / curl;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const th = (y / length) * curl;
    // the spine point, and the offset along the arc's normal
    pos.setXY(i, R * (1 - Math.cos(th)) + x * Math.cos(th), R * Math.sin(th) - x * Math.sin(th));
  }
  geo.computeVertexNormals();
  return geo;
}

/** A tapering horn or rib, `length` long, `r` thick at its root, curling through `curl`. */
function curvedBone(length: number, r: number, curl: number, tip = 0.15, segments = 10): THREE.BufferGeometry {
  const pts: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    pts.push([r * (1 - (1 - tip) * t) * (1 + 0.12 * Math.sin(t * Math.PI * 3)), t * length]);
  }
  pts.push([0, length]);
  return bend(lathe(pts, 7), length, curl);
}

/** A column of stacked vertebrae, tapering up from radius r to h tall. */
function spine(r: number, h: number, seed: number): THREE.BufferGeometry {
  const random = rng(seed);
  const n = Math.round(h / (r * 0.75));
  const step = h / n;
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const s = r * (1 - (i / n) * 0.3);
    const y = i * step;
    // the body: a waisted drum, a flared lip top and bottom
    parts.push(lathe([[0, 0], [s * 0.95, 0], [s * 1.02, step * 0.12], [s * 0.82, step * 0.5], [s * 1.02, step * 0.86], [s * 0.95, step * 0.94], [0, step * 0.94]], 12).translate(0, y, 0));
    // three processes jutting out and down
    const turn = random() * 0.4;
    for (let p = 0; p < 3; p++) {
      const a = turn + (p / 3) * Math.PI * 2 + (p === 0 ? 0 : (random() - 0.5) * 0.3);
      const len = s * (p === 0 ? 1.3 : 0.85);
      const proc = curvedBone(len, s * 0.2, -0.5, 0.3, 4).rotateZ(-Math.PI / 2 - 0.25);
      proc.rotateY(-a).translate(Math.cos(a) * s * 0.7, y + step * 0.55, Math.sin(a) * s * 0.7);
      parts.push(proc);
    }
  }
  return merge(parts);
}

/** A crown of horns curling out and up from the top of a spine. */
function hornCrown(r: number, seed: number): THREE.BufferGeometry {
  const random = rng(seed + 3);
  const parts: THREE.BufferGeometry[] = [lathe([[0, 0], [r * 0.9, 0], [r * 1.1, 0.3], [r * 0.6, 0.6], [0, 0.65]], 12)];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + random() * 0.4;
    const len = r * (2.2 + random() * 1.4);
    // out from the crown, curling up
    const horn = curvedBone(len, r * 0.28, 1.3 + random() * 0.4, 0.05, 10).rotateZ(-1.25);
    horn.rotateY(-a).translate(Math.cos(a) * r * 0.6, 0.35, Math.sin(a) * r * 0.6);
    parts.push(horn);
  }
  return merge(parts);
}

/** A basket of seven ribs rising from a vertebra stand, holding the fire at FLAME_Y. */
function ribBasket(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [spine(0.3, 0.85, 7400)];
  parts.push(new THREE.TorusGeometry(0.34, 0.07, 6, 18).rotateX(Math.PI / 2).translate(0, 0.9, 0));
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    // out and up from the ring, curling in at the tips over the fire
    const rib = curvedBone(1.05, 0.055, -1.4, 0.35, 8).rotateZ(-0.75);
    rib.rotateY(-a).translate(Math.cos(a) * 0.32, 0.88, Math.sin(a) * 0.32);
    parts.push(rib);
  }
  // a bowl of bone under the coals
  parts.push(lathe([[0, 0.9], [0.4, 0.92], [0.7, 1.2], [0.74, FLAME_Y - 0.08], [0.66, FLAME_Y - 0.08], [0, 1.18]], 18));
  return merge(parts);
}

/** A heap of long bones and skulls, about 2 m across. */
function bonePile(seed: number): THREE.BufferGeometry {
  const random = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 26; i++) {
    const len = 0.5 + random() * 0.45;
    const bone = longBone(len, 0.045 + random() * 0.025);
    bone.rotateX(Math.PI / 2 + (random() - 0.5) * 0.7).rotateY(random() * Math.PI * 2);
    const rr = Math.sqrt(random()) * 0.95;
    const a = random() * Math.PI * 2;
    // heaped higher in the middle
    bone.translate(Math.cos(a) * rr, 0.05 + (1 - rr) * 0.5 * random(), Math.sin(a) * rr);
    parts.push(bone);
  }
  for (let i = 0; i < 7; i++) {
    const sk = skull(0.13 + random() * 0.04);
    sk.rotateY(random() * Math.PI * 2).rotateX((random() - 0.5) * 0.8);
    const rr = Math.sqrt(random()) * 0.8;
    const a = random() * Math.PI * 2;
    sk.translate(Math.cos(a) * rr, 0.12 + (1 - rr) * 0.45, Math.sin(a) * rr);
    parts.push(sk);
  }
  return merge(parts);
}

/** A long bone along y, `len` long: a shaft between two knobbed ends. */
function longBone(len: number, r: number): THREE.BufferGeometry {
  return merge([
    new THREE.CylinderGeometry(r * 0.8, r * 0.8, len, 6).translate(0, len / 2, 0),
    new THREE.SphereGeometry(r * 1.5, 6, 4).scale(1.3, 1, 1).translate(0, 0, 0),
    new THREE.SphereGeometry(r * 1.5, 6, 4).scale(1.3, 1, 1).translate(0, len, 0),
  ]).translate(0, -len / 2, 0);
}

/** A skull facing +z, `r` the cranium's radius: cranium, cheekbones and jaw (the sockets are dark spheres, see SOCKETS). */
function skull(r: number): THREE.BufferGeometry {
  return merge([
    new THREE.SphereGeometry(r, 10, 8).scale(0.9, 0.95, 1.1).translate(0, r * 0.2, 0),
    new THREE.BoxGeometry(r * 1.3, r * 0.7, r * 0.8).translate(0, -r * 0.45, r * 0.45),
    new THREE.BoxGeometry(r * 0.95, r * 0.35, r * 0.75).translate(0, -r * 0.95, r * 0.4),
  ]);
}

/** A panel of ossuary niches against the wall: a black stone frame, rows of skulls, their sockets dark. */
function ossuary(k: KitBuild, s: WallSpot): void {
  const { mats, random } = k;
  const g = new THREE.Group();
  const seed = 7500 + Math.round(s.a * 100);
  const frame: THREE.BufferGeometry[] = [];
  const W = 4.2;
  const rows = 4;
  const cols = 6;
  const rowH = 0.85;
  frame.push(chippedBlock(W + 0.6, 0.5, 1.2, seed, 0.04).translate(0, 0.25, 0));
  frame.push(chippedBlock(0.4, rows * rowH + 0.9, 1.0, seed + 1, 0.04).translate(-W / 2 - 0.1, (rows * rowH + 0.9) / 2, -0.1));
  frame.push(chippedBlock(0.4, rows * rowH + 0.9, 1.0, seed + 2, 0.04).translate(W / 2 + 0.1, (rows * rowH + 0.9) / 2, -0.1));
  frame.push(chippedBlock(W + 1.0, 0.55, 1.3, seed + 3, 0.04).translate(0, rows * rowH + 0.75, 0));
  frame.push(new THREE.BoxGeometry(W, rows * rowH, 0.3).translate(0, 0.5 + (rows * rowH) / 2, -0.45));
  for (let r = 1; r < rows; r++) frame.push(chippedBlock(W, 0.1, 0.8, seed + 10 + r, 0.02).translate(0, 0.5 + r * rowH, -0.05));
  const skulls: THREE.BufferGeometry[] = [];
  const sockets: THREE.BufferGeometry[] = [];
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      if (random() < 0.12) continue;
      const sr = 0.17 + random() * 0.03;
      const x = -W / 2 + (i + 0.5) * (W / cols) + (random() - 0.5) * 0.08;
      const y = 0.5 + r * rowH + sr * 1.1;
      const turn = (random() - 0.5) * 0.5;
      skulls.push(skull(sr).rotateY(turn).translate(x, y, 0));
      sockets.push(SOCKETS.clone().scale(sr, sr, sr).rotateY(turn).translate(x, y, 0));
    }
  }
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, cast: boolean) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    g.add(m);
  };
  part(merge(frame), mats.obsidian, true);
  part(merge(skulls), mats.bone, false);
  part(merge(sockets), mats.obsidian, false);
  const back = 0.35;
  g.position.set(s.x + s.dx * back, 0, s.z + s.dz * back);
  g.rotation.y = facingIn(s);
  g.scale.setScalar(1.35);
  k.group.add(g);
  // a cold glow on the skulls from below
  k.light(0x5aff8a, 10, 7, s.x - s.dx * 1.6, 0.8, s.z - s.dz * 1.6);
}

/** Two eye sockets and a nose for a skull of radius 1 (scaled to the skull's). */
const SOCKETS = merge([
  new THREE.SphereGeometry(0.26, 6, 4).translate(-0.36, -0.08, 0.86),
  new THREE.SphereGeometry(0.26, 6, 4).translate(0.36, -0.08, 0.86),
  new THREE.SphereGeometry(0.12, 5, 3).scale(1, 1.4, 1).translate(0, -0.42, 0.82),
]);

/**
 * A giant's ribcage half sunk in the floor by the wall: its spine lying
 * along the foot of the rock, seven ribs rising out of the ground and
 * curving in over the hall, their broken tips hanging well overhead.
 */
function ribcage(k: KitBuild, s: WallSpot): void {
  const { mats, random } = k;
  const parts: THREE.BufferGeometry[] = [];
  // the spine along the wall (the tangent is local x)
  parts.push(spine(0.7, 14, 7600 + k.index).rotateZ(Math.PI / 2).translate(7, 0.2, -0.6));
  const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0));
  const lean = new THREE.Matrix4();
  for (let i = -3; i <= 3; i++) {
    // longest in the middle of the cage
    const len = 12.5 - Math.abs(i) * 1.1 + random() * 0.6;
    const rib = curvedBone(len, 0.36 - Math.abs(i) * 0.02, 1.55, 0.25, 16).applyMatrix4(basis);
    rib.applyMatrix4(lean.makeRotationZ(-i * 0.05));
    parts.push(rib.translate(i * 2.1, -0.6, -0.2));
  }
  const g = new THREE.Mesh(merge(parts), mats.bone);
  g.castShadow = true;
  g.receiveShadow = true;
  const back = 0.6;
  g.position.set(s.x + s.dx * back, 0, s.z + s.dz * back);
  g.rotation.y = facingIn(s);
  k.group.add(g);
}

// ---------------------------------------------------------------------------
// The Ossuary King's arena: its court

/**
 * The Ossuary King's court: the way on runs through the open mouth of a
 * colossal skull sunk in the wall, and pyramids of skulls stand at the four
 * corners, the topmost of each watching with the spirit fire in its eyes.
 */
function court(k: KitBuild, used: number[]): void {
  maw(k);
  for (const deg of [-146, -34, 146, 34]) {
    const s = wallAt(k.c, (deg * Math.PI) / 180);
    if (!s) continue;
    skullPyramid(k, s);
    used.push(s.a);
  }
  // the walls either side of the skull stay bare
  used.push(-Math.PI / 2 - 0.2, -Math.PI / 2 + 0.2);
}

/** The colossal skull's half width, half height and half depth (m), the height of its middle, and how far it is sunk behind the gate. */
const MAW = { w: 5.6, h: 7.4, d: 4.6, y: 9.6, back: 4.2 } as const;
/** Where its sockets are on the unit sphere it is shaped from (x either side, y up), their half size, and how deep they go (share of its depth). */
const SOCKET = { x: 0.33, y: 0.11, w: 0.19, h: 0.165, deep: 0.45 } as const;
/** How high its mouth's top edge is: the doorway runs through under it. */
const MOUTH = 6.6;

/**
 * The colossal skull round the way on, sunk in the wall behind the gate: the
 * doorway is its open mouth with the upper teeth hanging over it, the black
 * hollow of its nose over the lintel, a heavy brow overhangs two deep black
 * sockets with the spirit fire burning at the back of each, cheekbones jut
 * under them, and horns sweep out from its temples into the dark. The gate's
 * flames burn just in front of its cheeks.
 */
function maw(k: KitBuild): void {
  const { c, mats } = k;
  const { g, part } = setPiece();
  const cz = -(c.extent + MAW.back);
  // where the face is (before its features are carved), at a point of the unit sphere
  const narrow = (ny: number) => (ny < 0 ? 1 - 0.2 * Math.min(1, -ny / 0.7) : 1);
  const front = (nx: number, ny: number) => cz + Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * 0.82 * MAW.d;
  // a rounded square: 1 on its edge
  const squircle = (dx: number, dy: number) => Math.cbrt(Math.abs(dx) ** 3 + Math.abs(dy) ** 3);

  // its seam at the back, which is buried and cut away
  const sphere = new THREE.SphereGeometry(1, 128, 96, -Math.PI / 2);
  const pos = sphere.attributes.position as THREE.BufferAttribute;
  const dark = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const nx = pos.getX(i);
    const ny = pos.getY(i);
    const nz = pos.getZ(i);
    const ax = Math.abs(nx);
    const onFace = smoothstep(0.25, 0.6, nz);
    // the sockets: deep pits with a sharp rim; the nose: a hollow narrowing upward
    const sock = smoothstep(1, 0.72, squircle((ax - SOCKET.x) / SOCKET.w, (ny - SOCKET.y) / SOCKET.h));
    const noseW = 0.04 + 0.045 * smoothstep(0.06, -0.08, ny + 0.13);
    const nose = smoothstep(1, 0.6, Math.hypot(nx / noseW, (ny + 0.13) / 0.085));
    // the brow over the eyes, the cheekbones under and beside them, the ridge the teeth grow from
    const brow = Math.exp(-(((ny - 0.3) / 0.045) ** 2)) * smoothstep(0.62, 0.42, ax);
    const cheek = Math.exp(-(((ax - 0.55) / 0.11) ** 2) - ((ny + 0.06) / 0.07) ** 2);
    const ridge = Math.exp(-(((ny + 0.37) / 0.05) ** 2)) * smoothstep(0.5, 0.3, ax);
    const temple = Math.exp(-(((ax - 0.85) / 0.1) ** 2) - ((ny - 0.12) / 0.16) ** 2);
    const carve = (-SOCKET.deep * sock - 0.32 * nose + 0.07 * brow + 0.07 * cheek + 0.04 * ridge) * onFace;
    dark[i] = Math.max(sock, nose) * onFace;
    const x = nx * narrow(ny) * (1 - 0.1 * temple) * MAW.w;
    // the crown of the head lower than a ball's
    const y = MAW.y + (ny < 0.35 ? ny : 0.35 + (ny - 0.35) * 0.75) * MAW.h;
    const z = cz + (nz > 0 ? nz * 0.82 : nz) * MAW.d + carve * MAW.d;
    pos.setXYZ(i, x, y, z);
  }
  sphere.setAttribute('dark', new THREE.BufferAttribute(dark, 1));
  sphere.computeVertexNormals();
  // open where the doorway runs through it; nothing under the floor or at the back (buried in the rock).
  // Bone outside, black in the sockets and the nose.
  const [hollows, bone] = splitTriangles(sphere, (x, y, z) => !(Math.abs(x) < GATE.halfWidth + 0.25 && y < MOUTH) && y > -0.3 && z > cz - 0.5);
  part(bone, mats.bone, 0, 0, 0);
  part(hollows, mats.obsidian, 0, 0, 0);

  // the upper teeth over the doorway, the long ones at the corners of the mouth
  const teeth: THREE.BufferGeometry[] = [];
  const count = 10;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const x = (t - 0.5) * 2 * (GATE.halfWidth - 0.05);
    const ny = (MOUTH - MAW.y) / MAW.h;
    const nx = x / (MAW.w * narrow(ny));
    const fang = i === 1 || i === count - 2;
    const len = fang ? 2.1 : i === 0 || i === count - 1 ? 0.9 : 1.05 + Math.abs(t - 0.5) * 0.4;
    const r = fang ? 0.27 : 0.24;
    teeth.push(new THREE.ConeGeometry(r, len, 7).rotateX(Math.PI).translate(0, -len / 2, 0).scale(1, 1, 0.6).translate(x, MOUTH + 0.25, front(nx, ny) - 0.25));
  }
  part(merge(teeth), mats.bone, 0, 0, 0);

  // fire in its eyes, far back in the sockets
  const eyeZ = front(SOCKET.x, SOCKET.y) - SOCKET.deep * MAW.d + 0.35;
  for (const side of [-1, 1]) {
    const x = side * SOCKET.x * MAW.w;
    const y = MAW.y + SOCKET.y * MAW.h;
    part(EYE, mats.coals, x, y - 0.3, eyeZ, false);
    part(FLAME_BED, mats.flameBed, x, y - 0.5, eyeZ + 0.1, false).scale.setScalar(1.15);
  }

  // horns from its temples, out over the walls and curling up
  const horn = curvedBone(9.5, 0.85, 1.5, 0.06, 16).applyMatrix4(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 1, 0).normalize(), Math.PI));
  for (const side of [-1, 1]) {
    const m = part(horn, mats.bone, side * 0.86 * MAW.w, MAW.y + 0.2 * MAW.h, front(0.86, 0.2) - 0.6);
    m.rotation.y = side > 0 ? -0.35 : Math.PI + 0.35;
  }
  k.group.add(g);
  // lit from below, out of the doorway
  k.light(0x5aff8a, 34, 15, 0, 4.5, -c.extent + 1.8);
}

/** A glowing coal for an eye. */
const EYE = new THREE.SphereGeometry(0.62, 16, 10).scale(1, 0.8, 0.6);

/**
 * Splits an indexed mesh's triangles whose middles pass a test (the rest are
 * dropped) into those dark on average (its `dark` attribute over 0.5) and the
 * rest, each unindexed.
 */
function splitTriangles(geo: THREE.BufferGeometry, keep: (x: number, y: number, z: number) => boolean): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const index = geo.index!.array;
  const pos = (geo.attributes.position as THREE.BufferAttribute).array;
  const nor = (geo.attributes.normal as THREE.BufferAttribute).array;
  const dark = (geo.attributes.dark as THREE.BufferAttribute).array;
  const out = [0, 1].map(() => ({ p: new Float32Array(index.length * 3), n: new Float32Array(index.length * 3), at: 0 }));
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t]!;
    const b = index[t + 1]!;
    const c = index[t + 2]!;
    const x = (pos[a * 3]! + pos[b * 3]! + pos[c * 3]!) / 3;
    const y = (pos[a * 3 + 1]! + pos[b * 3 + 1]! + pos[c * 3 + 1]!) / 3;
    const z = (pos[a * 3 + 2]! + pos[b * 3 + 2]! + pos[c * 3 + 2]!) / 3;
    if (!keep(x, y, z)) continue;
    const o = out[dark[a]! + dark[b]! + dark[c]! > 1.5 ? 0 : 1]!;
    for (const v of [a, b, c]) {
      o.p.set(pos.subarray(v * 3, v * 3 + 3), o.at);
      o.n.set(nor.subarray(v * 3, v * 3 + 3), o.at);
      o.at += 3;
    }
  }
  return out.map(({ p, n, at }) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.slice(0, at), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(n.slice(0, at), 3));
    return g;
  }) as [THREE.BufferGeometry, THREE.BufferGeometry];
}

/** A pyramid of skulls on a black plinth, each looking out from its face of the heap, the topmost with fire in its eyes. */
function skullPyramid(k: KitBuild, s: WallSpot): void {
  const { mats, random } = k;
  const { g, part } = setPiece();
  part(chippedBlock(3.8, 0.8, 3.8, 7700 + Math.round(s.a * 100), 0.04), mats.obsidian, 0, 0.4, 0);
  const skulls: THREE.BufferGeometry[] = [];
  const sockets: THREE.BufferGeometry[] = [];
  const r = 0.27;
  const step = 0.62;
  let y = 0.8 + r;
  for (let layer = 0; layer < 4; layer++, y += 0.5) {
    const n = 5 - layer;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // only the outside of the heap shows
        if (i > 0 && i < n - 1 && j > 0 && j < n - 1) continue;
        const x = (i - (n - 1) / 2) * step + (random() - 0.5) * 0.06;
        const z = (j - (n - 1) / 2) * step + (random() - 0.5) * 0.06;
        const turn = Math.atan2(x, z) + (random() - 0.5) * 0.4;
        const sr = r * (0.9 + random() * 0.2);
        skulls.push(skull(sr).rotateY(turn).translate(x, y, z));
        sockets.push(SOCKETS.clone().scale(sr, sr, sr).rotateY(turn).translate(x, y, z));
      }
    }
  }
  const top = 0.44;
  y += top - r - 0.05;
  part(merge(skulls), mats.bone, 0, 0, 0);
  part(merge(sockets), mats.obsidian, 0, 0, 0, false);
  part(skull(top), mats.bone, 0, y, 0);
  part(SOCKETS.clone().scale(top, top, top), mats.coals, 0, y, 0, false);
  standAt(k, g, s, 0.4);
}
