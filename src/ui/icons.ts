import { hex, paletteFor } from '../combat/palette';
import type { Keystone, SkillDef, StatKey, TreeNode } from '../game/types';
import type { RelicId } from '../sim/Relics';

/**
 * Procedural skill icons: a glyph for what the skill does, drawn over a
 * radial glow in the god's spell color. Ultimates get a gold frame.
 * Everything is inline SVG, so there are no image assets to license.
 */
const GLYPHS = {
  // a comet: orb with a streak
  projectile: '<circle cx="40" cy="24" r="9"/><path d="M33 31 L12 52 M37 35 L20 54 M29 27 L10 46" stroke-width="4" stroke-linecap="round" fill="none"/>',
  // a spear
  line: '<path d="M10 54 L44 20" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M40 14 L54 10 L50 24 Z"/>',
  // a fan of blades
  cone: '<path d="M32 54 L12 16 M32 54 L32 10 M32 54 L52 16" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M14 18 A26 26 0 0 1 50 18" stroke-width="3" fill="none"/>',
  // a target circle with a strike
  ground: '<ellipse cx="32" cy="44" rx="20" ry="8" stroke-width="4" fill="none"/><path d="M36 6 L26 26 L34 26 L28 44 L42 20 L34 20 L40 6 Z"/>',
  // a nova
  nova: '<circle cx="32" cy="32" r="8"/><path d="M32 8 V18 M32 46 V56 M8 32 H18 M46 32 H56 M15 15 L22 22 M42 42 L49 49 M49 15 L42 22 M22 42 L15 49" stroke-width="4" stroke-linecap="round" fill="none"/>',
  // twin chevrons
  dash: '<path d="M12 16 L28 32 L12 48 M30 16 L46 32 L30 48" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M48 22 L56 32 L48 42" stroke-width="3" fill="none"/>',
  // an arcing leap
  leap: '<path d="M8 50 Q32 2 54 46" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M46 44 L56 50 L58 38 Z"/><ellipse cx="54" cy="52" rx="8" ry="3"/>',
  // an ankh
  ally: '<ellipse cx="32" cy="18" rx="8" ry="10" stroke-width="5" fill="none"/><path d="M32 28 V56 M18 32 H46" stroke-width="5" stroke-linecap="round" fill="none"/>',
  shield: '<path d="M32 8 L52 16 V30 C52 44 42 52 32 56 C22 52 12 44 12 30 V16 Z" stroke-width="4" fill="none"/><path d="M32 18 V46 M22 28 H42" stroke-width="3" fill="none"/>',
  heal: '<path d="M26 12 H38 V26 H52 V38 H38 V52 H26 V38 H12 V26 H26 Z"/>',
  buff: '<path d="M32 8 L50 30 H38 V56 H26 V30 H14 Z"/>',
  stealth: '<path d="M8 32 Q32 8 56 32 Q32 56 8 32 Z" stroke-width="4" fill="none"/><circle cx="32" cy="32" r="7"/><path d="M12 52 L52 12" stroke-width="4" stroke-linecap="round"/>',
  summon: '<circle cx="22" cy="20" r="7"/><circle cx="42" cy="20" r="7"/><path d="M10 50 C10 34 34 34 34 50 M30 50 C30 34 54 34 54 50" stroke-width="4" fill="none"/>',
  // themed glyphs, picked by the skill's name
  bolt: '<path d="M38 4 L16 34 H30 L22 60 L48 26 H34 L44 4 Z"/>',
  cyclone: '<path d="M10 14 H54 M14 24 H48 M20 34 H44 M24 44 H38 M28 54 H34" stroke-width="5" stroke-linecap="round" fill="none"/>',
  cloud: '<path d="M16 46 A10 10 0 0 1 16 26 A13 13 0 0 1 40 20 A11 11 0 0 1 50 46 Z"/><path d="M18 54 H46" stroke-width="3" stroke-linecap="round"/>',
  hammer: '<rect x="12" y="8" width="40" height="18" rx="3"/><path d="M32 26 V58" stroke-width="7" stroke-linecap="round"/><path d="M26 58 H38" stroke-width="4" stroke-linecap="round"/>',
  spin: '<path d="M32 12 A20 20 0 1 1 13 26" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M8 18 L14 30 L22 20 Z"/><circle cx="32" cy="32" r="6"/>',
  raven: '<path d="M6 30 Q20 14 32 26 Q44 14 58 30 Q46 26 38 32 L44 44 L32 38 L20 44 L26 32 Q18 26 6 30 Z"/><circle cx="32" cy="24" r="4"/>',
  eye: '<path d="M6 32 Q32 8 58 32 Q32 56 6 32 Z" stroke-width="4" fill="none"/><circle cx="32" cy="32" r="9"/><path d="M32 6 V14 M32 50 V58" stroke-width="3" stroke-linecap="round"/>',
  rune: '<path d="M22 8 V56 M22 12 L42 26 L22 38 M22 38 L44 54" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  dagger: '<path d="M32 4 L38 34 H26 Z"/><path d="M18 36 H46" stroke-width="5" stroke-linecap="round"/><path d="M32 38 V54" stroke-width="6" stroke-linecap="round"/><circle cx="32" cy="58" r="3.5"/>',
  smoke: '<circle cx="22" cy="38" r="12"/><circle cx="38" cy="30" r="14"/><circle cx="44" cy="46" r="9"/><circle cx="18" cy="20" r="5" opacity="0.7"/>',
  mask: '<path d="M10 16 Q32 8 54 16 Q54 44 32 56 Q10 44 10 16 Z" stroke-width="4" fill="none"/><path d="M18 28 Q24 22 28 30 Z M46 28 Q40 22 36 30 Z"/><path d="M24 44 Q32 38 40 44" stroke-width="3" fill="none"/>',
  rift: '<path d="M30 4 L24 18 L34 26 L22 40 L30 46 L26 60 M30 46 L40 52 M34 26 L44 22" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  swarm: '<ellipse cx="18" cy="20" rx="6" ry="4"/><ellipse cx="40" cy="14" rx="6" ry="4"/><ellipse cx="30" cy="32" rx="7" ry="5"/><ellipse cx="48" cy="34" rx="5" ry="3.5"/><ellipse cx="16" cy="44" rx="6" ry="4"/><ellipse cx="38" cy="50" rx="6" ry="4"/><path d="M12 16 L8 12 M46 10 L50 6 M24 28 L20 24" stroke-width="2"/>',
  wrap: '<path d="M18 10 Q32 4 46 10 V54 Q32 60 18 54 Z" stroke-width="3" fill="none"/><path d="M16 18 L48 26 M16 30 L48 22 M16 34 L48 42 M16 46 L48 38" stroke-width="4" stroke-linecap="round"/>',
  hand: '<path d="M18 58 V30 Q18 26 22 26 Q26 26 26 30 V14 Q26 10 30 10 Q34 10 34 14 V28 V12 Q34 8 38 8 Q42 8 42 12 V30 V18 Q42 14 46 14 Q50 14 50 18 V40 Q50 52 40 58 Z"/>',
  horn: '<path d="M10 42 Q14 18 40 14 L46 20 Q24 26 20 46 Z"/><path d="M50 26 Q56 32 50 40 M54 20 Q64 32 54 46" stroke-width="3" stroke-linecap="round" fill="none"/>',
  scales: '<path d="M32 8 V54 M14 54 H50 M12 20 H52" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M6 36 L12 20 L18 36 Z M46 36 L52 20 L58 36 Z" stroke-width="2"/><path d="M4 36 Q12 44 20 36 Z M44 36 Q52 44 60 36 Z"/>',
  wings: '<path d="M32 30 Q18 8 4 14 Q10 22 8 28 Q16 30 14 38 Q24 36 32 44 Q40 36 50 38 Q48 30 56 28 Q54 22 60 14 Q46 8 32 30 Z"/><circle cx="32" cy="52" r="5"/>',
  orb: '<circle cx="32" cy="32" r="13"/><path d="M32 6 L28 14 L34 16 M56 30 L48 28 L48 34 M10 38 L18 36 L16 30 M40 56 L36 48 L42 46" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  stormcloud: '<path d="M14 34 A9 9 0 0 1 14 18 A12 12 0 0 1 36 12 A10 10 0 0 1 48 34 Z"/><path d="M34 34 L26 46 H34 L28 60 L42 42 H34 L40 34 Z"/>',
  chain: '<rect x="6" y="24" width="20" height="14" rx="7" stroke-width="4" fill="none" transform="rotate(-25 16 31)"/><rect x="22" y="24" width="20" height="14" rx="7" stroke-width="4" fill="none" transform="rotate(-25 32 31)"/><rect x="38" y="24" width="20" height="14" rx="7" stroke-width="4" fill="none" transform="rotate(-25 48 31)"/>',
  crown: '<path d="M10 44 L8 18 L22 30 L32 12 L42 30 L56 18 L54 44 Z"/><path d="M10 52 H54" stroke-width="5" stroke-linecap="round"/>',
  slam: '<rect x="18" y="6" width="28" height="14" rx="3"/><path d="M32 20 V40" stroke-width="6" stroke-linecap="round"/><path d="M8 54 H56 M12 44 L4 38 M52 44 L60 38 M20 48 L16 40 M44 48 L48 40" stroke-width="4" stroke-linecap="round"/>',
  skull: '<path d="M32 6 C16 6 10 18 10 28 C10 36 16 40 18 42 V52 H46 V42 C48 40 54 36 54 28 C54 18 48 6 32 6 Z"/><circle cx="23" cy="28" r="6" fill="#07060a" stroke="none"/><circle cx="41" cy="28" r="6" fill="#07060a" stroke="none"/><path d="M26 52 V58 M32 52 V58 M38 52 V58" stroke-width="3"/>',
  poison: '<path d="M26 4 L32 30 H20 Z"/><path d="M14 32 H38" stroke-width="5" stroke-linecap="round"/><path d="M26 34 V46" stroke-width="5" stroke-linecap="round"/><path d="M46 30 C46 30 38 42 38 48 A8 8 0 0 0 54 48 C54 42 46 30 46 30 Z"/>',
  anvil: '<path d="M8 18 H48 Q58 18 58 26 H44 L40 34 H24 L20 26 H8 Z"/><path d="M22 34 H42 L46 52 H18 Z"/>',
  // a crackling ring around a small bolt
  presence: '<path d="M32 5 L40 14 L51 13 L50 24 L59 32 L50 40 L51 51 L40 50 L32 59 L24 50 L13 51 L14 40 L5 32 L14 24 L13 13 L24 14 Z" stroke-width="3.5" stroke-linejoin="round" fill="none"/><path d="M35 20 L26 34 H32 L28 44 L38 30 H32 Z"/>',
  // a bolt bursting outward into sparks
  discharge: '<path d="M36 14 L24 34 H32 L27 50 L41 28 H33 Z"/><path d="M12 12 L19 19 M52 12 L45 19 M12 52 L19 45 M52 52 L45 45 M6 32 H14 M50 32 H58" stroke-width="4" stroke-linecap="round" fill="none"/>',
  // a winged helm
  helm: '<path d="M18 46 V32 Q18 16 32 16 Q46 16 46 32 V46 H38 V36 H26 V46 Z"/><path d="M18 30 Q8 24 4 10 Q12 16 18 20 M46 30 Q56 24 60 10 Q52 16 46 20" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M14 52 H50" stroke-width="4" stroke-linecap="round"/>',
  // a fox's head
  fox: '<path d="M8 8 L24 24 H40 L56 8 L52 34 L32 56 L12 34 Z"/><circle cx="24" cy="34" r="3" fill="#07060a" stroke="none"/><circle cx="40" cy="34" r="3" fill="#07060a" stroke="none"/>',
  // afterimages stepping into a strike
  blink: '<circle cx="12" cy="40" r="5" opacity="0.4"/><circle cx="24" cy="34" r="6" opacity="0.7"/><path d="M34 46 L56 12" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M50 8 L60 6 L58 16 Z"/>',
  // a canopic jar
  jar: '<path d="M22 22 H42 Q50 32 46 50 Q44 56 32 56 Q20 56 18 50 Q14 32 22 22 Z"/><path d="M24 20 Q24 8 32 8 Q40 8 40 20 Z"/><path d="M22 34 H42" stroke="#07060a" stroke-width="3"/>',
  // talent glyphs for stat nodes
  sword: '<path d="M44 6 H58 V20 L26 46 L18 38 Z"/><path d="M12 36 L28 52" stroke-width="5" stroke-linecap="round"/><path d="M18 46 L8 56" stroke-width="6" stroke-linecap="round"/>',
  star: '<path d="M32 4 L38 24 H58 L42 36 L48 56 L32 44 L16 56 L22 36 L6 24 H26 Z"/>',
  heart: '<path d="M32 56 C10 40 6 28 10 18 C14 8 28 8 32 20 C36 8 50 8 54 18 C58 28 54 40 32 56 Z"/>',
  drop: '<path d="M32 6 C32 6 14 30 14 40 A18 18 0 0 0 50 40 C50 30 32 6 32 6 Z"/>',
  target: '<circle cx="32" cy="32" r="21" stroke-width="4" fill="none"/><circle cx="32" cy="32" r="11" stroke-width="4" fill="none"/><circle cx="32" cy="32" r="4"/><path d="M32 2 V14 M32 50 V62 M2 32 H14 M50 32 H62" stroke-width="3"/>',
  hourglass: '<path d="M16 6 H48 M16 58 H48" stroke-width="5" stroke-linecap="round"/><path d="M20 8 H44 L34 32 L44 56 H20 L30 32 Z" stroke-width="3" fill="none"/><path d="M24 54 H40 L32 42 Z M26 14 H38 L32 24 Z"/>',
  // keystone glyphs
  stack: '<path d="M12 50 L32 36 L52 50 M12 36 L32 22 L52 36 M12 22 L32 8 L52 22" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  reset: '<path d="M50 30 A18 18 0 1 1 40 15" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M36 6 L48 14 L36 22 Z"/><path d="M32 22 C25 22 22 27 22 31 C22 35 25 37 26 38 V43 H38 V38 C39 37 42 35 42 31 C42 27 39 22 32 22 Z"/>',
  conduit: '<path d="M40 8 H52 V20 L28 42 L22 36 Z"/><path d="M16 34 L30 48" stroke-width="4" stroke-linecap="round"/><path d="M20 44 L10 54" stroke-width="5" stroke-linecap="round"/><path d="M50 34 A14 14 0 0 1 36 54" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M32 50 L38 58 L42 50 Z"/>',
  rage: '<path d="M32 54 C12 40 8 28 12 19 C16 10 28 10 32 21 C36 10 48 10 52 19 C56 28 52 40 32 54 Z"/><path d="M28 18 L36 30 L28 30 L36 44" stroke="#07060a" stroke-width="3.5" fill="none" stroke-linejoin="round"/>',
  surge: '<circle cx="32" cy="32" r="11"/><path d="M32 4 V14 M32 50 V60 M4 32 H14 M50 32 H60" stroke-width="4" stroke-linecap="round"/><path d="M28 10 L32 4 L36 10 M28 54 L32 60 L36 54 M10 28 L4 32 L10 36 M54 28 L60 32 L54 36" stroke-width="3" fill="none"/>',
  aura: '<circle cx="32" cy="32" r="24" stroke-width="3" fill="none" stroke-dasharray="6 4"/><path d="M32 16 L44 21 V30 C44 38 38 43 32 46 C26 43 20 38 20 30 V21 Z"/>',
} as const;

