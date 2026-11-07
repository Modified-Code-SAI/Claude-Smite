import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HEROES } from './heroArt';

describe('hero renders', () => {
  it('every god the pick screen expects a hero render for has one in public/hero', () => {
    for (const id of HEROES) expect(existsSync(`public/hero/${id}.webp`), id).toBe(true);
  });

  it('and its head-and-shoulders card in public/hero/face (python3 tools/hero/faces.py <god>)', () => {
    for (const id of HEROES) expect(existsSync(`public/hero/face/${id}.webp`), id).toBe(true);
  });
});
