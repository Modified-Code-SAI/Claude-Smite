import { describe, expect, it } from 'vitest';
import { Rush, RUSH } from '../sim/Rush';
import { Sim, type SimTerrain } from '../sim/Sim';
import { CHANT, CHANT_BEAT, CHANT_LOOP, chantAt, chantBreak, chanting, chantMotion } from './chant';
import { hashSeed, RATE } from './dsp';
import { renderRecipe, SOUNDS } from './sounds';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };

function rush(): Rush {
  return new Rush(new Sim(flat, { order: { ...RUSH.bases.order }, chaos: { ...RUSH.bases.chaos } }, () => 0.5));
}

describe('the crowd chant', () => {
  it('starts in a tight finish and never over a goal or a won match', () => {
    const r = rush();
    r.phase = 'play';
    expect(chanting(r)).toBe(false);
    // a game within a goal in its last 45 s
    r.clock = 40;
    r.score.order = 2;
    r.score.chaos = 1;
    expect(chanting(r)).toBe(true);
    r.score.order = 3;
    expect(chanting(r)).toBe(false);
    // four apiece, however long is left
    r.clock = 200;
    r.score.order = r.score.chaos = 4;
    expect(chanting(r)).toBe(true);
    r.phase = 'kickoff';
    expect(chanting(r)).toBe(true);
    r.phase = 'goal';
    expect(chanting(r)).toBe(false);
    // golden-relic overtime
    r.phase = 'play';
    r.score.order = r.score.chaos = 2;
    r.clock = 0;
    r.overtime = true;
    expect(chanting(r)).toBe(true);
    r.winner = 'order';
    expect(chanting(r)).toBe(false);
  });

  it('lands each hop on a stamp and thrusts the arms up on each clap, the shout highest', () => {
    const m = { bob: 0, pump: 0 };
    const at = (beat: number) => (chantMotion(beat * CHANT_BEAT, m), { ...m });
    for (const s of CHANT.stomps) expect(at(s).bob).toBeLessThan(0.02);
    // highest midway through the long gaps, a small hop between the quick stamps
    expect(at(3.25).bob).toBeGreaterThan(0.95);
    expect(at(2.25).bob).toBeCloseTo(0.5, 1);
    for (const c of CHANT.claps) expect(at(c).pump).toBeCloseTo(1, 2);
    expect(at(CHANT.shout).pump).toBeCloseTo(1.4, 2);
    expect(at(1.5).pump).toBeLessThan(0.01);
    // it keeps going round, whatever the clock says
    expect(at(CHANT.beats * 37 + 3.25).bob).toBeCloseTo(at(3.25).bob, 3);
    expect(chantAt(-1)).toBeCloseTo(CHANT_LOOP - 1, 6);
  });

  it('an end breaks off the chant as it gets up to cheer', () => {
    expect(chantBreak(0.1)).toBe(0);
    expect(chantBreak(0.45)).toBe(0);
    expect(chantBreak(0.625)).toBeCloseTo(0.5, 6);
    expect(chantBreak(0.9)).toBe(1);
  });

  it('sounds its stamps on the beat, and wraps exactly on its length', () => {
    const takes = renderRecipe(SOUNDS['amb.chant']!, hashSeed('amb.chant'));
    expect(takes.length).toBe(2);
    const rms = (b: Float32Array, from: number, len: number) => {
      let e = 0;
      const a = Math.round(from * RATE);
      const n = Math.round(len * RATE);
      for (let i = 0; i < n; i++) e += b[(a + i + b.length) % b.length]! ** 2;
      return Math.sqrt(e / n);
    };
    for (const b of takes) {
      // no seam to shorten it: the beat lasts as long as the stands keep it
      expect(b.length).toBe(Math.round(CHANT_LOOP * RATE));
      for (let take = 0; take < CHANT.takes; take++) {
        for (const s of CHANT.stomps) {
          const t = (take * CHANT.beats + s) * CHANT_BEAT;
          expect(rms(b, t, 0.06)).toBeGreaterThan(rms(b, t - 0.07, 0.06) * 3);
        }
      }
      // the two takes differ (each hit made fresh)
      let diff = 0;
      const half = Math.round((CHANT_LOOP / CHANT.takes) * RATE);
      for (let i = 0; i < half; i++) diff += Math.abs(b[i]! - b[i + half]!);
      expect(diff / half).toBeGreaterThan(0.01);
    }
  });
});
