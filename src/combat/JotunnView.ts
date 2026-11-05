import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clusterGeometry, crystalGeometry, GIANT_ACTS, GiantModel, type GiantAct, type GiantPart, type GiantPartState, type GiantState } from '../actors/GiantModel';
import { attribute, color, float, hash, instanceIndex, mix, mx_noise_float, normalView, positionGeometry, positionView, pow, saturate, sin, smoothstep, time, uniform, uv, vec2, vec3, vec4 } from '../render/tsl';
import { placedGeometry, placeInstances, spriteQuads } from '../render/shared';
import type { Fire } from '../scene/Effects';
import { JOTUNN, PART_IDS, type PartId, type ShrineState } from '../sim/Jotunn';
import type { Flash, Point, SimEvent, Unit } from '../sim/Unit';
import type { MonsterView } from './MonsterViews';
import type { StructureModel } from './structures';
import { RelicView } from './Vfx';

type Ground = (x: number, z: number) => number;

/** What the game gives the Jötunn's view. */
export interface JotunnViewHost {
  ground: Ground;
  /** The sim's flashes: a warning carries the attack it winds up. */
  flashes(): readonly Flash[];
  /** The shrines' state (the host's mode, or a guest's copy of it). */
  shrines(): readonly ShrineState[];
  /** The temple fire burning in the brazier at a spot, if the map has one there. */
  fireAt(x: number, z: number): Fire | null;
  /** Camera shake, 0..1 trauma, felt less the further `at` is from the camera. */
  shake(amount: number, at: THREE.Vector3): void;
  /** A frost burst from the shared spell effects (flash, sparks, ring, snow). */
  burst(at: THREE.Vector3, power: number): void;
  /** A giant's foot came down (its sound), 0..1 how hard. */
  footfall?(at: THREE.Vector3, k: number): void;
}

// ---------------------------------------------------------------------------
// Particles: sprites simulated on the CPU, drawn in one call per kind.

interface Particle {
  p: THREE.Vector3;
  v: THREE.Vector3;
  age: number;
  life: number;
  size0: number;
  size1: number;
  alpha: number;
  drag: number;
  rise: number;
  c: THREE.Color;
}

/**
 * Soft puffs: `glow` adds light (frost breath, mist), the other kind is
 * alpha-blended (snow and dust thrown up by the giant's feet and blows).
 */
class Puffs {
  readonly sprite: THREE.Sprite;
  private readonly at: THREE.InstancedBufferAttribute;
  private readonly tint: THREE.InstancedBufferAttribute;
  private readonly live: Particle[] = [];
  private readonly free: Particle[] = [];

  constructor(max: number, glow: boolean) {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending });
    const at = attribute('pAt', 'vec4');
    const tint = attribute('pTint', 'vec4');
    m.positionNode = at.xyz;
    m.scaleNode = vec2(at.w, at.w);
    const seed = hash(instanceIndex.toFloat());
    const r = uv().sub(0.5).length().mul(2);
    // a lumpy edge, different for every copy, turning slowly
    const lumps = mx_noise_float(vec3(uv().x.mul(3.1), uv().y.mul(3.1), seed.mul(19).add(time.mul(0.25)))).mul(0.5).add(0.5);
    const f = smoothstep(1, 0.15, r.add(lumps.mul(0.4)));
    if (glow) {
      m.colorNode = vec4(tint.xyz.mul(f).mul(tint.w), 1);
      m.opacityNode = f.mul(tint.w);
    } else {
      // lit from above: a little darker at the bottom of each puff
      const shade = mix(float(0.72), float(1.05), uv().y);
      m.colorNode = vec4(tint.xyz.mul(shade), 1);
      m.opacityNode = f.mul(tint.w);
    }
    const g = spriteQuads(max, true);
    this.at = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('pAt', this.at);
    g.setAttribute('pTint', this.tint);
    this.sprite = new THREE.Sprite(m);
    this.sprite.geometry = g;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = glow ? 14 : 11;
    for (let i = 0; i < max; i++) this.free.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), age: 0, life: 1, size0: 1, size1: 1, alpha: 1, drag: 0, rise: 0, c: new THREE.Color() });
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, o: { life: number; size0: number; size1: number; alpha: number; color: number; drag?: number; rise?: number }): void {
    const q = this.free.pop() ?? this.live.shift();
    if (!q) return;
    q.p.copy(p);
    q.v.copy(v);
    q.age = 0;
    q.life = o.life;
    q.size0 = o.size0;
    q.size1 = o.size1;
    q.alpha = o.alpha;
    q.drag = o.drag ?? 1.5;
    q.rise = o.rise ?? 0;
    q.c.setHex(o.color);
    this.live.push(q);
  }

  /** A ring of puffs rolling out over the ground from `at`. */
  ring(at: THREE.Vector3, count: number, speed: number, o: { life: number; size0: number; size1: number; alpha: number; color: number; rise?: number }): void {
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const s = speed * (0.6 + Math.random() * 0.6);
      v.set(Math.cos(a) * s, 0.6 + Math.random() * 1.6, Math.sin(a) * s);
      this.spawn(at, v, { ...o, life: o.life * (0.75 + Math.random() * 0.5), drag: 2.4 });
    }
  }

  update(dt: number): void {
    const at = this.at.array as Float32Array;
    const tint = this.tint.array as Float32Array;
    let n = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const q = this.live[i]!;
      q.age += dt;
      if (q.age >= q.life) {
        this.live.splice(i, 1);
        this.free.push(q);
        continue;
      }
      q.v.multiplyScalar(Math.exp(-q.drag * dt));
      q.v.y += q.rise * dt;
      q.p.addScaledVector(q.v, dt);
    }
    for (const q of this.live) {
      const u = q.age / q.life;
      const size = q.size0 + (q.size1 - q.size0) * (1 - (1 - u) ** 2);
      // in quickly, out slowly
      const a = q.alpha * Math.min(1, u / 0.08) * (1 - u) ** 1.4;
      at.set([q.p.x, q.p.y, q.p.z, size], n * 4);
      tint.set([q.c.r, q.c.g, q.c.b, a], n * 4);
      n++;
    }
    at.fill(0, n * 4);
    this.at.needsUpdate = true;
    this.tint.needsUpdate = true;
    this.sprite.visible = n > 0;
  }
}

