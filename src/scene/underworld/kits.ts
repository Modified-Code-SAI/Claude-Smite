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
  light(color: number, intensity: number, distance: number, x: number, y: number, z: number): THREE.PointLight;
  /** Makes a light beat like a heart: a strong pulse and a softer one, then a rest. */
  beat(light: THREE.PointLight): void;
  /** Turns a part (left out of the dressing's bake) about an axis of its own, `speed` radians a second. */
  spin(part: THREE.Object3D, axis: THREE.Vector3, speed: number): void;
}

/** A chamber's dressing for one depth: its columns, the vessels of its fires, and what lines its walls. */
export type Kit = (k: KitBuild) => void;

/** Height of the flame over each brazier spot, the same in every depth (the fires belong to the chamber, not its dressing). */
export const FLAME_Y = 1.5;

/** The floor plans with a landmark of their own, by their place in CHAMBERS (the Burning Pit is known by its pit). */
const PLAN = { hall: 0, nave: 1, crossroads: 2, sanctums: 4 } as const;

/** Whether a pier is one of the Twin Sanctums' two hearts (the broad ones in the middle of each), where each depth sets its own shrine. */
const shrineAt = (index: number, r: number): boolean => index === PLAN.sanctums && r > 1.3;

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
  const nave = index === PLAN.nave;
  for (const [x, z, r] of c.pillars) {
    if (shrineAt(index, r)) {
      flameAltar(k, x, z);
      continue;
    }
    // the nave's piers all one height, for the arches sprung between them
    const tall = 9 + random() * 3;
    const h = nave ? NAVE_PIER : tall;
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
  if (c.pit) chainedHeart(k);
  if (nave) forgeArches(k);
  if (index === PLAN.hall) hangingAnvil(k);
  if (index === PLAN.crossroads) burningCrown(k);
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

/**
 * A great chain slung from `a` to `b` (both in the chamber's frame), sagging
 * `sag` m at its middle, its links `scale` times a hanging chain's.
 */
function slackChain(a: THREE.Vector3, b: THREE.Vector3, sag: number, scale: number): THREE.BufferGeometry {
  const link = chainLink().scale(scale, scale, scale);
  // a quadratic curve's middle is a quarter of the way to its control point
  const ctrl = a.clone().add(b).multiplyScalar(0.5);
  ctrl.y -= sag * 2;
  const curve = new THREE.QuadraticBezierCurve3(a, ctrl, b);
  const n = Math.ceil(curve.getLength() / (LINK * scale));
  const up = new THREE.Vector3(0, 1, 0);
  const quarter = new THREE.Quaternion().setFromAxisAngle(up, Math.PI / 2);
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    q.setFromUnitVectors(up, curve.getTangentAt(u));
    // every other link turned a quarter about the chain
    if (i % 2) q.multiply(quarter);
    parts.push(link.clone().applyMatrix4(m.compose(curve.getPointAt(u), q, one)));
  }
  return merge(parts);
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
// The Ashen Depths' landmark: the Burning Pit's chained heart

/**
 * A heart of molten metal held in an iron cage halfway up a basalt spire
 * that rises out of the lava, bound to the four piers round the pit by great
 * chains slung over the floor.
 */
function chainedHeart(k: KitBuild): void {
  const { c, mats, add } = k;
  const y = 5.9;
  const crag = add(boulder(1, 9000, 3), mats.forgeStone, 0, -1.4, 0);
  crag.scale.set(3.4, 2.6, 3.1);
  add(spire(1.7, 16, 9010), mats.forgeStone, 0, -1, 0);
  const heart = add(HEART, mats.molten, 0, y, 0, false);
  heart.rotation.set(0.25, 0.6, -0.2);
  heart.scale.setScalar(1.25);
  add(HEART_CAGE, mats.iron, 0, y, 0);
  for (const b of [y - 2.6, y + 2.4, 12.4]) add(band(1.55 - (b - y) * 0.05, 0.4, 0.1), mats.iron, 0, b, 0).rotation.y = b;
  // chains out to the inner face of each pier
  for (const [x, z, r] of c.pillars) {
    const d = Math.hypot(x, z);
    const from = new THREE.Vector3((x / d) * 1.7, y + 0.3, (z / d) * 1.7);
    const to = new THREE.Vector3(x - (x / d) * (r + 0.4), 8, z - (z / d) * (r + 0.4));
    add(slackChain(from, to, 1.3, 2.3), mats.iron, 0, 0, 0);
  }
  k.beat(k.light(0xff7a2a, 55, 18, 0, y, 0));
}

/** A jagged eight-sided spire tapering from `r` at its foot to a point `h` up. */
function spire(r: number, h: number, seed: number): THREE.BufferGeometry {
  const n = simplex2(seed);
  const pts: [number, number][] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    pts.push([r * (1 - t * 0.85) * (1 + n(t * 6, 0) * 0.12), t * h]);
  }
  pts.push([0, h + 0.4]);
  const geo = new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 8);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  // a twist up its length, so its faces catch the light unevenly
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const a = (y / h) * 0.6;
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setX(i, x * Math.cos(a) - z * Math.sin(a));
    pos.setZ(i, x * Math.sin(a) + z * Math.cos(a));
  }
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

/**
 * The heart: two lobes at its top, narrowing to a point turned aside below,
 * and the stumps of its great vessels rising out of it.
 */
const HEART = (() => {
  const body = new THREE.SphereGeometry(1.25, 28, 18);
  const pos = body.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i) / 1.25;
    let z = pos.getZ(i);
    if (y < 0) {
      // narrowing to the apex, which leans aside
      const t = 1 + y * 0.55;
      x = x * t - y * y * 0.35;
      z *= t;
    }
    // the cleft between the two lobes
    if (y > 0) y -= Math.exp(-((x / 0.4) ** 2)) * y * y * 0.28;
    pos.setXYZ(i, x * 1.05, y * 1.4, z * 0.9);
  }
  body.computeVertexNormals();
  const vessel = (r: number, len: number, x: number, z: number, lean: number) =>
    new THREE.CylinderGeometry(r * 0.9, r, len, 12, 1, true).translate(0, len / 2, 0).rotateZ(lean).translate(x, 0.75, z);
  // the great arch rising over the top and turning down behind
  const arch = new THREE.TorusGeometry(0.55, 0.3, 10, 18, Math.PI * 1.1).rotateY(Math.PI / 2).translate(0.05, 1.15, -0.35);
  // kept with its uvs, which the molten metal flows along
  const geo = mergeGeometries([body, vessel(0.32, 0.9, -0.45, 0.25, 0.3), vessel(0.24, 0.8, 0.55, 0.3, -0.35), arch], false);
  if (!geo) throw new Error('heart merge failed');
  return geo;
})();
/** Ribs of iron gripping the heart, belted round its middle. */
const HEART_CAGE = merge([
  ...[0, 1, 2, 3, 4, 5].map((i) => new THREE.TorusGeometry(1.85, 0.09, 5, 20, Math.PI).rotateZ(Math.PI / 2).scale(1, 1.3, 1).rotateY((i / 6) * Math.PI * 2)),
  new THREE.TorusGeometry(1.86, 0.12, 5, 28).rotateX(Math.PI / 2),
]);

// ---------------------------------------------------------------------------
// The Ashen Depths' landmark: the Long Descent's arches

/** How tall the nave's piers stand (to the top of their capitals), where its arches spring. */
const NAVE_PIER = 6.4;
/** Half the width of a pier's capital, where an arch springs from its top. */
const CAPITAL = 1.24;

/**
 * Round arches of basalt sprung from pier to pier, across the nave and down
 * each side of it, so the way on runs under a vault of open arches; a
 * keystone of glowing slag at each crown, and from those over the middle of
 * the nave, a fire basket hung on a chain.
 */
