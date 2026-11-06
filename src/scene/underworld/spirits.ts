import * as THREE from 'three/webgpu';
import type { ChamberDef, Palette } from '../../map/UnderworldLayout';
import {
  abs, atan, cameraPosition, cos, float, hash, instanceIndex, length, max, min, mix, positionGeometry, pow, sign, sin, smoothstep, time, uniform, varying, vec3, vec4,
} from '../../render/tsl';
import { DEPTH_COLORS } from './palettes';

/**
 * How many can fly at once. The mesh always draws all of them and each depth
 * hides the ones it doesn't use: changing a mesh's instance count would
 * build its shader again mid-run.
 */
const MAX = 12;

/** How one depth's creatures fly and look. */
interface Form {
  /** How many fly, their wingspan (m) and their speed (m/s). */
  count: number;
  size: number;
  speed: number;
  /** Wingbeats a second (as an angle rate), how far the wingtips rise and fall, and a ripple running down the wings. */
  flap: number;
  lift: number;
  wave: number;
  /** Tail length (in wingspans) and how ragged the wings' trailing edge is. */
  tail: number;
  ragged: number;
  /** The band of heights they keep to (m above the floor). */
  low: number;
  high: number;
  /** How bright they burn, and their wings' outline: 0 a bat's swept-back wings, 1 a ray's broad diamond. */
  glow: number;
  sweep: number;
}

const FORMS: Record<Palette, Form> = {
  // the Ashen Depths: cinder bats, small and quick, wheeling under the smoke
  ember: { count: 12, size: 0.9, speed: 6.5, flap: 13, lift: 0.75, wave: 0, tail: 0.1, ragged: 1, low: 6.8, high: 9.2, glow: 2.6, sweep: 0 },
  // the Drowned Halls: drowned souls gliding like rays, their wings rippling
  soul: { count: 6, size: 1.6, speed: 2.1, flap: 1.5, lift: 0.22, wave: 0.7, tail: 1.5, ragged: 0, low: 6.8, high: 8.8, glow: 0.9, sweep: 1 },
  // the Abyss: wraiths trailing long tatters
  spirit: { count: 9, size: 1.15, speed: 3.6, flap: 2.6, lift: 0.32, wave: 0.35, tail: 2.1, ragged: 0.55, low: 7, high: 9.6, glow: 1.1, sweep: 0.55 },
};

/** Keep the paths this far inside the floor's edge (the walls lean outward above it). */
const MARGIN = 1.2;

/**
 * The creatures that glide high over the shown chamber, one kind per depth:
 * a single draw of a few rippling wings, flown and flapped entirely in the
 * vertex shader, so they cost nothing on the CPU and moving down a depth or
 * into the next chamber is a few uniform writes.
 */
export class Spirits {
  readonly mesh: THREE.Mesh;
  /** The shown chamber's center and the half-axes of the oval the creatures fly round. */
  private readonly oval = uniform(new THREE.Vector4(0, 0, 8, 8));
  /** (count, size, speed, flap), (lift, wave, tail, ragged), (low, high, glow, sweep). */
  private readonly formA = uniform(new THREE.Vector4());
  private readonly formB = uniform(new THREE.Vector4());
  private readonly formC = uniform(new THREE.Vector4());
  private readonly tint = uniform(new THREE.Color());
  private readonly ovals = new Map<ChamberDef, [number, number]>();

  constructor() {
    // a wing sheet lying flat, nose toward +z, its tail running back to -z
    const geo = new THREE.PlaneGeometry(2, 3.4, 20, 18);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -0.7);

    const id = instanceIndex.toFloat();
    const [count, size, speed, flap] = [this.formA.x, this.formA.y, this.formA.z, this.formA.w];
    const [lift, wave, tail, ragged] = [this.formB.x, this.formB.y, this.formB.z, this.formB.w];
    const phase = hash(id.add(3.1)).mul(6.283);
    const p = positionGeometry;
    const span = abs(p.x);

    // the wings beat, a ripple runs down them, and the tail sways behind
    const beat = sin(time.mul(flap).add(phase));
    const ripple = sin(time.mul(flap.mul(0.7)).sub(p.z.mul(2.6)).add(phase)).mul(wave).mul(0.22).mul(span.add(0.3));
    const y = beat.mul(lift).mul(pow(span, float(1.4))).add(ripple);
    const behind = smoothstep(-0.2, -2.4, p.z);
    const x = p.x.add(sin(time.mul(flap.mul(0.55).add(1.2)).sub(p.z.mul(2.2)).add(phase)).mul(0.28).mul(behind).mul(min(tail, 1)));
    const scale = size.mul(hash(id.add(9.2)).mul(0.4).add(0.8)).mul(id.lessThan(count).select(1, 0));

