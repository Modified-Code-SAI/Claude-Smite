import { describe, expect, test } from 'vitest';
import { ROOMS, roomGain, roomImpulse, type Room } from './rooms';
import { DEPTH_ROOM } from './underworldAmbience';

const RATE = 48000;
const all = Object.keys(ROOMS) as Room[];
const impulses = Object.fromEntries(all.map((r) => [r, roomImpulse(ROOMS[r], RATE)])) as Record<Room, [Float32Array, Float32Array]>;

const energy = (x: Float32Array, from = 0, to = x.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i]! * x[i]!;
  return e;
};
/** How much of a stretch's energy is in its top end (its first difference against itself). */
const brightness = (x: Float32Array, from: number, to: number) => {
  let d = 0;
  for (let i = from + 1; i < to; i++) d += (x[i]! - x[i - 1]!) ** 2;
  return d / energy(x, from, to);
};

describe('rooms', () => {
  test('each room rings for its length in two decorrelated ears, and dies away', () => {
    for (const r of all) {
      const [l, rr] = impulses[r];
      expect(l.length).toBe(Math.round(ROOMS[r].seconds * RATE));
      let dot = 0;
      for (let i = 0; i < l.length; i++) dot += l[i]! * rr[i]!;
      expect(Math.abs(dot) / Math.sqrt(energy(l) * energy(rr)), `${r} ears`).toBeLessThan(0.2);
      const tenth = Math.floor(l.length / 10);
      expect(energy(l, l.length - tenth), `${r} tail`).toBeLessThan(energy(l, 0, tenth) * 0.01);
    }
  });

  test('once the convolver evens out their energy, each room comes out at its own level against the hall', () => {
    // the convolver scales every impulse to the same RMS (so a longer one passes more energy); roomGain undoes that
    const passed = (r: Room) => {
      const [l, rr] = impulses[r];
      const rms = Math.sqrt((energy(l) + energy(rr)) / (2 * l.length));
      return Math.sqrt((energy(l) + energy(rr)) / rms ** 2) * roomGain(r);
    };
    for (const r of all) expect(passed(r) / passed('hall'), r).toBeCloseTo(ROOMS[r].level, 2);
  });

  test('the Drowned Halls ring brightest and the Abyss darkest; the Abyss answers late and rings longest', () => {
    const mid = (r: Room) => brightness(impulses[r][0], Math.round(0.1 * RATE), Math.round(0.6 * RATE));
    expect(mid('drowned')).toBeGreaterThan(mid('hall'));
    expect(mid('hall')).toBeGreaterThan(mid('abyss'));
    expect(mid('forge')).toBeLessThan(mid('hall'));
    expect(Math.max(...all.map((r) => ROOMS[r].seconds))).toBe(ROOMS.abyss.seconds);
    expect(ROOMS.abyss.onset).toBeGreaterThan(ROOMS.hall.onset);
  });

  test('a room\'s echoes stand out of its tail where they fall', () => {
    for (const r of all) {
      const x = impulses[r][0];
      for (const [at] of ROOMS[r].echoes) {
        const i = Math.round(at * RATE);
        const w = 3 + Math.round(at * 40);
        // the few samples of the echo against as many of the tail just before it
        expect(energy(x, i, i + w), `${r} echo at ${at}`).toBeGreaterThan(energy(x, i - 3 * w, i - 2 * w) * 2);
      }
    }
  });

  test('the hall is the reverb every map always had', () => {
    // the impulse AudioEngine used to build, inline
    const len = Math.round(2.6 * RATE);
    for (let ch = 0; ch < 2; ch++) {
      let lp = 0;
      let seed = ch ? 0x9e3779b9 : 0x2545f491;
      const d = impulses.hall[ch]!;
      for (let i = 0; i < len; i += 1) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const n = ((seed >>> 0) / 4294967296) * 2 - 1;
        const t = i / len;
        lp += (n - lp) * (0.6 - t * 0.5);
        const pre = i < RATE * 0.012 ? i / (RATE * 0.012) : 1;
        if (i % 997 === 0) expect(d[i]).toBeCloseTo(lp * Math.pow(1 - t, 3.2) * pre * 0.6, 5);
      }
    }
    expect(roomGain('hall')).toBe(1);
  });

  test('each Descent depth rings in a room of its own', () => {
    const rooms = Object.values(DEPTH_ROOM);
    expect(new Set(rooms).size).toBe(rooms.length);
    for (const r of rooms) expect(r).not.toBe('hall');
  });
});
