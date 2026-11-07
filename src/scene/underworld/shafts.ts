import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ChamberDef, Palette } from '../../map/UnderworldLayout';
import {
  abs, atan, attribute, cameraPosition, dot, float, fract, hash, instanceIndex, length, max, mix, normalize, positionGeometry, positionWorld, pow, sin, smoothstep, time, uniform, uniformArray, varying, vec3, vec4,
} from '../../render/tsl';

/** The most shafts a chamber shows. The mesh always draws this many; the unused ones shrink to nothing (a new instance count would build the shader again). */
export const MAX_SHAFTS = 6;

/**
 * Which way the shafts lean, in meters across per meter up: toward the
 * underworld's light from above (Environment.underworld puts it at elevation
 * 74°, azimuth -150°), so they slant the way its shadows fall.
 */
export const SHAFT_TILT: readonly [number, number] = (() => {
  const d = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 74), THREE.MathUtils.degToRad(-150));
  return [d.x / d.y, d.z / d.y];
})();

/** How one depth's light falls. */
interface Shine {
  count: number;
  /** Radius (m) at the floor, and how bright. */
  radius: number;
  strength: number;
  color: number;
  /** Smoke rolling through the beams, rippling light from water above, motes rising up the beams. */
  smoke: number;
  caustic: number;
  rise: number;
}

const SHINES: Record<Palette, Shine> = {
  // the Ashen Depths: warm light through the forges' smoke, the smoke rolling through it
  ember: { count: 4, radius: 1.6, strength: 0.24, color: 0xffa868, smoke: 1, caustic: 0, rise: 0 },
  // the Drowned Halls: cold light through the water over the halls, rippling as it falls
  soul: { count: 5, radius: 1.7, strength: 0.22, color: 0x86c8ff, smoke: 0.3, caustic: 1, rise: 0 },
  // the Abyss: the last thin light of the living from far above, souls drifting up toward it
  spirit: { count: 3, radius: 1.1, strength: 0.13, color: 0xa8ffcc, smoke: 0.2, caustic: 0, rise: 1 },
};

/** How high the beams reach (m): well above anything the camera sees. */
const HEIGHT = 26;

/**
 * Shafts of light falling slantwise into the shown chamber, one look per
 * depth, each ending in a soft pool on the floor: one additive draw, shaped
 * and animated entirely in its shaders, so changing chamber or depth is a
 * few uniform writes.
 */
export class Shafts {
  readonly mesh: THREE.Mesh;
  /** Each shaft's (world x, world z, radius, strength). */
  private readonly spots = uniformArray(Array.from({ length: MAX_SHAFTS }, () => new THREE.Vector4()), 'vec4');
  /** (smoke, caustic, rise, unused). */
  private readonly form = uniform(new THREE.Vector4());
  private readonly tint = uniform(new THREE.Color());
  private readonly placed = new Map<string, [number, number, number][]>();
  private shine: Shine = SHINES.ember;
  private chamber: ChamberDef | null = null;

