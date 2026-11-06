import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeSkinned } from '../../scene/merge';
import { buildLods } from '../../scene/lod';

/** Gods with a built model in public/models/gods (see tools/gods/build.py). */
export const GOD_IDS = ['zeus', 'thor', 'odin', 'loki', 'anubis', 'thanatos', 'kukulkan'] as const;
export type GodId = (typeof GOD_IDS)[number];

export interface GodAsset {
  id: string;
  scene: THREE.Group;
  /** Clips retargeted for this god (hips translation scaled to its size). */
  clips: Map<string, THREE.AnimationClip>;
  meta: GodMeta;
}

/** Per-god data the build script stores in the GLB (`extras` on the root node). */
export interface GodMeta {
  hipsScale: number;
  height: number;
  /** Hands that close around a held weapon ('L', 'R'). */
  grip?: string[];
  /** Finger rotations applied on top of every clip to close the gripping hand: bone-local axis, radians. */
  curl?: { bone: string; axis: number[]; angle: number }[];
  /** Simulated cloth and hair sheets (see Physics.ts). */
  cloths?: ClothSpec[];
  /** Capsules the sheets collide with: two points in model (bind) space on one bone. */
  colliders?: { bone: string; a: number[]; b: number[]; r: number }[];
}

export interface ClothSpec {
  name: string;
  material: string;
  rows: number;
  cols: number;
  /** rows * cols rest points in model (bind) space, row-major, row 0 at the pinned edge. */
  points: number[][];
  uvs?: number[][];
  /** Bones the particles follow, and each particle's index into `drive`. */
  drive: string[];
  driveIndex: number[];
  /** Per particle: 1 = pinned, else how strongly it is pulled back to its animated rest point. */
  stiffness: number[];
  gravity?: number;
  damping?: number;
}

const assets = new Map<string, GodAsset>();
let loading: Promise<void> | null = null;
let clipsGltf: Promise<{ animations: THREE.AnimationClip[] }> | null = null;
const extra = new Map<string, Promise<void>>();
// the built game ships the models meshopt-compressed (scripts/meshopt.mjs)
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const base = () => `${import.meta.env.BASE_URL}models/gods/`;

function sharedClips(): Promise<{ animations: THREE.AnimationClip[] }> {
  return (clipsGltf ??= loader.loadAsync(`${base()}clips.glb`));
}

/** Loads one model and retargets the shared clips to it; false if it isn't built. */
async function loadOne(id: string, clips: { animations: THREE.AnimationClip[] }): Promise<boolean> {
  let gltf;
  try {
    gltf = await loader.loadAsync(`${base()}${id}.glb`);
  } catch {
    return false;
  }
  widenVertexFormats(gltf.scene);
  // coarser levels of each piece for distance (scene/lod.ts), carried through the merges
  await buildLods(gltf.scene);
  // one draw per material instead of one per armor piece
  mergeSkinned(gltf.scene);
  const root = gltf.scene.getObjectByName('god') ?? gltf.scene;
  const meta = root.userData as GodMeta;
  const retargeted = new Map<string, THREE.AnimationClip>();
  for (const c of clips.animations) {
    const clip = c.clone();
    for (const t of clip.tracks) {
      if (t.name.endsWith('.position')) {
        // clone() shares the value array between clips, so replace it
        t.values = Float32Array.from(t.values, (x) => x * meta.hipsScale);
      }
    }
    retargeted.set(clip.name, clip);
  }
  assets.set(id, { id, scene: gltf.scene, clips: retargeted, meta });
  return true;
}

/** Loads every god model and the shared clips once. Await before creating god models. */
export function preloadGodAssets(onProgress?: (fraction: number) => void): Promise<void> {
  loading ??= (async () => {
    let done = 0;
    const tick = () => onProgress?.(++done / (GOD_IDS.length + 1));
    const clips = await sharedClips();
    tick();
    // a god not built yet falls back to Zeus's body
    await Promise.all(GOD_IDS.map(async (id) => {
      await loadOne(id, clips);
      tick();
    }));
  })();
  return loading;
}

/**
 * Loads a model only one mode uses (the Jötunn), once, after the gods. Every
 * match preloads the gods; this keeps the rest off their download.
 */
export function loadGodAsset(id: string): Promise<void> {
  let p = extra.get(id);
  if (!p) {
    p = (async () => {
      await preloadGodAssets();
      if (!assets.has(id) && !(await loadOne(id, await sharedClips()))) throw new Error(`model ${id} missing`);
    })();
    extra.set(id, p);
  }
  return p;
}

/**
 * WebGPU has no one- or three-component 8/16-bit vertex formats (three.js
 * throws "Vertex format not supported yet" and nothing draws), so attributes
 * like the baked `_ao` (normalized uint8 scalar) become plain floats.
 */
function widenVertexFormats(scene: THREE.Object3D): void {
  scene.traverse((o) => {
    const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!geo) return;
    for (const [name, attr] of Object.entries(geo.attributes)) {
      if (!(attr instanceof THREE.BufferAttribute) || attr.array instanceof Float32Array) continue;
      if (attr.itemSize !== 1 && attr.itemSize !== 3) continue;
      const out = new Float32Array(attr.count * attr.itemSize);
      for (let i = 0; i < attr.count; i++) {
        for (let c = 0; c < attr.itemSize; c++) out[i * attr.itemSize + c] = attr.getComponent(i, c);
      }
      geo.setAttribute(name, new THREE.BufferAttribute(out, attr.itemSize));
    }
  });
}

export function godAsset(id: string): GodAsset {
  const a = assets.get(id) ?? assets.get('zeus');
  if (!a) throw new Error('God models not loaded: await preloadGodAssets() first');
  return a;
}