/** Themed glyphs by skill name, first match wins; the rest fall back to their targeting shape. */
const BY_NAME: readonly [RegExp, Glyph][] = [
  [/Worldbreaker|Rift/, 'rift'],
  [/Anvil/, 'anvil'],
  [/Mjolnir|Slam/, 'slam'],
  [/Hammer/, 'hammer'],
  [/Spin/, 'spin'],
  [/Sandstorm|Cyclone/, 'cyclone'],
  [/Skyfall/, 'stormcloud'],
  [/Aegis|Cloud/, 'cloud'],
  [/Ball Lightning/, 'orb'],
  [/Chain/, 'chain'],
  [/Thunder God/, 'crown'],
  [/Judgment/, 'skull'],
  [/Scales/, 'scales'],
  [/Poison/, 'poison'],
  [/Arc Bolt/, 'bolt'],
  [/Raven/, 'raven'],
  [/Eye|Gaze/, 'eye'],
  [/Rune/, 'rune'],
  [/Assassinate/, 'dagger'],
  [/Smoke/, 'smoke'],
  [/Decoy/, 'mask'],
  [/Locust/, 'swarm'],
  [/Mummify/, 'wrap'],
  [/Grasp/, 'hand'],
  [/Howl|War Cry|Call of Asgard/, 'horn'],
  [/Ascension/, 'wings'],
  [/Thundering Presence/, 'presence'],
  [/Static Discharge/, 'discharge'],
  [/Valhalla/, 'helm'],
  [/Shapeshift/, 'fox'],
  [/Blink/, 'blink'],
  [/Mark$/, 'target'],
  [/Embalm/, 'jar'],
];

