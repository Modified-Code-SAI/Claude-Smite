import * as THREE from 'three/webgpu';
import { fbm2, simplex2, smoothstep as sstep } from '../../core/random';
import { caveField, CHAMBERS, chamberAt, chamberField, pitDepth, underworldBrink, underworldField, UNDERWORLD } from '../../map/UnderworldLayout';
import {
  abs, atan, dFdx, dFdy, dot, exp, float, floor, fract, hash, length, max, min, mix, mx_noise_float, select, normalWorld, positionLocal, positionWorld, pow, sin, smoothstep, step, texture, time, transformNormalToView, vec2, vec3,
} from '../../render/tsl';
import { planar, triplanar, type TextureLibrary } from '../Materials';
import type { Terrain, TerrainDef } from '../Terrain';
import { BRINK_SCALE, darkReach, floodReach, gapLook, slagLook, ventLook } from './hazardLook';
import { CLEAR_WAVE, clearWave, depthLook, gateOpen, runeRings, underworldGlow } from './palettes';

/** Width (m) of one glyph's cell around a ring, and half the height of the band of glyphs. */
const GLYPH = 1.1;
const BAND = 0.62;

/** Points the shown chamber's rune rings (see ChamberDef.runes) at its floor. */
export function showRunes(ci: number): void {
  const c = CHAMBERS[ci]!;
  runeRings.forEach((u, k) => {
    const ring = c.runes[k];
    if (ring) u.value.set(c.x + ring[0], c.z + ring[1], ring[2], Math.max(8, Math.round((Math.PI * 2 * ring[2]) / GLYPH)));
    else u.value.set(1e4, 1e4, 0, 8);
  });
}

/** Distance from p to the segment a-b (all vec2 nodes). */
function segment(p: any, a: any, b: any): any {
  const pa = p.sub(a);
  const ba = b.sub(a);
  const h = dot(pa, ba).div(dot(ba, ba)).clamp(0, 1);
  return length(pa.sub(ba.mul(h)));
}

const hash1 = (x: any) => fract(sin(x.mul(12.9898)).mul(43758.5453));

/** How wide (m) the forge's basalt columns are, and the Abyss's facets of glass. */
const COLUMN = 0.95;
const FACET = 1.4;

/** How wide (m) the Drowned Halls' courses of paving are. */
const COURSE = 1.0;

/**
 * The cell of a hex lattice (centers 1 apart) that p falls in: p's offset
 * from the cell's middle, a hash of the cell, and how far p is inside its
 * edge (0.5 at the middle, 0 at the edge).
 */
function hexCell(p: any): { q: any; h: any; edge: any } {
  const s = vec2(1, Math.sqrt(3));
  const half = s.mul(0.5);
  const a = p.sub(s.mul(floor(p.div(s)))).sub(half);
  const b = p.sub(half).sub(s.mul(floor(p.sub(half).div(s)))).sub(half);
  const q = select(dot(a, a).lessThan(dot(b, b)), a, b);
  const id = p.sub(q);
  // (the hash takes whole numbers and no negatives: the middles fall on halves of 1 and of sqrt 3)
  const key = floor(id.x.mul(2).add(1024.5)).mul(4096).add(floor(id.y.mul(2 / Math.sqrt(3)).add(1024.5)));
  const qa = abs(q);
  return { q, h: hash(key), edge: float(0.5).sub(max(dot(qa, vec2(0.5, Math.sqrt(3) / 2)), qa.x)) };
}

/**
 * Distance (m) from a floor point to the nearest stroke of one rune ring: two
 * thin guide rings with a script of glyphs between them, each glyph a stem and
 * two branches picked from a hash of its cell, every seventh cell a dot.
 * Each depth writes it in its own hand: the forge's is cut clean (and filled
 * with molten metal, see the material), in the Drowned Halls the lines
 * waver like light through moving water, and in the Abyss the script is
 * written in spirit light: its guide lines broken, its glyphs fading out and
 * back one by one, each ring turning slowly its own way.
 */
function ringDistance(xz: any, ring: any, seed: number): any {
  const soul = depthLook.y;
  const abyss = float(1).sub(depthLook.x).sub(soul);
  const p = xz.sub(ring.xy);
  const rho = length(p);
  const a = atan(p.y, p.x);
  const y = rho.sub(ring.z).add(sin(a.mul(ring.w.mul(0.5).floor()).add(time.mul(1.1)).add(seed * 2.1)).mul(0.045).mul(soul));
  const u = a.div(Math.PI * 2).add(0.5).add(time.mul(seed % 2 ? -0.011 : 0.011).mul(abyss)).mul(ring.w);
  // (broken in gaps of their own lengths, some halves of a cell whole)
  const half = u.mul(2);
  const gap = mix(0.45, 1.15, hash1(floor(half).mod(ring.w.mul(2)).add(seed * 31 + 0.5)));
  const dashes = smoothstep(gap, gap.add(0.05), fract(half)).mul(abyss).mul(0.3);
  const guides = min(abs(y.sub(BAND)), abs(y.add(BAND))).sub(0.012).add(dashes);
  // (a cell's glyph stays the same all the way round, however far the ring has turned)
  const k = floor(u).mod(ring.w).add(seed * 17);
  const x = fract(u).sub(0.5).mul(rho.mul(Math.PI * 2).div(ring.w)).add(sin(y.mul(9).add(time.mul(2.1)).add(k)).mul(0.03).mul(soul));
  const q = vec2(x, y);
  const h1 = hash1(k);
  const h2 = hash1(k.add(0.37));
  const h3 = hash1(k.add(0.71));
  const side = select(h2.greaterThan(0.5), float(0.27), float(-0.27));
  const stem = segment(q, vec2(0, -0.42), vec2(0, 0.42));
  const b1 = segment(q, vec2(0, mix(-0.25, 0.3, h1)), vec2(side, mix(-0.42, 0.42, h3)));
  const b2 = segment(q, vec2(0, mix(0.42, 0.05, h3)), vec2(side.negate(), mix(0.1, -0.42, h1)));
  const glyph = min(stem, min(b1, b2));
  const dotGlyph = length(q).sub(0.09);
  // (most of the script is there at any moment, a glyph here and there gone)
  const fade = float(1).sub(smoothstep(-0.8, -0.1, sin(time.mul(0.55).add(h1.mul(37))))).mul(abyss).mul(0.22);
  const mark = select(fract(k.mul(1 / 7)).lessThan(0.1), dotGlyph, glyph).add(fade);
  return min(guides, mark);
}

