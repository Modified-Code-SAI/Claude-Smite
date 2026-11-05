import type { Combatant, Team } from '../game/combatant';
import { ULTIMATE_SLOT } from '../game/loadout';
import { isStructure, type Unit, type UnitKind } from './Unit';

/**
 * Quick calls a player sends their team: a mark on the ground or on a unit,
 * with a few words. Only the pinger's own team ever sees them.
 */
export type PingKind = 'look' | 'attack' | 'omw' | 'group' | 'ult' | 'back' | 'missing' | 'help' | 'thanks';

export interface PingDef {
  /** The words for it on their own. */
  label: string;
  /** The words on the wheel. */
  short: string;
  /** Marked where the pinger aims, or on the pinger themselves. */
  at: 'aim' | 'self';
  /** Seconds the marker stays up. */
  life: number;
  color: number;
  /** Which sound it makes (src/audio/sounds.ts `ping.*`). */
  sound: 'look' | 'attack' | 'warn' | 'call';
}

export const PINGS: Record<PingKind, PingDef> = {
  look: { label: 'Look here', short: 'Look', at: 'aim', life: 4, color: 0x8fb4cf, sound: 'look' },
  attack: { label: 'Attack', short: 'Attack', at: 'aim', life: 5, color: 0xff3b30, sound: 'attack' },
  omw: { label: 'On my way', short: 'On my way', at: 'aim', life: 5, color: 0x4aa8ff, sound: 'call' },
  group: { label: 'Group up', short: 'Group', at: 'aim', life: 6, color: 0x37e3d0, sound: 'call' },
  ult: { label: 'Ultimate', short: 'Ultimate', at: 'self', life: 4, color: 0xb07cff, sound: 'call' },
  back: { label: 'Fall back', short: 'Fall back', at: 'aim', life: 5, color: 0xff7a1a, sound: 'warn' },
  missing: { label: 'Enemy missing', short: 'Missing', at: 'aim', life: 6, color: 0xff4fd8, sound: 'warn' },
  help: { label: 'Need help', short: 'Help', at: 'self', life: 5, color: 0xffc22e, sound: 'warn' },
  thanks: { label: 'Thanks!', short: 'Thanks', at: 'self', life: 3, color: 0x7be07b, sound: 'call' },
};

export const isPingKind = (k: unknown): k is PingKind => typeof k === 'string' && Object.hasOwn(PINGS, k);

/** The wheel's calls, clockwise from the top: attack faces fall back, on my way faces enemy missing. */
export const WHEEL: readonly PingKind[] = ['attack', 'omw', 'group', 'ult', 'back', 'missing', 'help', 'thanks'];

/** The wheel's wedge for a mouse offset (screen pixels, y down), clockwise from the top. */
export function sectorOf(dx: number, dy: number): number {
  const n = WHEEL.length;
  const a = Math.atan2(dx, -dy);
  return ((Math.round(a / ((Math.PI * 2) / n)) % n) + n) % n;
}

/** Pings a god can send in a burst, and how fast the allowance comes back. */
export const PING_BURST = 4;
export const PING_REFILL = 1.25;

/** Each god's allowance of pings: a short burst is fine, a stream is muted. */
export class PingLimiter {
  private readonly left = new Map<Unit, { tokens: number; at: number }>();

  /** Whether `u` may ping at `time`, using up one if so. */
  take(u: Unit, time: number): boolean {
    const s = this.left.get(u) ?? { tokens: PING_BURST, at: time };
    s.tokens = Math.min(PING_BURST, s.tokens + (time - s.at) / PING_REFILL);
    s.at = time;
    this.left.set(u, s);
    if (s.tokens < 1) return false;
    s.tokens -= 1;
    return true;
  }
}

/** What an ultimate ping says: seconds left on the cooldown, 0 when ready, LOCKED before level 5, NO_MANA when short. */
export const ULT_LOCKED = -1;
export const ULT_NO_MANA = -2;

/** What an ultimate ping says about a god's ultimate right now. */
export function ultState(c: Combatant): number {
  const err = c.canCast(ULTIMATE_SLOT);
  const cd = c.cooldownOf(ULTIMATE_SLOT);
  const locked = err === 'locked' || err === 'emptySlot' || (err === 'dead' && c.skillRankInSlot(ULTIMATE_SLOT) === 0);
  return locked ? ULT_LOCKED : cd > 0 ? cd : err === 'mana' ? ULT_NO_MANA : 0;
}

/** The part of a unit a ping's words need. */
export interface PingSubject {
  name: string;
  kind: UnitKind;
  team: Team;
}

/** How a ping names the unit it is about: gods by name, the rest with "our" / "their" / "the". */
export function subjectName(s: PingSubject, team: Team): string {
  if (s.kind === 'god') return s.name;
  const name = s.kind === 'tower' ? 'tower' : s.name;
  if (isStructure(s)) return `${s.team === team ? 'our' : 'their'} ${name}`;
  return `the ${name}`;
}

/** The words a ping shows: "Attack Thor", "Group at the Treasure Wyrm", "Ultimate in 32 s". */
export function pingText(kind: PingKind, subject: PingSubject | null, team: Team, ult?: number): string {
  const who = subject ? subjectName(subject, team) : null;
  const ally = subject !== null && subject.team === team;
  switch (kind) {
    case 'look':
      return who ? (ally ? who : `Enemy: ${who}`) : 'Look here';
    case 'attack':
      if (who && ally && isStructure(subject!)) return `Defend ${who}`;
      return who && !ally ? `Attack ${who}` : 'Attack here';
    case 'omw':
      return who ? `On my way to ${who}` : 'On my way';
    case 'group':
      return who ? `Group at ${who}` : 'Group up';
    case 'ult':
      if (ult === undefined || ult === 0) return 'Ultimate ready';
      if (ult === ULT_LOCKED) return 'Ultimate at level 5';
      if (ult === ULT_NO_MANA) return 'Ultimate: need mana';
      return `Ultimate in ${Math.ceil(ult)} s`;
    case 'back':
      return 'Fall back';
    case 'missing':
      return 'Enemy missing';
    case 'help':
      return who && ally ? `Help ${who}` : 'Need help';
    case 'thanks':
      return 'Thanks!';
  }
}

/** A tap of the ping key: attack an enemy under the crosshair, help an ally god, or mark the ground. */
export function contextKind(subject: PingSubject | null, team: Team): PingKind {
  if (!subject) return 'look';
  if (subject.team !== team) return 'attack';
  return subject.kind === 'god' ? 'help' : isStructure(subject) ? 'attack' : 'look';
}