type Glyph = keyof typeof GLYPHS;

export function glyphFor(skill: SkillDef): Glyph {
  for (const [re, g] of BY_NAME) if (re.test(skill.name)) return g;
  const effects = skill.effects.map((e) => e.kind);
  if (effects.includes('summon')) return 'summon';
  if (effects.includes('stealth') && skill.targeting.type === 'self') return 'stealth';
  switch (skill.targeting.type) {
    case 'projectile':
      return 'projectile';
    case 'line':
      return 'line';
    case 'cone':
      return 'cone';
    case 'ground':
      return 'ground';
    case 'dash':
      return 'dash';
    case 'leap':
      return 'leap';
    case 'ally':
      return 'ally';
    case 'self':
      if (skill.targeting.radius !== undefined && effects.includes('damage')) return 'nova';
      if (effects.includes('shield')) return 'shield';
      if (effects.includes('heal')) return 'heal';
      return 'buff';
  }
}

// ---------------------------------------------------------------------------
// Scenes: each icon shows what the skill does. The caster (a light figure),
// the enemies it hits (dark red figures) or the allies it helps (green), the
// shape it covers, and the themed glyph as the thing that flies or lands.
// A badge in the corner names the crowd control it applies.

const FOE = 'fill="#3a0c0c" stroke="#ff7a62" stroke-width="1.6"';
const ALLY = 'fill="#123a16" stroke="#8dff8a" stroke-width="1.6"';

function figure(x: number, y: number, s: number, paint: string, opacity = 1): string {
  return `<g transform="translate(${x} ${y}) scale(${s})" opacity="${opacity}" ${paint}><circle cy="-10" r="4.6"/><path d="M-8 5 Q-8 -4 0 -4 Q8 -4 8 5 Z"/></g>`;
}
const foe = (x: number, y: number, s = 0.8) => figure(x, y, s, FOE);
const ally = (x: number, y: number, s = 0.8) => figure(x, y, s, ALLY);

/** A glyph drawn at (x, y), scaled from its 64-unit box. */
function glyphAt(g: Glyph, x: number, y: number, s: number, extra = ''): string {
  return `<g transform="translate(${x} ${y}) scale(${s}) translate(-32 -32)" ${extra}>${GLYPHS[g]}</g>`;
}

type Shape = 'projectile' | 'bounce' | 'pierce' | 'line' | 'cone' | 'ground' | 'zone' | 'nova' | 'buff' | 'dash' | 'blink' | 'leap' | 'ally' | 'summon' | 'stealth' | 'mark';

function shapeOf(skill: SkillDef): Shape {
  const t = skill.targeting;
  const kinds = skill.effects.map((e) => e.kind);
  const movement = skill.effects.find((e) => e.kind === 'movement');
  if (skill.detonates) return 'mark';
  if (kinds.includes('summon')) return 'summon';
  if (movement?.kind === 'movement' && movement.style === 'blink') return 'blink';
  switch (t.type) {
    case 'projectile':
      return t.bounces !== undefined ? 'bounce' : t.pierce ? 'pierce' : 'projectile';
    case 'line':
      return 'line';
    case 'cone':
      return 'cone';
    case 'ground':
      return skill.effects.some((e) => e.kind === 'damage' && (e.hits ?? 1) > 1) ? 'zone' : 'ground';
    case 'dash':
      return 'dash';
    case 'leap':
      return 'leap';
    case 'ally':
      return 'ally';
    case 'self':
      if (kinds.includes('stealth')) return 'stealth';
      if (t.radius !== undefined && kinds.includes('damage')) return 'nova';
      if (t.radius !== undefined && skill.effects.some((e) => 'target' in e && e.target === 'alliesAndSelf')) return 'ally';
      return 'buff';
  }
}

