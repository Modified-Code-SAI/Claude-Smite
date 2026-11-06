/**
 * The space every sound is heard in: the shared reverb's impulse, room by
 * room. The battlefields keep the open hall they always had; each depth of the
 * Underworld Descent has a space of its own (AudioEngine.setRoom crossfades
 * between them): the forge's low, warm vault, the Drowned Halls' long wet
 * stone with its slap off the far wall, and the Abyss's vast dark that answers
 * late and echoes back from nowhere.
 */

export type Room = 'hall' | 'forge' | 'drowned' | 'abyss';

export interface RoomShape {
  /** How long the tail rings (s). */
  seconds: number;
  /** How bright the tail is as it starts and as it ends (a one-pole's coefficient, 0..1): stone stays bright, a big dark space closes over fast. */
  bright: readonly [number, number];
  /** How steeply the tail dies away (the power of what is left of it). */
  fall: number;
  /** How long the tail takes to swell in (s): a big space answers late. */
  onset: number;
  /** Clear reflections off the near walls, or echoes off far ones: (delay s, level against what the tail spreads over 10 ms there). */
  echoes: readonly (readonly [number, number])[];
  /** Loudness against the hall's, once both are matched for energy (so a long tail isn't louder only for being long): the caverns are wetter than the open maps, the forge's low vault drier. */
  level: number;
}

export const ROOMS: Record<Room, RoomShape> = {
  // the reverb every map had before rooms: a medium hall
  hall: { seconds: 2.6, bright: [0.6, 0.1], fall: 3.2, onset: 0.012, echoes: [], level: 1 },
  // the Ashen Depths: a low vault of hot rock, short and warm, the ceiling close
  forge: { seconds: 1.9, bright: [0.42, 0.08], fall: 3, onset: 0.006, echoes: [[0.019, 1.4], [0.037, 1]], level: 0.85 },
  // the Drowned Halls: long wet stone that stays bright as it rings, and a slap back off the far wall
  drowned: { seconds: 3.6, bright: [0.7, 0.22], fall: 2.6, onset: 0.012, echoes: [[0.029, 1.2], [0.053, 1], [0.083, 0.8], [0.19, 2.6]], level: 1.3 },
  // the Abyss: a space too big to see across, swelling in late and dark, a far echo or two coming back
  abyss: { seconds: 4.6, bright: [0.38, 0.06], fall: 2.3, onset: 0.045, echoes: [[0.34, 2.4], [0.69, 1.4]], level: 1.2 },
};

/** The impulse for a room (two decorrelated channels), at the context's rate. */
export function roomImpulse(shape: RoomShape, rate: number): [Float32Array, Float32Array] {
  const len = Math.round(shape.seconds * rate);
  const onset = rate * shape.onset;
  const [b0, b1] = shape.bright;
  const out = [new Float32Array(len), new Float32Array(len)] as [Float32Array, Float32Array];
  for (let ch = 0; ch < 2; ch++) {
    const d = out[ch]!;
    let lp = 0;
    let seed = ch ? 0x9e3779b9 : 0x2545f491;
    for (let i = 0; i < len; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const n = ((seed >>> 0) / 4294967296) * 2 - 1;
      const t = i / len;
      lp += (n - lp) * (b0 + (b1 - b0) * t);
      const swell = i < onset ? i / onset : 1;
      d[i] = lp * Math.pow(1 - t, shape.fall) * swell * 0.6;
    }
    // each reflection a soft spike, a little apart in the two ears so it sits round the listener, and duller the
    // further it travelled; a spike gives a sound back whole where the tail smears it, so its level is set
    // against what the tail spreads over 10 ms
    for (const [at, level] of shape.echoes) {
      const i = Math.round((at + (ch ? 0.0013 : 0)) * rate);
      const w = 3 + Math.round(at * 40 * (rate / 48000));
      if (i + w >= len) continue;
      const t = i / len;
      const c = b0 + (b1 - b0) * t;
      const tail = 0.6 * Math.sqrt(c / (2 - c) / 3) * Math.pow(1 - t, shape.fall);
      const g = level * tail * Math.sqrt(0.01 * rate);
      let sum = 0;
      for (let k = 0; k < w; k++) sum += Math.sin((Math.PI * (k + 0.5)) / w) ** 2;
      for (let k = 0; k < w; k++) d[i + k] = d[i + k]! + (g * Math.sin((Math.PI * (k + 0.5)) / w) ** 2) / sum;
    }
  }
  return out;
}

/**
 * The gain a room's reverb comes out at, so that after the convolver's own
 * normalization (it scales every impulse to the same RMS, so the energy it
 * passes grows with its length) each room is its `level` against the hall.
 */
export function roomGain(room: Room): number {
  return ROOMS[room].level * Math.sqrt(ROOMS.hall.seconds / ROOMS[room].seconds);
}
