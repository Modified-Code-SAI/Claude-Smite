/**
 * Every skill's own sounds: what it sounds like when cast, while it travels
 * or lingers, and when it lands. Each god has a sonic palette (Zeus crackles
 * and booms, Thor rings steel and thunder, Odin sings runes and war horns,
 * Loki whispers smoke and steel, Anubis hisses sand and wails like the dead)
 * and each skill is a distinct arrangement of it.
 */

import { ahr, bell, buf, fill, glide, Osc, perc, type Rand } from './dsp';
import {
  buzz, chime, choir, clang, debris, filter, fire, impact, knock, layer, puff, roar, rumble, sand, shape, shimmer, thump, thunder, twang, vowel, VOWELS, whoosh, zap,
} from './gestures';
import { JOTUNN_SKILL_SOUNDS } from './jotunnSounds';
import type { Recipe } from './sounds';

export interface SkillSound {
  cast: Recipe['make'];
  /** Loop while the skill's projectile flies. */
  travel?: Recipe['make'];
  /** Where it lands: projectile hits, leap landings, or the area of an instant skill. */
  impact?: Recipe['make'];
  /** Loop while the skill's lingering area lasts. */
  zone?: Recipe['make'];
  /** Each damage tick of a lingering area. */
  tick?: Recipe['make'];
  /** Seconds after the cast that an instant area's impact plays (0 = with the cast). */
  impactDelay?: number;
}

// ---------------------------------------------------------------------------
// Shared pieces

const bolt = (r: Rand, len = 0.35, pitch = 1): Float32Array =>
  layer([zap(r, len, 260 * pitch, { chaos: 0.9, fall: 0.4, hiss: 1.2 }), 0.9], [thunder(r, len * 1.6, { crack: 1.2, rumble: 0.3 }), 0.8]);

const boom = (r: Rand, len = 1.6, crack = 1, rumbleAmt = 1): Float32Array =>
  layer([thunder(r, len, { crack, rumble: rumbleAmt }), 1], [thump(r, 0.7, 90, 30, { click: 0.5, noise: 0.8, drive: 2.5 }), 0.8]);

const hum = (r: Rand, len: number, f: number, crackle = 1): Float32Array =>
  layer([zap(r, len, f, { chaos: 0.3, fall: 1, hiss: 0.6 * crackle }), 0.6], [shimmer(r, len, f * 2, { rise: 1, peak: 0.5, voices: 4 }), 0.6]);

const metal = (r: Rand, base: number, len = 0.8): Float32Array => clang(r, len, base, { decay: len * 0.8 });

const swing = (r: Rand, len: number, lo: number, hi: number, gain = 1.3): Float32Array => whoosh(r, len, lo, hi, { q: 1.2, peak: 0.6, gain });

const runes = (r: Rand, len: number, root: number, rise = 1): Float32Array =>
  layer([choir(r, len, root, { env: (t) => ahr(t, len * 0.3, len * 0.3, len * 0.4) }), 0.7], [shimmer(r, len, root * 2, { rise, peak: 0.5 }), 0.6], [chime(r, len, root * 4), 0.35]);

const warHorn = (r: Rand, len: number, f: number): Float32Array => {
  const out = buf(len);
  for (const ratio of [1, 1.5, 2]) {
    const o = new Osc(r());
    fill(out, (t) => {
      const env = ahr(t, 0.18, len * 0.5, len * 0.35);
      return o.saw(f * ratio * (1 + Math.sin(t * 28) * 0.004)) * env * 0.3 * (ratio === 1 ? 1 : 0.5);
    });
  }
  return filter(out, 'lowpass', 1600, 0.9);
};

const dagger = (r: Rand, len = 0.16): Float32Array => layer([whoosh(r, len, 1600, 4200, { q: 2.2, peak: 0.55 }), 1], [clang(r, 0.18, 3300 + r() * 600, { decay: 0.1, gain: 0.25 }), 1]);

const smoke = (r: Rand, len = 0.6): Float32Array => layer([puff(r, len, { tone: 800 }), 1], [whoosh(r, len * 0.8, 1200, 400, { q: 0.7 }), 0.5]);

const sly = (r: Rand, len: number): Float32Array => {
  // a sucked-in, reversed shimmer: the trickster's tell
  const s = shimmer(r, len, 700, { rise: 0.6, peak: 0.85, voices: 5 });
  return layer([s, 1], [whoosh(r, len, 600, 2600, { q: 1, peak: 0.85 }), 0.5]);
};

const venom = (r: Rand, len: number): Float32Array => {
  const out = buf(len);
  const count = Math.round(len * 30);
  for (let k = 0; k < count; k++) {
    const at = r() * len * 0.9;
    const f = 250 + r() * 500;
    const d = 0.03 + r() * 0.06;
    const o = new Osc();
    fill(out, (t) => o.sine(f * (1 + t * 9)) * perc(t, 0.002, d) * 0.4, at, at + d * 1.5);
  }
  return layer([out, 1], [filter(sand(r, len, { tone: 1600, peak: 0.4 }), 'lowpass', 2500), 0.4]);
};

const wail = (r: Rand, len: number, f: number): Float32Array =>
  vowel(r, len, (t) => f * (1 + 0.2 * bell(t, len, 0.4)) * (1 + Math.sin(t * 5) * 0.02), VOWELS.oo, { voices: 3, detune: 0.03, breath: 0.25, vibrato: 0.02, env: (t) => ahr(t, len * 0.25, len * 0.3, len * 0.45) });

const gong = (r: Rand, len: number, f: number): Float32Array =>
  layer([clang(r, len, f, { decay: len, bright: 0.5, gain: 0.8 }), 1], [thump(r, 0.5, f * 1.2, f * 0.6, { click: 0.3, drive: 1.5 }), 0.6]);

const cloth = (r: Rand, len: number): Float32Array => layer([whoosh(r, len, 900, 2200, { q: 0.6, peak: 0.4, grit: 1.2 }), 1], [filter(puff(r, len, { tone: 2500 }), 'highpass', 600), 0.5]);

const loop = (b: Float32Array): Float32Array => b;

// ---------------------------------------------------------------------------
// The table

