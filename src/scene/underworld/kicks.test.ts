import { describe, expect, it } from 'vitest';
import { DepthKicks, KICKS } from './kicks';

const thrown = (k: DepthKicks) => {
  const from = k.sprite.geometry.getAttribute('kFrom').array as Float32Array;
  const vel = k.sprite.geometry.getAttribute('kVel').array as Float32Array;
  const out: { x: number; y: number; z: number; at: number; vx: number; vy: number; vz: number; kind: number; size: number }[] = [];
  for (let i = 0; i < KICKS.capacity; i++) {
    if (from[i * 4 + 3]! < -1) continue;
    const w = vel[i * 4 + 3]!;
    out.push({ x: from[i * 4]!, y: from[i * 4 + 1]!, z: from[i * 4 + 2]!, at: from[i * 4 + 3]!, vx: vel[i * 4]!, vy: vel[i * 4 + 1]!, vz: vel[i * 4 + 2]!, kind: Math.floor(w), size: w - Math.floor(w) });
  }
  return out;
};

describe("what the gods' feet throw up off the Descent's floors", () => {
  it('throws up ash (and a spark now and then) off the forge, a spray off the wet, motes off the glass', () => {
    const forge = new DepthKicks(() => 0.1);
    // heading -z: the ash goes back, toward +z
    forge.step(2, 0.5, 3, 0, -1, 1, 'ember');
    const ash = thrown(forge);
    expect(ash).toHaveLength(KICKS.per.ash + 2);
    expect(ash.filter((f) => f.kind === 0)).toHaveLength(KICKS.per.ash);
    expect(ash.filter((f) => f.kind === 1)).toHaveLength(1);
    // (with a puff of dust)
    expect(ash.filter((f) => f.kind === 4)).toHaveLength(1);
    for (const f of ash) {
      expect(f.vy).toBeGreaterThan(0);
      expect(f.y).toBeGreaterThan(0.5);
      expect(Math.hypot(f.x - 2, f.z - 3)).toBeLessThan(0.2);
    }
    for (const f of ash.filter((f) => f.kind === 0)) expect(f.vz).toBeGreaterThan(0);
    // (no spark when the dice say no)
    const dull = new DepthKicks(() => 0.9);
    dull.step(0, 0, 0, 0, -1, 1, 'ember');
    expect(thrown(dull).some((f) => f.kind === 1)).toBe(false);

    const wet = new DepthKicks(() => 0.5);
    wet.step(0, 0, 0, 1, 0, 1, 'soul');
    const spray = thrown(wet);
    expect(spray.filter((f) => f.kind === 2)).toHaveLength(KICKS.per.drop);
    expect(spray.filter((f) => f.kind === 5)).toHaveLength(1);
    expect(spray).toHaveLength(KICKS.per.drop + 1);

    const glass = new DepthKicks(() => 0.3);
    glass.step(0, 0, 0, 1, 0, 1, 'spirit');
    const motes = thrown(glass);
    expect(motes).toHaveLength(KICKS.per.mote + 1);
    expect(motes.filter((f) => f.kind === 6)).toHaveLength(1);
    for (const f of motes.filter((f) => f.kind === 3)) {
      expect(f.size).toBeGreaterThan(0);
      expect(f.size).toBeLessThan(0.2);
    }
    // (the puffs are wider than what they throw up, and every size fits the fraction it is kept in)
    for (const f of [...ash, ...spray, ...motes]) expect(f.size).toBeLessThan(1);
    expect(motes.find((f) => f.kind === 6)!.size).toBeGreaterThan(motes.find((f) => f.kind === 3)!.size);
  });

  it("throws a bigger god's flecks bigger and further", () => {
    const small = new DepthKicks(() => 0.5);
    small.step(0, 0, 0, 0, -1, 1, 'soul');
    const big = new DepthKicks(() => 0.5);
    big.step(0, 0, 0, 0, -1, 1.4, 'soul');
    const a = thrown(small).find((f) => f.kind === 2)!;
    const b = thrown(big).find((f) => f.kind === 2)!;
    expect(b.size).toBeGreaterThan(a.size);
    expect(b.vy).toBeGreaterThan(a.vy);
  });

  it('is drawn only while something it threw is still in the air, and is wiped for the next chamber', () => {
    const k = new DepthKicks(() => 0.5);
    k.update(0.1);
    expect(k.sprite.visible).toBe(false);
    k.step(0, 0, 0, 0, -1, 1, 'spirit');
    k.update(0.016);
    expect(k.sprite.visible).toBe(true);
    for (let i = 0; i < 200; i++) k.update(0.016);
    expect(k.sprite.visible).toBe(false);
    k.step(0, 0, 0, 0, -1, 1, 'soul');
    k.update(0.016);
    k.clear();
    expect(thrown(k)).toHaveLength(0);
    k.update(0.016);
    expect(k.sprite.visible).toBe(false);
    const undo = k.prime();
    expect(k.sprite.visible).toBe(true);
    undo();
    expect(k.sprite.visible).toBe(false);
  });

  it('makes room by reusing the oldest', () => {
    const k = new DepthKicks(() => 0.5);
    const steps = Math.ceil(KICKS.capacity / (KICKS.per.drop + 1)) + 1;
    for (let i = 0; i < steps; i++) {
      k.step(i, 0, 0, 0, -1, 1, 'soul');
      k.update(0.01);
    }
    const all = thrown(k);
    expect(all).toHaveLength(KICKS.capacity);
    // the first steps' drops are gone, the last step's are there
    expect(Math.min(...all.map((f) => f.x))).toBeGreaterThan(0);
    expect(all.filter((f) => f.x === steps - 1)).toHaveLength(KICKS.per.drop + 1);
  });
});
