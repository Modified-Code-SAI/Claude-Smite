import * as THREE from 'three/webgpu';
import { GIANT_SCALE, GiantModel, MIRRORED, MOTIONS, mirror, type GiantAct, type GiantPart, type GiantPartState, type GiantState } from '../actors/GiantModel';
import { loadGodAsset } from '../actors/gods/assets';
import { JOTUNN } from '../sim/Jotunn';

const PARTS: GiantPart[] = ['kneeL', 'kneeR', 'rune', 'wristL', 'wristR', 'crown'];
const WINDUP: Record<GiantAct, number> = { club: 0.5, stomp: 0.6, boulder: 0.9, slam: 0.85, roar: 0.8, breath: 0.7, avalanche: 1, hail: 0.6 };

/**
 * `?giant` dev view of the Jötunn at full size in front of the spawn, for
 * tuning its motions. `__game.giant.run(what, t)` replays a motion from its
 * start to `t` seconds at 60 Hz (deterministic, for filmstrips):
 *   what: idle | walk | kneel | death | silenced | stagger | <attack> (club, stomp, boulder, slam, roar, breath, avalanche, hail)
 * Options: view=front|side|three|back|low|knee|top, exposed (all weak points lit), damage=0..1,
 * mark=right,ahead (meters in the giant's frame, where an aimed attack lands).
 */
export class GiantShowcase {
  private model: GiantModel | null = null;
  private readonly center = new THREE.Vector3();
  private readonly fwd: THREE.Vector3;
  private readonly yaw: number;
  private live: { what: string; t: number } | null = null;
  private mark: number[] | null = null;
  /** The motion tables, to tune keys live from the console. */
  readonly tables = { MOTIONS, MIRRORED, mirror };

  static async create(params: URLSearchParams, parent: THREE.Object3D, spawn: { x: number; z: number; yaw: number }, ground: (x: number, z: number) => number, camera: THREE.PerspectiveCamera): Promise<GiantShowcase> {
    await loadGodAsset('jotunn');
    return new GiantShowcase(params, parent, spawn, ground, camera);
  }

  private constructor(
    private readonly params: URLSearchParams,
    private readonly parent: THREE.Object3D,
    spawn: { x: number; z: number; yaw: number },
    ground: (x: number, z: number) => number,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.yaw = spawn.yaw;
    this.fwd = new THREE.Vector3(-Math.sin(spawn.yaw), 0, -Math.cos(spawn.yaw));
    this.center.set(spawn.x, 0, spawn.z).addScaledVector(this.fwd, Number(params.get('at') ?? 14));
    this.center.y = ground(this.center.x, this.center.z);
    this.place(params.get('view') ?? 'front');
    this.run(params.get('giant') || 'idle', Number(params.get('t') ?? 0.01));
  }

  private place(view: string): void {
    const c = this.center;
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const at = new THREE.Vector3(c.x, c.y + (view === 'knee' ? 6 : 9), c.z);
    let p: THREE.Vector3;
    if (view === 'side') p = c.clone().addScaledVector(right, 36).setY(c.y + 10);
    else if (view === 'three') p = c.clone().addScaledVector(this.fwd, -26).addScaledVector(right, 24).setY(c.y + 10);
    else if (view === 'back') p = c.clone().addScaledVector(this.fwd, 34).setY(c.y + 10);
    else if (view === 'low') p = c.clone().addScaledVector(this.fwd, -16).addScaledVector(right, 6).setY(c.y + 2.2);
    else if (view === 'knee') p = c.clone().addScaledVector(this.fwd, -14).setY(c.y + 4);
    else if (view === 'top') p = c.clone().addScaledVector(this.fwd, -4).setY(c.y + 46);
    else p = c.clone().addScaledVector(this.fwd, -36).setY(c.y + 10);
    this.camera.position.copy(p);
    this.camera.lookAt(at);
  }

  /** Replays `what` from its start to `t` seconds. */
  run(what: string, t: number, view?: string, mark?: number[]): void {
    if (view) this.place(view);
    this.mark = mark ?? (this.params.get('mark')?.split(',').map(Number) || null);
    if (this.model) {
      this.parent.remove(this.model.root, this.model.fx);
    }
    const m = new GiantModel();
    this.model = m;
    m.root.position.copy(this.center);
    // face the spawn (the camera)
    m.root.rotation.y = this.yaw + Math.PI + Math.PI;
    this.parent.add(m.root, m.fx);
    this.live = { what, t: 0 };
    const dt = 1 / 60;
    for (let x = 0; x < t; x += dt) this.step(dt);
  }

  private state(what: string, t: number): GiantState {
    const s: GiantState = { speed: 0, localDir: new THREE.Vector2(0, 1), windup: null, kneel: false, plant: null, silenced: false, staggered: null, dead: false };
    // the giant faces the spawn: its forward is back toward the camera, its right the spawn's left
    const gf = this.fwd.clone().negate();
    const gr = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const at = (right: number, ahead: number) => this.center.clone().addScaledVector(gr, right).addScaledVector(gf, ahead);
    if (what === 'walk') s.speed = 5.1;
    else if (what === 'kneel') s.kneel = true;
    else if (what === 'death') s.dead = true;
    else if (what === 'silenced') s.silenced = t < 4;
    else if (what === 'stagger') s.staggered = t < 1.5 ? 'R' : null;
    else if (what in WINDUP) {
      const act = what as GiantAct;
      const w = WINDUP[act];
      const def: Partial<Record<GiantAct, number[]>> = { boulder: [0, 23], slam: [2, 6], hail: [0, 14], club: [0, 6] };
      const [right, ahead] = this.mark ?? def[act] ?? [0, 9];
      const mark = at(right!, ahead!);
      if (t < w) s.windup = { act, left: w - t, at: mark };
      if (act === 'slam' && t >= w && t < w + JOTUNN.plant) {
        // as the sim plants it: the wrist a little short of the mark, on the mark's side
        const d = Math.hypot(right!, ahead!);
        const k = Math.max(0, d - JOTUNN.wristShort) / d;
        s.plant = { hand: right! >= 0 ? 'R' : 'L', at: at(right! * k, ahead! * k) };
      }
    }
    return s;
  }

  private parts(): Record<GiantPart, GiantPartState> {
    const exposed = this.params.has('exposed');
    const health = 1 - Number(this.params.get('damage') ?? 0);
    const out = {} as Record<GiantPart, GiantPartState>;
    for (const p of PARTS) out[p] = { alive: true, exposed, health };
    return out;
  }

  private step(dt: number): void {
    if (!this.model || !this.live) return;
    this.live.t += dt;
    this.model.update(dt, this.state(this.live.what, this.live.t), this.parts());
  }

  update(dt: number): void {
    // a walking giant walks on the spot here
    this.step(dt);
  }

  /** For tuning the sim's weak point offsets: where each one is right now, in the giant's frame (meters right, ahead, up). */
  partOffsets(): Record<string, number[]> {
    const m = this.model!;
    const out: Record<string, number[]> = {};
    // the model faces +Z with its right hand toward -X
    const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(m.root.quaternion);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(m.root.quaternion);
    for (const p of PARTS) {
      const w = m.partPosition(p, new THREE.Vector3()).sub(m.root.position);
      out[p] = [+w.dot(right).toFixed(2), +w.dot(fwd).toFixed(2), +w.y.toFixed(2)];
    }
    out.scale = [GIANT_SCALE];
    return out;
  }
}
