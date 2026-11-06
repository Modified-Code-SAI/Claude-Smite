import { hypot } from '../core/math';
import type { Side } from '../game/combatant';
import { SLOT_COUNT, ULTIMATE_SLOT } from '../game/loadout';
import { FAVOR_THRESHOLDS, favorPoints, XP_TABLE } from '../game/progression';
import type { GodDef, SkillDef, StatKey } from '../game/types';
import type { CampKind } from '../map/ConquestLayout';
import { BOSS_CHAMBER, CHAMBERS, entranceSpot, exitSpot, obstaclesOf, steer, type ChamberDef, type Palette } from '../map/UnderworldLayout';
import { monsterName, monsterUnit, type MonsterType } from './factory';
import { MonsterBrain, type BossSpecial, type CampState } from './Jungle';
import { Relics, relicById, type Relic, type RelicNet } from './Relics';
import { BOONS, CHAMPION, CURSES, type Boon, type Curse } from './Siege';
import type { Sim } from './Sim';
import type { Brain, SimEvent, Unit } from './Unit';

/**
 * Underworld Descent: a co-op run down through fifteen chambers of the
 * underworld. Each chamber is a short fight (a monster pack, a trap room, an
 * elite, a Champion, a treasure chase) and every fifth holds a boss. Clear one
 * and the team votes on a reward: a boon for everyone, a new skill (each god
 * drafts one of three), tree points, or healing. The gods start with one skill
 * and unseal the rest through the run. Curses stack the deeper the team goes.
 * A fallen god lies downed until an ally stands over them long enough to
 * revive them; when every god is down at once, the run ends.
 *
 * A shared descent (team versus) sends two teams down the same chambers. The
 * monsters hunt everyone, gods can down their rivals, and every kill pays
 * souls to the team that made it: the most souls at the bottom wins. A downed
 * god rises at the gate on its own after a while, so nobody waits out a
 * chamber, and a smaller team fights harder and scores more for each god it
 * is short.
 */
export const DESCENT = {
  chambers: 15,
  bossEvery: 5,
  startLevel: 2,
  /** Seconds the chamber's name shows before its monsters rise. */
  enterTime: 2.4,
  /** Seconds the screen is black while the team goes down. */
  fadeTime: 0.9,
  revive: { range: 2.8, time: 3.2, health: 0.4 },
  /** A god still down when the team leaves comes along with this much health. */
  returnHealth: 0.3,
  /** Seconds to vote on a reward, and to draft a skill. */
  voteTime: 20,
  draftTime: 20,
  /** After the reward the exit gate opens; nobody walking in pulls the team down after this long. */
  exitPull: 30,
  exitRadius: 2.8,
  /** The next wave of a chamber rises once this share of the last is left, or after this long. */
  nextWave: { left: 0.3, after: 22 },
  /** Trap rooms: soul fire erupts under the gods. Damage is a share of max health. */
  eruption: { every: 2.8, warn: 1.25, radius: 3.2, damage: 0.15 },
  /** Bosses call adds when they fall below these shares of their health. */
  bossAdds: [0.66, 0.33],
  /**
   * Seconds a boss chamber holds still as its boss rises (the camera turns to
   * it and its name comes up): no monster or bot acts, and no soul fire falls.
   */
  bossIntro: 2.6,
  /**
   * Seconds a boss chamber holds after its boss falls, before the reward (the
   * camera watches it go down): the adds it called crumble with it.
   */
  bossFall: 2.4,
  /** How fast a fallen boss's retinue crumbles outward from it, in meters a second: a wave, not all in one frame. */
  crumble: 24,
  /** Champion's Obol: a whole-team wipe is undone this many times (it can be won as a reward). */
  obols: 0,
  /** A shared descent (team versus). */
  versus: {
    /** Seconds a downed god lies before rising at the gate on its own (an ally raises it sooner). */
    bleed: 12,
    /** Health a god rises with at the gate. */
    bleedHealth: 0.6,
    /** Souls for downing a rival god, and for each god of a team routed (all down at once). */
    god: 3,
    rout: 1,
    /** A Champion pays this many souls on top of its kind. */
    champion: 5,
    /** Gods hit rival gods this hard: skills are tuned for fights between gods, and here the monsters are the main foe. */
    rivalDamage: 0.5,
    /** For each god a team is short of its rival: more damage and less taken (and its souls count per head: see soulRate). */
    underdog: { damage: 0.2, reduction: 0.12 },
  },
} as const;

/** The Shade's blink: how close (edge to edge) a god gets before it goes, how often, and how far from them it reappears. */
export const SHADE_BLINK = { near: 4.5, every: 5.5, first: 1.5, far: 9 } as const;

/** The Ossuary King, lord of the Abyss and the run's last boss. */
export const KING = {
  /** Grave Toll: it drives its blade into the floor and a ring of soul fire bursts out around it. */
  toll: { every: 10, windup: 1.3, radius: 8, scale: 1.4 },
  /** Soul Rain: soul fire falls under every god within `reach` of it, and on `extra` spots near it. */
  rain: { first: 7, every: 12, enraged: 8, extra: 2, reach: 40 },
  /** Below this share of its health it is enraged and the rain comes faster. */
  enrage: 0.3,
} as const;

/**
 * The Gravekeeper's lantern: how often it mends, how far it reaches, how much
 * (a share of the patient's health, capped at a share of its own), who counts
 * as hurt, and how close a god gets before it backs away.
 */
export const KEEPER = { every: 4, first: 2, range: 13, share: 0.08, cap: 0.3, hurt: 0.92, near: 5 } as const;

/** Souls a monster pays the team that slays it in a shared descent. */
export const SOULS: Record<MonsterType, number> = {
  thornback: 1,
  thornSpitter: 1,
  shade: 2,
  gravekeeper: 3,
  thornbackAlpha: 2,
  warden: 4,
  gildedThornback: 5,
  treasureWyrm: 15,
  moltenColossus: 15,
  ossuaryKing: 20,
};

export type ChamberKind = 'pack' | 'trap' | 'elite' | 'champion' | 'treasure' | 'boss';

export interface ChamberPlan {
  /** 1-based chamber number. */
  n: number;
  /** Index in CHAMBERS. */
  layout: number;
  kind: ChamberKind;
}

/** The three depths, five chambers each, lit in their own color. */
export const DEPTHS: readonly { name: string; palette: Palette }[] = [
  { name: 'The Ashen Depths', palette: 'ember' },
  { name: 'The Drowned Halls', palette: 'soul' },
  { name: 'The Abyss', palette: 'spirit' },
];

export const depthOf = (n: number): number => Math.min(DEPTHS.length - 1, Math.floor((Math.max(1, n) - 1) / DESCENT.bossEvery));

export const KIND_NAMES: Record<ChamberKind, string> = {
  pack: 'Monster pack',
  trap: 'Trap room',
  elite: 'Elite guardians',
  champion: 'Champion',
  treasure: 'Treasure hunt',
  boss: 'Boss',
};

/** What each kind of chamber asks of the team, for the chamber card. */
export const KIND_TEXT: Record<ChamberKind, string> = {
  pack: 'Clear the chamber.',
  trap: 'Soul fire erupts beneath you. Keep moving!',
  elite: 'Wardens guard this chamber.',
  champion: 'A Champion leads the dead. Its fall empowers your team.',
  treasure: 'A Gilded Thornback hides here. Catch it for a second reward.',
  boss: 'A great beast rules this chamber.',
};

/**
 * The whole run's chambers, rolled up front: every depth visits four of the
 * five normal chambers in a random order, then the boss arena.
 */
export function planRun(rng: () => number): ChamberPlan[] {
  const out: ChamberPlan[] = [];
  const normal = CHAMBERS.map((_, i) => i).filter((i) => i !== BOSS_CHAMBER);
  let last = -1;
  for (let depth = 0; depth < DESCENT.chambers / DESCENT.bossEvery; depth++) {
    const order = shuffle(normal, rng);
    // never the same hall twice in a row across a depth's edge
    if (order[0] === last) order.push(order.shift()!);
    let treasure = false;
    for (let k = 0; k < DESCENT.bossEvery; k++) {
      const n = depth * DESCENT.bossEvery + k + 1;
      if (k === DESCENT.bossEvery - 1) {
        out.push({ n, layout: BOSS_CHAMBER, kind: 'boss' });
        continue;
      }
      const layout = order[k]!;
      last = layout;
      let kind: ChamberKind = 'pack';
      if (n > 1) {
        const r = rng();
        if (n >= 3 && !treasure && r < 0.14) kind = 'treasure';
        else if (r < 0.36) kind = 'trap';
        else if (r < 0.58) kind = 'elite';
        else if (n >= 3 && r < 0.78) kind = 'champion';
        else kind = 'pack';
        treasure ||= kind === 'treasure';
      }
      out.push({ n, layout, kind });
    }
  }
  return out;
}

function shuffle<T>(list: readonly T[], rng: () => number): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** How hard the underworld pushes back, tuned with bot-only runs (see descent.test.ts). */
export const DESCENT_TUNING = {
  /** Jungle minutes of growth per chamber (the jungle's growth stops at 20). */
  minutes: 1.6,
  /** From this chamber on, health and damage grow this much per chamber on top. */
  scaleFrom: 6,
  scalePer: 0.2,
  /** And in the last depth this much more per chamber past the second boss, squared (the run's climax). */
  lateRamp: 0.06,
  /** The second boss (the Molten Colossus) comes in at this share of its health. */
  secondBoss: 0.8,
  /** Monster damage on top of the growth. */
  power: 0.85,
  /** Monster health on top of the growth. */
  health: 2.5,
  /** Bosses' health on top of `health` (the packs carry the length of a chamber; a boss shouldn't drag). */
  bossHealth: 0.55,
  /** The last boss (the Ossuary King) on top of that. */
  lastBoss: 1.5,
  /** How many monsters a pack brings, as a multiplier. */
  count: 2,
  /** Monster health in a shared descent on top of the rest: each team fights its own half, and the rivals too. */
  versusHealth: 0.65,
  /** XP and favor for kills and for each cleared chamber, as multipliers (the gods' growth). */
  killXp: 0.45,
  clearXp: 0.5,
  favor: 1,
};

