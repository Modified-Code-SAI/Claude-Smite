/**
 * Poses gods the way the game does (idle clip, stance, finger curl, settled
 * cloth) and exports every visible piece, skinned on the CPU into the god's
 * own space (feet at the origin, facing +Z), for tools/hero/render.py.
 * Open /tools/hero/dump.html?god=<id> on the Vite dev server; the JSON is left
 * in `window.__dump` (tools/hero/README.md has the commands).
 */
import * as THREE from 'three/webgpu';
import { GodModel } from '../../src/actors/GodModel';
import { GOD_IDS, loadGodAsset, preloadGodAssets } from '../../src/actors/gods/assets';
import { paletteOf } from '../../src/actors/gods/materials';
import { mergeSwitch } from '../../src/scene/merge';

type Accent = { bone: string; axis: [number, number, number]; angle: number };

/**
 * Hero posture on top of the idle and the god's own stance, in the god's
 * model space like GodModel's IDLE_STANCE (+Y up, +Z ahead, the right hand
 * toward -X): a little more chest and chin than a god waiting for a fight.
 */
const HERO: Record<string, Accent[]> = {
  zeus: [
    { bone: 'DEF-spine.003', axis: [1, 0, 0], angle: -0.05 },
    { bone: 'DEF-head', axis: [1, 0, 0], angle: -0.04 },
  ],
  thor: [
    { bone: 'DEF-spine.003', axis: [1, 0, 0], angle: -0.06 },
    { bone: 'DEF-head', axis: [1, 0, 0], angle: -0.04 },
  ],
  odin: [{ bone: 'DEF-spine.003', axis: [1, 0, 0], angle: -0.04 }],
  loki: [],
  anubis: [{ bone: 'DEF-spine.003', axis: [1, 0, 0], angle: -0.05 }],
  thanatos: [],
  jotunn: [{ bone: 'DEF-spine.003', axis: [1, 0, 0], angle: -0.05 }],
};

/** Seconds of idle before the snapshot: long enough for capes to settle and the breath to sit high. */
const SETTLE = 3;

interface Piece {
  name: string;
  mat: string;
  n: number;
  pos: string;
  nrm: string;
  uv: string | null;
  col: string | null;
  colSize: number;
  edge: string | null;
  side: string | null;
  ao: string | null;
  head: string;
  idx: string;
}

function b64(a: ArrayBufferView): string {
  const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function scalar(geo: THREE.BufferGeometry, name: string): Float32Array | null {
  const a = geo.getAttribute(name) as THREE.BufferAttribute | undefined;
  if (!a) return null;
  const out = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
  return out;
}

function pieces(root: THREE.Object3D, headBones: Set<THREE.Object3D>): Piece[] {
  root.updateMatrixWorld(true);
  const list: Piece[] = [];
  const M = new THREE.Matrix4();
  const acc = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  root.traverseVisible((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isMesh) return;
    const geo = m.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    const n = pos.count;
    const P = new Float32Array(n * 3);
    const N = new Float32Array(n * 3);
    const H = new Uint8Array(n);
    const si = geo.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const sw = geo.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    const skinned = m.isSkinnedMesh && si && sw;
    if (skinned) m.skeleton.update();
    const bm = skinned ? m.skeleton.boneMatrices! : null;
    for (let i = 0; i < n; i++) {
      if (skinned) {
        acc.elements.fill(0);
        let best = -1;
        let bw = 0;
        for (let k = 0; k < 4; k++) {
          const w = sw!.getComponent(i, k);
          if (!w) continue;
          const b = si!.getComponent(i, k);
          for (let e = 0; e < 16; e++) acc.elements[e]! += w * bm![b * 16 + e]!;
          if (w > bw) {
            bw = w;
            best = b;
          }
        }
        M.multiplyMatrices(m.matrixWorld, m.bindMatrixInverse).multiply(acc).multiply(m.bindMatrix);
        H[i] = best >= 0 && headBones.has(m.skeleton.bones[best]!) ? 1 : 0;
      } else {
        M.copy(m.matrixWorld);
      }
      v.fromBufferAttribute(pos, i).applyMatrix4(M);
      P[i * 3] = v.x;
      P[i * 3 + 1] = v.y;
      P[i * 3 + 2] = v.z;
      nm.getNormalMatrix(M);
      v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
      N[i * 3] = v.x;
      N[i * 3 + 1] = v.y;
      N[i * 3 + 2] = v.z;
    }
    const index = geo.index ? Uint32Array.from(geo.index.array as ArrayLike<number>) : Uint32Array.from({ length: n }, (_, i) => i);
    const uv = scalar(geo, 'uv');
    const col = scalar(geo, 'color');
    const edge = scalar(geo, '_edge');
    const side = scalar(geo, '_side');
    const ao = scalar(geo, '_ao');
    list.push({
      name: m.name || `piece-${list.length}`,
      mat: (m.material as THREE.Material).name || 'default',
      n,
      pos: b64(P),
      nrm: b64(N),
      uv: uv && b64(uv),
      col: col && b64(col),
      colSize: col ? (geo.getAttribute('color') as THREE.BufferAttribute).itemSize : 0,
      edge: edge && b64(edge),
      side: side && b64(side),
      ao: ao && b64(ao),
      head: b64(H),
      idx: b64(index),
    });
  });
  return list;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const id = params.get('god') ?? 'zeus';
  const settle = Number(params.get('t') ?? SETTLE);
  // every piece on its own, by its forge name (render.py folds wings by name)
  mergeSwitch.on = false;
  await preloadGodAssets();
  if (!(GOD_IDS as readonly string[]).includes(id)) await loadGodAsset(id);
  const g = new GodModel(id, undefined, { shadowStandIn: false });
  const scene = new THREE.Scene();
  scene.add(g.root);
  const accents = (HERO[id] ?? []).map((a) => ({ bone: g.bone(a.bone)!, axis: new THREE.Vector3(...a.axis), angle: a.angle })).filter((a) => a.bone);
  g.poseHook = () => {
    for (const a of accents) g.rotateBone(a.bone, a.axis, a.angle);
  };
  const state = { speed: 0, localDir: new THREE.Vector2(), grounded: true, verticalSpeed: 0 };
  for (let t = 0; t < settle; t += 1 / 60) g.animate(1 / 60, state);
  scene.updateMatrixWorld(true);
  const headBones = new Set<THREE.Object3D>();
  g.head.traverse((o) => headBones.add(o));
  const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).toArray().map((x) => +x.toFixed(4));
  const out = {
    id,
    height: g.height,
    palette: paletteOf(id),
    bones: { head: at(g.head), chest: at(g.chest), hips: at(g.hips), handR: at(g.rightHand), handL: at(g.leftHand) },
    pieces: pieces(g.root, headBones),
  };
  (window as any).__dump = JSON.stringify(out);
  const verts = out.pieces.reduce((s, p) => s + p.n, 0);
  document.getElementById('log')!.textContent = `${id}: ${out.pieces.length} pieces, ${verts} vertices`;
}

main().catch((e) => {
  document.getElementById('log')!.textContent = `error: ${e?.stack ?? e}`;
  (window as any).__dump = 'error';
});
