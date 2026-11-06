/**
 * Distance levels of detail for the gods. A god is 70-110k triangles, which
 * only matters up close: across the lane it covers a few dozen pixels. Each
 * piece is simplified at load (meshoptimizer) to three coarser levels at a
 * fixed geometric error, the levels ride along through the merges, and every
 * frame each god draws the coarsest level whose error stays under a pixel on
 * screen. A level is only a shorter range of one index buffer over the same
 * vertices, so switching costs no new shaders, buffers or draws.
 */
import * as THREE from 'three/webgpu';
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';
import { slice } from '../core/slices';

/** Geometric error of each level, in model metres (level 0 is the full mesh). */
export const LOD_ERROR = [0, 0.004, 0.01, 0.024] as const;
/** The most a level's error may span on screen, in pixels. */
export const LOD_MAX_PX = 0.6;
/** A coarser level must fit well inside the budget, a finer one must clearly break it, so a god near a boundary doesn't flicker. */
const HYSTERESIS = 0.15;
/** Pieces smaller than this stay whole: their saving isn't worth an extra range. */
const MIN_TRIANGLES = 64;

export interface LodRange {
  start: number;
  count: number;
}

/** Coarser index lists, levels 1..3 (level 0 is the geometry's own index), kept in `geometry.userData.lods`. */
export function lodsOf(geometry: THREE.BufferGeometry): Uint32Array[] | undefined {
  return geometry.userData.lods as Uint32Array[] | undefined;
}

function floats(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number): Float32Array {
  const out = new Float32Array(attr.count * size);
  for (let i = 0; i < attr.count; i++) for (let c = 0; c < size; c++) out[i * size + c] = attr.getComponent(i, c);
  return out;
}

/** Simplifies one indexed piece into `userData.lods`, keeping its normals, colors and baked occlusion close. */
export function buildPieceLods(geometry: THREE.BufferGeometry): void {
  const index = geometry.index;
  const position = geometry.getAttribute('position');
  if (!index || !position) return;
  const base = Uint32Array.from(index.array as ArrayLike<number>);
  if (base.length / 3 < MIN_TRIANGLES) {
    geometry.userData.lods = [base, base, base];
    return;
  }
  const pos = floats(position, 3);
  // attributes the simplifier keeps close: the normal, the vertex color, the baked occlusion
  const parts: [THREE.BufferAttribute | THREE.InterleavedBufferAttribute, number, number][] = [];
  const normal = geometry.getAttribute('normal');
  if (normal) parts.push([normal, 3, 0.5]);
  const color = geometry.getAttribute('color');
  if (color) parts.push([color, 3, 0.5]);
  const ao = geometry.getAttribute('_ao') ?? geometry.getAttribute('_AO');
  if (ao) parts.push([ao, 1, 0.5]);
  const stride = parts.reduce((n, p) => n + p[1], 0);
  const attrs = new Float32Array(position.count * stride);
  const weights: number[] = [];
  let o = 0;
  for (const [a, size, w] of parts) {
    for (let i = 0; i < a.count; i++) for (let c = 0; c < size; c++) attrs[i * stride + o + c] = a.getComponent(i, c);
    for (let c = 0; c < size; c++) weights.push(w);
    o += size;
  }
  const lods: Uint32Array[] = [];
  let prev: Uint32Array = base;
  for (let level = 1; level < LOD_ERROR.length; level++) {
    // each level simplifies the one before, so a coarser level never holds more triangles
    const [out] = stride
      ? MeshoptSimplifier.simplifyWithAttributes(prev, pos, 3, attrs, stride, weights, null, 0, LOD_ERROR[level]!, ['LockBorder', 'ErrorAbsolute'])
      : MeshoptSimplifier.simplify(prev, pos, 3, 0, LOD_ERROR[level]!, ['LockBorder', 'ErrorAbsolute']);
    prev = out.length >= 3 ? new Uint32Array(out) : prev;
    lods.push(prev);
  }
  geometry.userData.lods = lods;
}

/** Builds the levels of every indexed mesh under `root`, yielding to the page between pieces. */
export async function buildLods(root: THREE.Object3D): Promise<void> {
  await MeshoptSimplifier.ready;
  const geos = new Set<THREE.BufferGeometry>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry.index) geos.add(m.geometry);
  });
  for (const g of geos) {
    buildPieceLods(g);
    await slice();
  }
}

