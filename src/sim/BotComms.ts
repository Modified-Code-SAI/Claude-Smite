import { hypot } from '../core/math';
import type { Side } from '../game/combatant';
import { GodBot } from './Bot';
import { DescentBot } from './DescentBot';
import type { CampState } from './Jungle';
import { LaneBot } from './LaneBot';
import type { Match } from './Match';
import type { PingKind } from './Pings';
import type { Sim } from './Sim';
import { worldSpeed, type Brain, type SimEvent, type Unit } from './Unit';

/** The god bot inside a mode's bot brain, if it is one that takes teammates' calls. */
export function godBotOf(b: Brain | null): GodBot | null {
  if (b instanceof GodBot) return b;
  if (b instanceof LaneBot) return b.bot;
  if (b instanceof DescentBot) return b.inner;
  return null;
}

/** How many bots come when a player calls: the nearest few for a fight, everyone to group. */
const ANSWERS: Partial<Record<PingKind, number>> = { attack: 2, help: 2, group: 4 };
/** Bots this close to a "fall back" mark back off. */
const BACK_RADIUS = 30;
const BACK_TIME = 6;
/** A bot this hurt doesn't answer a call to fight. */
const TOO_HURT = 0.35;
/** A team's bots call the same boss again only after this long, seconds. */
const BOSS_CALL_GAP = 45;

type PingEvent = Extract<SimEvent, { type: 'ping' }>;

/**
 * Bot teammates answering pings, on the end that runs the match: the nearest
 * bots come to an attack or help call (all of them to group up) and say they
 * are on the way; bots near a "fall back" mark break off. In Conquest the
 * bots also ping their own boss calls, so players see the team gathering.
 */
export class BotComms {
  private readonly replies: { at: number; u: Unit; kind: PingKind; x: number; z: number; subject: Unit | null }[] = [];
  private readonly called: Record<Side, { camp: CampState | null; at: number }> = { order: { camp: null, at: -99 }, chaos: { camp: null, at: -99 } };

  constructor(
    private readonly sim: Sim,
    /** Conquest's match, whose boss calls the bots ping. */
    private readonly match: () => Match | null = () => null,
    /** False on an online guest's end, where the host's bots answer instead. */
    private readonly active: () => boolean = () => true,
  ) {
    sim.listeners.push((e) => {
      if (e.type === 'ping' && this.active()) this.heard(e);
    });
  }

  /** Each fixed step: send the bots' replies when they are due, and their boss calls. */
  step(): void {
    const sim = this.sim;
    for (let i = this.replies.length - 1; i >= 0; i--) {
      const r = this.replies[i]!;
      if (r.at > sim.time) continue;
      this.replies.splice(i, 1);
      if (r.u.alive && (!r.subject || r.subject.alive)) sim.ping(r.u, r.kind, r.x, r.z, r.subject);
    }
    const match = this.match();
    if (match) for (const side of ['order', 'chaos'] as const) this.bossCall(side, match);
  }

  private heard(e: PingEvent): void {
    const from = e.unit;
    // bots never answer each other, or they would talk in circles
    if (godBotOf(from.brain)) return;
    const sim = this.sim;
    const team = this.bots(from);
    if (e.kind === 'back') {
      for (const u of team) {
        if (hypot(u.x - e.x, u.z - e.z) > BACK_RADIUS) continue;
        godBotOf(u.brain)!.order = { kind: 'back', at: { x: e.x, z: e.z }, subject: null, until: sim.time + BACK_TIME };
      }
      return;
    }
    const count = ANSWERS[e.kind];
    if (!count) return;
    // help with no one named means "help me"
    const subject = e.kind === 'help' ? (e.subject ?? from) : e.subject;
    const goal = subject ?? { x: e.x, z: e.z };
    const answering = team
      .filter((u) => u.combatant.health / u.combatant.stats.maxHealth > TOO_HURT)
      .map((u) => ({ u, d: hypot(u.x - goal.x, u.z - goal.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, count);
    answering.forEach(({ u, d }, i) => {
      const travel = d / Math.max(1, worldSpeed(u.combatant.stats.moveSpeed));
      godBotOf(u.brain)!.order = { kind: 'come', at: { x: e.x, z: e.z }, subject, until: sim.time + Math.min(32, travel * 1.3 + 9) };
      // the first two say so, a beat apart
      if (i < 2) this.replies.push({ at: sim.time + 0.6 + i * 0.55 + sim.rng() * 0.5, u, kind: 'omw', x: e.x, z: e.z, subject: e.subject });
    });
  }

  /** The living bot gods on a unit's team, besides it. */
  private bots(from: Unit): Unit[] {
    return this.sim.units.filter((u) => u !== from && u.kind === 'god' && u.team === from.team && u.alive && godBotOf(u.brain) !== null);
  }

  /** A team's bots calling a jungle boss ping the pit for everyone on the team, once per call. */
  private bossCall(side: Side, match: Match): void {
    const camp = match.objectives.call(side);
    const last = this.called[side];
    if (camp === last.camp) return;
    last.camp = camp;
    if (!camp || this.sim.time - last.at < BOSS_CALL_GAP) return;
    const boss = camp.members.find((m) => m.alive) ?? null;
    if (!boss) return;
    const [x, z] = camp.camp.at;
    let caller: Unit | null = null;
    let best = Infinity;
    for (const u of this.sim.units) {
      if (u.kind !== 'god' || u.team !== side || !u.alive || !godBotOf(u.brain)) continue;
      const d = hypot(u.x - x, u.z - z);
      if (d < best) [best, caller] = [d, u];
    }
    if (caller && this.sim.ping(caller, 'group', x, z, boss)) last.at = this.sim.time;
  }
}