// ---------------------------------------------------------------------------
// Ice that bursts out of the ground: spikes, a wall, hail. One draw a kind.

function iceSurface(m: THREE.MeshStandardNodeMaterial, glow: any): void {
  const facing = saturate(normalView.dot(positionView.normalize().negate()));
  const rim = pow(float(1).sub(facing), 2);
  const n = mx_noise_float(positionGeometry.mul(3.7)).mul(0.5).add(0.5);
  m.colorNode = mix(color(0x1d5fae), color(0xd4f2ff), rim.mul(0.75).add(n.mul(0.25)));
  m.emissiveNode = color(0x52d4ff).mul(rim.mul(1.3).add(0.12).mul(glow));
}

interface Placed {
  at: THREE.Vector3;
  yaw: number;
  size: number;
  /** Seconds before it erupts. */
  delay: number;
  /** Seconds it stands. */
  hold: number;
  age: number;
  /** Falling stones: speed down, and where they land. */
  fall: number;
  ground: number;
}

/** Copies of one ice shape placed on the GPU (see `placeInstances`), animated from here. */
class IceCopies {
  readonly mesh: THREE.Mesh;
  private readonly spot: THREE.InstancedBufferAttribute;
  private readonly turn: THREE.InstancedBufferAttribute;
  private readonly live: Placed[] = [];
  onLand: ((p: Placed) => void) | null = null;

  constructor(
    source: THREE.BufferGeometry,
    private readonly max: number,
    material: THREE.MeshStandardNodeMaterial,
  ) {
    const { geometry, spot, turn } = placedGeometry(source, max);
    this.spot = spot;
    this.turn = turn;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
  }

  add(at: THREE.Vector3, yaw: number, size: number, delay: number, hold: number, fall = 0, ground = at.y): void {
    if (this.live.length >= this.max) this.live.shift();
    this.live.push({ at: at.clone(), yaw, size, delay, hold, age: 0, fall, ground });
  }

  update(dt: number): void {
    const spot = this.spot.array as Float32Array;
    const turn = this.turn.array as Float32Array;
    let n = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i]!;
      p.age += dt;
      if (p.fall > 0 && p.age >= p.delay) {
        p.at.y -= p.fall * dt;
        if (p.at.y <= p.ground) {
          p.at.y = p.ground;
          this.onLand?.(p);
          this.live.splice(i, 1);
          continue;
        }
      }
      if (p.age > p.delay + p.hold + 0.7) this.live.splice(i, 1);
    }
    for (const p of this.live) {
      const t = p.age - p.delay;
      let k: number;
      let sink = 0;
      if (p.fall > 0) k = t < 0 ? 0 : 1;
      else if (t < 0) k = 0;
      else if (t < 0.12) k = 1.15 * (1 - (1 - t / 0.12) ** 3);
      else if (t < 0.22) k = 1.15 - 0.15 * ((t - 0.12) / 0.1);
      else if (t < p.hold) k = 1;
      else {
        // it sinks back into the ground and is gone
        const u = Math.min(1, (t - p.hold) / 0.7);
        k = 1 - u * 0.3;
        sink = u * u * 1.1;
      }
      spot.set([p.at.x, p.at.y - sink * p.size, p.at.z, k * p.size], n * 4);
      turn.set([Math.cos(p.yaw), Math.sin(p.yaw)], n * 2);
      n++;
    }
    spot.fill(0, n * 4);
    this.spot.needsUpdate = true;
    this.turn.needsUpdate = true;
    this.mesh.visible = n > 0;
  }
}

