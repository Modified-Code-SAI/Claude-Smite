import { GODS, godById } from '../game/gods';
import { NetGuest, NetHost } from '../net/NetGame';
import type { DescentSlot } from '../net/descentRoster';
import type { NetSession } from '../net/Session';
import type { PlayerController } from '../player/PlayerController';
import type { World } from '../scene/World';
import { Descent, learnSkill } from '../sim/Descent';
import { DescentBot } from '../sim/DescentBot';
import { godUnit } from '../sim/factory';
import { Scoreboard } from '../sim/Scoreboard';
import type { Sim } from '../sim/Sim';
import type { SimEvent, Unit } from '../sim/Unit';
import { DescentHud } from '../ui/DescentHud';
import { DescentView, type DescentViewOptions } from './DescentView';
import type { CombatVfx } from './Vfx';

export interface DescentDeps {
  sim: Sim;
  /** The local player's unit, already in the sim (on its slot's team). */
  player: Unit;
  /** Who plays which god, on which team (descentRoster), the same on every end. */
  slots: readonly DescentSlot[];
  /** A shared descent: two teams racing the same chambers for souls. */
  versus: boolean;
  ctrl: PlayerController;
  net?: NetSession;
  world: World;
  vfx: CombatVfx;
  groundAt: (x: number, z: number) => number;
  toast: (text: string, tone?: 'gold') => void;
  /** The player learned a skill (the loadout menu redraws). */
  learned: () => void;
  /** Adds camera shake (0..1 trauma). */
  shake?: (amount: number) => void;
  /** A moment with its own sound (see DescentViewOptions.cue). */
  cue?: DescentViewOptions['cue'];
  /** Builds the models of the monsters a chamber will raise ahead of time (UnitViews.stock). */
  stock?: (coming: readonly { tag: string; name: string }[]) => void;
  /** Takes the camera for a boss's entrance, and a unit's drawn height to frame it (see DescentViewOptions). */
  cameraShot?: DescentViewOptions['cameraShot'];
  heightOf?: DescentViewOptions['heightOf'];
}

/**
 * Underworld Descent in a live game: builds the team (the humans, then bots
 * up to three gods; in a shared descent, both teams), runs the rules alone or
 * on the host, mirrors them on an online guest, and owns the mode's HUD and
 * view. Votes and skill picks go through `pick`, which a guest sends to the
 * host.
 */
export class DescentMode {
  readonly run: Descent;
  readonly gods: Unit[] = [];
  host: NetHost | null = null;
  guest: NetGuest | null = null;
  readonly hud: DescentHud;
  readonly view: DescentView;
  /** The chamber whose monsters' models were last stocked. */
  private stocked = 0;

  constructor(private readonly deps: DescentDeps) {
    const { sim, player, net, world } = deps;
    const me = net?.me ?? 'me';
    const slots = deps.slots;
    const run = (this.run = new Descent(sim, godById('zeus')!, undefined, deps.versus));
    const bot = (u: Unit) => {
      u.brain = new DescentBot(sim, u, run);
      // a friend who left no longer holds up the vote or the way down
      run.humans.delete(u);
    };
    const host = net?.isHost ? new NetHost(net, sim, bot, deps.toast) : null;
    const guest = !!net && !net.isHost;
    const humans: Unit[] = [];
    for (const s of slots) {
      let u = player;
      if (s.player !== me) {
        u = godUnit(godById(s.god) ?? GODS[0]!, s.team, world.spawn);
        if (s.player) host?.assign(s.player, u);
        else if (!guest) bot(u);
        sim.add(u);
      }
      this.gods.push(u);
      if (s.player) humans.push(u);
    }
    const roster = { slots: this.gods, structures: new Map<string, Unit>() };
    if (guest) {
      // the host's events arrive ready-made: nothing here may count them again
      sim.listeners.length = 0;
      run.join(this.gods, humans);
      this.guest = new NetGuest(net, sim, run, roster, player, deps.ctrl);
    } else {
      for (const u of this.gods) run.addGod(u, humans.includes(u));
      run.begin();
      if (host) {
        host.onAct = (u, msg) => {
          const i = typeof msg.i === 'number' ? msg.i : -1;
          if (msg.k === 'vote') run.vote(u, i);
          else if (msg.k === 'draft') run.draft(u, i);
        };
        host.bind(run, roster);
        this.host = host;
      }
    }
    const board = new Scoreboard(sim);
    board.track(this.gods);
    this.hud = new DescentHud(run, player, (i) => this.pick(i), board);
    this.view = new DescentView(run, world, deps.vfx, deps.groundAt, { team: run.sideOf(player), me: player, shake: deps.shake, cue: deps.cue, cameraShot: deps.cameraShot, heightOf: deps.heightOf, flashes: () => sim.flashes });
  }

  /** Votes for a reward, or drafts a skill (from its key or a click on its card). */
  pick(i: number): void {
    const run = this.run;
    const me = this.deps.player;
    if (run.phase === 'reward') {
      if (!run.offer?.[i]) return;
      if (this.guest) {
        this.guest.act({ k: 'vote', i });
        run.votes.set(me, i);
      } else run.vote(me, i);
    } else if (run.phase === 'draft') {
      const d = run.drafts.get(me);
      const skill = d?.options[i];
      if (!d || !skill) return;
      if (this.guest) {
        // learned here at once: a guest keeps its own loadout, and the host learns the same
        this.guest.act({ k: 'draft', i });
        run.drafts.delete(me);
        learnSkill(me, d.slot, skill);
      } else run.draft(me, i);
      this.deps.toast(`Learned ${skill.name}`, 'gold');
      this.deps.learned();
    }
  }

  /** The fixed step, before the simulation's: the rules on the host (or alone); a guest's copy only runs its clocks. */
  step(dt: number): void {
    if (this.guest) this.run.follow(dt);
    else this.run.step(dt);
  }

  /** Toasts wait while a new depth's name is up, so the opening tip doesn't print over it (see CombatHud.holdToasts). */
  get holdsToasts(): boolean {
    return this.hud.depthCardUp;
  }

  onEvent(e: SimEvent): void {
    this.hud.onEvent(e);
    this.view.onEvent(e);
  }

  frame(dt: number, time: number): void {
    // a new chamber: its monsters' models are built while the team walks in, not as each wave rises
    if (this.run.chamber !== this.stocked) {
      this.stocked = this.run.chamber;
      this.deps.stock?.(this.run.upcoming());
    }
    this.hud.frame();
    this.view.frame(dt, time);
  }
}
