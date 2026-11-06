import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GODS } from '../game/gods';
import { GIANT_KINDS, GIANT_LINES, GOD_LINES, LINE_KINDS, lineUrl, VOICE_LINES, type VoiceKind } from './godLines';

const voices = join(__dirname, '..', '..', 'public', 'voices');

describe('god lines', () => {
  it('gives every god something to say for every moment, with a choice where it repeats', () => {
    expect(Object.keys(GOD_LINES).sort()).toEqual(GODS.map((g) => g.id).sort());
    for (const g of GODS) {
      for (const kind of LINE_KINDS) expect(GOD_LINES[g.id]![kind].length, `${g.id} ${kind}`).toBeGreaterThan(0);
      for (const kind of ['kill', 'taunt', 'start', 'ult', 'death', 'respawn'] as const) expect(GOD_LINES[g.id]![kind].length, `${g.id} ${kind}`).toBeGreaterThan(1);
    }
  });

  it('gives the Jötunn its own voice for each moment of the fight, with a choice where it repeats', () => {
    expect(VOICE_LINES.jotunn).toBe(GIANT_LINES);
    for (const kind of GIANT_KINDS) expect(GIANT_LINES[kind].length, kind).toBeGreaterThan(0);
    for (const kind of ['start', 'kill', 'brazier'] as const) expect(GIANT_LINES[kind].length, kind).toBeGreaterThan(2);
  });

  it('keeps lines short enough to say mid-fight, and never the same line twice for a god', () => {
    for (const [god, kinds] of Object.entries(VOICE_LINES)) {
      const all = Object.values(kinds).flat();
      expect(new Set(all).size, god).toBe(all.length);
      for (const line of all) expect(line.length, line).toBeLessThanOrEqual(70);
    }
  });

  it('has a recording for every line, and none left over', () => {
    for (const [god, kinds] of Object.entries(VOICE_LINES)) {
      const want = new Set<string>();
      for (const kind of Object.keys(kinds) as VoiceKind[]) {
        kinds[kind]!.forEach((_, n) => {
          const file = lineUrl('', god, kind, n).replace(/^voices\//, '');
          want.add(file.split('/')[1]!);
          expect(existsSync(join(voices, file)), file).toBe(true);
        });
      }
      expect(readdirSync(join(voices, god)).sort()).toEqual([...want].sort());
    }
  });
});