/** A clump of crystals leaning toward +Z (out from where they burst), about a meter tall. */
function spikeGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const specs = [
    [0, 0, 1, 0.2, 0.42],
    [0.22, -0.12, 0.62, 0.13, 0.7],
    [-0.2, -0.05, 0.55, 0.12, 0.6],
    [0.05, 0.2, 0.45, 0.1, 0.95],
  ];
  specs.forEach(([x, z, len, r, lean], i) => {
    const g = crystalGeometry(len!, r!, 6, i * 5 + 2);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(x! * 0.8, 1, lean!).normalize()));
    g.translate(x!, -0.05, z!);
    parts.push(g);
  });
  return mergeGeometries(parts, false)!;
}

// ---------------------------------------------------------------------------
// The giant and its weak points, as the units' views.

/** The giant's body. UnitViews places its root; this poses it from the units and warnings. */
class GiantView implements MonsterView {
  readonly root: THREE.Group;
  readonly height: number;
  readonly linger = 20;

  constructor(
    readonly model: GiantModel,
    private readonly owner: JotunnView,
  ) {
    this.root = model.root;
    this.height = model.height;
  }

  animate(u: Unit, dt: number): void {
    this.owner.animateGiant(u, dt);
  }
}

/** A weak point's unit: a root that follows the ice on the body, shown only while it can be struck (for its bar). */
class PartView implements MonsterView {
  readonly root = new THREE.Group();
  readonly height = 0.6;

  constructor(
    private readonly id: PartId,
    private readonly owner: JotunnView,
  ) {
    this.root.name = `jotunn-${id}`;
  }

  animate(u: Unit): void {
    this.owner.placePart(this.id, this.root);
    this.root.visible = u.alive && u.untargetable <= 0;
  }
}

// ---------------------------------------------------------------------------
// Braziers: the temple's fires, freezing over as the giant clubs them.

class BrazierModel implements StructureModel {
  readonly root = new THREE.Group();
  readonly height = 2.4;
  private readonly crust: THREE.Mesh;
  private damage = 0;
  private destroyed = 0;
  private rebirth = -1;
  private frozen = 0;
  private steam = 0;
  private readonly at = new THREE.Vector3();

  constructor(
    private readonly fire: Fire | null,
    at: Point,
    ground: number,
    crust: THREE.BufferGeometry,
    material: THREE.Material,
    private readonly mist: Puffs,
  ) {
    this.root.position.set(at.x, ground, at.z);
    this.at.set(at.x, ground + 1.6, at.z);
    this.crust = new THREE.Mesh(crust, material);
    this.crust.position.y = 0.55;
    this.crust.rotation.y = (at.x * 7.3 + at.z * 3.1) % (Math.PI * 2);
    this.crust.castShadow = true;
    this.crust.visible = false;
    this.root.add(this.crust);
  }

  setShielded(): void {}
  pulseFire(): void {}

  setDamage(d: number): void {
    this.damage = d;
  }

  setDestroyed(t: number): void {
    if (t > 0 && this.destroyed <= 0) this.steam = 7;
    this.destroyed = t;
    if (t > 0) this.rebirth = -1;
  }

  setRebirth(t: number): void {
    this.rebirth = t;
    if (t > 0) this.destroyed = 0;
  }

