import * as THREE from 'three/webgpu';
import type { CastKind, GodModel } from '../actors/GodModel';
import { createGodModel } from './godModels';
import { float, fract, length, mix, mx_noise_float, positionGeometry, smoothstep, uv, vec3 } from '../render/tsl';
import { summonCount, summonLook, type StructureKind, type SummonLook } from '../sim/factory';
import { isStructure, type Forced, type SimEvent, type Unit } from '../sim/Unit';
import { MinionViews } from './MinionViews';
import { createMonsterView, monsterViewKey, type MonsterView } from './MonsterViews';
import { createStructureModel, type StructureModel } from './structures';
import { MUZZLE_HEIGHT } from './Vfx';
import { castStaticAsOne } from '../scene/merge';
import { hypot, turnToward } from '../core/math';
import type { Billows } from '../scene/Billows';
import { TEAM_STYLE } from '../scene/structures/common';
import { paletteOf } from './palette';
import { settings } from '../settings/store';

const _cloudAt = new THREE.Vector3();
/**
 * A structure's blast in its team's fire. Order's is lighter than its brazier
 * blue: tone mapping pushes a bright pure blue toward violet, so a blast in
 * 0x1446ff read as purple paint.
 */
const BLAST_FLAME: Record<'order' | 'chaos', [number, number]> = {
  order: [0x1e8cff, 0xd4f6ff],
  chaos: [TEAM_STYLE.chaos.fire.low, TEAM_STYLE.chaos.fire.high],
};

/** Which pool of spare models a summon's look draws from. */
const summonKey = (look: SummonLook): string => `${look.god}|${look.variant}`;

/** The look of a summoned unit, from what called it up and who (see summonLook). */
function summonLookOf(u: Unit): SummonLook {
  return summonLook(u.origin?.f === 'summon' ? u.origin.kind : '', u.owner?.combatant.god.id ?? u.combatant.god.id);
}

/** Seconds a fallen god stays on the ground before it is hidden. */
const GOD_CORPSE = 2.8;

/** Radians a god leans at the height of a full throw (a Jötunn stomp's arc); a lower arc, less. */
export const THROWN_LEAN = 0.6;
/** Arcs below this (a pull, a stagger) leave a god upright; the full lean is reached at FULL_LEAN_ARC. */
const LEAN_FROM_ARC = 0.5;
const FULL_LEAN_ARC = 1.5;
const leanMid = new THREE.Vector3();

/**
 * How a god flung through the air leans, in its own frame (pitch: top
 * forward +; roll: top to its right +). The top goes the way it flies, most
 * at the height of the arc and upright again as it lands; thrown straight up,
 * it rocks back. Leaps (which fly over walls) keep their own pose.
 */
export function thrownLean(f: Forced | null, yaw: number, out: { pitch: number; roll: number }): { pitch: number; roll: number } {
  out.pitch = 0;
  out.roll = 0;
  if (!f || !f.collide || f.arc < LEAN_FROM_ARC || f.total <= 0) return out;
  const p = Math.min(1, Math.max(0, 1 - f.remaining / f.total));
  // whipped back fast as it leaves the ground, righted by the time its feet touch down
  const s = Math.sin(Math.PI * p);
  const lean = THROWN_LEAN * Math.min(1, f.arc / FULL_LEAN_ARC) * (p < 0.5 ? Math.sqrt(s) : s * Math.sqrt(s));
  const speed = hypot(f.vx, f.vz);
  if (speed < 0.1) {
    out.pitch = -lean * 0.6;
    return out;
  }
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // world velocity into the model's frame: forward (-sin, -cos), right (cos, -sin)
  out.pitch = (lean * (-f.vx * sin - f.vz * cos)) / speed;
  out.roll = (lean * (f.vx * cos - f.vz * sin)) / speed;
  return out;
}

/** How far a fallen god has sunk into the ground, in the last second before it is hidden. */
function godSink(deathTime: number): number {
  const t = THREE.MathUtils.clamp(deathTime - (GOD_CORPSE - 1), 0, 1);
  return t * t * 0.9;
}

let dummyLook: Record<'wood' | 'straw' | 'rope' | 'stone' | 'burlap' | 'paint', THREE.MeshStandardNodeMaterial> | null = null;
const dummyShadow: { geometry?: THREE.BufferGeometry } = {};

