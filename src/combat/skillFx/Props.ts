import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { abs, float, max, normalView, positionLocal, positionView, pow, saturate, sin, time, vec3 } from '../../render/tsl';
import { objectUniforms, useUniforms } from '../../render/shared';

/** The solid things skills throw: Mjolnir, daggers, a spearhead, a hand of the dead, ravens, a bomb. */
export type PropKind = 'hammer' | 'dagger' | 'spearhead' | 'claw' | 'raven' | 'bomb';

const propUniforms = () => ({
  base: new THREE.Color(),
  glow: new THREE.Color(),
  /** How strongly its edges and body burn with `glow`. */
  burn: 1,
  metal: 0.5,
  rough: 0.5,
  /** Wing beat for ravens (0 for everything else). */
  flap: 0,
  seed: 0,
});

let material: THREE.MeshStandardNodeMaterial | null = null;

function makeMaterial(): THREE.MeshStandardNodeMaterial {
  const u = objectUniforms(propUniforms());
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.5 });
  // wings beat: everything out past the body rises and falls (zero for other props)
  const reach = max(abs(positionLocal.x).sub(0.1), 0);
  m.positionNode = positionLocal.add(vec3(0, sin(time.mul(17).add(u.seed)).mul(reach).mul(u.flap), 0));
  const facing = saturate(normalView.dot(positionView.normalize().negate()));
  const rim = pow(float(1).sub(facing), 2.5);
  m.colorNode = u.base;
  m.metalnessNode = u.metal;
  m.roughnessNode = u.rough;
  m.emissiveNode = u.glow.mul(rim.mul(1.8).add(0.12).mul(u.burn));
  return m;
}

/** Merge parts into one geometry with the same attributes as every other prop (position, normal, uv). */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (!n.getAttribute('uv')) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.getAttribute('position').count * 2), 2));
    return n;
  });
  return mergeGeometries(flat, false)!;
}

/** Built facing -Z (the way it flies), about the size it is drawn at scale 1. */
const BUILD: Record<PropKind, () => THREE.BufferGeometry> = {
  hammer: () =>
    merge([
      new THREE.BoxGeometry(0.4, 0.4, 0.74).translate(0, 0.34, 0),
      new THREE.BoxGeometry(0.46, 0.08, 0.8).translate(0, 0.34, 0),
      new THREE.CylinderGeometry(0.06, 0.065, 0.66, 8).translate(0, -0.2, 0),
      new THREE.SphereGeometry(0.1, 8, 6).translate(0, -0.56, 0),
    ]),
  dagger: () => {
    const blade = new THREE.OctahedronGeometry(1, 0);
    blade.scale(0.07, 0.025, 0.36).translate(0, 0, -0.34);
    return merge([blade, new THREE.BoxGeometry(0.26, 0.05, 0.05), new THREE.CylinderGeometry(0.028, 0.03, 0.2, 6).rotateX(Math.PI / 2).translate(0, 0, 0.12)]);
  },
  spearhead: () => {
    const head = new THREE.OctahedronGeometry(1, 0);
    head.scale(0.16, 0.06, 0.6).translate(0, 0, -0.5);
    return merge([head, new THREE.CylinderGeometry(0.09, 0.07, 0.16, 8).rotateX(Math.PI / 2).translate(0, 0, 0.12)]);
  },
  claw: () => {
    const palm = new THREE.SphereGeometry(1, 10, 8);
    palm.scale(0.3, 0.1, 0.26);
    const parts: THREE.BufferGeometry[] = [palm];
    // four long fingers reaching forward and curling down, and a thumb
    for (let i = 0; i < 4; i++) {
      const x = -0.2 + i * 0.135;
      const f = new THREE.ConeGeometry(0.05, 0.62, 6).rotateX(-Math.PI / 2 - 0.25).translate(x, -0.06, -0.48);
      parts.push(f);
    }
    parts.push(new THREE.ConeGeometry(0.055, 0.42, 6).rotateX(-Math.PI / 2).rotateY(0.9).translate(-0.34, -0.02, -0.12));
    return merge(parts);
  },
  raven: () => {
    const body = new THREE.SphereGeometry(1, 10, 8);
    body.scale(0.15, 0.13, 0.34);
    const head = new THREE.SphereGeometry(0.11, 8, 6).translate(0, 0.07, -0.32);
    const beak = new THREE.ConeGeometry(0.045, 0.2, 6).rotateX(-Math.PI / 2).translate(0, 0.05, -0.5);
    // long swept wings out to the sides; the shader beats everything past the body
    const wingL = new THREE.BoxGeometry(0.62, 0.025, 0.3).translate(-0.4, 0.02, 0.02);
    const wingR = new THREE.BoxGeometry(0.62, 0.025, 0.3).translate(0.4, 0.02, 0.02);
    const tail = new THREE.BoxGeometry(0.22, 0.02, 0.24).translate(0, 0, 0.42);
    return merge([body, head, beak, wingL, wingR, tail]);
  },
  bomb: () =>
    merge([
      new THREE.SphereGeometry(0.26, 12, 8),
      new THREE.CylinderGeometry(0.08, 0.1, 0.1, 8).translate(0, 0.27, 0),
      new THREE.CylinderGeometry(0.02, 0.02, 0.18, 4).translate(0, 0.38, 0),
    ]),
};