function scene(shape: Shape, g: Glyph, core: string): string {
  const me = (x: number, y: number, s = 0.85, o = 1) => figure(x, y, s, `fill="${core}" stroke="#ffffff" stroke-width="1"`, o);
  const glow = `fill="${core}" stroke="${core}"`;
  switch (shape) {
    case 'projectile':
      return `${me(12, 56)}<path d="M18 46 L40 24" stroke="${core}" stroke-width="3" stroke-dasharray="3 4" opacity="0.7"/>${foe(52, 26)}${glyphAt(g, 36, 28, 0.56, glow)}`;
    case 'bounce':
      return `${me(10, 58, 0.7)}${foe(30, 30, 0.7)}${foe(52, 22, 0.7)}${foe(48, 52, 0.7)}<path d="M14 46 L28 24 L50 16 L46 46" stroke="${core}" stroke-width="2.6" fill="none" stroke-linejoin="round"/>${glyphAt(g, 22, 36, 0.42, glow)}`;
    case 'pierce':
      return `${me(10, 58, 0.7)}${foe(30, 38, 0.7)}${foe(50, 22, 0.7)}<path d="M14 50 L58 10" stroke="${core}" stroke-width="5" opacity="0.35"/>${glyphAt(g, 40, 28, 0.5, glow)}`;
    case 'line':
      return `${me(10, 58, 0.7)}<path d="M14 50 L60 8" stroke="${core}" stroke-width="9" stroke-linecap="round" opacity="0.28"/><path d="M14 50 L60 8" stroke="${core}" stroke-width="2.5"/>${foe(32, 38, 0.7)}${foe(50, 22, 0.7)}${glyphAt(g, 46, 16, 0.42, glow)}`;
    case 'cone':
      return `<path d="M32 58 L6 14 Q32 2 58 14 Z" fill="${core}" opacity="0.2"/><path d="M32 58 L6 14 M32 58 L58 14" stroke="${core}" stroke-width="1.6" opacity="0.7"/>${foe(20, 26, 0.65)}${foe(42, 22, 0.65)}${me(32, 62, 0.75)}${glyphAt(g, 32, 36, 0.42, glow)}`;
    case 'ground':
      return `<ellipse cx="32" cy="48" rx="24" ry="9" fill="${core}" opacity="0.22" stroke="${core}" stroke-width="2"/>${foe(22, 50, 0.7)}${foe(42, 50, 0.7)}${glyphAt(g, 32, 22, 0.62, glow)}`;
    case 'zone':
      return `<ellipse cx="32" cy="46" rx="26" ry="11" fill="${core}" opacity="0.18" stroke="${core}" stroke-width="2" stroke-dasharray="4 3"/><ellipse cx="32" cy="46" rx="14" ry="5.5" fill="none" stroke="${core}" stroke-width="1.5" opacity="0.6"/>${foe(18, 48, 0.62)}${foe(44, 50, 0.62)}${glyphAt(g, 32, 22, 0.62, glow)}`;
    case 'nova':
      return `<circle cx="32" cy="38" r="22" fill="${core}" opacity="0.12" stroke="${core}" stroke-width="2.4"/>${foe(10, 32, 0.6)}${foe(54, 32, 0.6)}${foe(32, 62, 0.6)}${me(32, 42)}${glyphAt(g, 32, 16, 0.42, glow)}`;
    case 'buff':
      return `${glyphAt(g, 32, 28, 0.62, `${glow} opacity="0.75"`)}<path d="M12 44 L16 38 L20 44 M44 44 L48 38 L52 44" stroke="${core}" stroke-width="2.5" fill="none"/>${me(32, 60, 0.95)}`;
    case 'dash':
      return `${me(12, 46, 0.8, 0.25)}${me(24, 44, 0.8, 0.5)}<path d="M4 36 H30 M8 46 H30 M4 56 H28" stroke="${core}" stroke-width="2" opacity="0.6"/>${foe(54, 46, 0.7)}${me(38, 42)}${glyphAt(g, 46, 18, 0.4, glow)}`;
    case 'blink':
      return `${me(12, 56, 0.8, 0.3)}<path d="M18 50 L40 26" stroke="${core}" stroke-width="2" stroke-dasharray="2 4"/>${foe(30, 30, 0.75)}${me(46, 24, 0.8)}${glyphAt(g, 48, 48, 0.4, glow)}`;
    case 'leap':
      return `<path d="M8 56 Q24 2 46 44" stroke="${core}" stroke-width="2.5" fill="none" stroke-dasharray="4 3"/><ellipse cx="46" cy="50" rx="14" ry="5" fill="${core}" opacity="0.3"/>${foe(38, 52, 0.55)}${foe(56, 52, 0.55)}${me(24, 22, 0.75)}${glyphAt(g, 46, 36, 0.38, glow)}`;
    case 'ally':
      return `<circle cx="42" cy="38" r="16" fill="${core}" opacity="0.18"/>${me(16, 56, 0.7)}${ally(42, 50, 0.95)}${glyphAt(g, 42, 20, 0.44, glow)}`;
    case 'summon':
      return `${figure(18, 52, 0.85, `fill="${core}" stroke="${core}" stroke-width="1"`, 0.6)}${figure(34, 54, 0.85, `fill="${core}" stroke="${core}" stroke-width="1"`, 0.6)}${foe(54, 46, 0.7)}${glyphAt(g, 26, 22, 0.46, glow)}`;
    case 'stealth':
      return `${glyphAt(g, 32, 24, 0.55, `${glow} opacity="0.5"`)}${me(32, 58, 0.95, 0.35)}<path d="M18 50 Q32 44 46 50" stroke="${core}" stroke-width="2" fill="none" stroke-dasharray="2 3"/>`;
    case 'mark':
      return `<circle cx="32" cy="36" r="24" fill="none" stroke="${core}" stroke-width="2" stroke-dasharray="5 4" opacity="0.6"/>${foe(16, 46, 0.65)}${foe(48, 46, 0.65)}${[16, 48].map((x) => `<path d="M${x - 6} 26 h4 M${x - 1} 26 h4 M${x + 4} 26 h4" stroke="${core}" stroke-width="3"/>`).join('')}${glyphAt(g, 32, 24, 0.52, glow)}`;
  }
}

/** Small symbols for the crowd control a skill applies, drawn in a badge. */
const CC_BADGES: Partial<Record<string, string>> = {
  stun: '<path d="M0 -5 L1.3 -1.6 L5 -1.5 L2 0.8 L3.1 4.5 L0 2.3 L-3.1 4.5 L-2 0.8 L-5 -1.5 L-1.3 -1.6 Z"/>',
  root: '<ellipse cx="-2.2" cy="0" rx="3.2" ry="2.2" fill="none" stroke-width="1.6"/><ellipse cx="2.2" cy="0" rx="3.2" ry="2.2" fill="none" stroke-width="1.6"/>',
  slow: '<path d="M-4 -4 L0 0 L4 -4 M-4 1 L0 5 L4 1" fill="none" stroke-width="2"/>',
  knockup: '<path d="M0 -5 L5 1 H2 V5 H-2 V1 H-5 Z"/>',
  knockback: '<path d="M5 0 L-1 -5 V-2 H-5 V2 H-1 V5 Z"/>',
  pull: '<path d="M-5 0 L1 -5 V-2 H5 V2 H1 V5 Z"/>',
  silence: '<path d="M-4 -1 Q0 -4 4 -1 M-5 -5 L5 5" fill="none" stroke-width="1.8"/>',
  fear: '<path d="M0 -5 C-4 -5 -5 -2 -5 0 C-5 2 -3 3 -3 3 V5 H3 V3 C3 3 5 2 5 0 C5 -2 4 -5 0 -5 Z"/>',
  blind: '<path d="M-5 0 Q0 -4 5 0 Q0 4 -5 0 Z M-5 -5 L5 5" fill="none" stroke-width="1.6"/>',
  taunt: '<path d="M-1.2 -5 H1.2 L0.8 1.5 H-0.8 Z"/><circle cy="3.8" r="1.2"/>',
  intoxicate: '<path d="M-4 -3 Q0 -6 4 -3 Q0 0 -4 3 Q0 6 4 3" fill="none" stroke-width="1.8"/>',
  cripple: '<path d="M-5 3 H5 M-3 3 L1 -4 M1 -4 L4 -1" fill="none" stroke-width="1.8"/>',
  disarm: '<path d="M-4 4 L4 -4 M-4 -4 L4 4" fill="none" stroke-width="2"/>',
  mesmerize: '<circle r="4" fill="none" stroke-width="1.6"/><circle r="1.5"/>',
};

function badge(symbol: string, x = 54, y = 54): string {
  return `<g transform="translate(${x} ${y})"><circle r="8.5" fill="#0a0806" stroke="#ffe3a3" stroke-width="1.4"/><g fill="#ffe3a3" stroke="#ffe3a3">${symbol}</g></g>`;
}

/** The strongest crowd control a list of effects applies, if any. */
function ccOf(effects: readonly SkillDef['effects'][number][]): string | null {
  const order = ['knockup', 'stun', 'fear', 'taunt', 'mesmerize', 'pull', 'knockback', 'root', 'silence', 'blind', 'disarm', 'intoxicate', 'cripple', 'slow'];
  const ccs = effects.flatMap((e) => (e.kind === 'cc' ? [e.cc as string] : []));
  return order.find((c) => ccs.includes(c)) ?? null;
}

// ---------------------------------------------------------------------------
// The Jötunn's blows. It towers over the gods, so its icons show the blow
// itself (a foot, a fist, its roaring head, a boulder) with the gods tiny
// around it.

const ICE = '#9eeaff';
const HIDE = 'stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round"';

