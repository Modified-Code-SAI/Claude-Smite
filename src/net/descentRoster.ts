import { GODS } from '../game/gods';
import type { NetPlayer } from './roster';

/** Underworld Descent's team: bots fill it to three; up to four friends play. */
export const DESCENT_TEAM = 3;
export const DESCENT_PLAYERS = 4;

/** One god of the descending team, played by a human (their player id) or a bot. */
export interface DescentSlot {
  god: string;
  player: string | null;
}

/**
 * Who plays which god, the same on every end of a networked run: the humans
 * in lobby order, then bots with gods no human picked until the team has
 * three. `shuffle` picks the bots' gods at random (single player only:
 * networked ends must agree).
 */
export function descentRoster(players: readonly NetPlayer[], shuffle?: () => number): DescentSlot[] {
  const humans = players.slice(0, DESCENT_PLAYERS);
  const used = new Set(humans.map((p) => p.god));
  const free = GODS.map((g) => g.id).filter((id) => !used.has(id));
  if (shuffle) free.sort(() => shuffle() - 0.5);
  const slots: DescentSlot[] = humans.map((p) => ({ god: p.god, player: p.id }));
  for (let k = 0; slots.length < DESCENT_TEAM; k++) slots.push({ god: free[k % free.length]!, player: null });
  return slots;
}
