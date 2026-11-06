import * as THREE from 'three/webgpu';
import {
  abs, atan, attribute, float, floor, fract, hash, max, mix, mx_noise_float, positionWorld, sign, smoothstep, step, time, vec3, vec4,
} from '../render/tsl';
import { objectUniforms, useUniforms } from '../render/shared';

export type DecalShape =
  | { type: 'circle'; radius: number }
  | { type: 'ring'; radius: number; width: number }
  | { type: 'rect'; length: number; width: number }
  | { type: 'cone'; range: number; angle: number };

export type DecalStyle = 'telegraph' | 'zone' | 'flash';

const STYLE = { telegraph: 0, zone: 1, flash: 2 } as const;

/** Each decal's own values for the material every decal shares. */
const decalUniforms = () => ({
  color: new THREE.Color(1, 1, 1),
  core: new THREE.Color(1, 1, 1),
  opacity: 1,
  /** 0..1 fill sweep for telegraphs (how charged the cast is). */
  fill: 0,
  /** 0..1 shockwave front for flashes, sweeping out from the caster. */
  wave: 1,
  /** 1 draws a ring of slowly turning runes inside a circle's rim (Odin). */
  glyphs: 0,
  center: new THREE.Vector2(),
  style: 0,
});
let decalMaterial: THREE.MeshBasicNodeMaterial | null = null;

function makeDecalMaterial(): THREE.MeshBasicNodeMaterial {
  const { color, core, opacity, fill, wave, glyphs, center, style } = objectUniforms(decalUniforms());
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const edge = attribute('edge', 'float');
  // 0 at the origin of the shape, 1 at its far end (radius, length or range)
  const along = attribute('along', 'float');
  const rim = smoothstep(0.82, 0.98, edge).mul(smoothstep(1.02, 0.97, edge));
  const wp = positionWorld.xz;
  const t = time;
  // Zones: churning energy (two scrolling noise layers) with bright veins.
  const n1 = mx_noise_float(vec3(wp.x.mul(0.45), wp.y.mul(0.45), t.mul(0.7))).mul(0.5).add(0.5);
  const n2 = mx_noise_float(vec3(wp.x.mul(1.3).add(t.mul(0.6)), wp.y.mul(1.3).sub(t.mul(0.4)), t.mul(0.3))).mul(0.5).add(0.5);
  const veins = smoothstep(0.42, 0.5, n1).mul(smoothstep(0.58, 0.5, n1)).mul(2.5);
  const swirl = n1.mul(0.45).add(n2.mul(0.35)).add(veins);
  // Telegraphs: faint fill, a crisp rim, and a pulse sweeping outward.
  const pulse = smoothstep(0.08, 0.0, abs(edge.sub(fract(t.mul(0.9))))).mul(0.6);
  const telegraphFill = float(0.16).add(pulse.mul(edge));
  const charged = smoothstep(fill.add(0.02), fill, edge).mul(0.25);

  // Flashes: a bright front sweeps outward, leaving a fading wash and crackle behind it.
  const front = smoothstep(0.16, 0.0, abs(along.sub(wave))).mul(2.6);
  const behind = smoothstep(wave.add(0.02), wave.sub(0.05), along);
  const crackle = smoothstep(0.46, 0.5, n2).mul(smoothstep(0.54, 0.5, n2)).mul(1.8);
  const flashBody = front.add(behind.mul(float(0.3).add(crackle).mul(float(1.15).sub(wave))));
  const flashRim = behind.mul(rim);

  // Runes: a band of procedural glyphs (staves, branches, ticks) framed by two thin circles.
  const local = wp.sub(center);
  const turn = atan(local.x, local.y).div(6.2832).add(0.5).add(t.mul(0.02));
  const cells = turn.mul(22);
  const cell = floor(cells);
  const u = fract(cells);
  const rr = edge.sub(0.7).div(0.16);
  const inBand = step(0, rr).mul(step(rr, 1));
  const h1 = hash(cell);
  const h2 = hash(cell.add(31.7));
  const stroke = (d: any) => smoothstep(0.1, 0.04, abs(d));
  const stave = stroke(u.sub(0.5)).mul(step(0.12, rr)).mul(step(rr, 0.88));
  const branch = stroke(u.sub(0.5).sub(rr.sub(0.5).mul(sign(h1.sub(0.5))).mul(0.7))).mul(step(0.35, h2));
  const tick = stroke(rr.sub(h1.mul(0.5).add(0.25)).mul(1.4)).mul(step(abs(u.sub(0.5)), 0.28)).mul(step(h2, 0.6));
  const frame = stroke(edge.sub(0.68).mul(4)).add(stroke(edge.sub(0.88).mul(4)));
  const runes = max(max(stave, branch), tick).mul(inBand).add(frame.mul(0.6)).mul(glyphs).mul(2.4);

  const isZone = smoothstep(0.5, 1.0, style).mul(smoothstep(1.5, 1.0, style));
  const isFlash = smoothstep(1.5, 2.0, style);
  const isTele = float(1).sub(isZone).sub(isFlash);

  const body = isTele.mul(telegraphFill.add(charged)).add(isZone.mul(swirl.mul(1.25))).add(isFlash.mul(flashBody));
  const rimStrength = isTele.mul(2.2).add(isZone.mul(3.0)).add(isFlash.mul(2.0));
  const glyphBody = runes.mul(mix(float(1), behind, isFlash));
  const intensity = glyphBody.add(body).add(rim.mul(rimStrength).mul(float(1).sub(isFlash).add(isFlash.mul(flashRim))));
  // Alpha-blended, not additive: additive light vanishes on the white marble.
  // HDR color (above 1) still feeds bloom so rims and veins glow.
  const hot = mix(color, core, smoothstep(1.2, 2.6, intensity));
  mat.colorNode = vec4(hot.mul(float(0.9).add(intensity.mul(1.4))), 1);
  mat.opacityNode = intensity.mul(0.75).clamp(0, 0.95).mul(opacity);
  return mat;
}

