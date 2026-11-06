/**
 * The recorded orchestra the score plays once it has loaded: one sample every
 * few semitones per instrument (public/music/, built by tools/music/build.py
 * from the VSCO 2 Community Edition and VCSL (CC0) and Sonatina Symphonic
 * Orchestra (CC Sampling Plus 1.0) libraries). Each note uses the sample
 * nearest its pitch, transposed by playback rate; sustained samples carry a
 * seamless loop so a note can be held for any length. Until the files are in
 * (or if they fail), `Music` plays its synthesized instruments instead.
 */

export interface Zone {
  /** The sample's measured MIDI pitch; null for unpitched hits. */
  ref: number | null;
  /** Round-robin variants of the same note. */
  files: string[];
  /** Loop start and end in seconds (sustained sets). */
  loop?: [number, number];
}

export interface SampleSet {
  kind: 'sustain' | 'decay' | 'hit' | 'swell';
  zones: Zone[];
}

export interface Manifest {
  version: number;
  /** Score instrument name (INST in music.ts) to sample set. */
  map: Record<string, string>;
  /** Score instrument name to the gain that matches the synthesized instrument's loudness. */
  gain?: Record<string, number>;
  sets: Record<string, SampleSet>;
}

/** The zone whose pitch is nearest `midi` (the first zone for hits or a missing pitch). */
export function pickZone(zones: readonly Zone[], midi: number | undefined): Zone | null {
  if (!zones.length) return null;
  if (midi === undefined) return zones[0]!;
  let best = zones[0]!;
  let gap = Infinity;
  for (const z of zones) {
    if (z.ref === null) return z;
    const d = Math.abs(z.ref - midi);
    if (d < gap) {
      gap = d;
      best = z;
    }
  }
  return best;
}

export interface SampleNote {
  buffer: AudioBuffer;
  /** Playback rate that brings the sample to the note's pitch. */
  rate: number;
  /** Multiplies the note's gain so the recording sits where the synthesized instrument did. */
  gain: number;
  loop: [number, number] | null;
}

const MAX_PARALLEL = 6;

/**
 * Makes a decoded loop wrap without a click. The build bakes a seamless loop,
 * but a lossy codec lays different noise on the two sides of the seam, so
 * here the last few milliseconds before the end blend into the same stretch
 * before the start, and the audio past the end becomes a copy of what follows
 * the start (playback interpolates across the seam). Returns the loop snapped
 * to whole frames, so the wrap lands exactly where the blend expects.
 */
export function sealLoop(channels: readonly Float32Array[], rate: number, loop: readonly [number, number], blend = 0.01): [number, number] {
  const s = Math.round(loop[0] * rate);
  const e = Math.round(loop[1] * rate);
  for (const d of channels) {
    if (e > d.length || s >= e) continue;
    const m = Math.min(Math.round(blend * rate), s, e - s);
    for (let i = 0; i < m; i++) {
      const w = (i + 1) / m;
      d[e - m + i] = d[e - m + i]! * (1 - w) + d[s - m + i]! * w;
    }
    for (let j = 0; e + j < d.length && s + j < e; j++) d[e + j] = d[s + j]!;
  }
  return [s / rate, e / rate];
}

export class Orchestra {
  private manifest: Manifest | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  /** Each sustained file's loop, snapped to whole frames of its decoded buffer. */
  private readonly loops = new Map<string, [number, number]>();
  private fetching: Promise<{ manifest: Manifest; data: Map<string, ArrayBuffer> } | null> | null = null;
  private loading: Promise<boolean> | null = null;
  private rr = 0;

  constructor(private readonly base: string) {}

  /** True once every sample is decoded. */
  get loaded(): boolean {
    return this.manifest !== null;
  }

  /**
   * Downloads the manifest and every file (about 4 MB) without decoding, so it
   * can run before audio is unlocked. Safe to call more than once.
   */
  prefetch(): Promise<{ manifest: Manifest; data: Map<string, ArrayBuffer> } | null> {
    this.fetching ??= (async () => {
      try {
        const res = await fetch(`${this.base}samples.json`);
        if (!res.ok) return null;
        const manifest = (await res.json()) as Manifest;
        const files = [...new Set(Object.values(manifest.sets).flatMap((s) => s.zones.flatMap((z) => z.files)))];
        const data = new Map<string, ArrayBuffer>();
        let next = 0;
        const worker = async () => {
          while (next < files.length) {
            const file = files[next++]!;
            const r = await fetch(`${this.base}${file}`);
            if (!r.ok) throw new Error(`${file}: ${r.status}`);
            data.set(file, await r.arrayBuffer());
          }
        };
        await Promise.all(Array.from({ length: MAX_PARALLEL }, worker));
        return { manifest, data };
      } catch {
        return null;
      }
    })();
    return this.fetching;
  }

  /** Fetches (if not already) and decodes every sample. Resolves false if anything fails; the score then stays synthesized. */
  load(ctx: BaseAudioContext): Promise<boolean> {
    this.loading ??= (async () => {
      const got = await this.prefetch();
      if (!got) return false;
      try {
        await Promise.all([...got.data].map(async ([file, bytes]) => this.buffers.set(file, await ctx.decodeAudioData(bytes))));
      } catch {
        this.buffers.clear();
        return false;
      }
      for (const set of Object.values(got.manifest.sets)) {
        for (const z of set.zones) {
          if (!z.loop) continue;
          for (const f of z.files) {
            const b = this.buffers.get(f)!;
            const ch = Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
            this.loops.set(f, sealLoop(ch, b.sampleRate, z.loop));
          }
        }
      }
      this.manifest = got.manifest;
      return true;
    })();
    return this.loading;
  }

  /** The recorded sample for a score instrument at a pitch, or null to fall back to the synthesized one. */
  note(inst: string, midi: number | undefined): SampleNote | null {
    const m = this.manifest;
    const setName = m?.map[inst];
    const set = setName ? m?.sets[setName] : undefined;
    if (!m || !set) return null;
    const z = pickZone(set.zones, midi);
    if (!z || !z.files.length) return null;
    const file = z.files.length === 1 ? z.files[0]! : z.files[this.rr++ % z.files.length]!;
    const buffer = this.buffers.get(file);
    if (!buffer) return null;
    const rate = midi !== undefined && z.ref !== null ? Math.pow(2, (midi - z.ref) / 12) : 1;
    return { buffer, rate, gain: m.gain?.[inst] ?? 1, loop: this.loops.get(file) ?? null };
  }
}
