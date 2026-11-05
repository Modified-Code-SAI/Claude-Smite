import type * as THREE from 'three/webgpu';
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
    deps.vfx.add(this.view.group);
    this.hud = new RushHud(rush, player, this.gods, !!net);
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
    this.hud.frame(dt);
  }

  prime(): () => void {
    return this.view.prime();
  }
}
