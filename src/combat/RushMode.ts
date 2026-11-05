import * as THREE from 'three/webgpu';
import type { Side } from '../game/combatant';
import { GODS, godById } from '../game/gods';
import { XP_TABLE } from '../game/progression';
import { NetGuest, NetHost } from '../net/NetGame';
import type { RushSlot } from '../net/rushRoster';
import type { NetSession } from '../net/Session';
import type { PlayerController } from '../player/PlayerController';
import type { CameraShot } from '../player/ThirdPersonCamera';
import { godUnit } from '../sim/factory';
import { Nav } from '../sim/Nav';
import { Rush, RUSH } from '../sim/Rush';
import { RushBot, RushCoach } from '../sim/RushBot';
import type { Sim } from '../sim/Sim';
import type { Unit } from '../sim/Unit';
import { RushHud } from '../ui/RushHud';
import { GOAL_CAM, goalCamSpot } from './goalCam';
import { RushView } from './RushView';
import type { GodPalette } from './palette';

/** Seconds after the winning moment that the winners pump their fists (the world stills at 4 s). */
const VICTORY_PUMPS = [0.45, 1.55, 2.65, 3.6];
const tone = (main: number, core: number): GodPalette => ({ cloth: main, trim: core, glow: main, vfx: main, core });
const GOLD = tone(0xffc23a, 0xfff2c4);
const ALLY = tone(0x4fb2ff, 0xe6f4ff);
const FOE = tone(0xff3524, 0xffe0c8);

export interface RushDeps {
  sim: Sim;
  /** The local player's unit, already in the sim at its slot's stand-up spot. */
  player: Unit;
  ctrl: PlayerController;
  slots: readonly RushSlot[];
  /** The local player's slot id (their peer id online, 'me' alone). */
  me: string;
  net?: NetSession;
  vfx: THREE.Object3D;
  gold: THREE.Material;
  /** The temple's floating crystal, whose light the Sun Relic borrows. */
  temple?: THREE.Group;
  groundAt: (x: number, z: number) => number;
  headOf: (u: Unit, out: THREE.Vector3) => THREE.Vector3 | null;
  toast: (text: string) => void;
  camera: THREE.Camera;
  /** A burst of light and sparks (CombatVfx.burst). */
  burst: (p: GodPalette, x: number, y: number, z: number, power: number) => void;
  shake?: (amount: number) => void;
  /** Plays a god's throwing arm (the basic-attack swing), or a scorer's cheer ('ult': chest up, a hand to the sky). */
  swing?: (u: Unit, kind?: 'basic' | 'ult') => void;
  /** Lays a camera shot over the follow camera (the first kickoff's fly-over); null hands it back. */
  cameraShot?: (shot: CameraShot | null) => void;
}

/**
 * The first kickoff's fly-over: the camera sweeps round the pitch from high
 * over the crowd, looking in at the pedestal, and comes down behind the
 * player's god as the countdown ends. Seconds into the countdown.
 */
const FLYOVER = { sweep: 1.35, radius: [27, 19], height: [15, 8.5], orbitFor: 2.6, holdUntil: 1.75, backBy: 2.75 } as const;

/** A teammate's call for the pass, placed over their head on screen. */
export interface RushCall {
  x: number;
  y: number;
  name: string;
  mine: boolean;
  /** 0 just called .. 1 about to fade. */
  age: number;
}

/**
 * Relic Rush in a live game: builds the six gods from the slots (bots think
 * on the host or alone; online guests only mirror the host), and owns the
 * mode's view and HUD. CombatGame steps it and routes the carrier's clicks here.
 */
export class RushMode {
  readonly rush: Rush;
  readonly gods: Unit[] = [];
  host: NetHost | null = null;
  guest: NetGuest | null = null;
  private readonly view: RushView;
  private readonly hud: RushHud;
  /** The beats already shown, so each catch, fumble and goal flashes once. */
  private seen = { catch: 0, steal: 0, fumble: 0, shrug: 0, goals: 0, phase: '' as string };
  private readonly v = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly toHead = new THREE.Vector3();
  private lastThrower: Unit | null = null;
  /** Seconds into the goal celebration at the last frame (-1 outside one), to catch the scorer's second fist pump. */
  private cheerAt = -1;
  /** Seconds since the match was won (-1 before), for the winners' fist pumps. */
  private wonFor = -1;

