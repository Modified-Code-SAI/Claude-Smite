/**
 * The game's sound bank: every non-skill sound, as a recipe built from the
 * gestures. Each recipe renders a few variants so repeated sounds (steps,
 * hits, swings) never sound like one sample on repeat.
 */

import { ahr, Biquad, brown, buf, crackle, dcBlock, declick, drive, fill, glide, loopable, mixIn, modal, normalize, OnePole, Osc, perc, pink, RATE, seeded as rngFor, tail, wander, white, type Rand } from './dsp';
import {
  chime, chirp, choir, clang, debris, filter, fire, impact, knock, layer, puff, roar, rumble, sand, shape, shimmer, thump, thunder, twang, vowel, VOWELS, whoosh, zap,
} from './gestures';
import { CREATURE_SOUNDS } from './creatures';
import { JOTUNN_SOUNDS } from './jotunnSounds';
import { VOICE_SOUNDS } from './voices';
import { CHANT, CHANT_BEAT, CHANT_LOOP } from './chant';

export interface Recipe {
  make: (r: Rand, variant: number) => Float32Array;
  /** How many variants to render (default 1). */
  variants?: number;
  /** Rendered as a seamless loop. */
  loop?: boolean;
  /** A loop built to wrap on its own length (a rhythm): it gets no crossfaded seam or filtering, which would pull it off the beat. */
  exact?: boolean;
  /** Peak level after normalizing (default 0.9). */
  peak?: number;
}

const step = (r: Rand, tone: number, soft: number, weight: number): Float32Array => {
  // heel then toe: two close taps, a low body thud and a gritty scuff
  const scuff = filter(whoosh(r, 0.09 + soft * 0.06, tone * 1.3, tone * 0.7, { q: 0.7 }), 'highpass', 400);
  return layer(
    [knock(r, 0.05, tone * (0.9 + r() * 0.2)), 0.5 * (1 - soft)],
    [knock(r, 0.05, tone * 1.4), 0.3 * (1 - soft), 0.025 + r() * 0.02],
    [thump(r, 0.12, 120 * weight, 55, { click: 0.1, noise: 0.2 }), 0.55 * weight],
    [scuff, 0.4 + soft * 0.5],
  );
};

const hitFlesh = (r: Rand, weight: number): Float32Array =>
  layer([impact(r, weight, { tone: 140 + r() * 30, crunch: 0.6 }), 1], [filter(puff(r, 0.12, { tone: 1600 }), 'highpass', 300), 0.35]);

/** A short burst of fire crackle. */
const crackles = (r: Rand, len: number, density: number): Float32Array => {
  const out = buf(len);
  crackle(out, r, density, (t) => ahr(t, 0.01, len * 0.3, len * 0.6));
  return out;
};

