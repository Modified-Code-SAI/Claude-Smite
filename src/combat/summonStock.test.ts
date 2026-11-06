import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { GodModel } from '../actors/GodModel';
import { loki, odin, zeus } from '../game/gods';
import { godUnit, summonUnit } from '../sim/factory';
import type { Unit } from '../sim/Unit';
import { createGodModel } from './godModels';
import { UnitViews } from './UnitViews';

// god models need the loaded glTF bodies: stand-ins that remember how they were made
vi.mock('./godModels', async () => {
  const THREE = await import('three/webgpu');
  return {
    createGodModel: vi.fn((god: string, variant = 'god') => {
      const root = new THREE.Group();
      root.name = `${god}|${variant}`;
      return { root, castHold: 0.3, castWeight: 0, deathTime: -1, rested: 0, rest() { this.rested++; }, animate() {}, startCast() {}, flinch() {}, hitStop() {} };
    }),
  };
});

const at = { x: 0, z: 0, yaw: 0 };
const playerModel = () => ({ root: new THREE.Group(), castHold: 0.3, castWeight: 0, deathTime: -1 }) as unknown as GodModel;
const built = () => vi.mocked(createGodModel).mock.calls.map(([god, variant]) => `${god}|${variant ?? 'god'}`);
const summon = (owner: Unit, kind: string, index: number) => {
  const s = summonUnit(owner, kind, at, index);
  s.owner = owner;
  return s;
};
const modelOf = (views: UnitViews, u: Unit) => (views as unknown as { views: Map<Unit, { model: GodModel & { rested: number } }> }).views.get(u)!.model;

describe('summon models built ahead and reused', () => {
  it('builds every summoner\'s summons while loading, hands them to casts, and takes them back', () => {
    vi.mocked(createGodModel).mockClear();
    const player = godUnit(zeus, 'order', at);
    const views = new UnitViews(player, playerModel());
    const trickster = godUnit(loki, 'chaos', at);
    const allfather = godUnit(odin, 'order', at);
    const gods = [player, trickster, allfather];

    // the gods themselves, then Loki's Mirror Legion (2) and Decoy (1), Odin's Einherjar (2), and nothing for Zeus
    views.prime(gods);
    expect(views.summonSpareCount).toBe(5);
    expect(built().sort()).toEqual(['loki|god', 'loki|god', 'loki|god', 'loki|god', 'odin|god', 'summon:einherjar|einherjar', 'summon:einherjar|einherjar']);

    // the first frame builds nothing more
    views.frame(gods, 1 / 60, 1);
    expect(built()).toHaveLength(7);
    expect(views.summonSpareCount).toBe(5);

    // a cast takes spares and builds nothing; Loki's copies wear Loki's body
    vi.mocked(createGodModel).mockClear();
    const copies = [summon(trickster, 'mirror-copy', 0), summon(trickster, 'mirror-copy', 1)];
    const warriors = [summon(allfather, 'einherjar', 0), summon(allfather, 'einherjar', 1)];
    views.frame([...gods, ...copies, ...warriors], 1 / 60, 1);
    expect(built()).toEqual([]);
    expect(views.summonSpareCount).toBe(1);
    expect(modelOf(views, copies[0]!).root.name).toBe('loki|god');
    expect(modelOf(views, warriors[0]!).root.name).toBe('summon:einherjar|einherjar');
    expect(modelOf(views, warriors[0]!).root.scale.x).toBeCloseTo(0.88);

    // when they end, their models wait for the next cast, which gets them fresh
    const first = modelOf(views, copies[0]!);
    views.frame(gods, 1 / 60, 1);
    expect(views.summonSpareCount).toBe(5);
    const again = [summon(trickster, 'mirror-copy', 0), summon(trickster, 'mirror-copy', 1)];
    views.frame([...gods, ...again], 1 / 60, 1);
    expect(built()).toEqual([]);
    expect([modelOf(views, again[0]!), modelOf(views, again[1]!)]).toContain(first);
    expect(first.rested).toBe(2);
  });

  it('builds a summon on the spot when the spares run out, and one less ahead', () => {
    vi.mocked(createGodModel).mockClear();
    const player = godUnit(zeus, 'order', at);
    const views = new UnitViews(player, playerModel());
    const trickster = godUnit(loki, 'chaos', at);
    // no loading pass (an online guest meets the god mid-match): the decoy arrives before its spares are built
    const decoy = summon(trickster, 'decoy', 0);
    // the god's own model, the decoy's (one less to build ahead), then a spare a frame: the two Mirror Copies
    views.frame([player, trickster, decoy], 1 / 60, 1);
    expect(built().filter((k) => k === 'loki|god')).toHaveLength(3);
    for (let i = 0; i < 3; i++) views.frame([player, trickster, decoy], 1 / 60, 1);
    expect(built().filter((k) => k === 'loki|god')).toHaveLength(4);
    expect(views.summonSpareCount).toBe(2);
  });
});
