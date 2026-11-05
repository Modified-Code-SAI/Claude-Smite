import { beforeEach, describe, expect, it } from 'vitest';
import { applyBuild, BuildBook, MAX_SAVED, readyBuilds, snapshotBuild, spendAlong, type Build } from './builds';
import { Combatant } from './combatant';
import { validateLoadout } from './loadout';
import { GODS, godById } from './gods';
import { FAVOR_THRESHOLDS, MAX_TREE_POINTS, XP_TABLE } from './progression';
import { botBuildOrder, indexTrees, pointsInTree } from './trees';
import type { GodDef } from './types';

/** A local storage the tests can read back (the game's own is absent under node). */
class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = store;
});

const zeus = godById('zeus')!;

function god(def: GodDef, level = 1, favor = false): Combatant {
  const c = new Combatant(def, 'order');
  c.gainXp(XP_TABLE[level - 1]!);
  if (favor) c.gainFavor(FAVOR_THRESHOLDS.at(-1)!);
  return c;
}

const keystone = (def: GodDef, tree: number) => def.trees[tree]!.nodes.find((n) => n.tier === 4)!;
const treeTotal = (def: GodDef, tree: number) => def.trees[tree]!.nodes.reduce((a, n) => a + n.maxRank, 0);

describe('ready-made builds', () => {
  it('offers one build per playstyle tree, named after it', () => {
    for (const def of GODS) {
      const builds = readyBuilds(def);
      expect(builds.map((b) => b.name)).toEqual(def.trees.map((t) => t.name));
      expect(new Set(builds.map((b) => b.id)).size).toBe(def.trees.length);
    }
  });

  it("brings the skills its keystone changes, on a bar that's always legal", () => {
    for (const def of GODS) {
      for (const [i, b] of readyBuilds(def).entries()) {
        expect(validateLoadout(def, b.loadout)).toBeNull();
        for (const e of keystone(def, i).effects) if (e.type === 'augment' || e.type === 'skill') expect(b.loadout).toContain(e.skill);
      }
      // the trees play differently, so their bars differ
      expect(new Set(readyBuilds(def).map((b) => b.loadout.join())).size).toBeGreaterThan(1);
    }
  });

  it('goes straight up its tree to the keystone before a point lands anywhere else, every god, every tree', () => {
    for (const def of GODS) {
      const index = indexTrees(def);
      for (const [i, b] of readyBuilds(def).entries()) {
        const c = god(def);
        for (let lvl = 1; lvl <= 20; lvl++) {
          c.gainXp(Math.max(0, XP_TABLE[lvl - 1]! - c.xp));
          spendAlong(c, b);
          expect(c.unspentPoints).toBe(0);
          const main = pointsInTree(index, c.allocation, def.trees[i]!.id);
          const elsewhere = Object.values(c.allocation).reduce((a, r) => a + r, 0) - main;
          if (elsewhere > 0) expect(main).toBe(treeTotal(def, i));
        }
        // level 20's 19 points: the keystone, the moment its tree opens it
        expect(c.allocation[keystone(def, i).id]).toBe(keystone(def, i).maxRank);
      }
    }
  });

  it('spends a full budget with nothing left over', () => {
    const c = god(zeus, 20, true);
    spendAlong(c, readyBuilds(zeus)[2]!);
    expect(c.unspentPoints).toBe(0);
    expect(Object.values(c.allocation).reduce((a, r) => a + r, 0)).toBe(MAX_TREE_POINTS);
  });
});

describe('saved builds', () => {
  /** A hand-made mix: bot-style spending led by the third tree. */
  function handBuilt(def: GodDef): Combatant {
    const c = god(def, 20, true);
    const order = botBuildOrder(def, 2);
    while (c.unspentPoints > 0 && order.some((id) => c.allocate(id) === null));
    c.swap(0, def.skills.find((s) => s.kind === 'regular' && !c.loadout.includes(s.id))!.id);
    return c;
  }

  it('remembers the bar, the ranks, and the trees by points spent', () => {
    const c = handBuilt(zeus);
    const b = snapshotBuild(c, 'mine:1', 'Test');
    expect(b.loadout).toEqual(c.loadout);
    expect(b.ranks).toEqual(c.allocation);
    expect(b.trees[0]).toBe(2);
  });

  it('rebuilds the exact same points in a new match, learned along the way as levels come', () => {
    for (const def of GODS) {
      const made = handBuilt(def);
      const b = snapshotBuild(made, 'mine:1', 'Test');
      const c = god(def);
      for (let lvl = 1; lvl <= 20; lvl++) {
        c.gainXp(Math.max(0, XP_TABLE[lvl - 1]! - c.xp));
        spendAlong(c, b);
        // never a point outside the plan while the plan has room
        for (const [id, r] of Object.entries(c.allocation)) expect(r).toBeLessThanOrEqual(b.ranks[id] ?? 0);
      }
      c.gainFavor(FAVOR_THRESHOLDS.at(-1)!);
      spendAlong(c, b);
      expect(c.allocation).toEqual(made.allocation);
    }
  });

  it('puts points past a small plan up its main tree', () => {
    const early = god(zeus, 4);
    const order = botBuildOrder(zeus, 1);
    while (early.unspentPoints > 0 && order.some((id) => early.allocate(id) === null));
    const b = snapshotBuild(early, 'mine:1', 'Early');
    const c = god(zeus, 20, true);
    spendAlong(c, b);
    expect(c.unspentPoints).toBe(0);
    expect(c.allocation[keystone(zeus, 1).id]).toBe(keystone(zeus, 1).maxRank);
  });
});

