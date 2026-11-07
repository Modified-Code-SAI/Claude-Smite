import { Combatant, type Team } from '../game/combatant';
import { FAVOR_REWARDS } from '../game/progression';
import type { GodDef } from '../game/types';
import { Unit, WORLD_SCALE, type Body, type Point, type UnitKind } from './Unit';

export const GOD_RADIUS = 0.6;

/** A plain body for units the simulation moves itself. */
export function body(x: number, z: number, yaw = 0): Body {
  return { x, y: 0, z, yaw };
}

export function godUnit(god: GodDef, team: Team, home: { x: number; z: number; yaw: number }, b: Body = body(home.x, home.z, home.yaw)): Unit {
  const u = new Unit('god', god.name, new Combatant(god, team), b, GOD_RADIUS, home);
  u.origin = { f: 'god', god: god.id };
  return u;
}

/**
 * Non-god units borrow a god's definition (the rules engine needs a full
 * GodDef) with their own stats. They never cast, so the loadout is unused.
 */
export function variant(base: GodDef, id: string, name: string, stats: Partial<GodDef['base']>, basicAttack?: GodDef['basicAttack']): GodDef {
  return {
    ...base,
    id,
    name,
    base: { ...base.base, healthRegen: 0, manaRegen: 0, moveSpeed: 0, ...stats },
    growth: {},
    basicAttack: basicAttack ?? base.basicAttack,
  };
}

/** A training post: sturdy, does not move or fight back, and stands again 8 s after it breaks. */
export function dummyUnit(base: GodDef, team: Team, at: { x: number; z: number; yaw: number }): Unit {
  const def = variant(base, 'training-dummy', 'Training Dummy', {
    maxHealth: 1400,
    physicalProtection: 20,
    magicalProtection: 20,
  });
  const u = new Unit('dummy', def.name, new Combatant(def, team), body(at.x, at.z, at.yaw), 0.55, at);
  u.origin = { f: 'dummy' };
  return u;
}

const SUMMONS: Record<string, { name: string; health: number; speed: number }> = {
  decoy: { name: 'Decoy', health: 200, speed: 0 },
  'mirror-copy': { name: 'Mirror Copy', health: 250, speed: 0 },
  einherjar: { name: 'Einherjar', health: 400, speed: 340 },
};

/** How many units one cast of a summon calls up (Odin's Einherjar and Loki's Mirror Legion come in pairs). */
export function summonCount(kind: string): number {
  return kind === 'einherjar' || kind === 'mirror-copy' ? 2 : 1;
}

export interface SummonLook {
  god: string;
  variant: 'god' | 'einherjar';
}

/**
 * The god model a summon is drawn with: Loki's Decoy and Mirror Copies wear
 * their summoner's own body (enemies must not tell them from the real god),
 * Odin's Einherjar the fallback warrior's body in their own colors.
 */
export function summonLook(kind: string, ownerGod: string): SummonLook {
  return kind === 'einherjar' ? { god: `summon:${kind}`, variant: 'einherjar' } : { god: ownerGod, variant: 'god' };
}

export function summonUnit(owner: Unit, kind: string, at: Point, index: number): Unit {
  const info = SUMMONS[kind] ?? { name: kind, health: 200, speed: 0 };
  const def = variant(owner.combatant.god, `summon:${kind}`, info.name, { maxHealth: info.health, moveSpeed: info.speed });
  // spread copies around the spot so they don't stack
  const angle = owner.body.yaw + Math.PI / 2 + index * Math.PI;
  const spread = kind === 'decoy' ? 0 : 1.6;
  const x = at.x + Math.sin(angle) * spread;
  const z = at.z + Math.cos(angle) * spread;
  const u = new Unit('summon', info.name, new Combatant(def, owner.team), body(x, z, owner.body.yaw), 0.55, { x, z, yaw: owner.body.yaw });
  u.origin = { f: 'summon', kind, index };
  return u;
}

export type MinionType = 'melee' | 'archer' | 'brute';

/**
 * Lane minions. Base numbers sit between Smite's and our god stats so a god
 * clears a wave in a few skills early and minions still hurt a diving god.
 * Waves grow a little stronger as the match goes on.
 */
const MINIONS: Record<MinionType, { name: string; health: number; power: number; speed: number; prot: number; range: number; projectile?: number; radius: number; rate: number }> = {
  melee: { name: 'Swordsman', health: 300, power: 26, speed: 330, prot: 12, range: 1.6, radius: 0.5, rate: 0.85 },
  archer: { name: 'Archer', health: 200, power: 22, speed: 330, prot: 6, range: 6.2, projectile: 34, radius: 0.45, rate: 0.8 },
  brute: { name: 'Brute', health: 900, power: 55, speed: 300, prot: 30, range: 1.9, radius: 0.85, rate: 0.6 },
};

