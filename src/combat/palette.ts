import type { Team } from '../game/combatant';

/**
 * Per-god colors: armor and cloth for the placeholder model, and the two
 * spell colors every effect, decal and icon of that god uses. Saturated and
 * bright on purpose, matching Smite 2's readable, stylized VFX.
 */
export interface GodPalette {
  cloth: number;
  trim: number;
  glow: number;
  /** Main spell color. */
  vfx: number;
  /** Hot core / highlight color. */
  core: number;
  /** Signature effect layered on top of the shared ones. */
  element?: 'lightning' | 'runes' | 'smoke' | 'sand' | 'frost';
}

const PALETTES: Record<string, GodPalette> = {
  zeus: { cloth: 0x1d3a8a, trim: 0xe0b04a, glow: 0x6fe3ff, vfx: 0x3fb6ff, core: 0xe6f8ff, element: 'lightning' },
  thor: { cloth: 0x8a1d1d, trim: 0xb9c3cf, glow: 0x9fd0ff, vfx: 0x6aa8ff, core: 0xf2f7ff, element: 'lightning' },
  odin: { cloth: 0x3a3f4a, trim: 0xd8a23a, glow: 0xffc955, vfx: 0xffa62a, core: 0xfff1c4, element: 'runes' },
  loki: { cloth: 0x1f5a2a, trim: 0xb8b04a, glow: 0x7dff6a, vfx: 0x3dff7a, core: 0xdcffe2, element: 'smoke' },
  anubis: { cloth: 0x18130e, trim: 0xe0b04a, glow: 0xffa040, vfx: 0xff7a1a, core: 0xffe3a6, element: 'sand' },
  thanatos: { cloth: 0x1c1826, trim: 0xa8b0bc, glow: 0x74c4ff, vfx: 0x5a9cff, core: 0xe4f4ff },
  kukulkan: { cloth: 0xeee4cc, trim: 0xf0b848, glow: 0x7affc8, vfx: 0x2fd890, core: 0xf2ffe0 },
  // the frost giant of the Jötunn mode
  jotunn: { cloth: 0x4e3c30, trim: 0x9a7444, glow: 0x66e0ff, vfx: 0x4fcfff, core: 0xeafcff, element: 'frost' },
};

const FALLBACK: GodPalette = { cloth: 0x444444, trim: 0xc0a060, glow: 0xffffff, vfx: 0xffd27a, core: 0xffffff };

export function paletteFor(godId: string): GodPalette {
  return PALETTES[godId] ?? FALLBACK;
}

/** Spell colors for minions and structures: their team's colors. */
const TEAM_PALETTES = {
  order: { cloth: 0x1f4fb8, trim: 0xd9a845, glow: 0x8fd0ff, vfx: 0x4fb2ff, core: 0xe6f4ff },
  chaos: { cloth: 0x8e1016, trim: 0x2a2320, glow: 0xff9a6a, vfx: 0xff3524, core: 0xffe0c8 },
  // jungle monsters: feral amber and moss
  neutral: { cloth: 0x4a3a22, trim: 0x7a8a3a, glow: 0xffc24a, vfx: 0xffa83a, core: 0xfff0c0 },
} as const satisfies Record<Team, GodPalette>;

/** The palette a unit's effects use: its god's, its summoner's, or its team's. */
export function paletteOf(u: { kind: string; team: Team; owner: { combatant: { god: { id: string } } } | null; combatant: { god: { id: string } } }): GodPalette {
  if (u.kind === 'god' || u.kind === 'dummy') return paletteFor(u.combatant.god.id);
  if (u.kind === 'summon' && u.owner) return paletteFor(u.owner.combatant.god.id);
  return TEAM_PALETTES[u.team];
}

/**
 * Team-relative colors for HUD marks (health bars, the minimap). Changed in
 * place by the colorblind setting (src/settings/teamColors.ts), so read them
 * when drawing rather than copying them.
 */
export const TEAM_COLORS = {
  ally: '#46d7c4',
  enemy: '#ff4a3d',
  self: '#7fe36a',
  neutral: '#f2b440',
};

/**
 * Your side and the other side in the world and on radars: Relic Rush's
 * relic, gates and pitch, Temple Clash's plaza and relic. Changed in place
 * by the colorblind setting, like TEAM_COLORS.
 */
export const SIDE = {
  ally: { main: 0x4fb2ff, core: 0xe6f4ff },
  foe: { main: 0xff3524, core: 0xffe0c8 },
};
/** The same two sides as CSS colors, for canvas radars. */
export const SIDE_CSS = { ally: '#4fb2ff', foe: '#ff4a38' };

export function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}