  constructor() {
    // a beam (an open tube, y 0 to 1) and the pool it makes on the floor
    const tube = new THREE.CylinderGeometry(1, 1, 1, 24, 8, true);
    tube.translate(0, 0.5, 0);
    tube.setAttribute('part', new THREE.Float32BufferAttribute(new Float32Array(tube.attributes.position!.count), 1));
    const pool = new THREE.CircleGeometry(1, 32);
    pool.rotateX(-Math.PI / 2);
    pool.setAttribute('part', new THREE.Float32BufferAttribute(new Float32Array(pool.attributes.position!.count).fill(1), 1));
    const geo = mergeGeometries([tube, pool], false)!;

    const spot = this.spots.element(instanceIndex);
    const part = attribute('part', 'float');
    const p = positionGeometry;
    const y = p.y.mul(HEIGHT);
    // a little narrower toward the opening it falls from
    const r = spot.z.mul(mix(float(1), float(0.6), p.y));
    const beam = vec3(spot.x.add(p.x.mul(r)).add(y.mul(SHAFT_TILT[0])), y, spot.y.add(p.z.mul(r)).add(y.mul(SHAFT_TILT[1])));
    // the pool, a little wider than the beam and just above the slabs
    const floorSpot = vec3(spot.x.add(p.x.mul(spot.z).mul(1.5)), 0.04, spot.y.add(p.z.mul(spot.z).mul(1.5)));
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    mat.fog = false;
    // added light comes out the same in any order, so both faces go in one draw
    mat.forceSinglePass = true;
    mat.positionNode = mix(beam, floorSpot, part);

    // (worked out per vertex: which shaft is drawn is only known there)
    const strength = varying(spot.w);
    const seed = varying(hash(instanceIndex.toFloat().add(4.2)).mul(6.283));
    const world = positionWorld;
    const view = normalize(cameraPosition.sub(world));
    const near = length(cameraPosition.sub(world));
    const [smoke, caustic, rise] = [this.form.x, this.form.y, this.form.z];
    const t = time;

    // the beam: thickest seen through its middle and fading softly to nothing
    // at its edges, so it reads as lit haze rather than a solid column; it
    // thins toward the floor and fades into the dark above
    const across = normalize(vec3(p.x, 0, p.z));
    const thick = pow(abs(dot(across, view)), float(5));
    const along = smoothstep(0, 7, y).mul(0.6).add(0.4).mul(smoothstep(0, 0.8, y)).mul(smoothstep(HEIGHT, HEIGHT * 0.3, y));
    // brighter and dimmer rays running down it, drifting round slowly
    const around = atan(p.z, p.x);
    const rays = sin(around.mul(5).add(y.mul(0.31)).add(t.mul(0.33)).add(seed)).mul(0.22).add(sin(around.mul(3).sub(t.mul(0.21)).add(seed.mul(2))).mul(0.14)).add(0.75);
    // smoke rolling slowly through the light in thick and thin bands
    const rolling = sin(y.mul(0.5).sub(t.mul(0.5)).add(around.mul(2)).add(seed)).mul(0.3).add(sin(y.mul(0.23).add(t.mul(0.31)).add(seed.mul(3))).mul(0.25)).mul(smoke).add(1);
    // light through moving water: it wavers as it falls, and where it lands
    // the ripples above draw their bright web on the floor
    const waver = sin(y.mul(1.3).sub(t.mul(2.1)).add(around.mul(4)).add(seed)).mul(sin(y.mul(0.7).add(t.mul(1.3)).sub(around.mul(3)))).mul(0.4).add(0.85);
    const sx = world.x.sub(world.y.mul(SHAFT_TILT[0]));
    const sz = world.z.sub(world.y.mul(SHAFT_TILT[1]));
    const ripples = abs(sin(sx.mul(2.3).add(t.mul(1.1))).add(sin(sz.mul(2.9).sub(t.mul(0.9)))).add(sin(sx.sub(sz).mul(1.7).add(t.mul(0.7))))).div(3);
    // souls drifting up toward the light, as faint rings climbing the beam
    const climb = smoothstep(0.86, 1, fract(y.mul(0.22).sub(t.mul(0.32)).add(seed))).mul(rise).mul(1.6);
    const beamGlow = thick.mul(along).mul(rays.mul(mix(float(1), waver, caustic)).mul(rolling).add(climb));

    // the pool: soft-edged, with the beam's ripples in it
    const fromMid = length(p.xz);
    const poolGlow = smoothstep(1, 0.15, fromMid).mul(0.9).mul(mix(float(1), pow(ripples, float(1.6)).mul(3), caustic));

    const fade = smoothstep(1.5, 4, near).mul(smoothstep(62, 46, near));
    mat.colorNode = vec4(this.tint, 1);
    mat.opacityNode = max(mix(beamGlow, poolGlow, part), 0).mul(strength).mul(fade);

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'light-shafts';
    (this.mesh as any).count = MAX_SHAFTS;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 10;
    this.setDepth('ember');
  }

