import type { Side } from '../game/combatant';
import { GODS } from '../game/gods';
import type { NetPlayer } from './roster';

/** Underworld Descent's team: bots fill it to three; up to four friends play together, or three a side in a shared descent. */
export const DESCENT_TEAM = 3;
export const DESCENT_PLAYERS = 4;

/** One god of the descent, played by a human (their player id) or a bot. */
export interface DescentSlot {
  god: string;
  player: string | null;
  team: Side;
}

/** How the run is set up: co-op or a shared descent (team versus), and which teams want bots to fill their empty spots. */
export interface DescentSetup {
  versus?: boolean;
  bots?: Partial<Record<Side, boolean>>;
}

/**
 * Who plays which god, the same on every end of a networked run. Co-op: the
 * humans in lobby order, then (unless the team turned bots off) bots until
 * the team has three. A shared descent: Order's slots, then Chaos's, each
 * team's humans first (at most three a side: extras cross over), then bots to
 * three if that team wants them. A team with no humans is always three bots.
 * Bots play gods nobody on their team picked, gods nobody picked at all
 * first. `shuffle` picks the bots' gods at random (single player only:
 * networked ends must agree).
 */
export function descentRoster(players: readonly NetPlayer[], shuffle?: () => number, setup: DescentSetup = {}): DescentSlot[] {
  const bots = (team: Side) => setup.bots?.[team] !== false;
  if (!setup.versus) {
    const humans = players.slice(0, DESCENT_PLAYERS);
    return fill('order', humans, bots('order') || !humans.length ? DESCENT_TEAM : humans.length, new Set(), shuffle);
  }
  const teams: Record<Side, NetPlayer[]> = { order: players.filter((p) => p.team !== 'chaos'), chaos: players.filter((p) => p.team === 'chaos') };
  while (teams.order.length > DESCENT_TEAM && teams.chaos.length < DESCENT_TEAM) teams.chaos.push(teams.order.pop()!);
  while (teams.chaos.length > DESCENT_TEAM && teams.order.length < DESCENT_TEAM) teams.order.push(teams.chaos.pop()!);
  const picked = new Set(players.map((p) => p.god));
  return (['order', 'chaos'] as const).flatMap((team) => {
    const humans = teams[team].slice(0, DESCENT_TEAM);
    return fill(team, humans, bots(team) || !humans.length ? DESCENT_TEAM : humans.length, picked, shuffle);
  });
}

function fill(team: Side, humans: readonly NetPlayer[], size: number, picked: ReadonlySet<string>, shuffle?: () => number): DescentSlot[] {
  const used = new Set(humans.map((p) => p.god));
  const free = GODS.map((g) => g.id).filter((id) => !used.has(id));
  if (shuffle) free.sort(() => shuffle() - 0.5);
  // gods nobody picked go to the bots first, so a match shows as many different gods as it can
  free.sort((a, b) => Number(picked.has(a)) - Number(picked.has(b)));
  const slots: DescentSlot[] = humans.map((p) => ({ god: p.god, player: p.id, team }));
  for (let k = 0; slots.length < size; k++) slots.push({ god: free[k % free.length]!, player: null, team });
  return slots;
}
