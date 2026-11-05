import { hypot } from '../core/math';
import { basicAttackRaw } from '../game/combat';
import type { Side } from '../game/combatant';
import type { Descent } from './Descent';
import type { Sim } from './Sim';
import type { SimEvent, Unit } from './Unit';

/**
 * Underworld relics: rare rewards in a descent that change how a team fights,
 * where a boon only adds a number. A team holds each relic once, and every
 * god of the team carries it. They work on the run's monsters only.
 */
export type RelicId = 'knell' | 'chain' | 'echo' | 'aegis' | 'harvest' | 'spite' | 'lantern';

export interface Relic {
  id: RelicId;
  name: string;
  text: string;
}

/**
 * How each relic works. Tuned with bot-only runs (3 bots, 384 runs): with no
 * relics 8% of runs win; holding one from the first chamber, Lantern alone
 * took that to 44% at twice the revive speed and 80% health, the others to
 * 12-21%. As found (about three a run, see RELIC_CHANCE) these make 14-16%.
 */
export const RELIC = {
  /** Death Knell: a slain monster bursts a beat later for this share of its max health on the monsters around it (so a pack can go up in a chain). */
  knell: { share: 0.12, radius: 4.5, delay: 0.2 },
  /** Chain of Souls: every `every`th basic hit leaps to `leaps` more monsters within `range` m, for `share` of a basic attack each. */
  chain: { every: 3, leaps: 2, range: 7, share: 0.6 },
  /** Echoing Rite: a monster slain by a skill takes `cut` seconds off the killer's skill cooldowns (`big` for a Champion or boss). */
  echo: { cut: 1.5, big: 6 },
  /** Bone Aegis: casting a skill shields the caster for `share` of its max health for `time` s, at most once every `every` s. */
  aegis: { share: 0.06, time: 3, every: 1.5 },
  /** Grave Harvest: each monster the team slays heals its gods within `range` m for `share` of their max health (`big` for a Champion or boss). */
  harvest: { share: 0.03, big: 0.2, range: 14 },
  /** Spite of the Fallen: below `below` of its health a god deals `damage` more and takes `reduction` less. */
  spite: { below: 0.4, damage: 0.25, reduction: 0.15 },
  /** Ferryman's Lantern: the team raises its fallen `speed` times as fast, and they rise with `health` of theirs. */
  lantern: { speed: 1.5, health: 0.6 },
} as const;

const pct = (v: number) => `${Math.round(v * 100)}%`;

export const RELICS: readonly Relic[] = [
  { id: 'knell', name: 'Death Knell', text: 'Slain monsters burst in soul fire, burning the monsters around them' },
  { id: 'chain', name: 'Chain of Souls', text: `Every ${RELIC.chain.every === 3 ? 'third' : `${RELIC.chain.every}th`} basic attack leaps to ${RELIC.chain.leaps} more monsters` },
  { id: 'echo', name: 'Echoing Rite', text: `Slay a monster with a skill and your skills come back ${RELIC.echo.cut} s sooner` },
  { id: 'aegis', name: 'Bone Aegis', text: `Every skill you cast wraps you in a bone shield (${pct(RELIC.aegis.share)} of your health)` },
  { id: 'harvest', name: 'Grave Harvest', text: `Every monster your team slays heals the gods nearby for ${pct(RELIC.harvest.share)} of their health` },
  { id: 'spite', name: 'Spite of the Fallen', text: `Below ${pct(RELIC.spite.below)} health, deal ${pct(RELIC.spite.damage)} more damage and take ${pct(RELIC.spite.reduction)} less` },
  { id: 'lantern', name: "Ferryman's Lantern", text: `Raise the fallen ${pct(RELIC.lantern.speed - 1)} faster, and they rise with ${pct(RELIC.lantern.health)} health` },
];

export const relicById = (id: string): Relic | undefined => RELICS.find((r) => r.id === id);

/**
 * A relic going off, for the view and the HUD: where (a burst, a leap's
 * start, a slain monster), where to (a leap's end), and the god it is about
 * (an index into the run's gods). Kept for a moment so guests see it too.
 */
export interface RelicProc {
  id: number;
  k: RelicId;
  side: Side;
  x: number;
  z: number;
  tx?: number;
  tz?: number;
  god?: number;
  /** Run time it went off. */
  t: number;
}

/** Seconds a proc stays listed (long enough for a guest's next snapshot to carry it). */
const PROC_LIFE = 0.6;

interface Burst {
  at: number;
  x: number;
  z: number;
  raw: number;
  source: Unit;
  side: Side;
}