  update(dt: number): void {
    // frost creeps over the bowl as it is struck; broken, it is sealed in ice
    let goal = this.destroyed > 0 ? 1 : this.damage * 0.45;
    if (this.rebirth >= 0) goal = Math.max(0, 1 - this.rebirth * 1.6) * this.frozen;
    const rate = this.destroyed > 0 ? 9 : 3;
    this.frozen += (goal - this.frozen) * Math.min(1, dt * rate);
    const k = this.frozen;
    this.crust.visible = k > 0.02;
    this.crust.scale.set(0.4 + k * 0.75, 0.15 + k * 1.05, 0.4 + k * 0.75);
    if (this.fire) {
      // the flame shrinks as the ice takes it, and is out once the brazier breaks
      const lit = this.destroyed > 0 ? Math.max(0, 1 - this.destroyed * 6) : 1 - this.damage * 0.5;
      const relit = this.rebirth >= 0 ? Math.min(1, Math.max(0, (this.rebirth - 0.35) / 0.4)) : lit;
      this.fire.strength = this.rebirth >= 0 ? relit : lit;
    }
    // smoke and steam rise off it for a while after it goes out
    if (this.steam > 0) {
      this.steam -= dt;
      if (Math.random() < dt * 9 * Math.min(1, this.steam / 3)) {
        const p = this.at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 0, (Math.random() - 0.5) * 0.8));
        this.mist.spawn(p, new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.2 + Math.random(), (Math.random() - 0.5) * 0.4), { life: 2.6, size0: 0.6, size1: 3.2, alpha: 0.35, color: 0xbdc6cc, drag: 0.6, rise: 0.25 });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shrines: an obelisk of ice on a ring the giant stands in to claim it.

const SHRINE_GLOW: Record<string, number> = { rime: 0x6fe6ff, avalanche: 0xd4ecff, hail: 0x8f9dff };

class ShrineView {
  readonly group = new THREE.Group();
  private readonly ring: RelicView;
  private readonly glow = uniform(1);
  private readonly obelisk: THREE.Mesh;
  private flare = 0;
  private wasReady = true;

  constructor(
    private readonly state: ShrineState,
    ground: Ground,
    base: THREE.BufferGeometry,
    stone: THREE.Material,
  ) {
    const { x, z } = state.def;
    const y = ground(x, z);
    this.ring = new RelicView(ground);
    this.group.add(this.ring.group);
    const plinth = new THREE.Mesh(base, stone);
    plinth.position.set(x, y + 0.3, z);
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0 });
    const tint = color(SHRINE_GLOW[state.def.id] ?? 0x6fe6ff);
    const facing = saturate(normalView.dot(positionView.normalize().negate()));
    const rim = pow(float(1).sub(facing), 2);
    m.colorNode = mix(color(0x1a4f94), color(0xd8f4ff), rim.mul(0.7));
    // light climbs the crystal in bands while it is ready to be claimed
    const bands = sin(positionGeometry.y.mul(1.6).sub(time.mul(2.2))).mul(0.5).add(0.5);
    m.emissiveNode = tint.mul(rim.mul(1.2).add(0.25).add(bands.mul(0.5)).mul(this.glow));
    this.obelisk = new THREE.Mesh(clusterGeometry(6, 6.5, 0.55, 0.42, 71 + x), m);
    this.obelisk.position.set(x, y + 0.65, z);
    this.obelisk.castShadow = true;
    this.group.add(plinth, this.obelisk);
  }

  update(dt: number, t: number): void {
    const s = this.state;
    const ready = s.dormant <= 0;
    if (!ready && this.wasReady) this.flare = 1;
    this.wasReady = ready;
    this.flare = Math.max(0, this.flare - dt * 1.5);
    const claim = ready ? s.progress : 0;
    this.glow.value = (ready ? 1 + claim * 2.5 + Math.sin(t * 9) * claim * 0.6 : 0.15) + this.flare * 6;
    this.obelisk.scale.setScalar(1 + this.flare * 0.08);
    const at = ready ? { x: s.def.x, z: s.def.z } : null;
    // the giant's claim fills it in frost; gods standing in it hold it back in gold
    this.ring.set(at, JOTUNN.shrineRadius, claim, t, s.contested ? 0xffc23a : 0x4fcfff, s.contested ? 0xfff1c4 : 0xeafcff, { lift: 0, width: 0.8 });
  }
}

// ---------------------------------------------------------------------------

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

/**
 * The Jötunn mode's 3D side: the giant (a GiantModel posed from its own unit,
 * its weak points' units and its warnings, so a guest sees what the host
 * sees), the temple braziers freezing over as it smashes them, the shrines,
 * and the ice, frost and snow its blows throw up.
 *
 * Hook `viewFor` and `structureFor` into UnitViews, feed `onEvent` the sim's
 * events and call `update` each frame. Everything is built here, at load,
 * so no shader is made mid-match.
 */