function forgeArches(k: KitBuild): void {
  const { c, mats, add } = k;
  const piers = c.pillars;
  const parts: THREE.BufferGeometry[] = [];
  const keys: THREE.BufferGeometry[] = [];
  for (const [ax, az] of piers) {
    for (const [bx, bz] of piers) {
      const across = az === bz && ax < bx;
      const along = ax === bx && bz > az && bz - az < 13;
      if (!across && !along) continue;
      arch(parts, keys, new THREE.Vector3(ax, NAVE_PIER, az), new THREE.Vector3(bx, NAVE_PIER, bz), 9300 + Math.round(ax * 3 + az * 7));
      if (!across) continue;
      // a fire basket hung under the keystone, over the middle of the nave
      const r = (bx - ax) / 2 - CAPITAL;
      const crown = NAVE_PIER + r;
      const top = crown - 3.2;
      chain(k, chainLink(), 0, az, top + 0.2, crown + 0.1);
      add(HUNG_BASKET, mats.iron, 0, top, az);
      add(COALS, mats.coals, 0, top - 0.12, az, false);
      add(FLAME_BED, mats.flameBed, 0, top - 0.1, az, false).scale.setScalar(0.9);
      k.light(0xff7a2e, 34, 15, 0, top + 0.4, az);
    }
  }
  add(merge(parts), mats.forgeStone, 0, 0, 0);
  add(merge(keys), mats.slag, 0, 0, 0);
}

/**
 * A round arch of wedge-shaped stones from the top of the pier at `a` to the
 * top of the pier at `b`, springing from the inner edges of their capitals;
 * its stones go in `parts` and its keystone in `keys`.
 */
function arch(parts: THREE.BufferGeometry[], keys: THREE.BufferGeometry[], a: THREE.Vector3, b: THREE.Vector3, seed: number): void {
  const u = b.clone().sub(a).setY(0);
  const span = u.length() - CAPITAL * 2;
  u.normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const r = span / 2;
  const n = Math.max(9, Math.round((Math.PI * r) / 1.35) | 1);
  const thick = 1.05;
  const len = ((Math.PI * (r + thick / 2)) / n) * 0.97;
  const stone = chippedBlock(len, thick, 1.5, seed, 0.06, [4, 3, 3]);
  const key = chippedBlock(len * 1.18, thick * 1.35, 1.75, seed + 1, 0.05, [4, 3, 3]);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const th = Math.PI - ((i + 0.5) / n) * Math.PI;
    const radial = u.clone().multiplyScalar(Math.cos(th)).addScaledVector(up, Math.sin(th));
    const tangent = u.clone().multiplyScalar(-Math.sin(th)).addScaledVector(up, Math.cos(th));
    const isKey = i === (n - 1) / 2;
    const at = mid.clone().addScaledVector(radial, r + (isKey ? thick * 0.62 : thick / 2));
    m.makeBasis(tangent, radial, tangent.clone().cross(radial)).setPosition(at);
    (isKey ? keys : parts).push((isKey ? key : stone).clone().applyMatrix4(m));
  }
}

/** A fire basket for hanging: a bowl of iron bars, its rim at y 0, and a ring to hang it by. */
const HUNG_BASKET = merge([
  new THREE.TorusGeometry(0.85, 0.06, 5, 20).rotateX(Math.PI / 2),
  new THREE.TorusGeometry(0.55, 0.05, 5, 16).rotateX(Math.PI / 2).translate(0, -0.45, 0),
  new THREE.CylinderGeometry(0.3, 0.12, 0.12, 12).translate(0, -0.62, 0),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.CylinderGeometry(0.035, 0.035, 0.95, 4).rotateZ(0.42).translate(0.62, -0.32, 0).rotateY((i / 8) * Math.PI * 2)),
  ...[0, 1, 2].map((i) => new THREE.CylinderGeometry(0.025, 0.025, 1.2, 4).rotateZ(-0.6).translate(0.36, 0.5, 0).rotateY((i / 3) * Math.PI * 2)),
]);

// ---------------------------------------------------------------------------
// The Ashen Depths' landmark: the Hall of Ash's titan's anvil

/** How high the titan's anvil hangs over the hall (its foot). */
const ANVIL_Y = 7.0;

/**
 * A titan's anvil hung over the middle of the hall: a great chain up into
 * the dark, four slung out to the piers, its face still glowing from the
 * last blow and molten metal dripping off its horn into a puddle below.
 */
function hangingAnvil(k: KitBuild): void {
  const { c, mats, add } = k;
  // side on to the way in, its horn toward the east
  const turn = 0.12;
  const at = new THREE.Matrix4().makeRotationY(turn).setPosition(0, ANVIL_Y, 0);
  add(TITAN_ANVIL.clone().applyMatrix4(at), mats.iron, 0, 0, 0);
  add(TITAN_ANVIL_FACE.clone().applyMatrix4(at), mats.slag, 0, 0, 0, false);
  // chains: from the four corners of its foot out to the piers, and from its waist straight up
  const corners = [[-1.9, -1.2], [1.9, -1.2], [1.9, 1.2], [-1.9, 1.2]].map(([x, z]) => new THREE.Vector3(x, 0.45, z).applyMatrix4(at));
  for (const [x, z, r] of c.pillars) {
    const d = Math.hypot(x, z);
    const near = corners.reduce((a, b) => (a.distanceToSquared(new THREE.Vector3(x, ANVIL_Y, z)) < b.distanceToSquared(new THREE.Vector3(x, ANVIL_Y, z)) ? a : b));
    add(slackChain(near, new THREE.Vector3(x - (x / d) * (r + 0.5), 8.7, z - (z / d) * (r + 0.5)), 0.5, 1.8), mats.iron, 0, 0, 0, false);
  }
  for (const side of [-1, 1]) {
    const p = new THREE.Vector3(side * 0.9, 3.3, 0).applyMatrix4(at);
    chain(k, chainLink().scale(2, 2, 2), p.x, p.z, p.y, 26);
  }
  // molten metal gathering in a drip under the horn's tip, and the puddle its drops have made
  const tipAt = new THREE.Vector3(5.45, 2.3, 0).applyMatrix4(at);
  add(MOLTEN_DRIP, mats.molten, tipAt.x, tipAt.y, tipAt.z, false);
  add(new THREE.CircleGeometry(1.1, 28).rotateX(-Math.PI / 2).scale(1, 1, 0.75), mats.molten, tipAt.x, 0.03, tipAt.z, false);
  k.light(0xff7a2e, 42, 16, 0, ANVIL_Y + 1.2, 3.2);
  k.light(0xff8a3a, 16, 7, tipAt.x, 0.9, tipAt.z);
}

/** A titan's anvil, long in x with its horn toward +x: feet, a waist, its body, the heel and the horn (its foot at y 0, its face at 3.2). */
const TITAN_ANVIL = merge([
  chippedBlock(4.4, 0.65, 2.9, 9720, 0.04).translate(0, 0.33, 0),
  chippedBlock(3.6, 0.35, 2.3, 9721, 0.04).translate(0, 0.8, 0),
  chippedBlock(2.3, 1.1, 1.5, 9722, 0.05).translate(0, 1.5, 0),
  chippedBlock(4.8, 1.2, 2.2, 9723, 0.04).translate(0, 2.6, 0),
  chippedBlock(0.95, 0.85, 1.7, 9724, 0.04).translate(-2.85, 2.75, 0),
  // the horn, tapering out and dipping a little
  lathe([[0, 0], [0.62, 0], [0.55, 0.9], [0.42, 1.8], [0.26, 2.6], [0.1, 3.1], [0, 3.2]], 16).rotateZ(-Math.PI / 2 - 0.06).translate(2.35, 2.62, 0),
]);
/** A drop of molten metal swelling as it hangs, its top at y 0. */
const MOLTEN_DRIP = lathe([[0, 0.05], [0.12, 0], [0.1, -0.35], [0.16, -0.7], [0.2, -0.85], [0.15, -1.0], [0, -1.04]], 12);
/** The anvil's face, still glowing. */
const TITAN_ANVIL_FACE = chippedBlock(4.5, 0.08, 1.95, 9725, 0.02).translate(-0.05, 3.22, 0);