  constructor(private readonly deps: RushDeps) {
    const { sim, player, slots, net } = deps;
    this.rush = new Rush(sim);
    const rush = this.rush;
    const coach = new RushCoach(sim, rush);
    const nav = new Nav({ groundAt: deps.groundAt, resolve: (x, z, r, y) => sim.solid(x, z, r, y) }, RUSH.pitchRadius + 2);
    const bot = (u: Unit) => (u.brain = new RushBot(sim, u, rush, coach, nav));
    const host = net?.isHost ? new NetHost(net, sim, bot, deps.toast) : null;
    const guest = !!net && !net.isHost;
    for (const s of slots) {
      let u = player;
      if (s.player !== deps.me) {
        u = godUnit(godById(s.god) ?? GODS[0]!, s.team, RUSH.homes[s.team][s.spot]!);
        if (s.player) host?.assign(s.player, u);
        else if (!guest) bot(u);
        sim.add(u);
      }
      this.gods.push(u);
    }
    for (const u of this.gods) {
      const c = u.combatant;
      c.gainXp(XP_TABLE[RUSH.startLevel - 1]!);
      c.gainFavor(RUSH.startFavor);
      c.health = c.stats.maxHealth;
      c.mana = c.stats.maxMana;
    }
    const roster = { slots: this.gods, structures: new Map<string, Unit>() };
    if (guest) {
      // the host's events arrive ready-made: nothing here may count them again
      sim.listeners.length = 0;
      rush.join(this.gods);
      this.guest = new NetGuest(net, sim, rush, roster, player, deps.ctrl);
    } else {
      nav.warm();
      rush.begin(this.gods);
      if (host) {
        host.onAct = (u, msg) => {
          const a = msg.a as [number, number] | undefined;
          if (msg.k === 'throw' && a) rush.throwRelic(u, { x: a[0], z: a[1] });
          else if (msg.k === 'call') rush.call(u);
        };
        host.bind(rush, roster);
        this.host = host;
      }
    }
    const mine = player.team as Side;
    this.view = new RushView(deps.groundAt, deps.gold, mine, deps.temple);
    this.view.camera = deps.camera;
    deps.vfx.add(this.view.group);
    this.hud = new RushHud(rush, player, this.gods, !!net);
    this.seen = { catch: rush.beats.catch, steal: rush.beats.steal, fumble: rush.beats.fumble, shrug: rush.beats.shrug, goals: rush.goalCount, phase: rush.phase };
  }

  /** Whether the local player has the relic (their skills and basic attack give way to throwing). */
  get carrying(): boolean {
    return this.rush.holder === this.deps.player;
  }

  /** Kickoff countdowns hold everyone on their marks. */
  get frozen(): boolean {
    return this.rush.frozen;
  }

  /** The local carrier throws toward their aim point. */
  throw(): void {
    const me = this.deps.player;
    if (this.guest) this.guest.act({ k: 'throw', a: [me.aim.x, me.aim.z] });
    else this.rush.throwRelic(me, me.aim);
  }

  /** The local player calls for the pass (F): shown to teammates, and a bot carrier throws it to them. */
  call(): void {
    if (this.guest) this.guest.act({ k: 'call' });
    else this.rush.call(this.deps.player);
  }

  /** The fixed step, before the simulation's: the rules run on the host (or alone); a guest's copy keeps a thrown relic flying between snapshots. */
  step(dt: number): void {
    if (this.guest) this.rush.follow(dt);
    else this.rush.step(dt);
  }

  /** The first kickoff's fly-over (see FLYOVER), and where it ends: the player's own side of the pitch. */
  private flyover: { end: number; shot: CameraShot } | null = null;
  private flyoverDone = false;