/**
 * The levels of merged pieces: piece i's indices, offset by the vertices
 * before it, level by level. `map` rewrites each piece's index list the way the
 * merge rewrites its base index (a shadow stand-in turns faces around).
 * Undefined unless every piece has levels.
 */
export function mergeLods(pieces: readonly THREE.BufferGeometry[], map: (geometry: THREE.BufferGeometry, indices: ArrayLike<number>) => ArrayLike<number> = (_, i) => i): Uint32Array[] | undefined {
  if (!pieces.every((g) => lodsOf(g))) return undefined;
  const out: Uint32Array[] = [];
  for (let level = 0; level < LOD_ERROR.length - 1; level++) {
    const lists = pieces.map((g) => map(g, lodsOf(g)![level]!));
    const merged = new Uint32Array(lists.reduce((n, l) => n + l.length, 0));
    let at = 0;
    let offset = 0;
    pieces.forEach((g, i) => {
      const l = lists[i]!;
      for (let k = 0; k < l.length; k++) merged[at + k] = l[k]! + offset;
      at += l.length;
      offset += g.getAttribute('position').count;
    });
    out.push(merged);
  }
  return out;
}

const drawable = new WeakMap<THREE.BufferGeometry, { index: THREE.BufferAttribute; ranges: LodRange[] }>();

/**
 * One index buffer holding every level back to back, and each level's range
 * in it, made once per geometry and shared by every model drawn from it.
 */
function drawableLods(geometry: THREE.BufferGeometry): { index: THREE.BufferAttribute; ranges: LodRange[] } | null {
  let d = drawable.get(geometry);
  if (d) return d;
  const lods = lodsOf(geometry);
  if (!lods || !geometry.index) return null;
  const levels = [geometry.index.array as ArrayLike<number>, ...lods];
  const total = levels.reduce((n, l) => n + l.length, 0);
  const vertices = geometry.getAttribute('position').count;
  const all = vertices <= 65535 ? new Uint16Array(total) : new Uint32Array(total);
  const ranges: LodRange[] = [];
  let at = 0;
  for (const l of levels) {
    ranges.push({ start: at, count: l.length });
    for (let k = 0; k < l.length; k++) all[at + k] = l[k]!;
    at += l.length;
  }
  d = { index: new THREE.BufferAttribute(all, 1), ranges };
  drawable.set(geometry, d);
  return d;
}

/**
 * A per-model view of a shared geometry: the same vertex buffers and the
 * all-levels index, with a draw range of its own. Null if it has no levels.
 */
export function lodView(geometry: THREE.BufferGeometry): { geometry: THREE.BufferGeometry; ranges: LodRange[] } | null {
  const d = drawableLods(geometry);
  if (!d) return null;
  const view = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes)) view.setAttribute(name, attr);
  view.setIndex(d.index);
  view.boundingSphere = geometry.boundingSphere?.clone() ?? null;
  view.boundingBox = geometry.boundingBox?.clone() ?? null;
  view.userData = geometry.userData;
  const r = d.ranges[0]!;
  view.setDrawRange(r.start, r.count);
  return { geometry: view, ranges: d.ranges };
}

/**
 * The level to draw for a model `pxPerMetre` on screen (pixels per metre of its
 * own geometry), given the level it drew last: the coarsest whose error fits.
 */
export function pickLod(pxPerMetre: number, current: number): number {
  let level = 0;
  for (let l = 1; l < LOD_ERROR.length; l++) {
    const px = LOD_ERROR[l]! * pxPerMetre;
    // a level coarser than the current one must fit with room to spare; the current and finer ones may run up to the margin
    const limit = LOD_MAX_PX * (l > current ? 1 - HYSTERESIS : 1 + HYSTERESIS);
    if (px <= limit) level = l;
  }
  return level;
}

/** URL `?lod=N` pins every god to one level, for comparing them (`?lod=-1` or none: by distance). */
export const FORCED_LOD = (() => {
  if (typeof location === 'undefined') return -1;
  const v = new URLSearchParams(location.search).get('lod');
  const n = v === null ? -1 : Number(v);
  return Number.isInteger(n) && n >= 0 && n < LOD_ERROR.length ? n : -1;
})();
