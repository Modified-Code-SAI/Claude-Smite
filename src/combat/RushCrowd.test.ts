import { describe, expect, it } from 'vitest';
import { RUSH, type Rush } from '../sim/Rush';
import type { Unit } from '../sim/Unit';
import { CROWD, RushCrowd } from './RushCrowd';

const flat = () => 0;

/** Just the parts of a Rush match the crowd watches. */
function match(): Rush {
  return {
    relic: { phase: 'center', holder: null, thrower: null, x: 0, z: 0 },
    beats: { fumble: 0, steal: 0, catch: 0, kickoff: 0, shrug: 0 },
    lastBeat: null,
    lastGoal: null,
    overtime: false,
    winner: null,
    phase: 'play',
  } as unknown as Rush;
}

const run = (crowd: RushCrowd, rush: Rush, seconds: number) => {
  for (let i = 0; i < seconds * 60; i++) crowd.frame(rush, 1 / 60);
};

describe('RushCrowd', () => {
  it('stands a few hundred spirits round the outside of the pitch, clear of the lanes and the halfway line', () => {
    const crowd = new RushCrowd(flat, 'order', { ally: 0x4fb2ff, foe: 0xff3524 });
    expect(crowd.count).toBeGreaterThan(250);
    expect(crowd.count).toBeLessThan(600);
    const feet = crowd.mesh.geometry.getAttribute('feet');
    for (let i = 0; i < feet.count; i += 37) {
      const x = feet.getX(i);
      const z = feet.getZ(i);
      expect(Math.hypot(x, z)).toBeGreaterThan(RUSH.pitchRadius + 1.5);
      expect(Math.abs(x)).toBeGreaterThanOrEqual(CROWD.laneGap);
      expect(Math.abs(z)).toBeGreaterThanOrEqual(CROWD.halfGap);
    }
    // WebGPU allows 8 vertex buffers; one draw, no shadow
    expect(Object.keys(crowd.mesh.geometry.attributes).length).toBeLessThanOrEqual(8);
    expect(crowd.mesh.castShadow).toBe(false);
  });

  it("puts each end on its feet for its team's goal, and lifts it for a run at the other gate", () => {
    const crowd = new RushCrowd(flat, 'order', { ally: 0x4fb2ff, foe: 0xff3524 });
    const rush = match() as unknown as { phase: string; lastGoal: unknown; relic: Record<string, unknown> };
    run(crowd, rush as unknown as Rush, 1);
    expect(crowd.excitement('order')).toBeLessThan(0.15);
    const scorer = { team: 'order' } as Unit;
    rush.phase = 'goal';
    rush.lastGoal = { team: 'order', scorer };
    run(crowd, rush as unknown as Rush, 1);
    expect(crowd.excitement('order')).toBeGreaterThan(0.9);
    expect(crowd.excitement('chaos')).toBeLessThan(0.05);
    // it settles after the goal, then Chaos carries the relic up to Order's gate
    rush.phase = 'play';
    run(crowd, rush as unknown as Rush, 4);
    expect(crowd.excitement('order')).toBeLessThan(0.2);
    const runner = { team: 'chaos' } as Unit;
    const gate = RUSH.gates.order;
    Object.assign(rush.relic, { phase: 'held', holder: runner, x: gate.x, z: gate.z - 3 });
    run(crowd, rush as unknown as Rush, 1);
    expect(crowd.excitement('chaos')).toBeGreaterThan(0.45);
    expect(crowd.excitement('order')).toBeLessThan(0.2);
  });
});