/** How grown a chamber's monsters are, in jungle minutes. */
export const chamberMinutes = (n: number): number => (n - 1) * DESCENT_TUNING.minutes;
/**
 * Deeper still, monsters get tougher than the jungle's growth alone: health
 * and damage. A shared descent skips the last depth's climax ramp: nobody's
 * run ends there, so the bottom has to stay winnable while the teams fight
 * each other too.
 */
export const chamberScale = (n: number, climax = true): number => {
  const t = DESCENT_TUNING;
  const late = climax ? Math.max(0, n - 2 * DESCENT.bossEvery) : 0;
  return 1 + Math.max(0, n - t.scaleFrom) * t.scalePer + late * late * t.lateRamp;
};
/** Monster health for a team of this many gods (tuned for three; bots fill a team up to three; a shared descent has up to six). */
export const teamScale = (gods: number): number => 0.4 + 0.2 * Math.max(1, gods);
/** How many monsters come for a team of this many gods. */
export const teamCount = (gods: number): number => [0.5, 0.75, 1, 1.3, 1.45, 1.6][Math.min(6, Math.max(1, gods)) - 1]!;

const isBossType = (t: string): boolean => t === 'treasureWyrm' || t === 'moltenColossus' || t === 'ossuaryKing';

/** The monsters of one chamber, wave by wave. */
export function chamberWaves(plan: ChamberPlan, gods = 3): MonsterType[][] {
  const { n, kind } = plan;
  const many = DESCENT_TUNING.count * teamCount(gods);
  const pack = (k: number): MonsterType[] => {
    const out: MonsterType[] = [];
    const add = (t: MonsterType, count: number) => {
      for (let i = 0; i < Math.round(count * k * many); i++) out.push(t);
    };
    // Shades haunt the halls past the first boss, each in place of a Thornback, and Gravekeepers the Abyss
    // past the second, each in place of two (a healer in a pack is worth more than a body)
    const shades = n > DESCENT.bossEvery ? Math.min(3, 1 + Math.floor((n - DESCENT.bossEvery - 1) / 3)) : 0;
    const keepers = n > 2 * DESCENT.bossEvery ? Math.min(2, 1 + Math.floor((n - 2 * DESCENT.bossEvery - 1) / 2)) : 0;
    add('thornback', Math.min(9, 3 + Math.floor(n * 0.6)) - shades - 2 * keepers);
    add('thornSpitter', n >= 2 ? Math.min(4, Math.floor(n / 2)) : 0);
    add('thornbackAlpha', Math.min(4, Math.floor((n - 1) / 3)));
    add('shade', shades);
    add('gravekeeper', keepers);
    return out;
  };
  // a big pack rises in two or three waves, the heavier monsters last
  const split = (all: MonsterType[]): MonsterType[][] => {
    if (all.length < 5) return [all];
    const waves = all.length >= 10 ? 3 : 2;
    const out: MonsterType[][] = [];
    for (let w = 0, at = 0; w < waves; w++) {
      const next = Math.round((all.length * (w + 1)) / waves);
      out.push(all.slice(at, next));
      at = next;
    }
    return out;
  };
  switch (kind) {
    case 'pack':
      return split(pack(1));
    case 'trap':
      return split(pack(0.6));
    case 'elite': {
      const wardens: MonsterType[] = Array(n >= 8 ? 2 : 1).fill('warden');
      return [[...wardens, ...pack(0.45)], pack(0.3)].filter((w) => w.length);
    }
    case 'champion':
      return [[(n >= 6 ? 'warden' : 'thornbackAlpha') as MonsterType, ...pack(0.5)], pack(0.3)].filter((w) => w.length);
    case 'treasure':
      return split(pack(0.7));
    case 'boss':
      return [[n >= DESCENT.chambers ? 'ossuaryKing' : n % 10 === 5 ? 'treasureWyrm' : 'moltenColossus', ...(n >= 10 ? (['thornSpitter', 'thornSpitter'] as MonsterType[]) : [])]];
  }
}

/** The adds a boss calls as it weakens. */
function bossAdds(n: number): MonsterType[] {
  const out: MonsterType[] = ['thornback', 'thornback', 'thornback', 'thornSpitter'];
  if (n >= 10) out.push('thornbackAlpha', 'thornSpitter');
  // the Ossuary King calls up Shades of its court (never a Gravekeeper: a healer on a boss drags the fight out)
  if (n >= DESCENT.chambers) out.push('shade', 'thornbackAlpha');
  return out;
}

// ---------------------------------------------------------------------------
// Rewards and curses

export type RewardKind = 'boon' | 'skill' | 'points' | 'heal' | 'obol' | 'relic';

export interface Reward {
  kind: RewardKind;
  name: string;
  text: string;
  /** The boon a boon card gives. */
  boon?: Boon;
  /** The relic a relic card gives. */
  relic?: Relic;
}

/** The chance a reward offers a relic, by the kind of chamber just cleared (none after the first): about three a run, one after each boss. */
export const RELIC_CHANCE: Partial<Record<ChamberKind, number>> = { boss: 1, elite: 0.4, champion: 0.4, pack: 0.1, trap: 0.12, treasure: 0.12 };

/** Boons for the underworld: Siege's that make sense away from the plaza. */
export const DESCENT_BOONS: readonly Boon[] = BOONS.filter((b) => !b.cleanse && !b.corruptScale);

export const POINTS_REWARD = 2;

const SKILL_REWARD: Reward = { kind: 'skill', name: 'Forgotten Rite', text: 'Each god learns a new skill: draft one of three' };
const POINTS: Reward = { kind: 'points', name: 'Ancestral Insight', text: `+${POINTS_REWARD} skill tree points for every god` };
const HEAL: Reward = { kind: 'heal', name: 'Waters of Lethe', text: 'Restore all health and mana, and the fallen rise' };
const OBOL: Reward = { kind: 'obol', name: "Charon's Obol", text: 'The next time your whole team falls, everyone rises again' };

/**
 * Curses stack as the team goes deeper: one more at each of these chambers,
 * announced while the team picks its reward in the chamber before.
 */
export const CURSE_AT: readonly number[] = [4, 7, 9, 12, 14];

export interface DescentCurse extends Curse {
  /** Monsters hit this much harder. */
  power?: number;
  /** Reviving a fallen god takes this many times as long. */
  restless?: number;
  /** Soul fire erupts in every chamber, not only trap rooms. */
  ashfall?: boolean;
}

export const DESCENT_CURSES: readonly DescentCurse[] = [
  ...CURSES.filter((c) => !c.respawn),
  { id: 'wrath', name: 'Wrath of the Dead', text: 'Monsters hit 20% harder', power: 0.2 },
  { id: 'restless', name: 'Restless Souls', text: 'Reviving a fallen god takes twice as long', restless: 2 },
  { id: 'ashfall', name: 'Ashfall', text: 'Soul fire erupts in every chamber', ashfall: true },
];

// ---------------------------------------------------------------------------
// Brains

/**
 * A Descent monster hunts the nearest god in its chamber; there is nowhere to
 * leash back to. It reuses the jungle monster's fighting (windups, boss slams)
 * with a camp that stays on its foe, and walks around columns and the pit.
 */
export class DescentMonsterBrain extends MonsterBrain {
  private readonly at: [number, number];
  /** A Shade's next blink, in seconds (never for anything else). */
  private blinkIn: number = SHADE_BLINK.first;
  /** A Gravekeeper's next mend, in seconds. */
  private mendIn: number = KEEPER.first;

  constructor(
    private readonly s: Sim,
    private readonly self: Unit,
    camp: CampState,
    private readonly obstacles: readonly (readonly [number, number, number])[] = [],
    /** The chamber it fights in: where a Shade may blink to. */
    private readonly chamber: ChamberDef | null = null,
    /** While true (a boss's entrance), it only turns to face its foe. */
    private readonly held: () => boolean = () => false,
  ) {
    super(s, self, camp);
    this.at = camp.camp.at as unknown as [number, number];
  }

  override get bossKey(): string | null {
    return this.self.tag.endsWith(':ossuaryKing') ? 'ossuaryKing' : super.bossKey;
  }

  /** The Ossuary King's Grave Toll in place of a jungle boss's slam. */
  protected override get specialSpec(): BossSpecial | null {
    return this.self.tag.endsWith(':ossuaryKing') ? KING.toll : super.specialSpec;
  }

  override update(dt: number): void {
    const u = this.self;
    const camp = this.camp;
    const foe = camp.foe;
    if (!foe || !foe.alive || !foe.targetable || foe.stealth > 0 || hypot(foe.x - u.x, foe.z - u.z) > 18) {
      let best: Unit | null = null;
      let bd = 70;
      for (const t of this.s.enemiesOf(u)) {
        if ((t.kind !== 'god' && t.kind !== 'summon') || t.stealth > 0 || !t.targetable) continue;
        const d = hypot(t.x - u.x, t.z - u.z);
        if (d < bd) [bd, best] = [d, t];
      }
      // a monster whose foe is only far away keeps it rather than flip-flopping
      if (best || !foe?.alive || !foe.targetable) camp.foe = best;
    }
    if (this.held()) {
      u.move = null;
      const f = camp.foe;
      if (f) u.body.yaw = Math.atan2(-(f.x - u.x), -(f.z - u.z));
      return;
    }
    if (u.tag.endsWith(':shade') && (this.blinkIn -= dt) <= 0 && this.blink()) this.blinkIn = SHADE_BLINK.every;
    const keeper = u.tag.endsWith(':gravekeeper');
    if (keeper && (this.mendIn -= dt) <= 0) this.mendIn = this.mend() ? KEEPER.every : 0.4;
    // the camp travels with the fight, so the jungle's leash never pulls it home
    const t = camp.foe;
    this.at[0] = t ? t.x : u.x;
    this.at[1] = t ? t.z : u.z;
    super.update(dt);
    if (t && u.move && this.obstacles.length) {
      const p = steer(this.obstacles, u.x, u.z, t.x, t.z, u.radius);
      if (p.x !== t.x || p.z !== t.z) {
        const dx = p.x - u.x;
        const dz = p.z - u.z;
        const d = Math.max(0.01, hypot(dx, dz));
        u.move = { x: dx / d, z: dz / d };
        u.body.yaw = Math.atan2(-dx, -dz);
      }
    }
    if (keeper) this.keepBack();
  }