  private flyoverFrame(): void {
    const set = this.deps.cameraShot;
    const r = this.rush;
    if (this.flyoverDone || !set) return;
    // only a match that's just starting (not a guest joining mid-game, nor a later kickoff)
    if (r.phase !== 'kickoff' || r.goalCount > 0 || r.overtime) {
      this.flyoverDone = true;
      if (this.flyover) set(null);
      this.flyover = null;
      document.body.classList.remove('rush-cine');
      return;
    }
    const me = this.deps.player;
    if (!this.flyover) {
      if (r.timer < RUSH.countdown - 0.05) {
        this.flyoverDone = true;
        return;
      }
      this.flyover = { end: Math.atan2(me.x, me.z), shot: { pos: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 1.2, z: 0 }, weight: 1 } };
    }
    const s = RUSH.countdown - r.timer;
    const k = Math.min(1, s / FLYOVER.orbitFor);
    const u = k * k * (3 - 2 * k);
    const a = this.flyover.end - FLYOVER.sweep * (1 - u);
    const rad = FLYOVER.radius[0] + (FLYOVER.radius[1] - FLYOVER.radius[0]) * u;
    const shot = this.flyover.shot;
    shot.pos.x = Math.sin(a) * rad;
    shot.pos.z = Math.cos(a) * rad;
    shot.pos.y = this.deps.groundAt(0, 0) + FLYOVER.height[0] + (FLYOVER.height[1] - FLYOVER.height[0]) * u;
    shot.look.y = this.deps.groundAt(0, 0) + 1.2;
    const back = Math.min(1, Math.max(0, (s - FLYOVER.holdUntil) / (FLYOVER.backBy - FLYOVER.holdUntil)));
    shot.weight = 1 - back * back * (3 - 2 * back);
    set(shot.weight > 0.001 ? shot : null);
    // the action bar, health bars and nameplates stand aside while the camera is up in the stands
    document.body.classList.toggle('rush-cine', shot.weight > 0.4);
  }

  /** The goal cam (see GOAL_CAM) for the goal it was set up for. */
  private goalCam: { goal: number; shot: CameraShot } | null = null;

  private goalCamFrame(dt: number): void {
    const set = this.deps.cameraShot;
    const r = this.rush;
    const g = r.lastGoal;
    if (!set) return;
    if (r.phase !== 'goal' || !g) {
      if (this.goalCam) {
        set(null);
        this.goalCam = null;
        document.body.classList.remove('rush-cine');
      }
      return;
    }
    const ground = this.deps.groundAt;
    const u = g.scorer;
    if (!this.goalCam || this.goalCam.goal !== r.goalCount) {
      const gate = RUSH.gates[g.team === 'order' ? 'chaos' : 'order'];
      const best = goalCamSpot(u.x, u.z, gate);
      this.goalCam = {
        goal: r.goalCount,
        shot: { pos: { x: best.x, y: ground(best.x, best.z) + GOAL_CAM.height, z: best.z }, look: { x: u.x, y: ground(u.x, u.z) + GOAL_CAM.look, z: u.z }, weight: 0 },
      };
    }
    const shot = this.goalCam.shot;
    // the look follows the scorer as they celebrate and their team mobs them
    const k = 1 - Math.exp(-GOAL_CAM.follow * dt);
    shot.look.x += (u.x - shot.look.x) * k;
    shot.look.z += (u.z - shot.look.z) * k;
    shot.look.y += (ground(u.x, u.z) + GOAL_CAM.look - shot.look.y) * k;
    const dx = shot.look.x - shot.pos.x;
    const dz = shot.look.z - shot.pos.z;
    const gap = Math.hypot(dx, dz);
    if (gap > GOAL_CAM.near && shot.weight > 0) {
      const step = Math.min(GOAL_CAM.push * dt, gap - GOAL_CAM.near) / gap;
      shot.pos.x += dx * step;
      shot.pos.z += dz * step;
    }
    shot.pos.y += (ground(shot.pos.x, shot.pos.z) + GOAL_CAM.height - shot.pos.y) * k;
    shot.weight = RUSH.celebrate - r.timer >= GOAL_CAM.cutAt ? 1 : 0;
    set(shot.weight > 0 ? shot : null);
    document.body.classList.toggle('rush-cine', shot.weight > 0.4);
  }

  frame(dt: number, time: number): void {
    this.flyoverFrame();
    this.goalCamFrame(dt);
    this.view.frame(this.rush, this.deps.player, this.deps.headOf, dt, time);
    this.beats();
    this.victory(dt);
    this.throws();
    this.hud.pointer(this.pointer());
    this.hud.calls(this.callouts());
    this.hud.frame(dt);
  }

  /** Light and shake for the sport's big moments: a catch, the relic knocked loose, a goal, the relic released at kickoff. */
  private beats(): void {
    const r = this.rush;
    const seen = this.seen;
    const me = this.deps.player;
    const at = this.view.relicAt;
    const burst = (p: GodPalette, x: number, y: number, z: number, power: number) => this.deps.burst(p, x, y, z, power);
    if (at && (r.beats.catch !== seen.catch || r.beats.steal !== seen.steal)) burst(GOLD, at.x, at.y, at.z, 0.45);
    if (at && r.beats.fumble !== seen.fumble) {
      burst(GOLD, at.x, at.y, at.z, 0.8);
      const b = r.lastBeat;
      if (b?.kind === 'fumble' && (b.unit === me || b.by === me)) this.deps.shake?.(0.25);
    }
    if (at && r.beats.shrug !== seen.shrug) {
      // a Captain keeps it: a ring of gold off the carrier
      burst(GOLD, at.x, at.y, at.z, 0.65);
      if (r.lastBeat?.unit === me) this.deps.shake?.(0.12);
    }
    if (r.goalCount !== seen.goals && r.lastGoal) {
      const g = r.lastGoal;
      const gate = RUSH.gates[g.team === 'order' ? 'chaos' : 'order'];
      const y = this.deps.groundAt(gate.x, gate.z);
      burst(g.team === me.team ? ALLY : FOE, gate.x, y + 2.4, gate.z, 1.9);
      burst(GOLD, gate.x, y + 0.5, gate.z, 1.2);
      // the scorer throws a fist to the sky (Rush.goal marked it as an action, so every end holds the pose)
      this.deps.swing?.(g.scorer, 'ult');
      this.cheerAt = 0;
      const near = Math.max(0, 1 - Math.hypot(me.x - gate.x, me.z - gate.z) / 30);
      this.deps.shake?.(0.15 + near * 0.35);
    }
    if (r.phase === 'play' && seen.phase === 'kickoff' && at) burst(GOLD, at.x, at.y, at.z, 0.9);
    // and again a moment later
    const cheer = r.phase === 'goal' && r.lastGoal ? RUSH.celebrate - r.timer : -1;
    if (r.lastGoal && this.cheerAt >= 0 && this.cheerAt < RUSH.cheer.again && cheer >= RUSH.cheer.again) this.deps.swing?.(r.lastGoal.scorer, 'ult');
    this.cheerAt = cheer;
    this.seen = { catch: r.beats.catch, steal: r.beats.steal, fumble: r.beats.fumble, shrug: r.beats.shrug, goals: r.goalCount, phase: r.phase };
  }

  /**
   * The winners throw their fists to the sky together, again and again, until
   * the world stills behind the result (the last pump holds as their pose).
   */
  private victory(dt: number): void {
    const r = this.rush;
    if (!r.winner) return;
    const was = this.wonFor;
    this.wonFor = was < 0 ? 0 : was + dt;
    r.team(r.winner).forEach((g, i) => {
      if (!g.alive) return;
      for (const at of VICTORY_PUMPS) {
        const t = at + i * 0.18;
        if (was < t && this.wonFor >= t) {
          g.sinceAction = 0;
          this.deps.swing?.(g, 'ult');
        }
      }
    });
  }

  /** A new throw swings its thrower's arm (on every end: the relic's state says who threw). */
  private throws(): void {
    const r = this.rush.relic;
    const thrower = r.phase === 'flying' ? r.thrower : null;
    if (thrower && thrower !== this.lastThrower) {
      thrower.sinceAction = 0;
      this.deps.swing?.(thrower);
    }
    this.lastThrower = thrower;
  }

  /** Teammates calling for the pass (and the player's own call), over their heads on screen. */
  private callouts(): RushCall[] {
    const out: RushCall[] = [];
    const me = this.deps.player;
    const cam = this.deps.camera;
    cam.getWorldDirection(this.fwd);
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const g of this.rush.team(me.team as Side)) {
      const ago = this.rush.calledAgo(g);
      if (ago === null || !g.alive) continue;
      const head = this.deps.headOf(g, this.v);
      if (!head) continue;
      head.y += 0.9;
      if (this.fwd.dot(this.toHead.copy(head).sub(cam.position)) < 0) continue;
      const p = head.project(cam);
      if (Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05) continue;
      out.push({ x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, name: g === me ? 'You' : g.name, mine: g === me, age: ago / RUSH.call.time });
    }
    return out;
  }

  /**
   * Where the edge-of-screen arrow points when the relic is out of sight:
   * screen pixels, the angle it points, and whose it is. Null while the relic
   * is on screen, gone, or in this player's own hands.
   */
  private pointer(): { x: number; y: number; angle: number; tone: 'ally' | 'foe' | 'gold' } | null {
    const r = this.rush;
    const at = this.view.relicAt;
    const me = this.deps.player;
    if (!at || r.holder === me || r.phase === 'goal' || r.phase === 'over') return null;
    const cam = this.deps.camera;
    cam.getWorldDirection(this.fwd);
    const behind = this.fwd.dot(this.v.copy(at).sub(cam.position)) < 0;
    const v = this.v.copy(at).project(cam);
    let x = v.x;
    let y = v.y;
    if (!behind && Math.abs(x) < 0.94 && Math.abs(y) < 0.9) return null;
    if (behind) {
      x = -x;
      y = -y;
      // straight behind: point down, toward the camera's back
      if (Math.abs(x) < 0.05 && Math.abs(y) < 0.05) y = -1;
      // behind always reads as below the view
      y = Math.min(y, -0.3);
    }
    const k = 1 / Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.8);
    const ex = x * k;
    const ey = y * k;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const holder = r.holder;
    return { x: ((ex + 1) / 2) * w, y: ((1 - ey) / 2) * h, angle: Math.atan2(-ey, ex), tone: holder ? (holder.team === me.team ? 'ally' : 'foe') : 'gold' };
  }

  prime(): () => void {
    return this.view.prime();
  }

  /** How excited one end of the crowd is right now (0 to 1), for its sound. */
  crowdHeat(side: Side): number {
    return this.view.crowd.excitement(side);
  }
}
