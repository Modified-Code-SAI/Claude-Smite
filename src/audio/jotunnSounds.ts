/**
 * The Jötunn's sounds: a frost giant's palette of cracking ice, grinding
 * stone, glacier-deep thuds and a bellowing voice. Everything is built from
 * the same gestures as the gods' sounds, only bigger, lower and slower.
 */

import { ahr, Biquad, buf, crackle, fill, glide, loopable, mixIn, pink, RATE, wander, white, type Rand } from './dsp';
import { chime, debris, filter, impact, knock, layer, puff, roar, rumble, sand, shimmer, thump, vowel, whoosh } from './gestures';
import type { SkillSound } from './skillSounds';
import type { Recipe } from './sounds';

// ---------------------------------------------------------------------------
// Pieces

/** Glassy shards tinkling down: many short inharmonic bell notes, thinning out. */
function shards(r: Rand, len: number, count: number, lo = 1800, hi = 5200, gain = 1): Float32Array {
  const out = buf(len);
  for (let k = 0; k < count; k++) {
    const at = Math.pow(r(), 1.7) * len * 0.75;
    const f = lo + r() * (hi - lo);
    chime(r, 0.12 + r() * 0.28, f, { gain: (0.25 + r() * 0.75) * (1 - at / len) * gain, at, out });
  }
  return out;
}

/** Ice splitting: a hard bright snap, a short crackling run along the fracture, a low creak under it. */
function crack(r: Rand, len = 0.45, weight = 1): Float32Array {
  const out = buf(len);
  const n = white(r);
  const hp = new Biquad('highpass', 2600, 0.8);
  // the snap
  fill(out, (t) => hp.run(n()) * Math.exp(-t * 90) * 1.6 * weight, 0, 0.06);
  // the run of the crack: a burst of tiny ticks that rushes then dies
  crackle(out, r, 900 * weight, (t) => Math.exp(-t * 9), { tone: 3800, gain: 0.9, len: 0.0015 });
  crackle(out, r, 160, (t) => Math.exp(-t * 6), { tone: 1400, gain: 0.7, len: 0.004 });
  return layer([out, 1], [knock(r, 0.12, 1900 + r() * 700), 0.6], [thump(r, len * 0.8, 180, 70, { click: 0.6, noise: 0.5 }), 0.45 * weight]);
}

/** Packed snow under a huge weight: a gritty crunch. */
function crunch(r: Rand, len: number, gain = 1): Float32Array {
  return filter(sand(r, len, { tone: 1700, grains: 700, peak: 0.2, gain }), 'lowpass', 4200);
}

/** A cold wind: pink noise through a slowly wandering band. */
function gust(r: Rand, len: number, tone = 700, gain = 1): Float32Array {
  const out = buf(len);
  const n = pink(r);
  const bp = new Biquad('bandpass', tone, 1.4);
  const wob = wander(r, 1.5);
  fill(out, (t, i) => {
    if ((i & 63) === 0) bp.set(tone * (0.7 + 0.6 * wob()), 1.4);
    return bp.run(n()) * 2.2 * ahr(t, len * 0.25, len * 0.35, len * 0.4) * gain;
  });
  return out;
}

/** Breath through teeth of ice: a hissing, glittering stream that swells and fades. */
function frostHiss(r: Rand, len: number): Float32Array {
  const out = buf(len);
  const n = white(r);
  const bp = new Biquad('bandpass', 3200, 0.7);
  const lo = new Biquad('lowpass', 900, 0.7);
  const nl = pink(r);
  const wob = wander(r, 7);
  fill(out, (t) => {
    const env = ahr(t, 0.18, len * 0.55, len * 0.3);
    return (bp.run(n()) * 1.3 * (0.75 + 0.25 * wob()) + lo.run(nl()) * 1.6) * env;
  });
  crackle(out, r, 220, (t) => ahr(t, 0.2, len * 0.5, len * 0.3), { tone: 5200, gain: 0.5, len: 0.0015 });
  return layer([out, 1], [shimmer(r, len, 1320, { rise: 0.8, peak: 0.5, voices: 5 }), 0.35]);
}

