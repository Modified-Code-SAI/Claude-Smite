/**
 * Recordings mixed under some synthesized sounds: footsteps, steel, punches,
 * rubble, swings, fire and crowds (public/sfx/, cut from CC0 packs by
 * tools/sfx/build.py). The synthesized sound keeps its weight and variety; the
 * recording adds the grain that synthesis can't. Each layer is mixed in once,
 * when both halves are ready, so playing a sound still costs one voice. If
 * the files don't arrive, the sounds stay purely synthesized.
 */

import type { AudioEngine } from './AudioEngine';
import { RATE } from './dsp';

export interface Layer {
  files: string[];
  /** The recording's level against the synthesized sound, in dB (0 is as loud). */
  mix: number;
  /** For a looping sound: the loop body in seconds; the file runs a little past it. */
  loop?: number;
}

export interface LayerManifest {
  version: number;
  layers: Record<string, Layer>;
}

/** The level of the part of a sound that is actually sounding (where it is within 20 dB of its peak). */
export function activeRms(x: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
  const floor = peak * 0.1;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]!);
    if (v < floor) continue;
    sum += v * v;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/**
 * Folds a loop's run-on back over its start: the first stretch fades from the
 * audio that followed the end into the start (equal power, since the two are
 * unrelated noise), so the body wraps without a seam.
 */
export function foldLoop(x: Float32Array, body: number): Float32Array {
  const out = x.slice(0, body);
  const m = Math.min(x.length - body, Math.floor(body / 4));
  for (let i = 0; i < m; i++) {
    const w = (i / m) * (Math.PI / 2);
    out[i] = x[i]! * Math.sin(w) + x[body + i]! * Math.cos(w);
  }
  return out;
}

/** Stretches a loop to exactly `n` samples (linear interpolation that wraps). */
export function fitLoop(x: Float32Array, n: number): Float32Array {
  if (x.length === n) return x;
  const out = new Float32Array(n);
  const step = x.length / n;
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const j = Math.floor(p);
    const f = p - j;
    out[i] = x[j % x.length]! * (1 - f) + x[(j + 1) % x.length]! * f;
  }
  return out;
}

/** How much louder (active level) a layered sound may come out than the synthesized one alone: 1.5 dB. */
export const LIFT = Math.pow(10, 1.5 / 20);
/** The highest peak a layered sound may have (the master limiter handles the sum of many). */
const PEAK = 0.98;

/** Where a sound is loudest (its envelope over 10 ms), in samples. */
export function peakAt(x: Float32Array): number {
  const w = Math.max(1, Math.round(RATE * 0.01));
  let sum = 0;
  let best = 0;
  let at = 0;
  for (let i = 0; i < x.length; i++) {
    sum += Math.abs(x[i]!) - (i >= w ? Math.abs(x[i - w]!) : 0);
    if (sum > best) {
      best = sum;
      at = i - (w >> 1);
    }
  }
  return Math.max(0, at);
}

/** How far a one-shot's recording may be moved to line its loudest moment up with the synthesized one's. */
const ALIGN_LATE = Math.round(0.25 * RATE);
/** How far the synthesized sound may be held back instead (a hit must not lag its blow). */
const ALIGN_EARLY = Math.round(0.03 * RATE);

/**
 * Mixes recorded clips under a synthesized sound's variants and returns the
 * new variants. Each recording is set `mix` dB against its synthesized
 * partner, with the loudest moments of the two lined up, and the pair is
 * brought back to within LIFT of the synthesized sound's level, so a layered
 * sound sits in the mix about where it did. One-shots pair variants and clips
 * round-robin (as many results as the larger set); a loop becomes a whole
 * number of the synthesized loop's lengths, with the recording folded and
 * stretched to match.
 */
export function mixLayer(synth: readonly Float32Array[], clips: readonly Float32Array[], layer: Pick<Layer, 'mix' | 'loop'>, loop: boolean): Float32Array[] {
  if (!synth.length || !clips.length) return [...synth];
  const g = Math.pow(10, layer.mix / 20);
  /** `ds` and `dc` delay the synthesized sound and the recording. */
  const pair = (s: Float32Array, c: Float32Array, ds: number, dc: number, n: number): Float32Array => {
    const rs = activeRms(s);
    const rc = activeRms(c);
    const out = new Float32Array(n);
    const k = rc > 0 ? (g * rs) / rc : 0;
    let po = 0;
    for (let i = 0; i < n; i++) {
      const a = i - ds;
      const b = i - dc;
      out[i] = (loop ? s[i % s.length]! : a >= 0 && a < s.length ? s[a]! : 0) + (b >= 0 && b < c.length ? k * c[b]! : 0);
      po = Math.max(po, Math.abs(out[i]!));
    }
    // the pair may come out up to LIFT louder: pulling it all the way back would thin the synthesized bass
    const ro = activeRms(out);
    let back = ro > rs * LIFT ? (rs * LIFT) / ro : 1;
    if (po * back > PEAK) back = PEAK / po;
    if (back !== 1) for (let i = 0; i < n; i++) out[i]! *= back;
    return out;
  };
  if (loop && layer.loop) {
    const s = synth[0]!;
    const body = Math.min(clips[0]!.length, Math.round(layer.loop * RATE));
    const reps = Math.max(1, Math.round(body / s.length));
    const n = s.length * reps;
    return [pair(s, fitLoop(foldLoop(clips[0]!, body), n), 0, 0, n)];
  }
  const count = Math.max(synth.length, clips.length);
  return Array.from({ length: count }, (_, i) => {
    const s = synth[i % synth.length]!;
    const c = clips[i % clips.length]!;
    const shift = Math.max(-ALIGN_EARLY, Math.min(ALIGN_LATE, peakAt(s) - peakAt(c)));
    const ds = Math.max(0, -shift);
    const dc = Math.max(0, shift);
    return pair(s, c, ds, dc, Math.max(s.length + ds, c.length + dc));
  });
}

/**
 * Downloads and decodes every layer (an OfflineAudioContext decodes before
 * audio is unlocked, straight to the bank's sample rate) and hands each to
 * the engine, which mixes it in when its sound is rendered. Resolves false
 * if anything fails; the sounds then stay synthesized.
 */
export async function loadLayers(engine: Pick<AudioEngine, 'layer'>, base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}layers.json`);
    if (!res.ok) return false;
    const manifest = (await res.json()) as LayerManifest;
    const ctx = new OfflineAudioContext(1, 1, RATE);
    // sounds can share clips (each depth's floor is stone too): fetch and decode each file once
    const decoded = new Map<string, Promise<Float32Array>>();
    const decode = (file: string): Promise<Float32Array> => {
      let got = decoded.get(file);
      if (!got) {
        got = (async () => {
          const r = await fetch(`${base}${file}`);
          if (!r.ok) throw new Error(`${file}: ${r.status}`);
          return (await ctx.decodeAudioData(await r.arrayBuffer())).getChannelData(0);
        })();
        decoded.set(file, got);
      }
      return got;
    };
    const all = await Promise.all(Object.entries(manifest.layers).map(async ([name, layer]) => [name, layer, await Promise.all(layer.files.map(decode))] as const));
    for (const [name, layer, clips] of all) engine.layer(name, (synth, loop) => mixLayer(synth, clips, layer, loop));
    return true;
  } catch {
    return false;
  }
}
