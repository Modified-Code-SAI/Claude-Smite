import * as THREE from 'three/webgpu';
import type { Side } from '../game/combatant';
import { GODS, godById } from '../game/gods';
import { XP_TABLE } from '../game/progression';
import { NetGuest, NetHost } from '../net/NetGame';
import type { RushSlot } from '../net/rushRoster';
import type { NetSession } from '../net/Session';
import type { PlayerController } from '../player/PlayerController';
import { godUnit } from '../sim/factory';
import { Nav } from '../sim/Nav';
import { Rush, RUSH } from '../sim/Rush';
import { RushBot, RushCoach } from '../sim/RushBot';
import type { Sim } from '../sim/Sim';
import type { Unit } from '../sim/Unit';
import { RushHud } from '../ui/RushHud';
import { RushView } from './RushView';
import type { GodPalette } from './palette';

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

  /** The fixed step, before the simulation's: the rules run on the host (or alone); a guest's copy keeps a thrown relic flying between snapshots. */
  step(dt: number): void {
    if (this.guest) this.rush.follow(dt);
    else this.rush.step(dt);
  }

  frame(dt: number, time: number): void {
    this.view.frame(this.rush, this.deps.player, this.deps.headOf, dt, time);
    this.beats();
    this.hud.pointer(this.pointer());
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
      const near = Math.max(0, 1 - Math.hypot(me.x - gate.x, me.z - gate.z) / 30);
      this.deps.shake?.(0.15 + near * 0.35);
    }
    if (r.phase === 'play' && seen.phase === 'kickoff' && at) burst(GOLD, at.x, at.y, at.z, 0.9);
    this.seen = { catch: r.beats.catch, steal: r.beats.steal, fumble: r.beats.fumble, shrug: r.beats.shrug, goals: r.goalCount, phase: r.phase };
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
}