export const SOUNDS: Record<string, Recipe> = {
  // -- footsteps
  'step.stone': { variants: 6, peak: 0.5, make: (r) => step(r, 1700, 0.1, 1) },
  'step.grass': { variants: 6, peak: 0.45, make: (r) => step(r, 1000, 0.85, 0.8) },
  'step.dirt': { variants: 6, peak: 0.45, make: (r) => step(r, 1250, 0.5, 0.9) },
  'step.minion': { variants: 4, peak: 0.35, make: (r) => layer([step(r, 1300, 0.5, 0.6), 1], [clang(r, 0.12, 1900 + r() * 400, { decay: 0.08 }), 0.15]) },
  // the Wyrm's pit is strewn with its hoard; the Colossus stands on cooled lava and ash
  'step.coins': { variants: 4, peak: 0.45, make: (r) => layer([step(r, 1500, 0.2, 0.7), 1], [clang(r, 0.25, 2600 + r() * 1400, { decay: 0.12, gain: 0.35 }), 0.8, 0.01], [clang(r, 0.2, 3400 + r() * 1600, { decay: 0.08, gain: 0.25 }), 0.6, 0.04]) },
  'step.ash': { variants: 4, peak: 0.45, make: (r) => layer([step(r, 900, 0.6, 0.9), 1], [debris(r, 0.18, { density: 60, gain: 0.3, tone: 2200 }), 0.7]) },
  // landing from a leap, a jump or a knock-up: a thud and a little dust
  'land': { variants: 3, peak: 0.7, make: (r) => layer([thump(r, 0.35, 120, 45, { click: 0.3, noise: 0.5, drive: 1.6 }), 1], [debris(r, 0.35, { density: 18, gain: 0.3, tone: 900 }), 0.6, 0.02], [puff(r, 0.4, { tone: 700, gain: 0.5 }), 0.4]) },
  'step.heavy': { variants: 3, peak: 0.9, make: (r) => layer([thump(r, 0.6, 70, 28, { click: 0.3, noise: 0.6, drive: 2 }), 1], [debris(r, 0.5, { density: 10, gain: 0.4, tone: 500 }), 0.6]) },

  // -- god basic attacks (cast side)
  'basic.zeus': { variants: 3, make: (r) => layer([zap(r, 0.22, 340 + r() * 60, { chaos: 0.4, fall: 1.6 }), 0.8], [whoosh(r, 0.18, 2000, 5000, { q: 1 }), 0.5]) },
  'basic.thor': { variants: 3, make: (r) => layer([whoosh(r, 0.32, 300, 900, { q: 1.1, peak: 0.6, gain: 1.4 }), 1], [zap(r, 0.1, 220, { hiss: 0.3, gain: 0.3 }), 1, 0.15]) },
  'basic.odin': { variants: 3, make: (r) => whoosh(r, 0.26, 500, 1600, { q: 1.6, peak: 0.55, gain: 1.3 }) },
  'basic.loki': { variants: 3, make: (r) => layer([whoosh(r, 0.16, 1400, 3800, { q: 2, peak: 0.6 }), 1], [clang(r, 0.2, 3100, { decay: 0.12, gain: 0.2 }), 1]) },
  'basic.thanatos': { variants: 3, make: (r) => layer([whoosh(r, 0.26, 600, 2600, { q: 1.6, peak: 0.55, gain: 1.3 }), 1], [clang(r, 0.25, 1900 + r() * 300, { decay: 0.15, gain: 0.18 }), 1, 0.03], [whoosh(r, 0.3, 200, 600, { q: 0.6, peak: 0.4, gain: 0.5, grit: 1.2 }), 0.4]) },
  'basic.anubis': { variants: 3, make: (r) => layer([sand(r, 0.3, { tone: 2600, peak: 0.25 }), 1], [vowel(r, 0.25, (t) => glide(180, 120, t, 0.25), [[600, 5, 1], [1300, 6, 0.4]], { breath: 0.6, gain: 0.4 }), 1]) },
  'basic.minion.melee': { variants: 3, peak: 0.55, make: (r) => whoosh(r, 0.2, 700, 1900, { q: 1.6, peak: 0.6 }) },
  'basic.minion.archer': { variants: 3, peak: 0.55, make: (r) => layer([twang(r, 0.35, 180 + r() * 40), 0.8], [whoosh(r, 0.15, 2500, 1500, { q: 2 }), 0.4, 0.02]) },
  'basic.minion.brute': { variants: 2, peak: 0.75, make: (r) => whoosh(r, 0.42, 220, 600, { q: 1, peak: 0.7, gain: 1.4 }) },
  // the Thornspitter: a wet hacking cough, then the glob of acid flying off
  'basic.spitter': { variants: 3, peak: 0.55, make: (r) => layer([vowel(r, 0.14, (t) => glide(300, 520, t, 0.14), VOWELS.ah, { breath: 0.7, growl: 0.1, gain: 0.4 }), 1], [puff(r, 0.12, { tone: 1400 }), 0.8, 0.08], [whoosh(r, 0.22, 1800, 900, { q: 1.5 }), 0.5, 0.1]) },
  // acid landing: a splat and a short sizzle
  // the Shade: a whispered hurl, a cold impact, and its blink (a hiss as it folds away, a gasp where it lands)
  'basic.shade': { variants: 3, peak: 0.55, make: (r) => layer([vowel(r, 0.42, (t) => glide(300, 190, t, 0.42), VOWELS.oo, { breath: 2.5, voices: 2, detune: 0.03, gain: 0.35, env: (t) => ahr(t, 0.04, 0.1, 0.28) }), 0.9], [whoosh(r, 0.5, 500, 2400, { q: 1.6 }), 0.8, 0.04], [shimmer(r, 0.6, 740, { rise: 0.6, peak: 0.12 }), 0.45, 0.06]) },
  'hit.shade': { variants: 2, peak: 0.5, make: (r) => layer([puff(r, 0.14, { tone: 1100 }), 0.7], [shimmer(r, 0.4, 1046.5, { rise: 0.75, peak: 0.04 }), 0.6, 0.01], [vowel(r, 0.25, (t) => glide(260, 160, t, 0.25), VOWELS.oh, { breath: 2.5, gain: 0.3, env: (t) => ahr(t, 0.01, 0.04, 0.2) }), 0.5]) },
  'shade.vanish': { variants: 2, peak: 0.5, make: (r) => layer([whoosh(r, 0.32, 3200, 450, { q: 1.2 }), 1], [vowel(r, 0.3, (t) => glide(200, 340, t, 0.3), VOWELS.eh, { breath: 3, gain: 0.3, env: (t) => ahr(t, 0.12, 0.05, 0.12) }), 0.6]) },
  'shade.appear': { variants: 2, peak: 0.5, make: (r) => layer([whoosh(r, 0.35, 600, 2800, { q: 1.4 }), 0.7], [vowel(r, 0.4, (t) => glide(380, 240, t, 0.4), VOWELS.ah, { breath: 2.8, gain: 0.32, env: (t) => ahr(t, 0.03, 0.08, 0.3) }), 0.8, 0.02], [shimmer(r, 0.5, 880, { rise: 0.5, peak: 0.1 }), 0.4, 0.05]) },
  // the Gravekeeper: a flick of lantern fire, its scorch, and the murmur and rising shimmer of a mend
  'basic.keeper': { variants: 3, peak: 0.55, make: (r) => layer([fire(r, 0.35, { gain: 0.8 }), 0.7], [whoosh(r, 0.3, 900, 2200, { q: 1.3 }), 0.7, 0.02], [crackles(r, 0.3, 14), 0.25, 0.03]) },
  'hit.keeper': { variants: 2, peak: 0.5, make: (r) => layer([puff(r, 0.12, { tone: 1500 }), 0.7], [crackles(r, 0.25, 18), 0.4, 0.01]) },
  // the Ossuary King: its great blade cleaving the air, the Grave Toll (a funeral bell under the slam), and its rising roar
  'basic.king': { variants: 2, peak: 0.95, make: (r) => layer([whoosh(r, 0.7, 90, 520, { q: 0.7, peak: 0.75, gain: 1.3 }), 1], [thump(r, 0.8, 55, 22, { click: 0.5, noise: 0.6, drive: 2.5 }), 0.9, 0.32], [clang(r, 0.7, 220, { decay: 0.35, gain: 0.3, bright: 0.3 }), 0.35, 0.33]) },
  'king.toll': {
    peak: 1,
    make: (r) =>
      layer(
        [thump(r, 1.4, 48, 18, { click: 0.7, noise: 1, drive: 3 }), 1],
        [clang(r, 4, 73.4, { decay: 3.2, bright: 0.35, gain: 0.9 }), 0.9, 0.02],
        [clang(r, 3.2, 110, { decay: 2.4, bright: 0.25, gain: 0.5 }), 0.5, 0.03],
        [choir(r, 2.6, 73.4, { vowelName: 'oh', env: (t) => ahr(t, 0.2, 0.6, 1.6) }), 0.45, 0.1],
        [fire(r, 1.6, { gain: 0.6, roar: 2.2 }), 0.8, 0.04],
        [debris(r, 1.8, { density: 30, gain: 0.5, tone: 500 }), 0.8, 0.08],
      ),
  },
  // Underworld relics: a find's bell and choir, then each one going off
  'relic.found': {
    peak: 0.7,
    make: (r) =>
      layer(
        [clang(r, 2.6, 293.7, { decay: 2.2, bright: 0.45, gain: 0.55 }), 0.8],
        [clang(r, 2.2, 440, { decay: 1.8, bright: 0.35, gain: 0.35 }), 0.5, 0.12],
        [choir(r, 2.4, 146.8, { vowelName: 'ah', env: (t) => ahr(t, 0.3, 0.7, 1.2) }), 0.5, 0.05],
        [shimmer(r, 1.8, 880, { rise: 1.6, peak: 0.5 }), 0.6, 0.15],
      ),
  },
  'relic.knell': { variants: 3, peak: 0.75, make: (r) => layer([thump(r, 0.5, 70, 30, { click: 0.4, noise: 0.7, drive: 2 }), 0.8], [fire(r, 0.7, { gain: 0.8, roar: 1.6 }), 0.9, 0.02], [clang(r, 1.2, 146.8 + r() * 10, { decay: 0.9, bright: 0.25, gain: 0.25 }), 0.45, 0.03], [crackles(r, 0.5, 16), 0.35, 0.05]) },
  'relic.chain': { variants: 3, peak: 0.6, make: (r) => layer([zap(r, 0.22, 600 + r() * 200, { chaos: 0.6, hiss: 0.8 }), 0.6], [whoosh(r, 0.25, 900, 3200, { q: 1.6, peak: 0.6 }), 0.6], [vowel(r, 0.3, (t) => glide(330, 440, t, 0.3), VOWELS.oo, { breath: 2.5, gain: 0.3 }), 0.35, 0.02]) },
  'relic.echo': { variants: 2, peak: 0.45, make: (r) => layer([clang(r, 1.1, 1174.7, { decay: 0.8, bright: 0.6, gain: 0.35 }), 0.7], [clang(r, 0.9, 1568, { decay: 0.6, bright: 0.5, gain: 0.25 }), 0.5, 0.09], [shimmer(r, 0.7, 2349, { rise: 0.8, peak: 0.2 }), 0.4, 0.04]) },
  'relic.aegis': { variants: 3, peak: 0.5, make: (r) => layer([knock(r, 0.12, 900 + r() * 300), 0.8], [knock(r, 0.1, 1400 + r() * 300), 0.6, 0.04], [knock(r, 0.1, 1100), 0.5, 0.08], [shimmer(r, 0.5, 660, { rise: 1.2, peak: 0.3 }), 0.4, 0.02]) },
  'relic.harvest': { variants: 3, peak: 0.4, make: (r) => layer([whoosh(r, 0.35, 2600, 700, { q: 1.3, peak: 0.3, gain: 0.6 }), 0.5], [choir(r, 0.7, 392, { vowelName: 'oo', env: (t) => ahr(t, 0.08, 0.15, 0.4) }), 0.45, 0.04], [shimmer(r, 0.6, 784, { rise: 1.2, peak: 0.4 }), 0.5, 0.06]) },
  'relic.spite': { peak: 0.75, make: (r) => layer([roar(r, 0.9, 110, { open: 1.1 }), 0.5], [fire(r, 0.9, { gain: 0.9, roar: 2 }), 0.8], [thump(r, 0.6, 60, 28, { click: 0.3, noise: 0.5, drive: 2 }), 0.6]) },
  'king.roar': { peak: 0.95, make: (r) => layer([roar(r, 3, 48, { open: 0.9 }), 1], [choir(r, 3, 55, { vowelName: 'oh', env: (t) => ahr(t, 0.6, 1.2, 1.2) }), 0.6, 0.2], [rumble(r, 3, { tone: 90 }), 0.8], [crackles(r, 2.4, 10), 0.3, 0.4]) },
  'keeper.mend': { variants: 2, peak: 0.55, make: (r) => layer([choir(r, 1.1, r() < 0.5 ? 98 : 110, { vowelName: 'oh', env: (t) => ahr(t, 0.25, 0.3, 0.5) }), 0.5], [shimmer(r, 1, 587.3, { rise: 1.5, peak: 0.6 }), 0.8, 0.1], [fire(r, 0.6, { gain: 0.6 }), 0.45], [vowel(r, 0.7, (t) => glide(140, 120, t, 0.7), VOWELS.oo, { breath: 2.4, gain: 0.3 }), 0.4, 0.05]) },
  'hit.acid': { variants: 2, peak: 0.5, make: (r) => layer([puff(r, 0.1, { tone: 900 }), 0.7], [sand(r, 0.35, { tone: 3000, peak: 0.5 }), 0.8, 0.03]) },
  'basic.monster': { variants: 3, peak: 0.6, make: (r) => layer([whoosh(r, 0.22, 500, 1200, { q: 1 }), 1], [vowel(r, 0.25, (t) => glide(220, 150, t, 0.25), VOWELS.ah, { breath: 0.5, growl: 0.2, gain: 0.5 }), 1]) },
  'basic.warden': { variants: 2, peak: 0.85, make: (r) => layer([whoosh(r, 0.45, 160, 500, { q: 0.8, peak: 0.75, gain: 1.4 }), 1], [roar(r, 0.5, 90), 0.5]) },
  'basic.wyrm': { variants: 2, peak: 0.9, make: (r) => layer([roar(r, 0.7, 120, { open: 1.2 }), 0.8], [whoosh(r, 0.5, 200, 700, { q: 0.8, peak: 0.7, gain: 1.2 }), 1]) },
  'basic.colossus': { variants: 2, peak: 0.95, make: (r) => layer([thump(r, 0.9, 60, 25, { click: 0.4, noise: 0.8, drive: 2.5 }), 1, 0.35], [whoosh(r, 0.5, 120, 400, { q: 0.8, peak: 0.8, gain: 1.2 }), 0.8], [fire(r, 0.9, { gain: 0.4 }), 1, 0.3]) },

  // -- projectile loops in flight
  'travel.zeus': { loop: true, peak: 0.5, make: (r) => layer([zap(r, 1.2, 180, { chaos: 0.8, fall: 1, hiss: 0.8 }), 0.6], [shape(crackleBed(r, 1.2, 5000, 220), () => 1), 0.55], [rumble(r, 1.2, { tone: 130, attack: 0.01 }), 0.7]) },
  'travel.anubis': { loop: true, peak: 0.45, make: (r) => shape(sand(r, 1.2, { tone: 2200, peak: 0.5, grains: 1400 }), () => 1) },
  'travel.arrow': { loop: true, peak: 0.25, make: (r) => shape(whoosh(r, 0.8, 2200, 2200, { q: 3, peak: 0.5 }), () => 1) },
  'travel.tower': { loop: true, peak: 0.45, make: (r) => towerHum(r, 1) },
  'travel.magic': { loop: true, peak: 0.35, make: (r) => shimmer(r, 1.2, 520, { rise: 1, peak: 0.5 }) },

  // -- hits
  'hit.flesh': { variants: 4, peak: 0.8, make: (r) => hitFlesh(r, 1) },
  'hit.blade': { variants: 4, peak: 0.8, make: (r) => layer([hitFlesh(r, 0.85), 1], [clang(r, 0.35, 2400 + r() * 900, { decay: 0.2, gain: 0.35 }), 0.8], [whoosh(r, 0.08, 4000, 2000, { q: 1 }), 0.5]) },
  'hit.blunt': { variants: 4, peak: 0.9, make: (r) => layer([impact(r, 1.4, { tone: 115 + r() * 20, crunch: 0.5, sub: 1.2 }), 1], [clang(r, 0.35, 700 + r() * 200, { decay: 0.25, gain: 0.3, bright: 0.4 }), 0.7], [debris(r, 0.3, { density: 12, gain: 0.25, tone: 900 }), 0.5, 0.02]) },
  // Zeus's basic is a small bolt: the blow, the arc's sparks and a bark of thunder
  'hit.zap': { variants: 4, peak: 0.85, make: (r) => layer([impact(r, 0.9, { tone: 160, crunch: 0.4 }), 0.9], [zap(r, 0.18, 420 + r() * 200, { chaos: 0.8, hiss: 1 }), 0.7], [thunder(r, 0.3, { crack: 1.4, rumble: 0.15 }), 0.55]) },
  'hit.sand': { variants: 3, peak: 0.8, make: (r) => layer([impact(r, 0.9, { tone: 135, crunch: 0.3, snap: 0.6 }), 1], [sand(r, 0.3, { tone: 3000, peak: 0.1 }), 0.8]) },
  'hit.soulblade': { variants: 4, peak: 0.8, make: (r) => layer([hitFlesh(r, 0.8), 1], [clang(r, 0.3, 1700 + r() * 500, { decay: 0.18, gain: 0.3 }), 0.7], [filter(fire(r, 0.25, { gain: 0.3 }), 'highpass', 1200), 0.5]) },
  'hit.structure': { variants: 4, peak: 0.75, make: (r) => layer([impact(r, 1.1, { tone: 95, crunch: 0.9, sub: 0.8 }), 0.8], [knock(r, 0.2, 500 + r() * 300), 1], [knock(r, 0.12, 1400), 0.5, 0.01], [debris(r, 0.4, { density: 15, gain: 0.25, tone: 1300 }), 1]) },
  'hit.crit': { variants: 2, peak: 0.85, make: (r) => layer([impact(r, 1.7, { tone: 120, crunch: 1, sub: 1.3, room: 0.25 }), 1], [clang(r, 0.6, 1500, { decay: 0.4, gain: 0.6 }), 0.6], [whoosh(r, 0.15, 6000, 3000, { q: 0.8 }), 0.5]) },
  'hit.monster': { variants: 3, peak: 0.8, make: (r) => layer([hitFlesh(r, 1.2), 1], [vowel(r, 0.2, (t) => glide(300, 200, t, 0.2), VOWELS.eh, { breath: 0.5, growl: 0.2, gain: 0.3 }), 1]) },
  // your skill connecting with an enemy god: a tight, bright thwack that cuts through a fight
  'hit.confirm': { variants: 3, peak: 0.75, make: (r) => layer([impact(r, 0.9, { tone: 150 + r() * 20, crunch: 0.7, snap: 1.1, sub: 1.1, room: 0.12 }), 1], [knock(r, 0.05, 2600 + r() * 300), 0.25]) },

  // -- minions
  'minion.death': { variants: 4, peak: 0.6, make: (r) => layer([vowel(r, 0.32, (t) => glide(190 + r() * 40, 110, t, 0.3), VOWELS.oh, { breath: 0.3, gain: 0.7, env: (t) => perc(t, 0.01, 0.3) }), 0.8], [debris(r, 0.5, { density: 12, gain: 0.5, tone: 1900 }), 1, 0.12], [thump(r, 0.2, 110, 50), 0.5, 0.25]) },
  'wave.horn': { peak: 0.8, make: (r) => horn(r, 2.6, [146.8, 220]) },

  // -- structures
  'tower.shot': { variants: 2, peak: 0.85, make: (r) => towerShot(r) },
  'tower.hit': { variants: 3, peak: 0.9, make: (r) => layer([impact(r, 1.6, { tone: 105, crunch: 0.6, sub: 1.3, room: 0.25 }), 1], [zap(r, 0.25, 420, { chaos: 0.6, hiss: 1, gain: 0.5 }), 1], [filter(whoosh(r, 0.4, 3000, 600, { q: 0.6 }), 'highpass', 500), 0.5]) },
  'titan.slam': { peak: 0.95, make: (r) => layer([thump(r, 1.4, 55, 22, { click: 0.6, noise: 1, drive: 3 }), 1], [rumble(r, 2.2, { tone: 120 }), 0.8], [debris(r, 1.6, { density: 30, gain: 0.5, tone: 700 }), 1, 0.05]) },
  'titan.windup': { peak: 0.8, make: (r) => layer([roar(r, 1.2, 55, { open: 0.7 }), 1], [rumble(r, 1.2, { tone: 90, attack: 0.6 }), 0.8]) },
  'structure.collapse': { peak: 0.95, make: (r) => layer([thump(r, 1.2, 60, 25, { click: 0.4, noise: 1, drive: 2.5 }), 1], [rumble(r, 4, { tone: 180 }), 1], [debris(r, 3.6, { density: 45, gain: 0.7, tone: 800 }), 1, 0.1], [clang(r, 2.5, 180, { decay: 1.8, gain: 0.25, bright: 0.4 }), 1, 0.05]) },
  'phoenix.collapse': { peak: 0.95, make: (r) => layer([roarBird(r, 1.6), 0.8], [fire(r, 3, { gain: 0.7, roar: 2 }), 1, 0.2], [rumble(r, 3.5, { tone: 200 }), 0.9, 0.3], [debris(r, 3, { density: 35, gain: 0.6 }), 1, 0.4]) },
  'phoenix.rise': { peak: 0.85, make: (r) => layer([roarBird(r, 1.4), 0.7], [fire(r, 2.2, { gain: 0.6, roar: 2 }), 1], [shimmer(r, 2, 330, { rise: 2, peak: 0.6 }), 0.8]) },

  // -- jungle
  'monster.death': { variants: 3, peak: 0.7, make: (r) => layer([vowel(r, 0.7, (t) => glide(260, 90, t, 0.7), VOWELS.oh, { breath: 0.5, growl: 0.25, gain: 0.8, env: (t) => perc(t, 0.02, 0.7) }), 1], [thump(r, 0.4, 90, 40, { noise: 0.6 }), 0.8, 0.3]) },
  'monster.aggro': { variants: 3, peak: 0.6, make: (r) => vowel(r, 0.5, (t) => glide(320 + r() * 80, 200, t, 0.5), VOWELS.eh, { breath: 0.6, growl: 0.35, voices: 2, detune: 0.05, env: (t) => ahr(t, 0.03, 0.15, 0.3) }) },
  'warden.slam': { variants: 2, peak: 0.9, make: (r) => layer([thump(r, 0.8, 70, 28, { click: 0.5, noise: 0.8, drive: 2.5 }), 1], [debris(r, 0.8, { density: 25, gain: 0.5 }), 1, 0.03]) },
  'wyrm.roar': { peak: 0.9, make: (r) => layer([roar(r, 2.2, 95, { open: 1.2 }), 1], [roar(r, 2, 140, { open: 1.4 }), 0.5, 0.1], [sand(r, 1.6, { tone: 1800, gain: 0.25 }), 1, 0.3]) },
  'wyrm.sweep': { peak: 0.95, make: (r) => layer([whoosh(r, 0.9, 150, 600, { q: 0.7, peak: 0.6, gain: 1.6 }), 1], [thump(r, 0.9, 65, 25, { click: 0.5, noise: 0.9, drive: 2.5 }), 1, 0.45], [debris(r, 1, { density: 30, gain: 0.5 }), 1, 0.5]) },
  'colossus.roar': { peak: 0.95, make: (r) => layer([roar(r, 2.6, 60, { open: 0.8 }), 1], [fire(r, 2.6, { gain: 0.5, roar: 2.5 }), 1], [rumble(r, 2.6, { tone: 100 }), 0.8]) },
  'colossus.stomp': { peak: 1, make: (r) => layer([thump(r, 1.6, 50, 20, { click: 0.6, noise: 1, drive: 3 }), 1], [fire(r, 1.8, { gain: 0.7, roar: 2.5 }), 1, 0.05], [rumble(r, 2.6, { tone: 140 }), 0.9], [debris(r, 2, { density: 35, gain: 0.6, tone: 600 }), 1, 0.1]) },
  'boss.windup': { variants: 2, peak: 0.8, make: (r) => layer([roar(r, 1, 75, { open: 0.9 }), 1], [rumble(r, 1, { tone: 110, attack: 0.5 }), 0.7]) },

  // -- gods
  'god.death': { variants: 2, peak: 0.85, make: (r) => layer([thump(r, 0.5, 90, 40, { noise: 0.7, drive: 2 }), 1, 0.2], [darkChord(r, 2.4), 0.8], [whoosh(r, 0.6, 1500, 200, { q: 0.8 }), 0.6]) },
  'god.respawn': { peak: 0.75, make: (r) => layer([shimmer(r, 1.6, 392, { rise: 2, peak: 0.6 }), 1], [choir(r, 1.8, 392, { env: (t) => ahr(t, 0.4, 0.6, 0.8) }), 0.5], [whoosh(r, 1.2, 300, 3000, { q: 0.8, peak: 0.8 }), 0.4]) },
  'god.levelup': { peak: 0.7, make: (r) => levelUp(r) },
  'god.ultready': { peak: 0.7, make: (r) => layer([levelUp(r), 0.7], [choir(r, 2, 293.7, { env: (t) => ahr(t, 0.3, 0.8, 0.9) }), 0.6]) },
  'recall.loop': { loop: true, peak: 0.45, make: (r) => layer([shimmer(r, 2, 660, { rise: 1, peak: 0.5, voices: 6 }), 1], [choir(r, 2, 330, { vowelName: 'oo', env: () => 1 }), 0.4]) },
  'recall.done': { peak: 0.8, make: (r) => layer([whoosh(r, 0.9, 400, 5000, { q: 0.8, peak: 0.75, gain: 1.2 }), 1], [shimmer(r, 1.2, 880, { rise: 1.5, peak: 0.2 }), 0.8]) },
  'teleport': { peak: 0.7, make: (r) => layer([whoosh(r, 0.4, 3000, 400, { q: 1 }), 1], [shimmer(r, 0.5, 1200, { rise: 0.5, peak: 0.1 }), 0.6]) },
  'heal': { variants: 2, peak: 0.45, make: (r) => layer([shimmer(r, 0.8, 784, { rise: 1.25, peak: 0.25 }), 1], [chime(r, 0.8, 1568, { gain: 0.5 }), 0.6]) },
  'favor': { variants: 3, peak: 0.4, make: (r) => coin(r) },
  // Relic Rush: a pass whistling off, a clean catch, the relic knocked loose with a ring
  'relic.throw': { variants: 2, peak: 0.55, make: (r) => layer([whoosh(r, 0.5, 500, 2600, { q: 1.2, peak: 0.35, gain: 1.1 }), 1], [shimmer(r, 0.7, 880, { rise: 1.5, peak: 0.3 }), 0.5, 0.03]) },
  // a throw coming down loose: a soft thud on the stones, and the relic rings as it bounces back up
  'relic.land': { variants: 2, peak: 0.45, make: (r) => layer([thump(r, 0.3, 150 + r() * 20, 55, { click: 0.25, noise: 0.5 }), 0.8], [clang(r, 0.9, 523.3, { decay: 0.5, bright: 0.3, gain: 0.3 }), 0.45, 0.01], [shimmer(r, 0.5, 1046.5, { rise: 1.1, peak: 0.12 }), 0.3, 0.04]) },
  'relic.catch': { variants: 2, peak: 0.5, make: (r) => layer([chime(r, 0.6, 1318.5), 1], [knock(r, 0.05, 1800), 0.6], [shimmer(r, 0.5, 1046.5, { rise: 1.2, peak: 0.1 }), 0.4]) },
  // a carrier's juke: a quick rush of air and a sandal's scuff on stone, with a glint off the relic
  'relic.juke': { variants: 2, peak: 0.5, make: (r) => layer([whoosh(r, 0.3, 700, 2600, { q: 0.9, peak: 0.3, gain: 1.2, grit: 0.8 }), 1], [filter(puff(r, 0.22, { tone: 2200 }), 'highpass', 700), 0.55], [shimmer(r, 0.35, 1568, { rise: 1.3, peak: 0.15 }), 0.25, 0.04]) },
  // a teammate calls for the pass: two quick rising notes, like a whistle
  'relic.call': { variants: 2, peak: 0.45, make: (r) => layer([chime(r, 0.28, 1174.7), 0.8], [chime(r, 0.34, 1568), 0.95, 0.09]) },
  // a Captain keeps the relic through a hit: a bright deflecting ring
  'relic.shrug': { variants: 2, peak: 0.6, make: (r) => layer([clang(r, 0.8, 880, { decay: 0.45, gain: 0.5 }), 1], [shimmer(r, 0.6, 1318.5, { rise: 1.4, peak: 0.2 }), 0.6, 0.02], [thump(r, 0.25, 160, 60, { click: 0.4 }), 0.6]) },
  // a goal: the gate's gong, a bright major chord swelling up behind it, and glitter rising off the relic
  'relic.goal': {
    peak: 0.9,
    make: (r) =>
      layer(
        [clang(r, 3, 196, { decay: 2.4, bright: 0.6, gain: 0.8 }), 1],
        [thump(r, 0.9, 80, 32, { click: 0.5, noise: 0.5, drive: 2 }), 0.9],
        [choir(r, 2.6, 261.6, { env: (t) => ahr(t, 0.15, 0.9, 1.4) }), 0.5, 0.08],
        [choir(r, 2.5, 329.6, { env: (t) => ahr(t, 0.18, 0.8, 1.4) }), 0.4, 0.12],
        [choir(r, 2.4, 392, { env: (t) => ahr(t, 0.2, 0.8, 1.3) }), 0.4, 0.16],
        [shimmer(r, 2.2, 784, { rise: 1.8, peak: 0.35 }), 0.7, 0.1],
      ),
  },
  // a god dazed in Relic Rush: a bonk, then a little ring of stars
  'god.daze': {
    variants: 2,
    peak: 0.75,
    make: (r) =>
      layer(
        [thump(r, 0.35, 150, 55, { click: 0.6, noise: 0.4, drive: 1.5 }), 0.7],
        [knock(r, 0.08, 900), 0.5],
        [chime(r, 0.3, 2093), 1, 0.12],
        [chime(r, 0.3, 1760), 0.95, 0.22],
        [chime(r, 0.3, 2349.3), 0.9, 0.32],
        [chime(r, 0.45, 1975.5), 0.85, 0.42],
      ),
  },
  // the spirits round the pitch: on their feet for a goal, a gasp at a save, and their murmur between
  'crowd.roar': { variants: 2, peak: 0.8, make: (r) => tail(crowd(r, 4.2, { voices: 24, pitch: 190, rise: 0.22, breath: 0.6, babble: 0.35, lp: 3600, env: (t) => ahr(t, 0.22, 1.3, 2.4) }), 0.85, 0.35, 3200) },
  'crowd.ooh': { variants: 2, peak: 0.6, make: (r) => tail(crowd(r, 1.9, { voices: 18, pitch: 165, rise: 0.3, breath: 0.25, babble: 0.1, lp: 3000, vowels: ['oo', 'oh'], arc: true, env: (t) => ahr(t, 0.16, 0.45, 1.1) }), 0.8, 0.3, 2800) },
  'amb.crowd': { loop: true, peak: 0.45, make: (r) => loopable(crowd(r, 10, { voices: 20, pitch: 150, rise: 0, breath: 0.35, babble: 1, lp: 2200, env: () => 1 }), 1.2) },
  // the same crowd on its feet: higher, brighter, held shouts instead of chatter (faded in as the play heats up)
  // (both ends: each its own take, on the same beat)
  'amb.chant': { loop: true, exact: true, variants: 2, peak: 0.6, make: (r) => chant(r) },
  'amb.cheer': { loop: true, peak: 0.5, make: (r) => loopable(crowd(r, 6, { voices: 22, pitch: 205, rise: 0, breath: 0.55, babble: 0.45, lp: 3400, env: () => 1 }), 1.2) },
  // the Sun Relic's song, a low sung drone that follows it round the pitch
  'relic.hum': { loop: true, peak: 0.4, make: (r) => relicHum(r, 6) },
  'relic.fumble': { variants: 2, peak: 0.7, make: (r) => layer([clang(r, 0.9, 660, { decay: 0.55, gain: 0.6 }), 1], [thump(r, 0.3, 120, 50, { click: 0.3 }), 0.8], [whoosh(r, 0.3, 2000, 700, { q: 1 }), 0.4, 0.04]) },
  // the big kill moments (multi-kills, shutdowns, streaks): a close thunderclap under a rising chorus and a bell
  // your ultimate: the world drops away under a rising surge of power
  'ult.surge': { peak: 0.85, make: (r) => layer([rumble(r, 1.8, { tone: 140, attack: 0.25 }), 1], [whoosh(r, 1.4, 150, 3200, { q: 0.7, peak: 0.85, gain: 1.3 }), 0.8], [choir(r, 1.8, 146.8, { env: (t) => ahr(t, 0.5, 0.6, 0.7) }), 0.5], [impact(r, 2, { tone: 70, crunch: 0.3, sub: 1.5, room: 0.4 }), 0.9, 1.15]) },
  // an enemy ultimate close by: a dark brass stab and a blow, so you know to look out
  'ult.warn': { peak: 0.85, make: (r) => layer([darkChord(r, 1.8), 0.9], [horn(r, 1.3, [146.8, 207.7]), 0.8], [impact(r, 1.6, { tone: 75, crunch: 0.5, sub: 1.3, room: 0.35 }), 0.9], [rumble(r, 1.4, { tone: 120 }), 0.6]) },
  'kill.big': { peak: 0.9, make: (r) => layer([thunder(r, 1.2, { crack: 1.3, rumble: 0.8 }), 0.8], [impact(r, 2, { tone: 90, crunch: 0.4, sub: 1.4, room: 0.35 }), 0.7], [choir(r, 2.2, 261.6, { env: (t) => ahr(t, 0.08, 0.5, 1.5) }), 0.55, 0.05], [choir(r, 2, 392, { env: (t) => ahr(t, 0.12, 0.4, 1.4) }), 0.4, 0.08], [clang(r, 2.2, 523, { decay: 1.6, gain: 0.6 }), 0.5, 0.02]) },
  'kill.confirm': { peak: 0.8, make: (r) => layer([clang(r, 1.4, 523, { decay: 1, gain: 0.7 }), 1], [thump(r, 0.4, 100, 40, { drive: 2 }), 0.8], [chime(r, 1.2, 1046.5), 0.5, 0.05]) },

  // -- herald stings and player feedback
  'sting.good': { peak: 0.75, make: (r) => layer([horn(r, 1.6, [146.8, 185, 220, 293.7]), 1], [thump(r, 0.9, 70, 30, { click: 0.3, drive: 2 }), 0.8]) },
  'sting.bad': { peak: 0.75, make: (r) => layer([horn(r, 1.8, [73.4, 87.3, 110]), 1], [thump(r, 1.1, 55, 25, { click: 0.2, drive: 2 }), 0.9], [darkChord(r, 1.8), 0.5]) },
  'sting.neutral': { peak: 0.6, make: (r) => layer([clang(r, 2.2, 220, { decay: 1.8, bright: 0.5, gain: 0.7 }), 1], [thump(r, 0.6, 90, 40, { click: 0.2 }), 0.6]) },
  'sting.epic': { peak: 0.85, make: (r) => layer([horn(r, 2.4, [73.4, 110, 146.8, 220]), 1], [thump(r, 1.4, 50, 22, { click: 0.4, noise: 0.6, drive: 2.5 }), 1], [clang(r, 2.6, 110, { decay: 2.2, bright: 0.4, gain: 0.6 }), 0.7]) },
  'heartbeat': { loop: true, peak: 0.7, make: (r) => heartbeat(r) },

  // -- UI (played flat, not positioned)
  // a few slightly different takes, so clicking around a menu doesn't sound like a metronome
  'ui.hover': { variants: 3, peak: 0.18, make: (r) => { const k = 0.94 + r() * 0.12; return layer([knock(r, 0.03, 3200 * k), 1], [sine(0.04, 2400 * k, 0.3), 1]); } },
  'ui.click': { variants: 3, peak: 0.38, make: (r) => { const k = 0.95 + r() * 0.1; return layer([knock(r, 0.04, 2600 * k), 1], [sine(0.07, 1320 * k, 0.6), 1], [knock(r, 0.05, 900 * k), 0.6]); } },
  'ui.select': { peak: 0.45, make: (r) => layer([chime(r, 0.4, 1046.5), 1], [chime(r, 0.4, 1568, { at: 0.05 }), 0.6], [knock(r, 0.04, 2600), 0.6]) },
  'ui.play': { peak: 0.8, make: (r) => layer([horn(r, 1.8, [146.8, 220, 293.7]), 1], [thump(r, 0.8, 80, 35, { click: 0.4, drive: 2 }), 0.9], [whoosh(r, 1.2, 200, 4000, { q: 0.8, peak: 0.6 }), 0.4]) },
  'ui.open': { peak: 0.45, make: (r) => layer([whoosh(r, 0.25, 600, 2400, { q: 1 }), 0.8], [chime(r, 0.5, 880), 0.5, 0.06]) },
  'ui.close': { peak: 0.4, make: (r) => whoosh(r, 0.22, 2200, 600, { q: 1 }) },
  'ui.deny': { peak: 0.45, make: () => layer([sine(0.12, 220, 1), 1], [sine(0.14, 165, 1), 1, 0.09]) },
  'ui.point': { peak: 0.5, make: (r) => layer([chime(r, 0.6, 1318.5), 1], [chime(r, 0.6, 1975.5, { at: 0.04 }), 0.5]) },
  'ui.toast': { peak: 0.3, make: (r) => chime(r, 0.4, 987.8) },
  // the god pick: the clock's last seconds, locking in a god, and both teams revealed
  'ui.tick': { variants: 2, peak: 0.34, make: (r) => layer([knock(r, 0.05, 1900 + r() * 100), 1], [sine(0.1, 880, 0.5), 0.7]) },
  'ui.lock': { peak: 0.7, make: (r) => layer([thump(r, 0.5, 120, 50, { click: 0.6, drive: 1.5 }), 1], [chime(r, 0.9, 784), 0.7], [chime(r, 0.9, 1174.7, { at: 0.04 }), 0.55], [whoosh(r, 0.5, 300, 3000, { q: 0.8, peak: 0.6 }), 0.35]) },
  'ui.versus': { peak: 0.85, make: (r) => layer([thump(r, 1.2, 72, 30, { click: 0.5, drive: 2.5 }), 1], [whoosh(r, 0.9, 140, 2600, { q: 0.7, peak: 0.3 }), 0.6], [horn(r, 1.8, [110, 164.8, 220]), 0.75]) },

  // -- pings: a low knock under a bell, each kind its own color of sound
  // look here: a soft wooden tap and a single clear bell
  'ping.look': { variants: 2, peak: 0.5, make: (r) => tail(layer([thump(r, 0.18, 120, 70, { click: 0.25, noise: 0.1 }), 0.8], [knock(r, 0.05, 1100), 0.35], [chime(r, 0.55, 659.3), 0.9, 0.01]), 0.5, 0.18) },
  // attack: a driven drum hit with a struck bronze ring over it
  'ping.attack': { variants: 2, peak: 0.6, make: (r) => tail(layer([thump(r, 0.3, 96, 40, { click: 0.55, drive: 2.4, noise: 0.25 }), 1], [clang(r, 0.7, 196, { bright: 0.7, decay: 0.45 }), 0.55, 0.005], [chime(r, 0.3, 880), 0.35, 0.02]), 0.55, 0.2) },
  // fall back, enemy missing, need help: a low two-note brass warning falling a fourth over a deep pulse
  'ping.warn': { variants: 2, peak: 0.6, make: (r) => tail(layer([thump(r, 0.26, 82, 44, { click: 0.3, drive: 1.6 }), 0.9], [horn(r, 0.34, [196, 293.7]), 0.75], [horn(r, 0.42, [146.8, 220]), 0.8, 0.16], [chime(r, 0.4, 587.3), 0.3, 0.16]), 0.6, 0.22) },
  // on my way, group up, ultimate, thanks: a warm rising pair of bells over a soft drum
  'ping.call': { variants: 2, peak: 0.5, make: (r) => tail(layer([thump(r, 0.2, 110, 60, { click: 0.22, noise: 0.08 }), 0.75], [chime(r, 0.45, 784), 0.8, 0.01], [chime(r, 0.55, 1174.7), 0.65, 0.08]), 0.5, 0.2) },
  // the wheel opening and a wedge lighting
  'ping.wheel': { peak: 0.3, make: (r) => layer([whoosh(r, 0.18, 300, 1400, { q: 1.1 }), 0.8], [thump(r, 0.1, 140, 90, { click: 0.1, noise: 0 }), 0.5]) },
  'ping.tick': { variants: 3, peak: 0.16, make: (r) => { const k = 0.94 + r() * 0.12; return layer([knock(r, 0.03, 1500 * k), 1], [sine(0.05, 520 * k, 0.4), 1]); } },

  // -- ambience
  'amb.wind': { loop: true, peak: 0.5, make: (r) => windBed(r, 12) },
  'amb.leaves': { loop: true, peak: 0.4, make: (r) => leavesBed(r, 9) },
  'amb.bird': { variants: 8, peak: 0.35, make: (r, v) => tail(chirp(r, v), 0.7, 0.3) },
  'amb.crow': { variants: 2, peak: 0.35, make: (r) => tail(crow(r), 0.9, 0.35) },
  'amb.fountain': { loop: true, peak: 0.5, make: (r) => water(r, 6) },
  'amb.fire': { loop: true, peak: 0.45, make: (r) => fire(r, 5) },
  'amb.jungle': { loop: true, peak: 0.3, make: (r) => insects(r, 8) },
  // the underworld: a deep cavern drone, drips in the dark, a far groan of rock, a souls' moan
  'amb.cave': { loop: true, peak: 0.5, make: (r) => caveBed(r, 14) },
  'amb.drip': { variants: 5, peak: 0.3, make: (r) => tail(drip(r), 0.95, 0.55, 2600) },
  'amb.groan': { variants: 2, peak: 0.6, make: (r) => tail(layer([rumble(r, 3.2, { tone: 90, attack: 1.1 }), 1], [debris(r, 2.4, { density: 10, gain: 0.25, tone: 500 }), 0.6, 0.8]), 0.9, 0.4, 1800) },
  'amb.souls': { variants: 2, peak: 0.4, make: (r) => tail(choir(r, 3.4, r() < 0.5 ? 110 : 98, { vowelName: 'oo', env: (t) => ahr(t, 1.2, 0.6, 1.6) }), 0.95, 0.6, 2200) },
  // each depth's own air: the Ashen Depths' furnace and far-off anvils, steam venting from the rock;
  // the Drowned Halls' water running in the dark and a sunken bell; the Abyss's hollow wind and whispers
  'amb.forge': { loop: true, peak: 0.5, make: (r) => forgeBed(r, 13) },
  'amb.anvil': { variants: 3, peak: 0.4, make: (r) => anvil(r) },
  'amb.vent': { variants: 2, peak: 0.3, make: (r) => vent(r) },
  'amb.stream': { loop: true, peak: 0.45, make: (r) => streamBed(r, 12) },
  'amb.toll': { variants: 2, peak: 0.55, make: (r) => drownedToll(r) },
  'amb.hollow': { loop: true, peak: 0.5, make: (r) => hollowBed(r, 14) },
  'amb.whisper': { variants: 4, peak: 0.3, make: (r) => whisper(r) },
  'amb.plunge': { peak: 0.75, make: (r) => plunge(r) },
  // a soul reaching you: an airy rush drawn in, a ghostly glint and a breath of a choir
  // the dead climbing out of the floor: rock cracking open, grit falling away and a low moan from below
  // a boss's entrance: a deep blow under the floor, a dark brass call and a low choir swelling behind it
  'boss.intro': {
    peak: 0.85,
    make: (r) =>
      layer(
        [impact(r, 1.6, { tone: 55, sub: 1, room: 0.9 }), 1],
        [rumble(r, 2.4, { tone: 60, attack: 0.08 }), 0.8],
        [horn(r, 2.6, [73.4, 110]), 0.45, 0.25],
        [choir(r, 2.8, 55, { vowelName: 'oo', env: (t) => ahr(t, 0.8, 0.9, 1.1) }), 0.4, 0.35],
      ),
  },
  // a boss gone down: a last great blow, then a bright chord and voices rising over it
  'boss.fall': {
    peak: 0.85,
    make: (r) =>
      layer(
        [impact(r, 1.8, { tone: 48, sub: 1, room: 1 }), 1],
        [debris(r, 1.6, { density: 22, gain: 0.4, tone: 520 }), 0.6, 0.06],
        [horn(r, 2.8, [110, 138.6, 164.8]), 0.4, 0.45],
        [choir(r, 3, 220, { vowelName: 'ah', env: (t) => ahr(t, 0.7, 1, 1.3) }), 0.35, 0.5],
        [shimmer(r, 2.2, 880, { rise: 1.5, peak: 0.25 }), 0.22, 0.7],
      ),
  },
  'monster.emerge': { variants: 3, peak: 0.6, make: (r) => layer([rumble(r, 1.3, { tone: 75, attack: 0.04 }), 1], [debris(r, 1, { density: 16, gain: 0.35, tone: 650 }), 0.75, 0.04], [choir(r, 1.5, r() < 0.5 ? 82 : 73, { vowelName: 'oo', env: (t) => ahr(t, 0.35, 0.25, 0.8) }), 0.3, 0.12]) },
  'soul.absorb': { variants: 3, peak: 0.35, make: (r) => layer([whoosh(r, 0.3, 700, 3400, { q: 1.4, peak: 0.85, gain: 0.7 }), 0.6], [shimmer(r, 0.55, 1046.5, { rise: 1.3, peak: 0.15 }), 1, 0.07], [choir(r, 0.6, 523.3, { vowelName: 'oo', env: (t) => ahr(t, 0.06, 0.08, 0.4) }), 0.35, 0.05]) },

  // -- the gods' own voices (voices.ts)
  ...VOICE_SOUNDS,

  // -- camps, bosses and minion waves (creatures.ts)
  ...CREATURE_SOUNDS,

  // -- the Jötunn: its steps, voice, weak points and braziers (jotunnSounds.ts)
  ...JOTUNN_SOUNDS,
};

