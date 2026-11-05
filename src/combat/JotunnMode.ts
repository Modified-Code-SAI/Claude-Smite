import * as THREE from 'three/webgpu';
import type { Input } from '../core/Input';
import { GODS } from '../game/gods';
import type { PlayerController } from '../player/PlayerController';
import type { Fire } from '../scene/Effects';
import { Jotunn, JOTUNN, type JotunnPlayer } from '../sim/Jotunn';
import { jotunnBots } from '../sim/JotunnBots';
import type { Sim } from '../sim/Sim';
import type { SimEvent, Unit } from '../sim/Unit';
import { JotunnHud } from '../ui/JotunnHud';
import { JotunnView } from './JotunnView';
import { paletteFor } from './palette';

/** Who plays the giant alone: everyone in turn (a bot first, then you), only you, or only the bots. */
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
  /** How quickly the bot gods notice a warning (difficulty); see jotunnBots. */
  reaction?: number;
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
 * The Jötunn in a live game, played alone with bots: the rules, the bots on
 * both sides, the view and HUD, and driving the giant when it is the local
 * player's turn. A giant walks where WASD points (relative to the camera)
 * and turns its body toward the camera slowly, so gods can get behind it.
 */
export class JotunnMode {
  readonly mode: Jotunn;
  readonly view: JotunnView;
  private readonly hud: JotunnHud;
  /** The local player drives the giant this round. */
  piloting = false;
  private readonly camAt = new THREE.Vector3();

  constructor(private readonly deps: JotunnDeps) {
    const { sim, player } = deps;
    const others = GODS.filter((g) => g.id !== player.combatant.god.id).slice(0, JOTUNN.gods);
    const players = [{ name: 'You', id: '', god: player }, ...others.map((g) => ({ name: g.name, id: null, god: g }))];
    const order = deps.role === 'giant' ? [0] : deps.role === 'god' ? [1] : undefined;
    this.mode = new Jotunn(sim, players, { order, brains: jotunnBots(sim, { reaction: deps.reaction }) });
    const mode = this.mode;
    mode.onRound = (p) => this.round(p);
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
    });
    deps.vfx.add(this.view.group);
    this.hud = new JotunnHud(mode, player);
    mode.begin();
  }

  /** A round starts: the local player takes the giant on their turn, their god otherwise. */
  private round(p: JotunnPlayer): void {
    const mine = p.god === this.deps.player;
    this.piloting = mine;
    this.deps.control(mine ? this.mode.giant : this.deps.player, mine);
    if (mine) {
      this.camAt.set(this.mode.giant.x, this.mode.giant.body.y, this.mode.giant.z);
      this.deps.ctrl.spawn(this.mode.giant.x, this.mode.giant.z, this.mode.giant.body.yaw);
      this.deps.ctrl.pitch = GIANT_CAMERA.pitch;
      this.deps.toast('You are the Jötunn. Smash three of the four braziers on the temple. Stand in an ice shrine to claim a new ultimate. Your knees, back rune, wrists and crown are where the gods break you.');
    } else {
      this.deps.toast(`${p.name} is the Jötunn. Keep it from the braziers: break both knees to bring it down, then strike its crown. After a slam, break the planted wrist.`);
    }
  }

  /** The fixed step, before the simulation's: drive the giant from the keys when it is ours. */
  step(dt: number): void {
    if (this.piloting) this.pilot(dt);
    this.mode.step(dt);
  }

  /** After the simulation's step: the camera's anchor follows the giant. */
  afterStep(): void {
    if (!this.piloting) return;
    const g = this.mode.giant;
    this.deps.ctrl.position.set(g.x, g.body.y, g.z);
  }

  private pilot(dt: number): void {
    const g = this.mode.giant;
    const { input, ctrl } = this.deps;
    // the body comes round to the camera slowly; a wound-up blow holds it
    if (g.windup <= 0 && g.alive) {
      let d = ctrl.yaw - g.body.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const turn = TURN * dt;
      g.body.yaw += THREE.MathUtils.clamp(d, -turn, turn);
    }
    if (this.mode.phase !== 'fight' || !g.alive) {
      g.move = null;
      return;
    }
    const f = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    const r = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    if (!f && !r) {
      g.move = null;
      return;
    }
    const sin = Math.sin(ctrl.yaw);
    const cos = Math.cos(ctrl.yaw);
    // forward = (-sin, -cos), right = (cos, -sin)
    g.move = { x: -sin * f + cos * r, z: -cos * f - sin * r };
  }

  onEvent(e: SimEvent): void {
    this.view.onEvent(e);
  }

  frame(dt: number, time: number): void {
    this.view.update(dt, time);
    this.hud.frame(dt);
  }

  prime(): () => void {
    const g = this.mode.giant;
    this.view.prime(new THREE.Vector3(g.x, this.deps.groundAt(g.x, g.z), g.z));
    return () => undefined;
  }
}
