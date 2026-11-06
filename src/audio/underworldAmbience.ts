/**
 * The Underworld Descent's sound, depth by depth: its theme, the beds that loop
 * under it and the sounds that stir in it now and then (GameAudio plays them).
 */

import type { Palette } from '../map/UnderworldLayout';
import type { SongName } from './music';

/** Each depth's theme between its bosses: the smith's war song, the drowned halls' slow one, the Abyss's own. */
export const DEPTH_SONG: Record<Palette, SongName> = { ember: 'forge', soul: 'drowned', spirit: 'abyss' };

/**
 * Each Descent depth's own air, over the cavern breath they all share: the
 * Ashen Depths' furnace, water running in the dark of the Drowned Halls, and
 * the Abyss's hollow wind. Every bed loops from the start and the shown
 * depth's fade up, so going down a depth is a crossfade.
 */
export const DEPTH_BEDS: readonly { depth: Palette; name: string; gain: number; pan?: number; rate?: number }[] = [
  { depth: 'ember', name: 'amb.forge', gain: 0.4, pan: -0.2 },
  { depth: 'ember', name: 'amb.forge', gain: 0.22, pan: 0.45, rate: 0.82 },
  { depth: 'soul', name: 'amb.stream', gain: 0.22, pan: 0.35 },
  { depth: 'soul', name: 'amb.stream', gain: 0.14, pan: -0.5, rate: 0.88 },
  { depth: 'spirit', name: 'amb.hollow', gain: 0.42 },
  { depth: 'spirit', name: 'amb.wind', gain: 0.2, pan: 0.5, rate: 0.42 },
];

/** Something that stirs every so often, somewhere around the team. */
export interface Stir {
  /** Seconds between them (min, max), the sounds to pick from, how far off (m) and how high they sound, and how loud. */
  every: [number, number];
  sounds: readonly string[];
  dist: [number, number];
  y: number;
  gain: number;
  ref: number;
}

/** What stirs at each depth: small sounds close by (hushed while the fighting is loud), and big ones far off. */
export const UNDERWORLD_LIFE: Record<Palette, { near: Stir; far: Stir }> = {
  // the Ashen Depths: steam venting from the hot rock, a smith's hammer somewhere below, the rock settling
  ember: {
    near: { every: [10, 22], sounds: ['amb.vent'], dist: [9, 22], y: 0.5, gain: 0.45, ref: 8 },
    far: { every: [9, 20], sounds: ['amb.anvil', 'amb.anvil', 'amb.groan'], dist: [28, 45], y: 4, gain: 0.7, ref: 20 },
  },
  // the Drowned Halls: water dripping into black pools all around, and a sunken bell tolling
  soul: {
    near: { every: [1.2, 4.5], sounds: ['amb.drip'], dist: [7, 24], y: 8, gain: 0.6, ref: 8 },
    far: { every: [20, 38], sounds: ['amb.toll', 'amb.toll', 'amb.souls'], dist: [32, 48], y: 6, gain: 0.9, ref: 24 },
  },
  // the Abyss: whispers in the dark, the souls' moan, and the rock groaning over the drop
  spirit: {
    near: { every: [9, 20], sounds: ['amb.whisper'], dist: [6, 14], y: 3, gain: 0.5, ref: 6 },
    far: { every: [14, 30], sounds: ['amb.souls', 'amb.souls', 'amb.groan'], dist: [30, 45], y: 10, gain: 0.65, ref: 20 },
  },
};
