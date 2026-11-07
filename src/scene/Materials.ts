import * as THREE from 'three/webgpu';
import {
  abs, attribute, cameraPosition, cross, dot, float, fract, normalWorld, positionLocal, positionWorld, screenCoordinate, smoothstep, sqrt, texture, transformNormalToView, uniform, vec2, vec3,
} from '../render/tsl';

import { frosted } from './frost';

/** Names of the PBR sets in public/textures/pbr (painted by tools/textures/paint.py over gen.py's layouts). */
export type PbrName = 'flagstone' | 'marble' | 'sandstone_blocks' | 'rock' | 'grass_ground' | 'dirt' | 'bark';

export interface PbrSet {
  /** sRGB base color with baked cavity occlusion. */
  albedo: THREE.Texture;
  /** R,G = tangent normal XY, B = roughness. */
  nr: THREE.Texture;
}

/**
 * Where a material reads the surface it textures: by default the position and
 * normal being drawn. Pieces that move (a collapsing tower's blocks) read their
 * rest pose instead, so the stone stays put on them as they tumble, and turn
 * the normals they light with along with the piece.
 */
export interface SurfaceSpace {
  /** World position the textures and noise are laid on. */
  world: any;
  /** World normal the projections blend by. */
  normal: any;
  /** Object-space position, for noise that belongs to the object. */
  local: any;
  /** Turns a world-space shading normal with the piece (identity when nothing moves). */
  turn(n: any): any;
}

export const drawnSpace: SurfaceSpace = { world: positionWorld, normal: normalWorld, local: positionLocal, turn: (n) => n };

const ALL: PbrName[] = ['flagstone', 'marble', 'sandstone_blocks', 'rock', 'grass_ground', 'dirt', 'bark'];

/**
 * Loads and caches texture sets. Call `load()` once at startup; afterwards
 * `get()` is synchronous so scene builders don't have to await.
 */
export class TextureLibrary {
  private readonly sets = new Map<PbrName, PbrSet>();
  private readonly loader = new THREE.TextureLoader();
  /** 2x2 atlas of leaf sprigs with alpha (see `foliage_atlas` in gen.py). */
  foliage!: THREE.Texture;

  constructor(private readonly anisotropy: number) {}

  async load(onProgress?: (fraction: number) => void): Promise<void> {
    let done = 0;
    const total = ALL.length * 2 + 1;
    const tick = () => onProgress?.(++done / total);
    const foliage = this.loader.loadAsync(`${import.meta.env.BASE_URL}textures/pbr/foliage_atlas.png`).then((t) => {
      tick();
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = this.anisotropy;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      this.foliage = t;
    });
    await Promise.all(ALL.map(async (name) => {
      const base = `${import.meta.env.BASE_URL}textures/pbr/${name}`;
      const [albedo, nr] = await Promise.all([
        this.loader.loadAsync(`${base}_albedo.jpg`).then((t) => (tick(), t)),
        this.loader.loadAsync(`${base}_nr.jpg`).then((t) => (tick(), t)),
      ]);
      albedo.colorSpace = THREE.SRGBColorSpace;
      for (const t of [albedo, nr]) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = this.anisotropy;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
      }
      this.sets.set(name, { albedo, nr });
    }));
    await foliage;
  }

  get(name: PbrName): PbrSet {
    const s = this.sets.get(name);
    if (!s) throw new Error(`Texture set ${name} not loaded`);
    return s;
  }
}

export interface SurfaceNodes {
  color: any;
  /** World-space shading normal. */
  normal: any;
  roughness: any;
  ao: any;
}

/**
 * Triplanar projection of a PBR set in world space, with whiteout normal
 * blending. Lets procedural architecture and cliffs be textured with no UVs
 * and constant texel density (the same trick UE uses for world-aligned materials).
 */
