const BASE = import.meta.env.BASE_URL;

/**
 * The gods with a full-length hero render (public/hero, made in Blender by
 * tools/hero): 1200x1800, transparent, head 5% from the top and feet 94% down,
 * so they stand straight on whatever light a screen puts behind them. Add a
 * new god here once its render exists (src/ui/heroArt.test.ts checks the file).
 */
export const HEROES: ReadonlySet<string> = new Set(['zeus', 'thor', 'odin', 'loki', 'anubis', 'thanatos', 'kukulkan', 'cthulhu', 'jotunn']);

/** A god's hero render. */
export const heroArt = (id: string) => `${BASE}hero/${id}.webp`;

/**
 * A god's head and shoulders cut from the hero render (tools/hero/faces.py), 320x400
 * and transparent: the card picture on the god strip, the team slots and the lobby seats.
 */
export const heroFace = (id: string) => `${BASE}hero/face/${id}.webp`;