/** The training dummy's materials, shared by every dummy so a new one builds no shader. */
function dummyMaterials(): NonNullable<typeof dummyLook> {
  if (dummyLook) return dummyLook;
  const wood = new THREE.MeshStandardNodeMaterial({ color: 0x6b4426, roughness: 0.8 });
  wood.colorNode = mix(vec3(0.24, 0.14, 0.07), vec3(0.42, 0.27, 0.14), mx_noise_float(positionGeometry.mul(vec3(2, 26, 2))).mul(0.5).add(0.5));
  const straw = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  const fiber = mx_noise_float(positionGeometry.mul(vec3(40, 3, 40))).mul(0.5).add(0.5);
  straw.colorNode = mix(vec3(0.45, 0.33, 0.12), vec3(0.85, 0.68, 0.3), fiber);
  const rope = new THREE.MeshStandardNodeMaterial({ color: 0x5a4630, roughness: 0.9 });
  const stone = new THREE.MeshStandardNodeMaterial({ color: 0x8c877c, roughness: 0.85 });
  const burlap = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  burlap.colorNode = mix(vec3(0.4, 0.32, 0.22), vec3(0.55, 0.45, 0.32), mx_noise_float(positionGeometry.mul(60)).mul(0.5).add(0.5));
  const paint = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.1 });
  const r = length(uv().sub(0.5)).mul(2);
  const ring = fract(r.mul(2.5)).step(0.5);
  const bull = smoothstep(0.22, 0.2, r);
  const red = vec3(0.6, 0.06, 0.04);
  const cream = vec3(0.85, 0.78, 0.6);
  const gold = vec3(0.9, 0.65, 0.2);
  paint.colorNode = mix(mix(cream, red, ring), gold, bull).mul(float(0.85).add(mx_noise_float(positionGeometry.mul(30)).mul(0.15)));
  dummyLook = { wood, straw, rope, stone, burlap, paint };
  for (const [name, m] of Object.entries(dummyLook)) m.name = `dummy-${name}`;
  return dummyLook;
}

/** A wooden training post with a straw body and a painted target shield: the parts `DummyCrowd` poses. */
function buildDummy(): THREE.Group {
  const g = new THREE.Group();
  const { wood, straw, rope, stone, burlap, paint } = dummyMaterials();

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  add(new THREE.CylinderGeometry(0.62, 0.7, 0.28, 10), stone, 0, 0.14, 0);
  add(new THREE.CylinderGeometry(0.09, 0.11, 2.1, 10), wood, 0, 1.2, 0);
  add(new THREE.CylinderGeometry(0.36, 0.3, 1.05, 14, 4), straw, 0, 1.35, 0);
  for (const y of [0.98, 1.35, 1.72]) add(new THREE.TorusGeometry(0.345, 0.03, 6, 20), rope, 0, y, 0, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.07, 0.07, 1.6, 8), wood, 0, 1.62, 0, 0, Math.PI / 2);
  for (const x of [-0.82, 0.82]) add(new THREE.SphereGeometry(0.14, 10, 8), straw, x, 1.62, 0);
  add(new THREE.SphereGeometry(0.25, 14, 10), burlap, 0, 2.12, 0);
  // the target faces +Z (the model's front, like the god model)
  add(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 28), paint, 0, 1.32, 0.36, Math.PI / 2);
  // its dozen parts cast as one
  castStaticAsOne(g, dummyShadow);
  return g;
}

/** Room for this many training dummies at once. */
const DUMMY_CAPACITY = 8;

/**
 * Every training dummy in one draw per material and one shadow caster, where
 * each dummy's dozen parts were a draw each: a BatchedMesh per material holds
 * the post's parts, posed per dummy. The materials read `positionGeometry`,
 * each part's own unposed position, so their grain sits on the parts as before.
 */
class DummyCrowd {
  readonly group = new THREE.Group();
  /** Each part of the post: its batch, its geometry there, and its place on the post. */
  private readonly parts: { mesh: THREE.BatchedMesh; geometry: number; matrix: THREE.Matrix4 }[] = [];
  private readonly ids = new Map<THREE.Object3D, number[]>();
  private readonly m = new THREE.Matrix4();

  constructor() {
    this.group.name = 'dummies';
    const post = buildDummy();
    post.updateMatrixWorld(true);
    const byMat = new Map<THREE.Material, THREE.Mesh[]>();
    post.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const list = byMat.get(m.material as THREE.Material);
      if (list) list.push(m);
      else byMat.set(m.material as THREE.Material, [m]);
    });
    for (const [material, meshes] of byMat) {
      const vertices = meshes.reduce((n, m) => n + m.geometry.getAttribute('position').count, 0);
      const indices = meshes.reduce((n, m) => n + (m.geometry.index?.count ?? 0), 0);
      const batch = new THREE.BatchedMesh(DUMMY_CAPACITY * meshes.length, vertices, indices, material);
      // (a handful of posts: culling and sorting them would cost more than drawing them)
      batch.perObjectFrustumCulled = false;
      batch.sortObjects = false;
      batch.frustumCulled = false;
      // the parts' shadow settings, and the stand-in's shadow-only layer
      batch.name = meshes[0]!.name;
      batch.castShadow = meshes[0]!.castShadow;
      batch.receiveShadow = meshes[0]!.receiveShadow;
      batch.layers.mask = meshes[0]!.layers.mask;
      batch.visible = false;
      for (const m of meshes) this.parts.push({ mesh: batch, geometry: batch.addGeometry(m.geometry), matrix: m.matrixWorld.clone() });
      this.group.add(batch);
    }
  }

  /** Gives a dummy, posed by `root`, its parts. */
  add(root: THREE.Object3D): void {
    this.ids.set(root, this.parts.map((p) => p.mesh.addInstance(p.geometry)));
    for (const p of this.parts) p.mesh.visible = true;
  }

  remove(root: THREE.Object3D): void {
    const ids = this.ids.get(root);
    if (!ids) return;
    this.parts.forEach((p, i) => p.mesh.deleteInstance(ids[i]!));
    this.ids.delete(root);
    if (!this.ids.size) for (const p of this.parts) p.mesh.visible = false;
  }

  /** Poses a dummy's parts where its root stands (in this group's space), or hides them with it. */
  place(root: THREE.Object3D): void {
    const ids = this.ids.get(root);
    if (!ids) return;
    root.updateMatrix();
    this.parts.forEach((p, i) => {
      p.mesh.setMatrixAt(ids[i]!, this.m.multiplyMatrices(root.matrix, p.matrix));
      p.mesh.setVisibleAt(ids[i]!, root.visible);
    });
  }
}


