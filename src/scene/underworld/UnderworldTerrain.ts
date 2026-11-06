import * as THREE from 'three/webgpu';
import { fbm2, simplex2, smoothstep as sstep } from '../../core/random';
import { hypot } from '../../core/math';
import { CHAMBERS, chamberAt, underworldField, UNDERWORLD } from '../../map/UnderworldLayout';
import {
  abs, atan, dFdx, dFdy, dot, exp, float, floor, fract, length, max, min, mix, mx_noise_float, select, normalWorld, positionWorld, sin, smoothstep, texture, time, transformNormalToView, vec2, vec3,
} from '../../render/tsl';
import { planar, triplanar, type TextureLibrary } from '../Materials';
import type { Terrain, TerrainDef } from '../Terrain';
import { depthLook, gateOpen, runeRings, underworldGlow } from './palettes';

/** Rune rings carved in each chamber's floor (local center and radius), glowing in the depth's color. */
const RUNES: readonly (readonly [number, number, number])[][] = [
  [[0, 0, 8.4], [0, 0, 3.2]],
  [[0, -12, 4.2], [0, 12, 4.2], [0, 0, 3]],
  [[0, 0, 6.4], [0, 0, 2.6]],
  [[0, 0, 10.6], [0, 0, 16.2]],
  [[0, -10, 5.4], [0, 10, 5.4]],
  [[0, 0, 12.5], [0, 0, 6.5], [0, -14, 3]],
];

/** Width (m) of one glyph's cell around a ring, and half the height of the band of glyphs. */
const GLYPH = 1.1;
const BAND = 0.62;

