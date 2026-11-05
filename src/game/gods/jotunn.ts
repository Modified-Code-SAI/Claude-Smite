import type { GodDef, SkillTree } from '../types';
import { cc, dmg, slow } from './author';

const none = (id: string, name: string): SkillTree => ({ id, name, theme: '', nodes: [] });

/**
 * The frost giant of the Jötunn mode, about eight times a god's height. It
 * is not a playable god (it is not in GODS): one player becomes it for a
 * round. Every blow winds up first and shows the ground it will strike, so
 * the gods around its feet can step out of it. Its hide shrugs off most
 * damage and crowd control; its knees, back rune, wrists and crown are where
 * it breaks (see src/sim/Jotunn.ts). Shrines in the valley swap its
 * ultimate for a new attack.
 */
export const jotunn: GodDef = {
  id: 'jotunn',
  name: 'Jötunn',
  title: 'Frost Giant',
  pantheon: 'Norse',
  role: 'solo',
  attackRange: 'melee',
  base: {
    maxHealth: 20000,
    healthRegen: 0,
    maxMana: 100,
    manaRegen: 10,
    physicalProtection: 150,
    magicalProtection: 150,
    attackSpeed: 0.5,
    attackPower: 450,
    moveSpeed: 290,
  },
  growth: {},
  // a club sweep about nine meters across the front
  basicAttack: { range: 5.2, damageType: 'physical', windup: 0.5 },
  passive: {
    name: 'Hide of the Glacier',
    description: 'Blows to the body barely scratch you and crowd control slides off. Gods break you at your knees, back rune, wrists and crown.',
  },
  skills: [
    {
      id: 'jotunn.stomp',
      name: 'Stomp',
      kind: 'regular',
      description: 'Raise a foot and bring it down, hurling back every god around you.',
      tags: ['damage', 'cc'],
      targeting: { type: 'self', radius: 3.6 },
      cooldown: 6,
      cost: 0,
      windup: 0.6,
      effects: [dmg(400, 'strength', 0, 'physical'), cc('knockback', 0.4)],
    },
    {
      id: 'jotunn.boulder',
      name: 'Hurl Boulder',
      kind: 'regular',
      description: 'Tear up a boulder and throw it far across the valley, slowing the gods it lands on.',
      tags: ['damage', 'cc'],
      targeting: { type: 'ground', range: 18, radius: 2.4 },
      cooldown: 7,
      cost: 0,
      windup: 0.9,
      effects: [dmg(420, 'strength', 0, 'physical'), slow(0.3, 2)],
    },
    {
      id: 'jotunn.slam',
      name: 'Glacial Slam',
      kind: 'regular',
      description: 'Smash a fist into the ground in front of you, stunning the gods there. The hand stays planted a moment, wrist exposed.',
      tags: ['damage', 'cc'],
      targeting: { type: 'ground', range: 6, radius: 2.2 },
      cooldown: 9,
      cost: 0,
      windup: 0.85,
      effects: [dmg(600, 'strength', 0, 'physical'), cc('stun', 1)],
    },
    {
      id: 'jotunn.roar',
      name: 'Freezing Roar',
      kind: 'ultimate',
      description: 'Roar so loud the gods around you flee in fear, frost biting them as they go.',
      tags: ['damage', 'cc'],
      targeting: { type: 'self', radius: 7 },
      cooldown: 45,
      cost: 0,
      windup: 0.8,
      effects: [dmg(400, 'strength', 0, 'physical'), cc('fear', 1.5)],
    },
    {
      id: 'jotunn.frost-breath',
      name: 'Frost Breath',
      kind: 'ultimate',
      description: 'From the Rime Shrine. Breathe a wide cone of frost that bites four times and slows.',
      tags: ['damage', 'cc'],
      targeting: { type: 'cone', range: 10, angle: 70 },
      cooldown: 30,
      cost: 0,
      windup: 0.7,
      effects: [dmg(180, 'strength', 0, 'physical', 4, 0.5), slow(0.4, 2.5)],
    },
    {
      id: 'jotunn.avalanche',
      name: 'Avalanche',
      kind: 'ultimate',
      description: 'From the Avalanche Shrine. Bring a wall of ice crashing down a long line, throwing the gods in it into the air.',
      tags: ['damage', 'cc'],
      targeting: { type: 'line', range: 20, width: 4 },
      cooldown: 35,
      cost: 0,
      windup: 1,
      effects: [dmg(700, 'strength', 0, 'physical'), cc('knockup', 1)],
    },
    {
      id: 'jotunn.hailstorm',
      name: 'Hailstorm',
      kind: 'ultimate',
      description: 'From the Hail Shrine. Call a storm of hail onto a wide circle; it pounds and slows whoever stays.',
      tags: ['damage', 'zone', 'cc'],
      targeting: { type: 'ground', range: 16, radius: 4 },
      cooldown: 30,
      cost: 0,
      windup: 0.6,
      effects: [dmg(150, 'strength', 0, 'physical', 6, 0.5), slow(0.25, 1)],
    },
  ],
  trees: [none('jotunn.might', 'Might'), none('jotunn.frost', 'Frost'), none('jotunn.stone', 'Stone')],
  defaultLoadout: ['jotunn.stomp', 'jotunn.boulder', 'jotunn.slam', 'jotunn.roar'],
};