// ---------------------------------------------------------------------------
// Helpers for the recipes above

function sine(len: number, f: number, g: number): Float32Array {
  const out = buf(len);
  const o = new Osc();
  fill(out, (t) => o.sine(f) * perc(t, 0.002, len) * g);
  return out;
}

function crackleBed(r: Rand, len: number, tone: number, density: number): Float32Array {
  const out = buf(len);
  crackle(out, r, density, () => 1, { tone, gain: 0.8, len: 0.003 });
  return out;
}

/** A brass horn call: stacked saws with a filter that opens as it swells. */
export function horn(r: Rand, len: number, notes: readonly number[]): Float32Array {
  const out = buf(len);
  for (const f of notes) {
    for (let k = 0; k < 3; k++) {
      const o = new Osc(r());
      const lp = new Biquad('lowpass', 400, 1.2);
      const d = 1 + (k - 1) * 0.004;
      const vib = r() * 6;
      fill(out, (t, i) => {
        const env = ahr(t, 0.25, len * 0.45, len * 0.4);
        if ((i & 31) === 0) lp.set(300 + env * 1700, 1.1);
        return lp.run(o.saw(f * d * (1 + Math.sin(t * 30 + vib) * 0.004 * Math.min(1, t)))) * env * 0.4;
      });
    }
  }
  return tail(out, 0.9, 0.3, 2500);
}

