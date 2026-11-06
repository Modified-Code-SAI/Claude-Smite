import { describe, expect, it } from 'vitest';
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
    // every one inside the time its body stays
    for (const t of ['thornback', 'warden', 'treasureWyrm', 'shade', 'gravekeeper', 'ossuaryKing']) {
      const v = createMonsterView({ tag: `descent-small-1.w1.0:${t}`, name: t });
      expect(sinksAfter(`descent-small-1.w1.0:${t}`), t).toBeLessThan((v.linger ?? 3) - 0.5);
    }
  });
});
