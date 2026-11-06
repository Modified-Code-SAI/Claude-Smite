import * as THREE from 'three/webgpu';
import {
  attribute, cross, int, ivec2, min, mix, modelNormalMatrix, modelWorldMatrix, normalGeometry, normalLocal, normalize,
  positionGeometry, positionPrevious, textureLoad, varying, vec3, vec4,
} from '../../render/tsl';
import { objectUniforms } from '../../render/shared';
import { MaterialLibrary, type SurfaceSpace, type TextureLibrary } from '../Materials';

/**
 * Baked collapses (tools/collapse/bake.py): a Tower's keep, crown and roof
 * breaking into blocks that fall into a pile, a Phoenix's bird bursting into
 * feathers that drift down and burn away. Each is the pieces' rest geometry
 * and, for every frame, each piece's position, turn and scale, kept in a float
 * texture the vertex shader reads: one mesh and one draw per material however
 * many pieces fall, and the frames blend, so it plays smoothly at any rate.
 *
 * The pieces are drawn in materials built to read their rest pose (see
 * `SurfaceSpace`), so a block keeps its stone, cracks and grime as it tumbles,
 * and turns the normals it is lit with along with it.
 */

export type CollapseName = 'tower' | 'phoenix';

export interface CollapseAsset {
  readonly name: CollapseName;
  /** Rest geometry in the structure's own space: position, normal, uv, piece; one group per material. */
  readonly geometry: THREE.BufferGeometry;
  /** The game material each geometry group is drawn in, by name (see the models). */
  readonly materials: string[];
  readonly frames: number;
  readonly fps: number;
  /** Seconds from the first frame to the last. */
  readonly duration: number;
  /** Width = pieces; row 0 = pivots, then per frame a row of (position, scale) and a row of turns. */
  readonly motion: THREE.DataTexture;
  /** The rest pose, for materials (see `SurfaceSpace`). */
  readonly space: SurfaceSpace;
  /** The animated position, normal turn and previous position, for `Collapse`. */
  readonly nodes: { position: any; turn: (v: any) => any; previous: any };
}

/** Object space of the materials' own noise, per collapse: the Phoenix's bird was modeled small and raised. */
const LOCAL: Record<CollapseName, (p: any) => any> = {
  tower: (p) => p,
  phoenix: (p) => p.sub(vec3(0, 5.3, 0)).div(1.45),
};

const assets = new Map<CollapseName, CollapseAsset>();