function towerHum(r: Rand, len: number): Float32Array {
  const out = buf(len);
  const o = new Osc();
  const o2 = new Osc(0.2);
  const m = new Osc();
  const n = white(r);
  const bp = new Biquad('bandpass', 1800, 2);
  fill(out, (t) => {
    const fm = m.sine(31) * 60;
    return o.sine(220 + fm) * 0.5 + o2.saw(110.5) * 0.15 + bp.run(n()) * 0.25 * (0.6 + 0.4 * Math.sin(t * 60));
  });
  return out;
}

function towerShot(r: Rand): Float32Array {
  const len = 0.7;
  const out = buf(len);
  const o = new Osc();
  const mod = new Osc();
  const lp = new Biquad('lowpass', 4000, 0.9);
  fill(out, (t) => {
    const f = glide(1400, 140, t, 0.35);
    const m = mod.sine(f * 1.5) * f * 2.5 * perc(t, 0.001, 0.3);
    return lp.run(o.sine(f + m)) * perc(t, 0.004, 0.5);
  });
  return layer([out, 0.8], [thump(r, 0.45, 160, 50, { click: 0.4, drive: 2.5 }), 0.8], [whoosh(r, 0.4, 3500, 900, { q: 0.8 }), 0.5]);
}

function roarBird(r: Rand, len: number): Float32Array {
  // a fiery bird cry: a bright, screeching vowel gliding down
  return vowel(r, len, (t) => glide(820, 420, t, len) * (1 + Math.sin(t * 40) * 0.03), [[1400, 6, 1], [2600, 7, 0.6], [3800, 8, 0.3]], {
    voices: 3,
    detune: 0.03,
    breath: 0.4,
    growl: 0.06,
    env: (t) => ahr(t, 0.05, len * 0.3, len * 0.6),
  });
}

