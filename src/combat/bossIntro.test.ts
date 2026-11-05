import { describe, expect, it } from 'vitest';
import { BOSS_FALL, BOSS_INTRO, fallDistance, fallOrbit, fallShot, introDistance, introShot, introSpot } from './bossIntro';

const boss = { x: 0, z: 0, ground: 2, height: 5 };
const shot = () => ({ pos: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: 0 }, weight: 0 });

describe('a boss entrance on camera', () => {
  it('stands in front of the boss toward the team, turned to one side, on open floor', () => {
    const open = () => 99;
    const p = introSpot(boss, { x: 0, z: 20 }, open, 8);
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(8, 5);
    // toward the team (+z), a three-quarter view
    expect(p.z).toBeGreaterThan(0);
    expect(Math.abs(Math.atan2(p.x, p.z))).toBeCloseTo(BOSS_INTRO.side, 5);
  });

  it('steps round a column, or in from a wall, rather than stand inside it', () => {
    // a column where the preferred spot would be
    const want = introSpot(boss, { x: 0, z: 20 }, () => 99, 8);
    const column = (x: number, z: number) => Math.hypot(x - want.x, z - want.z) - 1.5;
    const p = introSpot(boss, { x: 0, z: 20 }, column, 8);
    expect(column(p.x, p.z)).toBeGreaterThanOrEqual(BOSS_INTRO.clearance);
    // a wall 6 m in front of the boss: the camera comes in nearer
    const wall = (_x: number, z: number) => 6 - z;
    const q = introSpot(boss, { x: 0, z: 20 }, wall, 8);
    expect(wall(q.x, q.z)).toBeGreaterThanOrEqual(BOSS_INTRO.clearance);
    expect(Math.hypot(q.x, q.z)).toBeLessThan(8);
  });

  it('eases in, holds low and looking up at the boss while pushing in, and hands the camera back', () => {
    const total = 2.6;
    const spot = { x: 0, z: 8 };
    expect(introShot(0, total, boss, spot, shot()).weight).toBe(0);
    const mid = introShot(total / 2, total, boss, spot, shot());
    expect(mid.weight).toBe(1);
    expect(mid.pos.y).toBeLessThan(mid.look.y);
    expect(mid.look.y).toBeCloseTo(boss.ground + boss.height * BOSS_INTRO.look, 5);
    const early = introShot(0.6, total, boss, spot, shot());
    const late = introShot(2.0, total, boss, spot, shot());
    expect(Math.hypot(late.pos.x, late.pos.z)).toBeLessThan(Math.hypot(early.pos.x, early.pos.z));
    expect(introShot(total - 0.1, total, boss, spot, shot()).weight).toBeLessThan(0.1);
    expect(introShot(total, total, boss, spot, shot()).weight).toBe(0);
  });

  it('stands further back for a taller boss, within limits', () => {
    expect(introDistance(6)).toBeGreaterThan(introDistance(4));
    expect(introDistance(1)).toBe(BOSS_INTRO.near);
    expect(introDistance(40)).toBe(BOSS_INTRO.far);
  });
});

describe('a boss fall on camera', () => {
  const spot = { x: 0, z: 10 };

  it('stands back and higher than for the entrance, drifts round the boss and eases back, following it down', () => {
    const total = 2.4;
    expect(fallShot(0, total, boss, spot, BOSS_FALL.orbit, shot()).weight).toBe(0);
    const early = fallShot(0.6, total, boss, spot, BOSS_FALL.orbit, shot());
    const late = fallShot(1.6, total, boss, spot, BOSS_FALL.orbit, shot());
    expect(early.weight).toBe(1);
    expect(early.pos.y).toBeGreaterThan(introShot(1.3, 2.6, boss, spot, shot()).pos.y);
    // round the boss, a little further off, looking lower
    expect(Math.atan2(late.pos.x, late.pos.z)).toBeGreaterThan(Math.atan2(early.pos.x, early.pos.z));
    expect(Math.hypot(late.pos.x, late.pos.z)).toBeGreaterThan(Math.hypot(early.pos.x, early.pos.z));
    expect(late.look.y).toBeLessThan(early.look.y);
    expect(fallShot(total, total, boss, spot, BOSS_FALL.orbit, shot()).weight).toBe(0);
  });

  it('drifts the way that stays clear of walls, or holds still when neither does', () => {
    expect(fallOrbit(boss, spot, () => 99)).toBe(BOSS_FALL.orbit);
    // a wall on the +x side: drift the other way
    const east = (x: number) => 3 - x;
    expect(fallOrbit(boss, spot, east)).toBe(-BOSS_FALL.orbit);
    // boxed in on both sides
    expect(fallOrbit(boss, spot, (x) => 1 - Math.abs(x))).toBe(0);
  });

  it('stands further back than for the entrance', () => {
    expect(fallDistance(5)).toBeGreaterThan(introDistance(5));
    expect(fallDistance(1)).toBe(BOSS_FALL.near);
    expect(fallDistance(40)).toBe(BOSS_FALL.far);
  });
});
