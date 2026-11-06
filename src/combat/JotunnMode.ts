import * as THREE from 'three/webgpu';
import type { Input } from '../core/Input';
import { startingPointsLine } from '../game/builds';
import { GODS, godById } from '../game/gods';
import { NetGuest, NetHost } from '../net/NetGame';
import { jotunnRoster } from '../net/jotunnRoster';
import type { Roster } from '../net/Replica';
import type { NetSession } from '../net/Session';
import type { PlayerController } from '../player/PlayerController';
import type { CameraShot } from '../player/ThirdPersonCamera';
import type { CollisionWorld } from '../scene/Collision';
import type { Fire } from '../scene/Effects';
import type { Environment } from '../scene/Environment';
import { JOTUNN, Jotunn, type JotunnBrains, type JotunnPlayer } from '../sim/Jotunn';
import { jotunnBots, WardenCalls } from '../sim/JotunnBots';
import type { Sim } from '../sim/Sim';
import type { Point, SimEvent, Unit } from '../sim/Unit';
import { JotunnHud } from '../ui/JotunnHud';
import { JotunnMarks } from '../ui/JotunnMarks';
import { CINE, CINE_CLEARANCE, JotunnCine, type CineSight } from './jotunnCine';
import { JotunnView } from './JotunnView';
import { JotunnWeather } from './jotunnWeather';
import { paletteFor } from './palette';

/** Who plays the giant alone: everyone in turn (a bot first, then you), only you, or only the bots. Online, everyone takes a turn. */
export type JotunnRole = 'rotate' | 'giant' | 'god';

export function parseRole(s: string | null | undefined): JotunnRole {
  return s === 'giant' || s === 'god' ? s : 'rotate';
}

export interface JotunnDeps {
  sim: Sim;
  /** The local player's god, already in the sim. */
  player: Unit;
  ctrl: PlayerController;
  input: Input;
  role: JotunnRole;
  vfx: THREE.Object3D;
  groundAt: (x: number, z: number) => number;
  /** The temple's fires; the four on the platform are the braziers'. */
  fires: readonly Fire[];
  /** A burst of light and sparks (CombatVfx.burst). */
  burst: (p: ReturnType<typeof paletteFor>, x: number, y: number, z: number, power: number) => void;
  shake?: (amount: number) => void;
  /** Hands the local player a unit to play: the giant, or their god again. */
  control: (u: Unit, giant: boolean) => void;
  toast: (text: string) => void;
  /** How quickly bot gods notice a warning when a person plays the giant (difficulty); see jotunnBots. */
  reaction?: number;
  /** How hard a bot giant's blows land on gods (difficulty), 1 as tuned. */
  giantPower?: number;
  /** Online: up to five friends, bots filling the rest; each takes a turn as the giant. */
  net?: NetSession;
  /** A moment of the giant's that has its own sound ('step': a footfall, k how hard). */
  cue?: (name: 'step', at: THREE.Vector3, k: number) => void;
  /** Lays a shot of the giant over the follow camera (see JotunnCine); null hands it back. */
  cameraShot?: (shot: CameraShot | null) => void;
  /** The map's columns and walls, which a shot's camera keeps clear of. */
  collision?: CollisionWorld;
  /** The player's camera, for the objective marks (JotunnMarks); none, no marks. */
  camera?: THREE.Camera;
  /** Toward the sun, which a shot of the giant never looks into. */
  sun?: { x: number; z: number };
  /** The map's light and haze, which the giant's winter cools (see JotunnWeather). */
  environment?: Environment;
  /**
   * A round starts at a high level: spends the god's free points along a
   * ready-made build when the player follows none, and names it (null when
   * nothing was spent). Bots spend theirs as they come.
   */
  startPoints?: (u: Unit) => { tree: string; points: number } | null;
}