function darkChord(r: Rand, len: number): Float32Array {
  const out = buf(len);
  for (const f of [73.4, 87.3, 110, 103.8]) {
    const o = new Osc(r());
    const o2 = new Osc(r());
    const lp = new Biquad('lowpass', 700, 0.8);
    fill(out, (t) => lp.run(o.saw(f) + o2.saw(f * 1.006)) * ahr(t, 0.06, 0.3, len - 0.4) * 0.25);
  }
  return tail(out, 0.9, 0.35, 2000);
}

function levelUp(r: Rand): Float32Array {
  const out = buf(1.6);
  const notes = [587.3, 740, 880, 1174.7];
  notes.forEach((f, k) => chime(r, 1.6 - k * 0.08, f, { at: k * 0.08, out, gain: 0.8 }));
  return layer([out, 1], [shimmer(r, 1.4, 1174.7, { rise: 1.2, peak: 0.3 }), 0.4, 0.2]);
}

function heartbeat(r: Rand): Float32Array {
  const out = buf(0.92);
  const lub = thump(r, 0.2, 70, 40, { click: 0.05, noise: 0.1, drive: 1.5 });
  const dub = thump(r, 0.18, 62, 38, { click: 0.05, noise: 0.1, drive: 1.5 });
  for (let i = 0; i < lub.length; i++) out[i]! += lub[i]!;
  const o = Math.round(0.24 * RATE);
  for (let i = 0; i < dub.length; i++) out[o + i]! += dub[i]! * 0.7;
  return filter(out, 'lowpass', 300);
}