/** How often (in frames) a god model off screen is animated. */
const OFFSCREEN_EVERY = 8;
/** The longest step GodModel.animate takes without dropping time. */
const MAX_ANIM_DT = 1 / 20;
/**
 * Gods and monsters farther than this from the camera cast no shadow. The sun's
 * far cascades cover the whole map, so every jungle camp otherwise drew its
 * dozens of parts into them each frame: most of a frame's draw calls.
 */
const SHADOW_RANGE = 55;
/** Seconds a monster takes to climb out of the floor (Underworld Descent). */
export const EMERGE_TIME = 0.6;

interface UnitView {
  root: THREE.Group;
  model: GodModel | null;
  /** Height of the head above the feet, for bars and effects. */
  height: number;
  wobble: number;
  wobbleVel: number;
  deathTime: number;
  localDir: THREE.Vector2;
  lift: number;
  structure: StructureModel | null;
  /** The map owns and updates this structure model; combat only drives its state. */
  external: boolean;
  /** Last frame's windup, to start the slam animation once. */
  windup: number;
  /** Seconds since a destroyed structure began to rise again, or -1. */
  rebirth: number;
  /** Seconds since a monster began to climb out of the floor, or -1. */
  emerge: number;
  monster: MonsterView | null;
  /** Built by the mode's own view (see the `custom` hook), the player's included. */
  custom: boolean;
  /** Time the god model's animation has not caught up on yet (see animateEvery). */
  animDt: number;
  /** Staggers reduced-rate animation so gods don't all update on the same frame. */
  stagger: number;
  /** The meshes that cast shadows when near the camera, collected on first use. */
  casters?: THREE.Mesh[];
  shadows?: boolean;
}

/**
 * The 3D side of every unit: god models for bots and summons, training
 * posts, death and hit reactions. The player's model is owned by the
 * PlayerController; this only adds cast poses, lift and visibility to it.
 */
export class UnitViews {
  readonly group = new THREE.Group();
  readonly minions = new MinionViews();
  /** Built with the first training dummy. */
  private dummies: DummyCrowd | null = null;
  private readonly views = new Map<Unit, UnitView>();
  /** Relic Rush: fallen gods are dazed, not dead, and lie where they fell instead of sinking away. */
  dazes = false;
  /** Relic Rush: the god carrying the relic, who holds it up in their off hand (null: nobody). */
  carrier: Unit | null = null;
  /** Relic Rush: the god a pass is about to reach, whose off hand goes out to meet it at `catchAt` (null: nobody). */
  catcher: Unit | null = null;
  readonly catchAt = new THREE.Vector3();
  /** Underworld Descent: the dead claw their way up out of the floor instead of appearing on it. */
  emergeMonsters = false;
  /** Turns laid over how gods face (see `turn`), by god. */
  private readonly turns = new Map<Unit, { yaw: number; weight: number }>();
  private readonly prev = new Map<Unit, THREE.Vector3>();
  private readonly cur = new Map<Unit, THREE.Vector3>();
  /** When set, gods off screen or far away animate at a reduced rate. */
  camera: THREE.Camera | null = null;
  /** Where a falling structure's dust and smoke billow (the world's). */
  billows: Billows | null = null;
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  private readonly bounds = new THREE.Sphere();
  private frameNo = 0;
  private readonly lean = { pitch: 0, roll: 0 };
  private created = 0;
  /** Monster views built ahead of their monsters (see stock), by monsterViewKey. */
  private readonly spares = new Map<string, MonsterView[]>();
  /** Monsters still to get a spare view, built one a frame. */
  private readonly toBuild: { tag: string; name: string }[] = [];
  /**
   * Summon models waiting for their next cast, by summonKey: built ahead
   * for every god that can summon, and handed back when a summon ends, so a
   * cast never builds a god model in its frame (several ms each).
   */
  private readonly summonSpares = new Map<string, GodModel[]>();
  /** Summon models still to build ahead, one a frame once the monsters' are done. */
  private readonly summonsToBuild: SummonLook[] = [];
  /** Gods whose summons are already stocked. */
  private readonly summoners = new WeakSet<Unit>();

