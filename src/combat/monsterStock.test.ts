import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { GodModel } from '../actors/GodModel';
import { zeus } from '../game/gods';
import { godUnit, monsterUnit } from '../sim/factory';
import { monsterViewKey } from './MonsterViews';
import { UnitViews } from './UnitViews';

const at = { x: 0, z: 0, yaw: 0 };

describe('monster models built ahead of their monsters', () => {
  it('builds stocked models one a frame, hands them to arriving monsters, and never stocks more than asked', () => {
    const views = new UnitViews(godUnit(zeus, 'order', at), {} as GodModel);
    const thornback = { tag: 'descent-small-1.w1.0:thornback', name: 'Thornback' };
    const shade = { tag: 'descent-small-1.w1.2:shade', name: 'Shade' };
    views.stock([thornback, thornback, shade]);
    views.frame([], 1 / 60, 1);
    expect(views.spareCount).toBe(1);
    views.frame([], 1 / 60, 1);
    views.frame([], 1 / 60, 1);
    views.frame([], 1 / 60, 1);
    expect(views.spareCount).toBe(3);

    // a Thornback rises and takes a spare
    const m = monsterUnit(zeus, 'thornback', at, 1);
    m.tag = 'descent-small-1.w1.1:thornback';
    views.frame([m], 1 / 60, 1);
    expect(views.spareCount).toBe(2);
    expect(views.headOf(m, new THREE.Vector3())).not.toBeNull();

    // asking again only tops the stock up to what the next chamber needs
    views.stock([thornback, thornback, shade]);
    views.frame([m], 1 / 60, 1);
    views.frame([m], 1 / 60, 1);
    expect(views.spareCount).toBe(3);
  });

  it('lets a diving beast go down under the floor instead of lifting it like a god in a leap', () => {
    const views = new UnitViews(godUnit(zeus, 'order', at), {} as GodModel);
    for (const type of ['tideLurker', 'tidemaw'] as const) {
      const m = monsterUnit(zeus, type, at, 1);
      m.tag = `descent-small-7.w1.0:${type}`;
      views.frame([m], 1 / 60, 1);
      const standing = views.headOf(m, new THREE.Vector3())!.y;
      for (let i = 0; i < 120; i++) {
        m.untargetable = 0.2;
        views.frame([m], 1 / 60, 1);
      }
      // its root stays on the floor (its own rig takes it under)
      expect(views.headOf(m, new THREE.Vector3())!.y - standing, type).toBeLessThan(0.1);
    }
  });

  it('keeps Champions and each Warden glow apart from the plain models', () => {
    expect(monsterViewKey({ tag: 'descent-small-6.w1.0:thornbackAlpha', name: 'Champion Thornback Alpha' })).not.toBe(monsterViewKey({ tag: 'descent-small-6.w1.1:thornbackAlpha', name: 'Thornback Alpha' }));
    expect(monsterViewKey({ tag: 'descent-might-4.w1.0:warden', name: 'Warden' })).not.toBe(monsterViewKey({ tag: 'descent-wisdom-4.w1.1:warden', name: 'Warden' }));
    expect(monsterViewKey({ tag: 'descent-small-1.w1.0:thornback', name: 'Thornback' })).toBe(monsterViewKey({ tag: 'descent-small-9.w2.4:thornback', name: 'Thornback' }));
  });
});