// ---------------------------------------------------------------------------
// The Ashen Depths' landmark: the Crossroads' burning crown

/** How high the burning crown hangs (the foot of its band), and its radius. */
const CROWN = { y: 6.7, r: 3.0 } as const;

/**
 * A colossal iron crown hung over the crossing, slung on chains to the four
 * piers and held up into the dark, glowing stones set round its band and a
 * fire burning in a cup on each of its eight great points.
 */
function burningCrown(k: KitBuild): void {
  const { c, mats, add } = k;
  const { y, r } = CROWN;
  add(CROWN_IRON, mats.iron, 0, y, 0);
  add(CROWN_STONES, mats.slag, 0, y, 0, false);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const top = y + CROWN_POINT + 0.28;
    add(COALS.clone().scale(0.5, 0.5, 0.5), mats.coals, Math.cos(a) * r, top - 0.05, Math.sin(a) * r, false);
    add(FLAME_BED, mats.flameBed, Math.cos(a) * r, top - 0.04, Math.sin(a) * r, false).scale.setScalar(0.5);
  }
  // chains slung out to the piers, and four up from the band to a ring, and one from there into the dark
  for (const [x, z, pr] of c.pillars) {
    const d = Math.hypot(x, z);
    const from = new THREE.Vector3((x / d) * (r + 0.1), y + 0.4, (z / d) * (r + 0.1));
    add(slackChain(from, new THREE.Vector3(x - (x / d) * (pr + 0.5), 8.7, z - (z / d) * (pr + 0.5)), 0.4, 1.6), mats.iron, 0, 0, 0, false);
  }
  const ring = new THREE.Vector3(0, y + 8, 0);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
    add(slackChain(new THREE.Vector3(Math.cos(a) * (r - 0.1), y + 1.0, Math.sin(a) * (r - 0.1)), ring, 0.03, 1.1), mats.iron, 0, 0, 0, false);
  }
  chain(k, chainLink().scale(1.6, 1.6, 1.6), 0, 0, ring.y, 26);
  k.light(0xff8a3a, 44, 17, 0, y + 1.6, 0);
}

/** How tall the crown's great points rise over its band. */
const CROWN_POINT = 2.4;

/** The crown's iron: a thick band with a rim top and bottom, eight great points each with a cup, eight lesser between. */
const CROWN_IRON = (() => {
  const { r } = CROWN;
  const parts: THREE.BufferGeometry[] = [
    lathe([[r - 0.16, 0], [r + 0.1, 0], [r + 0.14, 0.12], [r + 0.14, 1.0], [r + 0.1, 1.12], [r - 0.16, 1.12], [r - 0.16, 0]], 48),
    new THREE.TorusGeometry(r + 0.16, 0.09, 6, 48).rotateX(Math.PI / 2).translate(0, 0.08, 0),
    new THREE.TorusGeometry(r + 0.16, 0.09, 6, 48).rotateX(Math.PI / 2).translate(0, 1.06, 0),
  ];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const great = i % 2 === 0;
    const h = great ? CROWN_POINT : 1.1;
    const point = new THREE.ConeGeometry(great ? 0.42 : 0.3, h, 5).translate(0, 1.1 + h / 2, 0);
    // leaning out a little, as a crown's points do
    point.applyMatrix4(new THREE.Matrix4().makeRotationZ(-0.12).setPosition(r, 0, 0));
    point.rotateY(-a);
    parts.push(point);
    if (great) parts.push(lathe([[0, 0], [0.1, 0], [0.32, 0.18], [0.36, 0.3], [0.3, 0.28], [0, 0.14]], 10).translate(r + 0.29, 1.1 + h - 0.06, 0).rotateY(-a));
  }
  return merge(parts);
})();
/** Glowing stones set round the band, between the great points. */
const CROWN_STONES = merge(
  Array.from({ length: 8 }, (_, i) => {
    const a = ((i + 0.5) / 8) * Math.PI * 2;
    return boulder(0.26, 9960 + i, 2).scale(1, 1.3, 0.55).translate(CROWN.r + 0.15, 0.56, 0).rotateY(-a);
  }),
);

// ---------------------------------------------------------------------------
// The Ashen Depths' landmark: the Twin Sanctums' altars of flame

/**
 * An altar of the forge at the heart of each sanctum: a stepped basalt
 * plinth, an iron-bound pillar and a great iron bowl on top, a tall fire
 * burning in it.
 */
function flameAltar(k: KitBuild, x: number, z: number): void {
  const { mats, add, random } = k;
  const seed = 9990 + Math.round(z);
  const turn = random() * 0.5;
  add(chippedBlock(2.9, 0.5, 2.9, seed, 0.04), mats.forgeStone, x, 0.25, z).rotation.y = turn;
  add(chippedBlock(2.4, 0.5, 2.4, seed + 1, 0.04), mats.forgeStone, x, 0.75, z).rotation.y = turn + 0.05;
  add(chippedBlock(1.7, 2.4, 1.7, seed + 2, 0.05), mats.forgeStone, x, 2.2, z).rotation.y = turn;
  for (const y of [1.45, 2.95]) add(band(1.84, 0.3, 0.07), mats.iron, x, y, z).rotation.y = turn;
  add(chippedBlock(2.3, 0.45, 2.3, seed + 3, 0.04), mats.forgeStone, x, 3.62, z).rotation.y = turn;
  add(ALTAR_BOWL, mats.iron, x, 3.85, z);
  add(COALS.clone().scale(2.6, 2.2, 2.6), mats.coals, x, 3.85 + ALTAR_FIRE - 0.15, z, false);
  for (const t of [0, Math.PI / 3]) add(FLAME_BED.clone().scale(2.1, 2.8, 2.1), mats.flameBed, x, 3.85 + ALTAR_FIRE - 0.12, z, false).rotation.y = t + turn;
  k.light(0xff8a3a, 40, 16, x, 6.2, z);
}

/** How high in the altar's bowl its fire sits. */
const ALTAR_FIRE = 0.62;
/** The altar's bowl: a wide iron basin on a short stem, its rim at ALTAR_FIRE. */
const ALTAR_BOWL = lathe([[0, 0], [0.55, 0], [0.5, 0.16], [0.7, 0.24], [1.3, 0.44], [1.55, ALTAR_FIRE + 0.02], [1.45, ALTAR_FIRE + 0.04], [1.18, 0.42], [0.5, 0.3], [0, 0.3]], 28);

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
    if (shrineAt(index, r)) return fountain(k, x, z);
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
  if (c.pit) drownedBell(k);
  if (index === PLAN.nave) weepingColossi(k, used);
  if (index === PLAN.hall) {
    hangingAnchor(k);
    drownedTomb(k, used);
  }
  if (index === PLAN.crossroads) armillary(k);
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
// The Drowned Halls' landmark: the Burning Pit's drowned bell

/**
 * A colossal bell of old bronze hanging low over the pit on four chains out
 * of the dark, the soul fire lighting it from below, its clapper hanging
 * still under its lip.
 */
function drownedBell(k: KitBuild): void {
  const { mats, add } = k;
  const y = 3.1;
  const bell = add(BELL, mats.bronze, 0, y, 0);
  bell.rotation.set(0.05, 0.3, 0.07);
  add(CLAPPER, mats.iron, 0.15, y, 0.1);
  add(new THREE.BoxGeometry(4.6, 0.55, 0.8), mats.iron, 0, y + 5.75, 0).rotation.y = 0.3;
  for (const end of [-1, 1]) {
    for (const side of [-1, 1]) {
      const along = new THREE.Vector3(end * 2.1, y + 5.9, side * 0.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.3);
      const top = new THREE.Vector3(along.x * 2.6 + side * 2, 24, along.z * 2.6 + side * 3);
      add(slackChain(along, top, 0.25, 1.7), mats.iron, 0, 0, 0, false);
    }
  }
  k.light(0x6ab8ff, 26, 14, 0, y + 7, 4);
}

