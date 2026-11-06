import { describe, expect, it } from 'vitest';
import { CHAMBERS } from '../../map/UnderworldLayout';
import { MAX_SHAFTS, placeShafts, SHAFT_TILT } from './shafts';

describe('the light shafts in the underworld chambers', () => {
  it('fall in every chamber, spread apart and clear of walls, gates, pillars and the middle', () => {
    for (const c of CHAMBERS) {
      for (const [count, radius] of [[4, 1.5], [5, 1.7], [3, 1.05]] as const) {
        const at = placeShafts(c, count, radius);
        expect(at.length, c.name).toBeGreaterThanOrEqual(3);
        expect(at.length).toBeLessThanOrEqual(Math.min(count, MAX_SHAFTS));
        for (const [x, z, r] of at) {
          const where = `${c.name} at ${x.toFixed(1)}, ${z.toFixed(1)}`;
          expect(c.sd(x, z), where).toBeGreaterThan(r + 2);
          expect(Math.hypot(x, z), where).toBeGreaterThan((c.pit ?? 1.5) + r);
          expect(Math.abs(x) < 3.5 && Math.abs(z) > c.extent - 9, where).toBe(false);
          for (const [px, pz, pr] of c.pillars) {
            for (let h = 0; h <= 12; h += 1) expect(Math.hypot(x + SHAFT_TILT[0] * h - px, z + SHAFT_TILT[1] * h - pz), where).toBeGreaterThan(pr + r);
          }
        }
        for (let i = 0; i < at.length; i++) for (let j = 0; j < i; j++) expect(Math.hypot(at[i]![0] - at[j]![0], at[i]![1] - at[j]![1]), c.name).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('lean toward the light from above', () => {
    // the light is high on the -x, -z side of the sky, so the beams climb that way
    expect(SHAFT_TILT[0]).toBeLessThan(0);
    expect(SHAFT_TILT[1]).toBeLessThan(0);
    expect(Math.hypot(...SHAFT_TILT)).toBeCloseTo(Math.tan((16 * Math.PI) / 180), 3);
  });
});