  /**
   * The Gravekeeper lifts its lantern and pours souls into the most hurt
   * monster near it (never itself, another Gravekeeper or the Gilded
   * Thornback). Stunned or silenced, it can't.
   */
  private mend(): boolean {
    const u = this.self;
    if (!u.alive || u.combatant.cc.locks().cast) return false;
    let best: Unit | null = null;
    let worst: number = KEEPER.hurt;
    for (const m of this.s.units) {
      if (m === u || m.kind !== 'monster' || !m.alive || m.tag.endsWith(':gravekeeper') || m.tag.endsWith(':gildedThornback')) continue;
      const share = m.combatant.health / m.combatant.stats.maxHealth;
      if (share >= worst || hypot(m.x - u.x, m.z - u.z) > KEEPER.range) continue;
      [worst, best] = [share, m];
    }
    if (!best) return false;
    this.s.mend(u, best, Math.min(best.combatant.stats.maxHealth * KEEPER.share, u.combatant.stats.maxHealth * KEEPER.cap));
    u.sinceAction = 0;
    u.body.yaw = Math.atan2(-(best.x - u.x), -(best.z - u.z));
    return true;
  }

  /** The Gravekeeper backs away from a god who comes close, along a wall when it has its back to one. */
  private keepBack(): void {
    const u = this.self;
    const c = this.chamber;
    if (!c || !this.s.canMove(u)) return;
    let near: Unit | null = null;
    let nd: number = KEEPER.near;
    for (const t of this.s.enemiesOf(u)) {
      if (t.kind !== 'god' || !t.alive || !t.targetable) continue;
      const d = hypot(t.x - u.x, t.z - u.z) - t.radius - u.radius;
      if (d < nd) [nd, near] = [d, t];
    }
    if (!near) return;
    const away = Math.max(0.01, hypot(u.x - near.x, u.z - near.z));
    let dx = (u.x - near.x) / away;
    let dz = (u.z - near.z) / away;
    if (c.sd(u.x + dx * 3 - c.x, u.z + dz * 3 - c.z) < 2.5) {
      // a wall behind it: slip along the wall, the way that leads toward the open middle
      const side = -dz * (c.x - u.x) + dx * (c.z - u.z) >= 0 ? 1 : -1;
      [dx, dz] = [-dz * side, dx * side];
    }
    const p = steer(this.obstacles, u.x, u.z, u.x + dx * 4, u.z + dz * 4, u.radius);
    const mx = p.x - u.x;
    const mz = p.z - u.z;
    const d = Math.max(0.01, hypot(mx, mz));
    u.move = { x: mx / d, z: mz / d };
    u.body.yaw = Math.atan2(-mx, -mz);
  }

  /**
   * A god closed in on the Shade: it vanishes and reappears out of their
   * reach, on the far side from them, still in bolt range. Never into a wall,
   * a column or the pit, and never while stunned or rooted.
   */
  private blink(): boolean {
    const u = this.self;
    const c = this.chamber;
    if (!c || !u.alive || u.windup > 0 || !this.s.canMove(u)) return false;
    let near: Unit | null = null;
    let nd: number = SHADE_BLINK.near;
    for (const t of this.s.enemiesOf(u)) {
      if (t.kind !== 'god' || !t.alive || !t.targetable) continue;
      const d = hypot(t.x - u.x, t.z - u.z) - t.radius - u.radius;
      if (d < nd) [nd, near] = [d, t];
    }
    if (!near) return false;
    const away = Math.atan2(u.x - near.x, u.z - near.z);
    for (let i = 0; i < 10; i++) {
      // straight away from them first, then anywhere around them
      const a = away + (this.s.rng() - 0.5) * (i < 5 ? 1.6 : 5);
      const x = near.x + Math.sin(a) * SHADE_BLINK.far;
      const z = near.z + Math.cos(a) * SHADE_BLINK.far;
      if (c.sd(x - c.x, z - c.z) < 2.5) continue;
      if (this.obstacles.some(([ox, oz, r]) => hypot(x - ox, z - oz) < r + u.radius + 0.6)) continue;
      this.s.teleport(u, x, z, Math.atan2(x - near.x, z - near.z));
      return true;
    }
    return false;
  }
}

/** The Gilded Thornback: never fights, runs from the gods around its chamber until caught or the chamber is cleared. */
export class FleeBrain implements Brain {
  private dir = 1;
  constructor(
    private readonly s: Sim,
    private readonly u: Unit,
    private readonly center: { x: number; z: number },
    private readonly roam: number,
  ) {}

  update(): void {
    const u = this.u;
    u.move = null;
    if (!u.alive) return;
    let nx = 0;
    let nz = 0;
    let near = Infinity;
    for (const t of this.s.enemiesOf(u)) {
      if (t.kind !== 'god' || !t.alive) continue;
      const d = hypot(t.x - u.x, t.z - u.z);
      if (d < near) [near, nx, nz] = [d, t.x, t.z];
    }
    const rx = u.x - this.center.x;
    const rz = u.z - this.center.z;
    const r = Math.max(0.01, hypot(rx, rz));
    let mx = (-rz / r) * this.dir + (rx / r) * (this.roam - r) * 0.15;
    let mz = (rx / r) * this.dir + (rz / r) * (this.roam - r) * 0.15;
    if (near < 12) {
      const ax = (u.x - nx) / Math.max(0.01, near);
      const az = (u.z - nz) / Math.max(0.01, near);
      if (ax * mx + az * mz < -0.3) this.dir = -this.dir;
      mx += ax * 2;
      mz += az * 2;
    }
    const m = hypot(mx, mz);
    if (m < 0.01) return;
    u.move = { x: mx / m, z: mz / m };
    u.body.yaw = Math.atan2(-mx, -mz);
  }
}

// ---------------------------------------------------------------------------
// The run

export type DescentPhase = 'enter' | 'fight' | 'reward' | 'draft' | 'exit' | 'descend' | 'won' | 'lost';

/** A pending eruption of soul fire: lands when `left` reaches 0. */
export interface Eruption {
  id: number;
  x: number;
  z: number;
  r: number;
  left: number;
}

/** A god's personal skill draft: which slot it fills and the three skills on offer. */
export interface Draft {
  slot: number;
  options: SkillDef[];
}

const WARDEN_GLOWS = ['might', 'wisdom', 'swiftness', 'insight'] as const;

export class Descent {
  readonly plan: ChamberPlan[];
  /** 1-based number of the chamber the team is in (0 before the first). */
  chamber = 0;
  phase: DescentPhase = 'enter';
  /** Seconds left in the current phase, where it has a limit. */
  timer: number = DESCENT.enterTime;
  /** Run clock, seconds. */
  time = 0;
  /** The gods on the team, and which of them humans play (they vote; bots follow). */
  readonly gods: Unit[] = [];
  readonly humans = new Set<Unit>();
  /** Monsters of the current chamber still standing, and the waves yet to rise. */
  readonly monsters: Unit[] = [];
  private waves: MonsterType[][] = [];
  wave = 0;
  private waveTimer = 0;
  private waveSize = 0;
  kills = 0;
  readonly boons: Boon[] = [];
  /** Which team took each of `boons` (always Order in co-op). */
  readonly boonTeam: Side[] = [];
  readonly curses: DescentCurse[] = [];
  /** The curse joining the stack at the next chamber, shown during the reward. */
  nextCurse: DescentCurse | null = null;
  /** The three rewards on offer after a chamber, and each human's vote. */
  offer: Reward[] | null = null;
  readonly votes = new Map<Unit, number>();
  /** Rewards still to be offered to each team after this one (the Gilded Thornback's prize). */
  readonly bonus: Record<Side, number> = { order: 0, chaos: 0 };
  /** The teams voting on the offer on the table, and the picks already settled (a team of bots picks at once). */
  offerTeams: Side[] = [];
  readonly picks = new Map<Side, number>();
  /** Each god's open skill draft. */
  readonly drafts = new Map<Unit, Draft>();
  /** Downed gods and how far along their revive is (0..1). */
  readonly downed = new Map<Unit, number>();
  obols: number = DESCENT.obols;
  /** Set once an obol lifts the team (for the herald and HUD). */
  obolUsed = 0;
  readonly eruptions: Eruption[] = [];
  private eruptIn = 0;
  /** Seconds until the Ossuary King's next Soul Rain. */
  private rainIn = 0;
  private nextEruption = 1;
  /** This chamber's Champion while it stands, the Gilded Thornback while it runs, and the boss. */
  champion: Unit | null = null;
  gilded: Unit | null = null;
  gildedFate: 'caught' | 'escaped' | null = null;
  boss: Unit | null = null;
  private bossAddsCalled = 0;
  /** Seconds left of a boss's entrance (see DESCENT.bossIntro). */
  private introLeft = 0;
  /** Seconds left of a boss's fall (see DESCENT.bossFall), and the god its retinue falls to. */
  private fallLeft = 0;
  private fallBy: Unit | null = null;
  /** Seconds left on the Champion's spoils, and the team that took them. */
  spoils = 0;
  spoilsTeam: Side = 'order';
  /** A shared descent's score: souls, monsters slain (the tie-break), routs suffered, and the team that slew this chamber's boss. */
  readonly souls: Record<Side, number> = { order: 0, chaos: 0 };
  readonly teamKills: Record<Side, number> = { order: 0, chaos: 0 };
  readonly routs: Record<Side, number> = { order: 0, chaos: 0 };
  bossBy: Side | null = null;
  /** The team with the most souls once the last chamber falls ('draw' on a dead heat). */
  winner: Side | 'draw' | null = null;
  /** Revives that need extra health after the sim respawns them. */
  private readonly reviving = new Map<Unit, number>();
  /** The relics each team has found, and what they do. */
  readonly relics: Relics;