/**
 * How deep (m) the ground lies `d` meters in past the floor's edge where
 * the floor is cut, by depth: a bed of rock under the forge's lava (its
 * surface at LAVA_Y), a sunken floor under the Drowned Halls' water (at
 * WATER_Y), and in the Abyss a lip, then a sheer fall into the dark.
 */
function holeDepth(depth: number, d: number): number {
  // (the lava's and the water's beds are shallow enough to wade: the sim walks gods down the same slope)
  if (depth < 2) return -pitDepth(depth, d);
  return -0.6 * sstep(0, 0.4, d) - VOID_DEPTH * sstep(0.35, 4.5, d);
}

/** Heights (m) of the lava's and the water's surface, and how far the Abyss's void falls. */
export const LAVA_Y = -0.9;
export const WATER_Y = -0.35;
export const VOID_DEPTH = 30;

/**
 * The underworld's ground: eighteen chamber floors sunk into a plateau of
 * black rock, walls rising steeply all round, and where a floor is cut, a
 * bed of rock under lava, a drowned floor under water, or a fall into the
 * void. The floors stay at height 0 so fights are on level ground.
 */
export function underworldTerrain(): TerrainDef {
  const n1 = simplex2(301);
  const n2 = simplex2(317);
  const n3 = simplex2(331);
  const H = UNDERWORLD.wallHeight;
  return {
    size: UNDERWORLD.size,
    // (about 0.55 m between vertices, fine enough for a bridge's edge)
    segments: 616,
    maskSize: UNDERWORLD.size,
    maskRes: 1024,
    height(x, z) {
      const i = chamberAt(x, z);
      let cave = -40;
      if (i >= 0) {
        const c = CHAMBERS[i]!;
        const f = chamberField(c, x - c.x, z - c.z);
        if (f >= 0) return 0;
        cave = caveField(c, x - c.x, z - c.z);
        if (cave >= 0) return holeDepth(c.depth, -f);
      }
      // into the wall: a lip of scree, then a steep, ledged cliff
      const d = -cave + fbm2(n1, x * 0.11, z * 0.11, 3) * 0.9;
      const rise = sstep(0.2, 7.5, d);
      const ridge = 1 - Math.abs(fbm2(n2, x * 0.05, z * 0.05, 4));
      const ledges = Math.round(rise * 5 + ridge * 0.5) / 5;
      const top = H * (0.8 + ridge * 0.35) + fbm2(n3, x * 0.02, z * 0.02, 3) * 4;
      return Math.max(0, d) * 0.5 * (1 - rise) + top * (rise * 0.6 + ledges * 0.4) + fbm2(n3, x * 0.21, z * 0.21, 2) * 0.6 * rise;
    },
    mask(x, z) {
      const f = underworldField(x, z);
      const edge = fbm2(n1, x * 0.3, z * 0.3, 3);
      const ash = 1 - sstep(0.4, 3.6, f + edge * 1.1);
      const scorch = Math.max(0, fbm2(n2, x * 0.07, z * 0.07, 3)) * 0.9;
      const macro = fbm2(n3, x * 0.03 + 50, z * 0.03, 4) * 0.5 + 0.5;
      // (green: how far the floor runs on to the lava, water or void, for the tide and the dark)
      const brink = Math.max(0, Math.min(1, underworldBrink(x, z) / BRINK_SCALE));
      return [ash, brink, scorch, macro];
    },
    material: underworldMaterial,
  };
}

/**
 * Basalt flagstones on the floors with grey ash drifted against the walls,
 * dark rock above, and the depth's glow seeping from the cracks low on the
 * walls, along the floor's rune rings and up from the lava bowl. All of it is
 * one material, recolored through `underworldGlow`.
 */