export const SKILL_SOUNDS: Record<string, SkillSound> = {
  // ===== Zeus: crackle, hum, thunder
  'zeus.arc-bolt': {
    cast: (r) => layer([bolt(r, 0.3, 1.2), 1], [whoosh(r, 0.2, 2500, 6000, { q: 1 }), 0.5]),
    travel: (r) => loop(hum(r, 1, 300, 1.4)),
    impact: (r) => layer([zap(r, 0.28, 600, { chaos: 1, hiss: 1.4 }), 1], [thunder(r, 0.5, { crack: 1, rumble: 0.2 }), 0.7]),
  },
  'zeus.storm-step': {
    cast: (r) => layer([thunder(r, 0.9, { crack: 1.4, rumble: 0.5 }), 1], [whoosh(r, 0.3, 6000, 800, { q: 0.8 }), 0.8], [zap(r, 0.4, 180, { chaos: 1.2, hiss: 1 }), 0.6]),
    impact: (r) => layer([zap(r, 0.25, 420, { chaos: 0.8, hiss: 1 }), 1], [thump(r, 0.35, 110, 40, { click: 0.5, noise: 0.5, drive: 2 }), 0.8]),
  },
  'zeus.thundering-presence': {
    cast: (r) => layer([boom(r, 1.4, 1.2, 0.7), 1], [hum(r, 1.2, 140, 1.6), 0.6], [zap(r, 0.6, 90, { chaos: 0.6, fall: 3, hiss: 0.6 }), 0.5]),
  },
  'zeus.static-discharge': {
    cast: (r) => layer([zap(r, 0.6, 80, { chaos: 0.5, fall: 6, hiss: 1.4 }), 1], [shimmer(r, 0.6, 600, { rise: 3, peak: 0.9 }), 0.6]),
    impact: (r) => layer([bolt(r, 0.4, 0.8), 1], [thump(r, 0.4, 140, 50, { click: 0.6, drive: 2 }), 0.6]),
    impactDelay: 0.25,
  },
  'zeus.aegis-of-clouds': {
    cast: (r) => layer([filter(rumble(r, 1.6, { tone: 300, attack: 0.3 }), 'lowpass', 600), 0.8], [whoosh(r, 1.4, 300, 1200, { q: 0.6, peak: 0.4 }), 0.8], [hum(r, 1.4, 220, 0.6), 0.4], [chime(r, 1.2, 880), 0.3, 0.2]),
  },
  'zeus.ball-lightning': {
    cast: (r) => layer([zap(r, 0.5, 120, { chaos: 0.4, fall: 2.5, hiss: 0.8 }), 1], [whoosh(r, 0.5, 400, 2000, { q: 0.9 }), 0.6]),
    travel: (r) => layer([hum(r, 1.2, 110, 2), 1], [zap(r, 1.2, 55, { chaos: 0.2, fall: 1, hiss: 0.2 }), 0.5]),
    impact: (r) => layer([zap(r, 0.2, 500, { chaos: 1, hiss: 1.2, gain: 0.8 }), 1], [thump(r, 0.3, 120, 45, { click: 0.5, drive: 2 }), 0.7]),
  },
  'zeus.wrath-mark': {
    cast: (r) => layer([zap(r, 0.25, 700, { chaos: 0.3, fall: 1.3, hiss: 0.6 }), 1], [whoosh(r, 0.2, 3000, 7000, { q: 1.4 }), 0.6]),
    travel: (r) => hum(r, 0.8, 660, 0.8),
    impact: (r) => layer([chime(r, 1, 1318.5), 0.7], [thunder(r, 0.6, { crack: 0.8, rumble: 0.2 }), 0.8], [zap(r, 0.2, 900, { chaos: 0.5 }), 0.5]),
  },
  'zeus.cyclone': {
    cast: (r) => layer([whoosh(r, 0.8, 200, 1400, { q: 0.8, peak: 0.7, gain: 1.4 }), 1], [zap(r, 0.4, 150, { chaos: 0.5 }), 0.4]),
    zone: (r) => layer([whoosh(r, 2.2, 400, 450, { q: 0.9, peak: 0.5, grit: 1.5 }), 1], [whoosh(r, 2.2, 900, 800, { q: 1.5, peak: 0.5, grit: 2 }), 0.7]),
    tick: (r) => zap(r, 0.18, 380, { chaos: 0.8, hiss: 1, gain: 0.7 }),
  },
  'zeus.skyfall-storm': {
    cast: (r) => layer([rumble(r, 1.5, { tone: 200, attack: 0.5 }), 1], [whoosh(r, 1.5, 200, 1500, { q: 0.6, peak: 0.9 }), 0.6], [zap(r, 1, 70, { chaos: 0.3, fall: 2 }), 0.4]),
    zone: (r) => layer([rumble(r, 2.5, { tone: 250 }), 0.8], [filter(sand(r, 2.5, { tone: 1500, peak: 0.5, grains: 300 }), 'lowpass', 3000), 0.5]),
    tick: (r) => boom(r, 1.4, 1.6, 0.7),
  },
  'zeus.olympian-spear': {
    cast: (r) => layer([zap(r, 0.7, 60, { chaos: 0.2, fall: 8, hiss: 1.2 }), 0.7], [boom(r, 2.4, 1.8, 1.2), 1, 0.35], [whoosh(r, 0.7, 6000, 300, { q: 0.7 }), 0.8, 0.3]),
    // the ultimate lands like a thunderbolt hitting the ground
    impact: (r) => layer([thunder(r, 1.4, { crack: 1.4, rumble: 0.9 }), 1], [boom(r, 1.6, 1.4, 1), 0.8], [zap(r, 0.3, 520, { chaos: 1, hiss: 1.4 }), 0.6]),
    impactDelay: 0.4,
  },
  'zeus.ascension': {
    cast: (r) => layer([whoosh(r, 1.4, 200, 6000, { q: 0.7, peak: 0.85, gain: 1.4 }), 1], [choir(r, 2, 293.7, { env: (t) => ahr(t, 0.6, 0.6, 0.8) }), 0.5], [zap(r, 1.2, 80, { chaos: 0.4, fall: 4 }), 0.4]),
    zone: (r) => layer([rumble(r, 3, { tone: 220 }), 0.7], [hum(r, 3, 160, 1.5), 0.6]),
    tick: (r) => bolt(r, 0.5, 0.9),
  },

  // ===== Thor: steel, weight, thunder
  'thor.hammer-throw': {
    cast: (r) => layer([swing(r, 0.4, 250, 900), 1], [zap(r, 0.25, 160, { hiss: 0.5, gain: 0.5 }), 1, 0.1]),
    travel: (r) => {
      // the hammer spinning end over end: pulsing low whoosh
      const w = whoosh(r, 1, 350, 350, { q: 0.9, peak: 0.5, grit: 0.5 });
      return shape(w, (t) => 0.4 + 0.6 * Math.abs(Math.sin(t * Math.PI * 9)));
    },
    impact: (r) => layer([metal(r, 520, 0.7), 0.7], [thump(r, 0.4, 130, 45, { click: 0.8, drive: 3 }), 1]),
  },
  'thor.tempest-leap': {
    cast: (r) => layer([whoosh(r, 0.6, 200, 1500, { q: 0.8, peak: 0.6, gain: 1.4 }), 1], [vowel(r, 0.4, (t) => glide(160, 130, t, 0.4), VOWELS.ah, { breath: 0.3, gain: 0.5 }), 0.5]),
    impact: (r) => layer([boom(r, 1.6, 1.2, 1), 1], [debris(r, 0.9, { density: 25, gain: 0.5 }), 0.8]),
  },
  'thor.mjolnir-slam': {
    cast: (r) => layer([swing(r, 0.32, 300, 700), 0.8], [thump(r, 0.8, 80, 28, { click: 1, noise: 1, drive: 3 }), 1, 0.2], [metal(r, 330, 1), 0.5, 0.2], [thunder(r, 1.2, { crack: 1, rumble: 0.7 }), 0.7, 0.2]),
  },
  'thor.berserker-spin': {
    cast: (r) => {
      const spin = whoosh(r, 1.2, 350, 900, { q: 1, peak: 0.5, gain: 1.4 });
      return layer([shape(spin, (t) => 0.35 + 0.65 * Math.abs(Math.sin(t * Math.PI * 2.6))), 1], [vowel(r, 0.6, (t) => glide(150, 190, t, 0.6), VOWELS.ah, { breath: 0.3, gain: 0.4 }), 0.5]);
    },
    impact: (r) => layer([metal(r, 600, 0.4), 0.6], [thump(r, 0.25, 140, 55, { click: 0.6 }), 0.8]),
  },
  'thor.lightning-dash': {
    cast: (r) => layer([whoosh(r, 0.45, 300, 2500, { q: 0.8, gain: 1.4 }), 1], [zap(r, 0.4, 140, { chaos: 0.8, hiss: 1 }), 0.7], [thunder(r, 0.8, { crack: 1, rumble: 0.4 }), 0.6]),
    impact: (r) => layer([thump(r, 0.35, 120, 45, { click: 0.9, drive: 3 }), 1], [zap(r, 0.2, 400), 0.5]),
  },
  'thor.thunder-guard': {
    cast: (r) => layer([metal(r, 260, 1.4), 0.7], [hum(r, 1.4, 120, 1.2), 0.7], [thump(r, 0.4, 100, 50, { drive: 2 }), 0.6]),
  },
  'thor.call-of-asgard': {
    cast: (r) => layer([vowel(r, 1, (t) => glide(130, 170, t, 0.4), VOWELS.ah, { voices: 3, detune: 0.03, breath: 0.25, growl: 0.05, gain: 0.8 }), 1], [thunder(r, 1.4, { crack: 0.5, rumble: 1 }), 0.6, 0.15], [warHorn(r, 1.2, 110), 0.4]),
  },
  'thor.storm-chain': {
    cast: (r) => layer([zap(r, 0.3, 240, { chaos: 0.8, hiss: 1 }), 1], [metal(r, 1400, 0.3), 0.3]),
    travel: (r) => layer([hum(r, 0.8, 240, 1.4), 1], [shape(debris(r, 0.8, { density: 50, gain: 0.4, tone: 3000 }), () => 1), 0.4]),
    impact: (r) => layer([metal(r, 900, 0.6), 0.6], [zap(r, 0.4, 330, { chaos: 0.9, hiss: 1.2 }), 0.8], [thump(r, 0.3, 120, 50), 0.6]),
  },
  'thor.anvil-of-dawn': {
    cast: (r) => layer([whoosh(r, 1, 150, 4000, { q: 0.7, peak: 0.7, gain: 1.4 }), 1], [vowel(r, 0.8, (t) => glide(140, 200, t, 0.8), VOWELS.ah, { voices: 3, breath: 0.3, gain: 0.6 }), 0.5]),
    impact: (r) => layer([boom(r, 2.6, 2, 1.4), 1], [metal(r, 220, 2), 0.5], [debris(r, 1.8, { density: 35, gain: 0.6 }), 0.9, 0.05]),
  },
  'thor.worldbreaker': {
    cast: (r) => layer([swing(r, 0.4, 200, 600), 0.7], [thump(r, 1.2, 60, 22, { click: 1, noise: 1, drive: 3 }), 1, 0.25], [rumble(r, 2.4, { tone: 170 }), 0.9, 0.25], [debris(r, 2, { density: 40, gain: 0.6, tone: 700 }), 1, 0.3]),
  },
  'thor.thunder-god': {
    cast: (r) => layer([boom(r, 2.6, 2, 1.5), 1], [vowel(r, 1.4, (t) => glide(120, 160, t, 1), VOWELS.ah, { voices: 4, detune: 0.03, breath: 0.25, growl: 0.06, gain: 0.7 }), 0.6], [hum(r, 2, 110, 2), 0.5]),
  },

  // ===== Odin: spear, ravens, runes, horns
  'odin.spear-thrust': {
    cast: (r) => layer([whoosh(r, 0.26, 600, 2400, { q: 2, peak: 0.6, gain: 1.4 }), 1], [metal(r, 1100, 0.4), 0.3, 0.12]),
    impact: (r) => layer([thump(r, 0.25, 160, 60, { click: 0.9 }), 1], [metal(r, 1500, 0.3), 0.35]),
    impactDelay: 0.1,
  },
  'odin.ravens': {
    cast: (r) => layer([ravens(r, 0.9, 3), 1], [whoosh(r, 0.6, 500, 1500, { q: 0.6, grit: 2 }), 0.6]),
    travel: (r) => {
      // wingbeats
      const w = whoosh(r, 1, 500, 500, { q: 0.6, peak: 0.5 });
      return layer([shape(w, (t) => Math.max(0, Math.sin(t * Math.PI * 12)) ** 2), 1], [ravens(r, 1, 1), 0.3]);
    },
    impact: (r) => layer([ravens(r, 0.5, 2), 0.7], [thump(r, 0.2, 200, 80, { click: 0.6, noise: 0.6 }), 0.8]),
  },
  'odin.war-cry': {
    cast: (r) => layer([vowel(r, 1.1, (t) => glide(110, 150, t, 0.5), VOWELS.ah, { voices: 4, detune: 0.03, breath: 0.25, growl: 0.06, gain: 0.9 }), 1], [warHorn(r, 1.4, 146.8), 0.5], [thump(r, 0.5, 70, 30, { drive: 2 }), 0.5]),
  },
  'odin.lunge': {
    cast: (r) => layer([whoosh(r, 0.4, 400, 2200, { q: 1.4, gain: 1.4 }), 1], [vowel(r, 0.3, (t) => glide(150, 120, t, 0.3), VOWELS.ah, { breath: 0.4, gain: 0.4 }), 0.5]),
    impact: (r) => layer([thump(r, 0.3, 150, 50, { click: 0.9, drive: 2.5 }), 1], [metal(r, 1250, 0.4), 0.35]),
  },
  'odin.gungnir-sweep': {
    cast: (r) => layer([whoosh(r, 0.5, 300, 1500, { q: 1.1, peak: 0.55, gain: 1.6 }), 1], [runes(r, 0.8, 220, 1.3), 0.4]),
    impact: (r) => layer([thump(r, 0.4, 120, 45, { click: 0.8, drive: 3 }), 1], [whoosh(r, 0.3, 1500, 500, { q: 0.8 }), 0.6]),
    impactDelay: 0.15,
  },
  'odin.wisdom': {
    cast: (r) => layer([runes(r, 1.6, 293.7, 1.5), 1], [waterPour(r, 1.2), 0.5]),
  },
  'odin.rune-ward': {
    cast: (r) => layer([runes(r, 1.6, 220, 1.2), 1], [metal(r, 440, 1.4), 0.4], [thump(r, 0.4, 90, 45, { drive: 1.5 }), 0.5]),
  },
  'odin.einherjar': {
    cast: (r) => layer([warHorn(r, 1.6, 98), 0.8], [choir(r, 1.8, 196, { vowelName: 'oh', env: (t) => ahr(t, 0.5, 0.6, 0.7) }), 0.6], [thump(r, 0.6, 80, 30, { drive: 2 }), 0.7, 0.4], [metal(r, 700, 0.5), 0.3, 0.45]),
    zone: (r) => layer([filter(debris(r, 2, { density: 18, gain: 0.5, tone: 1600 }), 'lowpass', 4000), 1], [choir(r, 2, 196, { vowelName: 'oh', env: () => 1, gain: 0.3 }), 0.4]),
    tick: (r) => layer([metal(r, 900 + r() * 400, 0.3), 0.6], [whoosh(r, 0.2, 700, 1800, { q: 1.4 }), 0.6]),
  },
  'odin.ring-of-spears': {
    cast: (r) => {
      // spears hammer into the ground all around, one after another
      const parts: [Float32Array, number, number][] = [];
      for (let k = 0; k < 8; k++) parts.push([layer([thump(r, 0.3, 140, 60, { click: 1 }), 1], [metal(r, 900 + k * 60, 0.3), 0.3]), 0.7, 0.15 + k * 0.06]);
      return layer([warHorn(r, 1.2, 110), 0.5], [runes(r, 1.4, 146.8, 1.2), 0.4], ...parts);
    },
    zone: (r) => runes(r, 2.5, 146.8, 1),
    tick: (r) => metal(r, 1200, 0.4),
  },
  'odin.valhallas-call': {
    cast: (r) => layer([warHorn(r, 2.4, 73.4), 1], [warHorn(r, 2.2, 110), 0.5, 0.25], [choir(r, 2.6, 293.7, { env: (t) => ahr(t, 0.8, 0.8, 1) }), 0.6], [boom(r, 1.8, 0.4, 1), 0.5]),
  },
  'odin.all-seeing-eye': {
    cast: (r) => layer([runes(r, 2.4, 110, 2), 1], [gong(r, 2.4, 82.4), 0.6], [whoosh(r, 2, 200, 3000, { q: 0.6, peak: 0.8 }), 0.4]),
  },

  // ===== Loki: steel, smoke, venom, tricks
  'loki.dagger-fan': {
    cast: (r) => layer([dagger(r, 0.18), 1], [dagger(r, 0.18), 0.8, 0.03], [dagger(r, 0.18), 0.8, 0.06], [dagger(r, 0.18), 0.7, 0.09], [dagger(r, 0.18), 0.7, 0.12]),
    impact: (r) => layer([thump(r, 0.15, 220, 90, { click: 0.6, noise: 0.5 }), 1, 0.12], [thump(r, 0.15, 200, 80, { click: 0.6, noise: 0.5 }), 0.8, 0.18], [metal(r, 2800, 0.15), 0.25, 0.12]),
    impactDelay: 0.1,
  },
  'loki.vanish': { cast: (r) => layer([smoke(r, 0.8), 1], [sly(r, 0.6), 0.7]) },
  'loki.decoy': {
    cast: (r) => layer([smoke(r, 0.6), 0.8], [laugh(r), 0.6, 0.1]),
    impact: (r) => layer([boom(r, 1.2, 0.6, 0.6), 1], [smoke(r, 0.8), 0.8]),
    impactDelay: 2,
  },
  'loki.poison-blade': {
    cast: (r) => layer([metal(r, 1800, 0.6), 0.5], [whoosh(r, 0.3, 1800, 3800, { q: 2 }), 0.7], [venom(r, 0.8), 0.8]),
  },
  'loki.backstab': {
    cast: (r) => layer([sly(r, 0.3), 1], [whoosh(r, 0.2, 5000, 1000, { q: 0.8 }), 0.6]),
    travel: (r) => filter(whoosh(r, 0.8, 1800, 1800, { q: 1.5, peak: 0.5 }), 'highpass', 800),
    impact: (r) => layer([thump(r, 0.3, 150, 55, { click: 1, noise: 0.6, drive: 2.5 }), 1], [metal(r, 2200, 0.5), 0.5], [whoosh(r, 0.15, 2000, 4500, { q: 2 }), 0.7]),
  },
  'loki.tricksters-mark': {
    cast: (r) => layer([dagger(r, 0.2), 1], [sly(r, 0.4), 0.5]),
    travel: (r) => whoosh(r, 0.8, 2600, 2600, { q: 3, peak: 0.5 }),
    impact: (r) => layer([thump(r, 0.2, 200, 80, { click: 0.7 }), 1], [chime(r, 0.8, 1108.7), 0.4], [laugh(r), 0.3, 0.05]),
  },
  'loki.smoke-bomb': {
    cast: (r) => layer([whoosh(r, 0.4, 800, 1600, { q: 1 }), 0.7], [twang(r, 0.3, 300, 0.4), 0.3]),
    impact: (r) => layer([thump(r, 0.6, 110, 40, { click: 0.6, noise: 0.8, drive: 2 }), 1], [smoke(r, 1.4), 1], [crackleHiss(r, 1.2), 0.4]),
    impactDelay: 0.35,
  },
  'loki.shapeshift': {
    cast: (r) => layer([smoke(r, 0.6), 0.8], [vowel(r, 0.45, (t) => glide(700, 1100, t, 0.45), VOWELS.eh, { breath: 0.4, gain: 0.5, env: (t) => perc(t, 0.02, 0.4) }), 0.6, 0.15], [sly(r, 0.5), 0.5]),
  },
  'loki.assassinate': {
    cast: (r) => layer([sly(r, 0.5), 1], [smoke(r, 0.6), 0.7], [vowel(r, 0.8, () => 82.4, VOWELS.oo, { voices: 3, detune: 0.04, breath: 0.4, gain: 0.5 }), 0.5]),
    travel: (r) => filter(whoosh(r, 0.8, 900, 900, { q: 1, peak: 0.5, grit: 1 }), 'lowpass', 2000),
    impact: (r) => layer([thump(r, 0.6, 110, 35, { click: 1, noise: 1, drive: 3 }), 1], [metal(r, 1700, 0.9), 0.6], [whoosh(r, 0.2, 2500, 5000, { q: 1.5 }), 0.7], [darkHit(r, 1.4), 0.6]),
  },
  'loki.mirror-legion': {
    cast: (r) => layer([smoke(r, 0.8), 0.7], [smoke(r, 0.8), 0.6, 0.12], [smoke(r, 0.8), 0.6, 0.24], [laugh(r), 0.6, 0.15], [sly(r, 0.8), 0.4]),
    tick: (r) => dagger(r, 0.14),
  },
  'loki.ragnarok-rift': {
    cast: (r) => layer([sly(r, 0.9), 0.6], [rumble(r, 1.6, { tone: 160, attack: 0.4 }), 1], [fire(r, 1.6, { gain: 0.6, roar: 2 }), 1, 0.4], [darkHit(r, 1.8), 0.6, 0.4]),
    zone: (r) => layer([fire(r, 2.5, { gain: 0.7, roar: 2 }), 1], [vowel(r, 2.5, (t) => 73.4 * (1 + Math.sin(t * 1.5) * 0.03), VOWELS.oo, { voices: 3, breath: 0.3, env: () => 1, gain: 0.3 }), 0.6]),
    tick: (r) => layer([fire(r, 0.4, { gain: 0.6 }), 1], [thump(r, 0.3, 110, 45, { noise: 0.6 }), 0.6]),
  },

  // ===== Anubis: sand, locusts, wraps, the dead
  'anubis.soul-shield': {
    cast: (r) => layer([wail(r, 1.2, 330), 0.6], [shimmer(r, 1.2, 440, { rise: 1.3, peak: 0.4 }), 0.7], [gong(r, 1.4, 164.8), 0.4]),
  },
  'anubis.locust-swarm': {
    cast: (r) => layer([buzz(r, 1.8, 190, { voices: 14, env: (t) => ahr(t, 0.12, 1, 0.6) }), 1], [sand(r, 0.8, { tone: 2600 }), 0.4]),
    impact: (r) => layer([buzz(r, 0.6, 230, { voices: 8, env: (t) => perc(t, 0.02, 0.6), gain: 0.6 }), 1], [sand(r, 0.5, { tone: 1800 }), 0.5], [thump(r, 0.25, 120, 60, { noise: 0.5 }), 0.5]),
    impactDelay: 0.25,
  },
  'anubis.mummify': {
    cast: (r) => layer([cloth(r, 0.5), 1], [wail(r, 0.7, 220), 0.4]),
    impact: (r) => layer([thump(r, 0.3, 140, 60, { click: 0.4, noise: 0.6 }), 1], [cloth(r, 0.3), 0.6], [gong(r, 1, 196), 0.35]),
    impactDelay: 0.15,
  },
  'anubis.scales-of-maat': {
    cast: (r) => layer([gong(r, 1.8, 130.8), 0.8], [chime(r, 1.4, 523.3), 0.5, 0.2], [sand(r, 1.2, { tone: 1800, peak: 0.6 }), 0.5]),
    impact: (r) => layer([fire(r, 0.8, { gain: 0.5 }), 0.6], [shimmer(r, 0.8, 660, { rise: 1.2, peak: 0.2 }), 0.6], [thump(r, 0.4, 100, 45, { click: 0.3, drive: 2 }), 0.8]),
    impactDelay: 0.3,
  },
  'anubis.grave-grasp': {
    cast: (r) => layer([wail(r, 0.6, 196), 0.6], [sand(r, 0.5, { tone: 1400, peak: 0.2 }), 0.7]),
    travel: (r) => layer([wail(r, 1, 165), 0.6], [sand(r, 1, { tone: 1400, peak: 0.5 }), 0.5]),
    impact: (r) => layer([thump(r, 0.35, 110, 45, { click: 0.6, noise: 0.6, drive: 2 }), 1], [cloth(r, 0.4), 0.6], [whoosh(r, 0.4, 2400, 400, { q: 0.8 }), 0.6, 0.05]),
  },
  'anubis.sand-step': {
    cast: (r) => layer([sand(r, 0.9, { tone: 2200, peak: 0.3, gain: 1.2 }), 1], [whoosh(r, 0.6, 400, 1800, { q: 0.8 }), 0.7]),
  },
  'anubis.jackal-howl': {
    cast: (r) =>
      layer(
        [vowel(r, 1.5, (t) => glide(300, 520, t, 0.5) * (t > 0.9 ? glide(1, 0.75, t - 0.9, 0.6) : 1), VOWELS.oo, { voices: 2, detune: 0.01, breath: 0.15, vibrato: 0.02, env: (t) => ahr(t, 0.15, 0.9, 0.45) }), 1],
        [vowel(r, 1.3, (t) => glide(450, 700, t, 0.5), VOWELS.oo, { breath: 0.1, vibrato: 0.025, env: (t) => ahr(t, 0.2, 0.7, 0.4) }), 0.4, 0.15],
      ),
  },
  'anubis.embalm': {
    cast: (r) => layer([cloth(r, 0.8), 0.7], [shimmer(r, 1.4, 392, { rise: 1.2, peak: 0.5 }), 0.7], [choir(r, 1.4, 196, { vowelName: 'oo', env: (t) => ahr(t, 0.4, 0.4, 0.6) }), 0.4]),
  },
  'anubis.death-gaze': {
    cast: (r) => layer([gong(r, 1.2, 98), 0.6], [wail(r, 1.2, 147), 0.6]),
    zone: (r) => layer([zap(r, 2, 73.4, { chaos: 0.1, fall: 1, hiss: 0.2 }), 0.5], [wail(r, 2, 110), 0.6], [sand(r, 2, { tone: 2600, peak: 0.5, grains: 1200 }), 0.6]),
    tick: (r) => layer([sand(r, 0.25, { tone: 3000, peak: 0.1 }), 1], [thump(r, 0.2, 130, 60), 0.6]),
  },
  'anubis.sandstorm': {
    cast: (r) => layer([whoosh(r, 1.6, 150, 1200, { q: 0.5, peak: 0.7, gain: 1.4 }), 1], [wail(r, 1.8, 110), 0.5], [gong(r, 2, 73.4), 0.4]),
    zone: (r) => layer([sand(r, 2.5, { tone: 1600, peak: 0.5, grains: 2000, gain: 1.4 }), 1], [whoosh(r, 2.5, 300, 320, { q: 0.5, peak: 0.5, grit: 2 }), 0.8]),
    tick: (r) => sand(r, 0.35, { tone: 2600, peak: 0.15 }),
  },
  'anubis.judgment': {
    cast: (r) => layer([gong(r, 3, 65.4), 1], [choir(r, 3, 196, { env: (t) => ahr(t, 0.8, 1, 1.2) }), 0.7], [choir(r, 3, 293.7, { vowelName: 'oh', env: (t) => ahr(t, 1, 0.8, 1.2) }), 0.4], [shimmer(r, 2.4, 587.3, { rise: 1.5, peak: 0.6 }), 0.5]),
  },
  // ===== Thanatos: beating wings, cold fire, dark iron, a slow heart and Sleep's low lullaby
  'thanatos.pitiless-edge': {
    cast: (r) => layer([swing(r, 0.28, 500, 3000, 1.5), 1], [metal(r, 1800, 0.35), 0.25, 0.04], [swing(r, 0.3, 600, 3400, 1.4), 0.9, 0.3], [metal(r, 2100, 0.35), 0.22, 0.34]),
    impact: (r) => layer([thump(r, 0.22, 170, 60, { click: 0.9, noise: 0.4 }), 1], [metal(r, 1500, 0.3), 0.2]),
  },
  'thanatos.snuff-out': {
    cast: (r) => layer([thump(r, 0.3, 120, 45, { click: 0.5, drive: 1.5 }), 0.8], [coldFire(r, 0.9), 1], [whoosh(r, 0.6, 2400, 300, { q: 0.7, peak: 0.2, gain: 1.2 }), 0.7, 0.05], [puff(r, 0.5, { tone: 600 }), 0.6, 0.35]),
  },
  'thanatos.wingbeat': {
    cast: (r) => layer([wingFlap(r, 0.6, 1.3), 1], [whoosh(r, 0.6, 300, 1800, { q: 0.8, peak: 0.35, gain: 1.3 }), 0.8, 0.05]),
    impact: (r) => layer([thump(r, 0.25, 150, 55, { click: 0.6, noise: 0.6 }), 0.9], [wingFlap(r, 0.35, 0.7), 0.5]),
  },
  'thanatos.claim': {
    cast: (r) => layer([cloth(r, 0.45), 0.9], [whoosh(r, 0.4, 700, 2600, { q: 1.2, peak: 0.25 }), 0.7], [lullaby(r, 0.7, 196), 0.25]),
    travel: (r) => layer([filter(whoosh(r, 0.8, 900, 900, { q: 1.2, peak: 0.5, grit: 1.2 }), 'bandpass', 1100, 0.9), 1], [lullaby(r, 0.8, 174.6), 0.2]),
    impact: (r) => layer([thump(r, 0.3, 140, 50, { click: 0.6, noise: 0.5 }), 1], [cloth(r, 0.5), 0.8], [whoosh(r, 0.4, 2400, 500, { q: 0.9, peak: 0.6 }), 0.7, 0.05]),
  },
  'thanatos.veil-of-night': {
    cast: (r) => layer([wingFlap(r, 0.5, 0.8), 0.8], [whoosh(r, 1.2, 1600, 200, { q: 0.5, peak: 0.15 }), 0.8], [lullaby(r, 1.2, 130.8), 0.45, 0.1], [shimmer(r, 1, 523.3, { rise: 0.5, peak: 0.1 }), 0.3]),
  },
  'thanatos.poppy-haze': {
    cast: (r) => layer([puff(r, 0.8, { tone: 1400 }), 0.8], [whoosh(r, 1, 300, 1400, { q: 0.5, peak: 0.6 }), 0.7], [lullaby(r, 1.6, 220), 0.5, 0.2]),
    zone: (r) => layer([filter(puff(r, 2.5, { tone: 900 }), 'lowpass', 1800), 0.6], [lullaby(r, 2.5, 196), 0.5], [shimmer(r, 2.5, 392, { rise: 1, peak: 0.5, voices: 3 }), 0.25]),
    tick: (r) => layer([puff(r, 0.3, { tone: 1200 }), 0.6], [thump(r, 0.2, 110, 50, { noise: 0.3 }), 0.4]),
  },
  'thanatos.iron-heart': {
    cast: (r) => layer([clang(r, 1.4, 196, { decay: 1.2, bright: 0.25, gain: 0.8 }), 0.8], [heartbeat(r, 1.4), 1, 0.15], [darkHit(r, 1), 0.4]),
  },
  'thanatos.final-rest': {
    cast: (r) => layer([swing(r, 0.6, 250, 1600, 1.6), 1], [lullaby(r, 1.2, 146.8), 0.5], [metal(r, 1250, 0.6), 0.3, 0.3]),
    impact: (r) => layer([impact(r, 0.9, { tone: 120, snap: 0.6, crunch: 0.2, room: 0.5 }), 1], [heartbeat(r, 1, 0.5), 0.6, 0.1], [choir(r, 1.4, 110, { vowelName: 'oo', env: (t) => ahr(t, 0.1, 0.4, 0.9) }), 0.4]),
    impactDelay: 0.15,
  },
  'thanatos.long-sleep': {
    cast: (r) => layer([wingFlap(r, 1, 1.6), 0.9], [lullaby(r, 3, 130.8), 0.8, 0.2], [lullaby(r, 3, 196), 0.5, 0.4], [whoosh(r, 2.2, 2600, 150, { q: 0.4, peak: 0.5 }), 0.5]),
    impact: (r) => layer([gong(r, 2.4, 55), 0.7], [heartbeat(r, 2, 0.4), 0.8], [choir(r, 2.6, 98, { vowelName: 'oo', env: (t) => ahr(t, 0.4, 1, 1.2) }), 0.6]),
    impactDelay: 0.6,
  },
  'thanatos.kiss-of-death': {
    cast: (r) => layer([wingFlap(r, 0.7, 1.8), 1], [whoosh(r, 0.9, 200, 2800, { q: 0.7, peak: 0.4, gain: 1.6 }), 0.9, 0.05], [choir(r, 1.2, 82.4, { vowelName: 'oo', env: (t) => ahr(t, 0.1, 0.4, 0.7) }), 0.5]),
    impact: (r) => layer([impact(r, 1.3, { tone: 110, snap: 1, crunch: 0.4, room: 0.6 }), 1], [metal(r, 900, 0.8), 0.3], [heartbeat(r, 1.2, 0.3), 0.6, 0.15]),
  },
  'thanatos.carried-home': {
    cast: (r) => layer([wingFlap(r, 0.8, 1.6), 1], [wingFlap(r, 0.8, 1.4), 0.8, 0.45], [choir(r, 2.6, 196, { vowelName: 'ah', env: (t) => ahr(t, 0.6, 1, 1) }), 0.5, 0.2], [shimmer(r, 2.2, 392, { rise: 1.3, peak: 0.5 }), 0.4, 0.3]),
    impact: (r) => layer([thump(r, 0.5, 120, 45, { click: 0.4, noise: 0.6, drive: 1.5 }), 0.9], [choir(r, 1.8, 261.6, { vowelName: 'oh', env: (t) => ahr(t, 0.1, 0.6, 1) }), 0.5], [shimmer(r, 1.4, 784, { rise: 1.4, peak: 0.2 }), 0.4]),
  },
  // ===== Kukulkan: rattles and serpent hiss, clay flutes, the slit drum and the conch, jade, rain and feathers
  'kukulkan.morning-star': {
    cast: (r) => layer([flute(r, 0.5, 1046.5, 1.25), 0.7], [whoosh(r, 0.35, 900, 4200, { q: 1.4, peak: 0.3, gain: 1.2 }), 0.8], [chime(r, 0.8, 1568), 0.35, 0.05]),
    travel: (r) => layer([shimmer(r, 1, 1318.5, { rise: 1, peak: 0.5, voices: 4 }), 0.6], [filter(whoosh(r, 1, 1800, 1800, { q: 1, peak: 0.5 }), 'bandpass', 2400, 0.8), 0.5]),
    impact: (r) => layer([impact(r, 0.8, { tone: 170, snap: 0.8, room: 0.4 }), 0.9], [chime(r, 1.2, 2093), 0.45], [jade(r, 0.6, 1400), 0.4]),
  },
  'kukulkan.equinox': {
    cast: (r) => layer([slitDrum(r, 0.9, 4), 0.8], [hiss(r, 1.1), 0.8, 0.1], [whoosh(r, 1.1, 300, 1600, { q: 0.6, peak: 0.4, gain: 1.1, grit: 1.2 }), 0.7, 0.1], [flute(r, 0.9, 523.3, 0.8), 0.3, 0.25]),
  },
  'kukulkan.vision-serpent': {
    cast: (r) => layer([fire(r, 0.8, { gain: 0.5, roar: 0.4 }), 0.6], [puff(r, 1, { tone: 900 }), 0.7], [conch(r, 1.4, 146.8), 0.6, 0.15], [hiss(r, 1.2), 0.6, 0.3]),
    zone: (r) => layer([filter(puff(r, 2.5, { tone: 700 }), 'lowpass', 1500), 0.6], [shimmer(r, 2.5, 311.1, { rise: 0.6, peak: 0.5, voices: 4 }), 0.35], [hiss(r, 2.5, 0.5), 0.4]),
    tick: (r) => layer([hiss(r, 0.35), 0.6], [thump(r, 0.2, 120, 50, { noise: 0.3 }), 0.4]),
  },
  'kukulkan.constricting-coils': {
    cast: (r) => layer([hiss(r, 0.45), 0.9], [whoosh(r, 0.4, 700, 3000, { q: 1.3, peak: 0.25 }), 0.7], [jade(r, 0.4, 1100), 0.3]),
    travel: (r) => layer([hiss(r, 1, 0.6), 0.7], [filter(whoosh(r, 1, 1200, 1200, { q: 1.2, peak: 0.5 }), 'bandpass', 1500, 0.9), 0.5]),
    impact: (r) => layer([thump(r, 0.35, 150, 50, { click: 0.6, noise: 0.5 }), 1], [squeeze(r, 0.8), 0.8, 0.05], [rattle(r, 0.5, 26), 0.5, 0.1]),
  },
  'kukulkan.quetzal-flight': {
    cast: (r) => layer([wingFlap(r, 0.6, 1.1), 1], [flute(r, 0.45, 1396.9, 1.4), 0.4], [whoosh(r, 0.8, 300, 2200, { q: 0.8, peak: 0.35, gain: 1.3 }), 0.8, 0.05]),
    impact: (r) => layer([thump(r, 0.35, 140, 50, { click: 0.6, noise: 0.7 }), 1], [cloth(r, 0.5), 0.7], [wingFlap(r, 0.4, 0.7), 0.5, 0.05]),
  },
  'kukulkan.jade-mask': {
    cast: (r) => layer([jade(r, 1, 880), 0.8], [jade(r, 1, 1318.5), 0.5, 0.12], [shimmer(r, 1.2, 660, { rise: 0.8, peak: 0.3 }), 0.4], [choir(r, 1.2, 220, { vowelName: 'oh', env: (t) => ahr(t, 0.2, 0.4, 0.6) }), 0.35]),
  },
  'kukulkan.rain-of-plenty': {
    cast: (r) => layer([rumble(r, 1.2, { tone: 150, attack: 0.3 }), 0.5], [rain(r, 1.6), 1, 0.2], [flute(r, 1, 659.3, 0.9), 0.3, 0.1]),
    impact: (r) => layer([rain(r, 1.8), 0.9], [shimmer(r, 1.6, 523.3, { rise: 0.5, peak: 0.3 }), 0.4]),
    impactDelay: 0.25,
  },
  'kukulkan.rattling-plumes': {
    cast: (r) => layer([rattle(r, 0.9, 30), 1], [cloth(r, 0.6), 0.6], [hiss(r, 0.7), 0.6, 0.15], [thump(r, 0.3, 110, 45, { click: 0.4, noise: 0.5 }), 0.5]),
  },
  'kukulkan.descent': {
    cast: (r) => layer([conch(r, 1.6, 110), 0.9], [wingFlap(r, 1, 1.6), 0.7, 0.2], [rattle(r, 1.2, 24), 0.5, 0.1], [whoosh(r, 1.6, 200, 3200, { q: 0.6, peak: 0.7, gain: 1.6 }), 0.8, 0.2]),
    impact: (r) => layer([impact(r, 1.4, { tone: 95, snap: 0.9, crunch: 0.5, room: 0.7 }), 1], [slitDrum(r, 0.6, 2), 0.6], [hiss(r, 1), 0.5, 0.05]),
    impactDelay: 0.45,
  },
  'kukulkan.venus-ascendant': {
    cast: (r) => layer([conch(r, 2, 164.8), 0.7], [flute(r, 1.6, 1046.5, 1.5), 0.45, 0.3], [shimmer(r, 2.4, 1318.5, { rise: 1.6, peak: 0.6, voices: 5 }), 0.6], [choir(r, 2.2, 329.6, { vowelName: 'ah', env: (t) => ahr(t, 0.8, 0.6, 0.8) }), 0.45]),
  },
  'kukulkan.sky-coils': {
    cast: (r) => layer([conch(r, 1.4, 98), 0.7], [whoosh(r, 1.4, 2600, 300, { q: 0.5, peak: 0.6, gain: 1.4 }), 0.7], [hiss(r, 1.4), 0.6, 0.2]),
    impact: (r) => layer([thump(r, 0.6, 90, 35, { click: 0.4, noise: 0.8, drive: 2 }), 1], [squeeze(r, 1.6), 0.9, 0.1], [rattle(r, 1.4, 22), 0.5, 0.3], [slitDrum(r, 0.6, 2), 0.4, 0.05]),
    tick: (r) => layer([squeeze(r, 0.4), 0.7], [thump(r, 0.25, 100, 40, { noise: 0.4 }), 0.5]),
    impactDelay: 0.5,
  },
  // ===== Cthulhu: wet flesh and bubbles from the sea floor, a drowned chorus a tritone apart, the swell and a voice from very far down
  'cthulhu.prodigious-claws': {
    cast: (r) => layer([swing(r, 0.32, 220, 1500, 1.7), 1], [swing(r, 0.32, 260, 1700, 1.6), 0.9, 0.3]),
    impact: (r) => layer([squelch(r, 0.4), 1], [impact(r, 0.9, { tone: 105, snap: 0.5, crunch: 0.35 }), 0.7]),
  },
  'cthulhu.reaching-feelers': {
    cast: (r) => layer([squelch(r, 0.35), 0.8], [whoosh(r, 0.4, 400, 1800, { q: 1, peak: 0.3, grit: 1.4 }), 0.8]),
    travel: (r) => layer([filter(whoosh(r, 1, 520, 520, { q: 1.2, peak: 0.5, grit: 1.6 }), 'bandpass', 600, 1), 0.8], [bubbles(r, 1, 8), 0.5]),
    impact: (r) => layer([squelch(r, 0.5), 1], [whoosh(r, 0.5, 1500, 180, { q: 1.4, peak: 0.2, gain: 1.2 }), 0.7, 0.08], [thump(r, 0.3, 120, 45, { click: 0.3, noise: 0.4 }), 0.5]),
  },
  'cthulhu.the-call': {
    cast: (r) => layer([roar(r, 1.4, 68, { open: 0.6 }), 1], [abyss(r, 1.8, 98), 0.6, 0.1], [moan(r, 1.6, 146.8), 0.35, 0.2]),
  },
  'cthulhu.wrong-angles': {
    cast: (r) => layer([abyss(r, 1.3, 138.6), 0.7], [shimmer(r, 1.2, 466.2, { rise: 0.6, peak: 0.4, voices: 5 }), 0.5], [whoosh(r, 1, 1800, 220, { q: 0.6, peak: 0.3 }), 0.5]),
    impact: (r) => layer([impact(r, 1, { tone: 90, snap: 0.4, crunch: 0.6, room: 0.6 }), 0.9], [shimmer(r, 0.9, 311.1, { rise: 0.4, peak: 0.1, voices: 5 }), 0.5]),
    impactDelay: 0.2,
  },
  'cthulhu.narrow-wings': {
    cast: (r) => layer([wingFlap(r, 0.7, 1.7), 1], [squelch(r, 0.3), 0.4], [whoosh(r, 0.8, 200, 1600, { q: 0.7, peak: 0.35, gain: 1.4 }), 0.8, 0.05]),
    impact: (r) => layer([thump(r, 0.5, 100, 38, { click: 0.4, noise: 0.8, drive: 2 }), 1], [squelch(r, 0.4), 0.8], [bubbles(r, 0.6, 8), 0.4, 0.05]),
  },
  'cthulhu.green-ooze': {
    cast: (r) => layer([squelch(r, 0.6), 1], [bubbles(r, 1, 18), 0.8, 0.1], [moan(r, 1, 110), 0.3]),
    zone: (r) => layer([bubbles(r, 2.5, 30), 0.7], [filter(puff(r, 2.5, { tone: 500 }), 'lowpass', 900), 0.6], [abyss(r, 2.5, 73.4), 0.25]),
    tick: (r) => layer([squelch(r, 0.25), 0.7], [bubbles(r, 0.3, 3), 0.5]),
  },
  'cthulhu.rubbery-hide': {
    cast: (r) => layer([squelch(r, 0.5), 0.9], [thump(r, 0.5, 80, 35, { click: 0.1, drive: 1.6 }), 0.7], [abyss(r, 1.1, 110), 0.4, 0.1]),
  },
  'cthulhu.the-swell': {
    cast: (r) => layer([surf(r, 1.1), 1], [roar(r, 0.8, 80, { open: 0.4 }), 0.4]),
  },
  'cthulhu.stars-are-right': {
    cast: (r) => layer([abyss(r, 2.6, 73.4), 0.9], [shimmer(r, 2.2, 1244.5, { rise: 1.6, peak: 0.7, voices: 6 }), 0.45], [moan(r, 2, 98), 0.5, 0.2]),
    impact: (r) => layer([roar(r, 1.8, 60, { open: 0.8, gain: 1.2 }), 1], [impact(r, 1.4, { tone: 80, snap: 0.8, crunch: 0.5, room: 0.8 }), 0.9], [darkHit(r, 1.6), 0.6]),
    impactDelay: 0.7,
  },
  'cthulhu.rlyeh-rises': {
    cast: (r) => layer([rumble(r, 2.2, { tone: 70, attack: 0.8 }), 1], [abyss(r, 2.2, 82.4), 0.6], [surf(r, 1.8), 0.5, 0.4]),
    impact: (r) => layer([impact(r, 1.8, { tone: 70, snap: 0.9, crunch: 1, room: 0.8 }), 1], [debris(r, 1.2, { density: 18, gain: 0.6, tone: 600 }), 0.8, 0.05], [bubbles(r, 1.2, 20), 0.5, 0.1]),
    impactDelay: 0.8,
  },
  'cthulhu.dream-plague': {
    cast: (r) => layer([moan(r, 2.4, 110), 0.7], [moan(r, 2.4, 155.6), 0.45, 0.2], [shimmer(r, 2.4, 622.3, { rise: 0.7, peak: 0.5, voices: 5 }), 0.4]),
    zone: (r) => layer([abyss(r, 2.5, 92.5), 0.6], [lullaby(r, 2.5, 130.8), 0.3], [filter(puff(r, 2.5, { tone: 700 }), 'lowpass', 1200), 0.4]),
    tick: (r) => layer([moan(r, 0.5, 220), 0.4], [thump(r, 0.25, 90, 40, { noise: 0.3 }), 0.5]),
  },
  // ===== the Jötunn: ice, stone and a bellowing voice (jotunnSounds.ts)
  ...JOTUNN_SKILL_SOUNDS,
};

