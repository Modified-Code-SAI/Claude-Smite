import { describe, expect, it } from 'vitest';
import { GODS } from '../game/gods';
import { BASIC_LOOKS, SKILL_LOOKS, lookFor } from './skillLooks';

/** The gods whose every skill must have its own look (gods added later get theirs in a later round). */
const COVERED = ['zeus', 'thor', 'odin', 'loki', 'anubis', 'thanatos', 'kukulkan', 'cthulhu'];

describe('skill looks', () => {
  it('gives every skill of the covered gods its own look', () => {
    const missing = GODS.filter((g) => COVERED.includes(g.id))
      .flatMap((g) => g.skills.map((s) => s.id))
      .filter((id) => !SKILL_LOOKS[id]);
    expect(missing).toEqual([]);
  });

  it('gives every covered god its own basic attack', () => {
    expect(COVERED.filter((g) => !BASIC_LOOKS[g])).toEqual([]);
    // a ranged god's shot is dressed; a melee god's swing is drawn as it lands
    for (const g of GODS.filter((d) => COVERED.includes(d.id))) {
      const look = BASIC_LOOKS[g.id]!;
      if (g.basicAttack.projectileSpeed === undefined) expect(look.attack, g.id).toBeDefined();
      else expect(look.shot ?? look.attack, g.id).toBeDefined();
    }
  });

  it('plays the passives the sim flashes', () => {
    for (const id of ['thor:passive', 'kukulkan:passive']) expect(lookFor(id)?.flash, id).toBeDefined();
  });

  it('only describes skills that exist', () => {
    const ids = new Set(GODS.flatMap((g) => g.skills.map((s) => s.id)));
    expect(Object.keys(SKILL_LOOKS).filter((id) => !ids.has(id))).toEqual([]);
  });
});
