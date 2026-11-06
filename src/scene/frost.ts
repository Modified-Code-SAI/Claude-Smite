import * as THREE from 'three/webgpu';
import { clamp, float, mix, normalWorld, smoothstep, uniform, vec3 } from '../render/tsl';

/**
 * How far the Jötunn's winter has frosted the world over, 0 to 1. It is 0
 * in every other mode, where the surfaces that read it come out exactly as
 * they were (mix by 0), and only its value ever changes, so no shader is
 * built as it does.
 */
export const frost = uniform(0);

/** Rime's albedo: a cool off-white, kept below the marble's so a frosted plaza never blows out in the sun. */
const RIME = vec3(0.7, 0.76, 0.84);

/**
 * A surface's color with the frost on it. It settles on what faces up
 * (`up`, 1 for flat ground) and spreads as `frost` grows, over the places
 * whose `grain` is below it: a value spread evenly over 0 to 1 (a noise, the
 * surface's own texture, a per-instance random), so `frost` is roughly the
 * share covered and the first frost comes in patches. At most `most` of the
 * surface's color turns.
 */
export function frosted(col: any, grain: any, up: any = normalWorld.y, most = 0.85): any {
  const face = smoothstep(0.35, 0.9, up);
  // (frost 0 gives exactly 0 for any grain at or above 0)
  const spread = clamp(frost.mul(1.25).sub(grain).mul(5), 0, 1);
  return mix(col, RIME, face.mul(spread).mul(float(most)));
}

/** The snow's level at its heaviest in a fight (see WINTER), past which only a giant's win takes it. */
const FIGHT_TOP = 0.92;

/**
 * Frost from the snow's level, as the share of the ground it covers: none
 * while the giant wakes, a dusting in the fight's first snow, patches once it
 * has frozen a brazier, a third at two, and never more than half while the
 * fight goes on, so the ground's warnings stay easy to read. Only a giant's
 * win, taking the snow past the fight's heaviest, whitens all of it.
 */
export function frostFor(snow: number): number {
  if (snow > FIGHT_TOP) return Math.min(1, 0.5 + (0.5 * (snow - FIGHT_TOP)) / (1 - FIGHT_TOP));
  const k = Math.max(0, (snow - 0.22) / (FIGHT_TOP - 0.22));
  return 0.5 * k ** 1.1;
}

/**
 * Where the Jötunn's feet press the grass flat: each foot's place (xyz) and
 * how wide it parts the blades (w, meters; 0 while the foot is lifted, and
 * in every other mode). JotunnView sets them each frame; the grass reads them.
 */
export const giantFeet = [uniform(new THREE.Vector4(0, -100, 0, 0)), uniform(new THREE.Vector4(0, -100, 0, 0))];
