import { describe, expect, it } from 'vitest';
import { ACTIONS, bindingLabel, bindingOverrides, defaultBindings, keyLabel, rebind, resolveBindings } from './bindings';
import { boundKeys, controlRows } from './controls';
import { DEFAULTS, normalize, resetForTest, setSettings, settings, slotForCode } from './store';
import { applyTeamColors, TEAM_COLOR_SETS } from './teamColors';
import { SIDE, SIDE_CSS, TEAM_COLORS } from '../combat/palette';

describe('key bindings', () => {
  it('gives every action its default and binds no input twice', () => {
    const b = defaultBindings();
    const seen = new Set<string>();
    for (const a of ACTIONS) {
      expect(b[a.id][0]).not.toBeNull();
      for (const c of b[a.id]) {
        if (!c) continue;
        expect(seen.has(c), `${c} bound twice`).toBe(false);
        seen.add(c);
      }
    }
  });

  it('swaps a key taken from another action instead of losing it', () => {
    const { bindings, movedFrom } = rebind(defaultBindings(), 'taunt', 0, 'KeyG');
    expect(movedFrom).toBe('ping');
    expect(bindings.taunt[0]).toBe('KeyG');
    // the ping wheel takes the taunt's old key
    expect(bindings.ping[0]).toBe('KeyV');
  });

  it('moves a secondary up when the primary is cleared', () => {
    const { bindings } = rebind(defaultBindings(), 'ultimate', 0, null);
    expect(bindings.ultimate).toEqual(['KeyR', null]);
  });

  it('binding an action\'s own other key just moves it', () => {
    const { bindings, movedFrom } = rebind(defaultBindings(), 'ultimate', 1, 'Digit4');
    expect(movedFrom).toBeNull();
    expect(bindings.ultimate).toEqual(['Digit4', null]);
  });

  it('saves only what changed, and reads saves safely', () => {
    const { bindings } = rebind(defaultBindings(), 'jump', 0, 'ShiftLeft');
    const saved = bindingOverrides(bindings);
    expect(Object.keys(saved)).toEqual(['jump']);
    const back = resolveBindings(JSON.parse(JSON.stringify(saved)));
    expect(back.jump[0]).toBe('ShiftLeft');
    expect(back.forward[0]).toBe('KeyW');
    // nonsense, Escape and a key bound twice are dropped
    const odd = resolveBindings({ jump: ['Escape', 42], taunt: ['KeyW', null], forward: 'x' });
    expect(odd.jump).toEqual([null, null]);
    expect(odd.forward[0]).toBe('KeyW');
    expect(odd.taunt[0]).toBeNull();
  });

  it('names keys the way a player reads them', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Digit4')).toBe('4');
    expect(keyLabel('Mouse0')).toBe('Left click');
    expect(keyLabel('Mouse2', true)).toBe('RMB');
    expect(keyLabel('ShiftLeft')).toBe('Shift');
    expect(bindingLabel(['Digit4', 'KeyR'])).toBe('4 / R');
    expect(bindingLabel([null, null])).toBe('Unbound');
  });
});

describe('settings store', () => {
  it('clamps and repairs saved values', () => {
    const s = normalize({ fov: 400, uiScale: 0.1, teamColors: 'rainbow', frameCap: 77, subtitles: 'yes', shake: 0.5 });
    expect(s.fov).toBe(75);
    expect(s.uiScale).toBe(0.75);
    expect(s.teamColors).toBe(DEFAULTS.teamColors);
    expect(s.frameCap).toBe(0);
    expect(s.subtitles).toBe(false);
    expect(s.shake).toBe(0.5);
  });

  it('casts skills from whatever keys the slots are bound to', () => {
    resetForTest();
    expect(slotForCode('Digit4')).toBe(3);
    setSettings({ bindings: rebind(settings().bindings, 'skill1', 0, 'KeyQ').bindings });
    expect(slotForCode('KeyQ')).toBe(0);
    expect(slotForCode('Digit1')).toBe(-1);
    // the controls list and tips name the new key
    expect(controlRows().find((r) => r[1] === 'Move')![0]).toBe('W A S D');
    expect(controlRows().some((r) => r[0].startsWith('Q'))).toBe(true);
    resetForTest();
  });

  it('rewrites default key names in tips to the bound keys', () => {
    resetForTest();
    setSettings({ bindings: rebind(settings().bindings, 'skills', 0, 'KeyP').bindings });
    expect(boundKeys('Press <kbd>K</kbd> to grow your trees')).toBe('Press <kbd>P</kbd> to grow your trees');
    expect(boundKeys('press <kbd>4</kbd> or <kbd>R</kbd>')).toBe('press <kbd>4</kbd> or <kbd>R</kbd>');
    resetForTest();
  });
});

describe('team colors', () => {
  it('keeps your side and theirs far apart in every set', () => {
    const lum = (c: number) => 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);
    for (const set of Object.values(TEAM_COLOR_SETS)) {
      const d = Math.abs(((set.ally.main >> 16) & 255) - ((set.foe.main >> 16) & 255)) + Math.abs((set.ally.main & 255) - (set.foe.main & 255));
      expect(d).toBeGreaterThan(200);
      expect(lum(set.ally.main)).toBeGreaterThan(60);
      expect(lum(set.foe.main)).toBeGreaterThan(60);
    }
  });

  it('repaints the shared tables in place', () => {
    const ally = SIDE.ally;
    applyTeamColors('redgreen', null);
    expect(SIDE.ally).toBe(ally);
    expect(SIDE.foe.main).toBe(TEAM_COLOR_SETS.redgreen.foe.main);
    expect(TEAM_COLORS.enemy).toBe(TEAM_COLOR_SETS.redgreen.bars.enemy);
    expect(SIDE_CSS.ally).toBe('#3d8bff');
    applyTeamColors('default', null);
    expect(TEAM_COLORS.ally).toBe('#46d7c4');
    expect(SIDE.foe.main).toBe(0xff3524);
  });
});
