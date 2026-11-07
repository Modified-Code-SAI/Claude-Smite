import { pad } from '../core/Gamepad';
import type { Combatant } from '../game/combatant';
import { SLOT_COUNT, SLOT_KEYS } from '../game/loadout';
import { keyLabel, type Action } from '../settings/bindings';
import { padLabel } from '../settings/padBindings';
import { codesFor, padCodeFor } from '../settings/store';
import { Arena } from '../scene/ArenaLayout';
import { FUMBLE_CC, RUSH } from '../sim/Rush';
import { MARK_MAX } from '../sim/Sim';
import type { Point, Unit } from '../sim/Unit';

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

/** What a carrier's keys do, as bound: 'Left click passes it, Space jukes' ('' with neither bound). */
export function carryKeys(): string {
  const pass = keyFor('attack');
  const juke = keyFor('jump');
  return [pass && `${pass} passes it`, juke && `${juke} jukes`].filter(Boolean).join(', ');
}

/** The match's opening line, with the keys as bound (a controller's buttons while one is in use). */
export function rushIntro(): string {
  const keys = carryKeys();
  const call = keyFor('callPass');
  return `Carry the Sun Relic through their gate. ${keys ? `${keys}; stun` : 'Stun'} the carrier to knock it loose.${call ? ` ${call} calls for the pass.` : ''}`;
}

/** The warning when the carrier presses a skill. */
export function carryNoSkills(): string {
  const keys = carryKeys();
  return `Carrying the relic: no skills.${keys ? ` ${keys}.` : ''}`;
}

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

/** What a throw would hit at `p` on the temple plaza, for the carrier's line: 'the pillar', 'a column', 'a brazier', 'the pedestal'. */
export function stoneName(p: Point): string {
  const r = Math.hypot(p.x, p.z);
  if (r < 2) return 'the pedestal';
  const gate = RUSH.gates.order.z;
  if (Math.abs(Math.abs(p.z) - gate) < 1.8 && Math.abs(Math.abs(p.x) - 5.4) < 1.8) return 'the gate pillar';
  if (Math.abs(r - 9.5) < 1.4) return 'a brazier';
  if (Math.abs(r - Arena.plaza.columnRing) < 1.6 || (r < Arena.plaza.baseRadius + 1 && r > Arena.plaza.columnRing)) return 'a column';
  return 'the stones';
}
