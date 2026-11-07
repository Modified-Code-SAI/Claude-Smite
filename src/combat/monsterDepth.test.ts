import { describe, expect, it } from 'vitest';
import { zeus } from '../game/gods';
import { CINDER } from '../sim/Descent';
import { monsterUnit } from '../sim/factory';
import { createMonsterView, monsterDepth, setMonsterDepth, sinksAfter } from './MonsterViews';

describe("the Descent's beasts take on their depth", () => {
  it('dresses them for each depth and back in the jungle look, eyes and all', () => {
    createMonsterView({ tag: 'descent-small-1.w1.0:thornback', name: 'Thornback' });
    createMonsterView({ tag: 'descent-small-1.w1.0:thornbackAlpha', name: 'Thornback Alpha' });
    const jungle = monsterDepth();
    expect(jungle.weights).toEqual([0, 0, 0]);
    // the eyes and the Alpha's crest
    expect(jungle.glows.length).toBeGreaterThanOrEqual(2);
    const eyes = new Set<number>();
    for (const [p, k] of [['ember', 0], ['soul', 1], ['spirit', 2]] as const) {
      setMonsterDepth(p);
      const d = monsterDepth();
      expect(d.weights.reduce((a, b) => a + b, 0)).toBe(1);
      expect(d.weights[k]).toBe(1);
      expect(new Set(d.glows).size).toBe(1);
      eyes.add(d.glows[0]!);
    }
    // every depth's light its own, none the jungle's amber
    expect(eyes.size).toBe(3);
    expect(eyes.has(jungle.glows[0]!)).toBe(false);
    setMonsterDepth(null);
    expect(monsterDepth()).toEqual(jungle);
  });

  it('knows when each body starts going into the ground, so the depth can take it as it goes', () => {
    expect(sinksAfter('descent-small-1.w1.0:thornback')).toBe(1.6);
    expect(sinksAfter('descent-small-1.w1.0:thornSpitter')).toBe(1.6);
    expect(sinksAfter('descent-small-1.w1.0:shade')).toBe(1.3);
    expect(sinksAfter('descent-small-1.w1.0:moltenColossus')).toBe(sinksAfter('jungle-might:warden'));
    expect(sinksAfter('descent-boss-1:ossuaryKing')).toBe(2.4);
    // a Cinderling's husk only goes once it has burst
    expect(sinksAfter('descent-small-1.w1.0:cinderling')).toBeGreaterThan(CINDER.warn);
    // every one inside the time its body stays
    for (const t of ['thornback', 'warden', 'treasureWyrm', 'shade', 'gravekeeper', 'ossuaryKing', 'cinderling', 'slagBrute', 'drownedThrall', 'lanternJelly', 'tideLurker']) {
      const v = createMonsterView({ tag: `descent-small-1.w1.0:${t}`, name: t });
      expect(sinksAfter(`descent-small-1.w1.0:${t}`), t).toBeLessThan((v.linger ?? 3) - 0.5);
    }
  });

  it("poses the forge's and the Drowned Halls' beasts through a run, a blow and a death without coming apart", () => {
    for (const t of ['cinderling', 'slagBrute', 'drownedThrall', 'lanternJelly', 'tideLurker'] as const) {
      const u = monsterUnit(zeus, t, { x: 0, z: 0, yaw: 0 }, 1);
      u.tag = `descent-small-4.w1.0:${t}`;
      const v = createMonsterView(u);
      const pose = (seconds: number, death: (k: number) => number) => {
        for (let i = 0; i < seconds * 60; i++) v.animate(u, 1 / 60, death(i / 60), Math.sin(i) * 0.5);
      };
      u.vx = 3;
      pose(1, () => -1);
      u.vx = 0;
      u.windup = 0.4;
      pose(0.3, () => -1);
      u.windup = 0;
      u.sinceAction = 0;
      pose(0.6, () => -1);
      pose(3, (k) => k);
      v.root.updateMatrixWorld(true);
      v.root.traverse((o) => {
        for (const x of o.matrixWorld.elements) expect(Number.isFinite(x), `${t} ${o.name}`).toBe(true);
      });
    }
  });
});