/** A great bell, its lip at y 0 and its crown 5.6 m up: a thick bronze wall flaring to the lip, a dome, and a loop on top. */
const BELL = merge([
  lathe([
    [3.3, 0], [3.45, 0.25], [3.2, 0.6], [2.7, 1.4], [2.45, 2.6], [2.3, 3.8], [2.05, 4.7], [1.6, 5.3], [0.9, 5.6], [0, 5.65],
    [0, 5.35], [0.85, 5.3], [1.5, 5.0], [1.85, 4.5], [2.05, 3.7], [2.2, 2.5], [2.45, 1.3], [2.95, 0.5], [3.1, 0.12], [3.3, 0],
  ], 40),
  new THREE.TorusGeometry(2.42, 0.11, 6, 40).rotateX(Math.PI / 2).translate(0, 2.6, 0),
  new THREE.TorusGeometry(2.06, 0.1, 6, 40).rotateX(Math.PI / 2).translate(0, 4.7, 0),
  new THREE.TorusGeometry(0.55, 0.18, 8, 16).translate(0, 5.95, 0),
]);
/** The clapper's rod from the crown and its ball just under the lip. */
const CLAPPER = merge([
  new THREE.CylinderGeometry(0.12, 0.12, 5.4, 8).translate(0, 2.7, 0),
  new THREE.SphereGeometry(0.62, 16, 12).scale(1, 1.15, 1).translate(0, -0.25, 0),
]);

// ---------------------------------------------------------------------------
// The Drowned Halls' landmark: the Long Descent's weeping colossi

/**
 * Two colossal hooded mourners carved out of the rock at the far end of the
 * nave, either side of the way on, heads bowed, each holding out a bowl in
 * its hands from which a stream of water pours down into a pool at its feet.
 */
function weepingColossi(k: KitBuild, used: number[]): void {
  for (const side of [-1, 1]) {
    const s = wallAt(k.c, -Math.PI / 2 + side * 0.3);
    if (!s) continue;
    colossus(k, s, 6900 + side);
    used.push(s.a);
  }
}

/** How many times a mourner's size the colossi stand. */
const COLOSSUS = 4.2;

function colossus(k: KitBuild, s: WallSpot, seed: number): void {
  const { mats } = k;
  const { g, part } = setPiece();
  const plinth = 1.6;
  part(chippedBlock(6.4, plinth, 5.2, seed, 0.04), mats.tideStone, 0, plinth / 2, 0);
  part(chippedBlock(6.8, 0.3, 5.6, seed + 1, 0.04), mats.tideStone, 0, plinth - 0.1, 0);
  // the figure, in a mourner's own measure
  const fig = new THREE.Group();
  fig.position.y = plinth;
  fig.scale.setScalar(COLOSSUS);
  g.add(fig);
  const piece = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, cast = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = true;
    fig.add(m);
    return m;
  };
  piece(ROBE, mats.tideStone, 0, 0, 0);
  piece(SLEEVES, mats.tideStone, 0, 0, 0);
  piece(OFFERING, mats.tideStone, 0, BOWL.y, BOWL.z);
  piece(BOWL_WATER, mats.waterfall, 0, BOWL.y - 0.02, BOWL.z, false);
  const head = new THREE.Group();
  head.position.set(0, 2.3, 0.04);
  head.rotation.x = 0.5;
  fig.add(head);
  for (const [geo, mat] of [[HOOD, mats.tideStone], [FACE, mats.obsidian], [EYES, mats.coals]] as const) {
    const m = new THREE.Mesh(geo, mat);
    if (geo !== HOOD) m.position.set(0, 0.2, 0.03);
    m.castShadow = geo === HOOD;
    m.receiveShadow = true;
    head.add(m);
  }
  // the stream pouring off the bowl's lip, and the pool it falls into
  const lip = new THREE.Vector3(0, plinth + BOWL.y * COLOSSUS, (BOWL.z + 0.17) * COLOSSUS);
  for (const turn of [0, Math.PI / 2]) part(stream(lip.y), mats.waterfall, 0, 0, lip.z, false).rotation.y = turn;
  part(new THREE.CircleGeometry(2.3, 36).rotateX(-Math.PI / 2), mats.pool, 0, 0.04, lip.z, false);
  const back = 1.6;
  standAt(k, g, s, back);
  const [lx, lz] = fromSpot(s, back, 0, lip.z + 0.6);
  k.light(0x6ab8ff, 30, 15, lx, 3.4, lz);
}

/** Where a colossus holds its bowl, in a mourner's measure. */
const BOWL = { y: 1.5, z: 0.72 } as const;

/** Sleeves from the shoulders down and forward to the hands under the bowl. */
const SLEEVES = merge(
  [-1, 1].map((side) => {
    const from = new THREE.Vector3(side * 0.44, 2.08, 0.02);
    const to = new THREE.Vector3(side * 0.16, BOWL.y - 0.08, BOWL.z - 0.08);
    const len = from.distanceTo(to);
    const geo = new THREE.CylinderGeometry(0.11, 0.17, len, 12).translate(0, -len / 2, 0);
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), to.clone().sub(from).normalize())));
    return geo.translate(from.x, from.y, from.z);
  }),
);
/** A shallow bowl held in two hands, its rim at y 0. */
const OFFERING = merge([
  new THREE.SphereGeometry(0.2, 18, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).scale(1, 0.95, 1),
  new THREE.TorusGeometry(0.2, 0.022, 6, 24).rotateX(Math.PI / 2),
  new THREE.CylinderGeometry(0.07, 0.1, 0.08, 12).translate(0, -0.22, 0),
  // the hands cupped under it, fingers up its sides
  ...[-1, 1].map((side) => new THREE.SphereGeometry(0.1, 10, 8).scale(0.7, 1.3, 1.3).rotateZ(side * 0.5).translate(side * 0.18, -0.1, 0)),
]);
const BOWL_WATER = new THREE.CircleGeometry(0.18, 20).rotateX(-Math.PI / 2);

/** A stream of water `h` tall, falling from its top and spreading as it falls. */
function stream(h: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(0.5, h, 1, 16).translate(0, h / 2, 0);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = 1 - pos.getY(i) / h;
    pos.setX(i, pos.getX(i) * (1 + t * 1.6));
  }
  return geo;
}

// ---------------------------------------------------------------------------
// The Drowned Halls' landmark: the Hall of Ash's anchor and drowned king

/** How high the anchor's crown hangs over the hall. */
const ANCHOR_Y = 6.8;

/**
 * A ship's anchor out of some drowned sea, colossal and green with age, hung
 * crown-down over the middle of the hall on its own great chain, water
 * still running off its flukes.
 */
function hangingAnchor(k: KitBuild): void {
  const { mats, add } = k;
  const turn = 0.4;
  const at = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, turn, 0.06)).setPosition(0, ANCHOR_Y, 0);
  add(ANCHOR.clone().applyMatrix4(at), mats.bronze, 0, 0, 0);
  const ring = new THREE.Vector3(0, 7.55, 0).applyMatrix4(at);
  chain(k, chainLink().scale(2.4, 2.4, 2.4), ring.x, ring.z, ring.y + 0.4, 26);
  // water running off each fluke into a puddle
  for (const side of [-1, 1]) {
    const tip = new THREE.Vector3(side * 2.35, 2.35, 0).applyMatrix4(at);
    for (const t of [0, Math.PI / 2]) add(stream(tip.y).scale(0.45, 1, 1), mats.waterfall, tip.x, 0, tip.z, false).rotation.y = t + turn;
    add(new THREE.CircleGeometry(1.3, 28).rotateX(-Math.PI / 2), mats.pool, tip.x, 0.035, tip.z, false);
  }
  k.light(0x6ab8ff, 34, 15, 0, ANCHOR_Y - 1.2, 0);
}

