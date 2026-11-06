import * as THREE from 'three/webgpu';
import { abs, color, float, fract, mix, sin, smoothstep, sqrt, time, uv, vec4 } from '../render/tsl';
import { objectUniforms, useUniforms } from '../render/shared';
import { Rush, RUSH } from '../sim/Rush';
import type { Point, Unit } from '../sim/Unit';
import { GroundDecal } from './GroundDecal';
import { PitchLines } from './PitchLines';
import { RushCrowd } from './RushCrowd';
import { RelicView } from './Vfx';
import { SIDE } from './palette';

type Ground = (x: number, z: number) => number;

/** How far to the screen's right of the local carrier's head the relic is held (m), when there's no hand to hold it. */
const MINE_SIDE = 0.8;
/** How far above the carrier's off hand the relic's middle sits (m): another god's, and the local carrier's smaller one. */
export const HELD = { lift: 0.5, mine: 0.36 };
/**
 * The column over a throw's landing spot when a god stands within `near` (m, past their body) of it: its foot `over` m up, clear of
 * their head and hands, eased at `ease` (1/s) so it never pops as someone steps in or out.
 */
const LANDING = { near: 1.2, over: RUSH.relic.catchHeight + 0.4, ease: 10 };
/**
 * A thrown relic coming down loose: how far it dips below its hover (m), how
 * fast it springs back (rad/s), how quickly that dies away, and the seconds
 * before it is back to its plain bob.
 */
const LAND = { depth: 0.7, rate: 9, damp: 4.2, time: 1.2 } as const;

// (the colorblind setting changes these in place)
const ALLY = SIDE.ally;
const FOE = SIDE.foe;
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

  /** `width`: half the ribbon's width at its head (m). */
  constructor(private readonly width = 0.32) {
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
      // a new sample once the head has moved a little from the last one, the head always on the relic
      // (the tail starts gathered where the streak began; refilling it every frame kept the ribbon one point long, so it never drew)
      if (this.count === 0) {
        for (const p of pts) p.copy(at);
        this.count = 1;
      } else if (pts[0]!.distanceTo(pts[1]!) > 0.35) {
        for (let i = TRAIL - 1; i > 0; i--) pts[i]!.copy(pts[i - 1]!);
        this.count = Math.min(TRAIL, this.count + 1);
      }
      pts[0]!.copy(at);
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
      this.side.normalize().multiplyScalar(this.width * (1 - (i / TRAIL) * 0.75));
      a.set([p.x + this.side.x, p.y + this.side.y, p.z + this.side.z, p.x - this.side.x, p.y - this.side.y, p.z - this.side.z], i * 6);
    }
    this.pos.needsUpdate = true;
  }
}

/**
 * A dizzy star: a plump four-pointed star, gold with a white-hot middle and a
 * dark amber rim, so it reads on the sunlit plaza floor as well as on shadow
 * (an additive glow alone vanished on the pale stone). Its middle is bright
 * enough to catch a touch of bloom.
 */
let starMaterial: THREE.MeshBasicNodeMaterial | null = null;

function makeStarMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const p = uv().sub(0.5).mul(2.3);
  // sqrt|x| + sqrt|y| = 1 is a four-pointed star with curved sides
  const d = sqrt(abs(p.x)).add(sqrt(abs(p.y)));
  const fill = smoothstep(1, 0.9, d);
  const shape = smoothstep(1.28, 1.16, d);
  const core = smoothstep(0.75, 0.15, d);
  const inner = mix(color(GOLD.main).mul(1.5), color(0xfffbe8).mul(2.6), core);
  m.colorNode = vec4(mix(color(0x6b3200), inner, fill), 1);
  m.opacityNode = shape;
  return m;
}

const STARS_PER_GOD = 3;
const MAX_DAZED = 6;

/** Stars circling the heads of dazed gods: every star of every god in one camera-facing mesh, one draw. */
class DazeStars {
  readonly mesh: THREE.Mesh;
  private readonly pos: THREE.BufferAttribute;
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  /** How far each god's stars have grown in (0..1), so they pop in and shrink away. */
  private readonly grow = new Map<Unit, number>();

