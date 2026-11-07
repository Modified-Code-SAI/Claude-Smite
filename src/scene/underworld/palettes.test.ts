import { describe, expect, it } from 'vitest';
import { CLEAR_WAVE, clearFlare, DEPTH_COLORS } from './palettes';

describe("each depth's light", () => {
  it("throws its floor's glow back up in its own color, softly", () => {
    const colors = new Set<number>();
    for (const c of Object.values(DEPTH_COLORS)) {
      expect(c.bounce.intensity).toBeGreaterThan(0);
      expect(c.bounce.intensity).toBeLessThanOrEqual(1);
      colors.add(c.bounce.color);
    }
    expect(colors.size).toBe(Object.keys(DEPTH_COLORS).length);
  });

  it('flares that glow as a cleared chamber exhales, swelling fast and dying away behind the wave', () => {
    expect(clearFlare(-1)).toBe(0);
    expect(clearFlare(0)).toBe(0);
    const peak = clearFlare(0.25);
    expect(peak).toBeGreaterThan(1);
    expect(clearFlare(0.1)).toBeLessThan(peak);
    expect(clearFlare(1)).toBeLessThan(peak);
    expect(clearFlare(2)).toBeLessThan(clearFlare(1));
    expect(clearFlare(CLEAR_WAVE.time - 0.01)).toBeLessThan(0.1);
    expect(clearFlare(CLEAR_WAVE.time + 0.01)).toBe(0);
  });
});