/** A six-armed snowflake. */
function flake(x: number, y: number, r: number, o = 1): string {
  const a = r * 0.87;
  const b = r / 2;
  return `<path transform="translate(${x} ${y})" d="M0 ${-r} V${r} M${-a} ${-b} L${a} ${b} M${-a} ${b} L${a} ${-b}" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" fill="none" opacity="${o}"/>`;
}

/** A god thrown through the air, tilted. */
function flung(x: number, y: number, tilt: number, s = 0.55): string {
  return `<g transform="rotate(${tilt} ${x} ${y})">${foe(x, y, s)}</g>`;
}

/** An ice shard standing up from (x, y). */
function shard(x: number, y: number, w: number, h: number): string {
  return `<path d="M${x - w} ${y} L${x - w * 0.2} ${y - h} L${x + w} ${y} Z" fill="${ICE}" ${HIDE}/>`;
}

const GIANT_SCENES: Record<string, (core: string) => string> = {
  // a foot comes down, the ground rings and the gods fly off
  stomp: (c) =>
    `<ellipse cx="30" cy="54" rx="28" ry="8" fill="${c}" opacity="0.16" stroke="${c}" stroke-width="2"/>` +
    `<ellipse cx="30" cy="54" rx="17" ry="4.6" fill="none" stroke="${c}" stroke-width="1.4" opacity="0.7"/>` +
    `<path d="M18 50 Q8 42 8 32 M44 50 Q54 44 54 36" stroke="${c}" stroke-width="1.8" fill="none" stroke-dasharray="3 3" opacity="0.8"/>` +
    `<path d="M24 0 H40 V36 Q41 50 34 52 H14 Q8 52 8 46.5 Q8 41 16 40 L24 37 Z" fill="${c}" ${HIDE}/>` +
    `<path d="M24 30 H40" stroke="${ICE}" stroke-width="3"/><path d="M13 46 H17 M19.5 47 H23.5" stroke="#4fa8c8" stroke-width="1.5"/>` +
    `<path d="M17 4 V14 M47 4 V16 M52 12 V22" stroke="${c}" stroke-width="2.2" stroke-linecap="round" opacity="0.7"/>` +
    flung(8, 24, -35) +
    flung(55, 28, 35),
  // a boulder on a high arc, landing among the gods
  boulder: (c) =>
    `<path d="M4 58 Q18 2 50 44" stroke="${c}" stroke-width="2.4" fill="none" stroke-dasharray="4 3" opacity="0.8"/>` +
    `<ellipse cx="45" cy="48" rx="15" ry="5.5" fill="${c}" opacity="0.22" stroke="${c}" stroke-width="2"/>` +
    foe(38, 50, 0.6) +
    foe(52, 47, 0.6) +
    `<path d="M6 30 L13 26 M4 21 L11 19 M9 39 L15 34" stroke="${c}" stroke-width="2" stroke-linecap="round" opacity="0.6"/>` +
    `<path d="M14 19 L22 9 L34 7 L41 15 L39 28 L28 34 L17 30 Z" fill="#8797a8" ${HIDE}/>` +
    `<path d="M22 9 L34 7 L41 15 L33 13.5 L27 17 L19 13 Z" fill="${ICE}"/>` +
    `<path d="M23 20 L29 24 L27 30 M33 18 L37 23" stroke="#3d4a58" stroke-width="1.4" fill="none" stroke-linecap="round"/>`,
  // a fist driven into the ground, ice bursting up around it
  slam: (c) =>
    `<ellipse cx="32" cy="47" rx="29" ry="9" fill="${c}" opacity="0.15" stroke="${c}" stroke-width="2"/>` +
    `<path d="M32 46 L17 52 L7 50 M32 46 L45 55 M32 46 L52 42 L61 44 M32 46 L12 41" stroke="${ICE}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    shard(11, 44, 3.5, 11) +
    shard(52, 42, 3.5, 13) +
    shard(21, 51, 2.6, 7) +
    `<path d="M25 0 H39 V12 H25 Z" fill="${c}" ${HIDE}/>` +
    `<path d="M18 15 Q18 10 23 10 H41 Q46 10 46 15 V31 H18 Z" fill="${c}" ${HIDE}/>` +
    [18, 25, 32, 39].map((x) => `<rect x="${x}" y="27" width="7" height="16" rx="3.5" fill="${c}" ${HIDE}/>`).join('') +
    `<path d="M19 19 Q12 19 12 25.5 Q12 32 19 32 H26" fill="${c}" ${HIDE}/>` +
    `<path d="M12 34 L6 30 M52 34 L58 29 M16 26 L11 20 M48 26 L53 20" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>` +
    foe(10, 59, 0.5) +
    foe(34, 60, 0.5),
  // its roaring head, the sound rolling out and the gods running from it
  roar: (c) =>
    `<path d="M14 12 Q7 22 14 32 M8 6 Q-1 22 8 38 M50 12 Q57 22 50 32 M56 6 Q65 22 56 38" stroke="${c}" stroke-width="2.6" fill="none" stroke-linecap="round"/>` +
    `<path d="M21 16 Q21 5 32 5 Q43 5 43 16 V25 Q43 31 38 33 H26 Q21 31 21 25 Z" fill="${c}" ${HIDE}/>` +
    `<path d="M22 27 Q24 41 32 45 Q40 41 42 27 Q38 34 32 34 Q26 34 22 27 Z" fill="${ICE}" ${HIDE}/>` +
    `<ellipse cx="32" cy="26" rx="5" ry="5.5" fill="#07060a"/>` +
    `<path d="M24 14 L30 17 M40 14 L34 17" stroke="#07060a" stroke-width="2.2" stroke-linecap="round"/>` +
    `<circle cx="27.5" cy="19" r="1.6" fill="#4fcfff"/><circle cx="36.5" cy="19" r="1.6" fill="#4fcfff"/>` +
    foe(9, 55, 0.55) +
    foe(25, 58, 0.55) +
    foe(44, 48, 0.5) +
    `<path d="M14 50 H20 M14 56 H19 M30 53 H36 M30 59 H35" stroke="${c}" stroke-width="1.8" stroke-linecap="round" opacity="0.7"/>`,
  // a cone of frost breathed across the gods
  'frost-breath': (c) =>
    `<path d="M22 25 L62 5 Q68 28 62 50 Z" fill="${c}" opacity="0.24"/>` +
    `<path d="M22 25 L62 5 M22 25 L62 50" stroke="${c}" stroke-width="1.4" opacity="0.7"/>` +
    `<path d="M26 25 Q37 18 47 22 Q55 26 61 20 M26 27 Q39 33 49 31 Q56 30 61 37" stroke="#ffffff" stroke-width="1.6" fill="none" opacity="0.7"/>` +
    foe(41, 33, 0.55) +
    foe(55, 24, 0.55) +
    flake(37, 17, 3) +
    flake(50, 39, 3.2) +
    flake(31, 31, 2.2, 0.8) +
    flake(57, 11, 2.2, 0.8) +
    `<path d="M2 26 Q1 8 12 5 Q20 4 21 11 L20.5 14 L24.5 19.5 L21 21 L23.5 23 L18.5 25 L23.5 28.5 Q21 35 13 37 Q3 37 2 26 Z" fill="${c}" ${HIDE}/>` +
    `<path d="M5 32 Q7 46 13 51 Q16 43 21 31 Q17 36 12 36.5 Q8 36.5 5 32 Z" fill="${ICE}" ${HIDE}/>` +
    `<path d="M11 11.5 L20 13" stroke="#07060a" stroke-width="2.2" stroke-linecap="round"/><circle cx="15.5" cy="15.5" r="1.5" fill="#4fcfff"/>` +
    `<path d="M3 7 L1 0 L7 4 M9 4 L9 -2 L13 3" fill="${ICE}" ${HIDE}/>`,
  // a wall of ice tearing down a long line, tossing the gods up
  avalanche: (c) =>
    `<path d="M6 58 L60 8" stroke="${c}" stroke-width="12" stroke-linecap="round" opacity="0.2"/>` +
    shard(15.7, 49, 4, 8) +
    shard(25.4, 40, 4.5, 12) +
    shard(35.2, 31, 5, 15) +
    shard(44.9, 22, 5, 17) +
    shard(54.6, 13, 4.5, 12) +
    flung(16, 25, -20) +
    flung(38, 50, 25) +
    `<path d="M20 38 V33 M17 35 L20 32 L23 35 M42 63 V58 M39 60 L42 57 L45 60" stroke="${c}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  // a storm cloud pounding a wide circle with hail
  hailstorm: (c) =>
    `<ellipse cx="32" cy="49" rx="27" ry="10" fill="${c}" opacity="0.16" stroke="${c}" stroke-width="2" stroke-dasharray="4 3"/>` +
    foe(19, 54, 0.55) +
    foe(41, 56, 0.55) +
    [[15, 31], [27, 38], [39, 29], [50, 39], [22, 47], [34, 49], [47, 25]].map(([x, y]) => `<path d="M${x! + 1.5} ${y! - 7} L${x} ${y}" stroke="${c}" stroke-width="1.4" opacity="0.6"/><circle cx="${x}" cy="${y}" r="2.3" fill="${ICE}" stroke="#ffffff" stroke-width="0.8"/>`).join('') +
    `<path d="M10 22 A8 8 0 0 1 14 8 A11 11 0 0 1 34 5 A10 10 0 0 1 52 10 A7 7 0 0 1 54 22 Z" fill="#5c7690" stroke="${c}" stroke-width="1.4"/>` +
    `<path d="M16 18 Q24 14 30 18 M34 14 Q42 11 48 15" stroke="#9fb4c8" stroke-width="1.4" fill="none" stroke-linecap="round"/>`,
};