  constructor(
    private readonly sim: Sim,
    /** The god whose shape monsters borrow (see factory.monsterUnit). */
    private readonly base: GodDef,
    plan?: ChamberPlan[],
    /** A shared descent: Order and Chaos go down together, scored in souls. */
    readonly versus = false,
  ) {
    this.plan = plan ?? planRun(sim.rng);
    sim.listeners.push((e) => this.on(e));
    // after the run's own listener, so a kill is the run's before a relic pays out on it
    this.relics = new Relics(sim, this);
  }

  /** The teams on the run: Order alone in co-op, both in a shared descent. */
  get sides(): Side[] {
    return this.versus ? ['order', 'chaos'] : ['order'];
  }

  /** A god's team on the run (in co-op, everyone is one team). */
  sideOf(g: Unit): Side {
    return this.versus && g.team === 'chaos' ? 'chaos' : 'order';
  }

  teamOf(side: Side): Unit[] {
    return this.gods.filter((g) => this.sideOf(g) === side);
  }

  humansOf(side: Side): Unit[] {
    return [...this.humans].filter((g) => this.sideOf(g) === side);
  }

  /** How many gods a team is short of its rival (0 in co-op). */
  short(side: Side): number {
    if (!this.versus) return 0;
    const mine = this.teamOf(side).length;
    return Math.max(0, this.gods.length - mine - mine);
  }

  /** Seconds left of a boss's entrance, while its chamber holds still (0 the rest of the time). */
  get intro(): number {
    return this.introLeft;
  }

  /** Seconds left of a boss's fall, while the chamber holds before its reward (0 the rest of the time). */
  get fall(): number {
    return this.fallLeft;
  }

  /** How many times this chamber's boss has called up its adds (see DESCENT.bossAdds). */
  get calls(): number {
    return this.bossAddsCalled;
  }

  /** The chamber the team is in (or about to enter). */
  get current(): ChamberPlan {
    return this.plan[Math.max(0, this.chamber - 1)]!;
  }

  get layout(): ChamberDef {
    return CHAMBERS[this.current.layout]!;
  }

  get depth(): number {
    return depthOf(Math.max(1, this.chamber));
  }

  /** Chambers fully cleared. */
  get cleared(): number {
    if (this.phase === 'won') return this.chamber;
    return this.phase === 'enter' || this.phase === 'fight' || this.phase === 'lost' ? this.chamber - 1 : this.chamber;
  }

  get over(): boolean {
    return this.phase === 'won' || this.phase === 'lost';
  }

  /** The sealed skill slots every god starts with: only the first skill and basic attacks to begin. */
  static readonly SEALED: readonly number[] = [1, 2, ULTIMATE_SLOT];

  /** Brings a god into the run: starting level, sealed slots, and its spot at the first gate. */
  addGod(u: Unit, human: boolean): void {
    this.gods.push(u);
    if (human) this.humans.add(u);
    const c = u.combatant;
    c.gainXp(Math.max(0, XP_TABLE[DESCENT.startLevel - 1]! - c.xp));
    for (const s of Descent.SEALED) c.sealed.add(s);
    c.health = c.stats.maxHealth;
    c.mana = c.stats.maxMana;
  }

  /** Puts the team at the first chamber's gate. Call once every god is added. */
  begin(): void {
    this.underdog();
    this.chamber = 1;
    this.phase = 'enter';
    this.timer = DESCENT.enterTime;
    this.placeTeam();
  }

  /** A smaller team fights harder for each god it is short (lasting perks, the same on every end); rival gods hit each other softer. */
  private underdog(): void {
    const u = DESCENT.versus.underdog;
    for (const g of this.gods) {
      if (this.versus) {
        const c = g.combatant;
        const own = c.damageAmp;
        c.damageAmp = (t, ability) => (own ? own(t, ability) : 1) * (this.sim.unitByCombatantUid(t.uid)?.kind === 'god' ? DESCENT.versus.rivalDamage : 1);
      }
      const n = this.short(this.sideOf(g));
      if (!n) continue;
      g.combatant.addPerk('damageBonus', u.damage * n);
      g.combatant.addPerk('damageReduction', u.reduction * n);
    }
  }

  // -------------------------------------------------------------------------
  // Events

  private on(e: SimEvent): void {
    if (e.type === 'respawn') {
      // raised by an ally, or (a shared descent) risen at the gate after lying long enough
      const share = this.reviving.get(e.unit) ?? (this.downed.has(e.unit) ? DESCENT.versus.bleedHealth : undefined);
      if (share === undefined) return;
      this.reviving.delete(e.unit);
      this.downed.delete(e.unit);
      e.unit.downed = false;
      const c = e.unit.combatant;
      c.health = Math.max(1, c.stats.maxHealth * share);
      return;
    }
    if (e.type !== 'death') return;
    const u = e.unit;
    if (u.kind === 'god' && this.gods.includes(u)) {
      this.down(u, this.creditOf(u, e.killer, e.assists));
      return;
    }
    if (u.kind !== 'monster') return;
    const ours = this.monsters.includes(u);
    // in co-op every kill is the team's; in a shared descent the team that made it
    const side = this.versus ? this.creditOf(u, e.killer, e.assists) : 'order';
    if (ours) {
      this.kills++;
      if (side) {
        this.teamKills[side]++;
        const type = u.origin?.f === 'mode' ? (u.origin.data as DescentSpawn | undefined)?.type : undefined;
        if (this.versus) this.score(side, (type ? SOULS[type] : 1) + (u === this.champion ? DESCENT.versus.champion : 0));
      }
    }
    if (u === this.boss) {
      this.bossBy = side;
      this.fallLeft = DESCENT.bossFall;
      const by = e.killer?.owner ?? e.killer;
      this.fallBy = by && this.gods.includes(by) ? by : (this.gods.find((g) => !side || this.sideOf(g) === side) ?? null);
      this.eruptions.length = 0;
    }
    if (u === this.champion) this.claimSpoils(side);
    if (u === this.gilded) {
      this.gilded = null;
      this.gildedFate = 'caught';
      if (side) this.bonus[side]++;
    }
  }

  /** The team a kill counts for: the killer's, or (a monster's last blow, a burn) a rival god who helped. */
  creditOf(victim: Unit, killer: Unit | null, assists: readonly Unit[]): Side | null {
    const team = (k: Unit | null | undefined): Side | null => (k && (k.team === 'order' || k.team === 'chaos') && k.team !== victim.team ? this.sideOf(k) : null);
    return team(killer) ?? team(assists.find((a) => a.kind === 'god')) ?? null;
  }

  /** How much each soul a team earns counts: a smaller team's souls count per head, so two against three earn half as much again. */
  soulRate(side: Side): number {
    const mine = this.teamOf(side).length;
    return this.short(side) && mine ? (this.gods.length - mine) / mine : 1;
  }

  private score(side: Side, n: number): void {
    this.souls[side] += n * this.soulRate(side);
  }

  /** A god falls: it lies downed until an ally raises it (or, in a shared descent, it rises at the gate). */
  private down(u: Unit, rival: Side | null): void {
    u.downed = true;
    this.downed.set(u, 0);
    if (!this.versus) {
      // no respawn timer in the underworld: only an ally (or leaving the chamber) brings a god back
      u.combatant.respawnTimer = 1e9;
      return;
    }
    u.combatant.respawnTimer = DESCENT.versus.bleed;
    const at = this.gateOf(u);
    u.home.x = at.x;
    u.home.z = at.z;
    u.home.yaw = at.yaw;
    if (rival) this.score(rival, DESCENT.versus.god);
    // a whole team down at once is a rout, worth souls to the rivals still standing
    const side = this.sideOf(u);
    const team = this.teamOf(side);
    if (!team.every((g) => this.downed.has(g))) return;
    this.routs[side]++;
    const other: Side = side === 'order' ? 'chaos' : 'order';
    if (this.teamOf(other).some((g) => g.alive)) this.score(other, DESCENT.versus.rout * team.length);
  }

  private claimSpoils(side: Side | null): void {
    this.champion = null;
    if (!side) return;
    this.spoils = CHAMPION.time;
    this.spoilsTeam = side;
    for (const g of this.teamOf(side)) {
      if (!g.alive) continue;
      g.combatant.refreshTimedMod('damageBonus', CHAMPION.damage, CHAMPION.time);
      g.combatant.heal(g.combatant.stats.maxHealth * CHAMPION.heal);
    }
  }

  // -------------------------------------------------------------------------
  // Step