function coin(r: Rand): Float32Array {
  const out = buf(0.5);
  const f = 1900 + r() * 200;
  chime(r, 0.4, f, { out, gain: 0.7 });
  chime(r, 0.45, f * 1.335, { out, at: 0.06, gain: 0.8 });
  return out;
}

/**
 * The Sun Relic's hum: a sung "oo" on D and the A above, a little under the
 * goal gong's chord, with a faint glassy halo of slow-beating partials on top.
 * Every tremolo makes whole cycles over the loop, so the seam can't be heard.
 */
function relicHum(r: Rand, len: number): Float32Array {
  const halo = buf(len);
  const ratios = [1, 1.5, 2, 3];
  for (let v = 0; v < ratios.length; v++) {
    const o = new Osc(r());
    const f = 587.3 * ratios[v]! * (1 + (r() - 0.5) * 0.008);
    const trem = (2 + v) / len;
    const tp = r() * 6.283;
    for (let i = 0; i < halo.length; i++) {
      const t = i / RATE;
      halo[i] = halo[i]! + o.sine(f) * (0.55 + 0.45 * Math.sin(t * trem * 6.283 + tp)) / (1 + v);
    }
  }
  const steady = () => 1;
  return loopable(layer([choir(r, len, 146.8, { vowelName: 'oo', env: steady }), 0.8], [choir(r, len, 220, { vowelName: 'oo', env: steady }), 0.45], [halo, 0.12]), 1);
}

/**
 * A crowd: dozens of voices at once, each its own pitch and loudness, through
 * a few vowel shapes, over the breathy roar of a mass of people. `babble`
 * chops each voice into syllables (a murmur); `rise` lifts every pitch as the
 * shout swells; `arc` bends the pitch up then down (an "ooh").
 */
function crowd(
  r: Rand,
  len: number,
  o: { voices: number; pitch: number; rise: number; breath: number; babble: number; lp: number; env: (t: number) => number; vowels?: (keyof typeof VOWELS)[]; arc?: boolean; stagger?: number },
): Float32Array {
  const out = buf(len);
  const shapes = (o.vowels ?? ['ah', 'eh', 'oh']).map((v) => VOWELS[v].map(([f, q, g]) => ({ b: new Biquad('bandpass', f * (0.92 + r() * 0.16), q * 0.6), g })));
  const people = Array.from({ length: o.voices }, (_, k) => ({
    o: new Osc(r()),
    f: o.pitch * (0.55 + r() * 1.15),
    // shouting voices waver: a few percent of pitch, several times a second
    drift: wander(r, 3 + r() * 4),
    loud: wander(r, 2 + r() * 3 + o.babble * 5),
    start: o.babble > 0.5 ? 0 : r() * (o.stagger ?? 0.3),
    shape: k % shapes.length,
  }));
  const sums = shapes.map(() => 0);
  const air = pink(r);
  const airBand = new Biquad('bandpass', 1100, 0.45);
  const lp = new Biquad('lowpass', o.lp, 0.6);
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = o.env(t);
    const lift = 1 + o.rise * (o.arc ? Math.sin(Math.min(1, t / (len * 0.8)) * Math.PI) : Math.min(1, t / 0.6));
    sums.fill(0);
    for (const p of people) {
      if (t < p.start) continue;
      const l = p.loud();
      // a murmur is mostly gaps between words; a roar is everyone at once
      const amp = o.babble > 0 ? Math.max(0, l * (0.6 + o.babble * 0.6) + 0.35 - o.babble * 0.25) : 0.6 + 0.4 * l;
      sums[p.shape]! += p.o.saw(p.f * lift * (1 + p.drift() * 0.07)) * amp;
    }
    let y = 0;
    for (let s = 0; s < shapes.length; s++) for (const f of shapes[s]!) y += f.b.run(sums[s]!) * f.g;
    // (strained a little, the way a shout is)
    y = drive((y * 2.2) / Math.sqrt(o.voices), 1.5) + airBand.run(air()) * o.breath * 2;
    out[i] = lp.run(y) * env;
  }
  return out;
}

/**
 * The stands chanting {@link CHANT}'s pattern: the stamp of hundreds of feet,
 * a crowd's claps and a shout to end each phrase, every hit made fresh, in a
 * stadium's air. Built to wrap exactly on its length (the reverb runs over two
 * laps and the second is kept), so it stays on the beat the stands move to.
 */
