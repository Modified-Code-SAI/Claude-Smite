/**
 * Colorblind-safe team colors. The default tells your side from theirs by
 * teal or blue against red, which red-green colorblind players (about one man
 * in twelve) can lose; each other set keeps the two sides apart in both hue
 * and brightness for its kind of color vision. Everything team-relative
 * reads them: health bars, the minimap and radars (TEAM_COLORS, SIDE_CSS),
 * the world's ally and enemy marks (SIDE), and the HUD's CSS variables.
 */

import { SIDE, SIDE_CSS, TEAM_COLORS } from '../combat/palette';
import type { TeamColorMode } from './store';

export interface TeamColorSet {
  name: string;
  text: string;
  /** Health bars and the minimap. */
  bars: { ally: string; enemy: string; self: string; neutral: string };
  /** World marks and radars: main color and hot core. */
  ally: { main: number; core: number };
  foe: { main: number; core: number };
}

export const TEAM_COLOR_SETS: Record<TeamColorMode, TeamColorSet> = {
  default: {
    name: 'Standard',
    text: 'Teal and blue for your team, red for enemies.',
    bars: { ally: '#46d7c4', enemy: '#ff4a3d', self: '#7fe36a', neutral: '#f2b440' },
    ally: { main: 0x4fb2ff, core: 0xe6f4ff },
    foe: { main: 0xff3524, core: 0xffe0c8 },
  },
  redgreen: {
    name: 'Red-green safe',
    text: 'Blue against orange, for protanopia and deuteranopia. You are white.',
    bars: { ally: '#3d9bff', enemy: '#ff9a1f', self: '#ffffff', neutral: '#c58cff' },
    ally: { main: 0x3d8bff, core: 0xe2eeff },
    foe: { main: 0xff8a10, core: 0xffe8c8 },
  },
  tritan: {
    name: 'Blue-yellow safe',
    text: 'Cyan against pink-red, for tritanopia. You are white.',
    bars: { ally: '#36d6e7', enemy: '#ff3d7a', self: '#ffffff', neutral: '#ffb84a' },
    ally: { main: 0x2fd2e6, core: 0xe4fdff },
    foe: { main: 0xff2f72, core: 0xffe0ea },
  },
  contrast: {
    name: 'High contrast',
    text: 'Bright cyan against magenta, the strongest split for any vision.',
    bars: { ally: '#22e8ff', enemy: '#ff28c8', self: '#ffffff', neutral: '#ffe14a' },
    ally: { main: 0x22e8ff, core: 0xffffff },
    foe: { main: 0xff28c8, core: 0xffe2f6 },
  },
};

const rgb = (c: number) => `${(c >> 16) & 255}, ${(c >> 8) & 255}, ${c & 255}`;
const css = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
/** Mix a color toward white (k > 0) or black (k < 0). */
const shade = (c: number, k: number) => {
  const ch = (s: number) => {
    const v = (c >> s) & 255;
    return Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k));
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

/** Point every team-relative color at one set. */
export function applyTeamColors(mode: TeamColorMode, root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null): void {
  const set = TEAM_COLOR_SETS[mode];
  Object.assign(TEAM_COLORS, set.bars);
  Object.assign(SIDE.ally, set.ally);
  Object.assign(SIDE.foe, set.foe);
  SIDE_CSS.ally = css(set.ally.main);
  SIDE_CSS.foe = css(shade(set.foe.main, 0.08));
  if (!root) return;
  root.dataset.teamColors = mode;
  const vars: Record<string, string> = {
    '--ally': set.bars.ally,
    '--enemy': set.bars.enemy,
    '--self': set.bars.self,
    '--neutral': set.bars.neutral,
    '--ally-main': css(set.ally.main),
    '--foe-main': css(set.foe.main),
    '--ally-rgb': rgb(shade(set.ally.main, 0.2)),
    '--ally-deep': css(shade(set.ally.main, -0.15)),
    '--ally-light': css(shade(set.ally.main, 0.55)),
    '--foe-rgb': rgb(shade(set.foe.main, 0.12)),
    '--foe-deep': css(shade(set.foe.main, -0.08)),
    '--foe-light': css(shade(set.foe.main, 0.5)),
  };
  for (const [k, v] of Object.entries(vars)) {
    if (mode === 'default') root.style.removeProperty(k);
    else root.style.setProperty(k, v);
  }
}
