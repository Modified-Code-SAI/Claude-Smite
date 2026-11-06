import type { SkillDef } from '../game/types';
import type { Unit } from '../sim/Unit';
import { hitIcon, skillIcon, type HitKind } from './icons';

/** Seconds of hits before a death that the recap counts. */
export const RECAP_WINDOW = 12;
/** Rows the recap shows at most: what hurt the player most. */
export const RECAP_ROWS = 4;
/** Hits the log keeps; a death rarely follows more than a few dozen. */
const RING = 64;

interface Taken {
  at: number;
  /** The unit that dealt it (a summon, a god) and who it counts for (a summon's owner). */
  src: Unit | null;
  credit: Unit | null;
  skill: string;
  ability: boolean;
  amount: number;
}

export interface RecapRow {
  /** Who it counts for, or null for the ground itself (the first of them, for monsters of one kind). */
  from: Unit | null;
  /** Which hitter: a god by itself, monsters by their kind (three Thornbacks are one row). */
  hitter: string;
  /** What dealt it: the skill's name, "Basic attack", the passive's name, or a monster's own name. */
  label: string;
  /** Who, beside the label ('' when the label already says, as a monster's does). */
  who: string;
  /** The skill, for its icon; otherwise what kind of hit it was. */
  skill: SkillDef | null;
  kind: HitKind | null;
  amount: number;
  hits: number;
  /** It landed the killing blow. */
  killing: boolean;
}

export interface Recap {
  rows: RecapRow[];
  total: number;
  hits: number;
  /** Seconds from the first counted hit to the last. */
  span: number;
}

/** How a mode names a unit in the recap (the Jötunn and who plays it), or null for its own name. */
export type RecapName = ((u: Unit) => string | null) | null;

/**
 * The hits the player took lately, for the death screen's recap: what
 * killed them and what hurt most. A fixed ring, so a hit costs no garbage.
 */
export class DamageLog {
  private readonly ring: Taken[] = Array.from({ length: RING }, () => ({ at: -Infinity, src: null, credit: null, skill: '', ability: false, amount: 0 }));
  private next = 0;
  /** Seconds, advanced by the HUD's frames. */
  time = 0;

  record(src: Unit | null, skill: string | undefined, ability: boolean, amount: number): void {
    const t = this.ring[this.next]!;
    this.next = (this.next + 1) % RING;
    t.at = this.time;
    t.src = src;
    t.credit = src ? (src.owner ?? src) : null;
    t.skill = skill ?? '';
    t.ability = ability;
    t.amount = amount;
  }

  clear(): void {
    for (const t of this.ring) {
      t.at = -Infinity;
      t.src = t.credit = null;
    }
  }

  /** What hurt the player over the last RECAP_WINDOW seconds, hardest first; the killing blow's row always makes the cut. */
  recap(nameOf: RecapName = null, limit = RECAP_ROWS): Recap {
    const since = this.time - RECAP_WINDOW;
    const rows = new Map<string, RecapRow>();
    let total = 0;
    let hits = 0;
    let first = Infinity;
    let last = -Infinity;
    let killing: RecapRow | null = null;
    // oldest first, so the last hit seen is the killing blow
    for (let i = 0; i < RING; i++) {
      const t = this.ring[(this.next + i) % RING]!;
      if (t.at < since) continue;
      const hitter = hitterOf(t.credit);
      const key = `${hitter}:${t.skill || (t.ability ? 'passive' : 'basic')}`;
      let r = rows.get(key);
      if (!r) rows.set(key, (r = describe(t, hitter, nameOf)));
      r.amount += t.amount;
      r.hits++;
      total += t.amount;
      hits++;
      first = Math.min(first, t.at);
      last = t.at;
      killing = r;
    }
    if (killing) killing.killing = true;
    const sorted = [...rows.values()].sort((a, b) => b.amount - a.amount);
    const shown = sorted.slice(0, limit);
    if (killing && !shown.includes(killing)) shown[shown.length - 1] = killing;
    // one hitter (the Jötunn, a duel's rival): the line under "Slain" names them, so the rows need not
    if (shown.every((x) => x.hitter === shown[0]!.hitter)) for (const x of shown) x.who = '';
    return { rows: shown, total, hits, span: hits ? last - first : 0 };
  }
}

function hitterOf(u: Unit | null): string {
  return !u ? '' : u.kind === 'god' ? `#${u.id}` : u.name;
}

function describe(t: Taken, hitter: string, nameOf: RecapName): RecapRow {
  const u = t.credit;
  const row: RecapRow = { from: u, hitter, label: 'Hazards', who: '', skill: null, kind: 'hazard', amount: 0, hits: 0, killing: false };
  if (!u) return row;
  const skill = t.skill ? (findSkill(t.src, t.skill) ?? findSkill(u, t.skill)) : null;
  const who = nameOf?.(u) ?? u.name;
  const god = u.combatant.god;
  row.skill = skill;
  row.kind = null;
  if (skill) {
    row.label = skill.name;
    row.who = who;
  } else if (u.kind !== 'god') {
    row.label = who;
    row.kind = 'monster';
  } else if (t.ability) {
    row.label = god.passive.name;
    row.who = who;
    row.kind = 'passive';
  } else {
    row.label = god.id === 'jotunn' ? 'Club swing' : 'Basic attack';
    row.who = who;
    row.kind = god.attackRange;
  }
  return row;
}

function findSkill(u: Unit | null, id: string): SkillDef | null {
  return u?.combatant.god.skills.find((s) => s.id === id) ?? null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const amount = (n: number) => Math.round(n).toLocaleString('en-US');

function iconOf(r: RecapRow): string {
  const god = r.from?.combatant.god.id ?? '';
  return r.skill ? skillIcon(god, r.skill) : hitIcon(god, r.kind ?? 'hazard');
}

/** Who killed the player, for the line under "Slain". */
export function killerHtml(killer: Unit | null, nameOf: RecapName): string {
  const k = killer ? (killer.owner ?? killer) : null;
  return k ? `by <b>${esc(nameOf?.(k) ?? k.name)}</b>` : '';
}

/** The recap panel: each source's icon, name and share of the damage, the killing blow marked. */
export function recapHtml(r: Recap): string {
  if (!r.rows.length) return '';
  const top = Math.max(...r.rows.map((x) => x.amount));
  const when = r.hits === 1 ? 'in one blow' : `in ${Math.max(1, Math.round(r.span))} s`;
  const rows = r.rows
    .map((x, i) => {
      const width = ((x.amount / top) * 100).toFixed(1);
      const who = x.who ? `<small>${esc(x.who)}</small>` : '';
      const tag = x.killing ? '<em>Killing blow</em>' : '';
      const times = x.hits > 1 ? `<small>&times;${x.hits}</small>` : '';
      return `<div class="ch-recap-row${x.killing ? ' kill' : ''}" style="--i:${i}"><span class="ch-recap-icon">${iconOf(x)}</span><span class="ch-recap-name"><b>${esc(x.label)}</b>${tag}${who}</span><span class="ch-recap-amt">${amount(x.amount)}${times}</span><span class="ch-recap-bar"><i style="width:${width}%"></i></span></div>`;
    })
    .join('');
  return `<div class="ch-recap-head"><span>Damage taken</span><span>${amount(r.total)} ${when}</span></div>${rows}`;
}
