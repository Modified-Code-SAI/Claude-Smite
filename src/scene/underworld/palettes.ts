import * as THREE from 'three/webgpu';
import { uniform } from '../../render/tsl';
import type { Palette } from '../../map/UnderworldLayout';

/** The colors of one depth of the underworld: its fire, the glow in its rock, and its air. */
export interface DepthColors {
  /** Brazier flames: base, tip, embers, and the light they cast. */
  fire: { low: number; high: number; ember: number; light: number };
  /** Cracks in the walls, rune rings in the floor, the coals and the open gate. */
  glow: number;
  /** Far haze, the sky's glow at the horizon, and the cold light from above. */
  fog: number;
  horizon: number;
  key: number;
}

export const DEPTH_COLORS: Record<Palette, DepthColors> = {
  // the Ashen Depths: embers and lava
  ember: {
    fire: { low: 0xff3a08, high: 0xffc46a, ember: 0xff8a2a, light: 0xff8a3c },
    glow: 0xff5a14,
    fog: 0x1a0c0a,
    horizon: 0x5a1808,
    key: 0xb8c4ff,
  },
  // the Drowned Halls: cold blue soul fire
  soul: {
    fire: { low: 0x0a48ff, high: 0x9fe8ff, ember: 0x4ab8ff, light: 0x4aa0ff },
    glow: 0x2a90ff,
    fog: 0x070d1a,
    horizon: 0x0a2a5a,
    key: 0xa8d0ff,
  },
  // the Abyss: green spirit fire
  spirit: {
    fire: { low: 0x14d04a, high: 0xd4ffb0, ember: 0x6aff8a, light: 0x5aff86 },
    glow: 0x3aff7a,
    fog: 0x07140e,
    horizon: 0x0c3a22,
    key: 0xc0ffd8,
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

/**
 * The shown chamber's rune rings in the floor, as (center x, center z, radius,
 * glyph count); a radius of 0 turns a ring off. Only one chamber shows at a
 * time, so the floor draws its runes from these instead of from a texture.
 */
export const runeRings = [0, 1, 2].map(() => uniform(new THREE.Vector4(1e4, 1e4, 0, 8)));
