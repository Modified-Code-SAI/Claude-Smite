import * as THREE from 'three/webgpu';
import { abs, attribute, float, mix, smoothstep, uv, vec4 } from '../render/tsl';
import { objectUniforms, useUniforms } from '../render/shared';

/** Segments one arc mesh can hold (main bolt plus forks). */
const MAX_SEGMENTS = 256;

type P = THREE.Vector3;

/** Each arc's own values for the material every arc shares: colors, and 0..1 brightness. */
const arcUniforms = () => ({ main: new THREE.Color(), core: new THREE.Color(), fade: 1 });
let arcMaterial: THREE.MeshBasicNodeMaterial | null = null;

function makeArcMaterial(): THREE.MeshBasicNodeMaterial {
  const { main, core, fade } = objectUniforms(arcUniforms());
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, forceSinglePass: true });
  const across = abs(uv().y.sub(0.5)).mul(2);
  const filament = smoothstep(1, 0.15, across);
  const heat = attribute('heat', 'float');
  const c = mix(main, core, smoothstep(0.55, 0, across).mul(heat));
  mat.colorNode = vec4(c.mul(float(3).add(heat.mul(9))).mul(filament).mul(fade), 1);
  mat.opacityNode = filament.mul(fade);
  return mat;
}

/**
 * Jagged lightning: a bolt split by midpoint displacement, drawn as two
 * crossed ribbons per segment so it reads from every camera angle without
 * knowing where the camera is. White-hot center, god-colored edges, HDR so
 * bloom turns it into a glowing filament.
 */
export class ArcView {
  readonly group = new THREE.Group();
  readonly values = arcUniforms();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly pos = new Float32Array(MAX_SEGMENTS * 8 * 3);
  private readonly heat = new Float32Array(MAX_SEGMENTS * 8);
  private segments = 0;
  /** The upload ranges, reused so a redraw allocates nothing. */
  private readonly posRange = { start: 0, count: 0 };
  private readonly heatRange = { start: 0, count: 0 };

  constructor() {
    const index: number[] = [];
    const uvs = new Float32Array(MAX_SEGMENTS * 8 * 2);
    for (let s = 0; s < MAX_SEGMENTS; s++) {
      for (let q = 0; q < 2; q++) {
        const b = s * 8 + q * 4;
        index.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
        // u along the segment, v across the ribbon
        uvs.set([0, 0, 0, 1, 1, 0, 1, 1], b * 2);
      }
    }
    this.geometry.setIndex(index);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setAttribute('heat', new THREE.BufferAttribute(this.heat, 1));
    const mesh = new THREE.Mesh(this.geometry, (arcMaterial ??= makeArcMaterial()));
    mesh.name = 'arc';
    mesh.frustumCulled = false;
    mesh.renderOrder = 14;
    useUniforms(this.values, mesh);
    this.group.add(mesh);
    this.geometry.setDrawRange(0, 0);
  }

  setColors(main: number, core: number): void {
    this.values.main.setHex(main);
    this.values.core.setHex(core);
  }

  clear(): void {
    this.segments = 0;
    this.geometry.setDrawRange(0, 0);
  }

  /** Add a jagged bolt from a to b. `jag` is sideways wander as a share of its length. */
  bolt(a: P, b: P, width: number, jag = 0.18, heat = 1, depth = 4): void {
    this.draw(jagged(a, b, jag, depth), width, heat);
  }

  /** A bolt with a few forks branching off it. */
  strike(a: P, b: P, width: number, forks = 3, jag = 0.18): void {
    const n = jagged(a, b, jag, 4);
    // the forks reuse the bolt scratch, so the trunk keeps its own copy to branch from
    for (let i = 0; i < n * 3; i++) trunk[i] = points[i]!;
    this.draw(n, width, 1);
    const len = a.distanceTo(b);
    for (let f = 0; f < forks; f++) {
      const i = (1 + Math.floor(Math.random() * (n - 2))) * 3;
      FROM.set(trunk[i]!, trunk[i + 1]!, trunk[i + 2]!);
      DIR.subVectors(b, a).normalize();
      DIR.x += (Math.random() - 0.5) * 1.6;
      DIR.y += (Math.random() - 0.5) * 0.8;
      DIR.z += (Math.random() - 0.5) * 1.6;
      TO.copy(FROM).addScaledVector(DIR.normalize(), len * (0.15 + Math.random() * 0.2));
      this.bolt(FROM, TO, width * 0.5, 0.3, 0.5, 3);
    }
  }

  /** Ribbon every span of the `n` points in the bolt scratch, tapering toward the tip. */
  private draw(n: number, width: number, heat: number): void {
    const first = this.segments;
    // taper toward the tip so the bolt looks like it strikes, not like a tube
    for (let i = 1; i < n; i++) this.segment((i - 1) * 3, i * 3, width * (1 - (i / n) * 0.55), heat);
    this.geometry.setDrawRange(0, this.segments * 12);
    if (this.segments === first) return;
    // upload only the spans in use: the buffers hold room for 256
    upload(this.geometry.getAttribute('position') as THREE.BufferAttribute, this.posRange, this.segments * 24);
    upload(this.geometry.getAttribute('heat') as THREE.BufferAttribute, this.heatRange, this.segments * 8);
  }