export class JotunnView {
  readonly group = new THREE.Group();
  readonly model = new GiantModel();
  private readonly parts = new Map<PartId, Unit>();
  private readonly partState = {} as Record<GiantPart, GiantPartState>;
  private readonly braziers: BrazierModel[] = [];
  private readonly shrines: ShrineView[] = [];
  private readonly snow = new Puffs(260, false);
  private readonly mist = new Puffs(220, true);
  private readonly spikes: IceCopies;
  private readonly hail: IceCopies;
  private readonly crust: THREE.BufferGeometry;
  private readonly crustMaterial: THREE.MeshStandardNodeMaterial;
  private readonly plinth = new THREE.CylinderGeometry(1.7, 2.1, 0.9, 6, 1).toNonIndexed();
  private readonly stone: THREE.MeshStandardNodeMaterial;
  /** When each part last broke (seconds on this view's clock), for the stagger and silence. */
  private readonly brokeAt = new Map<PartId, number>();
  private clock = 0;
  /** The warning being wound up: its shape, kept for the blow it lands. */
  private windup: { act: GiantAct; flash: Flash } | null = null;
  private landed: { act: GiantAct; flash: Flash } | null = null;
  private breath = 0;
  private storm: { x: number; z: number; r: number; left: number } | null = null;
  private readonly state: GiantState = { speed: 0, localDir: new THREE.Vector2(), windup: null, kneel: false, plant: null, silenced: false, staggered: null, dead: false };

