import { describe, expect, it } from 'vitest';
import { thor } from '../game/gods';
import { jotunn } from '../game/gods/jotunn';
import type { CameraShot } from '../player/ThirdPersonCamera';
import { godUnit } from '../sim/factory';
import { DEATH_CAM, deathCamSpot, JotunnDeathCam, type DeathCamHost } from './jotunnDeathCam';

/** A flat field where `blocked` spots (behind the body, which stands at the origin facing a giant 30 m off) are in a wall. */
function host(blocked: (x: number, z: number, y: number) => boolean = () => false) {
  const shots: (CameraShot | null)[] = [];
  const wall = (x: number, z: number, y: number) => z < -1 && blocked(x, z, y);
  const h: DeathCamHost = {
    ground: () => 0,
    height: 16,
    clear: (ax, ay, az, bx, by, bz) => !wall(ax, az, ay) && !wall(bx, bz, by),
    set: (s) => shots.push(s && { ...s, pos: { ...s.pos }, look: { ...s.look } }),
  };
  return { h, shots };
}

describe('Jötunn death cam', () => {
  it('stands back from the body, away from the giant, and higher when that is blocked', () => {
    const { h } = host();
    const p = deathCamSpot({ x: 0, z: 0 }, { x: 0, z: 30 }, h)!;
    expect(p.x).toBeCloseTo(0, 5);
    expect(p.z).toBeCloseTo(-DEATH_CAM.dist, 5);
    expect(p.y).toBe(DEATH_CAM.up);
    // straight back is blocked: it swings round
    const side = deathCamSpot({ x: 0, z: 0 }, { x: 0, z: 30 }, host((x) => Math.abs(x) < 1).h)!;
    expect(Math.abs(side.x)).toBeGreaterThan(1);
    // nowhere at its own height: it cranes up
    const high = deathCamSpot({ x: 0, z: 0 }, { x: 0, z: 30 }, host((_x, _z, y) => y < DEATH_CAM.up + 1).h)!;
    expect(high.z).toBeCloseTo(-DEATH_CAM.dist, 5);
    expect(high.y).toBe(DEATH_CAM.up + DEATH_CAM.crane);
    expect(deathCamSpot({ x: 0, z: 0 }, { x: 0, z: 30 }, host(() => true).h)).toBeNull();
  });

  it('rises after the fall, watches the giant off center, and is back on the body before the god returns', () => {
    const { h, shots } = host();
    const cam = new JotunnDeathCam(h);
    const me = godUnit(thor, 'order', { x: 0, z: 0, yaw: 0 });
    const giant = godUnit(jotunn, 'chaos', { x: 0, z: 30, yaw: 0 });
    const scene = { me, giant, cine: false, off: false };
    const dt = 1 / 60;
    cam.frame(dt, scene);
    expect(shots).toEqual([]);
    me.combatant.slay(giant.combatant);
    me.combatant.respawnTimer = 7;
    let t = 0;
    const run = (s: number) => {
      for (let i = 0; i < s * 60; i++) {
        me.combatant.respawnTimer -= dt;
        t += dt;
        cam.frame(dt, scene);
      }
    };
    run(DEATH_CAM.wait - 0.05);
    expect(cam.weight).toBe(0);
    run(DEATH_CAM.rise + 0.2);
    expect(cam.weight).toBe(1);
    const last = shots.at(-1)!;
    expect(last.pos.z).toBeCloseTo(-DEATH_CAM.dist, 5);
    // it looks toward the giant, turned a little past it
    const turn = Math.atan2(last.look.x - last.pos.x, last.look.z - last.pos.z);
    expect(turn).toBeCloseTo(-DEATH_CAM.aside, 2);
    expect(last.look.y).toBeCloseTo(16 * DEATH_CAM.look, 3);
    // down again before the timer runs out
    run(7 - t - 0.3);
    expect(cam.weight).toBe(0);
    expect(shots.at(-1)).toBeNull();
    expect(t).toBeLessThan(7);
  });

  it('gives the camera up at once to the mode\'s own shot, and to the giant\'s camera', () => {
    const { h, shots } = host();
    const cam = new JotunnDeathCam(h);
    const me = godUnit(thor, 'order', { x: 0, z: 0, yaw: 0 });
    const giant = godUnit(jotunn, 'chaos', { x: 0, z: 30, yaw: 0 });
    me.combatant.slay(giant.combatant);
    me.combatant.respawnTimer = 7;
    for (let i = 0; i < 180; i++) cam.frame(1 / 60, { me, giant, cine: false, off: false });
    expect(cam.weight).toBe(1);
    const n = shots.length;
    // the round's camera shot takes over: nothing more from this one
    cam.frame(1 / 60, { me, giant, cine: true, off: false });
    expect(shots.length).toBe(n);
    expect(cam.weight).toBe(0);
    // with no shot of the mode's to take over, it hands the camera back
    for (let i = 0; i < 180; i++) cam.frame(1 / 60, { me, giant, cine: false, off: false });
    cam.frame(1 / 60, { me, giant, cine: false, off: true });
    expect(shots.at(-1)).toBeNull();
  });
});
