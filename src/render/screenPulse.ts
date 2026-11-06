import * as THREE from 'three/webgpu';
import { uniform } from './tsl';

/**
 * A brief glow in from the screen's edges, laid on in the grading pass (see
 * PostFX): the player's own ultimate going off, a kill landing. `amount` is
 * 0 at rest, so the pass costs the same with or without one.
 */
export const pulse = {
  color: uniform(new THREE.Color()),
  amount: uniform(0),
};

/** Seconds a pulse takes to reach its peak; it then fades over its length. */
const RISE = 0.06;
let peak = 0;
let start = -1;
let length = 0.5;

/**
 * Starts a pulse of `hex` at `strength` (0..1) lasting `seconds`; a weaker
 * one never cuts a stronger one short.
 */
export function screenPulse(hex: number, strength: number, seconds = 0.5, now = performance.now() / 1000): void {
  if (pulseAt(now) > strength) return;
  pulse.color.value.setHex(hex);
  peak = strength;
  start = now;
  length = seconds;
}

/** The pulse's strength at `now` (seconds). */
function pulseAt(now: number): number {
  if (start < 0) return 0;
  const k = now - start;
  if (k < RISE) return peak * (k / RISE);
  const f = 1 - (k - RISE) / length;
  return f > 0 ? peak * f * f : 0;
}

/** Sets the uniform for this frame (PostFX.render). */
export function updatePulse(now = performance.now() / 1000): void {
  const a = pulseAt(now);
  pulse.amount.value = a;
  if (a === 0) start = -1;
}