/**
 * A glowing shape painted on the ground. The mesh is rebuilt in world space
 * and every vertex is dropped onto the terrain, so it hugs steps and slopes
 * instead of clipping into them. HDR color, so it feeds bloom.
 *
 * Shapes are built in local space facing -Z (yaw 0), matching the units.
 */
export class GroundDecal {
  readonly mesh: THREE.Mesh;
  readonly values = decalUniforms();
  private local: Float32Array = new Float32Array(0);
  /** The shape the local vertices were laid out for, and its grid (which edge, along and the triangles depend on). */
  private shape: { type: DecalShape['type'] | ''; a: number; b: number } = { type: '', a: NaN, b: NaN };
  private grid = '';
  /** Where it was last conformed, and the ground height under its center then. */
  private placed = { x: NaN, z: NaN, yaw: NaN, lift: NaN, ground: NaN };
  private readonly geometry = new THREE.BufferGeometry();

  constructor(private readonly groundAt: (x: number, z: number) => number) {
    this.mesh = new THREE.Mesh(this.geometry, (decalMaterial ??= makeDecalMaterial()));
    this.mesh.name = 'decal';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.matrixAutoUpdate = false;
    useUniforms(this.values, this.mesh);
    // a shape from the start, so a loading frame can draw it and prepare the shader
    this.ensureShape({ type: 'circle', radius: 1 });
  }

  setStyle(style: DecalStyle): void {
    this.values.style = STYLE[style];
  }

  setColors(main: number, core: number): void {
    this.values.color.setHex(main);
    this.values.core.setHex(core);
  }

  /**
   * Place the shape at (x, z) facing `yaw` and conform it to the ground.
   * Called every frame with the same arguments it does nothing: the mesh is
   * only conformed and uploaded again when the shape, the spot or the
   * ground under it changes.
   */
  place(shape: DecalShape, x: number, z: number, yaw: number, lift = 0.07): void {
    const resized = this.ensureShape(shape);
    const ground = this.groundAt(x, z);
    const at = this.placed;
    if (!resized && x === at.x && z === at.z && yaw === at.yaw && lift === at.lift && ground === at.ground) return;
    at.x = x;
    at.z = z;
    at.yaw = yaw;
    at.lift = lift;
    at.ground = ground;
    this.values.center.set(x, z);
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const local = this.local;
    const n = local.length / 2;
    for (let i = 0; i < n; i++) {
      const lx = local[i * 2]!;
      const lz = local[i * 2 + 1]!;
      const wx = x + lx * cos + lz * sin;
      const wz = z - lx * sin + lz * cos;
      arr[i * 3] = wx;
      arr[i * 3 + 1] = this.groundAt(wx, wz) + lift;
      arr[i * 3 + 2] = wz;
    }
    pos.needsUpdate = true;
  }

