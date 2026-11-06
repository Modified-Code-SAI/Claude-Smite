import { describe, expect, it } from 'vitest';
import { JOTUNN, SHRINES } from '../sim/Jotunn';
import { clearOfHud, WINS_CLEAR } from './JotunnMarks';
import { RADAR, radarPoint, radarSize } from './JotunnRadar';

const S = 176;
const inside = ([x, y]: [number, number]) => Math.hypot(x - S / 2, y - S / 2) <= S / 2 - 4 + 1e-6;

describe('Jötunn radar', () => {
  it('reaches the giant\'s lair, the gods\' fountain and every shrine', () => {
    const { order, chaos } = JOTUNN.bases;
    expect(inside(radarPoint(order.x, order.z + order.radius, S, 1))).toBe(true);
    expect(inside(radarPoint(chaos.x, chaos.z - chaos.radius, S, 1))).toBe(true);
    for (const s of SHRINES) expect(inside(radarPoint(s.x + Math.sign(s.x) * JOTUNN.shrineRadius, s.z, S, 1))).toBe(true);
    for (const b of JOTUNN.braziers) expect(inside(radarPoint(b.x, b.z, S, 1))).toBe(true);
    expect(RADAR.reach).toBeGreaterThan(50);
  });

  it('puts the other side at the top, whichever side you play', () => {
    const lair = JOTUNN.bases.chaos;
    const fountain = JOTUNN.bases.order;
    // a god sees the giant's lair at the top and the fountain at the bottom
    expect(radarPoint(lair.x, lair.z, S, 1)[1]).toBeLessThan(S * 0.2);
    expect(radarPoint(fountain.x, fountain.z, S, 1)[1]).toBeGreaterThan(S * 0.75);
    // the giant sees it the other way up, and east and west swap with it, as they do on screen
    expect(radarPoint(lair.x, lair.z, S, -1)[1]).toBeGreaterThan(S * 0.8);
    expect(radarPoint(40, 0, S, 1)[0]).toBeGreaterThan(S / 2);
    expect(radarPoint(40, 0, S, -1)[0]).toBeLessThan(S / 2);
  });

  it('is as big as its CSS says', () => {
    expect(radarSize(600)).toBe(120);
    expect(radarSize(1000)).toBe(150);
    expect(radarSize(2560)).toBe(176);
  });

  it('keeps objective marks out of its corner', () => {
    const W = 1600;
    const H = 900;
    const corner = radarSize(W) + 22;
    // in view under it: fades back
    expect(clearOfHud({ x: W - 60, y: 80, edge: false, angle: 0 }, W, H)).toBe(true);
    // pinned to the right edge: slides down below it and the wins under it
    const right = { x: W - 30, y: 70, edge: true, angle: -0.3 };
    expect(clearOfHud(right, W, H)).toBe(false);
    expect(right.y).toBe(corner + WINS_CLEAR);
    const lower = { x: W - 30, y: corner + WINS_CLEAR + 40, edge: true, angle: 0.2 };
    clearOfHud(lower, W, H);
    expect(lower.y).toBe(corner + WINS_CLEAR + 40);
    // pinned to the top edge: slides left of it
    const top = { x: W - 120, y: 30, edge: true, angle: -1.2 };
    clearOfHud(top, W, H);
    expect(top.x).toBe(W - corner);
    expect(top.y).toBe(30);
  });
});
