import * as THREE from 'three/webgpu';
import { abs, float, fract, max, mix, mx_noise_float, normalView, positionView, smoothstep, time, uv, vec3, vec4 } from '../../render/tsl';
import { objectUniforms, useUniforms } from '../../render/shared';
import type { Live } from './pool';

/** Each beam's own values for the material every beam shares. */
const beamUniforms = () => ({
  main: new THREE.Color(),
  hot: new THREE.Color(),
  /** 0..1 along the beam: drawn from `tail` to `head`. */
  head: 1,
  tail: 0,
  fade: 1,
  /** Meters long, so the pattern keeps its scale. */
  length: 10,
  /** How fast the energy streams along it, meters a second. */
  flow: 8,
  /** 0: streaming energy; 1: wound strips of cloth (burial wraps). */
  wraps: 0,
  seed: 0,
});

let material: THREE.MeshBasicNodeMaterial | null = null;

function makeMaterial(): THREE.MeshBasicNodeMaterial {
  const u = objectUniforms(beamUniforms());
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const along = uv().y;
  const around = uv().x;
  // 1 down the middle of the beam as seen from here, 0 at its silhouette
  const facing = abs(normalView.dot(positionView.normalize()));
  const shown = smoothstep(u.head.add(0.004), u.head.sub(0.012), along).mul(smoothstep(u.tail.sub(0.01), u.tail.add(0.03), along));
  const meters = along.mul(u.length);
  const n = mx_noise_float(vec3(meters.mul(0.55).sub(time.mul(u.flow).mul(0.55)), around.mul(5), u.seed)).mul(0.5).add(0.5);
  const energy = facing.pow(1.6).mul(n.mul(0.6).add(0.4)).add(facing.pow(7).mul(1.4));
  // cloth: diagonal bands wound round the beam, frayed by noise, with gold threads
  const wind = fract(meters.mul(0.9).add(around.mul(2)).sub(time.mul(u.flow).mul(0.3)));
  const strip = smoothstep(0.05, 0.16, wind).mul(smoothstep(0.86, 0.72, wind));
  const thread = smoothstep(0.05, 0, abs(wind.sub(0.5)));
  const cloth = strip.mul(n.mul(0.35).add(0.65)).mul(facing.pow(0.4)).add(thread.mul(0.8));
  const tip = smoothstep(0.05, 0, abs(along.sub(u.head))).mul(smoothstep(0.98, 0.9, u.head).add(0.4));
  const glow = mix(energy, cloth, u.wraps).add(tip.mul(1.5));
  const heat = mix(facing.pow(4).add(tip), thread, u.wraps).clamp(0, 1);
  const bright = mix(float(1.4).add(glow.mul(3)), float(1.15).add(thread.mul(2.5)), u.wraps);
  m.colorNode = vec4(mix(u.main, u.hot, heat).mul(bright), 1);
  // an energy beam keeps a solid body in its own color out to the silhouette, so it reads in daylight
  const body = facing.pow(0.6).mul(0.7).mul(float(1).sub(u.wraps));
  m.opacityNode = max(glow, body).clamp(0, 1).mul(shown).mul(u.fade);
  return m;
}

let geometry: THREE.CylinderGeometry | null = null;

export interface BeamOpts {
  from: THREE.Vector3;
  to: THREE.Vector3;
  width: number;
  main: number;
  hot: number;
  /** Seconds the head takes to reach the far end (0: there at once). */
  reach: number;
  /** Seconds it holds at full strength once the head arrives. */
  hold: number;
  /** Seconds it fades over. */
  fadeOut: number;
  /** The tail chases the head (a bolt flying down the line), seconds behind it. */
  chase?: number;
  flow?: number;
  wraps?: boolean;
}

/**
 * A long glowing shaft from one point to another: colossal bolts, channelled
 * gazes, thrust streaks, flung burial wraps, spirit links. One shader.
 */
export class Beam implements Live {
  readonly group: THREE.Mesh;
  private readonly values = beamUniforms();
  private o!: BeamOpts;
  private age = 0;
  readonly from = new THREE.Vector3();
  readonly to = new THREE.Vector3();

  constructor() {
    // an open tube along +Z from 0 to 1, uv.y running along it
    geometry ??= new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    this.group = new THREE.Mesh(geometry, (material ??= makeMaterial()));
    this.group.name = 'beam';
    this.group.frustumCulled = false;
    this.group.renderOrder = 12;
    useUniforms(this.values, this.group);
  }

  start(o: BeamOpts): this {
    this.o = o;
    this.age = 0;
    const v = this.values;
    v.main.setHex(o.main);
    v.hot.setHex(o.hot);
    v.flow = o.flow ?? 8;
    v.wraps = o.wraps ? 1 : 0;
    v.seed = Math.random() * 50;
    this.place(o.from, o.to, o.width);
    this.update(0);
    return this;
  }

  /** Moves its ends (a link that follows two gods). */
  place(from: THREE.Vector3, to: THREE.Vector3, width = this.o.width): void {
    this.from.copy(from);
    this.to.copy(to);
    const len = Math.max(0.01, from.distanceTo(to));
    this.values.length = len;
    this.group.position.copy(from);
    this.group.scale.set(width, width, len);
    this.group.lookAt(to);
  }

  update(dt: number): boolean {
    const o = this.o;
    const k = (this.age += dt);
    const v = this.values;
    v.head = o.reach > 0 ? Math.min(1, k / o.reach) : 1;
    v.tail = o.chase ? Math.max(0, Math.min(1, (k - o.chase) / Math.max(0.01, o.reach))) : 0;
    const held = Math.max(o.reach, o.chase ? o.reach + o.chase : 0) + o.hold;
    v.fade = k < held ? Math.min(1, k / 0.04 + 0.2) : Math.max(0, 1 - (k - held) / Math.max(0.01, o.fadeOut));
    return k < held + o.fadeOut;
  }
}
