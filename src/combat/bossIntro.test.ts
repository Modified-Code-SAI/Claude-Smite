import { describe, expect, it } from 'vitest';
import { BOSS_INTRO, introDistance, introShot, introSpot } from './bossIntro';

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
