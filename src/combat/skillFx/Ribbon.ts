import * as THREE from 'three/webgpu';
import { abs, cos, float, mix, mx_noise_float, sin, smoothstep, step, uv, vec3, vec4 } from '../../render/tsl';
import { objectUniforms, useUniforms } from '../../render/shared';
import type { Live } from './pool';

const SEGMENTS = 96;

/**
 * Each ribbon's own values for the material every ribbon shares. The band
 * sweeps the arc a0..a0+span (radians) in the plane of `ax` (angle 0) and
 * `ay` (angle 90°); `an` is the band's normal, used by wall bands and spirals.
 */
const ribbonUniforms = () => ({
  main: new THREE.Color(),
  hot: new THREE.Color(),
  ax: new THREE.Vector3(0, 0, -1),
  ay: new THREE.Vector3(1, 0, 0),
  an: new THREE.Vector3(0, 1, 0),
  radius: 1,
  a0: 0,
  span: Math.PI,
  width: 0.6,
  /** 0: the band lies across the arc (a slash); 1: it stands along `an` (a wall, a whirl). */
  wall: 0,
  /** Leading edge along the arc, 0..1, and how much of the arc behind it is lit. */
  head: 1,
  tail: 1,
  /** Width left at the tail end, as a share (blade slashes taper). */
  taper: 1,
  /** Climb along `an` over the arc (spiral wraps). */
  lift: 0,
  fade: 1,
  seed: 0,
});

let material: THREE.MeshBasicNodeMaterial | null = null;

function makeMaterial(): THREE.MeshBasicNodeMaterial {
  const u = objectUniforms(ribbonUniforms());
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const s = uv().x;
  const v = uv().y.sub(0.5);
  const behind = u.head.sub(s);
  // the band narrows toward the tail
  const thin = mix(float(1), u.taper, smoothstep(0, u.tail.max(0.001), behind).clamp(0, 1));
  const ang = u.a0.add(s.mul(u.span));
  const dir = u.ax.mul(cos(ang)).add(u.ay.mul(sin(ang)));
  const across = v.mul(u.width).mul(thin);
  const off = mix(dir.mul(across), u.an.mul(across), u.wall);
  m.positionNode = dir.mul(u.radius).add(off).add(u.an.mul(u.lift.mul(s)));

  const lit = smoothstep(u.tail.add(0.001), u.tail.mul(0.35), behind).mul(smoothstep(-0.004, 0.012, behind));
  const mid = float(1).sub(abs(v).mul(2));
  const body = smoothstep(0, 0.75, mid);
  // streaks running along the swing, drifting with its seed
  const streak = mx_noise_float(vec3(s.mul(u.span.abs().mul(2.2)).add(u.seed), v.mul(5), u.seed.mul(0.37))).mul(0.5).add(0.5);
  const edge = smoothstep(0.07, 0, behind).mul(step(-0.004, behind));
  const glow = lit.mul(body).mul(streak.mul(0.55).add(0.45)).add(edge.mul(mid).mul(1.6));
  const heat = edge.add(smoothstep(0.7, 1, mid).mul(0.6)).clamp(0, 1);
  m.colorNode = vec4(mix(u.main, u.hot, heat).mul(float(1.2).add(glow.mul(3.2))), 1);
  m.opacityNode = glow.clamp(0, 1).mul(u.fade);
  return m;
}

let geometry: THREE.PlaneGeometry | null = null;

export interface RibbonOpts {
  x: number;
  y: number;
  z: number;
  main: number;
  hot: number;
  /** Angle 0 direction and angle 90° direction (unit vectors). */
  ax: THREE.Vector3;
  ay: THREE.Vector3;
  an: THREE.Vector3;
  radius: number;
  /** Radius it grows to over its life (shockwaves); defaults to `radius`. */
  radiusTo?: number;
  a0: number;
  span: number;
  width: number;
  wall?: number;
  /** Seconds the leading edge takes to cross the arc (0: all at once). */
  sweep: number;
  /** Share of the arc lit behind the head. */
  tail?: number;
  taper?: number;
  lift?: number;
  /** Seconds it lasts in all. */
  life: number;
  /** Turns per second the whole arc spins about `an` (whirls). */
  spin?: number;
  /** Stays drawn on once swept (an aura), fading only at the end of its life. */
  hold?: boolean;
}

/**
 * A glowing swept band: blade slashes, hammer swings, whirls, shockwave rings,
 * sound waves and spiral wraps all draw with this one material and geometry.
 */
export class Ribbon implements Live {
  readonly group: THREE.Mesh;
  private readonly values = ribbonUniforms();
  private age = 0;
  private o!: RibbonOpts;
  private readonly baseX = new THREE.Vector3();
  private readonly baseY = new THREE.Vector3();

  constructor() {
    geometry ??= new THREE.PlaneGeometry(1, 1, SEGMENTS, 1);
    this.group = new THREE.Mesh(geometry, (material ??= makeMaterial()));
    this.group.name = 'ribbon';
    this.group.frustumCulled = false;
    this.group.renderOrder = 12;
    useUniforms(this.values, this.group);
  }

  start(o: RibbonOpts): this {
    this.o = o;
    this.age = 0;
    const v = this.values;
    v.main.setHex(o.main);
    v.hot.setHex(o.hot);
    this.baseX.copy(o.ax);
    this.baseY.copy(o.ay);
    v.ax.copy(o.ax);
    v.ay.copy(o.ay);
    v.an.copy(o.an);
    v.radius = o.radius;
    v.a0 = o.a0;
    v.span = o.span;
    v.width = o.width;
    v.wall = o.wall ?? 0;
    v.tail = o.tail ?? 1;
    v.taper = o.taper ?? 1;
    v.lift = o.lift ?? 0;
    v.seed = Math.random() * 50;
    v.head = o.sweep > 0 ? 0 : 1;
    v.fade = 1;
    this.group.position.set(o.x, o.y, o.z);
    return this;
  }

  /** Moves it along with whatever it wraps (a god). */
  follow(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
  }

  /** Ends it in a moment (whoever wore it is gone, or its buff ended). */
  stop(): void {
    this.o.life = Math.min(this.o.life, this.age + 0.5);
  }

  update(dt: number): boolean {
    const o = this.o;
    const k = (this.age += dt);
    const v = this.values;
    const tail = v.tail;
    // the head runs past the end so the tail can sweep off it (unless it holds)
    v.head = o.sweep > 0 ? Math.min(o.hold ? 1 : 1 + tail, k / o.sweep) : 1;
    const out = Math.min(1, k / o.life);
    if (o.radiusTo !== undefined) v.radius = o.radius + (o.radiusTo - o.radius) * (1 - (1 - out) ** 2.2);
    const end = o.hold ? o.life - 0.5 : o.sweep > 0 ? o.sweep * (1 + tail) : 0;
    v.fade = k < end ? 1 : Math.max(0, 1 - (k - end) / Math.max(0.05, o.life - end)) ** 1.4;
    if (o.spin) {
      const a = k * o.spin * Math.PI * 2;
      // turn the plane's axes about the normal (whirls)
      v.ax.copy(this.baseX).applyAxisAngle(o.an, a);
      v.ay.copy(this.baseY).applyAxisAngle(o.an, a);
    }
    return k < o.life;
  }
}
