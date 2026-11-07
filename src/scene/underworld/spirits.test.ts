import { describe, expect, it } from 'vitest';
import { CHAMBERS } from '../../map/UnderworldLayout';
import { fitOval } from './spirits';

describe('the spirits over the underworld chambers', () => {
  it('fly ovals that stay over each chamber, clear of its walls', () => {
    for (const c of CHAMBERS) {
      const [rx, rz] = fitOval(c);
      // wide enough to read as circling the hall, not hovering in one spot
      expect(Math.min(rx, rz), c.name).toBeGreaterThan(5);
      for (let k = 0; k < 120; k++) {
        const a = (k / 120) * Math.PI * 2;
        // each flies between half and all of the oval (see Spirits)
        for (const reach of [0.5, 0.75, 1]) {
          const x = Math.cos(a) * rx * reach;
          const z = Math.sin(a) * rz * reach;
          // (over the floor, or its lava, water or void: anywhere in the cavern, clear of the rock)
          expect(c.cave(x, z), `${c.name} at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBeGreaterThan(0.5);
        }
      }
    }
  });
});