/** A great anchor, crown down at y 0: its arms and flukes, its shank, the stock across it and the ring at its top (7.5 m). */
const ANCHOR = (() => {
  const arc = 2.3;
  const R = 2.3;
  const parts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(0.28, 0.36, 6.8, 14).translate(0, 3.5, 0),
    new THREE.SphereGeometry(0.5, 16, 12).translate(0, 0.3, 0),
    new THREE.TorusGeometry(R, 0.27, 10, 32, arc).rotateZ(-Math.PI / 2 - arc / 2).translate(0, R + 0.1, 0),
    // the stock across the shank, square to the arms
    new THREE.CylinderGeometry(0.2, 0.2, 4.8, 10).rotateX(Math.PI / 2).translate(0, 6.3, 0),
    ...[-1, 1].map((side) => new THREE.SphereGeometry(0.3, 12, 8).translate(0, 6.3, side * 2.4)),
    new THREE.TorusGeometry(0.62, 0.15, 8, 20).translate(0, 7.55, 0),
  ];
  // the flukes: broad spade blades at the arms' tips, pointing up and out
  for (const side of [-1, 1]) {
    const a = -Math.PI / 2 + (side * arc) / 2;
    const x = Math.cos(a) * R;
    const y = Math.sin(a) * R + R + 0.1;
    parts.push(new THREE.ConeGeometry(0.75, 1.5, 4).scale(1, 1, 0.3).rotateZ(-side * 0.75).translate(x + side * 0.2, y + 0.35, 0));
  }
  return merge(parts);
})();

/**
 * The tomb of a drowned king against the wall: a stepped dais, his coffin on
 * it under a bronze lid on which he lies in effigy, a sword on his breast;
 * a great stele behind, and soul fire burning in a font at each corner.
 */
function drownedTomb(k: KitBuild, used: number[]): void {
  const { mats } = k;
  const s = wallAt(k.c, (335 * Math.PI) / 180);
  if (!s) return;
  used.push(s.a);
  const { g, part } = setPiece();
  const seed = 9800;
  const z = 1.5;
  // the stele against the rock, a bronze disc set in it
  part(chippedBlock(5.4, 7.2, 0.9, seed, 0.04), mats.tideStone, 0, 3.6, -0.7);
  part(chippedBlock(6.0, 0.6, 1.2, seed + 1, 0.04), mats.tideStone, 0, 7.4, -0.7);
  part(new THREE.CylinderGeometry(1.15, 1.15, 0.14, 32).rotateX(Math.PI / 2), mats.verdigris, 0, 4.9, -0.2);
  part(new THREE.TorusGeometry(1.15, 0.08, 6, 32), mats.bronze, 0, 4.9, -0.13);
  part(new THREE.TorusGeometry(1.45, 0.07, 6, 40), mats.coals, 0, 4.9, -0.22, false);
  part(new THREE.TorusGeometry(0.55, 0.05, 6, 28), mats.coals, 0, 4.9, -0.1, false);
  // the dais, two steps
  part(chippedBlock(7.0, 0.45, 4.6, seed + 2, 0.03), mats.tideStone, 0, 0.225, z);
  part(chippedBlock(6.0, 0.45, 3.6, seed + 3, 0.03), mats.tideStone, 0, 0.675, z);
  // the coffin, banded in bronze
  const top = 0.9 + 1.3;
  part(chippedBlock(4.3, 1.3, 1.8, seed + 4, 0.03), mats.tideStone, 0, 0.9 + 0.65, z);
  for (const x of [-1.6, 1.6]) part(new THREE.BoxGeometry(0.2, 1.34, 1.86), mats.verdigris, x, 0.9 + 0.65, z, false);
  part(chippedBlock(4.55, 0.24, 2.05, seed + 5, 0.02), mats.bronze, 0, top + 0.12, z);
  // the king in effigy, his head toward +x, the sword on his breast
  part(EFFIGY, mats.bronze, -1.95, top + 0.62, z);
  part(EFFIGY_SWORD, mats.gold, -1.95, top + 0.62, z);
  // soul fire in a font at each corner of the dais
  for (const x of [-2.6, 2.6]) {
    for (const dz of [-1.4, 1.4]) {
      part(FONT.clone().scale(0.55, 0.55, 0.55), mats.tideStone, x, 0.9, z + dz);
      part(COALS.clone().scale(0.55, 0.55, 0.55), mats.coals, x, 0.9 + (FLAME_Y - 0.13) * 0.55, z + dz, false);
      part(FLAME_BED.clone().scale(0.55, 0.7, 0.55), mats.flameBed, x, 0.9 + (FLAME_Y - 0.12) * 0.55, z + dz, false);
    }
  }
  const back = 0.6;
  standAt(k, g, s, back);
  const [lx, lz] = fromSpot(s, back, 0, z + 3.2);
  k.light(0x6ab8ff, 30, 14, lx, 3.0, lz);
}

/** A mourner's robe and hood laid on their back, head toward +x, 1.3 times a mourner's size. */
const EFFIGY = (() => {
  // the robe's height along x, its front up
  const lie = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)).scale(new THREE.Vector3(1.3, 1.3, 1.3));
  return merge([
    ROBE.clone().applyMatrix4(lie),
    HOOD.clone().translate(0, 2.3, 0.02).applyMatrix4(lie),
    FACE.clone().translate(0, 2.5, 0.05).applyMatrix4(lie),
    // hands folded on the hilt
    new THREE.SphereGeometry(0.12, 10, 8).scale(1.4, 0.8, 1).translate(0, 1.85, 0.42).applyMatrix4(lie),
  ]);
})();
/** The effigy's sword, its hilt under his hands and its blade down to his feet. */
const EFFIGY_SWORD = merge([SWORD_BLADE, SWORD_HILT]).scale(1.25, 1.25, 1.25).applyMatrix4(
  new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)),
).translate(1.3 * 1.95, 1.3 * 0.47, 0);

// ---------------------------------------------------------------------------
// The Drowned Halls' landmark: the Crossroads' armillary

/** How high the armillary's middle hangs. */
const ARMILLARY_Y = 9.2;

/**
 * A great armillary sphere of old bronze hung over the crossing: a meridian
 * and a horizon ring holding a tilted axle, a cage of rings turning slowly
 * about it and the band of the heavens turning the other way, a ball of soul
 * light at its heart.
 */
function armillary(k: KitBuild): void {
  const { mats, add } = k;
  const y = ARMILLARY_Y;
  add(ARMILLARY_FRAME, mats.bronze, 0, y, 0);
  add(ORB, mats.coals, 0, y, 0, false).scale.setScalar(2.6);
  chain(k, chainLink().scale(1.5, 1.5, 1.5), 0, 0, y + 3.62, 26);
  // the cage turns about the axle, the band of the heavens about its own tilt
  const cage = new THREE.Mesh(ARMILLARY_CAGE, mats.verdigris);
  cage.position.set(0, y, 0);
  cage.rotation.z = AXLE_TILT;
  const band = new THREE.Mesh(ARMILLARY_BAND, mats.bronze);
  band.position.set(0, y, 0);
  band.rotation.set(0.42, 0, -0.2);
  for (const m of [cage, band]) {
    m.castShadow = true;
    m.receiveShadow = true;
    k.group.add(m);
  }
  const up = new THREE.Vector3(0, 1, 0);
  k.spin(cage, up, 0.16);
  k.spin(band, up, -0.1);
  k.light(0x6ab8ff, 36, 16, 0, y - 1.2, 0);
}

