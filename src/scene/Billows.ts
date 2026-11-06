import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, float, hash, min, mix, select, smoothstep, uniform, uv, vec2, vec3, vec4 } from '../render/tsl';
import { FLIPBOOK_ASPECT, FLIPBOOK_FRAMES, sampleFlipbook, unpackFlipbook, type FlipbookName } from '../render/flipbook';
import { spriteQuads } from '../render/shared';

/** The one-shot sheets a billow can play. */
export type BillowSheet = Exclude<FlipbookName, 'fire'>;

export interface BillowOptions {
  /** Seconds the sheet takes to play (default 2). */
  duration?: number;
  /** Smoke color (default warm grey). */
  tint?: number;
  /** Meters per second the cloud drifts up as it plays. */
  rise?: number;
  /** Seconds to wait before it appears. */
  delay?: number;
  /** Hot and cool ends of the flame ramp, for sheets with flame (default orange to pale gold). */
  flame?: [number, number];
}

/** Billows each sheet can play at once; the oldest is reused past that. */
const CAPACITY = 24;

/** Per sheet: one sprite set drawn in a single call, every billow a copy with its own attributes. */
interface Kind {
  sprite: THREE.Sprite;
  at: THREE.InstancedBufferAttribute;
  life: THREE.InstancedBufferAttribute;
  tint: THREE.InstancedBufferAttribute;
  flame: THREE.InstancedBufferAttribute;
  next: number;
  /** When the last billow of this sheet ends, on the billows' clock. */
  until: number;
}

/**
 * Clouds of smoke, dust and fire that play a flipbook once: a falling tower's
 * dust, the smoke of its collapse, a Phoenix's death blast. One material and
 * one draw call per sheet however many play; hidden when none do. Billows run
 * on their own clock (`update`), so they pause with the game.
 */
export class Billows {
  readonly group = new THREE.Group();
  private readonly kinds = new Map<BillowSheet, Kind>();
  private readonly now = uniform(0);
  private clock = 0;

  constructor() {
    this.group.name = 'billows';
    for (const sheet of ['dust', 'smoke', 'blast'] as const) this.kinds.set(sheet, this.make(sheet));
  }

  /** Starts a billow of `sheet`, `size` meters across, its center at (x, y, z). */
  spawn(sheet: BillowSheet, x: number, y: number, z: number, size: number, o: BillowOptions = {}): void {
    const k = this.kinds.get(sheet)!;
    const i = k.next;
    k.next = (i + 1) % CAPACITY;
    const start = this.clock + (o.delay ?? 0);
    const duration = o.duration ?? 2;
    k.at.setXYZW(i, x, y, z, size);
    k.life.setXYZW(i, start, duration, Math.random() * 100, o.rise ?? 0);
    const c = new THREE.Color(o.tint ?? 0x8c847a);
    k.tint.setXYZW(i, c.r, c.g, c.b, 1);
    // both ends of the flame ramp as 0xRRGGBB numbers (exact in a float32)
    const [hot, cool] = o.flame ?? [0xff5a14, 0xffd890];
    k.flame.setXYZW(i, hot, cool, 0, 0);
    k.at.needsUpdate = k.life.needsUpdate = k.tint.needsUpdate = k.flame.needsUpdate = true;
    k.until = Math.max(k.until, start + duration);
    k.sprite.visible = true;
  }

  /** Ends every billow at once (the dev stage, between shots). */
  clear(): void {
    for (const k of this.kinds.values()) {
      for (let i = 0; i < CAPACITY; i++) k.life.setX(i, -1e6);
      k.life.needsUpdate = true;
      k.until = -1;
      k.sprite.visible = false;
    }
  }

  update(dt: number): void {
    this.clock += dt;
    this.now.value = this.clock;
    for (const k of this.kinds.values()) if (k.sprite.visible && this.clock > k.until) k.sprite.visible = false;
  }

  private make(sheet: BillowSheet): Kind {
    const g = spriteQuads(CAPACITY, true);
    const add = (name: string) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    };
    const at = add('billowAt');
    const life = add('billowLife');
    const tint = add('billowTint');
    const flame = add('billowFlame');
    const sprite = new THREE.Sprite(billowMaterial(sheet, this.now));
    sprite.geometry = g;
    sprite.name = `billows-${sheet}`;
    sprite.frustumCulled = false;
    sprite.renderOrder = 12;
    sprite.visible = false;
    // drawn while loading, so the first collapse builds no shader mid-match
    sprite.userData.shownLater = true;
    this.group.add(sprite);
    return { sprite, at, life, tint, flame, next: 0, until: -1 };
  }
}

/** Unpacks a 0xRRGGBB number stored in a float attribute into a color. */
function hexColor(h: any): any {
  const r = h.div(65536).floor();
  const g = h.sub(r.mul(65536)).div(256).floor();
  const b = h.sub(r.mul(65536)).sub(g.mul(256));
  return vec3(r, g, b).div(255).pow(2.2);
}

function billowMaterial(sheet: BillowSheet, now: any): THREE.SpriteNodeMaterial {
  const at = attribute('billowAt', 'vec4');
  const life = attribute('billowLife', 'vec4');
  const tint = attribute('billowTint', 'vec4');
  const flame = attribute('billowFlame', 'vec4');
  const age = now.sub(life.x).div(life.y);
  const t = age.clamp(0, 1);
  const alive = select(age.greaterThanEqual(0).and(age.lessThan(1)), float(1), float(0));
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  // smoke composited over the scene, flame added on top: out = smoke * a + flame + dst * (1 - a)
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  const size = at.w.mul(alive);
  const center = at.xyz.add(vec3(0, life.w.mul(t).mul(life.y), 0));
  // pulled toward the camera by a third of its size, so the card cuts into the ground less
  const toward = cameraPosition.sub(center).normalize().mul(size.mul(0.33));
  m.positionNode = center.add(toward);
  const aspect = FLIPBOOK_ASPECT[sheet];
  m.scaleNode = vec2(size, size.div(aspect));
  // half the billows play mirrored, so a pile of them doesn't repeat
  const flip = hash(life.z).greaterThan(0.5);
  const u = uv();
  const fu = select(flip, float(1).sub(u.x), u.x);
  const s = unpackFlipbook(sampleFlipbook(sheet, t.mul(FLIPBOOK_FRAMES - 1), vec2(fu, u.y), false));
  // lit from above in the render; the shadowed side keeps a little sky
  const smoke = tint.rgb.mul(mix(float(0.32), float(1.15), s.lit));
  // late dust frames rise out of the top of their frame: fade every border so a big card never shows a straight edge
  const edge = smoothstep(0, 0.1, min(fu, float(1).sub(fu))).mul(smoothstep(0, 0.05, u.y)).mul(smoothstep(0, 0.2, float(1).sub(u.y)));
  const fade = float(1).sub(t.pow(3)).mul(alive).mul(edge);
  const a = s.alpha.mul(fade);
  const hot = hexColor(flame.x);
  const cool = hexColor(flame.y);
  // (heat^1.25 keeps the cooler folds of a fireball dark between its hot rolls)
  const fire = mix(hot, cool, s.heat.pow(1.5)).mul(s.heat.pow(1.25)).mul(5).mul(fade);
  m.colorNode = vec4(smoke.mul(a).add(fire), 1);
  m.opacityNode = a;
  return m;
}
