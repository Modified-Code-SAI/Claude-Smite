/**
 * How big a cloth panel's uv space is in meters, so its embroidery can be sized
 * in meters rather than as a fraction of the panel. Without it a 9-key border
 * was a fine band on a narrow loincloth and huge, stretched keys around a robe.
 */
export interface ClothScale {
  /** Meters per uv.x unit, measured near the hem (v.y close to 1), where the border runs. */
  across: number;
  /** Meters per uv.y unit. */
  down: number;
}

/**
 * Measures a panel from its rest positions and uvs: each triangle's uv-to-position
 * Jacobian gives meters per uv unit along x and y; the median keeps the wrap seam
 * of a skirt (where uv.x jumps from 1 back to 0) from skewing it. Null when the
 * uvs don't open into a panel (shells cut from the body share one uv point).
 */
export function clothScale(pos: ArrayLike<number>, uv: ArrayLike<number>, index: ArrayLike<number> | null, count: number): ClothScale | null {
  const tris = index ? index.length / 3 : count / 3;
  const across: number[] = [];
  const hem: number[] = [];
  const down: number[] = [];
  for (let t = 0; t < tris; t++) {
    const a = index ? index[t * 3]! : t * 3;
    const b = index ? index[t * 3 + 1]! : t * 3 + 1;
    const c = index ? index[t * 3 + 2]! : t * 3 + 2;
    const du1 = uv[b * 2]! - uv[a * 2]!, dv1 = uv[b * 2 + 1]! - uv[a * 2 + 1]!;
    const du2 = uv[c * 2]! - uv[a * 2]!, dv2 = uv[c * 2 + 1]! - uv[a * 2 + 1]!;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-9) continue;
    let ux = 0, vx = 0;
    for (let k = 0; k < 3; k++) {
      const e1 = pos[b * 3 + k]! - pos[a * 3 + k]!;
      const e2 = pos[c * 3 + k]! - pos[a * 3 + k]!;
      const pu = (e1 * dv2 - e2 * dv1) / det;
      const pv = (e2 * du1 - e1 * du2) / det;
      ux += pu * pu;
      vx += pv * pv;
    }
    const meanV = (uv[a * 2 + 1]! + uv[b * 2 + 1]! + uv[c * 2 + 1]!) / 3;
    across.push(Math.sqrt(ux));
    if (meanV > 0.8) hem.push(Math.sqrt(ux));
    down.push(Math.sqrt(vx));
  }
  if (down.length < 2) return null;
  return { across: median(hem.length >= 2 ? hem : across), down: median(down) };
}

function median(x: number[]): number {
  const s = [...x].sort((p, q) => p - q);
  return s[s.length >> 1]!;
}

/** Cloth vertices carry their scale in the spare color z and w, as meters over this (the cloth shader multiplies back). */
export const CLOTH_SCALE_RANGE = 4;

/** Writes a panel's scale into its color attribute's z and w (normalized attributes are handled by three). */
export function writeClothScale(color: { count: number; setZ(i: number, v: number): unknown; setW(i: number, v: number): unknown }, s: ClothScale): void {
  const z = Math.min(1, s.across / CLOTH_SCALE_RANGE);
  const w = Math.min(1, s.down / CLOTH_SCALE_RANGE);
  for (let i = 0; i < color.count; i++) {
    color.setZ(i, z);
    color.setW(i, w);
  }
}