  step(dt: number): void {
    if (this.over || this.chamber === 0) return;
    this.time += dt;
    this.spoils = Math.max(0, this.spoils - dt);
    for (let i = this.monsters.length - 1; i >= 0; i--) if (!this.monsters[i]!.alive) this.monsters.splice(i, 1);
    this.stepRevives(dt);
    if (this.checkWipe()) return;
    if (this.introLeft > 0) this.introLeft = Math.max(0, this.introLeft - dt);
    if (this.fallLeft > 0) this.stepFall(dt);
    if (this.introLeft <= 0 && this.fallLeft <= 0) {
      this.stepEruptions(dt);
      this.stepKing(dt);
    }
    this.relics.step();
    switch (this.phase) {
      case 'enter':
        this.timer -= dt;
        if (this.timer <= 0) this.startFight();
        break;
      case 'fight':
        this.stepFight(dt);
        break;
      case 'reward':
        this.timer -= dt;
        if (this.timer <= 0 || this.allVoted()) this.resolveVote();
        break;
      case 'draft':
        this.timer -= dt;
        for (const [g, d] of this.drafts) if (!this.humans.has(g) || this.timer <= 0) this.draft(g, this.humans.has(g) ? 0 : Math.floor(this.sim.rng() * d.options.length));
        if (this.drafts.size === 0) this.afterReward();
        break;
      case 'exit': {
        this.timer -= dt;
        const door = exitSpot(this.layout);
        const walkers = this.humans.size ? [...this.humans] : this.gods;
        const through = walkers.some((g) => g.alive && hypot(g.x - door.x, g.z - door.z) < DESCENT.exitRadius);
        if (through || this.timer <= 0) {
          this.phase = 'descend';
          this.timer = DESCENT.fadeTime;
        }
        break;
      }
      case 'descend':
        this.timer -= dt;
        if (this.timer <= 0) this.nextChamber();
        break;
      default:
        break;
    }
  }

  private stepFight(dt: number): void {
    if (this.gilded && this.monsters.every((m) => m === this.gilded)) this.escapeGilded();
    this.stepBoss();
    this.waveTimer += dt;
    const left = this.monsters.filter((m) => m !== this.gilded).length;
    if (this.wave < this.waves.length && (left <= this.waveSize * DESCENT.nextWave.left || this.waveTimer >= DESCENT.nextWave.after)) this.spawnWave();
    else if (this.wave >= this.waves.length && this.monsters.length === 0 && this.fallLeft <= 0) this.clearChamber();
  }

  /**
   * A boss gone down: whatever it called up crumbles with it, in a wave
   * spreading out from where it fell (everything left by the end of the
   * hold), credited to the god who felled it.
   */
  private stepFall(dt: number): void {
    this.fallLeft = Math.max(0, this.fallLeft - dt);
    const by = this.fallBy;
    const b = this.boss;
    if (!by || !b) return;
    const reach = this.fallLeft > 0 ? 1.5 + (DESCENT.bossFall - this.fallLeft) * DESCENT.crumble : Infinity;
    for (const m of this.monsters) if (m.alive && m !== this.gilded && hypot(m.x - b.x, m.z - b.z) <= reach) this.sim.slay(by, m);
  }

  /** A boss calls its adds as it weakens. */
  private stepBoss(): void {
    const b = this.boss;
    if (!b || !b.alive) return;
    const share = b.combatant.health / b.combatant.stats.maxHealth;
    const due = DESCENT.bossAdds[this.bossAddsCalled];
    if (due === undefined || share > due) return;
    this.bossAddsCalled++;
    this.spawn(bossAdds(this.chamber), 'adds');
  }

  private startFight(): void {
    this.phase = 'fight';
    this.introLeft = this.current.kind === 'boss' ? DESCENT.bossIntro : 0;
    this.fallLeft = 0;
    this.fallBy = null;
    this.waves = chamberWaves(this.current, this.gods.length);
    this.wave = 0;
    this.champion = null;
    this.boss = null;
    this.bossBy = null;
    this.bossAddsCalled = 0;
    this.gildedFate = null;
    this.eruptIn = 3;
    this.spawnWave();
    if (this.current.kind === 'treasure') this.spawnGilded();
  }

  private spawnWave(): void {
    const roster = this.waves[this.wave++]!;
    this.waveTimer = 0;
    this.waveSize = roster.length;
    this.spawn(roster, `w${this.wave}`);
  }

  /** A wave as it rises: the Swarm curse brings extra Thornbacks ahead of it. */
  private swarmed(roster: MonsterType[]): MonsterType[] {
    const swarm = this.curses.find((k) => k.swarm)?.swarm;
    if (!swarm) return roster;
    const t = roster.filter((r) => r === 'thornback').length;
    return [...Array<MonsterType>(Math.max(0, Math.min(t * (swarm.count - 1), 14 - t))).fill('thornback'), ...roster];
  }

  /** The title and camp of the `i`th monster of a wave, and its tag, which tells the views what to draw. */
  private look(type: MonsterType, i: number, label: string): { title: string; champion: boolean; campKind: CampKind; tag: string } {
    const n = this.chamber;
    const boss = isBossType(type);
    const king = type === 'ossuaryKing';
    // the champion of a Champion chamber is the first monster of its first wave
    const champion = this.current.kind === 'champion' && label === 'w1' && i === 0;
    const title = champion ? 'Champion' : boss && !king && n === DESCENT.chambers ? 'Abyssal' : '';
    // (the King's slam is its own, so it fights from a plain camp: see DescentMonsterBrain.specialSpec)
    const campKind: CampKind = type === 'warden' ? WARDEN_GLOWS[(n + i) % 4]! : boss && !king ? (type as CampKind) : 'small';
    return { title, champion, campKind, tag: `descent-${campKind}-${n}.${label}.${i}:${type}` };
  }

  /**
   * Every monster this chamber will raise (its waves, a boss's adds, a
   * treasure room's Gilded Thornback), by the tag and name the views will
   * see, so their models can be built before they arrive. Works on a guest's
   * copy too: it reads only the chamber's plan, the team and the curses.
   */
  upcoming(): { tag: string; name: string }[] {
    if (!this.chamber) return [];
    const n = this.chamber;
    const out: { tag: string; name: string }[] = [];
    const add = (roster: MonsterType[], label: string) =>
      this.swarmed(roster).forEach((type, i) => {
        const { title, tag } = this.look(type, i, label);
        out.push({ tag, name: monsterName(type, title) });
      });
    chamberWaves(this.current, this.gods.length).forEach((w, k) => add(w, `w${k + 1}`));
    if (this.current.kind === 'boss') for (let k = 0; k < DESCENT.bossAdds.length; k++) add(bossAdds(n), 'adds');
    if (this.current.kind === 'treasure') out.push({ tag: `descent-small-${n}.g:gildedThornback`, name: monsterName('gildedThornback') });
    return out;
  }

  private spawn(roster0: MonsterType[], label: string): void {
    const n = this.chamber;
    const c = this.layout;
    const roster = this.swarmed(roster0);
    const minutes = chamberMinutes(n);
    const scale = chamberScale(n, !this.versus);
    const team = teamScale(this.gods.length);
    roster.forEach((type, i) => {
      const boss = isBossType(type);
      const spot = boss ? [0, -c.extent * 0.35] : c.spawns[(i + this.wave * 3) % c.spawns.length]!;
      const jx = boss ? 0 : (this.sim.rng() - 0.5) * 2.2;
      const jz = boss ? 0 : (this.sim.rng() - 0.5) * 2.2;
      const x = c.x + spot[0]! + jx;
      const z = c.z + spot[1]! + jz;
      const king = type === 'ossuaryKing';
      const { title, champion, campKind, tag } = this.look(type, i, label);
      const u = monsterUnit(this.base, type, { x, z, yaw: 0 }, minutes, title);
      const cb = u.combatant;
      let hp = scale * team * DESCENT_TUNING.health * (this.versus ? DESCENT_TUNING.versusHealth : 1);
      let power = scale * DESCENT_TUNING.power;
      if (boss) hp *= DESCENT_TUNING.bossHealth;
      if (boss && n === DESCENT.bossEvery) hp *= 0.7;
      if (boss && n === 2 * DESCENT.bossEvery) hp *= DESCENT_TUNING.secondBoss;
      if (boss && n === DESCENT.chambers) {
        hp *= DESCENT_TUNING.lastBoss;
        power *= 1.15;
      }
      if (champion) {
        hp *= CHAMPION.health;
        power *= CHAMPION.power;
        this.champion = u;
      }
      for (const k of this.curses) {
        if (k.swarm && type === 'thornback') hp *= k.swarm.health;
        if (k.power) power *= 1 + k.power;
      }
      if (hp !== 1) cb.refreshTimedMod('maxHealth', cb.stats.maxHealth * (hp - 1), 1e9);
      if (power !== 1) cb.refreshTimedMod('attackPower', cb.stats.attackPower * (power - 1), 1e9);
      for (const k of this.curses) {
        for (const [s, f] of Object.entries(k.scale ?? {}) as [StatKey, number][]) cb.refreshTimedMod(s, cb.stats[s] * f, 1e9);
        for (const [s, v] of Object.entries(k.flat ?? {}) as [StatKey, number][]) cb.refreshTimedMod(s, v, 1e9);
      }
      cb.health = cb.stats.maxHealth;
      if (u.bounty) u.bounty = { xp: u.bounty.xp * DESCENT_TUNING.killXp, favor: u.bounty.favor * DESCENT_TUNING.favor };
      u.tag = tag;
      u.home.x = x;
      u.home.z = z;
      const camp: CampState = { camp: { id: `descent:${n}:${label}:${i}`, kind: campKind, team: null, at: [x, z] }, members: [u], respawnAt: null, foe: null };
      u.brain = new DescentMonsterBrain(this.sim, u, camp, obstaclesOf(c), c, () => this.introLeft > 0);
      if (boss) this.boss = u;
      if (king) this.rainIn = KING.rain.first;
      u.origin = { f: 'mode', kind: 'descent', data: { type, min: minutes, title, role: boss ? 'boss' : champion ? 'champion' : '' } satisfies DescentSpawn };
      this.monsters.push(u);
      this.sim.add(u);
    });
  }