/** Radians a second the giant's body turns toward the camera when a player drives it. */
const TURN = 2.6;
/**
 * The camera for a player driving the giant (ThirdPersonCamera.setScale):
 * far back, looking past its right shoulder, so its whole body sits left of
 * center above the skill bar and the way ahead stays in view.
 */
export const GIANT_CAMERA = { scale: 5.5, lift: 2.4, side: 6, ahead: 3.2, pitch: 0.45 } as const;
const FROST = paletteFor('jotunn');

/**
 * The Jötunn in a live game, alone with bots or online: the rules (on the
 * host, or alone), the bots on both sides, the view and HUD, and driving the
 * giant on the local player's turn. A giant walks where WASD points (relative
 * to the camera) and turns its body toward the camera slowly, so gods can get
 * behind it. An online guest sends what they ask of the giant; the host walks
 * it (see NetHost.steered).
 */
export class JotunnMode {
  readonly mode: Jotunn;
  readonly view: JotunnView;
  host: NetHost | null = null;
  guest: NetGuest | null = null;
  private readonly hud: JotunnHud;
  private readonly marks: JotunnMarks | null;
  /** The giant's moments on camera, where the game lends the camera. */
  private readonly cine: JotunnCine | null;
  /** The giant's winter: snow, and the colder light it brings. */
  readonly weather: JotunnWeather;
  /** The local player drives the giant this round. */
  piloting = false;
  private readonly brains: JotunnBrains | null;
  /** The bot gods' own calls (where the match runs: the host, or solo). */
  private readonly calls: WardenCalls | null;
  /** On the host: what the guest driving the giant this round last asked for, and how long ago. */
  private remote: { move: Point | null; yaw: number; age: number } | null = null;
  /** On a guest driving the giant: what was last sent, and how long ago. */
  private sent = { move: '', yaw: 0, age: 0 };

  constructor(private readonly deps: JotunnDeps) {
    const { sim, player, net } = deps;
    const me = net?.me ?? '';
    const slots = jotunnRoster(net?.players ?? [{ id: '', name: 'You', god: player.combatant.god.id, team: 'order' }]);
    const players = slots.map((s) => ({ name: s.name, id: s.player, god: s.player === me ? player : (godById(s.god) ?? GODS[0]!) }));
    // alone, the local player is first and a bot second (see jotunnRoster)
    const order = net ? undefined : deps.role === 'giant' ? [0] : deps.role === 'god' ? [1] : undefined;
    const guest = !!net && !net.isHost;
    // difficulty shapes the bots the people face, never their allies: bot gods are
    // quicker or slower only against a person's giant, a bot giant hits harder or softer
    const fair = jotunnBots(sim);
    const foes = jotunnBots(sim, { reaction: deps.reaction });
    this.brains = guest ? null : { giant: fair.giant, god: (m, u) => (m.giantPlayer.id !== null ? foes : fair).god(m, u) };
    this.mode = new Jotunn(sim, players, { order, brains: this.brains ?? undefined });
    this.calls = guest ? null : new WardenCalls(sim, this.mode);
    const mode = this.mode;
    mode.onRound = (p) => this.round(p);
    // the same units on every end: the gods in roster order, the giant's parts by name
    const structures = new Map<string, Unit>([['giant', mode.giant]]);
    for (const [id, u] of mode.parts) structures.set(id, u);
    mode.braziers.forEach((b, i) => structures.set(`brazier${i}`, b));
    const roster: Roster = { slots: mode.players.map((p) => p.god), structures };
    if (guest) {
      // the host's events arrive ready-made: the rules' own reactions to them would count everything twice
      sim.listeners.length = 0;
      this.guest = new NetGuest(net, sim, mode, roster, player, deps.ctrl);
      this.guest.steered = (u) => u === mode.giant;
    } else {
      if (net) {
        const host = (this.host = new NetHost(net, sim, (u, id) => this.toBot(u, id), deps.toast));
        for (const p of mode.players) if (p.id && p.id !== me) host.assign(p.id, p.god);
        host.steered = (u) => u === mode.giant;
        host.onAct = (u, msg) => {
          const m = msg.m as [number, number] | 0;
          if (msg.k === 'drive' && u === mode.giant && typeof msg.y === 'number') this.remote = { move: m ? { x: m[0], z: m[1] } : null, yaw: msg.y, age: 0 };
        };
      }
    }
    this.view = new JotunnView({
      ground: deps.groundAt,
      flashes: () => sim.flashes,
      shrines: () => mode.shrines,
      fireAt: (x, z) => {
        let best: Fire | null = null;
        let d = 2;
        for (const f of deps.fires) {
          const e = Math.hypot(f.group.position.x - x, f.group.position.z - z);
          if (e < d) {
            d = e;
            best = f;
          }
        }
        return best;
      },
      shake: (amount, at) => {
        // felt less the further off it lands
        const d = deps.ctrl.position.distanceTo(at);
        deps.shake?.(amount * THREE.MathUtils.clamp(1.15 - d / 70, 0.15, 1));
      },
      burst: (at, power) => deps.burst(FROST, at.x, at.y, at.z, power),
      footfall: (at, k) => deps.cue?.('step', at, k),
    });
    deps.vfx.add(this.view.group);
    this.weather = new JotunnWeather(deps.environment);
    deps.vfx.add(this.weather.group);
    this.hud = new JotunnHud(mode, player);
    this.marks = deps.camera ? new JotunnMarks(mode, deps.camera, deps.groundAt) : null;
    const set = deps.cameraShot;
    const view = this.view;
    this.cine = set
      ? new JotunnCine(mode, {
          height: view.model.height,
          ground: deps.groundAt,
          room: (x, z, y, sights) => this.room(x, z, y, sights),
          sun: deps.sun,
          set,
          roar: () => view.roar(),
          dip: (s) => this.hud.dip(s),
        })
      : null;
    // (a guest's rounds start with the host's state: see Jotunn.applyNet)
    if (!guest) {
      mode.begin();
      this.host?.bind(mode, roster);
    }
  }

