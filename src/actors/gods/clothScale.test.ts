import { describe, expect, it } from 'vitest';
import { clothScale } from './clothScale';

/** A rows x cols grid of rest points with uv 0..1, like a cloth sheet. */
function grid(rows: number, cols: number, at: (u: number, v: number) => [number, number, number]) {
  const pos: number[] = [];
  const uv: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1), v = r / (rows - 1);
      pos.push(...at(u, v));
      uv.push(u, v);
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      index.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
    }
  }
  return { pos, uv, index, count: rows * cols };
}

describe('clothScale', () => {
  it('measures a flat panel in meters per uv unit', () => {
    const g = grid(8, 6, (u, v) => [u * 0.4, -v * 1.2, 0]);
    const s = clothScale(g.pos, g.uv, g.index, g.count)!;
    expect(s.across).toBeCloseTo(0.4, 5);
    expect(s.down).toBeCloseTo(1.2, 5);
  });

  it('measures a flared skirt across its hem, not its waist', () => {
    // a cone: radius 0.2 at the waist (v = 0) flaring to 0.4 at the hem (v = 1)
    const g = grid(10, 33, (u, v) => {
      const r = 0.2 + 0.2 * v;
      return [Math.sin(u * 2 * Math.PI) * r, -v * 0.6, Math.cos(u * 2 * Math.PI) * r];
    });
    const s = clothScale(g.pos, g.uv, g.index, g.count)!;
    // circumference near the hem, about 2 pi 0.38
    expect(s.across).toBeGreaterThan(2.2);
    expect(s.across).toBeLessThan(2.55);
  });

  it('gives null for a shell whose uvs are one point', () => {
    const g = grid(4, 4, (u, v) => [u, v, 0]);
    g.uv.fill(0.5);
    expect(clothScale(g.pos, g.uv, g.index, g.count)).toBeNull();
  });
});