  constructor(
    private player: Unit,
    private playerModel: GodModel,
    /** Structure models the map already built and placed, by unit. */
    private readonly mapStructure: (u: Unit) => StructureModel | undefined = () => undefined,
    /** Views a mode draws its own units with (the Jötunn and its weak points), the player's unit included. */
    private readonly custom: (u: Unit) => MonsterView | undefined = () => undefined,
  ) {
    this.group.name = 'units';
    this.group.add(this.minions.group);
  }

  /**
   * The clouds of a structure falling (or a Phoenix rising): a ring of dust
   * thrown out across the ground, smoke rolling up through the wreck, dust
   * where the big pieces land, and for a Phoenix a burst of its team's fire.
   */
  private structureClouds(u: Unit, v: UnitView, rising: boolean): void {
    const b = this.billows;
    if (!b) return;
    const p = v.root.getWorldPosition(_cloudAt);
    const flame = BLAST_FLAME[u.side === 'chaos' ? 'chaos' : 'order'];
    if (u.kind === 'phoenix') {
      b.spawn('blast', p.x, p.y + 6.2, p.z, rising ? 7 : 9.5, { duration: 1.6, tint: 0x5a4c44, flame, rise: 0.6 });
      if (!rising) {
        b.spawn('smoke', p.x, p.y + 4.5, p.z, 8, { duration: 2.6, delay: 0.45, tint: 0x4a423c, rise: 1.2 });
        b.spawn('dust', p.x, p.y + 1.3, p.z, 13, { duration: 2, delay: 0.7, tint: 0x9c8c78 });
      }
      return;
    }
    if (rising) return;
    const big = u.kind === 'titan' ? 1.6 : 1;
    const h = v.height;
    // a baked collapse (tools/collapse) crumbles for a second before the crown comes down: the dust waits for it
    const crumble = u.kind === 'tower' && (v.structure?.fallTime ?? 2.2) > 2.2;
    const land = crumble ? 1.25 : 0.35;
    // the crown bursts in its team's light, then everything comes down
    if (u.kind === 'tower') b.spawn('blast', p.x, p.y + h * 0.62, p.z, 5.5, { duration: 1.2, tint: 0x5a5048, flame, rise: 0.4 });
    if (crumble) b.spawn('dust', p.x, p.y + 1.2, p.z, 9, { duration: 1.6, delay: 0.15, tint: 0xc4b8a4 });
    b.spawn('dust', p.x, p.y + 1.6 * big, p.z, 17 * big, { duration: 2.6, delay: land, tint: 0xb8ab95 });
    b.spawn('smoke', p.x, p.y + h * 0.45, p.z, 10 * big, { duration: 3.2, delay: crumble ? 0.9 : 0.25, tint: 0x8a8074, rise: 1.4 });
    // dust where the heavy pieces hit, around the foot
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = (3 + Math.random() * 2.5) * big;
      b.spawn('dust', p.x + Math.cos(a) * d, p.y + 0.9, p.z + Math.sin(a) * d, (6 + Math.random() * 3) * big, { duration: 1.8, delay: land + 0.35 + i * 0.25, tint: 0xbcae98 });
    }
  }

  /**
   * Builds the training dummies' views now, so the loading screen draws their
   * batches: three keys a batch's shaders to the batch itself, so drawing
   * any other copy would not spare these a build mid-match. The gods
   * already in the match are built now too, rather than all in the first
   * frame after the loading screen (a few ms each), and so are the
   * summoners' summon models (their shaders are the gods' own, already
   * warm), so no cast builds a model mid-match.
   */
  prime(units: readonly Unit[]): void {
    for (const u of units) if ((u.kind === 'dummy' || u.kind === 'god') && !this.views.has(u)) this.create(u);
    // (creating a god's view queued its summons: build them all now)
    while (this.summonsToBuild.length) this.buildSpare();
  }

  /**
   * Builds the models of monsters that are about to arrive, one a frame, so a
   * wave rising out of the floor doesn't build a whole pack's models in the
   * frame it appears (a dozen ms for a big wave). `coming` lists the monsters
   * to come by their tag and name; spares already built count toward it, so
   * repeated calls never stock more than one chamber's worth.
   */
  stock(coming: readonly { tag: string; name: string }[]): void {
    this.toBuild.length = 0;
    const wanted = new Map<string, number>();
    for (const m of coming) {
      const key = monsterViewKey(m);
      const n = (wanted.get(key) ?? 0) + 1;
      wanted.set(key, n);
      if (n > (this.spares.get(key)?.length ?? 0)) this.toBuild.push(m);
    }
  }

  /** Spare monster views ready, for tests and the performance probe. */
  get spareCount(): number {
    let n = 0;
    for (const list of this.spares.values()) n += list.length;
    return n;
  }

  /** Spare summon models ready, for tests and the performance probe. */
  get summonSpareCount(): number {
    let n = 0;
    for (const list of this.summonSpares.values()) n += list.length;
    return n;
  }

  /** Queues models for every summon this god's skills can call up (a cast's worth each), once per god. */
  private stockSummons(u: Unit): void {
    if (this.summoners.has(u)) return;
    this.summoners.add(u);
    const god = u.combatant.god;
    for (const skill of god.skills)
      for (const e of skill.effects) {
        if (e.kind !== 'summon') continue;
        const look = summonLook(e.unit, god.id);
        for (let i = 0; i < summonCount(e.unit); i++) this.summonsToBuild.push(look);
      }
  }

  /** A model for a summon that has arrived: a spare when one is ready, else a new one. */
  private summonModel(u: Unit): GodModel {
    const look = summonLookOf(u);
    const key = summonKey(look);
    const spare = this.summonSpares.get(key)?.pop();
    if (spare) {
      spare.rest();
      return spare;
    }
    // built now, so one less to build ahead
    const i = this.summonsToBuild.findIndex((m) => summonKey(m) === key);
    if (i >= 0) this.summonsToBuild.splice(i, 1);
    return this.buildSummon(look);
  }

  private buildSummon(look: SummonLook): GodModel {
    const model = createGodModel(look.god, look.variant);
    if (look.variant === 'einherjar') model.root.scale.setScalar(0.88);
    return model;
  }

  /** A summon's view is gone: its model waits, casting its shadow again, for the next cast. */
  private keepSummon(u: Unit, model: GodModel, casters: readonly THREE.Mesh[] | undefined): void {
    if (casters) for (const m of casters) m.castShadow = true;
    this.spareSummon(summonKey(summonLookOf(u)), model);
  }

  private spareSummon(key: string, model: GodModel): void {
    const list = this.summonSpares.get(key);
    if (list) list.push(model);
    else this.summonSpares.set(key, [model]);
  }

  private buildSpare(): void {
    const m = this.toBuild.shift();
    if (!m) {
      const look = this.summonsToBuild.shift();
      if (look) this.spareSummon(summonKey(look), this.buildSummon(look));
      return;
    }
    const key = monsterViewKey(m);
    const list = this.spares.get(key);
    const v = createMonsterView(m);
    if (list) list.push(v);
    else this.spares.set(key, [v]);
  }

  /** A spare view for a monster that has arrived, or a new one (which no longer needs building ahead). */
  private monsterView(u: Unit): MonsterView {
    const key = monsterViewKey(u);
    const spare = this.spares.get(key)?.pop();
    if (spare) return spare;
    const i = this.toBuild.findIndex((m) => monsterViewKey(m) === key);
    if (i >= 0) this.toBuild.splice(i, 1);
    return createMonsterView(u);
  }

  /** After a god switch: the old player's view is dropped (its model belongs to the controller). */
  setPlayer(u: Unit, model: GodModel): void {
    if (!this.views.get(this.player)?.custom) this.views.delete(this.player);
    this.player = u;
    this.playerModel = model;
  }

  /** Called before each fixed simulation step, so frames can interpolate between steps. */
  beforeStep(units: readonly Unit[]): void {
    for (const u of units) {
      const c = this.cur.get(u);
      const p = this.prev.get(u) ?? new THREE.Vector3();
      if (c) p.copy(c);
      else p.set(u.x, u.body.y, u.z);
      this.prev.set(u, p);
    }
  }

  afterStep(units: readonly Unit[]): void {
    for (const u of units) {
      const c = this.cur.get(u) ?? new THREE.Vector3();
      c.set(u.x, u.body.y, u.z);
      this.cur.set(u, c);
    }
  }

  /** Scratch for frame(), kept so a frame makes no garbage: the units seen this frame, the minions among them, and the minion batch's lookups. */
  private readonly seen = new Set<Unit>();
  private readonly minionsNow: Unit[] = [];
  private readonly minionAt = (u: Unit) => this.views.get(u)!.root.position;
  private readonly minionDeath = (u: Unit) => this.views.get(u)!.deathTime;
  private readonly minionShown = (u: Unit) => this.views.get(u)!.root.visible;

  frame(units: readonly Unit[], dt: number, alpha: number, time = 0): void {
    this.frameNo++;
    if (this.camera) this.frustum.setFromProjectionMatrix(this.viewProj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const seen = this.seen;
    const minions = this.minionsNow;
    seen.clear();
    minions.length = 0;
    for (const u of units) {
      seen.add(u);
      const v = this.views.get(u) ?? this.create(u);
      this.animate(u, v, dt, alpha);
      if (!v.structure && this.camera) this.setShadows(v, this.camera.position.distanceToSquared(v.root.position) < SHADOW_RANGE ** 2);
      if (u.kind === 'minion') minions.push(u);
      if (v.structure && !v.external) v.structure.update(dt, time, this.camera ?? undefined);
    }
    this.minions.frame(minions, dt, this.minionAt, this.minionDeath, this.minionShown);
    for (const [u, v] of this.views) {
      if (seen.has(u)) continue;
      if (u !== this.player || v.custom) this.group.remove(v.root);
      if (u.kind === 'dummy') this.dummies?.remove(v.root);
      if (u.kind === 'summon' && v.model) this.keepSummon(u, v.model, v.casters);
      this.views.delete(u);
      this.prev.delete(u);
      this.cur.delete(u);
    }
    this.buildSpare();
  }

  private setShadows(v: UnitView, on: boolean): void {
    if (v.shadows === on) return;
    if (!v.casters) {
      v.casters = [];
      v.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.castShadow) v.casters!.push(o as THREE.Mesh);
      });
    }
    v.shadows = on;
    for (const m of v.casters) m.castShadow = on;
  }

  /** Hit-stop on a god's pose (the player's included); other units just wobble. */
  /** A move of the arms without an attack: Relic Rush's throw (from the off hand that held it up) and a scorer's cheer (the ultimate's arms to the sky). */
  /**
   * Turns a god's model `weight` (0 to 1) of the way toward facing `yaw`,
   * over whatever its sim facing is: a scorer turning to the camera. Weight 0
   * hands it back. The player's own model is turned by its controller.
   */
  turn(u: Unit, yaw: number, weight: number): void {
    if (weight <= 0) this.turns.delete(u);
    else {
      const t = this.turns.get(u);
      if (t) {
        t.yaw = yaw;
        t.weight = weight;
      } else this.turns.set(u, { yaw, weight });
    }
  }

  swing(u: Unit, kind: CastKind = 'basic'): void {
    (u === this.player ? this.playerModel : this.views.get(u)?.model)?.startCast(kind);
  }

  hitStop(u: Unit, seconds: number): void {
    (u === this.player ? this.playerModel : this.views.get(u)?.model)?.hitStop(seconds);
  }

  onEvent(e: SimEvent): void {
    if (e.type === 'damage') {
      const v = this.views.get(e.target);
      if (v && !v.structure) {
        v.wobbleVel += Math.min(6, 1.5 + e.amount / 40);
        v.model?.flinch(0.35 + e.amount / 150);
        if (v.model && e.amount > 0) {
          // the blow lands in light, as bright as it is heavy (a burn's tick a glint, a crit or a big chunk white-hot),
          // gentler on your own god and with reduced flashing
          const chunk = e.amount / Math.max(1, e.target.combatant.stats.maxHealth);
          const k = (e.target === this.player ? 0.6 : 1) * (settings().reduceFlashes ? 0.45 : 1);
          v.model.flash(Math.min(1, (e.crit ? 0.85 : 0.35) + chunk * 4) * k, e.source ? paletteOf(e.source).core : 0xffffff);
        }
      }
      if (e.target.kind === 'minion') this.minions.hit(e.target, e.amount);
    } else if (e.type === 'basic') {
      const v = this.views.get(e.unit);
      v?.structure?.pulseFire();
      v?.model?.startCast('basic');
    } else if (e.type === 'cast') {
      this.views.get(e.unit)?.model?.startCast(e.cast.skill.kind === 'ultimate' ? 'ult' : 'skill');
    } else if (e.type === 'death') {
      const v = this.views.get(e.unit);
      if (v) v.deathTime = 0;
      if (v?.structure) this.structureClouds(e.unit, v, false);
    } else if (e.type === 'respawn' && isStructure(e.unit)) {
      const v = this.views.get(e.unit);
      if (v) v.rebirth = 0;
      if (v?.structure) this.structureClouds(e.unit, v, true);
    } else if (e.type === 'respawn' || e.type === 'teleport') {
      // don't interpolate across the map
      const p = this.prev.get(e.unit);
      if (p) p.set(e.unit.x, e.unit.body.y, e.unit.z);
      const c = this.cur.get(e.unit);
      if (c) c.set(e.unit.x, e.unit.body.y, e.unit.z);
    }
  }

  /** A unit's height as drawn (a Champion's grown size included), or null before it has a view. */
  heightOf(u: Unit): number | null {
    return this.views.get(u)?.height ?? null;
  }

  /** World position of a god's off (left) hand as posed, or null without a model on show. */
  handOf(u: Unit, out: THREE.Vector3): THREE.Vector3 | null {
    const v = this.views.get(u);
    if (!v?.model || !v.root.visible) return null;
    return v.model.leftHand.getWorldPosition(out);
  }

  /** World position just above a unit's head (for health bars). */
  headOf(u: Unit, out: THREE.Vector3): THREE.Vector3 | null {
    const v = this.views.get(u);
    if (!v || !v.root.visible) return null;
    return out.copy(v.root.position).setY(v.root.position.y + v.height + 0.5);
  }

  private create(u: Unit): UnitView {
    let root: THREE.Group;
    let model: GodModel | null = null;
    let structure: StructureModel | null = null;
    let external = false;
    let monster: MonsterView | null = null;
    let height = 2.45;
    const own = this.custom(u);
    if (own) {
      monster = own;
      root = own.root;
      height = own.height;
      this.group.add(root);
    } else if (u === this.player) {
      model = this.playerModel;
      root = model.root;
      this.stockSummons(u);
    } else if (u.kind === 'dummy') {
      // drawn by the batched crowd; this root only carries the pose
      root = new THREE.Group();
      height = 2.3;
      if (!this.dummies) this.group.add((this.dummies = new DummyCrowd()).group);
      this.dummies.add(root);
    } else if (u.kind === 'minion') {
      // drawn by the instanced crowd; this root only carries the position
      root = new THREE.Group();
      height = u.tag.endsWith('brute') ? 2.7 : 1.85;
    } else if (u.kind === 'monster') {
      monster = this.monsterView(u);
      root = monster.root;
      height = monster.height;
      this.group.add(root);
    } else if (isStructure(u)) {
      const placed = this.mapStructure(u);
      external = !!placed;
      structure = placed ?? createStructureModel(u.kind as StructureKind, u.side);
      root = structure.root as THREE.Group;
      height = structure.height;
      if (!placed) {
        root.position.set(u.x, u.body.y, u.z);
        root.rotation.y = u.body.yaw + Math.PI;
        this.group.add(root);
      }
      if (structure.muzzle) {
        // shots leave from the model's muzzle
        root.updateMatrixWorld(true);
        MUZZLE_HEIGHT[u.kind] = structure.muzzle.getWorldPosition(new THREE.Vector3()).y - root.position.y;
      }
    } else if (u.kind === 'summon') {
      model = this.summonModel(u);
      root = model.root;
      this.group.add(root);
    } else {
      model = createGodModel(u.combatant.god.id);
      root = model.root;
      this.group.add(root);
      if (u.kind === 'god') this.stockSummons(u);
    }
    const v: UnitView = { root, model, height, wobble: 0, wobbleVel: 0, deathTime: -1, localDir: new THREE.Vector2(), lift: 0, structure, rebirth: -1, emerge: this.emergeMonsters && u.kind === 'monster' && u.alive ? 0 : -1, external, windup: 0, monster, custom: !!own, animDt: 0, stagger: this.created++ };
    this.views.set(u, v);
    return v;
  }

  private animate(u: Unit, v: UnitView, dt: number, alpha: number): void {
    // spring wobble when hit
    v.wobbleVel += (-v.wobble * 60 - v.wobbleVel * 7) * dt;
    v.wobble += v.wobbleVel * dt;

    if (v.model) {
      const target = u.sinceAction < v.model.castHold ? 1 : 0;
      v.model.castWeight += (target - v.model.castWeight) * (1 - Math.exp(-dt * (target ? 22 : 6)));
      // a dash, juke or shove on the ground: which way it goes in the god's own frame (forward (-sin, -cos), right (cos, -sin))
      const f = u.forced;
      v.model.dashing = !!f && f.arc === 0 && u.alive;
      if (f && v.model.dashing) {
        const sin = Math.sin(u.body.yaw);
        const cos = Math.cos(u.body.yaw);
        v.model.dashDir.set(f.vx * cos - f.vz * sin, -f.vx * sin - f.vz * cos);
        if (v.model.dashDir.lengthSq() > 1e-6) v.model.dashDir.normalize();
      }
      v.model.carrying = u === this.carrier && u.alive;
      v.model.reaching = u === this.catcher && u.alive;
      if (v.model.reaching) v.model.reachTo.copy(this.catchAt);
    }

    const liftGoal = u.untargetable > 0 && u.alive ? 5 : 0;
    v.lift += (liftGoal - v.lift) * (1 - Math.exp(-dt * 4));

    if (!u.alive) {
      if (v.deathTime < 0) v.deathTime = 0;
      v.deathTime += dt;
    } else v.deathTime = -1;
    if (v.model) v.model.deathTime = v.deathTime;

    // a downed god (Underworld Descent) lies where it fell until it is raised; a dazed one (Relic Rush) until it stands up
    const lying = (u.downed || (this.dazes && u.kind === 'god')) && !u.alive;
    if (u === this.player && !v.custom) {
      // no sink: the camera follows this root through the respawn wait
      v.root.visible = u.alive || lying || v.deathTime < GOD_CORPSE;
      v.root.position.y += v.lift;
      this.leanThrown(u, v, 0);
      return;
    }

    if (v.structure) {
      const s = v.structure;
      s.setShielded(u.alive && u.shielded());
      const c = u.combatant;
      s.setDamage?.(u.alive ? 1 - c.health / c.stats.maxHealth : 1);
      if (u.windup > 0 && v.windup <= 0) s.attack?.();
      v.windup = u.windup;
      if (v.rebirth >= 0) {
        v.rebirth += dt;
        v.structure.setRebirth?.(Math.min(1, v.rebirth / 2.5));
        if (v.rebirth >= 2.5) v.rebirth = -1;
      } else v.structure.setDestroyed(u.alive ? 0 : Math.min(1, v.deathTime / (v.structure.fallTime ?? 2.2)));
      v.root.visible = true;
      return;
    }

    const p = this.prev.get(u);
    const c = this.cur.get(u);
    if (p && c) v.root.position.lerpVectors(p, c, alpha);
    else v.root.position.set(u.x, u.body.y, u.z);
    v.root.position.y += v.lift;
    const turn = this.turns.get(u);
    v.root.rotation.y = (turn ? turnToward(u.body.yaw, turn.yaw, turn.weight) : u.body.yaw) + Math.PI;
    if (v.emerge >= 0) {
      // up out of the ground fast, slowing as it stands
      const k = Math.min(1, (v.emerge += dt) / EMERGE_TIME);
      v.root.position.y -= (1 - k) ** 2 * v.height * 1.05;
      if (k >= 1) v.emerge = -1;
    }

    const hidden = u.stealth > 0 && u.team !== this.player.team;
    if (u.kind === 'dummy') {
      // a broken post tips over, then is hidden until it stands again
      const fall = v.deathTime < 0 ? 0 : Math.min(1, v.deathTime / 0.6);
      v.root.rotation.x = fall * fall * 1.45 + v.wobble * 0.12;
      v.root.visible = v.deathTime < 2.5;
      this.dummies?.place(v.root);
      return;
    }
    if (u.kind === 'minion') {
      // the crowd poses the body (and its fall) from this root
      v.root.visible = !hidden && v.deathTime < 2.2;
      return;
    }
    if (v.monster) {
      v.root.visible = v.deathTime < (v.monster.linger ?? 3);
      v.monster.animate(u, dt, v.deathTime, v.wobble);
      return;
    }
    v.root.visible = !hidden && (u.alive || lying || v.deathTime < (v.model ? GOD_CORPSE : 0.05));
    if (!v.model) return;
    if (!lying) v.root.position.y -= godSink(v.deathTime);
    const speed = hypot(u.vx, u.vz);
    if (speed > 0.1) {
      const sin = Math.sin(u.body.yaw);
      const cos = Math.cos(u.body.yaw);
      // world velocity into the model's frame: forward (-sin, -cos), right (cos, -sin)
      v.localDir.set((u.vx * cos - u.vz * sin) / speed, (-u.vx * sin - u.vz * cos) / speed);
    } else v.localDir.set(0, 0);
    v.root.rotation.z = v.wobble * 0.04;
    if (u.kind === 'god') this.leanThrown(u, v, v.wobble * 0.04);
    v.animDt += dt;
    const every = this.animateEvery(v);
    // GodModel.animate clamps its step to MAX_ANIM_DT, so pose before the backlog would exceed it
    if ((this.frameNo + v.stagger) % every !== 0 && v.animDt + dt <= MAX_ANIM_DT) return;
    v.model.animate(
      v.animDt,
      { speed, localDir: v.localDir, grounded: !u.forced || u.forced.arc === 0, verticalSpeed: 0 },
      // cloth is most of the cost: away from the camera it gets one 60 Hz step per update, in slow motion nobody can see
      every === 1 ? v.animDt : Math.min(v.animDt, 1 / 60),
    );
    v.animDt = 0;
  }

  /** Flung through the air, a god leans the way it flies, turning round its middle (see thrownLean); `roll` is its roll otherwise. */
  private leanThrown(u: Unit, v: UnitView, roll: number): void {
    const lean = thrownLean(u.alive ? u.forced : null, u.body.yaw, this.lean);
    const r = v.root.rotation;
    // (model +X is its left: a turn round +Z tips its top to its right)
    r.z = roll + lean.roll;
    if (lean.pitch === 0 && lean.roll === 0) {
      if (r.x !== 0) r.x = 0;
      return;
    }
    r.order = 'YXZ';
    r.x = lean.pitch;
    const mid = v.height * 0.5;
    v.root.position.y += mid;
    v.root.position.sub(leanMid.set(0, mid, 0).applyQuaternion(v.root.quaternion));
  }

  /**
   * Skinned god models are the most expensive thing to animate on the CPU,
   * so only the ones on screen and close by pose every frame. Far ones catch
   * up every few frames, and ones off screen only tick over now and then
   * (their shadows may still be in view).
   */
  private animateEvery(v: UnitView): number {
    if (!this.camera) return 1;
    if (!v.root.visible) return OFFSCREEN_EVERY;
    this.bounds.center.copy(v.root.position).setY(v.root.position.y + v.height * 0.5);
    this.bounds.radius = v.height * 1.2;
    if (!this.frustum.intersectsSphere(this.bounds)) return OFFSCREEN_EVERY;
    const d = this.camera.position.distanceTo(this.bounds.center);
    return d > 70 ? 3 : d > 35 ? 2 : 1;
  }
}
