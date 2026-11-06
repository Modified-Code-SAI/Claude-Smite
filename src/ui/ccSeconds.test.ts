import { describe, expect, it } from 'vitest';
import { ccSeconds } from './CombatHud';

describe('crowd control timers', () => {
  it('round up to a tenth, so an effect still on never reads 0.0', () => {
    expect(ccSeconds(0.04)).toBe('0.1');
    expect(ccSeconds(0.3)).toBe('0.3');
    expect(ccSeconds(1.21)).toBe('1.3');
    expect(ccSeconds(2)).toBe('2.0');
  });
});