export class Relics {
  /** Every relic taken, by which team, in order. */
  readonly held: { id: RelicId; side: Side }[] = [];
  readonly procs: RelicProc[] = [];
  private nextProc = 1;
  /** Basic hits each god has landed toward its next leap. */
  private readonly basics = new Map<Unit, number>();
  /** When each god's bone shield can form again. */
  private readonly aegisAt = new Map<Unit, number>();
  /** Whether the last blow each monster took came from a skill. */
  private readonly skillHit = new WeakMap<Unit, boolean>();
  /** Each monster's full health, noted while it lives (a death clears the buffs that scaled it up). */
  private readonly peak = new WeakMap<Unit, number>();
  /** Gods in a rage of spite right now. */
  private readonly spiteful = new Set<Unit>();
  private readonly bursts: Burst[] = [];
  /** Set while a relic's own damage lands, so it never sets off another relic's hit rules. */
  private proc = false;
  /** A guest's copy: the host's relics and procs arrive with its snapshots, and nothing goes off here. */
  remote = false;

  constructor(
    private readonly sim: Sim,
    private readonly run: Descent,
  ) {
    sim.listeners.push((e) => this.on(e));
  }

  has(side: Side, id: RelicId): boolean {
    return this.held.some((h) => h.side === side && h.id === id);
  }

  ofSide(side: Side): RelicId[] {
    return this.held.filter((h) => h.side === side).map((h) => h.id);
  }

  take(id: RelicId, side: Side): void {
    if (!this.has(side, id)) this.held.push({ id, side });
  }

  /** Relics none of these teams holds yet. */
  open(sides: readonly Side[]): Relic[] {
    return RELICS.filter((r) => sides.every((s) => !this.has(s, r.id)));
  }

  /** How many times as fast a team raises its fallen, and the share of health they rise with. */
  reviveSpeed(side: Side): number {
    return this.has(side, 'lantern') ? RELIC.lantern.speed : 1;
  }

  riseHealth(side: Side, base: number): number {
    return this.has(side, 'lantern') ? Math.max(base, RELIC.lantern.health) : base;
  }

  /** Whether a god is in a rage of spite (for the HUD). */
  spiting(g: Unit): boolean {
    return this.spiteful.has(g);
  }

  step(): void {
    const now = this.run.time;
    for (let i = this.procs.length - 1; i >= 0; i--) if (now - this.procs[i]!.t > PROC_LIFE) this.procs.splice(i, 1);
    if (!this.held.length) return;
    for (const m of this.run.monsters) if (m.alive && !this.peak.has(m)) this.peak.set(m, m.combatant.stats.maxHealth);
    this.stepBursts(now);
    this.stepSpite();
  }

  /** Forget a chamber's leftovers (bursts still to go off, half-built chains) as the team moves on. */
  reset(): void {
    this.bursts.length = 0;
    this.basics.clear();
  }

  private on(e: SimEvent): void {
    if (this.remote || !this.held.length) return;
    switch (e.type) {
      case 'damage': {
        if (e.target.kind !== 'monster') return;
        this.skillHit.set(e.target, e.ability && !this.proc);
        const src = e.source;
        if (this.proc || e.ability || !src || !this.isGod(src) || !this.has(this.run.sideOf(src), 'chain')) return;
        const n = (this.basics.get(src) ?? 0) + 1;
        this.basics.set(src, n % RELIC.chain.every);
        if (n >= RELIC.chain.every) this.leap(src, e.target);
        return;
      }
      case 'cast': {
        const g = e.unit;
        if (!this.isGod(g) || !g.alive || !this.has(this.run.sideOf(g), 'aegis')) return;
        if ((this.aegisAt.get(g) ?? -1) > this.sim.time) return;
        this.aegisAt.set(g, this.sim.time + RELIC.aegis.every);
        const c = g.combatant;
        c.addShield(c.stats.maxHealth * RELIC.aegis.share, RELIC.aegis.time);
        this.emit('aegis', this.run.sideOf(g), g.x, g.z, { god: this.run.gods.indexOf(g) });
        return;
      }
      case 'death':
        if (e.unit.kind === 'monster') this.slain(e.unit, e.killer, e.assists);
        return;
      default:
        return;
    }
  }

  private isGod(u: Unit): boolean {
    return u.kind === 'god' && this.run.gods.includes(u);
  }

  /** A Champion or boss: the relics that pay out per kill pay more for these. */
  private big(u: Unit): boolean {
    const role = u.origin?.f === 'mode' ? (u.origin.data as { role?: string } | undefined)?.role : undefined;
    return role === 'boss' || role === 'champion';
  }

  private slain(u: Unit, killer: Unit | null, assists: readonly Unit[]): void {
    const run = this.run;
    const side = run.versus ? run.creditOf(u, killer, assists) : 'order';
    const byGod = killer ? (killer.owner ?? killer) : null;
    const skill = this.skillHit.get(u) ?? false;
    this.skillHit.delete(u);
    if (!side) return;
    const big = this.big(u);
    const god = byGod && this.isGod(byGod) && run.sideOf(byGod) === side ? byGod : (run.teamOf(side).find((g) => g.alive) ?? run.teamOf(side)[0]);
    if (!god) return;
    if (this.has(side, 'knell')) {
      const raw = (this.peak.get(u) ?? u.combatant.stats.maxHealth) * RELIC.knell.share;
      this.bursts.push({ at: run.time + RELIC.knell.delay, x: u.x, z: u.z, raw, source: god, side });
    }
    if (this.has(side, 'harvest')) {
      const share = big ? RELIC.harvest.big : RELIC.harvest.share;
      for (const g of run.teamOf(side)) {
        if (!g.alive || hypot(g.x - u.x, g.z - u.z) > RELIC.harvest.range) continue;
        const healed = this.sim.mend(god, g, g.combatant.stats.maxHealth * share);
        if (healed > 0.5) this.emit('harvest', side, u.x, u.z, { god: run.gods.indexOf(g) });
      }
    }
    if (skill && byGod === god && this.has(side, 'echo')) {
      god.combatant.cutRegularCooldowns(big ? RELIC.echo.big : RELIC.echo.cut);
      this.emit('echo', side, god.x, god.z, { god: run.gods.indexOf(god) });
    }
  }