// ---------------------------------------------------------------------------
// Little extras used above

function ravens(r: Rand, len: number, count: number): Float32Array {
  const out = buf(len);
  for (let k = 0; k < count; k++) {
    const at = (k / Math.max(1, count)) * len * 0.7 + r() * 0.05;
    const f = 520 + r() * 160;
    const v = vowel(r, 0.22, (t) => glide(f, f * 0.8, t, 0.22), [[1150, 5, 1], [1750, 6, 0.6], [2800, 7, 0.3]], { breath: 0.45, growl: 0.18, voices: 2, detune: 0.03, env: (t) => ahr(t, 0.015, 0.07, 0.12) });
    const o = Math.round(at * 44100);
    for (let i = 0; i < v.length && o + i < out.length; i++) out[o + i]! += v[i]! * 0.7;
  }
  return out;
}

function laugh(r: Rand): Float32Array {
  // a short, breathy "heh-heh-heh"
  const out = buf(0.75);
  for (let k = 0; k < 3; k++) {
    const v = vowel(r, 0.14, (t) => glide(230 - k * 12, 190, t, 0.14), VOWELS.eh, { breath: 0.7, env: (t) => perc(t, 0.01, 0.12), gain: 0.8 });
    const o = Math.round(k * 0.16 * 44100);
    for (let i = 0; i < v.length && o + i < out.length; i++) out[o + i]! += v[i]!;
  }
  return out;
}

