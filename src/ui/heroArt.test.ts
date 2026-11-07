import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HEROES } from './heroArt';

describe('hero renders', () => {
  it('every god the pick screen expects a hero render for has one in public/hero', () => {
    for (const id of HEROES) expect(existsSync(`public/hero/${id}.webp`), id).toBe(true);
  });
});