/** The giant's voice: a cavernous growl, formants wide open, many voices beating. */
function bellow(r: Rand, len: number, pitch: number, open = 0.8, gain = 1): Float32Array {
  return layer([roar(r, len, pitch, { open, gain }), 1], [roar(r, len * 0.9, pitch * 1.5, { open: open * 1.2, gain: gain * 0.45 }), 1, 0.06], [rumble(r, len, { tone: 90, gain: 0.5 * gain }), 1]);
}

/** A short grunt of effort, deep in the chest. */
function grunt(r: Rand, len: number, pitch: number, gain = 1): Float32Array {
  return vowel(r, len, (t) => pitch * glide(1.15, 0.8, t, len), [[360, 4, 1], [760, 5, 0.5], [1800, 6, 0.15]], { voices: 3, detune: 0.05, growl: 0.2, breath: 0.4, env: (t) => ahr(t, 0.03, len * 0.3, len * 0.6), gain });
}

/** A mountain's worth of weight coming down: the thud, the quake rolling out, snow and stone thrown up. */
function quake(r: Rand, len: number, weight = 1): Float32Array {
  return layer(
    [thump(r, 0.9 * weight, 52, 20, { click: 0.35, noise: 0.9, drive: 2.8 }), 1],
    [impact(r, 1.6 * weight, { tone: 70, crunch: 0.6, sub: 1.6, room: 0.4 }), 0.8],
    [rumble(r, len, { tone: 120, attack: 0.02 }), 0.9],
    [debris(r, len * 0.8, { density: 16, gain: 0.45, tone: 650 }), 0.7, 0.05],
    [crunch(r, 0.5), 0.5],
  );
}

/** Many hailstones clattering down: high knocks on stone and ice. */
function hail(r: Rand, len: number, density: number): Float32Array {
  const out = buf(len);
  const count = Math.round(len * density);
  for (let k = 0; k < count; k++) {
    const at = r() * (len - 0.1);
    const s = knock(r, 0.05 + r() * 0.05, 1500 + r() * 2600);
    mixIn(out, s, at, 0.2 + r() * 0.5);
  }
  return out;
}

