import { describe, expect, it } from 'vitest';
import { CollisionWorld } from './Collision';

describe('camera blockers', () => {
  const world = () => {
    const w = new CollisionWorld(() => 0);
    w.addCameraBlocker({ kind: 'box', x: 0, z: 0, hx: 2.8, hz: 2.8, yaw: 0, top: Infinity });
    return w;
  };

  it('stop the camera ray but not movement', () => {
    const w = world();
    // ray from 6 m out toward the box: stops before its face (2.8 + probe radius)
    expect(w.raycast(6, 3, 0, -1, 0, 0, 8, 0.35)).toBeLessThan(3);
    expect(w.resolve(0, 0, 0.5, 0)).toEqual({ x: 0, z: 0 });
  });

  it('are ignored when the ray starts inside them', () => {
    expect(world().raycast(1, 3, 0, 1, 0, 0, 7)).toBe(7);
  });

  it('stop nothing above their top', () => {
    const w = new CollisionWorld(() => 0);
    w.addCameraBlocker({ kind: 'circle', x: 0, z: 0, r: 2, top: 1.2 });
    expect(w.raycast(6, 3, 0, -1, 0, 0, 8)).toBe(8);
  });
});

describe('the camera probe', () => {
  // a column 0.6 m across, standing 0.6 m to the side of where an 8 m ray ends
  const world = () => {
    const w = new CollisionWorld(() => 0);
    w.addCircle(7.5, 1.2, 0.6);
    return w;
  };

  it('keeps the camera clear of a column beside it, widening toward the far end', () => {
    expect(world().raycast(0, 3, 0, 1, 0, 0, 8, 0.35)).toBe(8);
    expect(world().raycast(0, 3, 0, 1, 0, 0, 8, 0.35, true, 0.8)).toBeLessThan(7.5);
  });

  it('still lets its god brush right past one', () => {
    const w = new CollisionWorld(() => 0);
    // the god's middle 0.5 m from a column's face: the ray starts thin, so it isn't stopped at once
    w.addCircle(0, 1.1, 0.6);
    expect(w.raycast(0, 3, 0, 1, 0, 0, 8, 0.35, true, 0.8)).toBe(8);
  });
});
