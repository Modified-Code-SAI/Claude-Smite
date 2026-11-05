import * as THREE from 'three/webgpu';
import { attribute, mix, smoothstep, uv, vec2, vec3, vec4 } from '../render/tsl';
import { spriteQuads } from '../render/shared';
import { WispSwarm, type WispHost } from './wisps';

/** Fading copies drawn behind each wisp along its motion: its streak. */
const GHOSTS = 5;
/** Seconds of motion between one streak copy and the next. */
const GHOST_GAP = 0.02;
/** Glows at once: one on each god taking in souls. */
const FLARES = 8;
const FLARE_LIFE = 0.32;

let wispMaterial: THREE.SpriteNodeMaterial | null = null;

/** A hot white core in a soft halo of the wisp's own color; each copy's place, size, color and strength come from its instance. */
function makeWispMaterial(): THREE.SpriteNodeMaterial {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const spot = attribute('wisp', 'vec4');
  const tint = attribute('wispTint', 'vec4');
  m.positionNode = spot.xyz;
  m.scaleNode = vec2(spot.w, spot.w);
  const r = uv().sub(0.5).length().mul(2);
  const halo = smoothstep(1, 0, r).pow(1.5);
  const core = smoothstep(0.45, 0, r).pow(1.4);
  m.colorNode = vec4(mix(tint.xyz, vec3(1, 1, 1), core.mul(0.7)).mul(halo.mul(3).add(core.mul(4))).mul(tint.w), 1);
  m.opacityNode = halo.mul(tint.w);
  return m;
}

/**
 * Souls in flight, drawn: every wisp, its streak and the glow on each god
 * taking them in are copies of one instanced sprite in one shared material,
 * so the whole swarm is a single draw that never builds a shader mid-run.
 */
export class SoulWisps {
  readonly sprite: THREE.Sprite;
  readonly swarm: WispSwarm;
  /** A wisp reached a unit. */
  onAbsorb: ((to: WispHost) => void) | null = null;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly spots: THREE.InstancedBufferAttribute;
  private readonly tints: THREE.InstancedBufferAttribute;
  private readonly flares: { to: WispHost; age: number; color: number; boost: number }[] = [];
  private readonly color = new THREE.Color();
  private clock = 0;

  constructor(cap = 64) {
    this.swarm = new WispSwarm(cap, Math.random, (to, w) => this.absorb(to, w.color));
    const n = cap * (1 + GHOSTS) + FLARES;
    this.geometry = spriteQuads(n, true);
    this.spots = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.tints = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('wisp', this.spots);
    this.geometry.setAttribute('wispTint', this.tints);
    this.geometry.instanceCount = 0;
    this.sprite = new THREE.Sprite((wispMaterial ??= makeWispMaterial()));
    this.sprite.geometry = this.geometry;
    this.sprite.name = 'soul-wisps';
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 13;
    this.sprite.visible = false;
  }

  frame(dt: number): void {
    this.clock += dt;
    this.swarm.step(dt);
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i]!;
      f.age += dt;
      if (f.age >= FLARE_LIFE) this.flares.splice(i, 1);
    }
    this.write(dt);
  }

  /** Shows a few copies for the loading frames that prepare shaders; returns the undo. */
  prime(): () => void {
    this.spots.setXYZW(0, 0, -50, 0, 0.01);
    this.tints.setXYZW(0, 0, 0, 0, 0);
    this.spots.needsUpdate = true;
    this.tints.needsUpdate = true;
    const count = this.geometry.instanceCount;
    const shown = this.sprite.visible;
    this.geometry.instanceCount = Math.max(1, count);
    this.sprite.visible = true;
    return () => {
      this.geometry.instanceCount = count;
      this.sprite.visible = shown;
    };
  }

  private absorb(to: WispHost, color: number): void {
    const f = this.flares.find((x) => x.to === to);
    if (f) {
      // each soul landing on the same god brightens its glow a little more
      f.age = Math.min(f.age, FLARE_LIFE * 0.25);
      f.boost = Math.min(4, f.boost + 1);
      f.color = color;
    } else if (this.flares.length < FLARES) this.flares.push({ to, age: 0, color, boost: 0 });
    this.onAbsorb?.(to);
  }

  private write(dt: number): void {
    const s = this.swarm;
    let n = 0;
    const put = (x: number, y: number, z: number, size: number, color: number, strength: number) => {
      this.color.setHex(color);
      this.spots.setXYZW(n, x, y, z, size);
      this.tints.setXYZW(n, this.color.r, this.color.g, this.color.b, strength);
      n++;
    };
    const step = Math.max(dt, 1e-3);
    for (const w of s.wisps) {
      const a = s.alpha(w);
      if (a <= 0) continue;
      const flicker = 0.85 + 0.15 * Math.sin(this.clock * 31 + w.seed);
      const vx = (w.x - w.px) / step;
      const vy = (w.y - w.py) / step;
      const vz = (w.z - w.pz) / step;
      put(w.x, w.y, w.z, w.size * flicker, w.color, a);
      for (let j = 1; j <= GHOSTS; j++) {
        const back = j * GHOST_GAP;
        put(w.x - vx * back, w.y - vy * back, w.z - vz * back, w.size * (1 - j * 0.13), w.color, a * (1 - j * 0.17) * 0.75);
      }
    }
    for (const f of this.flares) {
      const k = f.age / FLARE_LIFE;
      const grow = 1 - (1 - k) ** 3;
      put(f.to.x, f.to.body.y + 1.2, f.to.z, (0.7 + grow * 1.5) * (1 + f.boost * 0.12), f.color, (1 - k) ** 2 * (0.55 + f.boost * 0.1));
    }
    this.geometry.instanceCount = n;
    this.sprite.visible = n > 0;
    if (!n) return;
    this.spots.needsUpdate = true;
    this.tints.needsUpdate = true;
  }
}