  private spawnGilded(): void {
    const c = this.layout;
    const spot = c.spawns[1]!;
    const u = monsterUnit(this.base, 'gildedThornback', { x: c.x + spot[0]!, z: c.z + spot[1]!, yaw: 0 }, chamberMinutes(this.chamber));
    u.combatant.refreshTimedMod('maxHealth', u.combatant.stats.maxHealth * (chamberScale(this.chamber) * teamScale(this.gods.length) - 1), 1e9);
    u.combatant.health = u.combatant.stats.maxHealth;
    u.tag = `descent-small-${this.chamber}.g:gildedThornback`;
    u.brain = new FleeBrain(this.sim, u, { x: c.x, z: c.z }, Math.max(8, c.extent * 0.6));
    u.origin = { f: 'mode', kind: 'descent', data: { type: 'gildedThornback', min: chamberMinutes(this.chamber), title: '', role: 'gilded' } satisfies DescentSpawn };
    this.gilded = u;
    this.monsters.push(u);
    this.sim.add(u);
  }

  private escapeGilded(): void {
    if (!this.gilded) return;
    const i = this.monsters.indexOf(this.gilded);
    if (i >= 0) this.monsters.splice(i, 1);
    this.sim.remove(this.gilded);
    this.gilded = null;
    this.gildedFate = 'escaped';
  }

  // -------------------------------------------------------------------------
  // Clearing a chamber, and its reward

  private clearChamber(): void {
    this.eruptions.length = 0;
    const n = this.chamber;
    for (const g of this.gods) {
      this.sim.reward(g, (170 + 50 * n) * DESCENT_TUNING.clearXp, (40 + 12 * n) * DESCENT_TUNING.favor);
      if (g.alive) {
        const c = g.combatant;
        c.heal(c.stats.maxHealth * 0.2);
        c.mana = Math.min(c.stats.maxMana, c.mana + c.stats.maxMana * 0.3);
      }
    }
    if (n >= DESCENT.chambers) {
      this.phase = 'won';
      if (this.versus) this.winner = this.decide();
      return;
    }
    this.nextCurse = CURSE_AT.includes(n + 1) ? this.rollCurse() : null;
    this.offerReward();
  }

  /** The most souls wins (as the HUD shows them, in whole souls); then the most monsters slain. */
  private decide(): Side | 'draw' {
    const o = Math.floor(this.souls.order);
    const c = Math.floor(this.souls.chaos);
    if (o !== c) return o > c ? 'order' : 'chaos';
    if (this.teamKills.order !== this.teamKills.chaos) return this.teamKills.order > this.teamKills.chaos ? 'order' : 'chaos';
    return 'draw';
  }

  private rollCurse(): DescentCurse | null {
    const pool = DESCENT_CURSES.filter((c) => !this.curses.some((k) => k.id === c.id));
    return pool.length ? pool[Math.floor(this.sim.rng() * pool.length)]! : null;
  }

  /** Whether any god still has a sealed skill slot to draft into. */
  private get canLearn(): boolean {
    return this.gods.some((g) => g.combatant.sealed.size > 0);
  }

  /** Three cards for these teams to vote on (both teams see the same three; each takes its own pick). */
  private offerReward(sides: Side[] = this.sides): void {
    const rng = this.sim.rng;
    const cards: Reward[] = [];
    const hurt = this.gods.reduce((s, g) => s + (g.alive ? g.combatant.health / g.combatant.stats.maxHealth : 0), 0) / Math.max(1, this.gods.length);
    if (this.canLearn && (this.chamber <= 2 || rng() < 0.75)) cards.push(SKILL_REWARD);
    if ((this.downed.size > 0 || hurt < 0.55) && rng() < 0.85) cards.push(HEAL);
    // nobody's run ends in a shared descent, so there is no wipe for an obol to undo
    if (!this.versus && this.obols < 1 && this.chamber >= 3 && rng() < 0.12) cards.push(OBOL);
    const relics = this.relics.open(sides);
    if (cards.length < 3 && this.chamber >= 2 && relics.length && rng() < (RELIC_CHANCE[this.current.kind] ?? 0)) {
      const r = relics[Math.floor(rng() * relics.length)]!;
      cards.push({ kind: 'relic', name: r.name, text: r.text, relic: r });
    }
    if (cards.length < 3 && rng() < 0.4) cards.push(POINTS);
    const boons = shuffle(DESCENT_BOONS, rng);
    while (cards.length < 3) {
      const b = boons.pop()!;
      cards.push({ kind: 'boon', name: b.name, text: b.text, boon: b });
    }
    this.offer = shuffle(cards, rng);
    this.offerTeams = sides;
    this.votes.clear();
    this.picks.clear();
    this.phase = 'reward';
    this.timer = DESCENT.voteTime;
    // a team with nobody to vote takes what a team would usually want
    for (const side of sides) if (!this.humansOf(side).length) this.picks.set(side, this.botChoice(side));
    if (this.picks.size === sides.length) this.resolveVote();
  }

  private botChoice(side: Side): number {
    const o = this.offer!;
    const down = [...this.downed.keys()].some((g) => this.sideOf(g) === side);
    const order: RewardKind[] = down ? ['heal', 'skill', 'relic', 'obol', 'boon', 'points'] : ['skill', 'relic', 'obol', 'boon', 'points', 'heal'];
    for (const k of order) {
      const i = o.findIndex((r) => r.kind === k);
      if (i >= 0) return i;
    }
    return 0;
  }

  private allVoted(): boolean {
    return this.offerTeams.every((side) => this.picks.has(side) || this.humansOf(side).every((h) => this.votes.has(h)));
  }

  /** A human's vote for one of the offered rewards (they can change it until the vote closes). */
  vote(god: Unit, i: number): boolean {
    if (this.phase !== 'reward' || !this.offer?.[i] || !this.gods.includes(god) || !this.offerTeams.includes(this.sideOf(god))) return false;
    this.votes.set(god, i);
    return true;
  }

  /** How many votes each card has (from one team's gods, or everyone's). */
  tally(side?: Side): number[] {
    const t = (this.offer ?? []).map(() => 0);
    for (const [g, v] of this.votes) if (!side || this.sideOf(g) === side) t[v] = (t[v] ?? 0) + 1;
    return t;
  }

  /** Each team takes its pick: the most votes wins; a tie goes to the card voted first among the tied (no votes: the first card). */
  private resolveVote(): void {
    const offer = this.offer;
    if (!offer) return;
    const chosen = this.offerTeams.map((side): [Side, number] => {
      const pick = this.picks.get(side);
      if (pick !== undefined) return [side, pick];
      const t = this.tally(side);
      const top = Math.max(...t);
      const first = [...this.votes].find(([g, v]) => this.sideOf(g) === side && t[v] === top);
      return [side, top > 0 && first ? first[1] : 0];
    });
    this.offer = null;
    this.offerTeams = [];
    this.votes.clear();
    this.picks.clear();
    for (const [side, i] of chosen) this.take(offer[i]!, side);
    if (this.drafts.size) {
      this.phase = 'draft';
      this.timer = DESCENT.draftTime;
    } else this.afterReward();
  }

  /** The chosen reward takes effect for a whole team. */
  private take(r: Reward, side: Side): void {
    this.lastReward = r;
    const team = this.teamOf(side);
    switch (r.kind) {
      case 'boon': {
        const b = r.boon!;
        this.boons.push(b);
        this.boonTeam.push(side);
        for (const g of team) for (const [k, v] of Object.entries(b.stats ?? {}) as [StatKey, number][]) g.combatant.addPerk(k, v);
        break;
      }
      case 'points':
        for (const g of team) grantTreePoints(g, POINTS_REWARD);
        break;
      case 'relic':
        this.relics.take(r.relic!.id, side);
        break;
      case 'heal':
        for (const g of team) {
          if (!g.alive) this.revive(g, 1);
          else {
            const c = g.combatant;
            c.health = c.stats.maxHealth;
            c.mana = c.stats.maxMana;
          }
        }
        break;
      case 'obol':
        this.obols++;
        break;
      case 'skill':
        for (const g of team) {
          const d = draftFor(g, this.sim.rng);
          if (d) this.drafts.set(g, d);
        }
        break;
    }
  }

  /** The reward the team took last, for the HUD's toast. */
  lastReward: Reward | null = null;

  /** A god takes one of its drafted skills into its next sealed slot. */
  draft(god: Unit, i: number): SkillDef | null {
    const d = this.drafts.get(god);
    const skill = d?.options[i];
    if (!d || !skill) return null;
    this.drafts.delete(god);
    learnSkill(god, d.slot, skill);
    this.learned.push([++this.learnSerial, this.gods.indexOf(god), d.slot, skill.id]);
    if (this.learned.length > 8) this.learned.shift();
    return skill;
  }

  /** The latest skills learned, as [serial, god index, slot, skill id] (sent to guests, who keep their own loadouts). */
  private readonly learned: [number, number, number, string][] = [];
  private learnSerial = 0;

  private afterReward(): void {
    // the Gilded Thornback's prize: another reward straight after, for the team that caught it
    const more = this.sides.filter((side) => this.bonus[side] > 0);
    if (more.length) {
      for (const side of more) this.bonus[side]--;
      this.offerReward(more);
      return;
    }
    this.phase = 'exit';
    this.timer = DESCENT.exitPull;
  }

  // -------------------------------------------------------------------------
  // Moving down

  private nextChamber(): void {
    if (this.nextCurse) this.curses.push(this.nextCurse);
    this.nextCurse = null;
    this.chamber++;
    this.phase = 'enter';
    this.timer = DESCENT.enterTime;
    this.relics.reset();
    this.placeTeam();
  }

  /** Where a god stands at the current chamber's gate: a shared descent puts Order left of it and Chaos right, a gap between. */
  gateOf(g: Unit): { x: number; z: number; yaw: number } {
    const c = this.layout;
    if (!this.versus) return entranceSpot(c, this.gods.indexOf(g), this.gods.length);
    const side = this.sideOf(g);
    const i = this.teamOf(side).indexOf(g);
    return entranceSpot(c, side === 'order' ? 2 - i : 4 + i, 7, 2);
  }

