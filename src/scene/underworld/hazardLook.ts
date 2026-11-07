import * as THREE from 'three/webgpu';
import { uniform } from '../../render/tsl';

/**
 * What the underworld's ground shows of the current chamber's dangers (see
 * src/sim/DescentHazards.ts), set each frame by DescentView and read by the
 * terrain material. All uniforms, so a danger coming or going builds no
 * shader.
 */

/** The terrain mask's green channel holds ChamberDef.brink, 0 to this many meters. */
export const BRINK_SCALE = 12;

/** The forge's vents: x, z, how hot (0 cold, 1 about to blow) and the flash of a blast (1 just blown). Unused slots sit far away. */
export const ventLook = Array.from({ length: 6 }, () => uniform(new THREE.Vector4(1e4, 1e4, 0, 0)));

/** Slag puddles: x, z, radius (0 unused) and how hot (1 just landed, 0 cold). */
export const slagLook = Array.from({ length: 5 }, () => uniform(new THREE.Vector4(1e4, 1e4, 0, 0)));

/** The Abyss's crumbling patches: x, z, radius (0 unused), and 0 to 1 while it cracks, then 1 plus how far (m) it has dropped. */
export const gapLook = Array.from({ length: 3 }, () => uniform(new THREE.Vector4(1e4, 1e4, 0, 0)));

/** How far (m) the Drowned Halls' flood reaches in from the water's edge (0 at low water). */
export const floodReach = uniform(0);

/** How far (m) the Abyss's dark has crept in from the void (0 none). */
export const darkReach = uniform(0);

/** Every slot back to nothing (a new chamber, or a depth without these dangers). */
export function clearHazardLook(): void {
  for (const u of [...ventLook, ...slagLook, ...gapLook]) u.value.set(1e4, 1e4, 0, 0);
  floodReach.value = 0;
  darkReach.value = 0;
}