  /** Chain of Souls: the blow leaps on from its target to the nearest monsters around it. */
  private leap(src: Unit, from: Unit): void {
    const R = RELIC.chain;
    const near = this.run.monsters
      .filter((m) => m !== from && m.alive && m.targetable)
      .map((m) => [m, hypot(m.x - from.x, m.z - from.z) - m.radius] as const)
      .filter(([, d]) => d <= R.range)
      .sort((a, b) => a[1] - b[1])
      .slice(0, R.leaps);
    if (!near.length) return;
    const raw = basicAttackRaw(src.combatant.stats) * R.share;
    const type = src.combatant.god.basicAttack.damageType;
    const side = this.run.sideOf(src);
    this.proc = true;
    for (const [m] of near) {
      this.emit('chain', side, from.x, from.z, { tx: m.x, tz: m.z });
      this.sim.strike(src, m, raw, type);
    }
    this.proc = false;
  }

  private stepBursts(now: number): void {
    if (!this.bursts.length) return;
    const due = this.bursts.filter((b) => b.at <= now);
    if (!due.length) return;
    for (let i = this.bursts.length - 1; i >= 0; i--) if (this.bursts[i]!.at <= now) this.bursts.splice(i, 1);
    for (const b of due) {
      this.emit('knell', b.side, b.x, b.z);
      this.proc = true;
      for (const m of [...this.run.monsters]) {
        if (!m.alive || hypot(m.x - b.x, m.z - b.z) > RELIC.knell.radius + m.radius) continue;
        this.sim.strike(b.source, m, b.raw, 'true');
      }
      this.proc = false;
    }
  }

  /** Spite: a god low on health rages, refreshed every step while it stays low. */
  private stepSpite(): void {
    const S = RELIC.spite;
    for (const g of this.run.gods) {
      const c = g.combatant;
      const low = g.alive && this.has(this.run.sideOf(g), 'spite') && c.health < c.stats.maxHealth * S.below;
      if (!low) {
        this.spiteful.delete(g);
        continue;
      }
      c.refreshTimedMod('damageBonus', S.damage, 0.25);
      c.refreshTimedMod('damageReduction', S.reduction, 0.25);
      if (!this.spiteful.has(g)) {
        this.spiteful.add(g);
        this.emit('spite', this.run.sideOf(g), g.x, g.z, { god: this.run.gods.indexOf(g) });
      }
    }
  }

  private emit(k: RelicId, side: Side, x: number, z: number, extra: Partial<RelicProc> = {}): void {
    this.procs.push({ id: this.nextProc++, k, side, x, z, t: this.run.time, ...extra });
  }

  // -------------------------------------------------------------------------
  // Networking: the host's relics and recent procs, for guests

  netState(code: (s: Side) => string): RelicNet {
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return {
      h: this.held.map((h) => h.id + code(h.side)),
      p: this.procs.map((p) => [p.id, p.k + code(p.side), r2(p.x), r2(p.z), p.tx === undefined ? null : r2(p.tx), p.tz === undefined ? null : r2(p.tz), p.god ?? -1]),
      sp: [...this.spiteful].map((g) => this.run.gods.indexOf(g)),
    };
  }

  applyNet(s: RelicNet, side: (c: string) => Side): void {
    this.held.length = 0;
    for (const h of s.h) {
      const id = h.slice(0, -1) as RelicId;
      if (relicById(id)) this.held.push({ id, side: side(h.slice(-1)) });
    }
    this.procs.length = 0;
    for (const [id, ks, x, z, tx, tz, god] of s.p) {
      const k = ks.slice(0, -1) as RelicId;
      this.procs.push({ id, k, side: side(ks.slice(-1)), x, z, t: this.run.time, ...(tx === null ? {} : { tx }), ...(tz === null ? {} : { tz }), ...(god >= 0 ? { god } : {}) });
    }
    this.spiteful.clear();
    for (const i of s.sp) {
      const g = this.run.gods[i];
      if (g) this.spiteful.add(g);
    }
  }
}

export interface RelicNet {
  /** Relics held: id + team code ('knello'). */
  h: string[];
  /** Recent procs: [id, kind + team code, x, z, tx, tz, god index or -1]. */
  p: [number, string, number, number, number | null, number | null, number][];
  /** Gods raging in spite. */
  sp: number[];
}