export function triplanar(set: PbrSet, scale: any, sharpness = 4, positionNode: any = positionWorld, normalNode: any = normalWorld): SurfaceNodes {
  const p = positionNode.mul(scale);
  const n = normalNode.normalize();
  const w0 = abs(n).pow(float(sharpness));
  const w = w0.div(w0.x.add(w0.y).add(w0.z));
  const uvX = p.zy;
  const uvY = p.xz;
  const uvZ = p.xy;

  const cx = texture(set.albedo, uvX);
  const cy = texture(set.albedo, uvY);
  const cz = texture(set.albedo, uvZ);
  const nx = texture(set.nr, uvX);
  const ny = texture(set.nr, uvY);
  const nz = texture(set.nr, uvZ);

  const color = cx.rgb.mul(w.x).add(cy.rgb.mul(w.y)).add(cz.rgb.mul(w.z));
  const rough = nx.z.mul(w.x).add(ny.z.mul(w.y)).add(nz.z.mul(w.z));

  const tnx = unpackNormal(nx);
  const tny = unpackNormal(ny);
  const tnz = unpackNormal(nz);
  const bx = vec3(tnx.xy.add(n.zy), abs(tnx.z).mul(n.x));
  const by = vec3(tny.xy.add(n.xz), abs(tny.z).mul(n.y));
  const bz = vec3(tnz.xy.add(n.xy), abs(tnz.z).mul(n.z));
  const normal = bx.zyx.mul(w.x).add(by.xzy.mul(w.y)).add(bz.xyz.mul(w.z)).normalize();

  return { color, normal, roughness: rough, ao: float(1) };
}

/** Tangent normal from the RG channels, rebuilding Z. */
function unpackNormal(sampleNode: any): any {
  const xy = sampleNode.xy.mul(2).sub(1);
  return vec3(xy, sqrt(float(1).sub(xy.dot(xy)).max(0)));
}

/**
 * Planar (top-down) projection for ground layers. Returns a world-space normal
 * built with UDN blending against the geometry normal.
 */
export function planar(set: PbrSet, uvNode: any, geomNormal: any = normalWorld): SurfaceNodes {
  const c = texture(set.albedo, uvNode);
  const nr = texture(set.nr, uvNode);
  const t = unpackNormal(nr);
  const n = geomNormal.normalize();
  const normal = vec3(t.x.add(n.x), n.y, t.y.add(n.z)).normalize();
  return { color: c.rgb, normal, roughness: nr.z, ao: float(1) };
}

/** The world-space normal each library material lights with, for `turnedVariant`. */
const litNormals = new WeakMap<THREE.Material, any>();
const variants = new WeakMap<THREE.Material, THREE.Material>();

function lightWith(mat: THREE.MeshStandardNodeMaterial, normal: any, space: SurfaceSpace = drawnSpace): void {
  mat.normalNode = transformNormalToView(space.turn(normal));
  if (space === drawnSpace) litNormals.set(mat, normal);
}

/**
 * Library materials hand a world-space normal to `transformNormalToView`,
 * which also turns it by the mesh's rotation and scale, so a turned column or
 * rock is lit as if the sun stood elsewhere. The temple and structures were
 * tuned with that light. A baked mesh (`mergeStatic`) has no part transforms
 * left, so its vertices carry their part's rotation in `turn` (a quaternion)
 * and inverse scale in `turnScale`, and this variant of `mat` applies them to
 * light every part as before. Null for materials outside the library.
 */
export function turnedVariant(mat: THREE.Material): THREE.Material | null {
  const normal = litNormals.get(mat);
  if (!normal) return null;
  let v = variants.get(mat) as THREE.MeshStandardNodeMaterial | undefined;
  if (!v) {
    v = (mat as THREE.MeshStandardNodeMaterial).clone();
    v.name = `${mat.name}-turned`;
    const q = attribute('turn', 'vec4');
    const n = normal.mul(attribute('turnScale', 'vec4').xyz);
    const t = cross(q.xyz, n).mul(2);
    v.normalNode = transformNormalToView(n.add(t.mul(q.w)).add(cross(q.xyz, t)));
    variants.set(mat, v);
  }
  return v;
}

/** How near the camera (m) a near-faded material is gone, and from where it is solid (see nearFaded). */
export const NEAR_FADE = { gone: 0.8, solid: 3.2 } as const;

const nearFades = new WeakMap<THREE.Material, THREE.MeshStandardNodeMaterial>();

/**
 * A copy of `mat` that thins away in a fine, even dither where it comes
 * within a couple of meters of the camera, so a column, brazier or gate
 * pillar the follow camera passes beside stops filling half the screen (its
 * collision keeps it 0.8 m off a column; a brazier or the pedestal sits under
 * its ray). It stays opaque (pixels are dropped, nothing is sorted or
 * blended), and only the view thins: the shadow pass skips the alpha test
 * node, so the shadow keeps its shape and still casts with the rest
 * (`solidShadow`, see merge.ts). A library material keeps its lighting when
 * baked (see turnedVariant). One copy per material, so one shader.
 */
