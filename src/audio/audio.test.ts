import { describe, expect, test } from 'vitest';
import { GODS } from '../game/gods';
import { jotunn } from '../game/gods/jotunn';
import { hashSeed, RATE } from './dsp';
import { CHORDS, INST, INSTRUMENTS, Music, SONGS } from './music';
import type { AudioEngine } from './AudioEngine';
import { SKILL_SOUNDS } from './skillSounds';
import { renderRecipe, SOUNDS, type Recipe } from './sounds';
import { DEPTH_BEDS, UNDERWORLD_LIFE } from './underworldAmbience';

function check(name: string, recipe: Recipe): number {
  const variants = renderRecipe(recipe, hashSeed(name));
  let samples = 0;
  for (const b of variants) {
    let peak = 0;
    let sum = 0;
    let energy = 0;
    for (let i = 0; i < b.length; i++) {
      const x = b[i]!;
      if (!Number.isFinite(x)) throw new Error(`${name}: non-finite sample at ${i}`);
      peak = Math.max(peak, Math.abs(x));
      sum += x;
      energy += x * x;
    }
    expect(peak, `${name} peak`).toBeLessThanOrEqual(1.0001);
    expect(peak, `${name} is silent`).toBeGreaterThan(0.05);
    // no large DC offset (it would thump when the sound starts and stops)
    expect(Math.abs(sum / b.length), `${name} DC`).toBeLessThan(0.05);
    expect(Math.sqrt(energy / b.length), `${name} rms`).toBeGreaterThan(0.002);
    expect(b.length / RATE, `${name} length`).toBeLessThan(15);
    // loops must wrap without a jump (a click every time they repeat)
    if (recipe.loop) expect(Math.abs(b[b.length - 1]! - b[0]!), `${name} loop seam`).toBeLessThan(0.08);
    samples += b.length;
  }
  return samples;
}

describe('sound bank', () => {
  test('every sound renders clean audio', { timeout: 60000 }, () => {
    let total = 0;
    for (const [name, r] of Object.entries(SOUNDS)) total += check(name, r);
    for (const [name, r] of Object.entries(INSTRUMENTS)) total += check(name, r);
    // keep the whole bank light enough to render while the game loads
    expect(total / RATE).toBeLessThan(900);
  });

  test('every skill of every god (and the Jötunn) has its own cast sound, and its parts render', { timeout: 60000 }, () => {
    for (const g of [...GODS, jotunn]) {
      for (const s of g.skills) {
        const ss = SKILL_SOUNDS[s.id];
        expect(ss, `${s.id} has sounds`).toBeTruthy();
        if (s.targeting.type === 'projectile') expect(ss!.travel, `${s.id} travel`).toBeTruthy();
        for (const part of ['cast', 'travel', 'impact', 'zone', 'tick'] as const) {
          const make = ss![part];
          if (make) check(`skill:${s.id}:${part}`, { make, loop: part === 'travel' || part === 'zone' });
        }
      }
    }
  });

  test('every song writes only known chords and instruments, in range', () => {
    for (const [name, song] of Object.entries(SONGS)) {
      for (let loop = 0; loop < 2; loop++) {
        song.chords.forEach((c, bar) => {
          const chord = CHORDS[c];
          expect(chord, `${name} bar ${bar} chord ${c}`).toBeTruthy();
          const notes: Parameters<typeof song.write>[3] = [];
          song.write(bar, loop, chord!, notes);
          expect(notes.length, `${name} bar ${bar} is silent`).toBeGreaterThan(0);
          for (const n of notes) {
            expect(INST[n.inst], `${name}: ${n.inst}`).toBeTruthy();
            expect(INSTRUMENTS[n.inst], `${name}: ${n.inst} has a recipe`).toBeTruthy();
            expect(n.beat, `${name} bar ${bar} beat`).toBeGreaterThanOrEqual(0);
            expect(n.beat).toBeLessThan(song.beats);
            // transposing more than an octave and a half from the sample sounds wrong
            if (n.midi !== undefined) expect(Math.abs(n.midi - INST[n.inst]!.ref), `${name}: ${n.inst} ${n.midi}`).toBeLessThanOrEqual(19);
          }
        });
      }
    }
  });

  test('the music steps back, drums first, while something with its own beat carries the moment', () => {
    const gains = { battle: 0, base: 0 };
    const layer = (name: keyof typeof gains) => ({ gain: { setTargetAtTime: (v: number) => (gains[name] = v) } });
    const engine = { ctx: { currentTime: 0 }, onUnlock: () => {} } as unknown as AudioEngine;
    const music = new Music(engine);
    (music as unknown as { playing: unknown }).playing = { layers: { battle: layer('battle'), base: layer('base') } };
    const run = (seconds: number, hush: number) => {
      for (let i = 0; i < seconds * 60; i++) music.setIntensity(1, 1 / 60, hush);
    };
    run(3, 0);
    expect(gains.battle).toBeGreaterThan(0.95);
    // a crowd's chant takes over: the drums go, and the rest drops right back
    run(5, 1);
    expect(gains.battle).toBeLessThan(0.02);
    expect(gains.base).toBeLessThan(0.15);
    // and it comes back quicker than it went
    run(2.5, 0);
    expect(gains.battle).toBeGreaterThan(0.95);
  });

  test('each Descent depth has beds and stirs of its own, all in the bank', () => {
    const depths = ['ember', 'soul', 'spirit'] as const;
    const own = depths.map((d) => new Set([...DEPTH_BEDS.filter((b) => b.depth === d).map((b) => b.name), ...UNDERWORLD_LIFE[d].near.sounds, ...UNDERWORLD_LIFE[d].far.sounds]));
    for (const [k, d] of depths.entries()) {
      expect(DEPTH_BEDS.some((b) => b.depth === d), `${d} has a bed`).toBe(true);
      for (const name of own[k]!) expect(SOUNDS[name], name).toBeTruthy();
      for (const name of DEPTH_BEDS.filter((b) => b.depth === d).map((b) => b.name)) expect(SOUNDS[name]!.loop, `${name} loops`).toBe(true);
      // something heard at this depth and no other
      const others = own.filter((_, j) => j !== k);
      expect([...own[k]!].some((n) => others.every((o) => !o.has(n))), `${d} sounds like itself`).toBe(true);
      const { near, far } = UNDERWORLD_LIFE[d];
      for (const s of [near, far]) expect(s.every[0]).toBeLessThanOrEqual(s.every[1]);
    }
  });

  test('sounds are deterministic', () => {
    const a = renderRecipe(SOUNDS['hit.blade']!, 42)[0]!;
    const b = renderRecipe(SOUNDS['hit.blade']!, 42)[0]!;
    expect(a).toEqual(b);
  });
});