    // each flies its own oval round the chamber, a little in or out, rising and falling
    const way = hash(id.add(1.7)).lessThan(0.5).select(-1, 1);
    const reach = hash(id.add(5.3)).mul(0.45).add(0.5).add(sin(time.mul(0.3).add(phase)).mul(0.05));
    const rx = this.oval.z.mul(reach);
    const rz = this.oval.w.mul(reach);
    const angle = phase.add(time.mul(speed).div(rx.add(rz).mul(0.5)).mul(way));
    const at = vec3(
      this.oval.x.add(cos(angle).mul(rx)),
      mix(this.formC.x, this.formC.y, hash(id.add(7.7))).add(sin(time.mul(0.45).add(phase.mul(2))).mul(0.5)),
      this.oval.y.add(sin(angle).mul(rz)),
    );
    // face along the path and bank into the turn
    const tx = sin(angle).mul(rx).negate().mul(way);
    const tz = cos(angle).mul(rz).mul(way);
    const yaw = atan(tx, tz);
    const cy = cos(yaw);
    const sy = sin(yaw);
    const inward = this.oval.x.sub(at.x).mul(cy).sub(this.oval.y.sub(at.z).mul(sy));
    const bank = sign(inward).mul(-0.38);
    const cb = cos(bank);
    const sb = sin(bank);
    const lx = x.mul(cb).sub(y.mul(sb)).mul(scale);
    const ly = x.mul(sb).add(y.mul(cb)).mul(scale);
    const lz = p.z.mul(scale);

    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    mat.fog = false;
    // added light comes out the same in any order, so both faces go in one draw
    mat.forceSinglePass = true;
    const world = vec3(lx.mul(cy).add(lz.mul(sy)), ly, lz.mul(cy).sub(lx.mul(sy))).add(at);
    mat.positionNode = world;

    // the silhouette, drawn from the flat sheet: swept wings with a ragged
    // trailing edge, a slender body, and a tail tapering behind
    const sweep = this.formC.w;
    const zf = float(0.58).sub(mix(pow(span, float(1.3)).mul(0.8), span.mul(0.72), sweep));
    const zb = mix(float(-0.32).add(span.mul(0.22)), float(-0.5).add(span.mul(0.5)), sweep).sub(abs(sin(span.mul(7))).mul(0.26).mul(ragged).mul(smoothstep(0.05, 0.25, span)));
    const edge = min(min(zf.sub(p.z), p.z.sub(zb)), float(1).sub(span));
    // soft edges, so they read as smoke and light rather than cut paper
    const wing = smoothstep(0, 0.22, edge);
    const bx = p.x.div(0.19);
    const bz = p.z.sub(0.12).div(0.62);
    const body = smoothstep(1, 0.2, bx.mul(bx).add(bz.mul(bz)));
    const along = p.z.add(0.3).negate().div(max(tail, 0.05));
    const width = float(0.08).mul(float(1).sub(along)).add(0.012);
    const tailMask = smoothstep(width, width.mul(0.3), span).mul(smoothstep(1, 0.8, along)).mul(smoothstep(-0.15, 0.05, along));
    const shape = max(max(wing, body), tailMask);
    // the leading edges and the body burn brightest
    const rim = smoothstep(0.22, 0.02, zf.sub(p.z)).mul(wing).mul(0.9);
    // (worked out per vertex: which one is drawn is only known there)
    const flicker = varying(sin(time.mul(hash(id).mul(4).add(2)).add(phase)).mul(0.15).add(0.85));
    const near = length(world.sub(cameraPosition));
    const fade = varying(smoothstep(2, 5, near).mul(smoothstep(42, 30, near)));
    mat.colorNode = vec4(this.tint.mul(this.formC.z).mul(rim.add(body.mul(0.8)).add(0.45)).mul(flicker), 1);
    // translucent, like smoke lit from within: thickest along the body and the
    // leading edges, thinning out to the wingtips
    mat.opacityNode = shape.mul(rim.mul(0.5).add(body.mul(0.45)).add(0.28)).mul(float(1).sub(span.mul(0.5))).mul(fade);

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'spirits';
    (this.mesh as any).count = MAX;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 11;
    this.setDepth('ember');
  }

  /** Sends the creatures round a chamber, on the widest oval that keeps clear of its walls. */
  showChamber(c: ChamberDef): void {
    let o = this.ovals.get(c);
    if (!o) {
      o = fitOval(c);
      this.ovals.set(c, o);
    }
    this.oval.value.set(c.x, c.z, o[0], o[1]);
  }

  /** Swaps in a depth's creatures. */
  setDepth(p: Palette): void {
    const f = FORMS[p];
    this.formA.value.set(f.count, f.size, f.speed, f.flap);
    this.formB.value.set(f.lift, f.wave, f.tail, f.ragged);
    this.formC.value.set(f.low, f.high, f.glow, f.sweep);
    this.tint.value.setHex(DEPTH_COLORS[p].motes.color);
  }
}

/** The half-axes of the largest oval round a chamber's center whose every point stays MARGIN inside its floor. */
export function fitOval(c: ChamberDef): [number, number] {
  // out along an axis to the wall (past a pit in the middle, if there is one)
  const reach = (dx: number, dz: number): number => {
    let last = 0;
    for (let r = 0; r < 40; r += 0.25) {
      if (c.sd(dx * r, dz * r) > MARGIN) last = r;
      else if (last > 0) break;
    }
    return last;
  };
  const rx = reach(1, 0);
  const rz = reach(0, 1);
  // shrink it until it clears every bend of the walls
  let s = 1;
  for (let k = 0; k < 64; k++) {
    const a = (k / 64) * Math.PI * 2;
    while (s > 0.2 && c.sd(Math.cos(a) * rx * s, Math.sin(a) * rz * s) <= MARGIN && (!c.pit || Math.hypot(Math.cos(a) * rx * s, Math.sin(a) * rz * s) > c.pit + MARGIN)) s -= 0.02;
  }
  return [rx * s, rz * s];
}
