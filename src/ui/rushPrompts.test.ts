import { describe, expect, it } from 'vitest';
import { Combatant } from '../game/combatant';
import { odin, thanatos, thor, zeus } from '../game/gods';
import type { GodDef } from '../game/types';
import { XP_TABLE } from '../game/progression';
import { godUnit } from '../sim/factory';
import { RUSH, rushBar } from '../sim/Rush';
import { rebind } from '../settings/bindings';
import { resetForTest, setSettings, settings } from '../settings/store';
import { keyFor, pressing, Pressing, tackleHint, tackleSlots } from './rushPrompts';

function player(def: GodDef, bar: readonly string[]): Combatant {
  const c = new Combatant(def, 'order', bar);
  c.gainXp(XP_TABLE[RUSH.startLevel - 1]!);
  return c;
}

const carrier = () => godUnit(thor, 'chaos', RUSH.homes.chaos[0]!);

describe('the Relic Rush tackle hint', () => {
  it('names the tackle to use on the carrier, and its key', () => {
    const c = player(thanatos, ['thanatos.pitiless-edge', 'thanatos.claim', 'thanatos.wingbeat', 'thanatos.kiss-of-death']);
    const slots = tackleSlots(c);
    // Claim's pull, and the ultimate's stun
    expect(slots).toEqual([1, 3]);
    expect(tackleHint(c, carrier(), slots)).toBe('knock it loose with Claim (2)');
    c.setCooldown('thanatos.kiss-of-death', 60);
    c.setCooldown('thanatos.claim', 3.2);
    expect(tackleHint(c, carrier(), slots)).toBe('stay on them, Claim is back in 4');
  });

  it('asks for full stacks first when the tackle only stuns at full stacks', () => {
    const c = player(zeus, rushBar(zeus));
    const slots = tackleSlots(c);
    expect(slots).toEqual([1]);
    const h = carrier();
    // Static Discharge below 3 Charge only spends them for damage: the relic stays put
    expect(tackleHint(c, h, slots)).toBe('build Charge on them (0 of 3), then Static Discharge (2)');
    h.marks.set('charge', { stacks: 2, remaining: 5 });
    expect(tackleHint(c, h, slots)).toBe('build Charge on them (2 of 3), then Static Discharge (2)');
    h.marks.set('charge', { stacks: 3, remaining: 5 });
    expect(tackleHint(c, h, slots)).toBe('knock it loose with Static Discharge (2)');
    c.setCooldown('zeus.static-discharge', 6);
    expect(tackleHint(c, h, slots)).toBe('stay on them, Static Discharge is back in 6');
  });

  it('offers a ready tackle ahead of building a mark for another', () => {
    const c = player(thanatos, ['thanatos.final-rest', 'thanatos.claim', 'thanatos.wingbeat', 'thanatos.kiss-of-death']);
    const slots = tackleSlots(c);
    expect(slots).toEqual([0, 1, 3]);
    c.setCooldown('thanatos.kiss-of-death', 60);
    const h = carrier();
    h.marks.set('drowse', { stacks: 1, remaining: 5 });
    expect(tackleHint(c, h, slots)).toBe('knock it loose with Claim (2)');
    c.setCooldown('thanatos.claim', 8);
    expect(tackleHint(c, h, slots)).toBe('build Drowse on them (1 of 3), then Final Rest (1)');
  });

  it('says to get in the way with no tackle on the bar', () => {
    const c = player(odin, odin.defaultLoadout);
    expect(tackleSlots(c)).toEqual([]);
    expect(tackleHint(c, carrier(), [])).toBe('get in their way (none of your skills can knock it loose)');
  });
});

describe('Relic Rush prompts name the keys the player has bound', () => {
  it('reads a click as a click and a key as a press', () => {
    expect(pressing('Left click')).toBe('left click');
    expect(Pressing('Left click')).toBe('Left click');
    expect(pressing('F')).toBe('press F');
    expect(Pressing('RT')).toBe('Press RT');
    expect(pressing('')).toBe('');
  });

  it('follows a rebind', () => {
    resetForTest();
    expect(keyFor('callPass')).toBe('F');
    expect(keyFor('attack')).toBe('Left click');
    expect(keyFor('jump')).toBe('Space');
    let b = rebind(settings().bindings, 'callPass', 0, 'KeyQ').bindings;
    b = rebind(b, 'jump', 1, 'KeyV').bindings;
    setSettings({ bindings: rebind(b, 'jump', 0, null).bindings });
    expect(keyFor('callPass')).toBe('Q');
    expect(keyFor('jump')).toBe('V');
    resetForTest();
  });
});