/** How far the armillary's axle leans from upright. */
const AXLE_TILT = 0.41;

/** The fixed frame: the meridian (upright), the horizon ring, the axle through them and the knobs at its ends. */
const ARMILLARY_FRAME = (() => {
  const axle = new THREE.Matrix4().makeRotationZ(AXLE_TILT);
  return merge([
    new THREE.TorusGeometry(3.5, 0.13, 8, 64),
    new THREE.TorusGeometry(3.5, 0.11, 8, 64).rotateX(Math.PI / 2),
    new THREE.CylinderGeometry(0.07, 0.07, 7.4, 8).applyMatrix4(axle),
    ...[-1, 1].map((end) => new THREE.SphereGeometry(0.2, 12, 8).translate(0, end * 3.7, 0).applyMatrix4(axle)),
    ...[0, 1, 2, 3].map((i) => new THREE.SphereGeometry(0.16, 10, 6).translate(3.5, 0, 0).rotateY((i / 4) * Math.PI * 2 + Math.PI / 4)),
    new THREE.TorusGeometry(0.3, 0.08, 6, 14).rotateY(Math.PI / 2).translate(0, 3.66, 0),
  ]);
})();
/** The turning cage: two rings crossing at the poles on y and one round its equator. */
const ARMILLARY_CAGE = merge([
  new THREE.TorusGeometry(2.95, 0.09, 6, 56),
  new THREE.TorusGeometry(2.95, 0.09, 6, 56).rotateY(Math.PI / 2),
  new THREE.TorusGeometry(2.95, 0.08, 6, 56).rotateX(Math.PI / 2),
  ...[-1, 1].map((end) => new THREE.TorusGeometry(0.5, 0.06, 6, 20).rotateX(Math.PI / 2).translate(0, end * 2.55, 0)),
]);
/** The band of the heavens: a broad ring studded round its face. */
const ARMILLARY_BAND = merge([
  lathe([[2.3, -0.28], [2.46, -0.28], [2.5, -0.2], [2.5, 0.2], [2.46, 0.28], [2.3, 0.28], [2.3, -0.28]], 56),
  ...Array.from({ length: 12 }, (_, i) => new THREE.SphereGeometry(0.09, 8, 6).scale(1, 1, 0.5).translate(0, 0, 2.52).rotateY((i / 12) * Math.PI * 2)),
]);

// ---------------------------------------------------------------------------
// The Drowned Halls' landmark: the Twin Sanctums' fountains

/**
 * A fountain at the heart of each sanctum: a broad basin, a fluted column
 * rising from it to a bowl held high, an urn in the bowl, and the water
 * spilling over the bowl's lip in four streams into the basin below.
 */
function fountain(k: KitBuild, x: number, z: number): void {
  const { mats, add } = k;
  add(FOUNTAIN_BASIN, mats.tideStone, x, 0, z);
  add(new THREE.CircleGeometry(1.6, 36).rotateX(-Math.PI / 2), mats.pool, x, 0.56, z, false);
  add(flutedShaft(0.42, 3.0, 16, 60, 9), mats.tideStone, x, 0.6, z);
  add(FOUNTAIN_BOWL, mats.tideStone, x, 3.55, z);
  add(new THREE.CircleGeometry(1.08, 28).rotateX(-Math.PI / 2), mats.pool, x, 3.55 + 0.36, z, false);
  add(FOUNTAIN_RIM, mats.verdigris, x, 3.55, z, false);
  add(urn(0.42, 1.2), mats.verdigris, x, 3.55 + 0.3, z);
  // four streams off the lip into the basin
  const fall = 3.55 + 0.42 - 0.56;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const sx = x + Math.cos(a) * 1.22;
    const sz = z + Math.sin(a) * 1.22;
    for (const t of [0, Math.PI / 2]) add(stream(fall).scale(0.5, 1, 1), mats.waterfall, sx, 0.56, sz, false).rotation.y = t - a;
  }
  k.light(0x6ab8ff, 22, 11, x, 2.2, z + (z > 0 ? 2 : -2));
}

/** The fountain's basin: a broad round lip 0.6 m high round the water. */
const FOUNTAIN_BASIN = lathe([[0, 0], [1.9, 0], [1.95, 0.08], [1.88, 0.5], [1.98, 0.6], [1.86, 0.66], [1.66, 0.62], [1.62, 0.5], [0, 0.5]], 40);
/** The fountain's raised bowl, its lip at 0.42. */
const FOUNTAIN_BOWL = lathe([[0, 0], [0.5, 0], [0.62, 0.08], [1.0, 0.2], [1.22, 0.36], [1.24, 0.44], [1.12, 0.42], [0.9, 0.3], [0, 0.3]], 32);
const FOUNTAIN_RIM = new THREE.TorusGeometry(1.2, 0.04, 6, 32).rotateX(Math.PI / 2).translate(0, 0.43, 0);

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
    if (shrineAt(index, r)) return skullObelisk(k, x, z);
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
    // (the nave is already inside a ribcage)
    if (spot && index !== PLAN.nave) {
      ribcage(k, spot);
      used.push(spot.a);
    }
  }
  if (c.boss) court(k, used);
  if (c.pit) reachingHand(k);
  if (index === PLAN.nave) leviathan(k);
  if (index === PLAN.hall) boneChandelier(k);
  if (index === PLAN.crossroads) coiledSerpent(k);
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
// The Abyss's landmark: the Burning Pit's reaching hand

/**
 * The bones of a colossal hand and forearm reaching up out of the pit, the
 * wrist bent back so its palm turns up toward the way in, its fingers curled
 * round a ball of spirit fire.
 */
function reachingHand(k: KitBuild): void {
  const { mats, add } = k;
  const parts: THREE.BufferGeometry[] = [];
  // the arm leans a little toward the way on
  const arm = new THREE.Matrix4().makeTranslation(0.6, -5.4, 0.8).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-0.12, 0, 0.1)));
  // the forearm's two bones, crossing a little
  for (const side of [-1, 1]) {
    const bone = ARM_BONE.clone().applyMatrix4(new THREE.Matrix4().makeRotationZ(side * 0.04)).translate(side * 0.62, 0, 0);
    parts.push(bone.applyMatrix4(arm));
  }
  // the wrist: two rows of knucklebones, then the hand bent back at it
  const wrist = arm.clone().multiply(new THREE.Matrix4().makeTranslation(0, 9.1, 0));
  for (let i = 0; i < 8; i++) {
    const g = boulder(0.36 + (i % 3) * 0.06, 9100 + i, 1).translate(-1.05 + (i % 4) * 0.7, Math.floor(i / 4) * 0.62, ((i * 37) % 5) * 0.06);
    parts.push(g.applyMatrix4(wrist));
  }
  const hand = wrist.clone().multiply(new THREE.Matrix4().makeTranslation(0, 1.1, 0)).multiply(new THREE.Matrix4().makeRotationX(-1.0));
  const x = new THREE.Matrix4();
  // each joint curls the next bone in toward the palm (and `across`, sideways over it)
  const finger = (base: THREE.Matrix4, lengths: readonly number[], r: number, curls: readonly number[], across = 0) => {
    const m = base.clone();
    lengths.forEach((len, i) => {
      parts.push(phalanx(len, r).applyMatrix4(m));
      m.multiply(x.makeTranslation(0, len, 0)).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(curls[i]!, 0, across)));
      r *= 0.84;
    });
  };
  // four fingers fanning from the palm (a long bone in the palm, then three joints each)
  [-1.5, -0.5, 0.5, 1.5].forEach((across, i) => {
    const base = hand.clone().multiply(new THREE.Matrix4().makeTranslation(across * 0.62, 0, 0)).multiply(new THREE.Matrix4().makeRotationZ(-across * 0.1));
    const long = [3.4, 3.7, 3.5, 3.0][i]!;
    finger(base, [long, 2.1 - Math.abs(across) * 0.25, 1.4, 1.0], 0.3, [0.45, 0.6, 0.55, 0]);
  });
  // the thumb, out from the side and curling back across the palm
  const thumb = hand.clone().multiply(new THREE.Matrix4().makeTranslation(1.2, -0.3, 0.35)).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.55, 0, -0.75)));
  finger(thumb, [1.9, 1.5, 1.0], 0.34, [0.35, 0.4, 0], 0.5);
  add(merge(parts), mats.bone, 0, 0, 0);
  // the fire it holds
  const fire = new THREE.Vector3(0, 3.6, 1.6).applyMatrix4(hand);
  add(EYE, mats.coals, fire.x, fire.y, fire.z, false).scale.setScalar(1.5);
  add(FLAME_BED, mats.flameBed, fire.x, fire.y - 0.6, fire.z, false).scale.setScalar(2.2);
  k.light(0x5aff8a, 50, 18, fire.x, fire.y + 0.5, fire.z);
}