function skillArt(godId: string, skill: SkillDef, withBadge: boolean): { vfx: string; core: string; body: string } {
  const p = paletteFor(godId);
  const core = hex(p.core);
  const giant = godId === 'jotunn' ? GIANT_SCENES[skill.id.replace(/^jotunn\./, '')] : undefined;
  let body = giant ? giant(core) : scene(shapeOf(skill), glyphFor(skill), core);
  const cc = withBadge ? ccOf(skill.effects) : null;
  if (cc && CC_BADGES[cc]) body += badge(CC_BADGES[cc]!);
  return { vfx: hex(p.vfx), core, body };
}

/** What a hit that no skill dealt shows as: a god's basic attack (melee or ranged), its passive, a monster's blow, the ground itself. */
export type HitKind = 'melee' | 'ranged' | 'passive' | 'monster' | 'hazard';

/** The icon for a hit no skill dealt, in the hitter's colors (the Jötunn's basic is its club). */
export function hitIcon(godId: string, kind: HitKind): string {
  const p = paletteFor(godId);
  const core = hex(p.core);
  const g: Glyph = kind === 'melee' ? (godId === 'jotunn' ? 'hammer' : 'dagger') : kind === 'ranged' ? 'projectile' : kind === 'passive' ? 'orb' : kind === 'monster' ? 'skull' : 'rift';
  return iconSvg(hex(p.vfx), glyphAt(g, 32, 32, 0.72, `fill="${core}" stroke="${core}"`), false);
}

export function skillIcon(godId: string, skill: SkillDef): string {
  const a = skillArt(godId, skill, true);
  return iconSvg(a.vfx, a.body, skill.kind === 'ultimate');
}

const STAT_GLYPHS: Partial<Record<StatKey, Glyph>> = {
  strength: 'sword',
  intelligence: 'star',
  maxHealth: 'heart',
  healthRegen: 'heal',
  maxMana: 'orb',
  manaRegen: 'orb',
  physicalProtection: 'shield',
  magicalProtection: 'shield',
  damageReduction: 'anvil',
  ccReduction: 'chain',
  cooldownReduction: 'hourglass',
  critChance: 'target',
  lifesteal: 'drop',
  damageBonus: 'nova',
  bonusAttackSpeed: 'spin',
  bonusMoveSpeed: 'dash',
  physicalPenFlat: 'line',
  physicalPenPct: 'line',
  magicalPenFlat: 'line',
  magicalPenPct: 'line',
};

const KEYSTONE_GLYPHS: Record<Keystone['type'], Glyph> = {
  stackingDamage: 'stack',
  empoweredBasicAfterSkill: 'sword',
  executeBelow: 'skull',
  shieldOnHardCC: 'shield',
  auraProtection: 'aura',
  abilityLifesteal: 'drop',
  speedOnTakedown: 'wings',
  ultimateRefundOnTakedown: 'hourglass',
  basicsCutCooldowns: 'conduit',
  resetOnTakedown: 'reset',
  bloodrage: 'rage',
  manaSurge: 'surge',
};

/** Badges for what a talent changes on a skill. */
const MOD_BADGES: Record<string, string> = {
  damagePct: '<path d="M-1.5 -5 H1.5 V-1.5 H5 V1.5 H1.5 V5 H-1.5 V1.5 H-5 V-1.5 H-1.5 Z"/>',
  cooldownPct: '<path d="M-4 -5 H4 L0 0 L4 5 H-4 L0 0 Z" fill="none" stroke-width="1.6"/>',
  costPct: '<circle r="4" fill="none" stroke-width="1.8"/><path d="M-4 4 L4 -4" stroke-width="1.6"/>',
  radiusPct: '<path d="M-5 -5 L-1 -5 M-5 -5 L-5 -1 M5 5 L1 5 M5 5 L5 1 M-5 -5 L5 5" fill="none" stroke-width="1.6"/>',
  rangePct: '<path d="M-5 0 H4 M1 -3 L5 0 L1 3" fill="none" stroke-width="1.8"/>',
  ccDurationPct: '<circle r="4.5" fill="none" stroke-width="1.6"/><path d="M0 -3 V0 L2.5 1.5" fill="none" stroke-width="1.5"/>',
  extraHits: '<text y="3.5" text-anchor="middle" font-size="9" font-weight="700" stroke="none" font-family="sans-serif">+1</text>',
  extraBounces: '<text y="3.5" text-anchor="middle" font-size="9" font-weight="700" stroke="none" font-family="sans-serif">+2</text>',
  charges: '<text y="3.5" text-anchor="middle" font-size="9" font-weight="700" stroke="none" font-family="sans-serif">x2</text>',
};

const BUFF_BADGES: Partial<Record<StatKey, string>> = {
  lifesteal: '<path d="M0 -5 C0 -5 -4 0 -4 2 A4 4 0 0 0 4 2 C4 0 0 -5 0 -5 Z"/>',
  bonusMoveSpeed: '<path d="M-5 -4 L0 0 L-5 4 M0 -4 L5 0 L0 4" fill="none" stroke-width="1.8"/>',
  bonusAttackSpeed: '<path d="M-4 4 L4 -4 M1 -4 H4 V-1" fill="none" stroke-width="1.8"/>',
  damageBonus: '<path d="M0 -5 L5 1 H2 V5 H-2 V1 H-5 Z"/>',
  damageReduction: '<path d="M0 -5 L5 -3 V0 C5 3 3 5 0 6 C-3 5 -5 3 -5 0 V-3 Z"/>',
};