  /**
   * Every god to the current chamber's gate; the fallen come along. Quietly:
   * the team walks in under the fade, so no flash, puff or whoosh where each
   * god left or lands (Loki's smoke and Anubis's sand hung over the camera).
   */
  private placeTeam(): void {
    this.gods.forEach((g) => {
      const at = this.gateOf(g);
      g.home.x = at.x;
      g.home.z = at.z;
      g.home.yaw = at.yaw;
      if (!g.alive) this.revive(g, DESCENT.returnHealth);
      else this.sim.teleport(g, at.x, at.z, at.yaw, true);
      g.combatant.cc.reset();
    });
  }

  // -------------------------------------------------------------------------
  // Revives and wipes

  /** Seconds a revive takes with every curse counted. */
  get reviveTime(): number {
    return this.curses.reduce<number>((t, k) => t * (k.restless ?? 1), DESCENT.revive.time);
  }

  private stepRevives(dt: number): void {
    for (const [g, p] of this.downed) {
      let helpers = 0;
      for (const a of this.gods) {
        // only a god's own team can raise it
        if (a === g || !a.alive || this.sideOf(a) !== this.sideOf(g)) continue;
        if (hypot(a.x - g.x, a.z - g.z) <= DESCENT.revive.range + a.radius) helpers++;
      }
      const side = this.sideOf(g);
      const next = helpers ? p + (dt * (1 + 0.5 * (helpers - 1)) * this.relics.reviveSpeed(side)) / this.reviveTime : Math.max(0, p - dt * 0.25);
      if (next >= 1) this.revive(g, this.relics.riseHealth(side, DESCENT.revive.health));
      else this.downed.set(g, next);
    }
  }

  /** Brings a downed god back where it lies (or at its home spot), with this share of its health. */
  revive(g: Unit, health: number): void {
    // a death the sim has yet to notice: it lands in `downed` on the next step
    if (g.alive || g.wasAlive) return;
    this.downed.delete(g);
    g.downed = false;
    if (this.phase !== 'descend' && this.phase !== 'enter') {
      g.home.x = g.x;
      g.home.z = g.z;
      g.home.yaw = g.body.yaw;
    }
    this.reviving.set(g, health);
    g.combatant.respawnTimer = 0;
  }

  /** Every god down at once ends the run, unless an obol lifts them (a shared descent never ends this way: the fallen rise at the gate). */
  private checkWipe(): boolean {
    if (this.versus || !this.gods.length || !this.gods.every((g) => this.downed.has(g))) return false;
    if (this.obols > 0) {
      this.obols--;
      this.obolUsed++;
      for (const g of this.gods) this.revive(g, 0.5);
      return false;
    }
    this.phase = 'lost';
    this.offer = null;
    this.drafts.clear();
    return true;
  }

  // -------------------------------------------------------------------------
  // Soul fire

  /** Whether soul fire erupts in the current chamber. */
  get erupting(): boolean {
    return this.phase === 'fight' && (this.current.kind === 'trap' || this.curses.some((k) => k.ashfall));
  }

  private stepEruptions(dt: number): void {
    for (let i = this.eruptions.length - 1; i >= 0; i--) {
      const e = this.eruptions[i]!;
      e.left -= dt;
      if (e.left > 0) continue;
      this.eruptions.splice(i, 1);
      this.land(e);
    }
    if (!this.erupting) return;
    this.eruptIn -= dt;
    if (this.eruptIn > 0) return;
    // ashfall in a chamber that isn't a trap room is gentler
    const trap = this.current.kind === 'trap';
    this.eruptIn = DESCENT.eruption.every * (trap ? 1 : 1.8);
    const c = this.layout;
    const rng = this.sim.rng;
    for (const g of this.gods) {
      if (!g.alive) continue;
      // aimed a little ahead of where the god is going, so standing still or walking straight both get caught
      this.erupt(g.x + g.vx * 0.6 + (rng() - 0.5) * 1.5, g.z + g.vz * 0.6 + (rng() - 0.5) * 1.5);
    }
    if (trap) {
      for (let k = 0; k < 2; k++) {
        const s = c.spawns[Math.floor(rng() * c.spawns.length)]!;
        this.erupt(c.x + s[0]! + (rng() - 0.5) * 6, c.z + s[1]! + (rng() - 0.5) * 6);
      }
    }
  }

  /**
   * The Ossuary King's Soul Rain: it raises its hand and soul fire falls under
   * every god, a little ahead of where each is going, and on a few spots around
   * it besides. Faster once it is badly hurt; never while it is stunned.
   */
  private stepKing(dt: number): void {
    const k = this.boss;
    if (!k?.alive || this.phase !== 'fight' || !k.tag.endsWith(':ossuaryKing')) return;
    this.rainIn -= dt;
    if (this.rainIn > 0) return;
    if (k.combatant.cc.locks().cast) {
      this.rainIn = 0.5;
      return;
    }
    const hurt = k.combatant.health / k.combatant.stats.maxHealth < KING.enrage;
    this.rainIn = hurt ? KING.rain.enraged : KING.rain.every;
    const rng = this.sim.rng;
    for (const g of this.gods) {
      if (!g.alive || hypot(g.x - k.x, g.z - k.z) > KING.rain.reach) continue;
      this.erupt(g.x + g.vx * 0.6 + (rng() - 0.5) * 1.5, g.z + g.vz * 0.6 + (rng() - 0.5) * 1.5);
    }
    const c = this.layout;
    for (let i = 0; i < KING.rain.extra; i++) {
      const a = rng() * Math.PI * 2;
      const r = 5 + rng() * 6;
      const x = k.x + Math.sin(a) * r;
      const z = k.z + Math.cos(a) * r;
      if (c.sd(x - c.x, z - c.z) > 1.5) this.erupt(x, z);
    }
  }

  private erupt(x: number, z: number): void {
    this.eruptions.push({ id: this.nextEruption++, x, z, r: DESCENT.eruption.radius, left: DESCENT.eruption.warn });
  }

  /** An eruption lands: every god inside takes a share of its health. */
  private land(e: Eruption): void {
    this.landed.push(e);
    for (const g of this.gods) {
      if (!g.alive || g.untargetable > 0 || hypot(g.x - e.x, g.z - e.z) > e.r + g.radius) continue;
      const c = g.combatant;
      const amount = c.stats.maxHealth * DESCENT.eruption.damage * (1 - Math.min(0.9, c.stats.damageReduction));
      c.takeDamage(amount);
      this.sim.inject({ type: 'damage', target: g, source: null, amount, crit: false, ability: true });
    }
  }

  /** Eruptions that landed since the view last took them (for the burst effect). */
  readonly landed: Eruption[] = [];

  // -------------------------------------------------------------------------
  // Online co-op: the host runs the rules; guests copy them (see NetMatch in src/net/Replica.ts)

  /**
   * A guest's copy: the same gods in the same order as the host's, with no
   * rules of its own. Everything else arrives through applyNet and netSpawn.
   */
  join(gods: readonly Unit[], humans: readonly Unit[]): void {
    for (const g of gods) this.addGod(g, humans.includes(g));
    this.underdog();
    this.relics.remote = true;
  }

  netState(): DescentNet {
    const gi = (u: Unit) => this.gods.indexOf(u);
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const plan = this.chamber ? this.current : null;
    return {
      c: this.chamber,
      p: this.phase,
      t: r2(this.timer),
      tm: Math.round(this.time * 10) / 10,
      pl: plan ? [plan.layout, plan.kind] : null,
      k: this.kills,
      o: this.obols,
      ou: this.obolUsed,
      sp: Math.round(this.spoils * 10) / 10,
      br: [this.bonus.order, this.bonus.chaos],
      gf: this.gildedFate,
      un: [this.boss?.alive ? 1 : 0, this.champion?.alive ? 1 : 0, this.gilded ? 1 : 0],
      cu: this.curses.map((c) => c.id),
      nc: this.nextCurse?.id ?? null,
      of: this.offer?.map(rewardKey) ?? null,
      v: [...this.votes].map(([u, i]) => [gi(u), i]),
      dr: [...this.drafts].map(([u, d]) => [gi(u), d.slot, d.options.map((s) => s.id)]),
      dn: [...this.downed].map(([u, p]) => [gi(u), r2(p)]),
      e: this.eruptions.map((e) => [e.id, r2(e.x), r2(e.z), e.r, r2(e.left)]),
      b: this.boons.map((b) => b.id),
      ...(this.relics.held.length || this.relics.procs.length ? { rl: this.relics.netState(sideCode) } : {}),
      ...(this.introLeft > 0 ? { it: r2(this.introLeft) } : {}),
      ...(this.fallLeft > 0 ? { fl: r2(this.fallLeft) } : {}),
      ...(this.bossAddsCalled ? { bc: this.bossAddsCalled } : {}),
      l: this.learned,
      h: [...this.humans].map(gi),
      ...(this.versus
        ? {
            vs: {
              so: [r2(this.souls.order), r2(this.souls.chaos)],
              tk: [this.teamKills.order, this.teamKills.chaos],
              ro: [this.routs.order, this.routs.chaos],
              bb: this.bossBy,
              w: this.winner,
              st: this.spoilsTeam,
              ot: this.offerTeams.map(sideCode).join(''),
              pk: [...this.picks].map(([side, i]) => sideCode(side) + i).join(''),
              bt: this.boonTeam.map(sideCode).join(''),
            },
          }
        : {}),
    };
  }