/** One of the forearm's bones, 9 m from below the lava to the wrist. */
const ARM_BONE = lathe([
  [0, 0], [0.55, 0], [0.5, 2], [0.42, 5], [0.48, 7.6], [0.68, 8.5], [0.72, 8.9], [0.5, 9.2], [0, 9.25],
], 14);

/** A finger bone `len` long up y from a knuckle at its foot. */
function phalanx(len: number, r: number): THREE.BufferGeometry {
  return lathe([
    [0, -0.05], [r * 1.25, 0], [r * 1.3, len * 0.12], [r * 0.85, len * 0.3], [r * 0.8, len * 0.7], [r * 1.15, len * 0.9], [r, len], [0, len + 0.05],
  ], 10);
}

// ---------------------------------------------------------------------------
// The Abyss's landmark: the Long Descent's leviathan

/** How high the leviathan's spine runs along the nave. */
const KEEL = 15.4;

/**
 * The bones of a leviathan the nave was dug through: its spine runs the
 * length of the hall high overhead, and its ribs arch down out of the dark
 * on either side to plunge into the rock at the foot of the walls, so the
 * way on runs through its ribcage.
 */
function leviathan(k: KitBuild): void {
  const { c, mats, random, add } = k;
  const parts: THREE.BufferGeometry[] = [];
  const length = (c.extent + 3) * 2;
  parts.push(spine(0.85, length, 9500).rotateX(Math.PI / 2).translate(0, KEEL, -length / 2));
  // the straight sides of the nave, then the rounded ends (the nave is a capsule)
  const straight = 17;
  const radius = 12;
  for (let z = -19.5; z <= 19.5; z += 3) {
    const out = Math.abs(z) <= straight ? radius : Math.sqrt(radius * radius - (Math.abs(z) - straight) ** 2);
    for (const side of [-1, 1]) {
      // a circular arc leaving the spine level and meeting the rock at (out + 1.3, 2.4)
      const dx = out + 1.3 - 0.75;
      const dy = KEEL - 2.4;
      const curl = 2 * Math.atan2(dy, dx) * (0.97 + random() * 0.06);
      const len = (dx / Math.sin(curl)) * curl;
      const rib = curvedBone(len, 0.5, curl, 0.42, 20).rotateZ(-Math.PI / 2).translate(0.75, 0, 0);
      if (side < 0) rib.rotateY(Math.PI);
      parts.push(rib.translate(0, KEEL, z + (random() - 0.5) * 0.3));
    }
  }
  add(merge(parts), mats.bone, 0, 0, 0);
  // spirit fire guttering in the marrow of the spine, lighting its ribs from within
  for (const z of [-12, 0, 12]) k.light(0x5aff8a, 26, 16, 0, KEEL - 2.4, z);
}

// ---------------------------------------------------------------------------
// The Abyss's landmark: the Hall of Ash's bone chandelier

/** How high the bone chandelier's lowest ring hangs. */
const CHANDELIER = 7.6;

/**
 * A great chandelier of bones hung over the middle of the hall on chains
 * from the four spines: two rings of skulls looking out with spirit fire in
 * their eyes, long bones spoked between them, a column of vertebrae down its
 * middle ending in a skull, and spirit fire in cups of bone round its top.
 */
function boneChandelier(k: KitBuild): void {
  const { c, mats, add } = k;
  const y = CHANDELIER;
  const bones: THREE.BufferGeometry[] = [];
  const eyes: THREE.BufferGeometry[] = [];
  // the stem, and the skull at its foot
  bones.push(spine(0.3, 3.6, 9900).translate(0, y - 0.9, 0));
  bones.push(skull(0.42).rotateX(0.5).translate(0, y - 1.25, 0));
  eyes.push(SOCKETS.clone().scale(0.42, 0.42, 0.42).rotateX(0.5).translate(0, y - 1.25, 0));
  const tiers = [
    { at: 0, r: 1.75, n: 10, size: 0.27 },
    { at: 1.25, r: 2.75, n: 14, size: 0.3 },
  ];
  for (const t of tiers) {
    const ty = y + t.at;
    bones.push(new THREE.TorusGeometry(t.r, 0.09, 6, 48).rotateX(Math.PI / 2).translate(0, ty - t.size * 0.9, 0));
    for (let i = 0; i < t.n; i++) {
      const a = ((i + 0.5 * t.at) / t.n) * Math.PI * 2;
      const face = Math.PI / 2 - a;
      const x = Math.cos(a) * t.r;
      const z = Math.sin(a) * t.r;
      bones.push(skull(t.size).rotateY(face).translate(x, ty, z));
      eyes.push(SOCKETS.clone().scale(t.size, t.size, t.size).rotateY(face).translate(x, ty, z));
    }
    // spokes of long bone from the stem out to the ring
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + t.at;
      const len = t.r - 0.25;
      bones.push(longBone(len, 0.07).rotateZ(Math.PI / 2).translate(len / 2 + 0.2, ty - t.size * 0.9, 0).rotateY(-a));
    }
  }
  // cups of bone round the top ring, spirit fire in each
  const cups = 7;
  for (let i = 0; i < cups; i++) {
    const a = (i / cups) * Math.PI * 2 + 0.2;
    const x = Math.cos(a) * 2.2;
    const z = Math.sin(a) * 2.2;
    const cy = y + 2.0;
    bones.push(longBone(2.0, 0.06).rotateZ(Math.PI / 2).translate(1.2, cy - 0.12, 0).rotateY(-a));
    bones.push(lathe([[0, 0], [0.12, 0], [0.3, 0.2], [0.36, 0.34], [0.3, 0.32], [0, 0.18]], 10).translate(x, cy - 0.1, z));
    add(COALS.clone().scale(0.6, 0.6, 0.6), mats.coals, x, cy + 0.18, z, false);
    add(FLAME_BED, mats.flameBed, x, cy + 0.2, z, false).scale.setScalar(0.45);
  }
  // the crown, a horned vertebra the chains meet at
  bones.push(hornCrown(0.45, 9910).translate(0, y + 2.7, 0));
  add(merge(bones), mats.bone, 0, 0, 0);
  add(merge(eyes), mats.coals, 0, 0, 0, false);
  // chains out to the four spines, and one up into the dark
  const crown = new THREE.Vector3(0, y + 2.9, 0);
  for (const [x, z, r] of c.pillars) {
    const d = Math.hypot(x, z);
    add(slackChain(crown, new THREE.Vector3(x - (x / d) * (r + 0.2), 9.1, z - (z / d) * (r + 0.2)), 0.6, 1.4), mats.iron, 0, 0, 0, false);
  }
  chain(k, chainLink(), 0, 0, crown.y, 24);
  k.light(0x5aff8a, 44, 17, 0, y + 0.6, 0);
}

