import * as THREE from 'three/webgpu';
import { abs, cos, float, mix, mx_noise_float, normalView, positionLocal, positionView, sin, smoothstep, time, uv, vec3, vec4 } from '../../render/tsl';
import { objectUniforms, useUniforms } from '../../render/shared';
import type { Live } from './pool';

/** Each funnel's own values for the material every funnel shares. */
const funnelUniforms = () => ({
  main: new THREE.Color(),
  hot: new THREE.Color(),
  bottom: 0.6,
  top: 3,
  height: 6,
  /** Radians a second the streaks wind round. */
  twist: 3,
  /** 0..1 how thick the walls are. */
  density: 0.7,
  /** Light it gives off (0: dust that is only lit). */
  glow: 0,
  /** Sideways sway of its upper part, as a share of the top radius. */
  sway: 0.15,
  fade: 1,
  seed: 0,
});

let material: THREE.MeshBasicNodeMaterial | null = null;

function makeMaterial(): THREE.MeshBasicNodeMaterial {
  const u = objectUniforms(funnelUniforms());
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const v = uv().y;
  const r = mix(u.bottom, u.top, v.pow(1.5));
  const wob = u.sway.mul(u.top).mul(v.pow(1.2));
  const t = time.add(u.seed);
  const lean = vec3(sin(t.mul(1.7).add(v.mul(4))).mul(wob), 0, cos(t.mul(1.3).add(v.mul(3.5))).mul(wob));
  m.positionNode = vec3(positionLocal.x.mul(r), v.mul(u.height), positionLocal.z.mul(r)).add(lean);
  const ang = uv().x.mul(6.2832);
  const spin = ang.mul(1).add(v.mul(2.5)).sub(time.mul(u.twist));
  const n1 = mx_noise_float(vec3(cos(spin).mul(1.6), sin(spin).mul(1.6), v.mul(3).sub(time.mul(0.9)).add(u.seed))).mul(0.5).add(0.5);
  const n2 = mx_noise_float(vec3(cos(spin.mul(2)).mul(3), sin(spin.mul(2)).mul(3), v.mul(7).sub(time.mul(1.6)))).mul(0.5).add(0.5);
  const bands = smoothstep(0.42, 0.78, n1.mul(0.7).add(n2.mul(0.3)));
  const ends = smoothstep(0, 0.12, v).mul(smoothstep(1, 0.7, v));
  // seen edge-on, the walls are deepest
  const rim = float(1).sub(abs(normalView.dot(positionView.normalize()))).pow(0.6);
  const a = bands.mul(0.75).add(0.2).mul(rim.mul(0.6).add(0.4)).mul(ends).mul(u.density);
  m.colorNode = vec4(mix(u.main, u.hot, bands.mul(n2).mul(0.8)).mul(float(1).add(u.glow.mul(bands.mul(2.5).add(0.4)))), 1);
  m.opacityNode = a.clamp(0, 1).mul(u.fade);
  return m;
}

let geometry: THREE.CylinderGeometry | null = null;

export interface FunnelOpts {
  x: number;
  y: number;
  z: number;
  main: number;
  hot: number;
  bottom: number;
  top: number;
  height: number;
  twist?: number;
  density?: number;
  glow?: number;
  sway?: number;
  /** Seconds it lasts (Infinity: until stopped). */
  life: number;
  /** Seconds it takes to rise to full height. */
  grow?: number;
}

/** A spinning vortex: tornadoes, sand walls, rising columns. One shader. */
export class Funnel implements Live {
  readonly group: THREE.Mesh;
  readonly values = funnelUniforms();
  private o!: FunnelOpts;
  private age = 0;
  /** 0..1, set by an owner that keeps it alive (a zone): it fades out when the owner does. */
  strength = 1;

  constructor() {
    // a unit tube from y 0 to 1 whose rings the shader widens
    geometry ??= new THREE.CylinderGeometry(1, 1, 1, 32, 12, true).translate(0, 0.5, 0);
    this.group = new THREE.Mesh(geometry, (material ??= makeMaterial()));
    this.group.name = 'funnel';
    this.group.frustumCulled = false;
    this.group.renderOrder = 11;
    useUniforms(this.values, this.group);
  }

  start(o: FunnelOpts): this {
    this.o = o;
    this.age = 0;
    this.strength = 1;
    const v = this.values;
    v.main.setHex(o.main);
    v.hot.setHex(o.hot);
    v.bottom = o.bottom;
    v.top = o.top;
    v.twist = o.twist ?? 3;
    v.density = o.density ?? 0.7;
    v.glow = o.glow ?? 0;
    v.sway = o.sway ?? 0.15;
    v.seed = Math.random() * 40;
    this.group.position.set(o.x, o.y, o.z);
    this.update(0);
    return this;
  }

  move(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
  }

  /** Ends it soon (its owner is gone). */
  stop(): void {
    this.o.life = Math.min(this.o.life, this.age + 0.5);
  }

  update(dt: number): boolean {
    const o = this.o;
    const k = (this.age += dt);
    const grow = o.grow ?? 0.35;
    const up = Math.min(1, k / grow);
    const v = this.values;
    v.height = o.height * (1 - (1 - up) ** 2);
    const left = o.life - k;
    v.fade = Math.min(1, up * 1.5) * Math.min(1, left / 0.5) * this.strength;
    return k < o.life;
  }
}