  /** Two crossed ribbons from scratch point `ia` to `ib`, written straight into the buffers. */
  private segment(ia: number, ib: number, w: number, heat: number): void {
    if (this.segments >= MAX_SEGMENTS) return;
    const s = this.segments++;
    const pts = points;
    const ax = pts[ia]!, ay = pts[ia + 1]!, az = pts[ia + 2]!;
    const bx = pts[ib]!, by = pts[ib + 1]!, bz = pts[ib + 2]!;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    // two perpendicular widths, so one ribbon always faces the camera somewhat:
    // the first is d x Y (d x X for a near-vertical bolt), the second d x first
    const upright = Math.abs(dy) > 0.9 * Math.sqrt(dx * dx + dy * dy + dz * dz);
    let p1x = upright ? 0 : -dz;
    let p1y = upright ? dz : 0;
    let p1z = upright ? -dy : dx;
    const half = w / 2;
    const k1 = half / (Math.sqrt(p1x * p1x + p1y * p1y + p1z * p1z) || 1);
    p1x *= k1;
    p1y *= k1;
    p1z *= k1;
    let p2x = dy * p1z - dz * p1y, p2y = dz * p1x - dx * p1z, p2z = dx * p1y - dy * p1x;
    const k2 = half / (Math.sqrt(p2x * p2x + p2y * p2y + p2z * p2z) || 1);
    p2x *= k2;
    p2y *= k2;
    p2z *= k2;
    const pos = this.pos;
    const o = s * 24;
    quad(pos, o, ax, ay, az, bx, by, bz, p1x, p1y, p1z);
    quad(pos, o + 12, ax, ay, az, bx, by, bz, p2x, p2y, p2z);
    this.heat.fill(heat, s * 8, s * 8 + 8);
  }
}

/** One ribbon's four corners: a and b, each pushed either way along p. */
function quad(pos: Float32Array, o: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, px: number, py: number, pz: number): void {
  pos[o] = ax - px;
  pos[o + 1] = ay - py;
  pos[o + 2] = az - pz;
  pos[o + 3] = ax + px;
  pos[o + 4] = ay + py;
  pos[o + 5] = az + pz;
  pos[o + 6] = bx - px;
  pos[o + 7] = by - py;
  pos[o + 8] = bz - pz;
  pos[o + 9] = bx + px;
  pos[o + 10] = by + py;
  pos[o + 11] = bz + pz;
}

/** Mark the first `count` values of an attribute for upload, reusing one range object. */
function upload(attr: THREE.BufferAttribute, range: { start: number; count: number }, count: number): void {
  range.count = count;
  if (attr.updateRanges[0] !== range) {
    attr.clearUpdateRanges();
    attr.updateRanges.push(range);
  }
  attr.needsUpdate = true;
}

/** Most points one bolt can have: six halvings of a single span. */
const MAX_POINTS = 65;
const ping = new Float32Array(MAX_POINTS * 3);
const pong = new Float32Array(MAX_POINTS * 3);
/** The scratch holding the latest bolt's points (one of ping or pong). */
let points = ping;
/** A strike's main bolt, kept while its forks reuse the scratch. */
const trunk = new Float32Array(MAX_POINTS * 3);
const FROM = new THREE.Vector3();
const TO = new THREE.Vector3();
const DIR = new THREE.Vector3();

/**
 * Split a to b by midpoint displacement into the bolt scratch and return how
 * many points it has. Each level walks from the tip back, as the old splice
 * did, so the same random draws land on the same kinks.
 */
function jagged(a: P, b: P, jag: number, depth: number): number {
  let src = ping;
  let dst = pong;
  src[0] = a.x;
  src[1] = a.y;
  src[2] = a.z;
  src[3] = b.x;
  src[4] = b.y;
  src[5] = b.z;
  let n = 2;
  const len = a.distanceTo(b);
  let amp = len * jag;
  // long bolts get more kinks so they never read as straight lines
  const levels = Math.min(6, Math.max(depth, Math.ceil(Math.log2(len / 1.5))));
  for (let d = 0; d < levels; d++) {
    const last = (n - 1) * 3;
    const tip = (2 * n - 2) * 3;
    dst[tip] = src[last]!;
    dst[tip + 1] = src[last + 1]!;
    dst[tip + 2] = src[last + 2]!;
    for (let i = n - 1; i > 0; i--) {
      const p = (i - 1) * 3;
      const q = i * 3;
      const m = (2 * i - 1) * 3;
      const t = 0.4 + Math.random() * 0.2;
      dst[m] = src[p]! + (src[q]! - src[p]!) * t + (Math.random() - 0.5) * amp;
      dst[m + 1] = src[p + 1]! + (src[q + 1]! - src[p + 1]!) * t + (Math.random() - 0.5) * amp;
      dst[m + 2] = src[p + 2]! + (src[q + 2]! - src[p + 2]!) * t + (Math.random() - 0.5) * amp;
      const o = (2 * i - 2) * 3;
      dst[o] = src[p]!;
      dst[o + 1] = src[p + 1]!;
      dst[o + 2] = src[p + 2]!;
    }
    n = 2 * n - 1;
    const swap = src;
    src = dst;
    dst = swap;
    amp *= 0.5;
  }
  points = src;
  return n;
}