function darkHit(r: Rand, len: number): Float32Array {
  const out = buf(len);
  for (const f of [55, 58.3, 82.4]) {
    const o = new Osc(r());
    fill(out, (t) => o.saw(f) * perc(t, 0.01, len) * 0.3);
  }
  return filter(out, 'lowpass', 500, 0.9);
}

function waterPour(r: Rand, len: number): Float32Array {
  const out = buf(len);
  const count = Math.round(len * 40);
  for (let k = 0; k < count; k++) {
    const at = r() * len * 0.9;
    const f = 600 + r() * 1200;
    const d = 0.02 + r() * 0.04;
    const o = new Osc();
    fill(out, (t) => o.sine(f * (1 + t * 14)) * perc(t, 0.001, d) * 0.3, at, at + d * 1.5);
  }
  return out;
}

function crackleHiss(r: Rand, len: number): Float32Array {
  return filter(sand(r, len, { tone: 4000, peak: 0.2, grains: 500 }), 'highpass', 1500);
}

/** Generic fallbacks for a skill missing from the table (new skills added later). */
/** One great beat of feathered wings: a low push of air with the rustle of the vanes. */
function wingFlap(r: Rand, len: number, weight = 1): Float32Array {
  return layer(
    [thump(r, Math.min(len, 0.5), 90, 40, { click: 0.1, noise: 1, gain: 0.6 * weight }), 1],
    [whoosh(r, len, 250, 900, { q: 0.5, peak: 0.3, gain: weight, grit: 1.4 }), 1],
    [filter(puff(r, len * 0.8, { tone: 3200 }), 'highpass', 1800), 0.4 * weight, 0.05],
  );
}

