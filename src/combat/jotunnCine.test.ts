import { describe, expect, it } from 'vitest';
import type { CameraShot } from '../player/ThirdPersonCamera';
import { JOTUNN, type JotunnPhase } from '../sim/Jotunn';
import type { Unit } from '../sim/Unit';
import { CINE, CINE_CLEARANCE, CINE_CRANE, CINE_SUN, GIANT_FALL, GIANT_WAKE, JotunnCine, type CineHost } from './jotunnCine';

const H = 14;

/** A round's state as the shots read it, and a host that records what they do. */
function rig(room: CineHost['room'] = () => 99, sun?: { x: number; z: number }) {
  // the giant at its mark, facing +z (yaw π: forward is (-sin, -cos))
  const giant = { x: 0, z: -64, body: { yaw: Math.PI } } as unknown as Unit;
  const mode = { round: 0, phase: 'countdown' as JotunnPhase, timer: JOTUNN.countdown as number, lastRound: null as 'giant' | 'gods' | null, giant };
  const log = { shots: [] as (CameraShot | null)[], roars: 0, dips: [] as number[] };
  const host: CineHost = {
    height: H,
    ground: () => 0,
    room,
    sun,
    set: (s) => log.shots.push(s && { pos: { ...s.pos }, look: { ...s.look }, weight: s.weight }),
    roar: () => log.roars++,
    dip: (s) => log.dips.push(s),
  };
  const cine = new JotunnCine(mode, host);
  const run = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
      if (mode.phase === 'countdown' || mode.phase === 'over') mode.timer = Math.max(0, mode.timer - 1 / 60);
      cine.frame(1 / 60);
    }
  };
  return { mode, giant, log, cine, run, last: () => log.shots[log.shots.length - 1] };
}

describe('the Jötunn on camera', () => {
  it('cuts to the giant as a round starts: low in front, looking up, while it roars, then dips back to play', () => {
    const r = rig();
    r.mode.round = 1;
    r.run(0.5);
    expect(r.cine.kind).toBe('wake');
    const s = r.last()!;
    // in at once, not swept in from wherever the player stands
    expect(r.log.shots[0]!.weight).toBeGreaterThan(0.99);
    // in front of it (+z), a little to one side, far enough back to see all of it
    expect(s.pos.z).toBeGreaterThan(-64 + H);
    expect(Math.abs(s.pos.x)).toBeGreaterThan(1);
    expect(s.pos.y).toBeLessThan(s.look.y);
    expect(s.look.y).toBeCloseTo(H * GIANT_WAKE.look, 5);
    expect(r.log.roars).toBe(1);
    r.run(CINE.wake);
    expect(r.log.roars).toBe(1);
    // the dip comes just before the cut, which hands the camera back
    expect(r.log.dips).toEqual([CINE.dip]);
    expect(r.last()).toBeNull();
    expect(r.cine.kind).toBeNull();
    // and all within the countdown
    expect(CINE.wake).toBeLessThan(JOTUNN.countdown);
  });

  it('watches the giant fall side on when the gods win, and roar over the temple when it wins', () => {
    const r = rig();
    r.mode.round = 1;
    r.run(CINE.wake + 0.2);
    r.mode.phase = 'fight';
    r.run(0.5);
    expect(r.cine.kind).toBeNull();
    r.mode.phase = 'over';
    r.mode.timer = JOTUNN.pause;
    r.mode.lastRound = 'gods';
    r.run(0.5);
    expect(r.cine.kind).toBe('fall');
    const s = r.last()!;
    // well round to its side, so it topples across the frame
    const a = Math.abs(Math.atan2(s.pos.x - 0, s.pos.z - (-64 + H * 0.3)));
    expect(a).toBeGreaterThan(GIANT_FALL.side - GIANT_FALL.orbit - 0.05);
    expect(r.log.roars).toBe(1);
    r.run(CINE.fall);
    expect(r.cine.kind).toBeNull();
    expect(CINE.fall).toBeLessThan(JOTUNN.pause);

    // the next round wakes its giant again; this time the giant wins
    r.mode.round = 2;
    r.mode.phase = 'countdown';
    r.mode.timer = JOTUNN.countdown;
    r.run(0.3);
    expect(r.cine.kind).toBe('wake');
    r.run(CINE.wake);
    r.mode.phase = 'fight';
    r.run(0.2);
    r.mode.phase = 'over';
    r.mode.timer = JOTUNN.pause;
    r.mode.lastRound = 'giant';
    r.run(0.5);
    expect(r.cine.kind).toBe('triumph');
    expect(r.log.roars).toBe(3);
  });

  it('joins a shot part way for a guest who arrives late, or skips it near its end, and stops when the round moves on', () => {
    const late = rig();
    late.mode.round = 1;
    late.mode.timer = JOTUNN.countdown - 1.5;
    late.run(0.05);
    expect(late.cine.kind).toBe('wake');
    // well past the roar: not roared late
    expect(late.log.roars).toBe(0);
    late.mode.phase = 'fight';
    late.run(0.05);
    expect(late.cine.kind).toBeNull();
    expect(late.last()).toBeNull();

    const later = rig();
    later.mode.round = 1;
    later.mode.timer = JOTUNN.countdown - CINE.wake + 0.1;
    later.run(0.05);
    expect(later.cine.kind).toBeNull();
    expect(later.log.shots).toEqual([]);
  });

  it('stands clear of columns, and where nothing is in the way of the giant', () => {
    // a column where the preferred spot would be, and a wall cutting off the view from the other side
    const want = rig();
    want.mode.round = 1;
    want.run(0.1);
    const p = want.last()!.pos;
    const blocked = (x: number, z: number) => Math.min(Math.hypot(x - p.x, z - p.z) - 1, x > 0.5 === p.x > 0.5 ? 99 : -1);
    const r = rig((x, z) => blocked(x, z));
    r.mode.round = 1;
    r.run(0.1);
    const q = r.last()!.pos;
    expect(blocked(q.x, q.z)).toBeGreaterThanOrEqual(CINE_CLEARANCE);
  });

  it('rises over what is in the way when nowhere at its own height is clear', () => {
    // a wall of rocks round the giant, as high as the camera would stand
    const r = rig((_x, _z, y) => (y > H * GIANT_WAKE.eye + CINE_CRANE - 0.5 ? 99 : 0));
    r.mode.round = 1;
    r.run(0.1);
    expect(r.last()!.pos.y).toBeCloseTo(H * GIANT_WAKE.eye + CINE_CRANE, 5);
    // and stays at its own height where it can
    const open = rig();
    open.mode.round = 1;
    open.run(0.1);
    expect(open.last()!.pos.y).toBeCloseTo(Math.max(1.4, H * GIANT_WAKE.eye), 5);
  });

  it('never looks into the sun while another spot is clear', () => {
    // the sun low behind the giant, off to its left as the camera sees it: every spot on the wanted side looks into it
    const r = rig(undefined, { x: 0.5, z: -0.866 });
    r.mode.round = 1;
    r.run(0.1);
    const s = r.last()!;
    const dx = s.look.x - s.pos.x;
    const dz = s.look.z - s.pos.z;
    expect((dx * 0.5 - dz * 0.866) / Math.hypot(dx, dz)).toBeLessThan(CINE_SUN);
    // and with the sun behind the camera, the wanted side
    const fair = rig(undefined, { x: 0, z: 1 });
    fair.mode.round = 1;
    fair.run(0.1);
    expect(fair.last()!.pos.x).toBeLessThan(0);
  });
});
