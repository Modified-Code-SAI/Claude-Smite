import { describe, expect, it } from 'vitest';
import type { Forced } from '../sim/Unit';
import { THROWN_LEAN, thrownLean } from './UnitViews';

const out = { pitch: 0, roll: 0 };
/** A knockback `along` (vx, vz) at `p` of the way through, as the sim makes one (collide: walls stop it). */
const throwAt = (vx: number, vz: number, p: number, arc = 1.5, collide = true): Forced => ({ vx, vz, remaining: 0.4 * (1 - p), total: 0.4, arc, collide });

describe('a god thrown through the air', () => {
  it('leans the way it flies, most at the top of the arc', () => {
    // facing -z (yaw 0) and thrown back along +z: its top tips back
    const top = thrownLean(throwAt(0, 16, 0.5), 0, out);
    expect(top.pitch).toBeCloseTo(-THROWN_LEAN);
    expect(Math.abs(top.roll)).toBeLessThan(1e-9);
    const early = thrownLean(throwAt(0, 16, 0.15), 0, { pitch: 0, roll: 0 });
    expect(early.pitch).toBeLessThan(0);
    expect(early.pitch).toBeGreaterThan(-THROWN_LEAN);
  });

  it('is upright again as its feet touch down', () => {
    expect(Math.abs(thrownLean(throwAt(0, 16, 0.97), 0, out).pitch)).toBeLessThan(0.03);
    expect(thrownLean(throwAt(0, 16, 1), 0, out).pitch).toBeCloseTo(0);
  });

  it('thrown to its right side, tips its top to the right', () => {
    // yaw 0: right is +x
    const side = thrownLean(throwAt(16, 0, 0.5), 0, out);
    expect(side.roll).toBeCloseTo(THROWN_LEAN);
    expect(Math.abs(side.pitch)).toBeLessThan(1e-9);
  });

  it('thrown straight up, rocks back', () => {
    expect(thrownLean(throwAt(0, 0, 0.5, 2.6), 0, out).pitch).toBeLessThan(0);
  });

  it("stays upright for a leap, a pull or a ground dash, and leans less for another mode's lower knockback", () => {
    for (const f of [throwAt(0, 16, 0.5, 1.5, false), throwAt(0, 16, 0.5, 0.3), throwAt(0, 16, 0.5, 0), null]) {
      const l = thrownLean(f, 0, out);
      expect([l.pitch, l.roll]).toEqual([0, 0]);
    }
    expect(thrownLean(throwAt(0, 16, 0.5, 0.6), 0, out).pitch).toBeCloseTo(-THROWN_LEAN * 0.4);
  });
});
