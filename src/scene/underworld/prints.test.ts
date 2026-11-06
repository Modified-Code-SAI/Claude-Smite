import { describe, expect, it } from 'vitest';
import { DepthTracks, TRACKS } from './prints';

const corners = (t: DepthTracks, slot: number) => {
  const pos = (t.mesh.geometry.getAttribute('position').array as Float32Array).subarray(slot * 12, slot * 12 + 12);
  return [0, 1, 2, 3].map((c) => ({ x: pos[c * 3]!, y: pos[c * 3 + 1]!, z: pos[c * 3 + 2]! }));
};

describe("the gods' tracks in the Descent's floors", () => {
  it('lays a boot-sized print on the floor, toes the way the god was heading, a little behind the ball of the foot', () => {
    const t = new DepthTracks((x) => 0.5 + x * 0.01);
    t.step(10, -4, 0, -1, false, 1.2);
    const c = corners(t, 0);
    const mid = { x: c.reduce((a, p) => a + p.x, 0) / 4, z: c.reduce((a, p) => a + p.z, 0) / 4 };
    expect(mid.x).toBeCloseTo(10, 5);
    expect(mid.z).toBeCloseTo(-4 + TRACKS.foot.behind * 1.2, 5);
    // back corners (0, 1) behind the front ones (2, 3), heading -z
    expect(c[2]!.z - c[0]!.z).toBeCloseTo(-TRACKS.foot.length * 1.2, 5);
    expect(Math.abs(c[1]!.x - c[0]!.x)).toBeCloseTo(TRACKS.foot.width * 1.2, 5);
    // each corner on the floor beneath it, raised a hair
    for (const p of c) expect(p.y).toBeCloseTo(0.5 + p.x * 0.01 + TRACKS.lift, 5);
  });

  it('makes room for new prints by reusing the oldest, and wipes them all for the next chamber', () => {
    const t = new DepthTracks(() => 0);
    for (let i = 0; i <= TRACKS.capacity; i++) t.step(i, 0, 1, 0, i % 2 === 1, 1);
    // the first slot now holds the newest print
    expect(corners(t, 0)[0]!.x).toBeGreaterThan(TRACKS.capacity - 1);
    t.clear();
    for (let s = 0; s < TRACKS.capacity; s++) for (const p of corners(t, s)) expect([p.x, p.y, p.z]).toEqual([0, 0, 0]);
    expect(TRACKS.fade).toBeLessThan(TRACKS.life);
  });
});