  constructor(private readonly host: JotunnViewHost) {
    this.group.name = 'jotunn-view';
    this.group.add(this.model.fx, this.snow.sprite, this.mist.sprite);
    for (const id of PART_IDS) this.partState[id] = { alive: true, exposed: false, health: 1 };

    const ice = new THREE.MeshStandardNodeMaterial({ roughness: 0.15, metalness: 0 });
    ice.positionNode = placeInstances(ice);
    iceSurface(ice, float(1));
    this.spikes = new IceCopies(spikeGeometry(), 160, ice);
    const stone = new THREE.MeshStandardNodeMaterial({ roughness: 0.25, metalness: 0 });
    stone.positionNode = placeInstances(stone);
    iceSurface(stone, float(0.6));
    this.hail = new IceCopies(new THREE.IcosahedronGeometry(0.35, 0), 90, stone);
    this.hail.mesh.castShadow = false;
    this.hail.onLand = (p) => {
      this.snow.ring(p.at, 3, 2.2, { life: 0.8, size0: 0.4, size1: 1.4, alpha: 0.55, color: 0xe8f4fa });
      this.spikes.add(p.at, Math.random() * 6.28, 0.35 + Math.random() * 0.25, 0, 0.6);
    };
    this.group.add(this.spikes.mesh, this.hail.mesh);

    this.crustMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0 });
    iceSurface(this.crustMaterial, float(1.3));
    this.crust = clusterGeometry(9, 1.5, 0.3, 0.75, 5);
    this.stone = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.05 });
    this.stone.colorNode = mix(color(0x2a3240), color(0x4c5a6c), mx_noise_float(positionGeometry.mul(2.2)).mul(0.5).add(0.5));
    for (const s of host.shrines()) {
      const v = new ShrineView(s, host.ground, this.plinth, this.stone);
      this.shrines.push(v);
      this.group.add(v.group);
    }

    const m = this.model;
    m.onStep = (at, k) => this.step(at, k);
    m.onImpact = (act, at) => this.impact(act, at);
    m.onShatter = (part, at) => this.shatter(part, at);
    m.onFall = (at, k) => this.fall(at, k);
  }

  // ------------------------------------------------------------- UnitViews hooks

  /** The giant's and its weak points' views. */
  viewFor(u: Unit): MonsterView | undefined {
    const kind = u.origin?.f === 'mode' ? u.origin.kind : '';
    if (kind === 'jotunn:giant') {
      return new GiantView(this.model, this);
    }
    if (u.kind === 'weakpoint' && kind.startsWith('jotunn:')) {
      const id = kind.slice(7) as PartId;
      this.parts.set(id, u);
      return new PartView(id, this);
    }
    return undefined;
  }

  /** A temple brazier, wrapped around the map's fire there. */
  structureFor(u: Unit): StructureModel | undefined {
    if (u.kind !== 'brazier') return undefined;
    const g = this.host.ground(u.x, u.z);
    const b = new BrazierModel(this.host.fireAt(u.x, u.z), u, g, this.crust, this.crustMaterial, this.mist);
    this.braziers.push(b);
    this.group.add(b.root);
    return b;
  }

  /**
   * Builds every effect once, so a loading frame draws them all and prepares
   * their shaders. The giant and the braziers' frost only join the scene on the
   * match's first frame, so they stand in at `at` until the returned call.
   */
  prime(at: THREE.Vector3): () => void {
    this.spikes.add(at, 0, 1, 0, 0.2);
    this.hail.add(at.clone().setY(at.y + 30), 0, 1, 0, 0.2, 0.01, at.y - 1);
    this.snow.spawn(at, tmp.set(0, 0, 0), { life: 0.3, size0: 1, size1: 1, alpha: 0.5, color: 0xffffff });
    this.mist.spawn(at, tmp.set(0, 0, 0), { life: 0.3, size0: 1, size1: 1, alpha: 0.5, color: 0xffffff });
    this.spikes.update(0);
    this.hail.update(0);
    this.snow.update(0);
    this.mist.update(0);
    const giant = this.model.root;
    const loose = !giant.parent;
    if (loose) {
      giant.position.copy(at);
      this.group.add(giant);
    }
    const crust = new THREE.Mesh(this.crust, this.crustMaterial);
    crust.castShadow = true;
    crust.position.copy(at);
    this.group.add(crust);
    return () => {
      crust.removeFromParent();
      if (loose && giant.parent === this.group) this.group.remove(giant);
    };
  }

  // ------------------------------------------------------------------ the giant

  /** Called by the giant's view each frame, after UnitViews has placed its root. */
  animateGiant(u: Unit, dt: number): void {
    const s = this.state;
    const speed = Math.hypot(u.vx, u.vz);
    s.speed = speed;
    if (speed > 0.1) {
      const sin = Math.sin(u.body.yaw);
      const cos = Math.cos(u.body.yaw);
      s.localDir.set((u.vx * cos - u.vz * sin) / speed, (-u.vx * sin - u.vz * cos) / speed);
    } else s.localDir.set(0, 1);
    s.dead = !u.alive;

    // the attack it winds up, from its warning
    const warn = this.host.flashes().find((f) => f.warn && f.owner === u && f.act && GIANT_ACTS[f.act]);
    if (warn) this.windup = { act: GIANT_ACTS[warn.act!]!, flash: warn };
    else if (this.windup) {
      this.landed = this.windup;
      this.windup = null;
    }
    s.windup = warn ? { act: GIANT_ACTS[warn.act!]!, left: Math.max(0, warn.life - warn.age), at: this.aimOf(warn, u) } : null;

    // states the weak points show
    const part = (id: PartId) => this.parts.get(id);
    const kneeL = part('kneeL');
    const kneeR = part('kneeR');
    s.kneel = u.alive && !!kneeL && !!kneeR && !kneeL.alive && !kneeR.alive;
    s.plant = null;
    for (const [id, hand] of [['wristL', 'L'], ['wristR', 'R']] as const) {
      const w = part(id);
      if (w && w.alive && w.untargetable <= 0) s.plant = { hand, at: new THREE.Vector3(w.x, this.host.ground(w.x, w.z), w.z) };
    }
    const since = (id: PartId) => this.clock - (this.brokeAt.get(id) ?? -1e9);
    s.silenced = u.alive && since('rune') < JOTUNN.runeSilence;
    s.staggered = !u.alive ? null : since('wristR') < JOTUNN.wristStagger ? 'R' : since('wristL') < JOTUNN.wristStagger ? 'L' : null;

    for (const id of PART_IDS) {
      const p = part(id);
      const st = this.partState[id];
      st.alive = p ? p.alive : true;
      st.exposed = !!p && p.alive && p.untargetable <= 0 && u.alive;
      st.health = p ? p.combatant.health / p.combatant.stats.maxHealth : 1;
    }
    this.model.update(dt, s, this.partState);
  }

  /** Where a warning's blow lands. */
  private aimOf(f: Flash, u: Unit): THREE.Vector3 {
    const sh = f.shape;
    const out = new THREE.Vector3();
    if (sh.type === 'circle') out.set(sh.x, 0, sh.z);
    else if (sh.type === 'cone') out.set(sh.x - Math.sin(sh.yaw) * sh.range * 0.6, 0, sh.z - Math.cos(sh.yaw) * sh.range * 0.6);
    else out.set(sh.x - Math.sin(sh.yaw) * sh.length * 0.5, 0, sh.z - Math.cos(sh.yaw) * sh.length * 0.5);
    if (sh.type === 'circle' && Math.hypot(sh.x - u.x, sh.z - u.z) < 0.1) out.set(u.x, 0, u.z);
    out.y = this.host.ground(out.x, out.z);
    return out;
  }

  placePart(id: PartId, root: THREE.Object3D): void {
    this.model.partPosition(id, root.position);
  }

  // ------------------------------------------------------------------ events

  onEvent(e: SimEvent): void {
    if (e.type === 'damage' && e.target.kind === 'weakpoint') {
      const id = this.idOf(e.target);
      if (id) {
        this.model.hit(id, Math.min(1, e.amount / 600));
        // ice chips off where it was struck
        const at = this.model.partPosition(id, tmp);
        for (let i = 0; i < 2; i++) this.snow.spawn(at, tmp2.set((Math.random() - 0.5) * 6, 1 + Math.random() * 3, (Math.random() - 0.5) * 6), { life: 0.5, size0: 0.3, size1: 1.1, alpha: 0.6, color: 0xdff3ff, drag: 3 });
      }
    } else if (e.type === 'death' && e.unit.kind === 'weakpoint') {
      const id = this.idOf(e.unit);
      if (id) this.brokeAt.set(id, this.clock);
    } else if (e.type === 'death' && e.unit.kind === 'brazier') {
      const at = tmp.set(e.unit.x, this.host.ground(e.unit.x, e.unit.z) + 1.4, e.unit.z);
      this.host.burst(at, 2);
      this.spikes.add(at.clone().setY(at.y - 1.4), 0, 1.6, 0, 1.2);
      this.mist.ring(at, 14, 5, { life: 1.4, size0: 1, size1: 3.5, alpha: 0.45, color: 0xcfefff });
      this.host.shake(0.35, at);
    }
  }

  private idOf(u: Unit): PartId | null {
    for (const [id, p] of this.parts) if (p === u) return id;
    return null;
  }

  // ------------------------------------------------------------------ effects

  private step(at: THREE.Vector3, k: number): void {
    // snow kicked up around the foot, and the ground shaking
    this.snow.ring(at, Math.round(5 + k * 5), 3 + k * 3, { life: 1.1, size0: 0.8, size1: 2.6 + k, alpha: 0.5, color: 0xe2edf3 });
    this.host.shake(0.18 * k, at);
    this.host.footfall?.(at, k);
  }

  private impact(act: GiantAct, at: THREE.Vector3): void {
    const shape = (this.landed?.act === act ? this.landed.flash : this.windup?.flash)?.shape;
    this.landed = null;
    at.y = this.host.ground(at.x, at.z);
    switch (act) {
      case 'club':
        this.host.burst(tmp.copy(at).setY(at.y + 0.6), 1.4);
        this.snow.ring(at, 10, 6, { life: 1, size0: 1, size1: 3, alpha: 0.5, color: 0xe2edf3 });
        this.host.shake(0.3, at);
        break;
      case 'stomp': {
        const r = 3.6 * 1.75;
        this.host.burst(tmp.copy(at).setY(at.y + 0.5), 2.4);
        this.ringOfSpikes(at, 13, r * 0.55, r * 0.95, 1.6, 2.6, 0.9);
        this.snow.ring(at, 26, 12, { life: 1.5, size0: 1.4, size1: 4.5, alpha: 0.55, color: 0xe2edf3 });
        this.host.shake(0.75, at);
        break;
      }
      case 'slam':
        this.host.burst(tmp.copy(at).setY(at.y + 0.5), 2);
        this.ringOfSpikes(at, 9, 1.6, 3.6, 1.2, 2.2, JOTUNN.plant - 0.3);
        this.snow.ring(at, 18, 9, { life: 1.3, size0: 1.2, size1: 3.8, alpha: 0.55, color: 0xe2edf3 });
        this.host.shake(0.65, at);
        break;
      case 'boulder':
        this.host.burst(tmp.copy(at).setY(at.y + 0.8), 2.2);
        this.ringOfSpikes(at, 7, 1.2, 3.4, 0.7, 1.4, 1.2);
        this.snow.ring(at, 20, 10, { life: 1.4, size0: 1.2, size1: 4, alpha: 0.6, color: 0xc9d3da });
        this.host.shake(0.5, at);
        break;
      case 'roar': {
        // a wave of frost mist rolls out from its feet as the roar hits
        this.mist.ring(at, 36, 16, { life: 1.4, size0: 1.6, size1: 5, alpha: 0.45, color: 0xa8e8ff });
        this.host.burst(tmp.copy(at).setY(at.y + 0.5), 2.6);
        this.host.shake(0.6, at);
        break;
      }
      case 'breath':
        this.breath = 2.0;
        this.host.shake(0.3, at);
        break;
      case 'avalanche':
        if (shape?.type === 'line') this.wall(shape.x, shape.z, shape.yaw, shape.length, shape.width);
        else this.ringOfSpikes(at, 10, 1, 5, 1.4, 2.4, 1);
        this.host.shake(0.85, at);
        break;
      case 'hail':
        if (shape?.type === 'circle') this.storm = { x: shape.x, z: shape.z, r: shape.radius, left: 3 };
        else this.storm = { x: at.x, z: at.z, r: 7, left: 3 };
        break;
    }
  }

  private ringOfSpikes(at: THREE.Vector3, count: number, r0: number, r1: number, s0: number, s1: number, hold: number): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const r = r0 + Math.random() * (r1 - r0);
      const x = at.x + Math.cos(a) * r;
      const z = at.z + Math.sin(a) * r;
      // each leans out, away from the blow; the near ones come up first
      const yaw = Math.atan2(Math.cos(a), Math.sin(a));
      this.spikes.add(tmp.set(x, this.host.ground(x, z), z), yaw, s0 + Math.random() * (s1 - s0), (r - r0) * 0.012, hold);
    }
  }

  /** The avalanche: a wall of ice erupting down the line, front to back. */
  private wall(x: number, z: number, yaw: number, length: number, width: number): void {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    for (let d = 2; d < length; d += 1.3) {
      for (const side of [-0.32, 0, 0.32]) {
        const off = side * width + (Math.random() - 0.5) * 0.6;
        const px = x + fx * d + -fz * off;
        const pz = z + fz * d + fx * off;
        const y = this.host.ground(px, pz);
        const size = (side === 0 ? 2.4 : 1.7) * (0.8 + Math.random() * 0.4) * (1 - d / length * 0.3);
        this.spikes.add(tmp.set(px, y, pz), yaw + Math.PI + (Math.random() - 0.5) * 0.8, size, d * 0.018, 0.9);
      }
      if (Math.random() < 0.6) this.snow.spawn(tmp.set(x + fx * d, this.host.ground(x + fx * d, z + fz * d) + 0.5, z + fz * d), tmp2.set((Math.random() - 0.5) * 4, 2 + Math.random() * 2, (Math.random() - 0.5) * 4), { life: 1.6, size0: 1.5, size1: 4.5, alpha: 0.55, color: 0xe2edf3, drag: 1.2 });
    }
  }

  private shatter(_part: GiantPart, at: THREE.Vector3): void {
    this.host.burst(at, 1.6);
    this.mist.ring(at, 12, 7, { life: 0.9, size0: 0.8, size1: 2.6, alpha: 0.6, color: 0xbfefff });
    this.host.shake(0.3, at);
  }

  private fall(at: THREE.Vector3, k: number): void {
    at.y = this.host.ground(at.x, at.z);
    this.snow.ring(at, Math.round(30 * k), 14, { life: 2, size0: 2, size1: 6, alpha: 0.6, color: 0xe2edf3 });
    this.host.shake(0.9 * k, at);
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, t: number): void {
    this.clock += dt;
    // the frost breath streams from its mouth, sweeping with its head
    if (this.breath > 0) {
      this.breath -= dt;
      this.model.mouth(tmp, tmp2);
      const n = Math.round(dt * 70) + (Math.random() < (dt * 70) % 1 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const v = tmp2.clone();
        v.y = Math.min(v.y, -0.25);
        v.normalize();
        v.x += (Math.random() - 0.5) * 0.45;
        v.y += (Math.random() - 0.5) * 0.2;
        v.z += (Math.random() - 0.5) * 0.45;
        v.normalize().multiplyScalar(22 + Math.random() * 8);
        this.mist.spawn(tmp, v, { life: 0.75, size0: 0.8, size1: 4.2, alpha: 0.5, color: Math.random() < 0.3 ? 0xeafcff : 0x7fdcff, drag: 1.6 });
      }
      // the ground it rakes frosts over
      if (Math.random() < dt * 8) {
        const d = 6 + Math.random() * 10;
        const gx = tmp.x + tmp2.x * d;
        const gz = tmp.z + tmp2.z * d;
        this.spikes.add(tmp.set(gx, this.host.ground(gx, gz), gz), Math.random() * 6.28, 0.5 + Math.random() * 0.5, 0, 0.8);
      }
    }
    // hail: stones falling all over the storm
    if (this.storm) {
      const s = this.storm;
      s.left -= dt;
      const n = Math.round(dt * 26) + (Math.random() < (dt * 26) % 1 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * s.r;
        const x = s.x + Math.cos(a) * r;
        const z = s.z + Math.sin(a) * r;
        const y = this.host.ground(x, z);
        this.hail.add(tmp.set(x, y + 26 + Math.random() * 6, z), Math.random() * 6.28, 0.6 + Math.random() * 0.7, 0, 3, 34, y);
      }
      if (s.left <= 0) this.storm = null;
    }
    this.spikes.update(dt);
    this.hail.update(dt);
    this.snow.update(dt);
    this.mist.update(dt);
    for (const b of this.braziers) b.update(dt);
    for (const s of this.shrines) s.update(dt, t);
  }
}
