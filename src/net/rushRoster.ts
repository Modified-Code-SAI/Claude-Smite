import type { Side } from '../game/combatant';
import { GODS } from '../game/gods';
import type { NetPlayer } from './roster';

export const RUSH_TEAM = 3;
/** Humans take the middle spot first, then the flanks. */
const HUMAN_SPOTS = [1, 0, 2];

/** One of Relic Rush's six god slots, played by a human (their player id) or a bot. */
export interface RushSlot {
  team: Side;
  /** Place in the kickoff line (and the stand-up spot behind the gate). */
  spot: number;
  god: string;
  player: string | null;
}

/**
 * Who plays which slot, the same on every end of a networked match. A team
 * with more than three humans (a lobby where too many switched sides) sends
 * the extra players to the other one. `shuffle` picks the bots' gods at
 * random (single player only: networked ends must agree).
 */
export function rushRoster(players: readonly NetPlayer[], shuffle?: () => number): RushSlot[] {
  const teams: Record<Side, NetPlayer[]> = { order: players.filter((p) => p.team === 'order'), chaos: players.filter((p) => p.team !== 'order') };
  while (teams.order.length > RUSH_TEAM && teams.chaos.length < RUSH_TEAM) teams.chaos.push(teams.order.pop()!);
  while (teams.chaos.length > RUSH_TEAM && teams.order.length < RUSH_TEAM) teams.order.push(teams.chaos.pop()!);
  const slots: RushSlot[] = [];
  for (const team of ['order', 'chaos'] as const) {
    const humans = teams[team].slice(0, RUSH_TEAM);
    const bySpot = new Map(humans.map((p, i) => [HUMAN_SPOTS[i]!, p]));
    const used = new Set(humans.map((p) => p.god));
    const free = GODS.map((g) => g.id).filter((id) => !used.has(id));
    if (shuffle) free.sort(() => shuffle() - 0.5);
    let next = 0;
    for (let spot = 0; spot < RUSH_TEAM; spot++) {
      const p = bySpot.get(spot);
      slots.push({ team, spot, god: p ? p.god : free[next++ % free.length]!, player: p?.id ?? null });
    }
  }
  return slots;
}