  /**
   * Lays the shape out in local space; true when that changed. A new size on
   * the same grid (a telegraph or a pooled flash of a similar size) only
   * moves the vertices; a different grid gets new attributes.
   */
  private ensureShape(shape: DecalShape): boolean {
    const a = shape.type === 'circle' || shape.type === 'ring' ? shape.radius : shape.type === 'rect' ? shape.length : shape.range;
    const b = shape.type === 'circle' ? 0 : shape.type === 'cone' ? shape.angle : shape.width;
    const was = this.shape;
    if (shape.type === was.type && a === was.a && b === was.b) return false;
    was.type = shape.type;
    was.a = a;
    was.b = b;
    const { cols, rows } = gridOf(shape);
    const grid = `${shape.type}:${cols}:${rows}`;
    if (grid === this.grid) {
      layOut(shape, cols, rows, this.local, null, null);
      return true;
    }
    this.grid = grid;
    const n = (cols + 1) * (rows + 1);
    const edge = new Float32Array(n);
    const along = new Float32Array(n);
    this.local = new Float32Array(n * 2);
    layOut(shape, cols, rows, this.local, edge, along);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geometry.setAttribute('edge', new THREE.BufferAttribute(edge, 1));
    this.geometry.setAttribute('along', new THREE.BufferAttribute(along, 1));
    this.geometry.setIndex(new THREE.BufferAttribute(gridIndex(cols, rows, n), 1));
    // (a new grid always needs conforming, even on the same spot)
    this.placed.x = NaN;
    return true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

/** How many columns (around or across) and rows (out from the origin) a shape's grid has. */
function gridOf(shape: DecalShape): { cols: number; rows: number } {
  switch (shape.type) {
    case 'circle':
      return { cols: Math.max(32, Math.ceil(shape.radius * 10)), rows: Math.max(4, Math.ceil(shape.radius / 0.8)) };
    case 'ring':
      return { cols: Math.max(48, Math.ceil(shape.radius * 6)), rows: 2 };
    case 'rect':
      return { cols: 4, rows: Math.max(4, Math.ceil(shape.length / 0.8)) };
    case 'cone':
      return { cols: Math.max(12, Math.ceil(shape.angle / 4)), rows: Math.max(4, Math.ceil(shape.range / 0.8)) };
  }
}

/**
 * Local XZ vertices of the grid, and (when given) each one's edge factor (0
 * center, 1 outline) and how far along it is. Every shape's rows run from its
 * origin (v = 0) to its far end (v = 1); edge and along depend on the grid
 * alone, so a resize on the same grid leaves them be.
 */
function layOut(shape: DecalShape, cols: number, rows: number, local: Float32Array, edge: Float32Array | null, along: Float32Array | null): void {
  let i = 0;
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    for (let c = 0; c <= cols; c++, i++) {
      const u = c / cols;
      let x = 0;
      let z = 0;
      let e = 0;
      switch (shape.type) {
        case 'circle': {
          const ang = u * Math.PI * 2;
          x = Math.sin(ang) * v * shape.radius;
          z = Math.cos(ang) * v * shape.radius;
          e = v;
          break;
        }
        case 'ring': {
          const ang = u * Math.PI * 2;
          const inner = Math.max(0, shape.radius - shape.width);
          const rad = inner + (shape.radius - inner) * v;
          x = Math.sin(ang) * rad;
          z = Math.cos(ang) * rad;
          e = 0.84 + v * 0.16;
          break;
        }
        case 'rect': {
          const across = (u - 0.5) * 2;
          x = (across * shape.width) / 2;
          z = -v * shape.length;
          // outline on both sides and the far end; the near end stays open
          e = Math.max(Math.abs(across), v);
          break;
        }
        case 'cone': {
          const half = (shape.angle * Math.PI) / 360;
          const ang = (u - 0.5) * 2 * half;
          const rad = v * shape.range;
          x = -Math.sin(ang) * rad;
          z = -Math.cos(ang) * rad;
          e = Math.max(v, Math.abs(u - 0.5) * 2);
          break;
        }
      }
      local[i * 2] = x;
      local[i * 2 + 1] = z;
      if (edge) edge[i] = e;
      if (along) along[i] = v;
    }
  }
}

/** Two triangles per grid cell. */
function gridIndex(cols: number, rows: number, verts: number): Uint16Array | Uint32Array {
  const index = verts > 65535 ? new Uint32Array(cols * rows * 6) : new Uint16Array(cols * rows * 6);
  let k = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + cols + 1;
      index[k++] = a;
      index[k++] = b;
      index[k++] = a + 1;
      index[k++] = a + 1;
      index[k++] = b;
      index[k++] = b + 1;
    }
  }
  return index;
}