function underworldMaterial(terrain: Terrain, textures: TextureLibrary): THREE.Material {
  const mat = new THREE.MeshStandardNodeMaterial();
  const size = terrain.def.maskSize;
  const m = texture(terrain.mask, positionWorld.xz.div(size).add(0.5));
  const ash = m.r;
  // the shown chamber's rune rings, drawn analytically so they stay crisp at any distance
  const xz = positionWorld.xz;
  const runeD = min(ringDistance(xz, runeRings[0], 0), min(ringDistance(xz, runeRings[1], 1), ringDistance(xz, runeRings[2], 2)));
  const runeAA = abs(dFdx(runeD)).add(abs(dFdy(runeD))).max(0.004);
  const wornN = mx_noise_float(xz.mul(0.35));
  const worn = smoothstep(-0.7, -0.35, wornN);
  const runeCore = float(1).sub(smoothstep(0.035, runeAA.add(0.06), runeD)).mul(worn);
  // (the Abyss's spirit script glows wider and softer, like smoke round it)
  const runeHalo = exp(runeD.mul(mix(float(-7), float(-3.6), float(1).sub(depthLook.x).sub(depthLook.y)))).mul(0.28);
  const groove = float(1).sub(smoothstep(0.06, 0.15, runeD));
  const scorch = m.b;
  const macro = m.a;
  const n = normalWorld.normalize();
  const lum = (c: any) => dot(c, vec3(0.3, 0.59, 0.11));

  // each depth's own look, by weight (see depthLook): the Abyss where both
  // weights are 0, the Ashen Depths' forge, the Drowned Halls' crypt
  const ember = depthLook.x;
  const soul = depthLook.y;
  const abyss = float(1).sub(ember).sub(soul);
  const depthTint = (abyss: any, forge: any, drowned: any) => mix(mix(abyss, forge, ember), drowned, soul);

  const flag = planar(textures.get('flagstone'), positionWorld.xz.mul(0.058), n);
  const dust = planar(textures.get('dirt'), positionWorld.xz.mul(0.23).add(vec2(0.31, 0.17)), n);
  const rock = triplanar(textures.get('rock'), 0.055, 6);
  const fine = triplanar(textures.get('rock'), 0.2, 6);
  const wy = positionWorld.y;
  // one hex lattice serves two depths: upright in the forge, where its cells
  // are the columns the basalt has split into (their tops are the floor, their
  // sides the walls), and skewed and tipped in the Abyss, where they are the
  // facets of volcanic glass on the walls
  // (the forge's lattice bent by two slow noises, so its columns come in
  // uneven sizes and shapes as real basalt does, not a tiled honeycomb)
  const bend = vec2(wornN, mx_noise_float(xz.mul(0.31).add(vec2(17.3, 5.1)))).mul(0.42);
  const hex = hexCell(mix(vec2(xz.x.mul(0.62).add(wy.mul(0.45)), xz.y.mul(0.62).sub(wy.mul(0.38))).div(FACET), xz.add(bend).div(COLUMN), ember));
  // (meters a pixel spans here, so thin joints fade rather than shimmer far off)
  const px = abs(dFdx(xz.x)).add(abs(dFdy(xz.x))).add(abs(dFdx(xz.y))).add(abs(dFdy(xz.y))).mul(0.5).max(0.002);
  // (and up the walls: a pixel's height in meters there)
  const pxUp = abs(dFdx(wy)).add(abs(dFdy(wy))).mul(0.5).max(0.002);
  const seam = (d: any, w: number, aa: any = px) => smoothstep(aa.add(w), max(aa.negate().add(w), 0), d).mul(min(float(w).div(aa.add(w)), 1));

  // each depth lays its own floor. The Abyss: great slabs of black glass. The
  // Ashen Depths: the tops of the basalt columns the chamber was cut down
  // into, each its own shade and set a little askew, their edges worn round.
  // The Drowned Halls: a crypt's paving, laid in courses, the slabs sunk
  // unevenly, their edges worn by the water, here and there a grave slab
  // with a border cut round it
  const floorGrain = lum(fine.color).mul(1.25).add(lum(dust.color));
  const grainNrm = mix(n, fine.normal, 0.45);
  const topEdge = hex.edge.mul(COLUMN);
  const topJoint = seam(topEdge, 0.035);
  const outward = vec3(hex.q.x, 0, hex.q.y).div(max(length(hex.q), 0.05));
  const topNrm = grainNrm.add(outward.mul(smoothstep(0.17, 0.02, topEdge).mul(0.7))).add(vec3(fract(hex.h.mul(13.7)).sub(0.5), 0, fract(hex.h.mul(9.1)).sub(0.5)).mul(0.08)).normalize();
  const cz = xz.y.div(COURSE);
  const course = floor(cz);
  const courseH = hash(course.add(2048));
  const slabL = mix(float(1.4), float(2.4), courseH);
  const bx = xz.x.div(slabL).add(courseH.mul(7.3));
  const fx = fract(bx);
  const fz = fract(cz);
  const ex = min(fx, float(1).sub(fx)).mul(slabL);
  const ez = min(fz, float(1).sub(fz)).mul(COURSE);
  const slabEdge = min(ex, ez);
  const slabH = hash(floor(bx).add(2048).mul(4096).add(course.add(2048)));
  const slabJoint = seam(slabEdge, 0.035);
  const slabOut = select(ex.lessThan(ez), vec3(step(0.5, fx).mul(2).sub(1), 0, 0), vec3(0, 0, step(0.5, fz).mul(2).sub(1)));
  const wear = mix(float(0.05), float(0.2), smoothstep(-0.3, 0.5, wornN));
  const slabNrm = grainNrm.add(slabOut.mul(smoothstep(wear, 0.01, slabEdge).mul(0.6))).add(vec3(fract(slabH.mul(13.7)).sub(0.5), 0, fract(slabH.mul(9.1)).sub(0.5)).mul(0.1)).normalize();
  const grave = seam(abs(slabEdge.sub(0.15)), 0.018).mul(step(0.91, slabH));
  const floorLum = depthTint(
    lum(flag.color),
    floorGrain.mul(mix(float(0.72), float(1.22), hex.h)).mul(float(1).sub(topJoint.mul(0.65))),
    floorGrain.mul(mix(float(0.78), float(1.16), slabH)).mul(float(1).sub(slabJoint.mul(0.7)).sub(grave.mul(0.4))),
  );
  // polished black stone tinted by the depth, varied by the macro noise
  const basalt = vec3(floorLum).mul(depthTint(vec3(0.1, 0.112, 0.106), vec3(0.2, 0.158, 0.146), vec3(0.13, 0.15, 0.16))).mul(mix(float(0.75), float(1.2), macro));
  // what has drifted against the walls: in the Abyss pale bone dust, in the
  // Ashen Depths a black crust of cooling lava, in the Drowned Halls the
  // grey-green silt the water left behind
  const ashCol = vec3(lum(dust.color)).mul(depthTint(vec3(0.44, 0.42, 0.37), vec3(0.075, 0.06, 0.055), vec3(0.2, 0.235, 0.215)));
  const ashW = smoothstep(0.2, 0.8, ash.add(dust.color.g.mul(0.6)).sub(0.25));
  let col: any = mix(basalt, ashCol, ashW);
  let nrm: any = mix(depthTint(flag.normal, topNrm, slabNrm), dust.normal, ashW);
  // polished enough to catch the braziers' light; the Abyss's slabs are black
  // glass, polished to a mirror between their scratches
  const floorRough = depthTint(flag.roughness.mul(0.32).add(0.04), mix(mix(float(0.42), float(0.56), fract(hex.h.mul(4.3))), float(0.9), topJoint), mix(mix(float(0.46), float(0.62), fract(slabH.mul(4.3))), float(0.9), max(slabJoint, grave)));
  let rough: any = mix(floorRough, float(0.95), ashW);

  // rock: the steep faces and everything above the floor, each depth's walls
  // their own stone
  const rockNrm = rock.normal.add(fine.normal).normalize();
  const raw = rock.color.mul(fine.color.mul(1.7));
  // level and along the wall, for shading across its columns and beds
  const along = vec3(n.z.negate(), 0, n.x).div(max(length(n.xz), 0.05));
  const sheer = smoothstep(0.93, 0.6, n.y);

  // the Ashen Depths: columns of basalt, each its own shade, rounded across
  // the wall, split into drums at joints of their own heights
  const drumH = mix(float(1.5), float(3.2), fract(hex.h.mul(7.31)));
  const drumV = wy.div(drumH).add(fract(hex.h.mul(3.17)));
  const drum = fract(drumV);
  const colJoint = smoothstep(0.075, 0.0, hex.edge.mul(COLUMN));
  const drumJoint = smoothstep(0.065, 0.0, min(drum, float(1).sub(drum)).mul(drumH)).mul(sheer);
  const colTone = mix(float(0.72), float(1.22), hex.h).mul(mix(float(0.9), float(1.08), hash(floor(drumV).add(floor(hex.h.mul(4096))).add(512))));
  const colNrm = rockNrm.add(along.mul(dot(hex.q, along.xz).mul(sheer).mul(1.2))).normalize();

  // the Drowned Halls: limestone laid down in beds, each its own shade, the
  // lip of each catching the light from above and its underside in shadow;
  // the water that stood here left the stone darker below its line, and water
  // still runs down it in dark, glossy streaks
  // (some beds thick, some thin)
  const bedV = wy.mul(0.9).add(wornN.mul(0.3)).add(sin(wy.mul(0.37)).mul(0.4)).add(sin(wy.mul(1.7).add(1.3)).mul(0.12));
  const bed = fract(bedV);
  const bedJoint = smoothstep(0.06, 0.0, min(bed, float(1).sub(bed)).div(0.9));
  const bedTone = mix(float(0.8), float(1.16), hash(floor(bedV).add(64)));
  const bedNrm = rockNrm.add(vec3(0, smoothstep(0.72, 1, bed).sub(smoothstep(0.28, 0, bed)).mul(0.7).mul(sheer), 0)).normalize();
  const tideY = wy.add(wornN.mul(0.12)).sub(2.7);
  const below = smoothstep(0.06, -0.06, tideY);
  const tideLine = smoothstep(0.13, 0.0, abs(tideY.sub(0.05)));
  const streak = smoothstep(0.45, 0.85, sin(xz.x.mul(1.9).add(xz.y.mul(1.6)).add(fine.color.r.mul(5))).mul(0.5).add(0.5)).mul(soul);
  const bedShade = bedTone.mul(float(1).sub(below.mul(0.28))).add(tideLine.mul(0.35)).mul(float(1).sub(streak.mul(0.35)));

  // the Abyss: black volcanic glass broken into facets, each tipped its own
  // way (more of them down than up, so few mirror the sky), polished, rippled
  // in the curved ribs glass breaks in, a pale bevel where two meet
  const tip = vec3(fract(hex.h.mul(13.7)).sub(0.5), fract(hex.h.mul(5.3)).mul(0.75).sub(0.6), fract(hex.h.mul(9.1)).sub(0.5)).mul(sheer);
  const facetNrm = mix(rockNrm, n, 0.7).add(tip).normalize();
  const bevel = smoothstep(0.06, 0.0, hex.edge.mul(FACET));
  const ribs = sin(length(hex.q.sub(vec2(fract(hex.h.mul(6.1)), fract(hex.h.mul(8.3))).sub(0.5).mul(0.6))).mul(34)).mul(0.5).add(0.5);
  const glassTone = mix(float(0.3), float(0.55), fract(hex.h.mul(2.9))).mul(float(1).sub(ribs.mul(0.12))).add(bevel.mul(0.9));

  const joints = depthTint(float(0), max(colJoint, drumJoint), bedJoint);
  const rockCol = vec3(lum(raw)).mul(depthTint(vec3(0.24, 0.26, 0.25), vec3(0.33, 0.25, 0.215), vec3(0.24, 0.27, 0.28))).mul(depthTint(glassTone, colTone, bedShade)).mul(float(1).sub(joints.mul(0.68)));
  const rockW = max(smoothstep(0.82, 0.6, n.y), smoothstep(0.25, 1.2, wy));
  col = mix(col, rockCol, rockW);
  nrm = mix(nrm, depthTint(facetNrm, colNrm, bedNrm), rockW);
  const rockRough = depthTint(mix(mix(float(0.2), float(0.36), fract(hex.h.mul(4.3))).add(ribs.mul(0.08)), float(0.55), bevel), float(0.62), mix(mix(float(0.75), float(0.42), below), float(0.3), streak));
  rough = mix(rough, mix(rockRough, float(0.95), joints), rockW);
  col = col.mul(float(1).sub(scorch.mul(0.35)));
  // the runes are cut into the slabs: a dark groove around each glowing line
  // (only at the floor's own level: a ring broken off at the brink stays broken, not carried on down the drop)
  const floorW = float(1).sub(rockW).mul(smoothstep(-0.45, -0.1, wy));
  // (the Abyss's script is light over the stone, not cut into it)
  const cut = groove.mul(floorW).mul(float(1).sub(abyss.mul(0.8)));
  col = col.mul(float(1).sub(cut.mul(0.6)));
  rough = mix(rough, float(0.85), cut);

  // the glow: cracks low on the walls (dark crevices of the rock), the floor's
  // runes and the lava bowl, breathing slowly
  const breathe = sin(time.mul(1.3).add(positionWorld.x.mul(0.07)).add(positionWorld.z.mul(0.05))).mul(0.18).add(0.82);
  // thin branching cracks where a slow noise crosses zero, their width wandering,
  // low on the walls and in the rock's darker grain, each with a scorched crust
  // the rock's own grain shoves the line about, so it zigzags along the crevices like a split in stone
  const jag = fine.color.sub(0.3).mul(0.55).add(rock.color.sub(0.3).mul(0.25));
  const crackN = abs(mx_noise_float(positionWorld.mul(vec3(0.32, 0.5, 0.32)).add(jag)));
  const veinN = mx_noise_float(positionWorld.mul(0.11).add(7));
  const crackW = mix(float(0.012), float(0.045), smoothstep(-0.4, 0.6, veinN));
  const grain = smoothstep(0.22, 0.08, lum(raw));
  const low = smoothstep(5.5, 0.4, positionWorld.y);
  const zone = grain.mul(rockW).mul(low);
  // (in the Drowned Halls they are wider, softer seams of seeping light)
  const veinW = crackW.mul(mix(float(1), float(1.9), soul));
  const crack = smoothstep(veinW, 0.0, crackN);
  col = col.mul(float(1).sub(smoothstep(veinW.mul(4), veinW, crackN).mul(zone).mul(0.55)));
  // in runs a few meters long, not one unbroken line round the walls
  const cracks = crack.mul(zone).mul(smoothstep(-0.4, 0.05, wornN));
  // each depth's light gets out of its stone its own way. In the forge it is
  // lava in the cracks, slow pulses of it sliding down them. In the Drowned
  // Halls it seeps out along the joints between the beds in long runs, the
  // cracks only faint. In the Abyss it is spirit light in the seams between
  // the facets of glass, each facet's rim brightening and dimming on its own
  // slow beat
  const slide = sin(wy.mul(2.2).add(time.mul(1.5)).add(xz.x.add(xz.y).mul(0.9))).mul(0.3).add(0.9);
  // (each bed's seam and each facet's rim alight in runs of its own)
  const onWall = rockW.mul(low).mul(sheer);
  // (broken up by the stone's own grain, as if seeping through where it is porous)
  const bedSeam = seam(min(bed, float(1).sub(bed)).div(0.9), 0.035, pxUp).mul(smoothstep(-0.15, 0.35, wornN.add(sin(floor(bedV).mul(2.3)).mul(0.45)))).mul(onWall).mul(smoothstep(0.13, 0.21, lum(fine.color)));
  const facetSeam = seam(hex.edge.mul(FACET), 0.03, px.add(pxUp)).mul(smoothstep(-0.2, 0.3, wornN.add(fract(hex.h.mul(5.7)).sub(0.5).mul(0.7)))).mul(onWall);
  const facetBeat = sin(time.mul(0.8).add(hex.h.mul(40))).mul(0.4).add(0.6);
  const veins = depthTint(
    cracks.mul(3.2).add(facetSeam.mul(facetBeat).mul(2.6)),
    cracks.mul(slide).mul(3.6),
    cracks.mul(1.0).add(bedSeam.mul(4)),
  );
  // a slow wave of light runs round the rings, and they flare as the way down opens
  const runeA = atan(xz.y.sub(runeRings[0].y), xz.x.sub(runeRings[0].x));
  const wave = sin(runeA.mul(3).sub(time.mul(1.4))).mul(0.25).add(0.85);
  // in the forge the runes are channels of molten metal: a white-hot pour
  // runs round them, cooling behind it, and in stretches a dark crust has formed
  const pour = pow(fract(runeA.div(Math.PI * 2).sub(time.mul(0.06))), float(5));
  const crust = float(1).sub(smoothstep(0.1, 0.45, wornN).mul(0.6));
  // in the Drowned Halls they shimmer as if seen through the water over them,
  // and every few seconds a ripple of their light laps out a little way from
  // the ring (dying away well short of anything a fight could mistake for a
  // shockwave)
  const shimmer = sin(xz.x.mul(2.7).add(time.mul(1.9))).mul(sin(xz.y.mul(2.3).sub(time.mul(1.6)))).mul(0.3).add(1);
  const spread = fract(time.mul(0.2));
  const rippleR = runeRings[0].z.add(BAND).add(spread.mul(3.2));
  const runeRipple = exp(abs(length(xz.sub(runeRings[0].xy)).sub(rippleR)).mul(-11)).mul(float(1).sub(spread).pow(2)).mul(0.26).mul(soul).mul(float(1).sub(ashW));
  const flare = gateOpen.mul(0.7).add(1);
  const runes = runeCore.mul(2.4).add(runeHalo).mul(depthTint(wave, wave.mul(crust).add(pour.mul(0.9)), wave.mul(shimmer))).add(runeRipple).mul(floorW).mul(flare);
  const molten = runeCore.mul(floorW).mul(ember).mul(crust).mul(pour.mul(1.6).add(0.3)).mul(flare);
  // the light of the lava, or the water's glow, from the stone under them; in
  // the Abyss only a faint band of spirit light far down the drop
  const bowl = mix(smoothstep(-0.15, -1.6, wy).mul(2.2), smoothstep(-5, -13, wy).mul(smoothstep(-31, -18, wy)).mul(0.55), abyss);
  // and down the Abyss's drop the stone goes black
  const sunk = smoothstep(-1.5, -11, wy);
  // (its veins and seams die out within a few meters of the lip, so the drop reads as bottomless)
  const sunkGlow = smoothstep(-0.7, -4, wy);
  // the Ashen Depths: lava seeping up through the joints between the slabs in
  // patches, and through the cracks in the crust along the walls
  // (in patches a few slabs across, where the runes' wear noise runs high)
  const open = float(1).sub(ashW);
  const patch = smoothstep(0.25, 0.62, wornN).mul(smoothstep(0.3, 0.55, macro));
  const joint = topJoint.mul(patch).mul(open);
  const crustCracks = smoothstep(0.07, 0.0, crackN).mul(ashW);
  const forgeFloor = floorW.mul(ember);
  // round each seeping patch the slabs are heated: their edges scorched and
  // glowing dull red, and a warm light rising off the stone that fades out
  // over a few slabs
  const warmth = smoothstep(0.0, 0.6, wornN).mul(smoothstep(0.15, 0.55, macro)).mul(open);
  const rimHeat = smoothstep(0.24, 0.05, topEdge).mul(warmth);
  // cinders caught in the black crust along the walls (and a few among the
  // hot slabs), each glowing and fading on its own beat
  const cell = floor(xz.mul(3.5)).add(2048);
  const cellHash = hash(cell.y.mul(4096).add(cell.x));
  const fleckD = length(fract(xz.mul(3.5)).sub(0.5));
  const fleckBeat = sin(time.mul(cellHash.mul(3).add(1.5)).add(cellHash.mul(40))).mul(0.5).add(0.5);
  const fleck = smoothstep(0.93, 0.96, cellHash).mul(smoothstep(0.24, 0.05, fleckD)).mul(fleckBeat).mul(max(ashW, patch.mul(0.6)));
  // and molten light up the joints between some of the columns at the walls' foot
  const lavaUp = smoothstep(1.8, 0.1, wy);
  const lavaJoint = colJoint.mul(lavaUp.mul(lavaUp)).mul(smoothstep(0.45, 0.75, hex.h)).mul(rockW).mul(ember);
  const seep = joint.mul(0.8).add(crustCracks.mul(2.4)).add(rimHeat.mul(0.3)).add(warmth.mul(0.045)).add(fleck.mul(3.5)).mul(forgeFloor);
  col = col.mul(float(1).sub(joint.add(rimHeat.mul(0.45)).mul(forgeFloor).mul(0.6)));
  // the Drowned Halls: the slabs are wet, moss grows in their joints, and
  // still water stands in the hollows, stirred by slow ripples
  const wetFloor = floorW.mul(soul);
  const moss = max(slabJoint, grave.mul(0.6)).mul(float(1).sub(ashW));
  col = mix(col, vec3(0.04, 0.075, 0.062).mul(lum(flag.color).add(0.5)), moss.mul(wetFloor).mul(0.85));
  const puddle = smoothstep(0.44, 0.36, macro).mul(smoothstep(-0.35, 0.05, wornN)).mul(wetFloor);
  const ripple = textures.get('dirt').nr;
  const r1 = texture(ripple, xz.mul(0.21).add(vec2(time.mul(0.021), time.mul(0.013)))).xy;
  const r2 = texture(ripple, xz.mul(0.17).sub(vec2(time.mul(0.011), time.mul(0.019)))).xy;
  const rippleN = vec3(r1.x.add(r2.x).sub(1).mul(0.12), 1, r1.y.add(r2.y).sub(1).mul(0.12)).normalize();
  col = col.mul(float(1).sub(puddle.mul(0.55)));
  nrm = mix(nrm, rippleN, puddle);
  rough = mix(rough.mul(mix(float(1), float(0.6), wetFloor)), float(0.03), puddle);
  // the Abyss: bone dust ground into some of the joints, and in the scorched
  // patches the black slabs split clean through, spirit light welling up from
  // the dark below (both masks reuse noise already sampled above)
  const bare = floorW.mul(abyss).mul(float(1).sub(ashW));
  const boneJoint = smoothstep(0.955, 0.998, flag.roughness).mul(smoothstep(-0.25, 0.25, wornN));
  col = mix(col, vec3(0.36, 0.34, 0.29).mul(lum(dust.color).add(0.55)), boneJoint.mul(bare).mul(0.7));
  rough = mix(rough, float(0.9), boneJoint.mul(bare));
  const rift = smoothstep(0.06, 0.26, scorch).mul(bare);
  const split = smoothstep(crackW.mul(0.75), 0.0, crackN).mul(rift);
  const rim = smoothstep(crackW.mul(6), crackW, crackN).mul(rift);
  col = col.mul(float(1).sub(rim.mul(0.5)));
  rough = mix(rough, float(0.6), rim);
  const fissure = split.mul(2.3).add(rim.mul(0.1));
  // the chamber's dangers (hazardLook, from the run's Hazards)
  const brinkD = m.g.mul(BRINK_SCALE);
  let hazardGlow: any = vec3(0);
  // the forge's magma vents: a scorched mouth in the floor with cracks running
  // out from it, the magma showing in them, glowing hotter as a blast builds
  // and flaring white as it goes
  for (const v of ventLook) {
    const off = xz.sub(v.xy);
    const d = length(off);
    const apron = smoothstep(2.1, 1.1, d);
    const ray = abs(sin(atan(off.y, off.x).mul(3.5).add(wornN.mul(2.4)).add(d.mul(0.9))));
    const fissure = smoothstep(0.17, 0.0, ray).mul(smoothstep(2.0, 0.8, d)).mul(smoothstep(0.4, 0.65, d));
    const mouth = smoothstep(0.62, 0.36, d);
    const lip = smoothstep(0.3, 0.0, abs(d.sub(0.66)));
    const heat = v.z;
    const flash = v.w;
    col = col.mul(float(1).sub(apron.mul(0.5)).sub(mouth.mul(0.4)));
    rough = mix(rough, float(0.9), apron.mul(0.7));
    // (a raised lip round the mouth)
    nrm = nrm.add(vec3(off.x, 0, off.y).div(max(d, 0.05)).mul(smoothstep(0.95, 0.66, d).mul(smoothstep(0.4, 0.66, d)).mul(0.8)));
    const hot = heat.mul(heat);
    hazardGlow = hazardGlow
      .add(vec3(1.0, 0.36, 0.08).mul(mouth.mul(hot.mul(4).add(0.45)).add(fissure.mul(heat.mul(2.6).add(0.3))).add(lip.mul(heat).mul(0.8)).add(apron.mul(flash).mul(2.5))))
      .add(vec3(1.0, 0.82, 0.5).mul(mouth.mul(hot.mul(2.5).add(flash.mul(4)))));
  }
  // slag spat out of the lava: a puddle with a ragged edge, molten when it
  // lands, a black crust forming over it as it cools with the glow only in its
  // cracks
  // (one set of noise shared by every puddle: the shader runs over the whole floor)
  const churn = mx_noise_float(vec3(xz.x.mul(1.3), xz.y.mul(1.3), time.mul(0.35)));
  const raggedN = mx_noise_float(xz.mul(1.4).add(31.7)).mul(0.35);
  const crustN = mx_noise_float(xz.mul(1.1).add(57.3)).mul(0.3);
  const seamN = smoothstep(0.08, 0.015, abs(mx_noise_float(xz.mul(2.2).add(83.1))));
  for (const sl of slagLook) {
    const off = xz.sub(sl.xy);
    const d = length(off).add(raggedN);
    const inside = smoothstep(sl.z, sl.z.sub(0.25), d).mul(step(0.01, sl.z));
    const heat = sl.w;
    // the crust closes in from the rim as it cools, in plates, the melt glowing in the seams between them
    const within = smoothstep(0.0, 1.1, sl.z.sub(d));
    const lip = smoothstep(0.35, 0.0, abs(d.sub(sl.z.sub(0.12)))).mul(step(0.01, sl.z));
    const crustAt = float(1).sub(within).mul(0.55).add(crustN).add(0.2);
    const open = smoothstep(0.06, -0.06, crustAt.sub(heat.mul(0.9))).mul(inside).mul(float(1).sub(lip.mul(0.6)));
    const seam = seamN.mul(inside).mul(float(1).sub(open));
    col = mix(col, vec3(0.045, 0.032, 0.027), inside.mul(0.95));
    col = mix(col, vec3(0.4, 0.12, 0.03), open);
    rough = mix(rough, float(0.85), inside);
    rough = mix(rough, float(0.3), open);
    nrm = nrm.add(vec3(off.x, 0, off.y).div(max(length(off), 0.05)).mul(lip.mul(0.5)));
    hazardGlow = hazardGlow
      .add(vec3(1.0, 0.3, 0.05).mul(open.mul(smoothstep(-0.4, 0.7, churn).mul(1.2).add(0.6)).add(seam.mul(heat.mul(1.6).add(0.25)))))
      .add(vec3(1.0, 0.6, 0.2).mul(open.mul(heat.mul(heat)).mul(smoothstep(0.3, 0.8, churn)).mul(0.9)));
  }
  // (one fine drifting noise breaks up both the flood's lapping line and the dark's tendrils: no depth has both)
  const edgeN = mx_noise_float(vec3(xz.x.mul(1.7), xz.y.mul(1.7), time.mul(0.6)));
  // the Drowned Halls' flood: the floor near the water gone under it, glassy
  // and rippling, deeper and darker toward the water, the soul light
  // wavering over it, and a pale foaming line where it laps at the dry stone
  const floodAt = brinkD.add(wornN.mul(0.35));
  const flooding = step(0.01, floodReach).mul(floorW).mul(soul);
  const flood = smoothstep(floodReach, floodReach.sub(0.25), floodAt).mul(flooding);
  const deep = smoothstep(floodReach, float(0), floodAt).mul(flood);
  const lap = exp(abs(floodAt.sub(floodReach).add(edgeN.mul(0.12))).mul(-10)).mul(flooding).mul(edgeN.mul(0.35).add(0.8));
  const caustic = pow(float(1).sub(abs(churn)), 7);
  col = mix(col, mix(col.mul(vec3(0.24, 0.32, 0.36)), vec3(0.01, 0.026, 0.032), deep.mul(0.75)), flood);
  rough = mix(rough, float(0.02), flood);
  nrm = mix(nrm, rippleN, flood);
  hazardGlow = hazardGlow
    .add(vec3(0.2, 0.55, 0.7).mul(flood.mul(caustic.mul(float(1).sub(deep.mul(0.6))).mul(0.4).add(0.04))))
    .add(vec3(0.65, 0.88, 1.0).mul(lap.mul(0.55)));
  // the Abyss's creeping dark: the floor going black from the void inward in
  // curling tendrils, a sickly light just inside its edge
  const curl = mx_noise_float(vec3(xz.x.mul(0.45), xz.y.mul(0.45), time.mul(0.25))).mul(0.9);
  const darkEdge = darkReach.add(curl).add(edgeN.mul(0.45));
  const creeping = step(0.01, darkReach).mul(floorW).mul(abyss);
  const dark = smoothstep(darkEdge.add(0.2), darkEdge.sub(0.5), brinkD).mul(creeping);
  const darkFront = exp(max(darkEdge.sub(brinkD), 0).mul(-4)).mul(dark);
  col = col.mul(float(1).sub(dark.mul(0.97)));
  rough = mix(rough, float(0.95), dark);
  hazardGlow = hazardGlow.add(underworldGlow.mul(darkFront.mul(0.14)));
  // the Abyss's brink cracking before it gives way: a ring split round the
  // patch and cracks across it, the spirit light showing through
  for (const g of gapLook) {
    const off = xz.sub(g.xy);
    const d = length(off);
    const inside = smoothstep(g.z.add(0.15), g.z.sub(0.15), d).mul(step(0.01, g.z));
    const crack = min(g.w, 1);
    const across = smoothstep(0.12, 0.0, abs(sin(atan(off.y, off.x).mul(2.5).add(wornN.mul(3)).add(d.mul(1.6)))));
    const ring = smoothstep(0.16, 0.0, abs(d.sub(g.z.mul(0.94))));
    const split = max(across.mul(smoothstep(0.2, 0.6, crack)), ring).mul(inside).mul(smoothstep(0.0, 0.25, crack));
    col = col.mul(float(1).sub(split.mul(0.75)));
    hazardGlow = hazardGlow.add(underworldGlow.mul(split.mul(crack.mul(2.6))));
  }
  // and where it gave way, the ground falls into the void (a ragged edge, one vertex in)
  let drop: any = float(0);
  const dropN = mx_noise_float(positionLocal.xz.mul(2.1)).mul(0.4);
  for (const g of gapLook) {
    const d = length(positionLocal.xz.sub(g.xy)).add(dropN);
    drop = max(drop, smoothstep(g.z.add(0.1), g.z.sub(0.2), d).mul(step(0.01, g.z)).mul(max(g.w.sub(1), 0)));
  }
  mat.positionNode = positionLocal.sub(vec3(0, drop, 0));
  mat.colorNode = col.mul(float(1).sub(sunk.mul(0.92)));
  mat.normalNode = transformNormalToView(nrm.normalize());
  mat.roughnessNode = rough;
  mat.metalnessNode = float(0);
  // the chamber exhales once it is cleared: a wave of the depth's light runs
  // out from where the last foe fell, every vein, seam and crack swelling as
  // it passes, a front of light over the bare stone between them (brightest
  // over the Drowned Halls' wet floor, which has the fewest veins to carry it)
  const behind = length(xz.sub(clearWave.xy)).sub(clearWave.z.mul(CLEAR_WAVE.speed)).abs();
  const fading = smoothstep(CLEAR_WAVE.time, CLEAR_WAVE.time * 0.35, clearWave.z).mul(clearWave.w);
  const crest = exp(behind.mul(-0.35)).mul(fading);
  const edge = exp(behind.mul(-1.4)).mul(fading).mul(floorW);
  const lit = veins.add(seep).add(lavaJoint.mul(2.2)).add(fissure).mul(crest.mul(3).add(1)).add(crest.mul(0.06)).add(edge.mul(soul.mul(0.6).add(0.3)));
  mat.emissiveNode = underworldGlow
    .mul(lit.mul(float(1).sub(sunkGlow)).add(runes).add(bowl).mul(breathe))
    .add(vec3(1.0, 0.72, 0.42).mul(molten.mul(1.5)))
    .mul(float(1).sub(dark.mul(0.97)))
    .add(hazardGlow.mul(float(1).sub(sunkGlow)));
  return mat;
}
