import * as THREE from 'three/webgpu';
import { abs, color, float, fract, mix, sin, smoothstep, time, uv, vec4 } from '../render/tsl';
import { objectUniforms, useUniforms } from '../render/shared';
import { Rush, RUSH } from '../sim/Rush';
import type { Unit } from '../sim/Unit';
import { GroundDecal } from './GroundDecal';
import { RelicView } from './Vfx';

type Ground = (x: number, z: number) => number;

const ALLY = { main: 0x4fb2ff, core: 0xe6f4ff };
const FOE = { main: 0xff3524, core: 0xffe0c8 };
const GOLD = { main: 0xffc23a, core: 0xfff2c4 };

/** Each gate veil's own colors and how hard it glows, for the one material both share. */
const veilUniforms = () => ({ main: new THREE.Color(), hot: new THREE.Color(), glow: 1 });
let veilMaterial: THREE.MeshBasicNodeMaterial | null = null;

/** A shimmering curtain of light hanging in a gateway: streaks rising, brightest at the floor and the posts. */
function makeVeilMaterial(): THREE.MeshBasicNodeMaterial {
  const { main, hot, glow } = objectUniforms(veilUniforms());
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, forceSinglePass: true });
  const u = uv().x;
  const v = uv().y;
  const streak = sin(u.mul(48).add(sin(u.mul(7).add(time.mul(0.7))).mul(3))).mul(0.5).add(0.5);
  const rise = fract(v.mul(1.5).sub(time.mul(0.35)).add(u.mul(3.1)));
  const ripple = smoothstep(0, 0.15, rise).mul(smoothstep(0.6, 0.15, rise));
  const edge = smoothstep(0.42, 0.5, abs(u.sub(0.5)));
  const fade = float(1).sub(v).pow(1.4);
  const body = streak.mul(0.35).add(ripple.mul(0.6)).add(edge).mul(fade).mul(glow);
  m.colorNode = vec4(mix(main, hot, fade.pow(6).add(edge.mul(0.5)).clamp(0, 1)).mul(body).mul(1.6), 1);
  m.opacityNode = body.clamp(0, 1);
  return m;
}

/** The Sun Relic's halo: a hot core fading into a golden glow (feeds bloom). */
let haloMaterial: THREE.SpriteNodeMaterial | null = null;
const haloUniforms = () => ({ main: new THREE.Color(GOLD.main), power: 1 });

function makeHaloMaterial(): THREE.SpriteNodeMaterial {
  const { main, power } = objectUniforms(haloUniforms());
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const r = uv().sub(0.5).length().mul(2);
  const core = smoothstep(0.35, 0, r);
  const glowRing = smoothstep(1, 0.2, r).pow(2.2);
  const pulse = sin(time.mul(3.1)).mul(0.12).add(0.88);
  m.colorNode = vec4(mix(main.mul(2.2), color(0xfff6dc).mul(5), core).mul(glowRing.add(core)).mul(pulse).mul(power), 1);
  m.opacityNode = glowRing;
  return m;
}

/** The thrown relic's streak: bright at the relic, thinning and fading down its path. */
let trailMaterial: THREE.MeshBasicNodeMaterial | null = null;
const trailUniforms = () => ({ alpha: 0 });
const TRAIL = 18;

function makeTrailMaterial(): THREE.MeshBasicNodeMaterial {
  const { alpha } = objectUniforms(trailUniforms());
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, forceSinglePass: true });
  const along = uv().x;
  const across = float(1).sub(abs(uv().y.mul(2).sub(1)));
  const head = float(1).sub(along);
  const body = head.pow(1.6).mul(smoothstep(0, 0.7, across)).mul(alpha);
  m.colorNode = vec4(mix(color(GOLD.main).mul(1.8), color(0xfff6dc).mul(4), head.pow(3).mul(across)).mul(body), 1);
  m.opacityNode = body.clamp(0, 1);
  return m;
}

