import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { smoothstep as sstep } from '../../core/random';
import { CHAMBERS, chamberField, type ChamberDef, type Palette } from '../../map/UnderworldLayout';
import {
  attribute, cos, float, mix, mx_noise_float, positionWorld, sin, smoothstep, time, uniform, vec2, vec3, vec4,
} from '../../render/tsl';

/** The two sheets the mist is drawn in (m above the floor): a denser one low down and a thinner one over it. */
const SHEETS = [0.14, 0.5] as const;
/** How far apart (m) the mist's grid points lie. */
const STEP = 1.5;

/** How one depth's mist lies and moves. */
interface Lie {
  /** How thick it gets at its thickest, and its color. */
  density: number;
  color: number;
  /** The way it drifts (m/s), how fast it turns round the chamber (rad/s), and how quickly it churns. */
  wind: readonly [number, number];
  turn: number;
  churn: number;
  /** How much of the floor it covers: 0 a few patches, 1 nearly all of it. */
  cover: number;
}

const LIES: Record<Palette, Lie> = {
  // the Ashen Depths: smoke from the forges drifting low across the floor
  ember: { density: 0.27, color: 0xa0705a, wind: [0.55, 0.2], turn: 0, churn: 0.07, cover: 0.45 },
  // the Drowned Halls: cold mist standing over the wet stone, barely moving
  soul: { density: 0.22, color: 0x8db4d6, wind: [0.12, -0.08], turn: 0, churn: 0.035, cover: 0.65 },
  // the Abyss: spirit mist turning slowly round the chamber
  spirit: { density: 0.22, color: 0x7ae0a8, wind: [0, 0], turn: 0.035, churn: 0.09, cover: 0.5 },
};

/**
 * Mist lying ankle-deep over the shown chamber's floor, one kind per depth:
 * forge smoke, cold crypt mist, turning spirit mist. One draw: every
 * chamber's sheets are in the one mesh, and showing a chamber picks its part
 * with the draw range, so moving on never builds a shader. It thins out
 * before the walls and the Burning Pit's rim (each grid point knows how far
 * inside the floor it lies), so it never cuts a hard line across the stone.
 */
export class Mist {
  readonly mesh: THREE.Mesh;
  /** (density, cover, churn, turn). */
  private readonly lie = uniform(new THREE.Vector4());
  /** (wind x, wind z, center x, center z). */
  private readonly flow = uniform(new THREE.Vector4());
  private readonly tint = uniform(new THREE.Color());
  private readonly ranges: [number, number][] = [];
  private shine: Lie = LIES.ember;

  constructor() {
    const parts: THREE.BufferGeometry[] = [];
    let start = 0;
    for (const c of CHAMBERS) {
      const geo = mistSheets(c);
      const count = geo.index!.count;
      this.ranges.push([start, count]);
      start += count;
      parts.push(geo);
    }
    const geo = mergeGeometries(parts, false)!;
    for (const p of parts) p.dispose();

    const xz = positionWorld.xz;
    const sheet = attribute('sheet', 'float');
    const inside = attribute('inside', 'float');
    const [density, cover, churn, turn] = [this.lie.x, this.lie.y, this.lie.z, this.lie.w];
    // drifting with the wind, and in the Abyss turning about the chamber's middle as a whole
    const a = time.mul(turn);
    const rel = xz.sub(this.flow.zw);
    const turned = vec2(rel.x.mul(cos(a)).sub(rel.y.mul(sin(a))), rel.x.mul(sin(a)).add(rel.y.mul(cos(a))));
    const p = turned.sub(this.flow.xy.mul(time));
    // big slow banks of it, churning in place, frayed by a finer layer
    const banks = mx_noise_float(vec3(p.mul(0.13), time.mul(churn).add(sheet.mul(3.1))));
    const fray = mx_noise_float(vec3(p.mul(0.41).add(vec2(11.7, 4.3)), time.mul(churn.mul(2.3)).add(sheet.mul(1.7))));
    const thick = smoothstep(mix(float(0.45), float(-0.35), cover), 0.65, banks.add(fray.mul(0.45)));
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.forceSinglePass = true;
    mat.colorNode = vec4(vec3(this.tint).mul(thick.mul(0.35).add(0.85)), 1);
    mat.opacityNode = thick.mul(inside).mul(density).mul(mix(float(1), float(0.6), sheet));

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'ground-mist';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // under the ground decals and telegraphs, so they read through it
    this.mesh.renderOrder = 3;
    this.setDepth('ember');
    this.showChamber(CHAMBERS[0]!);
  }

  /** Lays the mist over one chamber's floor. */
  showChamber(c: ChamberDef): void {
    const [start, count] = this.ranges[CHAMBERS.indexOf(c)] ?? [0, 0];
    this.mesh.geometry.setDrawRange(start, count);
    this.flow.value.z = c.x;
    this.flow.value.w = c.z;
  }

  /** Swaps in a depth's mist. */
  setDepth(p: Palette): void {
    const s = (this.shine = LIES[p]);
    this.lie.value.set(s.density, s.cover, s.churn, s.turn);
    this.flow.value.x = s.wind[0];
    this.flow.value.y = s.wind[1];
    this.tint.value.setHex(s.color);
  }

  /** The current depth's mist (for tests). */
  get look(): Readonly<Lie> {
    return this.shine;
  }
}

/** How far into the mist a point on the floor lies, 0 (none) to 1: it thins out over the last meters before the walls and the pit's rim. */
export function mistInside(c: ChamberDef, lx: number, lz: number): number {
  return sstep(0.6, 2.6, chamberField(c, lx, lz));
}

/** One chamber's sheets of mist in world space: a grid over its floor at each height, each point carrying `sheet` and `inside`. */
function mistSheets(c: ChamberDef): THREE.BufferGeometry {
  const half = c.extent + 1;
  const n = Math.ceil((half * 2) / STEP);
  const sheets: THREE.BufferGeometry[] = [];
  SHEETS.forEach((y, k) => {
    const g = new THREE.PlaneGeometry(half * 2, half * 2, n, n);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position!;
    const inside = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      inside[i] = mistInside(c, pos.getX(i), pos.getZ(i));
      pos.setXYZ(i, pos.getX(i) + c.x, y, pos.getZ(i) + c.z);
    }
    g.setAttribute('inside', new THREE.Float32BufferAttribute(inside, 1));
    g.setAttribute('sheet', new THREE.Float32BufferAttribute(new Float32Array(pos.count).fill(k), 1));
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    sheets.push(g);
  });
  const geo = mergeGeometries(sheets, false)!;
  for (const s of sheets) s.dispose();
  return geo;
}
