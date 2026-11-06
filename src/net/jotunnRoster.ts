import { GODS } from '../game/gods';
import { JOTUNN } from '../sim/Jotunn';
import type { NetPlayer } from './roster';

/** The Jötunn takes one giant and four gods: up to five people play, bots fill the rest. */
export const JOTUNN_PLAYERS = JOTUNN.gods + 1;

/** One player of a Jötunn match, a human (their player id) or a bot. */
export interface JotunnSlot {
  name: string;
  god: string;
  player: string | null;
}

/**
 * Who plays, the same on every end of a networked match: the humans in lobby
 * order, then bots with gods no human picked, until there are five. Alone,
 * `shuffle` (the god pick's seeded dice) draws the bots from every god, so the
 * newer gods turn up as often as the first five.
 */
export function jotunnRoster(players: readonly NetPlayer[], shuffle?: () => number): JotunnSlot[] {
  const humans = players.slice(0, JOTUNN_PLAYERS);
  const used = new Set(humans.map((p) => p.god));
  // every god dealt once, whoever you pick, so trying another god on the pick screen only swaps out the bot that had it
  const deck = [...GODS];
  if (shuffle) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(shuffle() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
  }
  const free = deck.filter((g) => !used.has(g.id));
  const slots: JotunnSlot[] = humans.map((p) => ({ name: p.name, god: p.god, player: p.id }));
  for (let k = 0; slots.length < JOTUNN_PLAYERS; k++) {
    const g = free[k % Math.max(1, free.length)] ?? GODS[k % GODS.length]!;
    slots.push({ name: g.name, god: g.id, player: null });
  }
  return slots;
}
