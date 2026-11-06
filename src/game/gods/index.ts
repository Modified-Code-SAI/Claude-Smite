import type { GodDef } from '../types';
import { amaterasu } from './amaterasu';
import { anubis } from './anubis';
import { loki } from './loki';
import { odin } from './odin';
import { thanatos } from './thanatos';
import { thor } from './thor';
import { zeus } from './zeus';

/** Playable gods in roster order. */
export const GODS: readonly GodDef[] = [zeus, thor, odin, loki, anubis, amaterasu, thanatos];

export function godById(id: string): GodDef | undefined {
  return GODS.find((g) => g.id === id);
}

export { amaterasu, anubis, loki, odin, thanatos, thor, zeus };
