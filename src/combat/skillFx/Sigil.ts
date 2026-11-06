import * as THREE from 'three/webgpu';
import { abs, cos, exp, float, max, min, mix, sin, smoothstep, step, uv, vec2, vec4 } from '../../render/tsl';
import { objectUniforms, useUniforms } from '../../render/shared';
import type { Live } from './pool';

/** The glyphs a sigil can draw (one shader draws them all). */
export const GLYPHS = { bolt: 0, eye: 1, ankh: 2, algiz: 3, scales: 4, tiwaz: 5 } as const;
export type Glyph = keyof typeof GLYPHS;

const sigilUniforms = () => ({
  main: new THREE.Color(),
  hot: new THREE.Color(),
  glyph: 0,
  /** 0..1 drawn on from the middle out (and an eye opening). */
  open: 1,
  spin: 0,
  fade: 1,
});

/** Distance from p to the segment a-b, with the segment's constants folded in here. */
function seg(p: any, ax: number, ay: number, bx: number, by: number): any {
  const dx = bx - ax;
  const dy = by - ay;
  const inv = 1 / (dx * dx + dy * dy);
  const pa = p.sub(vec2(ax, ay));
  const h = pa.dot(vec2(dx, dy)).mul(inv).clamp(0, 1);
  return pa.sub(vec2(dx, dy).mul(h)).length();
}

const ring = (p: any, cx: number, cy: number, r: number) => abs(p.sub(vec2(cx, cy)).length().sub(r));
/** The lower half of a ring (a balance's pan). */
const bowl = (p: any, cx: number, cy: number, r: number) => max(ring(p, cx, cy, r), p.y.sub(cy));
const lines = (...d: any[]) => d.reduce((a, b) => min(a, b));

let material: THREE.MeshBasicNodeMaterial | null = null;

function makeMaterial(): THREE.MeshBasicNodeMaterial {
  const u = objectUniforms(sigilUniforms());
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const q = uv().sub(0.5).mul(2);
  const c = cos(u.spin);
  const s = sin(u.spin);
  const p = vec2(q.x.mul(c).sub(q.y.mul(s)), q.x.mul(s).add(q.y.mul(c)));
  const frame = ring(p, 0, 0, 0.9);

  const bolt = lines(ring(p, 0, 0, 0.86), seg(p, 0.22, 0.7, -0.18, 0.06), seg(p, -0.18, 0.06, 0.17, 0.02), seg(p, 0.17, 0.02, -0.2, -0.7));
  // an almond eye that opens with `open`: two arcs, an iris and a slit pupil
  const h = u.open.mul(0.44).max(0.03);
  const R = h.mul(h).add(0.64).div(h.mul(2));
  const cc = R.sub(h);
  const lid = abs(max(p.sub(vec2(0, cc.negate())).length().sub(R), p.sub(vec2(0, cc)).length().sub(R)));
  const iris = abs(p.length().sub(u.open.mul(0.25)));
  const pupil = vec2(p.x.mul(2.6), p.y.mul(0.9)).length().sub(u.open.mul(0.2)).max(0);
  const eye = lines(lid, iris, pupil, ring(p, 0, 0, 0.95));
  const loop = abs(vec2(p.x.mul(1.15), p.y.sub(0.42)).length().sub(0.3));
  const ankh = lines(loop, seg(p, 0, 0.12, 0, -0.85), seg(p, -0.45, 0.06, 0.45, 0.06));
  const algiz = lines(frame, seg(p, 0, -0.72, 0, 0.72), seg(p, 0, 0.02, -0.44, 0.56), seg(p, 0, 0.02, 0.44, 0.56));
  const scales = lines(
    seg(p, 0, -0.68, 0, 0.56), seg(p, -0.62, 0.5, 0.62, 0.5), seg(p, -0.3, -0.68, 0.3, -0.68),
    seg(p, -0.62, 0.5, -0.82, 0.02), seg(p, -0.62, 0.5, -0.42, 0.02), bowl(p, -0.62, 0.02, 0.22),
    seg(p, 0.62, 0.5, 0.42, 0.02), seg(p, 0.62, 0.5, 0.82, 0.02), bowl(p, 0.62, 0.02, 0.22),
  );
  const tiwaz = lines(frame, seg(p, 0, -0.72, 0, 0.74), seg(p, 0, 0.74, -0.42, 0.3), seg(p, 0, 0.74, 0.42, 0.3));

  const pick = (k: number) => step(abs(u.glyph.sub(k)), 0.5);
  const d = bolt.mul(pick(0)).add(eye.mul(pick(1))).add(ankh.mul(pick(2))).add(algiz.mul(pick(3))).add(scales.mul(pick(4))).add(tiwaz.mul(pick(5)));
  const core = smoothstep(0.05, 0.015, d);
  const halo = exp(d.mul(-11)).mul(0.55);
  // drawn on from the middle outward (the eye opens instead)
  const reach = mix(u.open.mul(1.35), float(2), pick(1));
  const shown = smoothstep(reach, reach.sub(0.18), q.length());
  const glow = core.add(halo).mul(shown);
  m.colorNode = vec4(mix(u.main, u.hot, core.mul(0.85)).mul(float(1.3).add(glow.mul(3))), 1);
  m.opacityNode = glow.clamp(0, 1).mul(u.fade);
  return m;
}

