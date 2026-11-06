import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { CHORDS, INST, SONGS } from './music';
import { Orchestra, pickZone, sealLoop, type Manifest, type Zone } from './orchestra';

const DIR = 'public/music/';
const manifest = JSON.parse(readFileSync(`${DIR}samples.json`, 'utf8')) as Manifest;
/**
 * Score instruments that stay synthesized on purpose. A new instrument either
 * gets a recorded set (SETS and MAP in tools/music/build.py, then rerun it) or
 * a line here saying why not.
 */
const SYNTH_ONLY: Record<string, string> = {
  // the forge theme's hammer plays chord roots and fifths; a real anvil rings inharmonic and can't follow them
  'mus.anvil': 'pitched hammer part',
};

describe('recorded orchestra', () => {
  test('picks the sample nearest the note, and the first for unpitched hits', () => {
    const zones: Zone[] = [
      { ref: 48, files: ['a'] },
      { ref: 51, files: ['b'] },
      { ref: 54.02, files: ['c'] },
    ];
    expect(pickZone(zones, 47)!.files[0]).toBe('a');
    expect(pickZone(zones, 52)!.files[0]).toBe('b');
    expect(pickZone(zones, 53)!.files[0]).toBe('c');
    expect(pickZone(zones, 90)!.files[0]).toBe('c');
    expect(pickZone(zones, undefined)!.files[0]).toBe('a');
    expect(pickZone([{ ref: null, files: ['hit'] }], 60)!.files[0]).toBe('hit');
    expect(pickZone([], 60)).toBeNull();
  });

  test('every score instrument has a recorded set, a loudness match and files on disk', () => {
    for (const inst of Object.keys(INST)) {
      if (SYNTH_ONLY[inst]) continue;
      const set = manifest.sets[manifest.map[inst]!];
      expect(set, `${inst} has no recorded set: add one in tools/music/build.py or list it in SYNTH_ONLY`).toBeTruthy();
      expect(manifest.gain?.[inst], `${inst} gain`).toBeGreaterThan(0);
      for (const z of set!.zones) {
        for (const f of z.files) expect(existsSync(`${DIR}${f}`), f).toBe(true);
        if (set!.kind === 'sustain') {
          expect(z.loop, `${inst} loop`).toBeTruthy();
          expect(z.loop![1] - z.loop![0], `${inst} loop length`).toBeGreaterThan(1);
        }
      }
    }
  });

  test('no note the score writes is stretched more than two and a half semitones from its recording', () => {
    for (const [name, song] of Object.entries(SONGS)) {
      for (let loop = 0; loop < 2; loop++) {
        song.chords.forEach((c, bar) => {
          const notes: Parameters<typeof song.write>[3] = [];
          song.write(bar, loop, CHORDS[c]!, notes);
          for (const n of notes) {
            if (n.midi === undefined || SYNTH_ONLY[n.inst]) continue;
            const z = pickZone(manifest.sets[manifest.map[n.inst]!]!.zones, n.midi)!;
            expect(Math.abs(n.midi - z.ref!), `${name}: ${n.inst} ${n.midi}`).toBeLessThanOrEqual(2.5);
          }
        });
      }
    }
  });

  test('loads, then serves each note transposed and level-matched, rotating round-robin hits', async () => {
    const fake: Manifest = {
      version: 1,
      map: { 'mus.pad.lo': 'strings', 'mus.taiko': 'drum' },
      gain: { 'mus.pad.lo': 1.5 },
      sets: {
        strings: { kind: 'sustain', zones: [{ ref: 45, files: ['s0.ogg'], loop: [1, 3] }, { ref: 48, files: ['s1.ogg'], loop: [1, 3] }] },
        drum: { kind: 'hit', zones: [{ ref: null, files: ['d0.ogg', 'd1.ogg'] }] },
      },
    };
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return url.endsWith('samples.json') ? { ok: true, json: async () => fake } : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    });
    let decoded = 0;
    const ctx = {
      decodeAudioData: async () => {
        const data = new Float32Array(48000 * 4);
        return { id: decoded++, sampleRate: 48000, numberOfChannels: 1, getChannelData: () => data };
      },
    } as unknown as BaseAudioContext;
    const o = new Orchestra('/m/');
    expect(o.note('mus.pad.lo', 45)).toBeNull();
    expect(await o.load(ctx)).toBe(true);
    vi.unstubAllGlobals();
    expect(o.loaded).toBe(true);
    expect(fetched.sort()).toEqual(['/m/d0.ogg', '/m/d1.ogg', '/m/s0.ogg', '/m/s1.ogg', '/m/samples.json']);
    const pad = o.note('mus.pad.lo', 47)!;
    expect(pad.rate).toBeCloseTo(Math.pow(2, -1 / 12));
    expect(pad.gain).toBe(1.5);
    expect(pad.loop).toEqual([1, 3]);
    expect(decoded).toBe(4);
    const a = o.note('mus.taiko', undefined)!;
    const b = o.note('mus.taiko', undefined)!;
    expect(a.buffer).not.toBe(b.buffer);
    expect(a.gain).toBe(1);
    expect(o.note('mus.bell', 81)).toBeNull();
  });

  test('a sealed loop wraps without a step, even with codec noise on each side of the seam', () => {
    const rate = 48000;
    const d = new Float32Array(rate * 3);
    // a 110 Hz tone whose loop spans whole cycles, with independent noise on the two sides
    let seed = 1;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.04;
    for (let i = 0; i < d.length; i++) d[i] = 0.6 * Math.sin((2 * Math.PI * 110 * i) / rate) + noise();
    // the end deliberately off a whole frame
    const [ls, le] = sealLoop([d], rate, [0.5, 1.50001]);
    const s = Math.round(ls * rate);
    const e = Math.round(le * rate);
    expect(ls * rate).toBeCloseTo(s, 6);
    expect(le * rate).toBeCloseTo(e, 6);
    // the frame before the end equals the frame before the start, and past the end continues the start
    expect(d[e - 1]).toBe(d[s - 1]);
    for (let j = 0; j < 100; j++) expect(d[e + j]).toBe(d[s + j]);
    // and the blend is gentle: no step bigger than the tone's own
    let worst = 0;
    for (let i = e - 600; i < e; i++) worst = Math.max(worst, Math.abs(d[i + 1]! - d[i]!));
    expect(worst).toBeLessThan(0.6 * ((2 * Math.PI * 110) / rate) + 0.05);
  });

  test('a failed download leaves the score synthesized', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false }));
    const o = new Orchestra('/m/');
    expect(await o.load({} as BaseAudioContext)).toBe(false);
    vi.unstubAllGlobals();
    expect(o.loaded).toBe(false);
    expect(o.note('mus.pad.lo', 45)).toBeNull();
  });
});
