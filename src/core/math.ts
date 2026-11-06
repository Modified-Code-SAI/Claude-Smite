/**
 * Length of the vector (x, z). Use it instead of Math.hypot in anything that
 * runs every frame: V8 doesn't inline Math.hypot, so each call is a builtin
 * call that boxes its result on the heap (about 18x slower, and garbage).
 */
export function hypot(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

/** The angle `from` turned `w` (0 to 1) of the way toward `to`, the short way round (radians). */
export function turnToward(from: number, to: number, w: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return from + d * w;
}