/** Points the shown chamber's rune rings at its floor. */
export function showRunes(ci: number): void {
  const c = CHAMBERS[ci]!;
  runeRings.forEach((u, k) => {
    const ring = RUNES[ci]?.[k];
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

/**
 * Distance (m) from a floor point to the nearest stroke of one rune ring: two
 * thin guide rings with a script of glyphs between them, each glyph a stem and
 * two branches picked from a hash of its cell, every seventh cell a dot.
 */
function ringDistance(xz: any, ring: any, seed: number): any {
  const p = xz.sub(ring.xy);
  const rho = length(p);
  const y = rho.sub(ring.z);
  const guides = min(abs(y.sub(BAND)), abs(y.add(BAND))).sub(0.012);
  const u = atan(p.y, p.x).div(Math.PI * 2).add(0.5).mul(ring.w);
  const k = floor(u).add(seed * 17);
  const x = fract(u).sub(0.5).mul(rho.mul(Math.PI * 2).div(ring.w));
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
  const mark = select(fract(k.mul(1 / 7)).lessThan(0.1), dotGlyph, glyph);
  return min(guides, mark);
}

/**
 * The underworld's ground: six flat basalt chamber floors sunk into a plateau
 * of black rock, walls rising steeply all round, and a bowl under the Burning
 * Pit's lava. The floors stay at height 0 so fights are on level ground.
 */
export function underworldTerrain(): TerrainDef {
  const n1 = simplex2(301);
  const n2 = simplex2(317);
  const n3 = simplex2(331);
  const H = UNDERWORLD.wallHeight;
  return {
    size: UNDERWORLD.size,
    segments: 512,
    maskSize: UNDERWORLD.size,
    maskRes: 1024,
    height(x, z) {
      const f = underworldField(x, z);
      if (f >= 0) return 0;
      const c = CHAMBERS[chamberAt(x, z)]!;
      if (c.pit) {
        const r = hypot(x - c.x, z - c.z);
        if (r < c.pit + 0.05) return -2.6 * sstep(0, 1.8, c.pit - r);
      }
      // into the wall: a lip of scree, then a steep, ledged cliff
      const d = -f + fbm2(n1, x * 0.11, z * 0.11, 3) * 0.9;
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
      return [ash, 0, scorch, macro];
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
  const runeHalo = exp(runeD.mul(-7)).mul(0.28);
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

  // each depth lays its own slabs: great black ones in the Abyss, the forge's
  // middling basalt, the crypt's small worn paving
  const flag = planar(textures.get('flagstone'), positionWorld.xz.mul(depthTint(float(0.058), float(0.085), float(0.115))), n);
  const dust = planar(textures.get('dirt'), positionWorld.xz.mul(0.23).add(vec2(0.31, 0.17)), n);
  const rock = triplanar(textures.get('rock'), 0.055, 6);
  const fine = triplanar(textures.get('rock'), 0.2, 6);
  // polished black basalt tinted by the depth, the slabs varied by the macro noise
  const basalt = vec3(lum(flag.color)).mul(depthTint(vec3(0.1, 0.112, 0.106), vec3(0.2, 0.158, 0.146), vec3(0.13, 0.15, 0.16))).mul(mix(float(0.75), float(1.2), macro));
  // what has drifted against the walls: in the Abyss pale bone dust, in the
  // Ashen Depths a black crust of cooling lava, in the Drowned Halls the
  // grey-green silt the water left behind
  const ashCol = vec3(lum(dust.color)).mul(depthTint(vec3(0.44, 0.42, 0.37), vec3(0.075, 0.06, 0.055), vec3(0.2, 0.235, 0.215)));
  const ashW = smoothstep(0.2, 0.8, ash.add(dust.color.g.mul(0.6)).sub(0.25));
  let col: any = mix(basalt, ashCol, ashW);
  let nrm: any = mix(flag.normal, dust.normal, ashW);
  // polished enough to catch the braziers' light; the Abyss's slabs are black
  // glass, polished to a mirror between their scratches
  let rough: any = mix(flag.roughness.mul(mix(float(0.5), float(0.32), abyss)).add(mix(float(0.08), float(0.04), abyss)), float(0.95), ashW);

  // rock: dark and faintly banded, steep faces and everything above the floor
  const rockNrm = rock.normal.add(fine.normal).normalize();
  const raw = rock.color.mul(fine.color.mul(1.7));
  const strata = sin(positionWorld.y.mul(1.1).add(rock.color.r.mul(5))).mul(0.5).add(0.5);
  // the Drowned Halls: water running down the rock in dark, glossy streaks
  const streak = smoothstep(0.45, 0.85, sin(xz.x.mul(1.9).add(xz.y.mul(1.6)).add(fine.color.r.mul(5))).mul(0.5).add(0.5)).mul(soul);
  const rockCol = vec3(lum(raw)).mul(depthTint(vec3(0.24, 0.26, 0.25), vec3(0.33, 0.25, 0.215), vec3(0.24, 0.27, 0.28))).mul(mix(float(0.8), float(1.12), strata)).mul(float(1).sub(streak.mul(0.35)));
  const rockW = max(smoothstep(0.82, 0.6, n.y), smoothstep(0.25, 1.2, positionWorld.y));
  col = mix(col, rockCol, rockW);
  nrm = mix(nrm, rockNrm, rockW);
  rough = mix(rough, mix(mix(float(0.7), float(0.92), strata), float(0.3), streak), rockW);
  col = col.mul(float(1).sub(scorch.mul(0.35)));
  // the runes are cut into the slabs: a dark groove around each glowing line
  const floorW = float(1).sub(rockW);
  col = col.mul(float(1).sub(groove.mul(0.6).mul(floorW)));
  rough = mix(rough, float(0.85), groove.mul(floorW));

  // the glow: cracks low on the walls (dark crevices of the rock), the floor's
  // runes and the lava bowl, breathing slowly
  const breathe = sin(time.mul(1.3).add(positionWorld.x.mul(0.07)).add(positionWorld.z.mul(0.05))).mul(0.18).add(0.82);
  // thin branching cracks where a slow noise crosses zero, their width wandering,
  // low on the walls and in the rock's darker grain, each with a scorched crust
  // the rock's own grain shoves the line about, so it zigzags along the crevices like a split in stone
  const jag = fine.color.sub(0.3).mul(0.55).add(rock.color.sub(0.3).mul(0.25));
  const crackN = abs(mx_noise_float(positionWorld.mul(vec3(0.32, 0.5, 0.32)).add(jag)));
  const crackW = mix(float(0.012), float(0.045), smoothstep(-0.4, 0.6, mx_noise_float(positionWorld.mul(0.11).add(7))));
  const grain = smoothstep(0.22, 0.08, lum(raw));
  const low = smoothstep(5.5, 0.4, positionWorld.y);
  const zone = grain.mul(rockW).mul(low);
  const crack = smoothstep(crackW, 0.0, crackN);
  col = col.mul(float(1).sub(smoothstep(crackW.mul(4), crackW, crackN).mul(zone).mul(0.55)));
  // in runs a few meters long, not one unbroken line round the walls
  const veins = crack.mul(zone).mul(smoothstep(-0.4, 0.05, wornN)).mul(3.6);
  // a slow wave of light runs round the rings, and they flare as the way down opens
  const wave = sin(atan(xz.y.sub(runeRings[0].y), xz.x.sub(runeRings[0].x)).mul(3).sub(time.mul(1.4))).mul(0.25).add(0.85);
  const runes = runeCore.mul(2.4).add(runeHalo).mul(floorW).mul(wave).mul(gateOpen.mul(0.7).add(1));
  const bowl = smoothstep(-0.15, -1.6, positionWorld.y).mul(2.2);
  // the Ashen Depths: lava seeping up through the joints between the slabs in
  // patches, and through the cracks in the crust along the walls
  // (in patches a few slabs across, where the runes' wear noise runs high)
  const joint = smoothstep(0.955, 0.998, flag.roughness).mul(smoothstep(0.25, 0.62, wornN)).mul(smoothstep(0.3, 0.55, macro)).mul(float(1).sub(ashW));
  const crustCracks = smoothstep(0.07, 0.0, crackN).mul(ashW);
  const seep = joint.mul(1.25).add(crustCracks.mul(2.4)).mul(floorW).mul(ember);
  col = col.mul(float(1).sub(joint.mul(ember).mul(floorW).mul(0.6)));
  // the Drowned Halls: the slabs are wet, moss grows in their joints, and
  // still water stands in the hollows, stirred by slow ripples
  const wetFloor = floorW.mul(soul);
  const moss = smoothstep(0.955, 0.998, flag.roughness).mul(float(1).sub(ashW));
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
  mat.colorNode = col;
  mat.normalNode = transformNormalToView(nrm.normalize());
  mat.roughnessNode = rough;
  mat.metalnessNode = float(0);
  mat.emissiveNode = underworldGlow.mul(veins.add(runes).add(bowl).add(seep).add(fissure).mul(breathe));
  return mat;
}