/** Loads the baked collapses (call once at startup); a missing one leaves its structure sinking as before. */
export async function loadCollapses(): Promise<void> {
  await Promise.all((['tower', 'phoenix'] as const).map(async (name) => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}models/collapse/${name}.bin`);
      if (!res.ok) return;
      let buf = await res.arrayBuffer();
      const head = new Uint8Array(buf, 0, 2);
      if (head[0] === 0x1f && head[1] === 0x8b) {
        buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      }
      assets.set(name, parse(name, buf));
    } catch (e) {
      console.warn(`collapse ${name} not loaded`, e);
    }
  }));
}

export function collapseAsset(name: CollapseName): CollapseAsset | null {
  return assets.get(name) ?? null;
}

const libraries = new WeakMap<TextureLibrary, Map<CollapseName, MaterialLibrary>>();

/** The material library again, every material reading `asset`'s rest pose. One per textures and collapse. */
export function collapseLibrary(asset: CollapseAsset, textures: TextureLibrary): MaterialLibrary {
  let byName = libraries.get(textures);
  if (!byName) libraries.set(textures, (byName = new Map()));
  let lib = byName.get(asset.name);
  if (!lib) byName.set(asset.name, (lib = new MaterialLibrary(textures, asset.space)));
  return lib;
}

/** Each collapse's frame (and the frame drawn before it, for motion blur and TAA), per mesh. */
const collapseUniforms = () => ({ frame: 0, framePrev: 0 });

function parse(name: CollapseName, buf: ArrayBuffer): CollapseAsset {
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'CLPS') throw new Error('not a collapse');
  const [, pieces, frames, fps, vertices, indices, groupCount] = Array.from({ length: 7 }, (_, i) => dv.getUint32(4 + i * 4, true)) as number[];
  let o = 32;
  const groups: { name: string; start: number; count: number }[] = [];
  for (let g = 0; g < groupCount!; g++) {
    const bytes = new Uint8Array(buf, o, 24);
    const end = bytes.indexOf(0);
    groups.push({ name: new TextDecoder().decode(bytes.subarray(0, end < 0 ? 24 : end)), start: dv.getUint32(o + 24, true), count: dv.getUint32(o + 28, true) });
    o += 32;
  }
  const take = (n: number) => {
    const a = new Float32Array(buf, o, n);
    o += n * 4;
    return a;
  };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(take(vertices! * 3), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(take(vertices! * 3), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(take(vertices! * 2), 2));
  geometry.setAttribute('piece', new THREE.BufferAttribute(take(vertices!), 1));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, o, indices!), 1));
  o += indices! * 4;
  groups.forEach((g, i) => geometry.addGroup(g.start, g.count, i));
  // the pieces fly: bound everything they reach rather than the rest pose
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 4, 0), 16);
  const motion = new THREE.DataTexture(take(pieces! * (1 + 2 * frames!) * 4), pieces!, 1 + 2 * frames!, THREE.RGBAFormat, THREE.FloatType);
  motion.needsUpdate = true;
  const asset = { name, geometry, materials: groups.map((g) => g.name), frames: frames!, fps: fps!, duration: (frames! - 1) / fps!, motion };
  return { ...asset, ...build(asset) };
}

/** Turns `v` by the unit quaternion `q`. */
const rotate = (q: any, v: any) => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2));

function build(a: { name: CollapseName; frames: number; motion: THREE.DataTexture }): Pick<CollapseAsset, 'space' | 'nodes'> {
  const { frame, framePrev } = objectUniforms(collapseUniforms());
  const piece = int(attribute('piece', 'float'));
  const last = a.frames - 1;
  const at = (row: any) => textureLoad(a.motion, ivec2(piece, row));
  /** The piece's position and scale, and its turn, at `f` frames in (blending the two frames around it). */
  const pose = (f: any) => {
    const f0 = f.floor();
    const k = f.sub(f0);
    const i0 = int(f0);
    const i1 = min(i0.add(1), int(last));
    const move = mix(at(i0.mul(2).add(1)), at(i1.mul(2).add(1)), k);
    const turn = normalize(mix(at(i0.mul(2).add(2)), at(i1.mul(2).add(2)), k));
    return { move, turn };
  };
  const pivot = at(int(0)).xyz;
  const place = (f: any) => {
    const p = pose(f);
    return { position: rotate(p.turn, positionGeometry.sub(pivot).mul(p.move.w)).add(p.move.xyz), turn: p.turn };
  };
  const now = place(frame);
  const turnV = varying(now.turn, 'v_collapseTurn');
  const space: SurfaceSpace = {
    world: varying(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz, 'v_collapseRestWorld'),
    normal: varying(modelNormalMatrix.mul(normalGeometry), 'v_collapseRestNormal').normalize(),
    local: varying(LOCAL[a.name](positionGeometry), 'v_collapseRestLocal'),
    turn: (n: any) => rotate(normalize(turnV), n),
  };
  return { space, nodes: { position: now.position, turn: (v: any) => rotate(now.turn, v), previous: place(framePrev).position } };
}

const animated = new WeakSet<THREE.Material>();

/** Has `mat` (built from `collapseLibrary` or `asset.space`) draw its pieces where the bake put them. */
function animate(mat: THREE.Material, asset: CollapseAsset): void {
  if (animated.has(mat)) return;
  animated.add(mat);
  const m = mat as THREE.NodeMaterial;
  m.positionNode = asset.nodes.position;
  const setup = m.setupPosition;
  m.setupPosition = function (this: THREE.NodeMaterial, builder: any) {
    normalLocal.assign(asset.nodes.turn(normalLocal));
    if (builder.needsPreviousData()) positionPrevious.assign(asset.nodes.previous);
    return setup.call(this, builder);
  };
}

/**
 * One structure's collapse: a mesh over the shared pieces, each drawn in its
 * game material. Hidden until `play` starts it; shown while loading so its
 * shaders are built then.
 */
export class Collapse {
  readonly mesh: THREE.Mesh;
  /** Uniforms the mesh draws with: its frames, plus whatever its materials read (wear, burn). */
  readonly values: Record<string, number>;
  private readonly frames: number;
  private readonly fps: number;

  constructor(readonly asset: CollapseAsset, materials: Record<string, THREE.Material>, extra: Record<string, number> = {}) {
    const list = asset.materials.map((name) => {
      const m = materials[name];
      if (!m) throw new Error(`collapse ${asset.name}: no material for ${name}`);
      animate(m, asset);
      return m;
    });
    this.mesh = new THREE.Mesh(asset.geometry, list);
    this.mesh.name = `collapse-${asset.name}`;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.mesh.userData.shownLater = true;
    this.values = { ...collapseUniforms(), ...extra };
    this.mesh.userData.uniforms = this.values;
    this.frames = asset.frames;
    this.fps = asset.fps;
  }

  /** Shows the collapse `seconds` into its fall (null hides it). */
  play(seconds: number | null): void {
    if (seconds === null) {
      this.mesh.visible = false;
      return;
    }
    const f = Math.min(this.frames - 1, Math.max(0, seconds * this.fps));
    this.values.framePrev = this.mesh.visible ? this.values.frame! : f;
    this.values.frame = f;
    this.mesh.visible = true;
  }
}
