import type { Side } from './combatant';
import { GODS } from './gods';
import type { JotunnRole } from '../combat/JotunnMode';
import { descentRoster } from '../net/descentRoster';
import { jotunnRoster } from '../net/jotunnRoster';
import { roster, type NetMode, type NetPlayer } from '../net/roster';
import { rushRoster } from '../net/rushRoster';

/**
 * Who plays a match, worked out before it starts so the god pick screen can
 * show the bots' gods: the same seed gives the match the very bots the
 * screen showed. Online rosters are already the same on every end (they
 * depend only on the lobby's players), so they need no seed.
 */

/** A small seeded random number generator (mulberry32): the same seed, the same numbers. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh seed for one match's lineup. */
export function newSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

const ids = (): string[] => GODS.map((g) => g.id);

function shuffled<T>(list: readonly T[], rng: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Conquest alone: four bot allies (never the player's god) and five enemies,
 * in the roster's order (it sets their lanes), drawn from every god so a
 * sixth or later god turns up too. Like Clash, changing the player's god only
 * replaces the ally that clashes with it.
 */
export function conquestBots(mine: string, rng: () => number): { allies: string[]; enemies: string[] } {
  const a = shuffled(ids(), rng);
  const e = shuffled(ids(), rng);
  return { allies: a.filter((id) => id !== mine).slice(0, 4), enemies: e.slice(0, 5) };
}

/**
 * Temple Clash's bots: two allies (never the player's own god) and three
 * enemies. Changing the player's god only replaces an ally that clashes with
 * it, so the screen's bots don't all reshuffle on every click.
 */
export function clashBots(mine: string, rng: () => number): { allies: string[]; enemies: string[] } {
  const a = shuffled(ids(), rng);
  const e = shuffled(ids(), rng);
  return { allies: a.filter((id) => id !== mine).slice(0, 2), enemies: e.slice(0, 3) };
}

/** Temple Siege's two bot allies. */
export function siegeBots(mine: string, rng: () => number): string[] {
  return shuffled(ids(), rng)
    .filter((id) => id !== mine)
    .slice(0, 2);
}

/** Temple Duel's rival: the one asked for, unless it is the player's own god (or none was), then one at random. */
export function duelRival(mine: string, wanted: string | undefined, rng: () => number): string {
  const others = ids().filter((id) => id !== mine);
  return wanted && others.includes(wanted) ? wanted : others[Math.floor(rng() * others.length)]!;
}

/** One god of a lineup: a person's (their player id) or a bot's. */
export interface LineupSlot {
  god: string;
  player: string | null;
  /** The Jötunn: this player is the giant in the first round. */
  giant?: boolean;
}

export interface Lineup {
  order: LineupSlot[];
  chaos: LineupSlot[];
}

export interface LineupSetup {
  mode: string;
  /** Everyone in the match (alone: just the player). */
  players: readonly NetPlayer[];
  /** Online: the lobby's kind and which teams want bots. */
  net?: { mode: NetMode; bots: Record<Side, boolean> };
  seed: number;
  rival?: string;
  allies?: boolean;
  rivals?: boolean;
  role?: JotunnRole;
}

const human = (p: NetPlayer): LineupSlot => ({ god: p.god, player: p.id });
const bot = (god: string): LineupSlot => ({ god, player: null });

/** Who plays on each team, as the match will build it (see CombatGame and the rosters in src/net). */
export function lineupFor(s: LineupSetup): Lineup {
  const me = s.players[0]!;
  const mine = me.god;
  const rng = () => seeded(s.seed);
  switch (s.mode) {
    case 'conquest': {
      if (s.net) {
        const slots = roster(s.players);
        // the fountain line-up runs solo, mid, duo, duo, roam: show people first, then bots
        const side = (t: Side) => slots.filter((x) => x.team === t).sort((a, b) => Number(!a.player) - Number(!b.player));
        return { order: side('order').map((x) => ({ god: x.god, player: x.player })), chaos: side('chaos').map((x) => ({ god: x.god, player: x.player })) };
      }
      const b = conquestBots(mine, rng());
      return { order: [human(me), ...b.allies.map(bot)], chaos: b.enemies.map(bot) };
    }
    case 'clash': {
      const b = clashBots(mine, rng());
      return { order: [human(me), ...b.allies.map(bot)], chaos: b.enemies.map(bot) };
    }
    case 'siege':
      return { order: [human(me), ...siegeBots(mine, rng()).map(bot)], chaos: [] };
    case 'duel':
      return { order: [human(me)], chaos: [bot(duelRival(mine, s.rival, rng()))] };
    case 'rush': {
      const slots = rushRoster(s.players, s.net ? undefined : rng());
      const side = (t: Side) => slots.filter((x) => x.team === t).map((x) => ({ god: x.god, player: x.player }));
      return { order: side('order'), chaos: side('chaos') };
    }
    case 'descent': {
      const setup = s.net ? { versus: s.net.mode === 'versus', bots: s.net.bots } : { versus: !!s.rivals, bots: { order: s.allies !== false } };
      const slots = descentRoster(s.players, s.net ? undefined : rng(), setup);
      const side = (t: Side) => slots.filter((x) => x.team === t).map((x) => ({ god: x.god, player: x.player }));
      return { order: side('order'), chaos: side('chaos') };
    }
    case 'jotunn': {
      const slots = jotunnRoster(s.players);
      const people = slots.filter((x) => x.player !== null).length;
      // alone a bot is the giant first (or you, or only the bot, by role); online the first person
      const first = people >= 2 ? 0 : s.role === 'giant' ? 0 : 1;
      return { order: slots.map((x, i) => ({ god: x.god, player: x.player, giant: i === first })), chaos: [] };
    }
    default:
      // the training ground: you, and the Thor holding the north side
      return { order: [human(me)], chaos: [bot('thor')] };
  }
}