// ---------------------------------------------------------------------------
// The Abyss's landmark: the Crossroads' coiled serpent

/**
 * The skeleton of a great serpent coiled down out of the dark over the
 * crossing, its ribs curling in round the coil, its neck reaching out and
 * down toward the way in, its jaws agape on the spirit fire in its throat.
 */
function coiledSerpent(k: KitBuild): void {
  const { mats, add } = k;
  const bones: THREE.BufferGeometry[] = [];
  // the coil round the middle, from high in the dark down, then the neck out toward the way in
  const pts: THREE.Vector3[] = [];
  const turns = 2.25;
  const R = 2.7;
  const top = 19.5;
  const low = 9.0;
  for (let i = 0; i <= 54; i++) {
    const t = i / 54;
    const a = Math.PI / 2 + t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * R, top - (top - low) * t, Math.sin(a) * R));
  }
  const end = pts[pts.length - 1]!;
  pts.push(new THREE.Vector3(end.x * 0.6, low - 0.6, end.z * 0.6 + 1.6), new THREE.Vector3(0.2, 7.8, 3.7), new THREE.Vector3(0, 7.1, 4.6));
  const spineCurve = new THREE.CatmullRomCurve3(pts);
  const n = Math.round(spineCurve.getLength() / 0.46);
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const basis = new THREE.Matrix4();
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const p = spineCurve.getPointAt(u);
    const t = spineCurve.getTangentAt(u);
    // thin at the tail up in the dark, thickest round the coil, the neck a little slimmer
    const s = 0.38 * (0.3 + 0.7 * smoothstep(0, 0.4, u)) * (1 - 0.22 * smoothstep(0.82, 1, u));
    q.setFromUnitVectors(up, t);
    bones.push(VERTEBRA.clone().scale(s, 0.46, s).applyQuaternion(q).translate(p.x, p.y, p.z));
    if (u < 0.08 || u > 0.86) continue;
    // a pair of ribs curling in toward the coil's middle
    const inward = new THREE.Vector3(-p.x, 0, -p.z).normalize();
    inward.addScaledVector(t, -inward.dot(t)).normalize();
    const side = new THREE.Vector3().crossVectors(t, inward).normalize();
    for (const dir of [-1, 1]) {
      const y = side.clone().multiplyScalar(dir);
      basis.makeBasis(inward, y, new THREE.Vector3().crossVectors(inward, y)).setPosition(p);
      bones.push(curvedBone(s * 3.6, s * 0.17, 1.9, 0.3, 6).applyMatrix4(basis));
    }
  }
  add(merge(bones), mats.bone, 0, 0, 0);
  // the skull at the end of the neck, looking along it
  const head = spineCurve.getPointAt(1);
  const look = spineCurve.getTangentAt(1);
  const place = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), look)).setPosition(head);
  add(SERPENT_SKULL.clone().applyMatrix4(place), mats.bone, 0, 0, 0);
  add(SERPENT_EYES.clone().applyMatrix4(place), mats.coals, 0, 0, 0, false);
  const throat = new THREE.Vector3(0, -0.15, 0.7).applyMatrix4(place);
  add(EYE, mats.coals, throat.x, throat.y, throat.z, false).scale.setScalar(0.42);
  k.light(0x5aff8a, 26, 15, throat.x, throat.y - 1.4, throat.z + 1.8);
  k.light(0x5aff8a, 20, 14, 0, low + 1.5, 0);
}

/** One of the serpent's vertebrae: a waisted drum on y, 1 m tall and 1 m round. */
const VERTEBRA = lathe([[0, 0], [0.92, 0], [1, 0.14], [0.76, 0.5], [1, 0.86], [0.92, 0.96], [0, 0.96]], 10).translate(0, -0.48, 0);

/** A serpent's skull looking down +z from its hinge at the origin: a long cranium, the snout, the brow, fangs, and the lower jaw dropped open. */
const SERPENT_SKULL = (() => {
  const jaw = new THREE.Matrix4().makeRotationX(0.75);
  const fang = (x: number, z: number, len: number) => new THREE.ConeGeometry(0.07, len, 6).rotateX(Math.PI).translate(x, -len / 2 - 0.12, z);
  return merge([
    new THREE.SphereGeometry(0.62, 16, 12).scale(0.85, 0.55, 1.15).translate(0, 0.1, 0.35),
    new THREE.SphereGeometry(0.42, 14, 10).scale(0.8, 0.42, 1.6).translate(0, 0.0, 1.15),
    ...[-1, 1].map((side) => new THREE.SphereGeometry(0.16, 10, 8).scale(1.3, 0.6, 1.6).translate(side * 0.34, 0.3, 0.75)),
    ...[-1, 1].map((side) => fang(side * 0.22, 1.6, 0.42)),
    ...[-1, 1].map((side) => fang(side * 0.3, 1.25, 0.2)),
    // the lower jaw, hinged at the back and dropped
    new THREE.SphereGeometry(0.38, 12, 8).scale(0.9, 0.22, 2.4).translate(0, -0.18, 0.85).applyMatrix4(jaw),
    ...[-1, 1].map((side) => new THREE.ConeGeometry(0.05, 0.26, 5).translate(side * 0.2, 0.0, 1.55).applyMatrix4(jaw)),
  ]);
})();
const SERPENT_EYES = merge([-1, 1].map((side) => new THREE.SphereGeometry(0.11, 8, 6).translate(side * 0.34, 0.22, 0.82)));

// ---------------------------------------------------------------------------
// The Abyss's landmark: the Twin Sanctums' obelisks

/**
 * A black obelisk at the heart of each sanctum, gripped by ribs rising from
 * its foot, and over it a great skull hanging in the air, turning slowly to
 * look round the sanctum with spirit fire in its eyes.
 */
function skullObelisk(k: KitBuild, x: number, z: number): void {
  const { mats, add } = k;
  const seed = 9995 + Math.round(z);
  add(chippedBlock(2.8, 0.6, 2.8, seed, 0.04), mats.obsidian, x, 0.3, z).rotation.y = Math.PI / 4;
  add(OBELISK, mats.obsidian, x, 0.6, z);
  add(OBELISK_RIBS, mats.bone, x, 0.6, z);
  // the skull, turning
  const head = new THREE.Group();
  head.position.set(x, 0.6 + OBELISK_H + 1.6, z);
  head.rotation.y = z > 0 ? 0 : Math.PI;
  for (const [geo, mat] of [[GREAT_SKULL, mats.bone], [GREAT_SOCKETS, mats.coals]] as const) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = mat === mats.bone;
    m.receiveShadow = true;
    head.add(m);
  }
  k.group.add(head);
  k.spin(head, new THREE.Vector3(0, 1, 0), z > 0 ? 0.22 : -0.22);
  k.light(0x5aff8a, 28, 13, x, OBELISK_H + 0.2, z + (z > 0 ? 1.2 : -1.2));
}

/** How tall the obelisk stands on its plinth, to its tip. */
const OBELISK_H = 4.4;
const OBELISK = merge([
  new THREE.CylinderGeometry(0.62, 0.95, OBELISK_H - 0.7, 4).rotateY(Math.PI / 4).translate(0, (OBELISK_H - 0.7) / 2, 0),
  new THREE.ConeGeometry(0.62, 0.7, 4).rotateY(Math.PI / 4).translate(0, OBELISK_H - 0.35, 0),
]);
/** Four ribs rising from the obelisk's foot and curling in round it. */
const OBELISK_RIBS = merge(
  [0, 1, 2, 3].map((i) => curvedBone(3.6, 0.14, -0.45, 0.2, 10).translate(1.15, 0, 0).rotateY((i / 4) * Math.PI * 2)),
);
/** The great skull, 0.9 m round, facing +z. */
const GREAT_SKULL = skull(0.9);
const GREAT_SOCKETS = SOCKETS.clone().scale(0.9, 0.9, 0.9);

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