  /** A round starts: the local player takes the giant on their turn, their god otherwise; the host hands guests theirs. */
  private round(p: JotunnPlayer): void {
    const mode = this.mode;
    const g = mode.giant;
    const mine = p.god === this.deps.player;
    this.piloting = mine;
    this.remote = null;
    const me = this.deps.net?.me ?? '';
    if (this.host) for (const x of mode.players) if (x.id && x.id !== me) this.host.assign(x.id, x === p ? g : x.god);
    this.handicap();
    this.deps.control(mine ? g : this.deps.player, mine);
    if (mine) {
      this.deps.ctrl.spawn(g.x, g.z, g.body.yaw);
      this.deps.ctrl.pitch = GIANT_CAMERA.pitch;
      this.deps.toast('You are the Jötunn. Smash three of the four braziers on the temple. Stand in an ice shrine to claim a new ultimate. Your knees, back rune, wrists and crown are where the gods break you.');
    } else {
      this.deps.toast(`${p.name} is the Jötunn. Keep it from the braziers: break both knees to bring it down, then strike its crown. After a slam, break the planted wrist.`);
      // (a guest's points are the host's to spend, as their menu's are)
      const spent = this.guest ? null : this.deps.startPoints?.(this.deps.player);
      if (spent) this.deps.toast(startingPointsLine(spent));
    }
  }

  /** A friend left: a bot takes whatever they played, now and in their later rounds. */
  private toBot(u: Unit, id: string): void {
    const mode = this.mode;
    const p = mode.players.find((x) => x.id === id);
    if (p) p.id = null;
    if (!this.brains || mode.phase === 'over' || mode.phase === 'done') return;
    if (u === mode.giant) {
      this.remote = null;
      u.brain = this.brains.giant(mode);
      this.handicap();
    } else u.brain = this.brains.god(mode, u);
  }

