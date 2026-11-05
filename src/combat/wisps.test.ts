import { describe, expect, it } from 'vitest';
import { WispSwarm, type WispHost } from './wisps';

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const host = (x: number, z: number, alive = true) => ({ x, z, body: { y: 0 }, alive });
const run = (s: WispSwarm, seconds: number, dt = 1 / 60, each?: () => void) => {
  for (let t = 0; t < seconds; t += dt) {
    each?.();
    s.step(dt);
  }
};

describe('soul wisps', () => {
  it('flies every soul of a spray into the god who landed the blow, even as it walks away', () => {
    const got: WispHost[] = [];
    const s = new WispSwarm(64, seeded(3), (to) => got.push(to));
    const god = host(12, 0);
    s.release(0, 1, 0, 6, god, 0xffffff);
    expect(s.wisps).toHaveLength(6);
    let closest = Infinity;
    run(s, 2.5, 1 / 60, () => {
      god.x += 4 / 60;
      for (const w of s.wisps) closest = Math.min(closest, Math.hypot(w.x - god.x, w.z - god.z));
    });
    expect(got).toHaveLength(6);
    expect(got.every((g) => g === god)).toBe(true);
    expect(s.wisps).toHaveLength(0);
    expect(closest).toBeLessThan(1.5);
  });

  it('lands at its goal on time however the frames fall', () => {
    for (const dt of [1 / 144, 1 / 30, 1 / 12]) {
      let clock = 0;
      let landed = -1;
      const s = new WispSwarm(8, seeded(5), () => (landed = clock));
      const god = host(6, 4);
      s.release(0, 1, 0, 1, god, 0);
      const w = s.wisps[0]!;
      const due = w.delay + w.time;
      run(s, due + 0.5, dt, () => (clock += dt));
      expect(landed).toBeGreaterThanOrEqual(due - 1e-9);
      expect(landed).toBeLessThan(due + dt + 1e-9);
      // the bow is gone at the end: the path finishes on the god's chest
      expect(Math.hypot(w.x - god.x, w.y - 1.3, w.z - god.z)).toBeLessThan(1e-6);
    }
  });

  it('lets the souls of a god that fell first drift away, and keeps a stream into a downed ally', () => {
    const got: WispHost[] = [];
    const s = new WispSwarm(64, seeded(8), (to) => got.push(to));
    const dead = host(10, 0, false);
    const downed = host(-3, 0, false);
    s.release(0, 1, 0, 3, dead, 0);
    s.send(0, 1, 0, downed, 0, 0.2, 0.45, true);
    run(s, 3);
    expect(got).toEqual([downed]);
    expect(s.wisps).toHaveLength(0);
  });

  it('never holds more than its cap, and souls with nowhere to go fade out', () => {
    const s = new WispSwarm(10, seeded(2));
    s.release(0, 1, 0, 25, null, 0);
    s.sink(0, 1, 10, 0, 3, 0, 0);
    expect(s.wisps).toHaveLength(10);
    const w = s.wisps[0]!;
    run(s, w.delay + w.time * 0.95);
    if (s.wisps.includes(w)) expect(s.alpha(w)).toBeLessThan(0.3);
    run(s, 3);
    expect(s.wisps).toHaveLength(0);
  });
});