let geometry: THREE.PlaneGeometry | null = null;

export interface SigilOpts {
  x: number;
  y: number;
  z: number;
  glyph: Glyph;
  size: number;
  main: number;
  hot: number;
  life: number;
  /** Laid on the ground instead of facing the camera. */
  flat?: boolean;
  /** Turns a second. */
  spin?: number;
  /** Meters it rises over its life. */
  rise?: number;
  /** Seconds to draw on. */
  open?: number;
}

/** A glowing glyph: brands over a marked god, runes, an ankh, the Allfather's eye. */
export class Sigil implements Live {
  readonly group: THREE.Mesh;
  private readonly values = sigilUniforms();
  private o!: SigilOpts;
  private age = 0;
  private baseY = 0;
  /** Turned to face the camera every frame (set by the director). */
  facing = true;

  constructor() {
    geometry ??= new THREE.PlaneGeometry(1, 1);
    this.group = new THREE.Mesh(geometry, (material ??= makeMaterial()));
    this.group.name = 'sigil';
    this.group.frustumCulled = false;
    this.group.renderOrder = 13;
    useUniforms(this.values, this.group);
  }

  start(o: SigilOpts): this {
    this.o = o;
    this.age = 0;
    const v = this.values;
    v.main.setHex(o.main);
    v.hot.setHex(o.hot);
    v.glyph = GLYPHS[o.glyph];
    v.spin = 0;
    this.facing = !o.flat;
    this.baseY = o.y;
    this.group.position.set(o.x, o.y, o.z);
    this.group.rotation.set(o.flat ? -Math.PI / 2 : 0, 0, 0);
    this.group.scale.setScalar(o.size);
    this.update(0);
    return this;
  }

  /** Keeps it over whoever carries it. */
  follow(x: number, y: number, z: number): void {
    this.baseY = y;
    this.group.position.set(x, y + this.risen(), z);
  }

  /** Ends it in a moment (whatever carried it is gone). */
  stop(): void {
    this.o.life = Math.min(this.o.life, this.age + 0.2);
  }

  private risen(): number {
    return this.o.rise ? this.o.rise * Math.min(1, this.age / this.o.life) : 0;
  }

  update(dt: number): boolean {
    const o = this.o;
    const k = (this.age += dt);
    const v = this.values;
    v.open = Math.min(1, k / (o.open ?? 0.25));
    v.spin = k * (o.spin ?? 0) * Math.PI * 2;
    const left = o.life - k;
    v.fade = Math.min(1, left / 0.35, k / 0.08);
    // pops in a little larger, then settles
    const pop = 1 + 0.25 * Math.max(0, 1 - k / 0.2);
    this.group.scale.setScalar(o.size * pop);
    this.group.position.y = this.baseY + this.risen();
    return k < o.life;
  }
}