/** A camera-facing ribbon through the relic's last positions (one draw, rebuilt in place each frame). */
class Trail {
  readonly mesh: THREE.Mesh;
  readonly values = trailUniforms();
  private readonly points: THREE.Vector3[] = Array.from({ length: TRAIL }, () => new THREE.Vector3());
  private count = 0;
  private readonly pos: THREE.BufferAttribute;
  private readonly side = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly toEye = new THREE.Vector3();

  constructor() {
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(TRAIL * 2 * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    const uvs = new Float32Array(TRAIL * 2 * 2);
    const index: number[] = [];
    for (let i = 0; i < TRAIL; i++) {
      uvs.set([i / (TRAIL - 1), 0, i / (TRAIL - 1), 1], i * 4);
      if (i < TRAIL - 1) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    g.setAttribute('position', this.pos);
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(index);
    this.mesh = new THREE.Mesh(g, (trailMaterial ??= makeTrailMaterial()));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    useUniforms(this.values, this.mesh);
  }

  /** Each frame: `at` is the relic while it streaks (null lets the tail run out). */
  frame(at: THREE.Vector3 | null, camera: THREE.Camera | null, dt: number): void {
    const pts = this.points;
    if (at) {
      // a new sample once the relic has moved a little, the head always on the relic
      if (this.count === 0 || pts[0]!.distanceTo(pts[1] ?? pts[0]!) > 0.35) {
        for (let i = TRAIL - 1; i > 0; i--) pts[i]!.copy(pts[i - 1]!);
        this.count = Math.min(TRAIL, this.count + 1);
      }
      pts[0]!.copy(at);
      if (this.count === 1) for (const p of pts) p.copy(at);
      this.values.alpha = Math.min(1, this.values.alpha + dt * 8);
    } else {
      this.values.alpha = Math.max(0, this.values.alpha - dt * 3.5);
      if (this.values.alpha <= 0) this.count = 0;
    }
    this.mesh.visible = this.values.alpha > 0 && this.count > 1;
    if (!this.mesh.visible) return;
    const a = this.pos.array as Float32Array;
    if (camera) this.eye.setFromMatrixPosition(camera.matrixWorld);
    for (let i = 0; i < TRAIL; i++) {
      const p = pts[i]!;
      const q = pts[Math.min(TRAIL - 1, i + 1)]!;
      const r = pts[Math.max(0, i - 1)]!;
      // across the path and the line to the camera, so the ribbon always faces the viewer
      this.dir.subVectors(r, q);
      this.toEye.subVectors(this.eye, p);
      this.side.crossVectors(this.dir, this.toEye);
      if (this.side.lengthSq() < 1e-6) this.side.set(0, 1, 0);
      this.side.normalize().multiplyScalar(0.32 * (1 - (i / TRAIL) * 0.75));
      a.set([p.x + this.side.x, p.y + this.side.y, p.z + this.side.z, p.x - this.side.x, p.y - this.side.y, p.z - this.side.z], i * 6);
    }
    this.pos.needsUpdate = true;
  }
}

/**
 * Everything Relic Rush draws on top of the temple: the Sun Relic itself (a
 * gold orb inside a turning ring, with a halo), the gold column that marks
 * where it is from across the field, a ring where a throw will land, a veil
 * of light in each scoring gateway in its defenders' color, the pitch's edge,
 * and the local carrier's throw preview. It borrows the temple's own relic
 * light, so the scene's light count (and every lit shader) stays the same.
 */
export class RushView {
  readonly group = new THREE.Group();
  private readonly relic = new THREE.Group();
  private readonly orb: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly halo: THREE.Sprite;
  private readonly haloValues = haloUniforms();
  private readonly locator: RelicView;
  private readonly veils: { side: 'order' | 'chaos'; mesh: THREE.Mesh; values: ReturnType<typeof veilUniforms>; floor: GroundDecal }[] = [];
  private readonly edge: GroundDecal;
  private readonly preview: GroundDecal;
  private previewAt = '';
  private readonly head = new THREE.Vector3();
  /** Where the relic was drawn last frame, so a catch glides instead of snapping. */
  private readonly drawn = new THREE.Vector3();
  private readonly goal = new THREE.Vector3();
  private placed = false;
  private light: THREE.PointLight | null = null;
  private readonly trail = new Trail();
  /** The camera the trail ribbon faces. */
  camera: THREE.Camera | null = null;

  constructor(
    private readonly ground: Ground,
    gold: THREE.Material,
    /** Which side the local player is on (their gate glows blue, the other red). */
    mine: 'order' | 'chaos',
    /** The temple's floating crystal: hidden, its light carried by the Sun Relic instead. */
    temple?: THREE.Group,
  ) {
    this.group.name = 'rush';
    this.orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 3), gold);
    this.orb.castShadow = true;
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.055, 8, 48), gold);
    this.ring.castShadow = true;
    this.halo = new THREE.Sprite((haloMaterial ??= makeHaloMaterial()));
    this.halo.scale.setScalar(2.6);
    this.halo.renderOrder = 14;
    useUniforms(this.haloValues, this.halo);
    this.relic.add(this.orb, this.ring, this.halo);
    this.locator = new RelicView(ground);
    this.group.add(this.relic, this.locator.group, this.trail.mesh);

    for (const side of ['order', 'chaos'] as const) {
      const g = RUSH.gates[side];
      const values = veilUniforms();
      const c = side === mine ? ALLY : FOE;
      values.main.setHex(c.main);
      values.hot.setHex(c.core);
      const w = RUSH.gateHalfWidth * 2;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, 5.2).translate(0, 2.6, 0), (veilMaterial ??= makeVeilMaterial()));
      mesh.position.set(g.x, ground(g.x, g.z) - 0.05, g.z);
      mesh.renderOrder = 11;
      useUniforms(values, mesh);
      const floor = new GroundDecal(ground);
      floor.setStyle('zone');
      floor.setColors(c.main, c.core);
      const out = Math.sign(g.z);
      // the decal runs from its origin along -z at yaw 0: start at the plaza side of the mouth
      floor.place({ type: 'rect', length: RUSH.gateDepth * 2, width: w }, g.x, g.z + out * RUSH.gateDepth, out > 0 ? 0 : Math.PI, 0.09);
      floor.values.opacity = 0.75;
      this.veils.push({ side, mesh, values, floor });
      this.group.add(mesh, floor.mesh);
    }

    this.edge = new GroundDecal(ground);
    this.edge.setStyle('zone');
    this.edge.setColors(GOLD.main, GOLD.core);
    this.edge.place({ type: 'ring', radius: RUSH.pitchRadius, width: 1.1 }, 0, 0, 0, 0.12);
    this.edge.values.opacity = 0.55;
    this.preview = new GroundDecal(ground);
    this.preview.setStyle('telegraph');
    this.preview.setColors(GOLD.main, GOLD.core);
    this.preview.mesh.visible = false;
    this.group.add(this.edge.mesh, this.preview.mesh);

    if (temple) {
      for (const o of temple.children) {
        if (o instanceof THREE.PointLight) this.light = o;
        else o.visible = false;
      }
      this.light?.color.setHex(0xffc65a);
    }
  }

  /** Shows every part until the returned function is called, so loading prepares their shaders. */
  prime(): () => void {
    const was = this.preview.mesh.visible;
    this.preview.mesh.visible = true;
    this.relic.visible = true;
    this.trail.mesh.visible = true;
    return () => {
      this.preview.mesh.visible = was;
      this.trail.mesh.visible = false;
    };
  }

  /** Where the relic is drawn, or null while it is gone (after a goal). */
  get relicAt(): THREE.Vector3 | null {
    return this.relic.visible ? this.relic.position : null;
  }

  frame(rush: Rush, me: Unit, headOf: (u: Unit, out: THREE.Vector3) => THREE.Vector3 | null, dt: number, t: number): void {
    const r = rush.relic;
    const R = RUSH.relic;
    const shown = r.phase !== 'gone';
    this.relic.visible = shown;
    let x = r.x;
    let z = r.z;
    let y = this.ground(x, z) + r.h;
    // over the local carrier's own head it sits lower and smaller, out of the way of their aim
    const mine = r.phase === 'held' && r.holder === me;
    if (r.phase === 'held' && r.holder) {
      const head = headOf(r.holder, this.head);
      if (head) {
        x = head.x;
        z = head.z;
        y = head.y + (mine ? 0.35 : 0.55);
      }
    }
    this.relic.scale.setScalar(mine ? 0.75 : 1);
    // glide into the hands on a catch rather than jumping a meter
    if (!this.placed || r.phase === 'center' || r.phase === 'gone') this.drawn.set(x, y, z);
    else this.drawn.lerp(this.goal.set(x, y, z), Math.min(1, dt * (r.phase === 'held' ? 22 : 40)));
    this.placed = shown;
    const bob = r.phase === 'loose' || r.phase === 'center' ? Math.sin(t * 2.2) * 0.12 : 0;
    this.relic.position.set(this.drawn.x, this.drawn.y + bob, this.drawn.z);
    // a thrown or knocked-loose relic streaks through the air
    this.trail.frame(r.phase === 'flying' ? this.relic.position : null, this.camera, dt);
    this.orb.rotation.y = t * 0.8;
    this.ring.rotation.set(Math.PI / 2 + Math.sin(t * 0.9) * 0.5, t * 1.7, 0);
    const golden = rush.overtime;
    this.haloValues.power = (golden ? 1.6 : 1) * (r.phase === 'flying' ? 1.25 : 1);
    this.haloValues.main.setHex(golden ? 0xffe27a : GOLD.main);
    const light = this.light;
    if (light) {
      // the temple's scenery is frozen (no automatic matrix updates), so the light is moved by hand
      const parent = light.parent!;
      parent.getWorldPosition(this.head);
      light.position.set(this.drawn.x - this.head.x, this.drawn.y + 0.4 - this.head.y, this.drawn.z - this.head.z);
      light.updateMatrix();
      light.updateMatrixWorld(true);
    }

    // the gold column: on the relic, over its carrier, or at a throw's landing spot
    const team = r.phase === 'held' ? r.holder?.team : r.phase === 'flying' ? r.thrower?.team : null;
    const tone = team ? (team === me.team ? ALLY : FOE) : GOLD;
    const at = !shown ? null : r.phase === 'flying' ? { x: r.tx, z: r.tz } : { x: this.drawn.x, z: this.drawn.z };
    // the column rises from just above the relic (never around the gods), and marks a throw's landing spot from the ground
    const lift = !shown || r.phase === 'flying' ? 0 : this.drawn.y - this.ground(this.drawn.x, this.drawn.z) + 0.7;
    // (none over the local carrier: from behind it would stand right where they aim)
    const width = r.phase === 'held' ? (mine ? 0 : 0.34) : r.phase === 'flying' ? 0.5 : 0.4;
    this.locator.set(at, r.phase === 'held' ? 1.2 : 1.6, team ? 1 : 0, t, tone.main, tone.core, { lift, width });

    // a gate glows harder while the relic is coming at it
    for (const v of this.veils) {
      const g = RUSH.gates[v.side];
      const attacker = r.phase === 'held' && r.holder && r.holder.team !== v.side ? r.holder : null;
      const near = attacker ? Math.max(0, 1 - Math.hypot(attacker.x - g.x, attacker.z - g.z) / 18) : 0;
      v.values.glow = 0.8 + near * 1.4 + (rush.phase === 'goal' && rush.lastGoal?.team !== v.side ? 1.2 + Math.sin(t * 14) * 0.6 : 0);
      v.floor.values.opacity = 0.55 + near * 0.4;
    }
    this.edge.values.opacity = 0.4 + 0.12 * Math.sin(t * 1.3);

    // the local carrier sees where a throw would land
    const carrying = r.phase === 'held' && r.holder === me && rush.phase === 'play';
    this.preview.mesh.visible = carrying;
    if (carrying) {
      const to = rush.throwTarget(me, me.aim);
      const key = `${to.x.toFixed(1)},${to.z.toFixed(1)}`;
      if (key !== this.previewAt) {
        this.previewAt = key;
        this.preview.place({ type: 'circle', radius: R.catchReach + 0.6 }, to.x, to.z, 0, 0.1);
      }
      this.preview.values.opacity = 0.75;
    }
  }
}
