import { pad } from '../core/Gamepad';
import type { Combatant } from '../game/combatant';
import { SLOT_COUNT, SLOT_KEYS } from '../game/loadout';
import { keyLabel, type Action } from '../settings/bindings';
import { padLabel } from '../settings/padBindings';
import { codesFor, padCodeFor } from '../settings/store';
import { FUMBLE_CC } from '../sim/Rush';
import { MARK_MAX } from '../sim/Sim';
import type { Unit } from '../sim/Unit';

/** The key or controller button bound to an action now ('Left click', 'F', 'RT'), '' when it has none. */
export function keyFor(a: Action): string {
  if (pad.active) return padLabel(padCodeFor(a), pad.family);
  const [first, second] = codesFor(a);
  return keyLabel(first ?? second ?? null);
}

/** How a prompt says to use a key: 'left click', 'press F' ('' with none bound). */
export function pressing(label: string): string {
  if (!label) return '';
  return /click$/i.test(label) ? label.toLowerCase() : `press ${label}`;
}

/** A prompt's opening words, capitalized: 'Left click', 'Press RT'. */
export const Pressing = (label: string): string => {
  const p = pressing(label);
  return p.charAt(0).toUpperCase() + p.slice(1);
};

/** The slots on a bar whose skills knock the relic loose, regular skills first. */
export function tackleSlots(c: Combatant): number[] {
  const slots: number[] = [];
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    if (c.skillRankInSlot(slot) > 0 && c.resolve(slot).hits.some((e) => e.kind === 'cc' && FUMBLE_CC.has(e.cc))) slots.push(slot);
  }
  return slots;
}

/** A mark's name as the skill text writes it ("charge" reads Charge). */
const markName = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

/**
 * What to do about an enemy carrier: the tackle to use now, the mark to build
 * first when the tackle only stuns at full stacks (Static Discharge, Final
 * Rest), how long until one is back, or (with none on the bar) to get in their way.
 */
export function tackleHint(c: Combatant, carrier: Unit, slots: readonly number[]): string {
  if (!slots.length) return 'get in their way (none of your skills can knock it loose)';
  let soonest = -1;
  let mana = -1;
  let build = -1;
  for (const slot of slots) {
    const why = c.canCast(slot);
    const mark = c.skillInSlot(slot)!.detonates;
    // a detonating tackle only knocks it loose at full stacks: below that it spends the mark for damage
    const short = mark ? (carrier.marks.get(mark)?.stacks ?? 0) < MARK_MAX : false;
    if (why === null && !short) return `knock it loose with ${c.skillInSlot(slot)!.name} (${SLOT_KEYS[slot]})`;
    if (why === null && build < 0) build = slot;
    if (why === 'mana' && mana < 0) mana = slot;
    const cd = c.cooldownOf(slot);
    if (cd > 0 && (soonest < 0 || cd < c.cooldownOf(soonest))) soonest = slot;
  }
  if (build >= 0) {
    const skill = c.skillInSlot(build)!;
    const mark = skill.detonates!;
    return `build ${markName(mark)} on them (${carrier.marks.get(mark)?.stacks ?? 0} of ${MARK_MAX}), then ${skill.name} (${SLOT_KEYS[build]})`;
  }
  if (soonest >= 0) return `stay on them, ${c.skillInSlot(soonest)!.name} is back in ${Math.ceil(c.cooldownOf(soonest))}`;
  return mana >= 0 ? `stay on them (not enough mana for ${c.skillInSlot(mana)!.name})` : 'stay on them';
}