export function minionUnit(
  base: GodDef,
  team: Team,
  type: MinionType,
  at: { x: number; z: number; yaw: number },
  opts: { wave: number; empowered: boolean },
): Unit {
  const m = MINIONS[type];
  const grow = 1 + Math.min(1.2, opts.wave * 0.025);
  const boost = opts.empowered ? 1.5 : 1;
  const def = variant(
    base,
    `minion:${type}`,
    opts.empowered ? `Empowered ${m.name}` : m.name,
    {
      maxHealth: Math.round(m.health * grow * boost),
      attackPower: m.power * grow * (opts.empowered ? 1.4 : 1),
      attackSpeed: m.rate,
      moveSpeed: m.speed,
      physicalProtection: m.prot,
      magicalProtection: m.prot,
    },
    { range: m.range, damageType: 'physical', projectileSpeed: m.projectile },
  );
  const u = new Unit('minion', def.name, new Combatant(def, team), body(at.x, at.z, at.yaw), m.radius, at);
  u.respawns = false;
  u.tag = type;
  u.origin = { f: 'minion', type, wave: opts.wave, empowered: opts.empowered };
  return u;
}

export type MonsterType =
  | 'thornback'
  | 'thornbackAlpha'
  | 'thornSpitter'
  | 'shade'
  | 'gravekeeper'
  | 'cinderling'
  | 'slagBrute'
  | 'drownedThrall'
  | 'lanternJelly'
  | 'tideLurker'
  | 'gravehound'
  | 'packleader'
  | 'gildedThornback'
  | 'warden'
  | 'treasureWyrm'
  | 'moltenColossus'
  | 'ossuaryKing';

/** Jungle monsters, neutral to both sides. Bounty is XP and favor for the god who kills one. */
const MONSTERS: Record<MonsterType, { name: string; health: number; power: number; speed: number; prot: number; range: number; radius: number; rate: number; xp: number; favor: number; projectile?: number }> = {
  thornback: { name: 'Thornback', health: 300, power: 14, speed: 360, prot: 10, range: 1.4, radius: 0.6, rate: 0.9, xp: 45, favor: 6 },
  thornbackAlpha: { name: 'Thornback Alpha', health: 620, power: 24, speed: 340, prot: 18, range: 1.7, radius: 0.9, rate: 0.8, xp: 110, favor: FAVOR_REWARDS.jungleCamp },
  // Temple Siege only: hangs back and spits acid, so the gods have to dive for it
  thornSpitter: { name: 'Thornspitter', health: 240, power: 20, speed: 330, prot: 8, range: 6.5, radius: 0.55, rate: 0.75, xp: 60, favor: 8, projectile: 26 },
  // Underworld Descent's deeper chambers: hurls slow soul bolts you can sidestep, and blinks away from anyone who closes in
  shade: { name: 'Shade', health: 210, power: 18, speed: 330, prot: 6, range: 8, radius: 0.5, rate: 0.6, xp: 70, favor: 9, projectile: 15 },
  // the Abyss (Underworld Descent's last depth): hangs back from the gods and mends the most hurt monster near it with its lantern
  gravekeeper: { name: 'Gravekeeper', health: 240, power: 16, speed: 290, prot: 12, range: 6, radius: 0.55, rate: 0.7, xp: 80, favor: 10, projectile: 22 },
  // the Ashen Depths' swarm: small, quick imps of cinder that burst into flame where they fall
  cinderling: { name: 'Cinderling', health: 250, power: 13, speed: 385, prot: 6, range: 1.3, radius: 0.5, rate: 1.05, xp: 40, favor: 5 },
  // the Ashen Depths' heavy: a hunched brute of cooled slag round a molten core that slams the floor
  slagBrute: { name: 'Slag Brute', health: 760, power: 26, speed: 300, prot: 24, range: 2, radius: 1.05, rate: 0.6, xp: 130, favor: 14 },
  // the Drowned Halls' many: bloated husks of the drowned that shamble in and grip whoever they strike, slowing them
  drownedThrall: { name: 'Drowned Thrall', health: 340, power: 14, speed: 300, prot: 12, range: 1.5, radius: 0.6, rate: 0.8, xp: 45, favor: 6 },
  // the Drowned Halls' shooters: jellyfish of cold soul light drifting over the floor, spitting bolts of it
  lanternJelly: { name: 'Lantern Jelly', health: 230, power: 19, speed: 320, prot: 8, range: 7, radius: 0.55, rate: 0.7, xp: 60, favor: 8, projectile: 18 },
  // the Drowned Halls' heavy: a great lure-headed fish that swims under the floor and bursts up beneath the gods
  tideLurker: { name: 'Tide Lurker', health: 700, power: 25, speed: 330, prot: 20, range: 1.9, radius: 1.0, rate: 0.7, xp: 120, favor: 13 },
  // the Abyss's many: gaunt hounds of bone and grave-hide that circle in and pounce on whoever stands off from them
  gravehound: { name: 'Gravehound', health: 290, power: 15, speed: 385, prot: 8, range: 1.4, radius: 0.6, rate: 0.95, xp: 45, favor: 6 },
  // the Abyss's heavy: the pack's antlered leader, whose howl drives the hounds near it into a frenzy
  packleader: { name: 'Packleader', health: 720, power: 25, speed: 350, prot: 18, range: 1.8, radius: 0.95, rate: 0.8, xp: 120, favor: 13 },
  // Temple Siege only: never fights, runs from the gods, and carries a second boon
  gildedThornback: { name: 'Gilded Thornback', health: 900, power: 0, speed: 345, prot: 25, range: 1.4, radius: 0.6, rate: 0.5, xp: 120, favor: 40 },
  treasureWyrm: { name: 'Treasure Wyrm', health: 5200, power: 70, speed: 280, prot: 35, range: 3.2, radius: 2.6, rate: 0.5, xp: 300, favor: 0 },
  moltenColossus: { name: 'Molten Colossus', health: 8500, power: 95, speed: 240, prot: 45, range: 3.6, radius: 3.4, rate: 0.4, xp: 400, favor: 0 },
  // Underworld Descent's last boss: a crowned giant of bones at the bottom of the Abyss
  ossuaryKing: { name: 'Ossuary King', health: 5200, power: 70, speed: 260, prot: 38, range: 3.8, radius: 2.6, rate: 0.45, xp: 500, favor: 0 },
  warden: { name: 'Warden', health: 950, power: 30, speed: 300, prot: 20, range: 2, radius: 1.25, rate: 0.55, xp: 220, favor: FAVOR_REWARDS.buffCamp },
};