/** The temple horn of the frost: low, slow, a fifth under it. */
function frostHorn(r: Rand, len: number, notes: readonly number[]): Float32Array {
  const out = buf(len);
  for (const f of notes) {
    for (let k = 0; k < 3; k++) {
      const n = white(r);
      const lp = new Biquad('lowpass', 300, 1.1);
      const d = 1 + (k - 1) * 0.005;
      let ph = r();
      fill(out, (t, i) => {
        const env = ahr(t, 0.4, len * 0.4, len * 0.45);
        if ((i & 31) === 0) lp.set(240 + env * 1300, 1.1);
        ph = (ph + (f * d) / RATE) % 1;
        // a saw with breath in it
        return lp.run(ph * 2 - 1 + n() * 0.08) * env * 0.35;
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The bank (merged into SOUNDS)

export const JOTUNN_SOUNDS: Record<string, Recipe> = {
  /** A footfall: the ground shakes, snow crunches, stones skitter. */
  'step.giant': { variants: 4, peak: 0.95, make: (r) => layer([thump(r, 0.8, 48, 20, { click: 0.2, noise: 0.7, drive: 2.6 }), 1], [rumble(r, 1.3, { tone: 100, attack: 0.02 }), 0.65], [crunch(r, 0.4), 0.55, 0.02], [debris(r, 0.9, { density: 10, gain: 0.3, tone: 550 }), 0.5, 0.06]) },
  /** The club swung: a long, low rush of air with the haft creaking. */
  'basic.jotunn': { variants: 3, peak: 0.85, make: (r) => layer([whoosh(r, 0.8, 120, 480, { q: 0.8, peak: 0.6, gain: 1.7, grit: 0.6 }), 1], [grunt(r, 0.45, 62 + r() * 8, 0.6), 0.5], [knock(r, 0.2, 260), 0.25, 0.05]) },
  /** The club landing: a crunching blow, ice flying off the spikes. */
  'hit.jotunn': { variants: 3, peak: 0.95, make: (r) => layer([impact(r, 2.2, { tone: 80, crunch: 0.8, sub: 1.6, room: 0.4 }), 1], [debris(r, 0.6, { density: 18, gain: 0.4, tone: 800 }), 0.6, 0.02], [shards(r, 0.7, 10, 2000, 4800, 0.6), 0.5, 0.02]) },
  /** A blow on one of its weak points: the ice cracks. */
  'jotunn.crack': { variants: 4, peak: 0.8, make: (r) => crack(r, 0.45, 0.8) },
  /** A weak point breaks: a deep split, a burst of shards, frost hissing out. */
  'jotunn.shatter': { variants: 2, peak: 0.95, make: (r) => layer([crack(r, 0.9, 1.4), 1], [shards(r, 1.6, 40, 1500, 6000), 0.9, 0.03], [thump(r, 0.7, 90, 35, { click: 0.4, noise: 0.6, drive: 2 }), 0.7], [filter(puff(r, 1.2, { tone: 2600 }), 'highpass', 1800), 0.5, 0.08]) },
  /** A brazier smashed: iron rings and buckles, the fire chokes out in a gasp of steam. */
  'jotunn.brazier': { peak: 0.95, make: (r) => layer([impact(r, 2, { tone: 90, crunch: 1, sub: 1.2, room: 0.5 }), 1], [knock(r, 0.5, 340), 0.7], [debris(r, 1.6, { density: 30, gain: 0.6, tone: 1100 }), 0.8, 0.04], [whoosh(r, 1.2, 1600, 300, { q: 0.6, peak: 0.15, gain: 1.2 }), 0.6, 0.05], [filter(puff(r, 2.2, { tone: 3200 }), 'highpass', 2200), 0.8, 0.15], [shards(r, 1.4, 16, 1400, 3600, 0.6), 0.5, 0.2]) },
  /** Both knees gone: it crashes down onto them with a groan. */
  'jotunn.kneel': { peak: 0.95, make: (r) => layer([quake(r, 1.6, 1), 1], [quake(r, 1.4, 0.8), 0.8, 0.28], [bellow(r, 2.2, 44, 0.6, 0.8), 0.7, 0.1]) },
  /** The giant falls: a long collapse, ice breaking off it as it hits the ground. */
  'jotunn.fall': { peak: 0.95, make: (r) => layer([bellow(r, 2.6, 40, 0.55, 0.9), 0.8], [quake(r, 3.5, 1.4), 1, 0.9], [debris(r, 3, { density: 40, gain: 0.7, tone: 700 }), 0.9, 1], [shards(r, 2.5, 60, 1200, 5000), 0.7, 1]) },
  /** The giant's bellow as a round starts. */
  'jotunn.roar': { peak: 0.95, make: (r) => layer([bellow(r, 3.2, 46, 0.75), 1], [gust(r, 3.4, 600, 0.7), 0.6], [shards(r, 2.4, 14, 2600, 5600, 0.4), 0.35, 0.8]) },
  /** Rearing back to strike: muscles and ice straining, a breath drawn in. */
  'jotunn.windup': { variants: 3, peak: 0.7, make: (r) => layer([filter(gust(r, 0.7, 500, 1), 'lowpass', 1400), 0.9], [grunt(r, 0.5, 50 + r() * 8, 0.5), 0.45, 0.1], [crack(r, 0.35, 0.4), 0.35, 0.2]) },
  /** A shrine taken: a cold chord swelling out of the ice. */
  'jotunn.claim': { peak: 0.85, make: (r) => layer([shimmer(r, 2.4, 330, { rise: 1.4, peak: 0.55, voices: 6 }), 1], [frostHorn(r, 2.6, [55, 82.4]), 0.8], [shards(r, 2, 18, 2200, 5200, 0.5), 0.5, 0.4]) },
  /** A weak point grows back: ice knitting together with a creak. */
  'jotunn.regrow': { peak: 0.6, make: (r) => layer([shimmer(r, 1.2, 880, { rise: 1.6, peak: 0.8, voices: 4 }), 0.8], [crack(r, 0.5, 0.35), 0.4, 0.6]) },
  /** The round's horn: deep and wintry. */
  'jotunn.horn': { peak: 0.85, make: (r) => layer([frostHorn(r, 3.2, [55, 82.4, 110]), 1], [rumble(r, 3, { tone: 80, attack: 0.4 }), 0.5]) },
  // the giant's own voice (GameAudio.voice): effort, pain, a war cry with each ultimate, and its fall
  'voice.jotunn.effort': { variants: 3, peak: 0.6, make: (r) => grunt(r, 0.45, 52 + r() * 10) },
  'voice.jotunn.hurt': { variants: 3, peak: 0.7, make: (r) => layer([grunt(r, 0.6, 66 + r() * 10, 1), 1], [roar(r, 0.6, 80, { open: 0.7, gain: 0.5 }), 0.5]) },
  'voice.jotunn.cry': { peak: 0.9, make: (r) => bellow(r, 1.8, 52, 0.85) },
  'voice.jotunn.death': { peak: 0.9, make: (r) => bellow(r, 2.4, 42, 0.6) },
};

// ---------------------------------------------------------------------------
// Skills (merged into SKILL_SOUNDS)

export const JOTUNN_SKILL_SOUNDS: Record<string, SkillSound> = {
  'jotunn.stomp': {
    // the foot comes down on the cast; spikes of ice burst up a moment later
    cast: (r) => layer([quake(r, 1.8, 1.2), 1], [crunch(r, 0.6, 1.2), 0.7]),
    impact: (r) => layer([crack(r, 0.8, 1.2), 1], [shards(r, 1.2, 24, 1600, 5000, 0.8), 0.7, 0.05]),
    impactDelay: 0.12,
  },
  'jotunn.boulder': {
    // torn up and thrown: stone grinds free, the throw grunts out; it lands far off with a crash
    cast: (r) => layer([grunt(r, 0.7, 58, 1), 0.8], [whoosh(r, 0.9, 90, 360, { q: 0.7, peak: 0.55, gain: 1.6, grit: 0.8 }), 1], [debris(r, 0.7, { density: 22, gain: 0.5, tone: 500 }), 0.7]),
    impact: (r) => layer([impact(r, 2.6, { tone: 70, crunch: 1, sub: 1.8, room: 0.5 }), 1], [debris(r, 1.6, { density: 40, gain: 0.7, tone: 700 }), 0.9, 0.03], [rumble(r, 1.6, { tone: 110 }), 0.6], [shards(r, 1, 12, 1800, 4200, 0.5), 0.4, 0.05]),
    impactDelay: 0.75,
  },
  'jotunn.slam': {
    cast: (r) => layer([quake(r, 1.6, 1), 1], [crack(r, 0.7, 1.1), 0.8, 0.03], [shards(r, 1, 16, 1600, 4800, 0.6), 0.5, 0.06]),
  },
  'jotunn.roar': {
    cast: (r) => layer([bellow(r, 2.6, 50, 0.9, 1.1), 1], [gust(r, 2.6, 900, 1), 0.7, 0.1], [shards(r, 2, 26, 2200, 6000, 0.5), 0.45, 0.3]),
  },
  'jotunn.frost-breath': {
    cast: (r) => layer([bellow(r, 0.7, 60, 0.9, 0.6), 0.6], [frostHiss(r, 2.4), 1, 0.12]),
    tick: (r) => layer([crack(r, 0.3, 0.5), 0.6], [shards(r, 0.5, 8, 2600, 5600, 0.5), 0.6]),
  },
  'jotunn.avalanche': {
    // the wall of ice comes crashing down the whole line
    cast: (r) => layer([bellow(r, 1, 54, 0.8, 0.7), 0.6], [rumble(r, 3.4, { tone: 140, attack: 0.3 }), 1], [debris(r, 3, { density: 60, gain: 0.8, tone: 750 }), 1, 0.25], [crack(r, 1, 1.4), 0.8, 0.3], [shards(r, 2.6, 50, 1400, 5200, 0.8), 0.8, 0.35]),
  },
  'jotunn.hailstorm': {
    cast: (r) => layer([gust(r, 2.2, 520, 1.2), 1], [frostHorn(r, 1.8, [49, 73.4]), 0.4]),
    zone: (r) => loopable(layer([gust(r, 3.6, 650, 0.6), 0.8], [hail(r, 3.6, 90), 1]), 0.6),
    tick: (r) => layer([hail(r, 0.5, 60), 1], [crack(r, 0.3, 0.4), 0.4]),
  },
};
