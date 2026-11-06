import { describe, expect, it } from 'vitest';
import { CHAMBERS, chamberField } from '../../map/UnderworldLayout';
import { mistInside } from './mist';

describe('the ground mist in the underworld chambers', () => {
  it('lies over the open floor and thins out to nothing before the walls and the pit', () => {
    for (const c of CHAMBERS) {
      for (let x = -c.extent - 1; x <= c.extent + 1; x += 0.5) {
        for (let z = -c.extent - 1; z <= c.extent + 1; z += 0.5) {
          const f = chamberField(c, x, z);
          const m = mistInside(c, x, z);
          const where = `${c.name} at ${x}, ${z}`;
          expect(m, where).toBeGreaterThanOrEqual(0);
          expect(m, where).toBeLessThanOrEqual(1);
          // gone by the time the stone starts to rise (or the pit falls away)
          if (f < 0.6) expect(m, where).toBe(0);
          if (f > 2.6) expect(m, where).toBe(1);
        }
      }
    }
  });

  it('covers most of every floor', () => {
    for (const c of CHAMBERS) {
      let floor = 0;
      let misty = 0;
      for (let x = -c.extent; x <= c.extent; x += 1) {
        for (let z = -c.extent; z <= c.extent; z += 1) {
          if (chamberField(c, x, z) < 0) continue;
          floor++;
          if (mistInside(c, x, z) > 0.5) misty++;
        }
      }
      expect(misty / floor, c.name).toBeGreaterThan(0.7);
    }
  });
});
