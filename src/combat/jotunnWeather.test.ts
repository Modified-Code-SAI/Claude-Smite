import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Environment } from '../scene/Environment';
import { JOTUNN } from '../sim/Jotunn';
import { JotunnWeather, snowFor, WINTER, type WinterState } from './jotunnWeather';

const fight = (frozen = 0, fury = 0): WinterState => ({ phase: 'fight', braziersLeft: JOTUNN.braziers.length - frozen, fury, lastRound: null });

/** The knobs JotunnWeather turns, as the map sets them. */
function env(): Environment {
  return {
    fogColor: { value: new THREE.Color(0.5, 0.58, 0.86) },
    fogDensity: { value: 0.0035 },
    fogStart: { value: 35 },
    sun: { color: new THREE.Color(1, 0.86, 0.68), intensity: 6.6 },
    fill: { color: new THREE.Color(0.78, 0.84, 1) },
    sky: { cloudCoverage: { value: 0.55 } },
  } as unknown as Environment;
}

const run = (w: JotunnWeather, s: WinterState, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) w.frame(1 / 60, s);
};

describe("the Jötunn's winter", () => {
  it('snows harder with each frozen brazier and the fury, and storms or clears with the round', () => {
    expect(snowFor({ ...fight(), phase: 'countdown' })).toBe(WINTER.waking);
    expect(snowFor(fight(1))).toBeGreaterThan(snowFor(fight(0)));
    expect(snowFor(fight(2))).toBeGreaterThan(snowFor(fight(1)));
    expect(snowFor(fight(2, 0.3))).toBeGreaterThan(snowFor(fight(2)));
    expect(snowFor(fight(2, 5))).toBeLessThan(1);
    expect(snowFor({ ...fight(3), phase: 'over', lastRound: 'giant' })).toBe(1);
    expect(snowFor({ ...fight(1), phase: 'over', lastRound: 'gods' })).toBe(0);
  });

  it('eases in, and cools the light only as far as the snow goes', () => {
    const e = env();
    const w = new JotunnWeather(e);
    run(w, fight(), 1);
    // a gentle start, not a cut
    expect(w.level).toBeGreaterThan(0);
    expect(w.level).toBeLessThan(WINTER.fight);
    run(w, fight(), 10);
    expect(w.level).toBeCloseTo(WINTER.fight, 5);
    expect(e.fogDensity.value).toBeGreaterThan(0.0035);
    // cooler: less red in the sun than the map's warm late morning
    expect(e.sun.color.r - e.sun.color.b).toBeLessThan(1 - 0.68);
    // the sun keeps its strength short of a blizzard
    expect(e.sun.intensity).toBeCloseTo(6.6, 5);
  });

  it('howls when the giant wins, and gives the map its own sky back when it falls', () => {
    const e = env();
    const w = new JotunnWeather(e);
    run(w, fight(2), 12);
    run(w, { ...fight(3), phase: 'over', lastRound: 'giant' }, 4);
    expect(w.level).toBe(1);
    expect(e.sun.intensity).toBeLessThan(6.6);
    expect(e.fogStart.value).toBeLessThan(35);

    const f = env();
    const v = new JotunnWeather(f);
    run(v, fight(2), 12);
    run(v, { ...fight(2), phase: 'over', lastRound: 'gods' }, 4);
    expect(v.level).toBe(0);
    expect(f.fogColor.value.getHex()).toBe(new THREE.Color(0.5, 0.58, 0.86).getHex());
    expect(f.fogDensity.value).toBeCloseTo(0.0035, 9);
    expect(f.fogStart.value).toBeCloseTo(35, 9);
    expect(f.sun.color.getHex()).toBe(new THREE.Color(1, 0.86, 0.68).getHex());
    expect(f.sky.cloudCoverage.value).toBeCloseTo(0.55, 9);
  });

  it('works without a map to light (a test, or a view without one)', () => {
    const w = new JotunnWeather();
    run(w, fight(1), 2);
    expect(w.level).toBeGreaterThan(0);
  });
});
