import * as THREE from 'three/webgpu';
import { abs, cameraPosition, float, fract, hash, instanceIndex, max, sin, smoothstep, time, uniform, uv, vec2, vec3, vec4 } from '../render/tsl';
import { instancedSprite } from '../render/shared';
import type { Environment } from '../scene/Environment';
import { frost, frostFor } from '../scene/frost';
import { JOTUNN, type JotunnPhase } from '../sim/Jotunn';

/**
 * The Jötunn brings winter: snow falls while it walks, harder with each
 * brazier it freezes and as its fury grows, and a blizzard howls when it wins.
 * When it falls the snow stops and the sun comes back warm.
 */
export const WINTER = {
  /** Flakes in the box around the camera (only `amount` of them show). */
  flakes: 9000,
  /** The box's width and depth, and height, in meters. */
  box: 36,
  tall: 18,
  /** How hard it snows while the giant wakes, and how much more each brazier it froze and its fury add. */
  waking: 0.22,
  fight: 0.32,
  perBrazier: 0.17,
  perFury: 0.6,
  /** Snow eases in and out this fast (share per second); a blizzard and a clearing sky come quicker. */
  rise: 0.08,
  ease: 0.12,
  storm: 0.35,
  clear: 0.3,
} as const;

/** The state of a round the weather follows. */
export interface WinterState {
  phase: JotunnPhase;
  braziersLeft: number;
  fury: number;
  lastRound: 'giant' | 'gods' | null;
}

/** How hard it snows, 0 to 1, for a round's state. */
export function snowFor(s: WinterState): number {
  if (s.phase === 'over' || s.phase === 'done') return s.lastRound === 'giant' ? 1 : 0;
  if (s.phase === 'countdown') return WINTER.waking;
  const frozen = JOTUNN.braziers.length - s.braziersLeft;
  return Math.min(0.92, WINTER.fight + WINTER.perBrazier * frozen + WINTER.perFury * Math.min(0.4, s.fury));
}

/** How fast the snow moves toward `target` from `now` (share per second). */
function rate(now: number, target: number, s: WinterState): number {
  if (s.phase === 'over' || s.phase === 'done') return s.lastRound === 'giant' ? WINTER.storm : WINTER.clear;
  return target > now ? WINTER.rise : WINTER.ease;
}

/**
 * Falling snow, all on the GPU: every flake's place is worked out from its
 * index and the time, in a box that wraps around the camera and stays put in
 * the world as the camera moves. One draw; flakes past `amount` shrink to
 * nothing, so a light fall costs almost no fill.
 */
class Snowfall {
  readonly sprite: THREE.Sprite;
  /** Share of the flakes that show. */
  readonly amount = uniform(0);
  /** How far the wind has carried the snow, in meters (summed here, so a changing wind never jumps). */
  readonly drift = uniform(new THREE.Vector3());

  constructor() {
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const id = instanceIndex.toFloat();
    const box = float(WINTER.box);
    const tall = float(WINTER.tall);
    const h1 = hash(id);
    const h2 = hash(id.mul(1.37).add(3.1));
    const h3 = hash(id.mul(2.71).add(7.7));
    const speed = hash(id.mul(4.13)).mul(0.8).add(1.05);
    // a slow flutter as it falls
    const sway = sin(time.mul(h2.mul(0.7).add(0.6)).add(h3.mul(6.283))).mul(0.4);
    // each axis wrapped into the box around the camera: k is where the flake sits across it, 0 to 1
    const kx = fract(h1.mul(box).add(this.drift.x).add(sway).sub(cameraPosition.x).div(box).add(0.5));
    const kz = fract(h2.mul(box).add(this.drift.z).sub(sway.mul(0.6)).sub(cameraPosition.z).div(box).add(0.5));
    const ky = fract(h3.mul(tall).sub(time.mul(speed)).add(this.drift.y).sub(cameraPosition.y).div(tall).add(0.5));
    const pos = vec3(kx.sub(0.5).mul(box), ky.sub(0.5).mul(tall), kz.sub(0.5).mul(box)).add(cameraPosition);
    mat.positionNode = pos;
    // which flakes show: those under `amount`, each fading in over a short band so a change never pops
    const pick = hash(id.mul(9.31).add(1.9));
    const shown = float(1).sub(smoothstep(this.amount.sub(0.05), this.amount, pick));
    // thin out toward the box's walls (so the wrap never shows) and right by the lens
    const edge = max(abs(kx.sub(0.5)), abs(kz.sub(0.5))).mul(2);
    const wall = smoothstep(1, 0.72, edge).mul(smoothstep(1, 0.8, abs(ky.sub(0.5)).mul(2)));
    const d = pos.sub(cameraPosition).length();
    const near = smoothstep(2, 5.5, d);
    // smaller close by and a little larger far off, so near flakes never blot the view and far ones still read
    const size = hash(id.mul(5.77)).mul(0.05).add(0.05).mul(d.div(10).clamp(0, 1.6).mul(0.45).add(0.55));
    const s = size.mul(shown.greaterThan(0.001).select(1, 0));
    mat.scaleNode = vec2(s, s);
    const dot = smoothstep(0.5, 0.12, uv().sub(0.5).length());
    // lit snow: brighter than the HDR white of a sunlit wall, a touch blue
    mat.colorNode = vec4(2.5, 2.65, 2.9, 1);
    mat.opacityNode = dot.mul(shown).mul(wall).mul(near).mul(0.8);
    this.sprite = instancedSprite(mat, WINTER.flakes);
    this.sprite.name = 'jotunn-snow';
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 14;
    this.sprite.visible = false;
  }
}

