import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, float, mix, mx_noise_float, normalView, positionGeometry, positionView, pow, saturate, sin, smoothstep, time, vec3 } from '../../render/tsl';
import { objectUniforms, placedGeometry, placeInstances, useUniforms } from '../../render/shared';

const shardUniforms = () => ({ base: new THREE.Color(), metal: 0, rough: 0.8, tipGlow: 0 });

let material: THREE.MeshStandardNodeMaterial | null = null;

/**
 * Rock chips and spears share one lit material: stone with glowing cracks, or
 * gilded spears whose heads burn. Each copy's glow color is its `tint`.
 */
function makeMaterial(): THREE.MeshStandardNodeMaterial {
  const u = objectUniforms(shardUniforms());
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  m.positionNode = placeInstances(m);
  const tint = attribute('tint', 'vec4');
  const n = mx_noise_float(positionGeometry.mul(4.3)).mul(0.5).add(0.5);
  const cracks = smoothstep(0.47, 0.5, n).mul(smoothstep(0.53, 0.5, n));
  const facing = saturate(normalView.dot(positionView.normalize().negate()));
  const rim = pow(float(1).sub(facing), 3);
  const tip = smoothstep(1.45, 1.75, positionGeometry.y);
  const pulse = sin(time.mul(9)).mul(0.15).add(0.85);
  const glow = mix(cracks.mul(2.2).add(rim.mul(0.5)), tip.mul(2.4).add(rim.mul(0.35)), u.tipGlow).mul(tint.w).mul(pulse);
  m.colorNode = mix(u.base.mul(n.mul(0.35).add(0.75)), vec3(1, 1, 1), tip.mul(u.tipGlow).mul(0.2));
  m.metalnessNode = u.metal;
  m.roughnessNode = u.rough;
  m.emissiveNode = tint.xyz.mul(glow);
  return m;
}

/** A jagged stone shard about a meter tall, leaning toward +Z. */
function rockGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const specs = [
    [0, 0, 1.15, 0.36, 0.32],
    [0.3, -0.15, 0.7, 0.25, 0.5],
    [-0.28, 0.08, 0.6, 0.22, 0.45],
  ];
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const spec of specs) {
    const [x, z, h, r, lean] = spec as [number, number, number, number, number];
    const g = new THREE.OctahedronGeometry(1, 1);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const k = 0.8 + rnd() * 0.4;
      p.setXYZ(i, p.getX(i) * r * k, (p.getY(i) * 0.5 + 0.5) * h * (0.9 + rnd() * 0.2) - 0.15, p.getZ(i) * r * k);
    }
    g.rotateX(lean);
    g.translate(x, 0, z);
    parts.push(g.toNonIndexed());
  }
  const out = mergeGeometries(parts, false)!;
  out.computeVertexNormals();
  return out;
}

/** A spear standing point up: a shaft, a collar and a long leaf-shaped head, 1.9 m. */
function spearGeometry(): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(0.045, 0.055, 1.5, 6, 1).translate(0, 0.45, 0);
  const collar = new THREE.CylinderGeometry(0.085, 0.07, 0.12, 8, 1).translate(0, 1.22, 0);
  const head = new THREE.OctahedronGeometry(1, 0);
  head.scale(0.13, 0.32, 0.05).translate(0, 1.6, 0);
  const parts = [shaft, collar, head].map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of parts) g.deleteAttribute('uv');
  const out = mergeGeometries(parts, false)!;
  out.computeVertexNormals();
  return out;
}

interface Piece {
  x: number;
  y: number;
  z: number;
  yaw: number;
  size: number;
  delay: number;
  hold: number;
  age: number;
  r: number;
  g: number;
  b: number;
  glow: number;
}

export type ShardKind = 'rock' | 'spear';

/**
 * Pieces bursting out of the ground and sinking back: rocks thrown up where
 * a hammer lands or the earth splits, spears in a ring. Every piece of a kind
 * is one instance of one mesh, so all of them are a single draw.
 */