  constructor() {
    const n = STARS_PER_GOD * MAX_DAZED;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    const uvs = new Float32Array(n * 4 * 2);
    const index: number[] = [];
    for (let i = 0; i < n; i++) {
      uvs.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    }
    g.setAttribute('position', this.pos);
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(index);
    this.mesh = new THREE.Mesh(g, (starMaterial ??= makeStarMaterial()));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    this.mesh.visible = false;
  }

  frame(gods: readonly Unit[], ground: Ground, camera: THREE.Camera | null, dt: number, t: number): void {
    const a = this.pos.array as Float32Array;
    a.fill(0);
    if (camera) {
      this.right.setFromMatrixColumn(camera.matrixWorld, 0);
      this.up.setFromMatrixColumn(camera.matrixWorld, 1);
    }
    let slot = 0;
    for (const g of gods) {
      const k = Math.max(0, Math.min(1, (this.grow.get(g) ?? 0) + (g.alive ? -dt * 4 : dt * 3)));
      this.grow.set(g, k);
      if (k <= 0 || slot >= MAX_DAZED) continue;
      // over where the god lies, circling and bobbing out of step
      const cy = ground(g.x, g.z) + 0.9;
      for (let i = 0; i < STARS_PER_GOD; i++) {
        const ang = t * 3.2 + (i / STARS_PER_GOD) * Math.PI * 2 + g.combatant.uid;
        const x = g.x + Math.cos(ang) * 0.65;
        const z = g.z + Math.sin(ang) * 0.65;
        const y = cy + Math.sin(t * 5 + i * 2.1) * 0.08;
        const s = 0.3 * k * (0.85 + 0.15 * Math.sin(t * 9 + i * 1.7));
        const rx = this.right.x * s, ry = this.right.y * s, rz = this.right.z * s;
        const ux = this.up.x * s, uy = this.up.y * s, uz = this.up.z * s;
        a.set([x - rx - ux, y - ry - uy, z - rz - uz, x + rx - ux, y + ry - uy, z + rz - uz, x + rx + ux, y + ry + uy, z + rz + uz, x - rx + ux, y - ry + uy, z - rz + uz], (slot * STARS_PER_GOD + i) * 12);
      }
      slot++;
    }
    this.mesh.visible = slot > 0;
    if (slot > 0) this.pos.needsUpdate = true;
  }
}