/** A jungle monster; camps that grow back later in the match are tougher. */
/** A monster's name, with a title (Champion, Abyssal) when it has one. */
export function monsterName(type: MonsterType, title = ''): string {
  return title ? `${title} ${MONSTERS[type].name}` : MONSTERS[type].name;
}

export function monsterUnit(base: GodDef, type: MonsterType, at: { x: number; z: number; yaw: number }, minutes: number, title = ''): Unit {
  const m = MONSTERS[type];
  const grow = 1 + Math.min(1.2, minutes * 0.06);
  const def = variant(
    base,
    `monster:${type}`,
    monsterName(type, title),
    {
      maxHealth: Math.round(m.health * grow),
      attackPower: m.power * grow,
      attackSpeed: m.rate,
      moveSpeed: m.speed,
      physicalProtection: m.prot,
      magicalProtection: m.prot,
    },
    { range: m.range, damageType: 'physical', projectileSpeed: m.projectile },
  );
  const u = new Unit('monster', def.name, new Combatant(def, 'neutral'), body(at.x, at.z, at.yaw), m.radius, at);
  u.respawns = false;
  u.bounty = { xp: Math.round(m.xp * grow), favor: m.favor };
  u.origin = { f: 'monster', type, minutes };
  return u;
}

export type StructureKind = Extract<UnitKind, 'tower' | 'phoenix' | 'titan'>;

/** Ranges are in arena meters (the layout's), converted to engine units here. */
const STRUCTURES: Record<StructureKind, { name: string; health: number; power: number; rate: number; prot: number; projectile?: number }> = {
  tower: { name: 'Tower', health: 2600, power: 95, rate: 0.85, prot: 45, projectile: 26 },
  phoenix: { name: 'Phoenix', health: 3400, power: 115, rate: 0.85, prot: 55, projectile: 24 },
  titan: { name: 'Titan', health: 7000, power: 160, rate: 0.6, prot: 65 },
};

export function structureUnit(base: GodDef, team: Team, kind: StructureKind, at: { x: number; z: number; yaw: number }, radius: number, range: number): Unit {
  const s = STRUCTURES[kind];
  const def = variant(
    base,
    `structure:${kind}`,
    s.name,
    { maxHealth: s.health, attackPower: s.power, attackSpeed: s.rate, physicalProtection: s.prot, magicalProtection: s.prot },
    { range: range / WORLD_SCALE, damageType: 'physical', projectileSpeed: s.projectile },
  );
  const u = new Unit(kind, def.name, new Combatant(def, team), body(at.x, at.z, at.yaw), radius, at);
  u.respawns = false;
  u.origin = { f: 'structure' };
  return u;
}