  /** The difficulty's hold on the giant: a bot giant's blows on gods land harder or softer; a person's giant hits as tuned. */
  private handicap(): void {
    if (this.guest) return;
    const mode = this.mode;
    const k = mode.giantPlayer.id === null ? (this.deps.giantPower ?? 1) : 1;
    const sim = this.deps.sim;
    // braziers take the same blows whatever the difficulty
    mode.giant.combatant.damageAmp = k === 1 ? null : (t) => (sim.unitByCombatantUid(t.uid)?.kind === 'god' ? k : 1);
  }

  /** The fixed step, before the simulation's: drive the giant from the keys when it is ours (or from a guest's word), then the rules. */
  step(dt: number): void {
    if (this.guest) {
      // the host runs the rules: a guest only says where it wants the giant to go
      if (this.piloting) this.send(dt);
      return;
    }
    if (this.piloting) {
      const want = this.intent();
      this.steer(want.yaw, want.move, dt);
    } else if (this.remote) {
      // a driver gone quiet (a stall) stops walking
      this.remote.age += dt;
      this.steer(this.remote.yaw, this.remote.age < 0.5 ? this.remote.move : null, dt);
    }
    this.mode.step(dt);
    this.calls?.step();
  }

  /** After the simulation's step: the camera's anchor follows the giant. */
  afterStep(): void {
    if (!this.piloting) return;
    const g = this.mode.giant;
    this.deps.ctrl.position.set(g.x, g.body.y, g.z);
  }

  /** Where the keys point (relative to the camera), and the camera's heading. */
  private intent(): { move: Point | null; yaw: number } {
    const { input, ctrl } = this.deps;
    const f = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    const r = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    if (!f && !r) return { move: null, yaw: ctrl.yaw };
    const sin = Math.sin(ctrl.yaw);
    const cos = Math.cos(ctrl.yaw);
    // forward = (-sin, -cos), right = (cos, -sin)
    return { move: { x: -sin * f + cos * r, z: -cos * f - sin * r }, yaw: ctrl.yaw };
  }

  /**
   * The body comes round to the heading slowly (a wound-up blow holds it, and
   * so do its shots: its waking and its win) and walks where it was asked,
   * while the round is on.
   */
  private steer(yaw: number, move: Point | null, dt: number): void {
    const m = this.mode;
    const g = m.giant;
    const still = m.phase === 'over' || (m.phase === 'countdown' && JOTUNN.countdown - m.timer < CINE.wake);
    if (g.windup <= 0 && g.alive && !still) {
      let d = yaw - g.body.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const turn = TURN * dt;
      g.body.yaw += THREE.MathUtils.clamp(d, -turn, turn);
    }
    g.move = this.mode.phase === 'fight' && g.alive ? move : null;
  }

  /** A guest driving the giant: what it asks for, sent when it changes and a few times a second while held. */
  private send(dt: number): void {
    const want = this.intent();
    const move = want.move ? `${want.move.x.toFixed(2)},${want.move.z.toFixed(2)}` : '';
    this.sent.age += dt;
    let dy = want.yaw - this.sent.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    if (move === this.sent.move && Math.abs(dy) < 0.02 && this.sent.age < 0.2) return;
    this.sent = { move, yaw: want.yaw, age: 0 };
    this.guest!.act({ k: 'drive', m: want.move ? [Math.round(want.move.x * 100) / 100, Math.round(want.move.z * 100) / 100] : 0, y: Math.round(want.yaw * 1000) / 1000 });
  }

  onEvent(e: SimEvent): void {
    this.view.onEvent(e);
    this.hud.onEvent(e);
    this.marks?.onEvent(e);
  }

  frame(dt: number, time: number): void {
    this.cine?.frame(dt);
    this.weather.frame(dt, this.mode);
    this.view.update(dt, time);
    this.hud.frame(dt, this.cine?.kind ?? null);
    this.marks?.frame(dt, this.piloting, !!this.cine?.kind, this.piloting ? this.mode.giant : this.deps.player);
  }