/** Soul fire burning cold: a thin, airy flame with a glassy ring in it. */
function coldFire(r: Rand, len: number): Float32Array {
  return layer([filter(fire(r, len, { gain: 0.8, roar: 0.6 }), 'highpass', 900), 1], [shimmer(r, len, 1174.7, { rise: 0.7, peak: 0.2, voices: 3 }), 0.4]);
}

/** A slow, heavy heart: lub-dub, lub-dub. */
function heartbeat(r: Rand, len: number, slow = 0.8): Float32Array {
  const out = buf(len);
  const period = 0.6 / slow;
  for (let at = 0.02; at < len - 0.2; at += period) {
    for (const [d, g] of [[0, 1], [0.16, 0.7]] as const) {
      const h = thump(r, 0.22, 70, 38, { click: 0.05, drive: 1.2, gain: g });
      const o = Math.round((at + d) * 44100);
      for (let i = 0; i < h.length && o + i < out.length; i++) out[o + i]! += h[i]!;
    }
  }
  return filter(out, 'lowpass', 400, 0.8);
}

/** Sleep's lullaby: a hushed, swaying hum a fifth over its root. */
function lullaby(r: Rand, len: number, f: number): Float32Array {
  return layer(
    [vowel(r, len, (t) => f * (1 + Math.sin(t * 2.2) * 0.012), VOWELS.oo, { voices: 3, detune: 0.02, breath: 0.5, vibrato: 0.01, env: (t) => ahr(t, len * 0.35, len * 0.25, len * 0.4) }), 1],
    [vowel(r, len, (t) => f * 1.5 * (1 + Math.sin(t * 1.7 + 1) * 0.012), VOWELS.oo, { voices: 2, detune: 0.02, breath: 0.6, env: (t) => ahr(t, len * 0.45, len * 0.2, len * 0.35), gain: 0.5 }), 0.6],
  );
}