function chant(r: Rand): Float32Array {
  const n = Math.round(CHANT_LOOP * RATE);
  const out = new Float32Array(n);
  const nz = white(r);
  // each hit is built with 30 ms of room before its beat, for the stragglers
  const lead = 0.03;
  const put = (b: Float32Array, beat: number, gain: number) => {
    const at = Math.round((beat * CHANT_BEAT - lead) * RATE) + n;
    for (let i = 0; i < b.length; i++) out[(at + i) % n]! += b[i]! * gain;
  };
  // a few feet and hands, each its own, drawn on again and again in every stamp and clap
  // (a foot: the thud of the body, and the knock of the stand it lands on)
  const feet = Array.from({ length: 6 }, () => layer(thump(r, 0.2 + r() * 0.1, 140 + r() * 90, 75, { click: 0.15, noise: 0.75 }), [knock(r, 0.12, 240 + r() * 280), 5]));
  const blows = Array.from({ length: 3 }, () => thump(r, 0.4, 104 + r() * 12, 58, { click: 0, noise: 0.15 }));
  const hands = Array.from({ length: 12 }, () => {
    const bp = new Biquad('bandpass', 950 + r() * 1700, 1 + r() * 0.8);
    const decay = 0.03 + r() * 0.035;
    const o = buf(decay * 1.4);
    fill(o, (t) => bp.run(nz()) * perc(t, 0.0006, decay));
    return o;
  });
  const pick = <T>(of: T[]) => of[Math.floor(r() * of.length)]!;
  /** `count` of `parts` summed into a new hit, spread over `spread` seconds from just before the beat (most a touch late, the way a crowd keeps time). */
  const many = (parts: Float32Array[], count: number, spread: number, len: number, gain: number) => {
    const o = buf(len);
    for (let k = 0; k < count; k++) {
      const p = pick(parts);
      const at = Math.round((lead + (r() - 0.2) * spread) * RATE);
      const g = gain * (0.4 + r() * 0.6);
      for (let i = 0; i < p.length; i++) o[at + i]! += p[i]! * g;
    }
    return o;
  };
  const stamp = () => {
    const o = many(feet, 16, 0.05, 0.5, 0.3);
    // one deep blow under it all, so the stamp lands as one
    const body = pick(blows);
    for (let i = 0; i < body.length; i++) o[i + Math.round(lead * RATE)]! += body[i]! * 0.4;
    // (no sub below the thud: it would only eat the headroom the knock needs)
    return filter(filter(o, 'highpass', 70), 'lowpass', 2400);
  };
  const clap = () => many(hands, 32, 0.045, 0.2, 1);
  const shout = () => {
    const s = crowd(r, 0.62, { voices: 20, pitch: 178, rise: 0.12, breath: 0.45, babble: 0, stagger: 0.04, lp: 3600, vowels: ['eh', 'ah'], env: (t) => ahr(t, 0.03, 0.13, 0.36) });
    const o = buf(0.62 + lead);
    o.set(s, Math.round(lead * RATE));
    return o;
  };
  // each hit's level, matched by its own peak so the mix holds whatever the take
  const level = (b: Float32Array, to: number) => normalize(b, to);
  for (let take = 0; take < CHANT.takes; take++) {
    const top = take * CHANT.beats;
    for (const s of CHANT.stomps) put(level(stamp(), 1), top + s, 0.92 + r() * 0.16);
    for (const c of CHANT.claps) put(level(clap(), 0.45), top + c, 0.9 + r() * 0.2);
    put(level(shout(), 0.8), top + CHANT.shout, 1);
    put(level(clap(), 0.35), top + CHANT.shout, 1);
  }
  // the stadium's air, run over two laps so the tail of the last hit is in the first
  const laps = new Float32Array(n * 2);
  laps.set(out);
  laps.set(out, n);
  return dcBlock(tail(laps, 0.95, 0.32, 2600)).slice(n);
}

function windBed(r: Rand, len: number): Float32Array {
  const out = buf(len + 1);
  const n = pink(r);
  const bp = new Biquad('bandpass', 500, 0.6);
  const lp = new Biquad('lowpass', 300, 0.6);
  const gust = wander(r, 0.18);
  const tone = wander(r, 0.35);
  for (let i = 0; i < out.length; i++) {
    const g = 0.45 + 0.55 * Math.max(0, gust());
    if ((i & 63) === 0) bp.set(350 + 500 * (0.5 + 0.5 * tone()) * g, 0.8);
    const x = n();
    out[i] = (bp.run(x) * 1.6 * g + lp.run(x) * 0.9) * (0.5 + 0.5 * g);
  }
  return loopable(out, 1);
}

function leavesBed(r: Rand, len: number): Float32Array {
  const out = buf(len + 1);
  const n = white(r);
  const hp = new Biquad('highpass', 2500, 0.6);
  const lp = new Biquad('lowpass', 7000, 0.6);
  const gust = wander(r, 0.3);
  const flutter = wander(r, 14);
  for (let i = 0; i < out.length; i++) {
    const g = Math.max(0, gust()) ** 1.5;
    out[i] = lp.run(hp.run(n())) * g * (0.5 + 0.5 * Math.abs(flutter()));
  }
  crackle(out, r, 25, (t) => Math.max(0, Math.sin(t * 0.7)) ** 2, { tone: 4500, gain: 0.3, len: 0.003 });
  return loopable(out, 1);
}

function water(r: Rand, len: number): Float32Array {
  const out = buf(len + 0.5);
  const n = white(r);
  const bp = new Biquad('bandpass', 900, 0.5);
  const hp = new Biquad('highpass', 3000);
  for (let i = 0; i < out.length; i++) out[i] = bp.run(n()) * 0.5 + hp.run(n()) * 0.15;
  // bubbles: short rising sine chirps
  const count = Math.round(len * 55);
  for (let k = 0; k < count; k++) {
    const at = r() * len;
    const f = 400 + r() * 1400;
    const d = 0.02 + r() * 0.05;
    const o = new Osc();
    const g = 0.05 + r() * 0.15;
    fill(out, (t) => o.sine(f * (1 + t * 12)) * perc(t, 0.001, d) * g, at, at + d * 1.5);
  }
  return loopable(out, 0.5);
}

/** A cavern's breath: low brown noise that swells and sinks, over two faint beating tones. */
function caveBed(r: Rand, len: number): Float32Array {
  const out = buf(len + 1);
  let v = 0;
  const lp = new Biquad('lowpass', 140, 0.7);
  const bp = new Biquad('bandpass', 260, 1.2);
  const swell = wander(r, 0.12);
  const a = new Osc();
  const b = new Osc();
  for (let i = 0; i < out.length; i++) {
    v = (v + (r() * 2 - 1) * 0.04) * 0.997;
    const g = 0.6 + 0.4 * swell();
    const t = i / RATE;
    out[i] = (lp.run(v * 3) * 1.4 + bp.run(v * 3) * 0.35 * g) * g + (a.sine(41) + b.sine(61.5) * 0.7) * 0.05 * (0.6 + 0.4 * Math.sin(t * 0.45));
  }
  return loopable(dcBlock(out), 1.5);
}

/** A great forge somewhere below: the furnace's low roar, breathing with the bellows, and embers spitting. */
function forgeBed(r: Rand, len: number): Float32Array {
  const out = buf(len + 1);
  const br = brown(r);
  const pk = pink(r);
  const lp = new Biquad('lowpass', 150, 0.8);
  const body = new Biquad('bandpass', 280, 0.5);
  const bp = new Biquad('bandpass', 360, 0.7);
  const flicker = wander(r, 2.2);
  const flutter = wander(r, 9);
  // the bellows push every few seconds; each breath wraps round the loop's length, so the seam falls inside one unheard
  const breaths: number[] = [];
  for (let t = r() * 1.5; t < len - 1.5; t += 2.9 + r() * 1.1) breaths.push(t);
  const push = (t: number): number => {
    let e = 0;
    for (const b of breaths) {
      const d = (((t - b) % len) + len) % len;
      if (d < 2.6) e = Math.max(e, ahr(d, 0.8, 0.3, 1.5));
    }
    return e;
  };
  for (let i = 0; i < out.length; i++) {
    const p = push(i / RATE);
    if ((i & 63) === 0) bp.set(300 + 400 * p, 0.7);
    const x = pk();
    const flame = (0.8 + 0.2 * flicker()) * (0.85 + 0.15 * flutter());
    out[i] = lp.run(br()) * 0.35 + (body.run(x) * 0.9 + bp.run(x) * 1.7 * p) * (0.55 + 0.45 * p) * flame;
  }
  crackle(out, r, 16, (t) => 0.35 + push(t), { tone: 1700, gain: 0.3, len: 0.004 });
  return loopable(dcBlock(out), 1);
}

/** A smith's hammer on an anvil far off in the caverns: a few ringing blows, dulled by the distance and carried by the rock. */
function anvil(r: Rand): Float32Array {
  const blows = 2 + Math.floor(r() * 3);
  const gap = 0.58 + r() * 0.2;
  const out = buf(blows * gap + 1.8);
  const base = 640 + r() * 150;
  for (let k = 0; k < blows; k++) {
    // the last blow is the light one, a tap to settle the work
    const g = k === blows - 1 && blows > 2 ? 0.45 : 1 - k * 0.08;
    mixIn(out, clang(r, 1.5, base, { decay: 1.1, bright: 0.5, gain: g }), k * gap + (r() - 0.5) * 0.03);
  }
  const lp = new Biquad('lowpass', 2300, 0.7);
  for (let i = 0; i < out.length; i++) out[i] = lp.run(out[i]!);
  return tail(out, 1, 0.55, 1700);
}

/**
 * Falling down into the next depth: air rushing past, rising in pitch and
 * buffeting harder the further the team drops, over a deep rumble, cut off
 * just before the landing (its thump plays as the team lands).
 */
function plunge(r: Rand): Float32Array {
  const len = 2.15;
  const out = buf(len + 0.35);
  const n = pink(r);
  const bp = new Biquad('bandpass', 300, 0.8);
  const hi = new Biquad('bandpass', 1800, 1.2);
  // (the rumble sits in the low mids, where small speakers still carry it)
  const rumble = new Biquad('bandpass', 150, 0.9);
  const buffet = wander(r, 9);
  const gust = wander(r, 2.5);
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const k = Math.min(1, t / len);
    if ((i & 63) === 0) {
      bp.set(300 + 900 * k * k, 0.8);
      hi.set(1600 + 1400 * k, 1.2);
    }
    // swelling as the fall speeds up, then gone at the bottom
    const env = ahr(t, len * 0.85, len * 0.1, 0.3) * (0.35 + 0.65 * k);
    const x = n();
    const air = bp.run(x) * 0.9 + hi.run(x) * 0.25 * k;
    out[i] = (air * (0.75 + 0.25 * buffet() + 0.15 * gust()) + rumble.run(x) * 0.55 * (1 - 0.4 * k)) * env;
  }
  return tail(out, 0.9, 0.2, 2500);
}