/** The badge for a talent's change to a skill: the effect it adds, or the number it tunes. */
function talentBadge(node: TreeNode): string | null {
  const charge = node.effects.find((e) => e.type === 'skill' && e.field === 'charges');
  if (charge) return MOD_BADGES.charges!;
  for (const e of node.effects) {
    if (e.type !== 'augment') continue;
    const cc = ccOf(e.effects);
    if (cc && CC_BADGES[cc]) return CC_BADGES[cc]!;
    for (const x of e.effects) {
      if (x.kind === 'heal') return '<path d="M-1.5 -5 H1.5 V-1.5 H5 V1.5 H1.5 V5 H-1.5 V1.5 H-5 V-1.5 H-1.5 Z"/>';
      if (x.kind === 'debuff') return '<path d="M0 5 L5 -1 H2 V-5 H-2 V-1 H-5 Z"/>';
      if (x.kind === 'mark') return '<path d="M-5 0 h3 M-1.5 0 h3 M2 0 h3" stroke-width="2.5"/>';
      if (x.kind === 'buff' && BUFF_BADGES[x.stat]) return BUFF_BADGES[x.stat]!;
    }
  }
  const mod = node.effects.find((e) => e.type === 'skill');
  return mod?.type === 'skill' ? (MOD_BADGES[mod.field] ?? null) : null;
}

/**
 * Talent icons: nodes that change a skill show that skill's scene with a
 * badge for the change (x2 for a second charge, a star for an added stun,
 * an hourglass for faster cooldowns). Stat nodes show a stat glyph in the
 * tree's accent color, and keystones a gold frame.
 */
export function talentIcon(godId: string, node: TreeNode, skills: readonly SkillDef[], accent: string): string {
  const sport = node.id.startsWith('sport.') && SPORT_SCENES[node.id.slice(6)];
  if (sport) return iconSvg(node.tier === 4 ? '#ffb43a' : accent, sport, node.tier === 4);
  const first = node.effects.find((e) => e.type === 'skill' || e.type === 'augment') ?? node.effects[0];
  if (node.tier !== 4 && (first?.type === 'skill' || first?.type === 'augment')) {
    const skill = skills.find((s) => s.id === first.skill);
    if (skill) {
      const a = skillArt(godId, skill, false);
      const b = talentBadge(node);
      return iconSvg(a.vfx, a.body + (b ? badge(b) : ''), false);
    }
  }
  const key = node.effects.find((e) => e.type === 'keystone');
  if (key?.type === 'keystone') return iconSvg('#ffb43a', glyphAt(KEYSTONE_GLYPHS[key.keystone.type] ?? 'crown', 32, 32, 0.8, 'fill="#fff4cf" stroke="#fff4cf"'), true);
  const glyph = (first?.type === 'stat' && STAT_GLYPHS[first.stat]) || 'buff';
  return iconSvg(accent, glyphAt(glyph, 32, 32, 0.8, 'fill="#fff6e2" stroke="#fff6e2"'), false);
}

// ---------------------------------------------------------------------------
// Relic Rush's Playmaker tree: scenes with the Sun Relic in them

const ME = 'fill="#fff6e2" stroke="#ffffff" stroke-width="1"';
const me = (x: number, y: number, s = 0.85, o = 1) => figure(x, y, s, ME, o);
const LINE = 'stroke="#fff6e2" fill="none" stroke-linecap="round" stroke-linejoin="round"';

/** The Sun Relic: a gold orb in a tilted ring. */
function relic(x: number, y: number, r = 6): string {
  return `<ellipse cx="${x}" cy="${y}" rx="${r * 1.7}" ry="${r * 0.55}" transform="rotate(-18 ${x} ${y})" fill="none" stroke="#ffd34a" stroke-width="${r * 0.28}"/><circle cx="${x}" cy="${y}" r="${r}" fill="#ffe28a" stroke="#fff6d8" stroke-width="1.2"/><circle cx="${x - r * 0.35}" cy="${y - r * 0.35}" r="${r * 0.3}" fill="#ffffff" opacity="0.8"/>`;
}

const SPORT_SCENES: Record<string, string> = {
  // a runner leaving afterimages
  stride: `${me(14, 52, 0.8, 0.22)}${me(26, 50, 0.8, 0.45)}<path d="M2 34 H22 M6 44 H24 M2 54 H20" ${LINE} stroke-width="2.4" opacity="0.7"/>${me(40, 48, 0.95)}<path d="M48 18 L56 26 L48 34 M40 18 L48 26 L40 34" ${LINE} stroke-width="4"/>`,
  // a pass on a long arc, landing past the usual ring
  arm: `${me(10, 58, 0.7)}<path d="M14 44 Q32 0 52 42" ${LINE} stroke-width="2.4" stroke-dasharray="4 3"/><ellipse cx="36" cy="49" rx="6" ry="2.4" fill="none" stroke="#fff6e2" stroke-width="1.5" opacity="0.45"/><ellipse cx="52" cy="48" rx="8" ry="3.2" fill="none" stroke="#ffd34a" stroke-width="2.2"/><path d="M40 58 H60 M56 54 L60 58 L56 62" ${LINE} stroke-width="2.6"/>${relic(32, 16, 5.5)}`,
  // a hand reaching wide for the relic
  hands: `<circle cx="32" cy="20" r="15" fill="none" stroke="#fff6e2" stroke-width="2" stroke-dasharray="4 3" opacity="0.8"/>${relic(32, 20, 6.5)}${glyphAt('hand', 32, 46, 0.5, 'fill="#fff6e2" stroke="#fff6e2"')}`,
  // the carrier at full stride, relic overhead
  bearer: `<path d="M2 36 H18 M4 46 H20 M2 56 H16" ${LINE} stroke-width="2.4" opacity="0.7"/>${me(34, 56, 1)}${relic(34, 26, 7)}<path d="M50 34 L58 42 L50 50" ${LINE} stroke-width="4"/>`,
  // back on their feet, dizzy stars flying off
  rise: `<ellipse cx="32" cy="58" rx="20" ry="4" fill="#fff6e2" opacity="0.25"/>${me(32, 54, 1)}<path d="M50 50 V20 M43 27 L50 18 L57 27" ${LINE} stroke-width="4"/>${[[14, 26], [22, 16], [10, 40]].map(([x, y]) => `<path transform="translate(${x} ${y}) scale(0.7)" d="M0 -5 L1.3 -1.6 L5 -1.5 L2 0.8 L3.1 4.5 L0 2.3 L-3.1 4.5 L-2 0.8 L-5 -1.5 L-1.3 -1.6 Z" fill="#fff6e2" opacity="0.6"/>`).join('')}`,
  // the relic knocked off a carrier, popping into the tackler's hands
  strip: `${foe(16, 50, 0.85)}<path transform="translate(16 26) scale(0.9)" d="M0 -5 L1.3 -1.6 L5 -1.5 L2 0.8 L3.1 4.5 L0 2.3 L-3.1 4.5 L-2 0.8 L-5 -1.5 L-1.3 -1.6 Z" fill="#ffd34a"/><path d="M20 30 Q34 6 46 30" ${LINE} stroke-width="2.4" stroke-dasharray="3 3"/><path d="M42 26 L46 31 L49 25" ${LINE} stroke-width="2.4"/>${relic(34, 14, 5)}${me(48, 52, 0.9)}`,
  // a pass flying flat and fast
  bullet: `${me(9, 58, 0.62)}<path d="M4 22 H30 M10 30 H32 M4 38 H28" ${LINE} stroke-width="2.6" opacity="0.75"/>${relic(40, 30, 7.5)}<path d="M52 22 L60 30 L52 38" ${LINE} stroke-width="3"/>${ally(56, 58, 0.62)}`,
  // a shove that sends a foe flying
  shove: `${me(14, 52, 0.95)}<path d="M24 42 H40 M34 34 L44 42 L34 50" ${LINE} stroke-width="5"/><path d="M30 50 Q44 18 56 26" ${LINE} stroke-width="2" stroke-dasharray="3 3" opacity="0.7"/><g transform="rotate(30 52 30)">${foe(52, 34, 0.75)}</g><path d="M58 50 L62 54 M54 56 L58 60" ${LINE} stroke-width="2.4" opacity="0.6"/>`,
  // planted feet against an incoming shove
  footing: `<path d="M2 32 H18 M12 25 L20 32 L12 39" ${LINE} stroke-width="4"/><path d="M22 22 L26 42" ${LINE} stroke-width="2.6" opacity="0.7"/>${me(38, 54, 1)}<path d="M18 60 H58" ${LINE} stroke-width="4"/><path d="M26 60 L23 64 M34 60 L31 64 M42 60 L39 64 M50 60 L47 64" ${LINE} stroke-width="2.4" opacity="0.8"/>`,
  // the keystone: the relic crowned
  captain: `<circle cx="32" cy="38" r="20" fill="#ffd34a" opacity="0.16"/><path d="M32 14 V8 M14 22 L10 18 M50 22 L54 18 M10 38 H4 M54 38 H60" ${LINE} stroke-width="3" opacity="0.8"/>${relic(32, 40, 10)}${glyphAt('crown', 32, 15, 0.32, 'fill="#fff4cf" stroke="#fff4cf"')}`,
};