  /** Lights a chamber's floor with the current depth's shafts. */
  showChamber(c: ChamberDef): void {
    this.chamber = c;
    this.update();
  }

  /** Swaps in a depth's light. */
  setDepth(p: Palette): void {
    this.shine = SHINES[p];
    const s = this.shine;
    this.form.value.set(s.smoke, s.caustic, s.rise, 0);
    this.tint.value.setHex(s.color);
    this.update();
  }

  private update(): void {
    const c = this.chamber;
    const s = this.shine;
    const at = c ? this.spotsFor(c, s) : [];
    for (let i = 0; i < MAX_SHAFTS; i++) {
      const v = this.spots.array[i] as THREE.Vector4;
      const spot = at[i];
      if (spot && c) v.set(c.x + spot[0], c.z + spot[1], spot[2], s.strength);
      else v.set(0, 0, 0, 0);
    }
  }

  private spotsFor(c: ChamberDef, s: Shine): [number, number, number][] {
    const key = `${c.name}|${s.count}|${s.radius}`;
    let at = this.placed.get(key);
    if (!at) {
      at = placeShafts(c, s.count, s.radius);
      this.placed.set(key, at);
    }
    return at;
  }
}

/**
 * Where a chamber's shafts fall (local x, z and radius): spread apart over its
 * floor, clear of the walls, the gates' lanes, the middle (where the
 * landmarks stand), the braziers and, all the way up their slant, the
 * pillars.
 */
export function placeShafts(c: ChamberDef, count: number, radius: number): [number, number, number][] {
  const sizes = [1, 0.85, 1.15, 0.92, 1.08, 0.8];
  const middle = 4.5;
  const clear = (x: number, z: number, r: number): boolean => {
    if (Math.hypot(x, z) < middle + r) return false;
    // (its pool of light all on the floor, well clear of the walls; it may fall beside the lava or the drop)
    if (c.sd(x, z) < r + 0.4 || c.cave(x, z) < r + 2.2) return false;
    // (the walls lean outward above the floor, so partway up is enough; over lava, water or void it falls freely)
    if (c.cave(x + SHAFT_TILT[0] * 6, z + SHAFT_TILT[1] * 6) < 0.5) return false;
    // the way in and out stays dark, so the gates read
    if (Math.abs(x) < 3.5 + r && Math.abs(z) > c.extent - 9) return false;
    for (const [fx, fz] of c.fires) if (Math.hypot(x - fx, z - fz) < r + 2) return false;
    for (const [px, pz, pr] of c.pillars) {
      for (let h = 0; h <= 12; h += 2) {
        if (Math.hypot(x + SHAFT_TILT[0] * h - px, z + SHAFT_TILT[1] * h - pz) < pr + r + 0.8) return false;
      }
    }
    return true;
  };
  const free: [number, number][] = [];
  for (let d = 2; d < 30; d += 1) {
    for (let k = 0; k < 36; k++) {
      const a = (k / 36) * Math.PI * 2;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (clear(x, z, radius * 1.15)) free.push([x, z]);
    }
  }
  if (!free.length) return [];
  // the first a little off to one side of the middle, then each as far from the others as it can be
  const out: [number, number, number][] = [];
  let first = free[0]!;
  for (const f of free) if (Math.abs(Math.hypot(f[0], f[1]) - middle - 4) + Math.abs(f[1]) * 0.1 < Math.abs(Math.hypot(first[0], first[1]) - middle - 4) + Math.abs(first[1]) * 0.1) first = f;
  out.push([first[0], first[1], radius * sizes[0]!]);
  while (out.length < count) {
    let best: [number, number] | null = null;
    let bestD = 0;
    for (const f of free) {
      let d = Infinity;
      for (const o of out) d = Math.min(d, Math.hypot(f[0] - o[0], f[1] - o[1]));
      if (d > bestD) {
        bestD = d;
        best = f;
      }
    }
    if (!best || bestD < 6) break;
    out.push([best[0], best[1], radius * sizes[out.length]!]);
  }
  return out;
}