/** Steam venting from a crack in the hot rock: a sudden hiss that sputters and sighs away. */
function vent(r: Rand): Float32Array {
  const len = 1.3 + r() * 0.8;
  const out = buf(len + 0.6);
  const n = white(r);
  const hp = new Biquad('highpass', 900, 0.7);
  const bp = new Biquad('bandpass', 3000, 0.6);
  const sputter = wander(r, 16);
  const f0 = 2400 + r() * 1400;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    if ((i & 63) === 0) bp.set(f0 * (1 - 0.4 * Math.min(1, t / len)), 0.6);
    out[i] = bp.run(hp.run(n())) * ahr(t, 0.04, len * 0.2, len * 0.75) * (0.75 + 0.25 * sputter());
  }
  return tail(out, 0.8, 0.35, 2800);
}

/** Water running through the stone in the dark: many small bubbles over a low rush, heard from a hall away. */
function streamBed(r: Rand, len: number): Float32Array {
  const out = buf(len + 1);
  const n = pink(r);
  const lp = new Biquad('bandpass', 260, 0.7);
  const bp = new Biquad('bandpass', 750, 0.5);
  const flow = wander(r, 0.2);
  for (let i = 0; i < out.length; i++) {
    const x = n();
    out[i] = (lp.run(x) * 0.35 + bp.run(x) * 0.5) * (0.75 + 0.25 * flow());
  }
  // the babble: little rising bubbles, thick where the flow runs strong
  const count = Math.round(len * 130);
  for (let k = 0; k < count; k++) {
    const at = r() * len;
    const f = 300 + r() ** 1.3 * 1500;
    const d = 0.01 + r() * 0.03;
    const o = new Osc();
    const g = (0.04 + r() * 0.12) * (0.6 + 0.4 * Math.sin((at / len) * Math.PI * 4 + 1) ** 2);
    fill(out, (t) => o.sine(f * (1 + t * 18)) * perc(t, 0.0015, d) * g, at, at + d * 1.6);
  }
  const far = new Biquad('lowpass', 2800, 0.6);
  for (let i = 0; i < out.length; i++) out[i] = far.run(out[i]!);
  return loopable(tail(out, 0.85, 0.35, 2200), 1);
}

/** A great bell tolling somewhere under the water: deep and muffled, its note wavering as it carries. */
function drownedToll(r: Rand): Float32Array {
  const len = 7.5;
  const dry = buf(len);
  const base = 182 + r() * 24;
  // a bell's partials: the hum an octave down, the strike note, its minor third and fifth, the nominal and the clang above
  modal(dry, base, [[0.5, 0.45, 6.5], [1, 1, 5], [1.19, 0.6, 3.6], [1.5, 0.35, 2.8], [2, 0.65, 2.6], [2.52, 0.35, 1.8], [3.01, 0.32, 1.4], [4.1, 0.2, 1], [5.4, 0.12, 0.7], [6.8, 0.08, 0.5]], { gain: 0.5, attack: 0.004 });
  mixIn(dry, thump(r, 0.3, 140, 70, { click: 0.04, noise: 0.12 }), 0, 0.3);
  // the water: a slow wobble in the pitch and a murk that thickens and thins
  const out = buf(len);
  const lp = new Biquad('lowpass', 900, 0.6);
  const murk = wander(r, 0.7);
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const at = i - (0.005 + 0.0025 * Math.sin(t * 3.4)) * RATE;
    const j = Math.floor(at);
    const x = j < 0 ? 0 : dry[j]! + (dry[j + 1] ?? 0) * (at - j) - dry[j]! * (at - j);
    if ((i & 63) === 0) lp.set(1100 + 800 * (0.5 + 0.5 * murk()), 0.6);
    out[i] = lp.run(x);
  }
  return tail(out, 1.2, 0.45, 1400);
}

/** Wind over the edge of a bottomless drop: a broad low rush, and hollow moans where it sings across the mouths of shafts. */
function hollowBed(r: Rand, len: number): Float32Array {
  const out = buf(len + 1);
  const n = pink(r);
  const lp = new Biquad('lowpass', 380, 0.7);
  const hp = new Biquad('highpass', 110, 0.7);
  const gust = wander(r, 0.15);
  const pipes = [215, 330, 470].map((f) => ({ f: f * (0.92 + r() * 0.16), b: new Biquad('bandpass', f, 10), sweep: wander(r, (0.08 + r() * 0.08) * 64), swell: wander(r, 0.1 + r() * 0.12) }));
  for (let i = 0; i < out.length; i++) {
    const x = n();
    const g = 0.4 + 0.6 * Math.max(0, gust());
    let y = hp.run(lp.run(x)) * 1.2 * (0.5 + 0.5 * g);
    for (const p of pipes) {
      if ((i & 63) === 0) p.b.set(p.f * (1 + 0.1 * p.sweep()), 10);
      y += p.b.run(x) * 6 * Math.max(0, p.swell()) ** 2 * g;
    }
    out[i] = y;
  }
  return loopable(dcBlock(out), 1);
}

/** Voices whispering in the dark: breath shaped into syllables no one can make out, two or three at once. */
function whisper(r: Rand): Float32Array {
  const len = 2.2 + r() * 0.8;
  const out = buf(len + 0.6);
  const shapes = Object.values(VOWELS);
  const voices = 2 + Math.floor(r() * 2);
  for (let v = 0; v < voices; v++) {
    const n = white(r);
    const fs = [0, 1, 2].map(() => new Biquad('bandpass', 1000, 6));
    const sib = new Biquad('highpass', 4300, 0.8);
    const breath = new OnePole(5200);
    // each whisperer is a little higher or lower, and starts a beat after the last
    const lift = 0.88 + r() * 0.3;
    const from = 0.04 + v * (0.2 + r() * 0.35);
    const to = Math.min(len - 0.1, from + 1.1 + r() * 1.2);
    let t0 = from;
    while (t0 < to) {
      const d = 0.09 + r() * 0.15;
      const shape = shapes[Math.floor(r() * shapes.length)]!;
      fs.forEach((f, k) => f.set(shape[k]![0] * lift, 5));
      const hiss = r() < 0.45 ? 0.05 + r() * 0.05 : 0;
      const a = Math.round(t0 * RATE);
      const z = Math.min(out.length, Math.round((t0 + hiss + d) * RATE));
      const phrase = (t: number) => Math.sin(Math.PI * Math.min(1, Math.max(0, (t - from) / (to - from)))) ** 0.6;
      for (let i = a; i < z; i++) {
        const t = (i - a) / RATE;
        const x = breath.run(n());
        let y = 0;
        if (t < hiss) y = sib.run(n()) * 0.35 * Math.sin((Math.PI * t) / hiss);
        else {
          const u = (t - hiss) / d;
          for (let k = 0; k < 3; k++) y += fs[k]!.run(x) * shape[k]![2];
          y *= Math.sin(Math.PI * u) ** 1.5 * 2.2;
        }
        out[i]! += y * phrase(i / RATE) * (0.7 + 0.3 * (v === 0 ? 1 : r()));
      }
      t0 += hiss + d + (r() < 0.25 ? 0.12 + r() * 0.15 : 0.015 + r() * 0.04);
    }
  }
  return tail(out, 0.9, 0.45, 3200);
}

/** One drop falling into a still pool far off: a quick rising plink. */
function drip(r: Rand): Float32Array {
  const len = 0.18;
  const out = buf(len);
  const o = new Osc();
  const f = 900 + r() * 900;
  fill(out, (t) => o.sine(f * (1 + t * 9)) * perc(t, 0.001, 0.05) * 0.8);
  return out;
}

function insects(r: Rand, len: number): Float32Array {
  const out = buf(len + 1);
  // a few cicada-like trills that wax and wane
  for (let k = 0; k < 4; k++) {
    const o = new Osc();
    const am = new Osc(r());
    const f = 4200 + r() * 2400;
    const rate = 30 + r() * 40;
    const sw = wander(r, 0.2 + r() * 0.2);
    fill(out, () => o.sine(f) * Math.max(0, am.sine(rate)) ** 3 * Math.max(0, sw()) * 0.25);
  }
  return loopable(out, 1);
}

function crow(r: Rand): Float32Array {
  const out = buf(1.1);
  const calls = 2 + Math.floor(r() * 2);
  for (let k = 0; k < calls; k++) {
    const v = vowel(r, 0.28, (t) => glide(560, 470, t, 0.28), [[1100, 5, 1], [1700, 6, 0.6], [2700, 7, 0.3]], { breath: 0.4, growl: 0.15, voices: 2, detune: 0.03, env: (t) => ahr(t, 0.02, 0.1, 0.15) });
    const o = Math.round(k * 0.32 * RATE);
    for (let i = 0; i < v.length && o + i < out.length; i++) out[o + i]! += v[i]! * 0.6;
  }
  return out;
}

/** Renders a recipe's variants. */
export function renderRecipe(recipe: Recipe, seed: number): Float32Array[] {
  const out: Float32Array[] = [];
  const n = recipe.variants ?? 1;
  for (let v = 0; v < n; v++) {
    const r = rngFor(seed + v * 7919);
    let b = recipe.make(r, v);
    b = normalize(recipe.exact ? b : dcBlock(b), recipe.peak ?? 0.9);
    // loops get a crossfaded seam so they never click when they wrap
    if (!recipe.exact) b = recipe.loop ? loopable(b, 0.2) : declick(b, 0.5, 12);
    out.push(b);
  }
  return out;
}

