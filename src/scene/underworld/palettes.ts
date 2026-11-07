import * as THREE from 'three/webgpu';
import { uniform } from '../../render/tsl';
import type { Palette } from '../../map/UnderworldLayout';

/** The colors of one depth of the underworld: its fire, the glow in its rock, and its air. */
export interface DepthColors {
  /** Brazier flames: base, tip, embers, and the light they cast. */
  fire: { low: number; high: number; ember: number; light: number; scale: number };
  /** Cracks in the walls, rune rings in the floor, the coals and the open gate. */
  glow: number;
  /** Far haze, the sky's glow at the horizon, and the light from above (cold in all but the forge). */
  fog: number;
  horizon: number;
  key: number;
  /** The depth's glow thrown back up off its floor, onto the undersides of the gods, the beasts and every overhang. */
  bounce: { color: number; intensity: number };
  /** How the air hangs: the haze's density at the floor, how fast it thins with height (per m), and how far off it begins (m). */
  air: { density: number; falloff: number; start: number };
  /** The motes in the air: their color, glow of their own (0 lit only by the light behind them), rise (m/s) and size. */
  motes: { color: number; glow: number; rise: number; grow: number; near: number };
}

export const DEPTH_COLORS: Record<Palette, DepthColors> = {
  // the Ashen Depths: embers and lava
  ember: {
    fire: { low: 0xff3a08, high: 0xffc46a, ember: 0xff8a2a, light: 0xff8a3c, scale: 1.4 },
    glow: 0xff5a14,
    fog: 0x3a1c10,
    horizon: 0x5a1808,
    // the light from above comes down through the forges' smoke, dull and warm
    key: 0xd4b8b0,
    // the lava's glow, up under chins, arms and ledges
    bounce: { color: 0xff5a1c, intensity: 0.6 },
    // smoke filling the hall to the roof
    air: { density: 0.018, falloff: 0.035, start: 12 },
    // embers off the forges, drifting up
    motes: { color: 0xff6a20, glow: 0.9, rise: 0.45, grow: 1.7, near: 6 },
  },
  // the Drowned Halls: cold blue soul fire
  soul: {
    fire: { low: 0x0a48ff, high: 0x9fe8ff, ember: 0x4ab8ff, light: 0x4aa0ff, scale: 1 },
    glow: 0x2a90ff,
    fog: 0x1a2c46,
    horizon: 0x0a2a5a,
    key: 0xa8d0ff,
    // the soul-light off the wet stone
    bounce: { color: 0x2a86ff, intensity: 0.5 },
    // a cold mist lying low over the floor, the far end of the hall lost in it
    air: { density: 0.036, falloff: 0.3, start: 6 },
    // pale soul-light motes sinking slowly through the damp air
    motes: { color: 0x9fd8ff, glow: 0.45, rise: -0.12, grow: 1.25, near: 4 },
  },
  // the Abyss: green spirit fire
  spirit: {
    fire: { low: 0x14d04a, high: 0xd4ffb0, ember: 0x6aff8a, light: 0x5aff86, scale: 1 },
    glow: 0x3aff7a,
    fog: 0x040a07,
    horizon: 0x0c3a22,
    key: 0xc0ffd8,
    // the spirit light in the glass
    bounce: { color: 0x2aff74, intensity: 0.5 },
    // darkness, swallowing the far walls
    air: { density: 0.022, falloff: 0.03, start: 9 },
    // spirit wisps rising out of the dark
    motes: { color: 0x7affa0, glow: 0.8, rise: 0.22, grow: 1.5, near: 5 },
  },
};

/**
 * The underworld's shared color uniforms: every material that glows in the
 * depth's color reads these, so moving down a depth is a few uniform writes
 * (no new shaders, no new lights).
 */
export const underworldGlow = uniform(new THREE.Color(DEPTH_COLORS.ember.glow));
/** How open the current chamber's exit gate is, 0 sealed to 1 open. */
export const gateOpen = uniform(0);

/** The wave of light a cleared chamber sends out across its floor: how fast it runs (m/s) and how long it lasts (s). */
export const CLEAR_WAVE = { speed: 24, time: 3.2, flare: 2.4 };

/**
 * How much brighter than its own the floor's bounce light shines `t` seconds
 * after a chamber is cleared (below 0, or once the wave has run out, none):
 * it swells in a quarter second as the wave sets off and dies away behind it.
 */
export function clearFlare(t: number): number {
  if (t < 0 || t > CLEAR_WAVE.time) return 0;
  return CLEAR_WAVE.flare * Math.min(1, t / 0.25) * Math.exp(-t * 1.3);
}
/**
 * The cleared chamber's wave, as (x, z where the last foe fell, seconds since,
 * on): the floor's veins, seams and cracks swell as it passes (see
 * UnderworldTerrain), so the chamber seems to exhale.
 */
export const clearWave = uniform(new THREE.Vector4(0, 0, 0, 0));

/**
 * The shown chamber's rune rings in the floor, as (center x, center z, radius,
 * glyph count); a radius of 0 turns a ring off. Only one chamber shows at a
 * time, so the floor draws its runes from these instead of from a texture.
 */
export const runeRings = [0, 1, 2].map(() => uniform(new THREE.Vector4(1e4, 1e4, 0, 8)));

/**
 * How much of each depth's own look the shared underworld materials show, as
 * (Ashen Depths, Drowned Halls, Abyss) weights: one is 1 and the others 0.
 * The floor and walls branch on these (uniform writes, no new shaders).
 */
export const depthLook = uniform(new THREE.Vector3(1, 0, 0));

/** The depthLook weights for a palette. */
export function depthWeights(p: Palette): [number, number, number] {
  return p === 'ember' ? [1, 0, 0] : p === 'soul' ? [0, 1, 0] : [0, 0, 1];
}

/** The white-hot heart of the current depth's fire (its fire's tip color), for the flame beds in its fire baskets. */
export const flameHot = uniform(new THREE.Color(0xffc46a));