/** The colder light and haze that come with the snow, as shares toward these from the map's own. */
const COLD = {
  fog: new THREE.Color(0.66, 0.73, 0.86),
  sun: new THREE.Color(0.95, 0.93, 0.9),
  fill: new THREE.Color(0.72, 0.82, 1.0),
};

/**
 * The weather of a Jötunn match: the snow, and the light and haze it brings
 * (uniform writes only, so it builds no shader as it changes). Follows the
 * round each frame from its state, so a guest's matches the host's.
 */
export class JotunnWeather {
  readonly group = new THREE.Group();
  private readonly snow = new Snowfall();
  /** How hard it snows now, 0 to 1 (eased toward the round's). */
  level = 0;
  private readonly base: { fog: THREE.Color; density: number; start: number; sun: THREE.Color; sunPower: number; fill: THREE.Color; clouds: number } | null;
  private readonly wind = new THREE.Vector2(0.62, 0.78);

  constructor(private readonly env?: Environment) {
    this.group.name = 'jotunn-weather';
    this.group.add(this.snow.sprite);
    this.base = env
      ? {
          fog: env.fogColor.value.clone(),
          density: env.fogDensity.value,
          start: env.fogStart.value,
          sun: env.sun.color.clone(),
          sunPower: env.sun.intensity,
          fill: env.fill.color.clone(),
          clouds: env.sky.cloudCoverage.value,
        }
      : null;
  }

  frame(dt: number, s: WinterState): void {
    const target = snowFor(s);
    const r = rate(this.level, target, s) * dt;
    this.level = target > this.level ? Math.min(target, this.level + r) : Math.max(target, this.level - r);
    const a = this.level;
    const snow = this.snow;
    snow.amount.value = a;
    snow.sprite.visible = a > 0.001;
    // the wind picks up with the snow: a breeze, then a gale
    const gust = 0.5 + 4.5 * a * a;
    snow.drift.value.x += this.wind.x * gust * dt;
    snow.drift.value.z += this.wind.y * gust * dt;
    // and blows the flakes down faster in a storm
    snow.drift.value.y -= 1.6 * a * a * dt;
    // and the world frosts over as it deepens, melting back as it clears
    frost.value = frostFor(a);
    this.light(a);
  }

  /** Cooler light and a whiter, nearer haze as the snow thickens; the map's own again once it stops. */
  private light(a: number): void {
    const env = this.env;
    const b = this.base;
    if (!env || !b) return;
    const k = Math.min(1, a * 1.6);
    // (a first flurry already cools the haze; none at all gives the map's own back)
    env.fogColor.value.copy(b.fog).lerp(COLD.fog, (0.25 + 0.55 * a) * Math.min(1, a * 4));
    env.fogDensity.value = b.density * (1 + 0.7 * a);
    env.fogStart.value = b.start - 12 * a * a;
    env.sun.color.copy(b.sun).lerp(COLD.sun, k);
    // the sun dims only in a real blizzard
    env.sun.intensity = b.sunPower * (1 - 0.3 * Math.max(0, (a - 0.7) / 0.3));
    env.fill.color.copy(b.fill).lerp(COLD.fill, k);
    env.sky.cloudCoverage.value = b.clouds + 0.3 * a;
  }

  /** Shows every flake for a loading frame (it builds the snow's shader), until the returned call. */
  prime(): () => void {
    const snow = this.snow;
    snow.amount.value = 1;
    snow.sprite.visible = true;
    return () => {
      snow.amount.value = this.level;
      snow.sprite.visible = this.level > 0.001;
    };
  }
}