/** A rattlesnake's warning: a fast buzz of dry clicks. */
function rattle(r: Rand, len: number, rate = 26): Float32Array {
  const out = buf(len);
  const n = () => r() * 2 - 1;
  for (let at = 0; at < len - 0.02; at += 1 / rate) {
    const g = ahr(at, len * 0.15, len * 0.5, len * 0.35);
    fill(out, (t) => n() * perc(t - at, 0.0008, 0.012) * g * 0.8, at, at + 0.03);
  }
  return filter(out, 'highpass', 2400, 0.9);
}

/** A serpent's long hiss. */
function hiss(r: Rand, len: number, gain = 1): Float32Array {
  return shape(filter(puff(r, len, { tone: 5200, gain }), 'highpass', 3200, 0.8), (t) => ahr(t, len * 0.15, len * 0.45, len * 0.4));
}

/** A clay flute: a breathy whistle with a little vibrato, its pitch bending up by `bend` at the start. */
function flute(r: Rand, len: number, f: number, bend = 1): Float32Array {
  const out = buf(len);
  const o = new Osc(r());
  const o2 = new Osc(r());
  fill(out, (t) => {
    const p = f * (1 + (1 / bend - 1) * Math.exp(-t * 18)) * (1 + Math.sin(t * 34) * 0.008);
    const env = ahr(t, 0.03, len * 0.5, len * 0.45);
    return (o.sine(p) + o2.sine(p * 2) * 0.12) * env * 0.4;
  });
  return layer([out, 1], [filter(shape(puff(r, len, { tone: f * 2 }), (t) => ahr(t, 0.02, len * 0.5, len * 0.45)), 'bandpass', f, 2), 0.35]);
}

