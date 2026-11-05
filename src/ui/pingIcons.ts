import type { PingKind } from '../sim/Pings';

/** Four copies of a shape turned a quarter at a time about the icon's center. */
const quad = (d: string) => [0, 90, 180, 270].map((a) => `<path transform="rotate(${a} 12 12)" d="${d}"/>`).join('');
const glyph = (c: string) => `<text x="12" y="18.6" text-anchor="middle" font-family="Georgia, serif" font-size="19" font-weight="900">${c}</text>`;

/** A sword, point up and to the right. */
const SWORD = 'M20.8 2.2l-.9 4.4-9.4 9.5-2.6-2.6 9.5-9.4zM4.4 13.3l6.3 6.3-1.5 1.5-1.8-1.8-2.6 2.6-1.4-1.4 2.6-2.6-1.8-1.8z';

/**
 * Each call's picture, drawn on a 24-unit square in the current color: crossed
 * swords to attack, an eye to look, chevrons to move, arrows closing in to group.
 */
export const PING_ICONS: Record<PingKind, string> = {
  look: '<path fill-rule="evenodd" d="M12 5C6.6 5 2.8 9.1 1.4 12c1.4 2.9 5.2 7 10.6 7s9.2-4.1 10.6-7C21.2 9.1 17.4 5 12 5zm0 11.6a4.6 4.6 0 1 1 0-9.2 4.6 4.6 0 0 1 0 9.2zm0-2.4a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z"/>',
  attack: `<path d="${SWORD}"/><path transform="matrix(-1 0 0 1 24 0)" d="${SWORD}"/>`,
  omw: '<path d="M3.5 4.5l7.5 7.5-7.5 7.5-2.2-2.2 5.3-5.3-5.3-5.3zm9.5 0l7.5 7.5-7.5 7.5-2.2-2.2 5.3-5.3-5.3-5.3z"/>',
  group: `<circle cx="12" cy="12" r="2.4"/>${quad('M9.2 1.6h5.6v3.2h2.6L12 9.4 6.6 4.8h2.6z')}`,
  ult: '<path d="M12 1.2l2.7 7.6 8 .3-6.3 4.9 2.2 7.8L12 17.3l-6.6 4.5 2.2-7.8-6.3-4.9 8-.3z"/>',
  back: '<path d="M2.6 4.4L12 11l9.4-6.6v4.2L12 15.2 2.6 8.6zm0 6.8L12 17.8l9.4-6.6v4.2L12 22 2.6 15.4z"/>',
  missing: glyph('?'),
  help: glyph('!'),
  thanks: '<path d="M12 21.2s-8.8-5.4-8.8-11.5c0-3.3 2.4-5.5 5-5.5 1.7 0 3 .9 3.8 2.2.8-1.3 2.1-2.2 3.8-2.2 2.6 0 5 2.2 5 5.5 0 6.1-8.8 11.5-8.8 11.5z"/>',
};

export const pingIcon = (k: PingKind): string => `<svg viewBox="0 0 24 24" aria-hidden="true">${PING_ICONS[k]}</svg>`;
