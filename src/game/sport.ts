import { node, stat, tree } from './gods/author';
import type { NodeEffect, SkillTree, SportKey } from './types';

const sport = (key: SportKey, perRank: number): NodeEffect => ({ type: 'sport', key, perRank });

/**
 * Relic Rush's fourth tree, open to every god in that mode only: the sport
 * playstyle. Its points buy speed, reach, longer and faster passes and harder
 * shoves instead of damage (and Bulldozer gives some damage back for push).
 * The rules read these numbers through `Combatant.sport` (src/sim/Rush.ts,
 * and the sim's knockbacks); in any other mode the tree isn't there.
 */
export const PLAYMAKER: SkillTree = tree('sport', 'Playmaker', 'Relic Rush only: speed, passing and shoves instead of damage', [
  node('stride', 'Fleet Foot', 1, 3, '+3% movement speed per rank.', stat('bonusMoveSpeed', 0.03)),
  node('arm', 'Long Arm', 1, 3, 'Your passes reach 1.5 m farther per rank.', sport('throwRange', 1.5)),
  node('hands', 'Sure Hands', 1, 3, 'You catch and pick up the relic from 0.25 m farther per rank.', sport('catchReach', 0.25)),
  node('bearer', "Bearer's Stride", 2, 1, 'Carrying the relic slows you half as much.', sport('carrierSpeed', 0.5)),
  node('rise', 'Quick to Rise', 2, 1, 'You stand up from a daze 1 s sooner.', sport('dazeCut', 1)),
  node('strip', 'Strip Tackle', 2, 1, 'A relic you knock loose pops toward you instead of away.', sport('strip', 1)),
  node('bullet', 'Bullet Pass', 3, 3, 'Your passes fly 10% faster per rank, so they are harder to cut off.', sport('throwSpeed', 0.1)),
  node('shove', 'Bulldozer', 3, 3, 'Your knockbacks throw 12% farther per rank, but you deal 5% less damage per rank.', sport('push', 0.12), stat('damageBonus', -0.05)),
  node('footing', 'Iron Footing', 3, 3, 'Knockbacks throw you 12% less far per rank.', sport('footing', 0.12)),
  node('captain', 'Captain', 4, 1, 'The first hit that would knock the relic loose each time you take it is shrugged off, and a teammate who catches your pass runs 30% faster for 2 s.', sport('captain', 1)),
]);

/** The keystone's catch burst. */
export const CAPTAIN_SPEED = { pct: 0.3, duration: 2 } as const;