/** The tunkul, a slit drum: two wooden tongues struck in turn. */
function slitDrum(r: Rand, len: number, beats: number): Float32Array {
  const out = buf(len);
  for (let k = 0; k < beats; k++) {
    const at = (k / beats) * len * 0.8;
    const b = knock(r, 0.25, k % 2 ? 330 : 220);
    const o = Math.round(at * 44100);
    for (let i = 0; i < b.length && o + i < out.length; i++) out[o + i]! += b[i]! * (1 - k * 0.12);
  }
  return out;
}

/** A conch-shell trumpet: a low, hollow, slightly nasal horn. */
function conch(r: Rand, len: number, f: number): Float32Array {
  return layer(
    [vowel(r, len, (t) => f * (1 + 0.03 * bell(t, len, 0.3)) * (1 + Math.sin(t * 22) * 0.004), VOWELS.oh, { voices: 2, detune: 0.01, breath: 0.35, env: (t) => ahr(t, 0.15, len * 0.5, len * 0.4) }), 1],
    [warHorn(r, len, f), 0.4],
  );
}

/** Polished jade struck: a short, glassy stone ring. */
function jade(r: Rand, len: number, f: number): Float32Array {
  return layer([chime(r, len, f), 1], [knock(r, 0.08, f * 2.2), 0.4]);
}