export class Shards {
  readonly mesh: THREE.Mesh;
  private readonly spot: THREE.InstancedBufferAttribute;
  private readonly turn: THREE.InstancedBufferAttribute;
  private readonly tint: THREE.InstancedBufferAttribute;
  private readonly live: Piece[] = [];
  private readonly spare: Piece[] = [];
  private readonly values = shardUniforms();

  constructor(kind: ShardKind, private readonly max = 160) {
    const source = kind === 'rock' ? rockGeometry() : spearGeometry();
    if (!source.getAttribute('uv')) source.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(source.getAttribute('position').count * 2), 2));
    const { geometry, spot, turn } = placedGeometry(source, max);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('tint', this.tint);
    this.spot = spot;
    this.turn = turn;
    this.mesh = new THREE.Mesh(geometry, (material ??= makeMaterial()));
    this.mesh.name = `shards-${kind}`;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    if (kind === 'rock') {
      this.values.base.setHex(0x5a5048);
      this.values.rough = 0.9;
    } else {
      this.values.base.setHex(0xd8a84a);
      this.values.metal = 0.85;
      this.values.rough = 0.32;
      this.values.tipGlow = 1;
    }
    useUniforms(this.values, this.mesh);
    (geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
    this.mesh.visible = false;
  }

  /** One piece: bursts up after `delay`, stands `hold` seconds, sinks. `glow` colors its cracks or head. */
  add(x: number, y: number, z: number, yaw: number, size: number, delay: number, hold: number, glow: number, strength = 1): void {
    if (this.live.length >= this.max) this.spare.push(this.live.shift()!);
    const p = this.spare.pop() ?? ({} as Piece);
    p.x = x;
    p.y = y;
    p.z = z;
    p.yaw = yaw;
    p.size = size;
    p.delay = delay;
    p.hold = hold;
    p.age = 0;
    p.r = ((glow >> 16) & 255) / 255;
    p.g = ((glow >> 8) & 255) / 255;
    p.b = (glow & 255) / 255;
    p.glow = strength;
    this.live.push(p);
  }

  /** Shown at full size where `prime` puts it, so loading builds its shader. */
  prime(): () => void {
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 1;
    this.spot.setXYZW(0, 0, -50, 0, 1);
    this.turn.setXY(0, 1, 0);
    this.spot.needsUpdate = this.turn.needsUpdate = true;
    this.mesh.visible = true;
    return () => this.update(0);
  }

  update(dt: number): void {
    const live = this.live;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i]!;
      p.age += dt;
      if (p.age > p.delay + p.hold + 0.6) {
        live[i] = live[live.length - 1]!;
        live.pop();
        this.spare.push(p);
      }
    }
    const spot = this.spot;
    const turn = this.turn;
    const tint = this.tint;
    let n = 0;
    for (const p of live) {
      const t = p.age - p.delay;
      if (t < 0) continue;
      let k: number;
      let sink = 0;
      if (t < 0.1) k = 1.2 * (1 - (1 - t / 0.1) ** 3);
      else if (t < 0.2) k = 1.2 - 0.2 * ((t - 0.1) / 0.1);
      else if (t < p.hold) k = 1;
      else {
        const s = Math.min(1, (t - p.hold) / 0.6);
        k = 1 - s * 0.25;
        sink = s * s * 1.6;
      }
      spot.setXYZW(n, p.x, p.y - sink * p.size, p.z, k * p.size);
      turn.setXY(n, Math.cos(p.yaw), Math.sin(p.yaw));
      // the glow dies down once it has burst
      tint.setXYZW(n, p.r, p.g, p.b, p.glow * (t < p.hold ? 1 - 0.5 * Math.min(1, t / Math.max(0.2, p.hold)) : 0.4));
      n++;
    }
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    spot.needsUpdate = turn.needsUpdate = tint.needsUpdate = true;
  }
}