describe('taking a build', () => {
  const tempest = (): Build => readyBuilds(zeus)[1]!;

  it('at the fountain: its skills on the bar, every point refunded and spent along it', () => {
    const c = god(zeus, 10);
    spendAlong(c, readyBuilds(zeus)[0]!);
    const b = { ...tempest(), loadout: [...zeus.defaultLoadout].reverse() };
    expect(applyBuild(c, b)).toBeNull();
    expect(c.loadout[0]).toBe(zeus.defaultLoadout.at(-2));
    expect(pointsInTree(indexTrees(zeus), c.allocation, zeus.trees[0]!.id)).toBe(0);
    expect(c.unspentPoints).toBe(0);
  });

  it('in the field: only new points follow it, and the rest waits for the fountain', () => {
    const book = new BuildBook();
    const c = god(zeus, 6);
    spendAlong(c, readyBuilds(zeus)[0]!);
    const had = { ...c.allocation };
    c.inBase = false;
    expect(book.use(c, 'tree:1')).toBe('field');
    expect(c.allocation).toEqual(had);
    expect(book.waiting(zeus)).toBe(true);
    c.gainXp(XP_TABLE[7]! - c.xp);
    expect(book.follow(c)).toBe('spent');
    expect(pointsInTree(indexTrees(zeus), c.allocation, zeus.trees[1]!.id)).toBe(2);
    // the fountain sets it up in full, once
    c.inBase = true;
    expect(book.follow(c)).toBe('setup');
    expect(pointsInTree(indexTrees(zeus), c.allocation, zeus.trees[0]!.id)).toBe(0);
    expect(book.follow(c)).toBeNull();
  });

  it('spending by hand leaves the points alone', () => {
    const book = new BuildBook();
    const c = god(zeus, 8);
    book.use(c, 'tree:0');
    expect(c.unspentPoints).toBe(0);
    book.use(c, null);
    c.gainXp(XP_TABLE[9]! - c.xp);
    expect(book.follow(c)).toBeNull();
    expect(c.unspentPoints).toBe(2);
  });

  it('follows nothing where the mode wants points by hand, and never sets a dealt bar', () => {
    const rush = new BuildBook({ skills: true, follow: false });
    const c = god(zeus, 8);
    rush.use(c, 'tree:0');
    expect(rush.follow(c)).toBeNull();
    expect(c.unspentPoints).toBe(7);

    const descent = new BuildBook({ skills: false, follow: true });
    const d = god(zeus, 8);
    const bar = [...d.loadout];
    descent.use(d, 'tree:0');
    expect(d.loadout).toEqual(bar);
    expect(d.unspentPoints).toBe(0);
  });
});

describe('the build book', () => {
  it('saves up to the limit, numbers the names, and keeps them for next time', () => {
    const book = new BuildBook();
    const c = god(zeus, 20, true);
    spendAlong(c, readyBuilds(zeus)[0]!);
    const first = book.save(c)!;
    expect(first.name).toBe(`My ${zeus.trees[0]!.name}`);
    expect(book.save(c)!.name).toBe(`My ${zeus.trees[0]!.name} 2`);
    for (let i = 2; i < MAX_SAVED; i++) expect(book.save(c)).not.toBeNull();
    expect(book.save(c)).toBeNull();
    expect(book.canSave(zeus)).toBe(false);

    const later = new BuildBook();
    expect(later.list(zeus).filter((b) => b.id.startsWith('mine:'))).toHaveLength(MAX_SAVED);
    expect(later.active(zeus)?.id).toBe(`mine:${MAX_SAVED}`);
    later.remove(zeus, `mine:${MAX_SAVED}`);
    expect(later.active(zeus)).toBeNull();
    expect(new BuildBook().canSave(zeus)).toBe(true);
    // other gods keep their own
    expect(new BuildBook().list(godById('thor')!).map((b) => b.id)).toEqual(['tree:0', 'tree:1', 'tree:2']);
  });

  it('puts the last bar back at the start of the next match', () => {
    const book = new BuildBook();
    const c = god(zeus);
    const pick = zeus.skills.find((s) => s.kind === 'regular' && !c.loadout.includes(s.id))!;
    c.swap(1, pick.id);
    book.rememberBar(c);
    const next = god(zeus);
    new BuildBook().restoreBar(next);
    expect(next.loadout[1]).toBe(pick.id);
  });

  it('shrugs off a broken or tampered store', () => {
    store.setItem('ascendant.builds', '{not json');
    expect(new BuildBook().list(zeus)).toHaveLength(zeus.trees.length);
    store.setItem(
      'ascendant.builds',
      JSON.stringify({ zeus: { saved: [{ id: 'mine:1', name: '<img src=x onerror=alert(1)>', loadout: [], ranks: {}, trees: [0] }, { id: 7 }], active: 'mine:1', bar: [1, 2] } }),
    );
    const book = new BuildBook();
    const saved = book.list(zeus).filter((b) => b.id.startsWith('mine:'));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).not.toMatch(/[<>]/);
    // a bad bar is ignored; an empty saved loadout falls back to the god's own
    const c = god(zeus, 3);
    book.restoreBar(c);
    expect(c.loadout).toEqual([...zeus.defaultLoadout]);
    book.use(c, 'mine:1');
    expect(c.loadout).toHaveLength(zeus.defaultLoadout.length);
    expect(c.unspentPoints).toBe(0);
  });
});