function iconSvg(vfx: string, body: string, gold: boolean): string {
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  const frame = gold
    ? `<rect x="2" y="2" width="60" height="60" rx="8" fill="none" stroke="url(#${id}f)" stroke-width="4"/>`
    : `<rect x="1.5" y="1.5" width="61" height="61" rx="8" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>`;
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <radialGradient id="${id}b" cx="50%" cy="42%" r="70%">
        <stop offset="0" stop-color="${vfx}" stop-opacity="0.85"/>
        <stop offset="0.6" stop-color="${vfx}" stop-opacity="0.28"/>
        <stop offset="1" stop-color="#07060a"/>
      </radialGradient>
      <linearGradient id="${id}f" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fff1b8"/><stop offset="0.5" stop-color="#d9a23a"/><stop offset="1" stop-color="#7a4f12"/>
      </linearGradient>
      <filter id="${id}g" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="1.2" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <clipPath id="${id}c"><rect width="64" height="64" rx="9"/></clipPath>
    </defs>
    <rect width="64" height="64" rx="9" fill="url(#${id}b)"/>
    <g clip-path="url(#${id}c)" filter="url(#${id}g)">${body}</g>
    ${frame}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Underworld Descent's relics: emblems of what each one does

const RELIC_ART: Record<RelicId, { vfx: string; body: string }> = {
  // a skull bursting in a ring of soul fire
  knell: {
    vfx: '#ff6a1a',
    body: `<circle cx="32" cy="33" r="25" fill="none" stroke="#ffb36a" stroke-width="2" stroke-dasharray="3 4" opacity="0.8"/>${Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const p = (r: number) => `${(32 + Math.cos(a) * r).toFixed(1)} ${(33 + Math.sin(a) * r).toFixed(1)}`;
      return `<path d="M${p(16)} L${p(23)}" ${LINE} stroke="#ffd08a" stroke-width="3"/>`;
    }).join('')}${glyphAt('skull', 32, 33, 0.42, 'fill="#fff6e2" stroke="#fff6e2"')}`,
  },
  // a blow landing on one monster and leaping on to two more
  chain: {
    vfx: '#3aa8ff',
    body: `${foe(32, 24, 0.78)}${foe(13, 54, 0.7)}${foe(51, 54, 0.7)}<path d="M28 30 L22 36 L26 38 L17 45" ${LINE} stroke="#d8f6ff" stroke-width="2.8"/><path d="M36 30 L42 36 L38 38 L47 45" ${LINE} stroke="#d8f6ff" stroke-width="2.8"/><path d="M32 6 V10 M24 9 L26 12 M40 9 L38 12" ${LINE} stroke-width="2.4"/>`,
  },
  // an hourglass inside a turning arrow: cooldowns given back
  echo: {
    vfx: '#e0a020',
    body: `<path d="M50 14 A23 23 0 1 0 55 38" ${LINE} stroke-width="3.4"/><path d="M49 32 L55 39 L60 31" ${LINE} stroke-width="3.4"/>${glyphAt('hourglass', 31, 33, 0.5, 'fill="#fff6e2" stroke="#fff6e2"')}`,
  },
  // a shield built of ribs on a spine
  aegis: {
    vfx: '#b8c8e8',
    body: `<path d="M32 7 L52 15 V31 C52 44 43 52 32 57 C21 52 12 44 12 31 V15 Z" fill="#fff6e2" fill-opacity="0.12" stroke="#fff6e2" stroke-width="3" stroke-linejoin="round"/><path d="M32 13 V52" ${LINE} stroke-width="3.4"/><path d="M31 21 Q21 20 17 26 M33 21 Q43 20 47 26 M31 30 Q21 29 17 35 M33 30 Q43 29 47 35 M31 39 Q23 38 20 43 M33 39 Q41 38 44 43" ${LINE} stroke-width="2.6"/>`,
  },
  // souls streaming out of the slain into a heart
  harvest: {
    vfx: '#3ad06a',
    body: `<path d="M8 10 Q14 24 24 30 M56 10 Q50 24 40 30 M32 4 V18" ${LINE} stroke="#c8ffd0" stroke-width="2.2" stroke-dasharray="3 3"/><circle cx="8" cy="10" r="3" fill="#c8ffd0"/><circle cx="56" cy="10" r="3" fill="#c8ffd0"/><circle cx="32" cy="4" r="3" fill="#c8ffd0"/>${glyphAt('heart', 32, 40, 0.5, 'fill="#8dff8a" stroke="#fff6e2" stroke-width="3"')}${glyphAt('heal', 32, 40, 0.22, 'fill="#0d3a14" stroke="none"')}`,
  },
  // a skull with burning eyes in a rising flame
  spite: {
    vfx: '#e02020',
    body: `<path d="M32 4 C40 14 46 18 44 30 C50 26 52 20 52 20 C58 34 50 50 32 58 C14 50 6 34 12 20 C12 20 14 26 20 30 C18 18 24 14 32 4 Z" fill="#ff5a3a" fill-opacity="0.55" stroke="#ffb08a" stroke-width="1.6"/>${glyphAt('skull', 32, 38, 0.46, 'fill="#fff6e2" stroke="#fff6e2"')}<circle cx="27.9" cy="36.2" r="1.9" fill="#ff3020"/><circle cx="36.1" cy="36.2" r="1.9" fill="#ff3020"/>`,
  },
  // the ferryman's lantern, and a god rising in its light
  lantern: {
    vfx: '#40c8e0',
    body: `<path d="M26 6 H34 M30 6 V12" ${LINE} stroke-width="3"/><path d="M21 14 H39 L36 18 H24 Z" fill="#fff6e2"/><rect x="22" y="18" width="16" height="23" rx="3" fill="#9ff0ff" fill-opacity="0.3" stroke="#fff6e2" stroke-width="2.6"/><path d="M30 23 C34.5 28 34 34 30 37 C26 34 25.5 28 30 23 Z" fill="#e8ffff"/><path d="M21 41 H39 L36 45 H24 Z" fill="#fff6e2"/>${me(50, 58, 0.62)}<path d="M50 40 V28 M45 33 L50 27 L55 33" ${LINE} stroke="#9ff0ff" stroke-width="3"/>`,
  },
};

/** A relic's emblem, gold-framed like an ultimate: relics are the run's rare finds. */
export function relicIcon(id: RelicId): string {
  const a = RELIC_ART[id];
  return iconSvg(a.vfx, a.body, true);
}