  /** Clear floor for a shot's camera at (x, z), `y` up, that looks at each of `sights` (see CineHost.room). */
  private room(x: number, z: number, y: number, sights: readonly CineSight[]): number {
    const here = this.deps.groundAt(x, z);
    if (y < here + 1) return 0;
    // open ground before the lens: no bank rising across the bottom of the frame
    const t = sights[0]!;
    const d = Math.hypot(t.x - x, t.z - z);
    for (const m of [2, 4, 6, 8]) if (m < d && this.deps.groundAt(x + ((t.x - x) * m) / d, z + ((t.z - z) * m) / d) > here + 1.2) return 0;
    const c = this.deps.collision;
    if (!c) return 99;
    // nor a rock or a wall standing just before it
    const ux = (t.x - x) / d;
    const uz = (t.z - z) / d;
    for (const k of c.colliders) {
      if (k.top < here + 1.2) continue;
      const along = (k.x - x) * ux + (k.z - z) * uz;
      const r = k.kind === 'circle' ? k.r : Math.hypot(k.hx, k.hz);
      if (along > -r && along < 9 + r && Math.abs((k.z - z) * ux - (k.x - x) * uz) < r + 2.5) return 0;
    }
    // nothing taller than the camera within reach of it
    const p = c.resolve(x, z, CINE_CLEARANCE, y - 0.55);
    const pushed = Math.hypot(p.x - x, p.z - z);
    if (pushed > 0.01) return CINE_CLEARANCE - pushed;
    // (a bank may hide its feet, but not its body)
    for (const t of sights) if (!this.inSight(c, x, y, z, t)) return 0;
    return 99;
  }

  /**
   * Nothing between a camera at (x, y, z) and a point `t` on the giant: no
   * column or wall within a meter of the line (boxes taken as their round
   * bounds), no ice shrine's crystal, and (unless its `ground` is below 0)
   * no rise in the ground to within `ground` meters of the line. It stops 8 m short of the giant: a column at its feet hides a
   * sliver of it, one near the camera half the screen, and its body is no
   * collider. A few hundred sums, not the camera's fine ray march, since a
   * shot tries several spots in the frame it starts.
   */
  private inSight(c: CollisionWorld, x: number, y: number, z: number, t: CineSight): boolean {
    const dx = t.x - x;
    const dy = t.y - y;
    const dz = t.z - z;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1) return true;
    const end = Math.max(0, 1 - 8 / Math.sqrt(len2));
    for (const k of c.colliders) {
      const s = THREE.MathUtils.clamp(((k.x - x) * dx + (k.z - z) * dz) / len2, 0, end);
      if (y + dy * s > k.top) continue;
      const r = (k.kind === 'circle' ? k.r : Math.hypot(k.hx, k.hz)) + 1;
      if (Math.hypot(x + dx * s - k.x, z + dz * s - k.z) < r) return false;
    }
    for (const sh of this.mode.shrines) {
      const s = THREE.MathUtils.clamp(((sh.def.x - x) * dx + (sh.def.z - z) * dz) / len2, 0, end);
      if (Math.hypot(x + dx * s - sh.def.x, z + dz * s - sh.def.z) < 3) return false;
    }
    // the ground a meter at a time, so a narrow bank isn't stepped over
    const step = 1 / Math.sqrt(len2);
    if (t.ground >= 0) for (let s = step; s < end; s += step) if (y + dy * s < this.deps.groundAt(x + dx * s, z + dz * s) + t.ground) return false;
    return true;
  }

  prime(): () => void {
    const g = this.mode.giant;
    const snow = this.weather.prime();
    const view = this.view.prime(new THREE.Vector3(g.x, this.deps.groundAt(g.x, g.z), g.z));
    return () => {
      view();
      snow();
    };
  }
}
