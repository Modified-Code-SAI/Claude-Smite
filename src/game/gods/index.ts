import type { GodDef } from '../types';
import { anubis } from './anubis';
import { kukulkan } from './kukulkan';
import { loki } from './loki';
import { odin } from './odin';
import { thanatos } from './thanatos';
import { thor } from './thor';
import { zeus } from './zeus';

/** Playable gods in roster order. */
export const GODS: readonly GodDef[] = [zeus, thor, odin, loki, anubis, thanatos, kukulkan];

export function godById(id: string): GodDef | undefined {
  return GODS.find((g) => g.id === id);
}

export { anubis, kukulkan, loki, odin, thanatos, thor, zeus };