export function nearFaded(mat: THREE.MeshStandardNodeMaterial): THREE.MeshStandardNodeMaterial {
  let f = nearFades.get(mat);
  if (!f) {
    f = mat.clone();
    f.name = `${mat.name}-near`;
    f.opacityNode = smoothstep(NEAR_FADE.gone, NEAR_FADE.solid, cameraPosition.distance(positionWorld));
    // interleaved gradient noise per screen pixel: an even screen-door, where hashed alpha clumped into speckle
    f.alphaTestNode = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy.floor(), vec2(0.06711056, 0.00583715)))));
    f.userData.solidShadow = true;
    const normal = litNormals.get(mat);
    if (normal) litNormals.set(f, normal);
    nearFades.set(mat, f);
  }
  return f;
}

export function applySurface(mat: THREE.MeshStandardNodeMaterial, s: SurfaceNodes, opts: { tint?: any; roughnessMul?: any; aoStrength?: number } = {}, space: SurfaceSpace = drawnSpace): void {
  // the Jötunn's frost settles on the stone's tops as rime in its grain (folded over 0 to 1, whatever the stone's brightness)
  mat.colorNode = frosted(opts.tint ? s.color.mul(opts.tint) : s.color, fract(s.color.g.mul(7)));
  lightWith(mat, s.normal, space);
  mat.roughnessNode = opts.roughnessMul ? s.roughness.mul(opts.roughnessMul) : s.roughness;
  const k = opts.aoStrength ?? 1;
  mat.aoNode = k === 1 ? s.ao : float(1).sub(float(1).sub(s.ao).mul(k));
  mat.metalnessNode = float(0);
}

/**
 * Library of shared materials used by the architecture. A library built with
 * another `space` (see collapse.ts) has the same materials reading that space.
 */
export class MaterialLibrary {
  readonly marble: THREE.MeshStandardNodeMaterial;
  readonly sandstone: THREE.MeshStandardNodeMaterial;
  readonly flagstone: THREE.MeshStandardNodeMaterial;
  readonly rock: THREE.MeshStandardNodeMaterial;
  readonly bronze: THREE.MeshStandardNodeMaterial;
  readonly gold: THREE.MeshStandardNodeMaterial;
  /** Global wetness/darkening knob for weather later. */
  readonly grime = uniform(1);

  constructor(readonly textures: TextureLibrary, readonly space: SurfaceSpace = drawnSpace) {
    this.marble = this.make('marble', 0.42, { tint: vec3(1.0, 0.985, 0.96) });
    this.sandstone = this.make('sandstone_blocks', 0.25);
    // the painted slabs are smaller in the map than gen.py's were, so it repeats less often (same slab size)
    this.flagstone = this.make('flagstone', 0.14);
    this.rock = this.make('rock', 0.11, { aoStrength: 1.2 });
    this.bronze = this.metal(new THREE.Color(0x8c5a32), 0.38, true);
    this.gold = this.metal(new THREE.Color(0xd9a441), 0.26, false);
  }

  private make(name: PbrName, scale: number, opts: { tint?: any; aoStrength?: number } = {}): THREE.MeshStandardNodeMaterial {
    const mat = new THREE.MeshStandardNodeMaterial();
    applySurface(mat, triplanar(this.textures.get(name), scale, 4, this.space.world, this.space.normal), opts, this.space);
    mat.name = name;
    return mat;
  }

  /** Metals reuse the rock texture's detail as a subtle wear/patina mask. */
  private metal(base: THREE.Color, roughness: number, patina: boolean): THREE.MeshStandardNodeMaterial {
    const mat = new THREE.MeshStandardNodeMaterial();
    const s = triplanar(this.textures.get('rock'), 0.9, 4, this.space.world, this.space.normal);
    const wear = s.color.r.mul(2.2).clamp(0, 1);
    const baseCol = vec3(base.r, base.g, base.b);
    let col: any = baseCol.mul(wear.mul(0.35).add(0.75));
    const patinaMask = float(1).sub(s.color.r.mul(4)).clamp(0, 0.6);
    if (patina) col = col.mix(vec3(0.16, 0.36, 0.3), patinaMask);
    mat.colorNode = col;
    mat.metalnessNode = patina ? float(1).sub(patinaMask) : float(1);
    mat.roughnessNode = float(roughness).add(s.roughness.sub(0.8).mul(0.4));
    lightWith(mat, s.normal.mix(this.space.normal, 0.6).normalize(), this.space);
    return mat;
  }
}
