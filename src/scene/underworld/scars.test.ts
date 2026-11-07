import { describe, expect, it } from 'vitest';
import { DepthScars, SCARS, scarsFor } from './scars';

const vertex = (s: DepthScars, i: number) => {
  const pos = s.mesh.geometry.getAttribute('position').array as Float32Array;
  return { x: pos[i * 3]!, y: pos[i * 3 + 1]!, z: pos[i * 3 + 2]! };
};

describe("the big blows' marks in the Descent's floors", () => {
  it('marks a blast where it struck, a line along its length, a cone out in front; never a small one', () => {
    expect(scarsFor({ type: 'circle', x: 4, z: -2, radius: 3 })).toEqual([{ x: 4, z: -2, r: 3 }]);
    expect(scarsFor({ type: 'circle', x: 0, z: 0, radius: 40 })[0]!.r).toBe(SCARS.maxRadius);
    expect(scarsFor({ type: 'circle', x: 0, z: 0, radius: SCARS.minRadius - 0.1 })).toEqual([]);
    // yaw 0 heads -z
    const line = scarsFor({ type: 'line', x: 0, z: 0, yaw: 0, length: 12, width: 2 });
    expect(line.length).toBeGreaterThan(1);
    for (const m of line) {
      expect(m.x).toBeCloseTo(0, 5);
      expect(m.z).toBeLessThan(0);
      expect(m.z).toBeGreaterThan(-12);
    }
    expect(scarsFor({ type: 'line', x: 0, z: 0, yaw: 0, length: 12, width: 0.4 })).toEqual([]);
    const cone = scarsFor({ type: 'cone', x: 0, z: 0, yaw: Math.PI / 2, range: 8, angle: 100 });
    expect(cone).toHaveLength(1);
    expect(cone[0]!.x).toBeLessThan(0);
    expect(cone[0]!.r).toBeLessThanOrEqual(4);
  });

  it('lays a mark on a grid wide enough for its rim (or its rings), every vertex on the floor beneath it', () => {
    const dry = new DepthScars(() => 0);
    dry.mark(10, 6, 3);
    expect(vertex(dry, SCARS.grid * SCARS.grid - 1).x - vertex(dry, 0).x).toBeCloseTo(2 * SCARS.extent * 3, 5);
    const s = new DepthScars((x, z) => 0.5 + x * 0.02 - z * 0.01);
    s.mark(10, 6, 3, true);
    const g = SCARS.grid;
    const first = vertex(s, 0);
    const last = vertex(s, g * g - 1);
    expect(last.x - first.x).toBeCloseTo(2 * SCARS.ringsExtent * 3, 5);
    expect(last.z - first.z).toBeCloseTo(2 * SCARS.ringsExtent * 3, 5);
    // (the rings run out inside the square)
    expect(SCARS.rings.reach).toBeLessThan(SCARS.ringsExtent);
    expect((first.x + last.x) / 2).toBeCloseTo(10, 5);
    for (let i = 0; i < g * g; i++) {
      const p = vertex(s, i);
      expect(p.y).toBeCloseTo(0.5 + p.x * 0.02 - p.z * 0.01 + SCARS.lift, 5);
    }
  });

  it('makes room for new marks by reusing the oldest, and wipes them all for the next chamber', () => {
    const s = new DepthScars(() => 0);
    for (let i = 0; i <= SCARS.capacity; i++) s.mark(i * 20, 0, 2);
    // the first slot now holds the newest mark
    expect(vertex(s, 0).x).toBeGreaterThan(SCARS.capacity * 20 - 10);
    s.clear();
    const n = SCARS.capacity * SCARS.grid * SCARS.grid;
    for (let i = 0; i < n; i++) expect(vertex(s, i)).toEqual({ x: 0, y: 0, z: 0 });
    expect(SCARS.fade).toBeLessThan(SCARS.life);
  });
});