/** Warm rain: a patter of drops over a soft hiss. */
function rain(r: Rand, len: number): Float32Array {
  return layer([waterPour(r, len), 0.8], [shape(filter(puff(r, len, { tone: 3000 }), 'highpass', 1200), (t) => ahr(t, len * 0.2, len * 0.5, len * 0.3)), 0.5]);
}

/** Coils tightening: a creak of scales and a low strain. */
function squeeze(r: Rand, len: number): Float32Array {
  return layer([filter(sand(r, len, { tone: 900, peak: 0.6, grains: 300 }), 'bandpass', 700, 1.5), 0.8], [whoosh(r, len, 400, 160, { q: 1.5, peak: 0.7, grit: 1.5 }), 0.6]);
}

/** Bubbles rising through deep water: low, wet blips that bend upward. */
function bubbles(r: Rand, len: number, count = 14): Float32Array {
  const out = buf(len);
  for (let k = 0; k < count; k++) {
    const at = r() * len * 0.85;
    const f = 180 + r() * 420;
    const d = 0.03 + r() * 0.06;
    const o = new Osc();
    fill(out, (t) => o.sine(f * (1 + t * 22)) * perc(t, 0.002, d) * 0.35, at, at + d * 1.5);
  }
  return filter(out, 'lowpass', 2200);
}

/** Wet flesh: the slap and squelch of something boneless. */
function squelch(r: Rand, len: number): Float32Array {
  return layer(
    [filter(puff(r, len, { tone: 600, gain: 1.2 }), 'bandpass', 420, 1.8), 1],
    [whoosh(r, len, 500, 180, { q: 2, peak: 0.25, grit: 1.6 }), 0.6],
    [thump(r, Math.min(len, 0.3), 110, 45, { click: 0.2, noise: 0.4 }), 0.6],
  );
}

/** The deep's chorus: two drowned choirs a tritone apart over a low, beating drone. */
function abyss(r: Rand, len: number, f: number): Float32Array {
  const env = (t: number): number => ahr(t, len * 0.35, len * 0.3, len * 0.35);
  return layer([choir(r, len, f, { vowelName: 'oo', env }), 0.7], [choir(r, len, f * Math.SQRT2, { vowelName: 'oh', env }), 0.45], [darkHit(r, len), 0.5]);
}

/** A long, falling moan from very far down, like a whale or a drowned bell. */
function moan(r: Rand, len: number, f: number): Float32Array {
  return vowel(r, len, (t) => glide(f * 1.25, f, t, len * 0.8), VOWELS.oo, { voices: 2, detune: 0.015, breath: 0.25, vibrato: 0.01, env: (t) => ahr(t, len * 0.3, len * 0.3, len * 0.4) });
}

/** A heavy swell of seawater: a rising surge that breaks into foam and bubbles. */
function surf(r: Rand, len: number): Float32Array {
  return layer(
    [whoosh(r, len, 120, 700, { q: 0.5, peak: 0.6, gain: 1.4, grit: 1.6 }), 1],
    [filter(puff(r, len * 0.6, { tone: 2600 }), 'highpass', 1200), 0.6, len * 0.45],
    [bubbles(r, len * 0.7, 10), 0.5, len * 0.3],
  );
}

export function fallbackSkill(element: string | undefined, targeting: string): SkillSound {
  const cast: Recipe['make'] =
    element === 'lightning' ? (r) => bolt(r) : element === 'sand' ? (r) => sand(r, 0.6) : element === 'smoke' ? (r) => smoke(r) : element === 'runes' ? (r) => runes(r, 1, 220) : (r) => whoosh(r, 0.4, 400, 2000);
  return {
    cast,
    travel: targeting === 'projectile' ? (r) => shimmer(r, 1, 520, { rise: 1, peak: 0.5 }) : undefined,
    impact: (r) => thump(r, 0.4, 130, 45, { click: 0.7, drive: 2 }),
  };
}