/**
 * Everything Relic Rush draws on top of the temple: the Sun Relic itself (a
 * gold orb inside a turning ring, with a halo), the gold column that marks
 * where it is from across the field, a ring where a throw will land, a veil
 * of light in each scoring gateway in its defenders' color, the pitch's edge
 * and markings,
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
  /** What the preview shows (its colors are only set when that changes): a pass, a shot on target, or a throw an enemy would cut off or stone would stop (see `read`). */
  private previewTone: 'pass' | 'shot' | 'cut' = 'pass';
  /** What the local carrier's throw would do (see Rush.passRead), or null when they aren't carrying. */
  read: ReturnType<Rush['passRead']> | null = null;
  /** Where the local carrier's throw would go: their aim, or a teammate's run the pass assist leads (see Rush.assistAim). */
  aim: Point | null = null;
  private readonly head = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  /** Where the relic was drawn last frame, so a catch glides instead of snapping. */
  private readonly drawn = new THREE.Vector3();
  private readonly goal = new THREE.Vector3();
  /** Where the relic was drawn when it reached its holder's hand, from the hand: closes over a catch. */
  private readonly lag = new THREE.Vector3();
  private heldBy: Unit | null = null;
  private placed = false;
  /** The relic's phase last frame, and seconds since a throw last came down loose (for the bounce; -1 none). */
  private wasPhase = '';
  private landedFor = -1;
  private light: THREE.PointLight | null = null;
  private readonly trail = new Trail();
  /** A carrier's juke: a gold streak through the sidestep, at chest height (same material as the relic's). */
  private readonly jukeTrail = new Trail(0.42);
  private jukeSeen = -1;
  private juker: Unit | null = null;
  private jukeFor = 0;
  private readonly stars = new DazeStars();
  /** The spirits watching round the pitch. */
  readonly crowd: RushCrowd;
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
    this.group.add(this.relic, this.locator.group, this.trail.mesh, this.jukeTrail.mesh, this.stars.mesh);

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

    // the markings inlaid in the plaza: center circle, halfway line, keepers' boxes, kickoff marks
    this.group.add(new PitchLines(ground, mine, { ally: ALLY.main, foe: FOE.main, gold: GOLD.main }).mesh);
    this.crowd = new RushCrowd(ground, mine, { ally: ALLY.main, foe: FOE.main });
    this.group.add(this.crowd.mesh);

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
    this.jukeTrail.mesh.visible = true;
    this.stars.mesh.visible = true;
    return () => {
      this.preview.mesh.visible = was;
      this.trail.mesh.visible = false;
      this.jukeTrail.mesh.visible = false;
      this.stars.mesh.visible = false;
    };
  }

  private readonly lineup: Unit[] = [];
  /** The relic column's foot above the ground (eased while a throw is in the air). */
  private lift = 0;
  /** Both teams' gods, gathered once (the line-up never changes). */
  private gods(rush: Rush): readonly Unit[] {
    if (!this.lineup.length) this.lineup.push(...rush.team('order'), ...rush.team('chaos'));
    return this.lineup;
  }

  /** Where the relic is drawn, or null while it is gone (after a goal). */
  get relicAt(): THREE.Vector3 | null {
    return this.relic.visible ? this.relic.position : null;
  }

  frame(rush: Rush, me: Unit, headOf: (u: Unit, out: THREE.Vector3) => THREE.Vector3 | null, dt: number, t: number, handOf?: (u: Unit, out: THREE.Vector3) => THREE.Vector3 | null): void {
    const r = rush.relic;
    const R = RUSH.relic;
    const shown = r.phase !== 'gone';
    this.relic.visible = shown;
    let x = r.x;
    let z = r.z;
    let y = this.ground(x, z) + r.h;
    // the carrier holds it up in their off hand; the local one's is smaller, off to the side of the crosshair so it doesn't hide whoever they pass to
    const mine = r.phase === 'held' && r.holder === me;
    const hand = r.phase === 'held' && r.holder ? handOf?.(r.holder, this.head) : null;
    if (hand) {
      x = hand.x;
      z = hand.z;
      y = hand.y + (mine ? HELD.mine : HELD.lift);
    } else if (r.phase === 'held' && r.holder) {
      const head = headOf(r.holder, this.head);
      if (head) {
        x = head.x;
        z = head.z;
        y = head.y + 0.55;
        if (mine && this.camera) {
          this.side.setFromMatrixColumn(this.camera.matrixWorld, 0);
          x += this.side.x * MINE_SIDE;
          z += this.side.z * MINE_SIDE;
          y = head.y + 0.1;
        }
      }
    }
    this.relic.scale.setScalar(mine ? 0.7 : 1);
    this.goal.set(x, y, z);
    if (!this.placed || r.phase === 'center' || r.phase === 'gone') this.drawn.copy(this.goal);
    else if (r.phase === 'held') {
      // glide into the hand on a catch rather than jumping a meter, then stay right in it
      if (this.heldBy !== r.holder) this.lag.copy(this.drawn).sub(this.goal);
      this.lag.multiplyScalar(Math.exp(-dt * 22));
      this.drawn.copy(this.goal).add(this.lag);
    } else this.drawn.lerp(this.goal, Math.min(1, dt * 40));
    this.heldBy = r.phase === 'held' ? r.holder : null;
    this.placed = shown;
    // a throw that comes down loose carries on into the ground and bounces back up to hover, then eases into its bob
    if (this.wasPhase === 'flying' && r.phase === 'loose') this.landedFor = 0;
    else if (r.phase !== 'loose') this.landedFor = -1;
    this.wasPhase = r.phase;
    let bounce = 0;
    let settle = 1;
    if (this.landedFor >= 0) {
      const s = (this.landedFor += dt);
      bounce = s < LAND.time ? -LAND.depth * Math.sin(s * LAND.rate) * Math.exp(-s * LAND.damp) : 0;
      const k = Math.min(1, s / LAND.time);
      settle = k * k * (3 - 2 * k);
    }
    const bob = r.phase === 'loose' || r.phase === 'center' ? Math.sin(t * 2.2) * 0.12 * settle : 0;
    this.relic.position.set(this.drawn.x, this.drawn.y + bob + bounce, this.drawn.z);
    // a thrown or knocked-loose relic streaks through the air
    this.trail.frame(r.phase === 'flying' ? this.relic.position : null, this.camera, dt);
    // a juke streaks through the sidestep
    if (this.jukeSeen < 0) this.jukeSeen = rush.beats.juke;
    if (rush.beats.juke !== this.jukeSeen) {
      this.jukeSeen = rush.beats.juke;
      this.juker = rush.lastJuke;
      this.jukeFor = RUSH.juke.time + 0.05;
    }
    this.jukeFor = Math.max(0, this.jukeFor - dt);
    const chest = this.jukeFor > 0 && this.juker?.alive ? headOf(this.juker, this.head) : null;
    if (chest) chest.y -= 0.8;
    this.jukeTrail.frame(chest, this.camera, dt);
    this.stars.frame(this.gods(rush), this.ground, this.camera, dt, t);
    this.crowd.frame(rush, dt);
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
    // the column rises from just above the relic, never around the gods: a throw's landing spot is marked from the ground, unless someone
    // stands there waiting for it, when it starts above their head instead so they're still seen (reaching for the catch)
    let lift = !shown ? 0 : r.phase === 'flying' ? 0 : this.drawn.y - this.ground(this.drawn.x, this.drawn.z) + 0.7;
    if (shown && r.phase === 'flying') {
      for (const g of this.gods(rush)) if (g.alive && Math.hypot(g.x - r.tx, g.z - r.tz) < g.radius + LANDING.near) lift = LANDING.over;
      lift = this.lift += (lift - this.lift) * (1 - Math.exp(-dt * LANDING.ease));
    } else this.lift = lift;
    // (none over the local carrier: from behind it would stand right where they aim)
    const width = r.phase === 'held' ? (mine ? 0 : 0.34) : r.phase === 'flying' ? 0.5 : 0.4;
    this.locator.set(at, r.phase === 'held' ? 1.2 : 1.6, team ? 1 : 0, t, tone.main, tone.core, { lift, width });

    // the local carrier sees where a throw would land and who would catch it: blue when it would go in as a shot, red when an enemy would cut it off
    // or it would hit stone on the way
    const carrying = r.phase === 'held' && r.holder === me && rush.phase === 'play';
    const aim = (this.aim = carrying ? rush.assistAim(me, me.aim) : null);
    const read = (this.read = aim ? rush.passRead(me, aim) : null);
    const shot = !!read?.goal;
    // a gate glows harder while the relic is coming at it, and flares when your shot is lined up on it
    for (const v of this.veils) {
      const g = RUSH.gates[v.side];
      const attacker = r.phase === 'held' && r.holder && r.holder.team !== v.side ? r.holder : null;
      const near = attacker ? Math.max(0, 1 - Math.hypot(attacker.x - g.x, attacker.z - g.z) / 18) : 0;
      v.values.glow = 0.8 + near * 1.4 + (rush.phase === 'goal' && rush.lastGoal?.team !== v.side ? 1.2 + Math.sin(t * 14) * 0.6 : 0) + (shot && v.side !== me.team ? 0.9 + Math.sin(t * 12) * 0.35 : 0);
      v.floor.values.opacity = 0.55 + near * 0.4;
    }
    this.edge.values.opacity = 0.4 + 0.12 * Math.sin(t * 1.3);

    this.preview.mesh.visible = carrying;
    const by = read?.catcher ?? null;
    if (carrying) {
      const tone = shot ? 'shot' : (by && by.team !== me.team) || read?.stone ? 'cut' : 'pass';
      if (tone !== this.previewTone) {
        this.previewTone = tone;
        const c = tone === 'shot' ? ALLY : tone === 'cut' ? FOE : GOLD;
        this.preview.setColors(c.main, c.core);
      }
      const to = rush.throwTarget(me, aim!);
      const key = `${to.x.toFixed(1)},${to.z.toFixed(1)}`;
      if (key !== this.previewAt) {
        this.previewAt = key;
        this.preview.place({ type: 'circle', radius: R.catchReach + 0.6 }, to.x, to.z, 0, 0.1);
      }
      this.preview.values.opacity = shot ? 0.85 + Math.sin(t * 12) * 0.15 : 0.75;
    }
  }
}
