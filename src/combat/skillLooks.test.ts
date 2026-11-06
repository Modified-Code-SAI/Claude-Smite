import { describe, expect, it } from 'vitest';
import { GODS } from '../game/gods';
import { SKILL_LOOKS } from './skillLooks';

/** The gods whose every skill must have its own look (gods added later get theirs in a later round). */
const COVERED = ['zeus', 'thor', 'odin', 'loki', 'anubis', 'thanatos'];

describe('skill looks', () => {
  it('gives every skill of the covered gods its own look', () => {
    const missing = GODS.filter((g) => COVERED.includes(g.id))
      .flatMap((g) => g.skills.map((s) => s.id))
      .filter((id) => !SKILL_LOOKS[id]);
    expect(missing).toEqual([]);
  });

  it('only describes skills that exist', () => {
    const ids = new Set(GODS.flatMap((g) => g.skills.map((s) => s.id)));
    expect(Object.keys(SKILL_LOOKS).filter((id) => !ids.has(id))).toEqual([]);
  });
});
