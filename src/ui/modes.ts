import type { NetHostOption } from '../net/roster';

export type GameMode = 'conquest' | 'arena' | 'clash' | 'siege' | 'duel' | 'rush' | 'descent' | 'jotunn';

/** The map a mode is played on. */
export function mapOf(mode: GameMode): 'conquest' | 'arena' | 'underworld' {
  return mode === 'conquest' ? 'conquest' : mode === 'descent' ? 'underworld' : 'arena';
}

/** A mode as the home page and the god pick screen show it. `net` lists the lobbies it can host online (none: single player only). */
export interface ModeInfo {
  id: GameMode;
  name: string;
  /** The short line under its name: format and the hook. */
  tag: string;
  /** How long a game runs. */
  time: string;
  /** The home page's paragraph. */
  text: string;
  /** A line of advice for the pick and loading screens. */
  tip: string;
  /** What the other side of the pick screen is when it isn't a team of gods. */
  foe?: { name: string; text: string };
  net?: NetHostOption[];
}

export const JOTUNN_TIP =
  'As a god, strike the glowing weak points: break both knees and the giant kneels, opening its crown. As the giant, every blow winds up first, so aim where the gods are going. Claim a shrine for a new ultimate.';

export const MODES: readonly ModeInfo[] = [
  {
    id: 'conquest',
    name: 'Conquest',
    tag: '5v5 · Three lanes',
    time: '15–20 min',
    text: 'The full war. Push three lanes with your minions, take the jungle and its bosses, break the towers and phoenixes, and destroy the enemy Titan to win.',
    tip: 'You start mid with four allied gods in the other lanes. Go wherever you like, and take the Treasure Wyrm with your team for gold-flecked power.',
    net: [
      { mode: 'coop', label: 'Host co-op', text: 'Friends together against bots', cap: 5 },
      { mode: 'versus', label: 'Host versus', text: 'Friends on both teams, bots fill in', cap: 10 },
    ],
  },
  {
    id: 'clash',
    name: 'Temple Clash',
    tag: '3v3 · King of the hill',
    time: '4 min',
    text: "Hold the temple plaza and take down gods. The temple's blessing doubles points now and then, and a Sun Relic rises on the flanks for whoever claims it first. First to 115.",
    tip: 'Everyone starts at level 8. Stand on the plaza with no enemy on it to score, and claim the Sun Relic when it rises on a flank.',
  },
  {
    id: 'rush',
    name: 'Relic Rush',
    tag: '3v3 · A sport of the gods',
    time: '5 min',
    text: 'Carry the Sun Relic through the enemy gate or pass it in. Stun the carrier to steal it. Nobody dies here; they get dazed. First to five goals.',
    tip: "The carrier is slower and can't fight, so pass to open teammates, juke a tackle with Space, and use stuns and knockbacks to break up their rushes.",
    net: [
      { mode: 'coop', label: 'Host co-op', text: 'Friends on one team against bots', cap: 3 },
      { mode: 'versus', label: 'Host versus', text: 'Friends on both teams, bots fill in', cap: 6 },
    ],
  },
  {
    id: 'descent',
    name: 'Underworld Descent',
    tag: 'Co-op · Fifteen chambers',
    time: '25 min',
    text: 'A dungeon run down fifteen chambers of the underworld, a boss every fifth. Vote on a reward after each chamber, learn new skills as you go, and raise fallen allies. Co-op, or team against team for the most souls.',
    tip: 'You start with one skill; a Forgotten Rite reward teaches you another. A fallen god stays down until an ally stands over them.',
    foe: { name: 'The Underworld', text: 'Fifteen chambers, a boss every fifth' },
    net: [
      { mode: 'coop', label: 'Host co-op', text: 'Up to four friends descend together; bots fill the team to three if you like', cap: 4, bots: true },
      { mode: 'versus', label: 'Host versus', text: 'Two teams of up to three race the same chambers for souls; each team picks bots or none', cap: 6, bots: true },
    ],
  },
  {
    id: 'jotunn',
    name: 'The Jötunn',
    tag: 'Four gods · One giant',
    time: '3 min a round',
    text: 'One frost giant against four gods. The giant wins a round by smashing three of the four braziers; the gods win by breaking it at its knees, wrists, back rune and crown. Shrines in the valley give the giant new ultimates.',
    tip: JOTUNN_TIP,
    foe: { name: 'The Jötunn', text: 'Frost Giant · smashes braziers' },
    net: [{ mode: 'coop', label: 'Host a hunt', text: 'Up to five friends take turns as the giant; bots fill the rest', cap: 5 }],
  },
  {
    id: 'siege',
    name: 'Temple Siege',
    tag: 'Co-op · Endless waves',
    time: 'Until you fall',
    text: 'You and two bot gods hold the temple against endless monster waves, with a boss every fifth. Pick a team boon after each wave. How long can you last?',
    tip: 'Monsters on the plaza corrupt it. Meet them at the gates, north and south, and pick a boon with Z, X or C after each wave.',
    foe: { name: 'The Horde', text: 'Endless waves, a boss every fifth' },
  },
  {
    id: 'duel',
    name: 'Temple Duel',
    tag: '1v1 · First to three',
    time: '2–3 min',
    text: 'One on one against a bot god. Win a round by taking them down; a ring of fire closes in so nobody can hide. The loser of each round picks a boon.',
    tip: 'Both gods start at level 9 and gain two levels every round. Stay inside the ring once it closes.',
  },
  {
    id: 'arena',
    name: 'Training Ground',
    tag: 'Practice · No clock',
    time: 'Any length',
    text: 'Training posts and one enemy Thor on the temple plaza. Swap gods and jump levels freely with K, and try every skill and tree.',
    tip: 'Swap gods and jump levels with K at the fountain.',
    foe: { name: 'Training posts', text: 'And an enemy Thor to the north' },
  },
];

export function modeInfo(id: string): ModeInfo {
  return MODES.find((m) => m.id === id) ?? MODES[0]!;
}

/** The home page's backdrop and card art for a mode (filmed in game, see tools/trailer). */
export function modeArt(id: string): string {
  return `${import.meta.env.BASE_URL}keyart/${id}.jpg`;
}

/** A small blurred copy of the art, for the god pick screen's backdrop. */
export function modeBlur(id: string): string {
  return `${import.meta.env.BASE_URL}keyart/${id}-blur.jpg`;
}

/** A small copy of the art for the home page's mode list. */
export function modeThumb(id: string): string {
  return `${import.meta.env.BASE_URL}keyart/${id}-thumb.jpg`;
}