  applyNet(state: unknown): void {
    const s = state as DescentNet;
    const god = (i: number) => this.gods[i] ?? null;
    this.chamber = s.c;
    this.phase = s.p;
    this.timer = s.t;
    this.time = s.tm;
    if (s.pl && s.c > 0) this.plan[s.c - 1] = { n: s.c, layout: s.pl[0], kind: s.pl[1] };
    this.introLeft = s.it ?? 0;
    this.fallLeft = s.fl ?? 0;
    this.bossAddsCalled = s.bc ?? 0;
    this.kills = s.k;
    this.obols = s.o;
    this.obolUsed = s.ou;
    this.spoils = s.sp;
    this.bonus.order = s.br[0];
    this.bonus.chaos = s.br[1];
    const vs = s.vs;
    if (vs) {
      [this.souls.order, this.souls.chaos] = vs.so;
      [this.teamKills.order, this.teamKills.chaos] = vs.tk;
      [this.routs.order, this.routs.chaos] = vs.ro;
      this.bossBy = vs.bb;
      this.winner = vs.w;
      this.spoilsTeam = vs.st;
      this.offerTeams = [...vs.ot].map(codeSide);
      this.picks.clear();
      for (let i = 0; i + 1 < vs.pk.length; i += 2) this.picks.set(codeSide(vs.pk[i]!), Number(vs.pk[i + 1]));
    } else this.offerTeams = s.of ? ['order'] : [];
    this.gildedFate = s.gf;
    if (!s.un[0]) this.boss = null;
    if (!s.un[1]) this.champion = null;
    if (!s.un[2]) this.gilded = null;
    if (s.cu.join() !== this.curses.map((c) => c.id).join()) {
      this.curses.length = 0;
      for (const id of s.cu) {
        const c = DESCENT_CURSES.find((k) => k.id === id);
        if (c) this.curses.push(c);
      }
    }
    this.nextCurse = DESCENT_CURSES.find((k) => k.id === s.nc) ?? null;
    this.relics.applyNet(s.rl ?? { h: [], p: [], sp: [] }, codeSide);
    // the same objects while nothing changes, so the HUD only redraws its cards on a change
    const offerKey = s.of?.join() ?? '';
    if (offerKey !== (this.offer?.map(rewardKey).join() ?? '')) this.offer = s.of ? s.of.map(rewardFromKey) : null;
    this.votes.clear();
    for (const [i, v] of s.v) if (god(i)) this.votes.set(god(i)!, v);
    const drafts = new Map<Unit, Draft>();
    for (const [i, slot, ids] of s.dr) {
      const g = god(i);
      // a pick this end already made (and learned) before the host heard of it
      if (!g || !g.combatant.sealed.has(slot)) continue;
      const had = this.drafts.get(g);
      const same = had && had.slot === slot && had.options.map((o) => o.id).join() === ids.join();
      const options = ids.map((id) => g.combatant.god.skills.find((k) => k.id === id)).filter((k): k is SkillDef => !!k);
      drafts.set(g, same ? had : { slot, options });
    }
    this.drafts.clear();
    for (const [g, d] of drafts) this.drafts.set(g, d);
    this.downed.clear();
    for (const [i, p] of s.dn) if (god(i)) this.downed.set(god(i)!, p);
    for (const g of this.gods) g.downed = this.downed.has(g);
    // an eruption that vanished on its last moments landed: burst it here too
    const now = new Set(s.e.map((e) => e[0]));
    for (const e of this.eruptions) if (!now.has(e.id) && e.left < 0.4) this.landed.push(e);
    this.eruptions.length = 0;
    for (const [id, x, z, r, left] of s.e) this.eruptions.push({ id, x, z, r, left });
    // boons give the team's gods the same perks on every end
    for (let i = this.boons.length; i < s.b.length; i++) {
      const b = DESCENT_BOONS.find((k) => k.id === s.b[i]);
      if (!b) continue;
      const side = codeSide(vs?.bt[i] ?? 'o');
      this.boons.push(b);
      this.boonTeam.push(side);
      for (const g of this.teamOf(side)) for (const [k, v] of Object.entries(b.stats ?? {}) as [StatKey, number][]) g.combatant.addPerk(k, v);
    }
    // a guest keeps its own loadout: learn what the host learned (a pick made here, or one the timer made)
    for (const [serial, i, slot, id] of s.l) {
      if (serial <= this.learnSerial) continue;
      this.learnSerial = serial;
      const g = god(i);
      const skill = g?.combatant.god.skills.find((k) => k.id === id);
      if (g && skill && (g.combatant.sealed.has(slot) || g.combatant.loadout[slot] !== id)) learnSkill(g, slot, skill);
    }
    this.humans.clear();
    for (const i of s.h) if (god(i)) this.humans.add(god(i)!);
  }

  /** On a guest: one of the host's monsters, built the same way (its health and buffs arrive with its state). */
  netSpawn(origin: { kind: string; data?: unknown }, _team: unknown, at: { x: number; z: number; yaw: number }): Unit | null {
    if (origin.kind !== 'descent') return null;
    const d = origin.data as DescentSpawn;
    const u = monsterUnit(this.base, d.type, at, d.min, d.title);
    if (d.role === 'boss') this.boss = u;
    else if (d.role === 'champion') this.champion = u;
    else if (d.role === 'gilded') this.gilded = u;
    this.monsters.push(u);
    return u;
  }

  /** On a guest, between snapshots: drop the fallen and run the clocks down so countdowns stay smooth. */
  follow(dt: number): void {
    for (let i = this.monsters.length - 1; i >= 0; i--) if (!this.monsters[i]!.alive) this.monsters.splice(i, 1);
    if (this.over || !this.chamber) return;
    this.time += dt;
    this.timer = Math.max(0, this.timer - dt);
    this.spoils = Math.max(0, this.spoils - dt);
    this.introLeft = Math.max(0, this.introLeft - dt);
    this.fallLeft = Math.max(0, this.fallLeft - dt);
    for (const e of this.eruptions) e.left = Math.max(0, e.left - dt);
  }
}

/** How a monster the run spawned is rebuilt on a guest. */
interface DescentSpawn {
  type: MonsterType;
  min: number;
  title: string;
  role: '' | 'boss' | 'champion' | 'gilded';
}

/** The run's state on the wire (Descent.netState): gods travel as their index in the line-up. */
export interface DescentNet {
  c: number;
  p: DescentPhase;
  t: number;
  tm: number;
  pl: [number, ChamberKind] | null;
  k: number;
  o: number;
  ou: number;
  sp: number;
  /** Bonus rewards still due to Order and to Chaos. */
  br: [number, number];
  gf: 'caught' | 'escaped' | null;
  /** Whether the boss, the Champion and the Gilded Thornback still stand. */
  un: [number, number, number];
  cu: string[];
  nc: string | null;
  of: string[] | null;
  v: [number, number][];
  dr: [number, number, string[]][];
  dn: [number, number][];
  e: [number, number, number, number, number][];
  b: string[];
  /** Relics held and their recent procs (left out while there are none). */
  rl?: RelicNet;
  /** Seconds left of a boss's entrance (left out the rest of the time). */
  it?: number;
  /** Seconds left of a boss's fall (left out the rest of the time). */
  fl?: number;
  /** Times the boss has called up its adds (left out until it does). */
  bc?: number;
  l: [number, number, number, string][];
  h: number[];
  /** A shared descent's score and team choices (teams as 'o' and 'c'). */
  vs?: {
    so: [number, number];
    tk: [number, number];
    ro: [number, number];
    bb: Side | null;
    w: Side | 'draw' | null;
    st: Side;
    /** The teams voting on the offer, and the picks already settled ('o2' : Order took the third card). */
    ot: string;
    pk: string;
    /** Which team took each boon. */
    bt: string;
  };
}

const sideCode = (s: Side): string => (s === 'order' ? 'o' : 'c');
const codeSide = (c: string): Side => (c === 'c' ? 'chaos' : 'order');

const REWARDS: readonly Reward[] = [SKILL_REWARD, POINTS, HEAL, OBOL];
const rewardKey = (r: Reward): string => (r.kind === 'boon' ? `b:${r.boon!.id}` : r.kind === 'relic' ? `r:${r.relic!.id}` : r.kind);
function rewardFromKey(key: string): Reward {
  const relic = key.startsWith('r:') ? relicById(key.slice(2)) : undefined;
  if (relic) return { kind: 'relic', name: relic.name, text: relic.text, relic };
  if (key.startsWith('b:')) {
    const b = DESCENT_BOONS.find((k) => k.id === key.slice(2))!;
    return { kind: 'boon', name: b?.name ?? '', text: b?.text ?? '', boon: b };
  }
  return REWARDS.find((r) => r.kind === key) ?? SKILL_REWARD;
}

/** Favor enough for this many more tree points (each god's points come from levels and favor). */
export function grantTreePoints(g: Unit, points: number): void {
  const c = g.combatant;
  const have = favorPoints(c.favor);
  const goal = Math.min(FAVOR_THRESHOLDS.length, have + points);
  if (goal > have) c.gainFavor(FAVOR_THRESHOLDS[goal - 1]! - c.favor);
}

/** Three skills a god could learn into its next sealed slot (ultimates for the ultimate slot). */
export function draftFor(g: Unit, rng: () => number): Draft | null {
  const c = g.combatant;
  const slot = [...c.sealed].sort((a, b) => a - b)[0];
  if (slot === undefined) return null;
  const known = new Set(c.loadout.filter((_, i) => !c.sealed.has(i)));
  const pool = c.god.skills.filter((s) => !known.has(s.id) && (slot === ULTIMATE_SLOT ? s.kind === 'ultimate' : s.kind === 'regular'));
  const options = shuffle(pool, rng).slice(0, 3);
  return options.length ? { slot, options } : null;
}

/** Puts a skill into a sealed slot and unseals it; a sealed slot already holding it gives it up. */
export function learnSkill(g: Unit, slot: number, skill: SkillDef): void {
  const c = g.combatant;
  const next = [...c.loadout] as string[];
  const was = next.indexOf(skill.id);
  if (was >= 0 && was !== slot) next[was] = next[slot]!;
  next[slot] = skill.id;
  c.setBuild(next, c.allocation);
  c.sealed.delete(slot);
}

/** Every slot of a god's bar, so a test can check none is ever left empty. */
export const ALL_SLOTS = Array.from({ length: SLOT_COUNT }, (_, i) => i);