const geometries = new Map<PropKind, THREE.BufferGeometry>();
export const PROP_KINDS = Object.keys(BUILD) as PropKind[];

/** How each prop is dressed: base color, glow, and finish. */
const DRESS: Record<PropKind, { base: number; metal: number; rough: number; burn: number }> = {
  hammer: { base: 0xa9b4c0, metal: 0.9, rough: 0.3, burn: 1 },
  dagger: { base: 0xc8d2c4, metal: 0.95, rough: 0.22, burn: 1.2 },
  spearhead: { base: 0xe0b45a, metal: 0.9, rough: 0.25, burn: 1.4 },
  claw: { base: 0xd8c8a0, metal: 0.1, rough: 0.7, burn: 1.3 },
  // a faint rim only: the flat wings, seen at a slant from behind, are all rim, and glowed tan
  raven: { base: 0x141418, metal: 0.2, rough: 0.55, burn: 0.12 },
  bomb: { base: 0x2b2f2a, metal: 0.4, rough: 0.5, burn: 0.9 },
};

/** One thrown thing in flight: a lit solid with a glowing rim in its skill's colors. */
export class Prop {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  private readonly values = propUniforms();
  kind: PropKind = 'hammer';

  constructor() {
    this.mesh = new THREE.Mesh(this.geometryOf('hammer'), (material ??= makeMaterial()));
    this.mesh.name = 'prop';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.group.add(this.mesh);
    this.group.name = 'prop';
    useUniforms(this.values, this.mesh);
  }

  private geometryOf(kind: PropKind): THREE.BufferGeometry {
    let g = geometries.get(kind);
    if (!g) geometries.set(kind, (g = BUILD[kind]()));
    return g;
  }

  dress(kind: PropKind, glow: number, size: number): this {
    this.kind = kind;
    this.mesh.geometry = this.geometryOf(kind);
    const d = DRESS[kind];
    const v = this.values;
    v.base.setHex(d.base);
    v.glow.setHex(glow);
    v.burn = d.burn;
    v.metal = d.metal;
    v.rough = d.rough;
    v.flap = kind === 'raven' ? 0.9 : 0;
    v.seed = Math.random() * 20;
    this.mesh.scale.setScalar(size);
    this.mesh.rotation.set(0, 0, 0);
    return this;
  }

  /** Points it along a direction on the ground (unit yaw convention: 0 faces -Z). */
  aim(x: number, y: number, z: number, yaw: number): void {
    this.group.position.set(x, y, z);
    this.group.rotation.set(0, yaw, 0);
  }
}
