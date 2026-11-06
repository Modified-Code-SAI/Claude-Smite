import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { RATE } from './dsp';
import { activeRms, fitLoop, foldLoop, LIFT, mixLayer, peakAt, type LayerManifest } from './layers';
import { renderRecipe, SOUNDS } from './sounds';
import { hashSeed } from './dsp';

const DIR = 'public/sfx/';
const manifest = JSON.parse(readFileSync(`${DIR}layers.json`, 'utf8')) as LayerManifest;

let seed = 7;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
const burst = (len: number, at: number, decay: number) => Float32Array.from({ length: len }, (_, i) => (i < at ? 0 : noise() * Math.exp(-(i - at) / decay)));

describe('recorded layers', () => {
  test('every layer sits under a synthesized sound, with its files on disk', () => {
    expect(Object.keys(manifest.layers).length).toBeGreaterThan(10);
    for (const [name, layer] of Object.entries(manifest.layers)) {
      const recipe = SOUNDS[name];
      expect(recipe, `${name} is not a sound`).toBeTruthy();
      expect(!!layer.loop, `${name}: a loop layer goes under a looping sound`).toBe(!!recipe!.loop);
      for (const f of layer.files) expect(existsSync(`${DIR}${f}`), f).toBe(true);
    }
    expect(existsSync(`${DIR}CREDITS.md`)).toBe(true);
  });

  test('a looping layer is a whole number of its sound\'s loops long, so it barely needs stretching', () => {
    for (const [name, layer] of Object.entries(manifest.layers)) {
      if (!layer.loop) continue;
      const len = renderRecipe(SOUNDS[name]!, hashSeed(name))[0]!.length;
      const body = layer.loop * RATE;
      const fitted = Math.max(1, Math.round(body / len)) * len;
      expect(Math.abs(fitted / body - 1), `${name}: ${(body / RATE).toFixed(2)} s against a ${(len / RATE).toFixed(2)} s loop`).toBeLessThan(0.03);
    }
  });

  test('measures the level of the part that sounds, not the silence around it', () => {
    const x = new Float32Array(1000);
    for (let i = 100; i < 200; i++) x[i] = i % 2 ? 0.5 : -0.5;
    expect(activeRms(x)).toBeCloseTo(0.5);
    expect(activeRms(new Float32Array(10))).toBe(0);
    const y = burst(4000, 1500, 200);
    expect(Math.abs(peakAt(y) - 1500)).toBeLessThan(RATE * 0.01);
  });

  test('a folded loop wraps into the audio that followed its end', () => {
    const body = 4000;
    const x = Float32Array.from({ length: body + 500 }, () => noise());
    const out = foldLoop(x, body);
    expect(out).toHaveLength(body);
    // the wrap from the last sample lands on what came after it in the recording
    expect(out[0]).toBeCloseTo(x[body]!, 6);
    expect(out[body - 1]).toBe(x[body - 1]);
    // past the fold the body is untouched
    for (let i = 500; i < body; i += 97) expect(out[i]).toBe(x[i]);
    const f = fitLoop(out, 4100);
    expect(f).toHaveLength(4100);
    expect(f[0]).toBe(out[0]);
  });

  test('a one-shot layer lines up with its sound, stays near its level and gives every clip a variant', () => {
    // a swing that swells to its loudest at 0.1 s, and recordings loudest at their start
    const swing = (k: number) => Float32Array.from({ length: Math.round(RATE * 0.25) }, (_, i) => 0.6 * Math.sin(i * (0.05 + k * 0.01)) * Math.exp(-(((i / RATE - 0.1) / 0.03) ** 2)));
    const synth = [swing(0), swing(1)];
    const clips = [burst(5000, 0, 600), burst(6000, 0, 900), burst(4000, 0, 400)];
    const out = mixLayer(synth, clips, { mix: 0 }, false);
    expect(out).toHaveLength(3);
    out.forEach((o, i) => {
      const s = synth[i % 2]!;
      expect(activeRms(o)).toBeLessThanOrEqual(activeRms(s) * LIFT * 1.001);
      expect(activeRms(o)).toBeGreaterThan(activeRms(s) * 0.8);
      expect(Math.max(...o.map(Math.abs))).toBeLessThanOrEqual(0.981);
      // the recording's hit moved to the swing's loudest moment
      expect(Math.abs(peakAt(o) - peakAt(s))).toBeLessThan(RATE * 0.02);
    });
    // nothing to mix: the sound is unchanged
    expect(mixLayer(synth, [], { mix: 0 }, false)).toEqual(synth);
  });

  test('a hit does not lag its blow: the synthesized sound waits at most 30 ms for a later recording', () => {
    const synth = [burst(4000, 0, 300)];
    const late = [burst(RATE, Math.round(RATE * 0.5), 300)];
    const out = mixLayer(synth, late, { mix: 0 }, false)[0]!;
    // the synthesized attack starts within 30 ms
    let lead = 0;
    while (lead < out.length && out[lead] === 0) lead++;
    expect(lead).toBeLessThanOrEqual(Math.round(RATE * 0.03));
  });

  test('a looping layer comes out a whole number of loops long and wraps without a step', () => {
    // a synthesized loop of whole cycles, and a recording of a bit over two of its lengths with a run-on
    const len = 4410;
    const synth = [Float32Array.from({ length: len }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 10 * i) / len))];
    const body = 2.05 * len;
    const rec = Float32Array.from({ length: Math.round(body) + 4000 }, (_, i) => 0.3 * Math.sin(i * 0.031) + 0.05 * noise());
    const [out] = mixLayer(synth, [rec], { mix: 0, loop: body / RATE }, true);
    expect(out!.length).toBe(2 * len);
    let worst = 0;
    for (let i = 1; i < out!.length; i++) worst = Math.max(worst, Math.abs(out![i]! - out![i - 1]!));
    expect(Math.abs(out![0]! - out![out!.length - 1]!)).toBeLessThan(worst * 1.5);
  });
});
