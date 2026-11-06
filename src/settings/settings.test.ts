import { describe, expect, it } from 'vitest';
import { ACTIONS, bindingLabel, bindingOverrides, defaultBindings, keyLabel, rebind, resolveBindings } from './bindings';
import { boundKeys, controlRows } from './controls';
import { DEFAULTS, normalize, resetForTest, setSettings, settings, slotForCode } from './store';
import { applyTeamColors, TEAM_COLOR_SETS } from './teamColors';
import { SIDE, SIDE_CSS, TEAM_COLORS } from '../combat/palette';
import { defaultPadBindings, padFamily, padLabel, padLayer, padOverrides, rebindPad, resolvePadBindings, STICK_ACTIONS } from './padBindings';
import { deadzoneStick } from '../core/Gamepad';
import { movePenalty } from '../player/PlayerController';

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

describe('controller', () => {
  it('gives every button action a default, one action per button in each layer', () => {
    const b = defaultPadBindings();
    const seen = { pick: new Set<string>(), main: new Set<string>() };
    for (const a of ACTIONS) {
      if (STICK_ACTIONS.includes(a.id)) {
        expect(b[a.id]).toBeNull();
        continue;
      }
      const c = b[a.id];
      if (!c) continue;
      const layer = seen[padLayer(a.id)];
      expect(layer.has(c), `${c} bound twice`).toBe(false);
      layer.add(c);
    }
    // the essentials are all on a button
    for (const a of ['attack', 'skill1', 'skill2', 'skill3', 'ultimate', 'jump', 'cancel', 'recall', 'skills', 'ping', 'menu', 'pick1', 'pick2', 'pick3'] as const) expect(b[a]).not.toBeNull();
  });

  it('swaps a button within its layer, and lets picks share the D-pad', () => {
    const { bindings, movedFrom } = rebindPad(defaultPadBindings(), 'skill1', 'Pad7');
    expect(movedFrom).toBe('attack');
    expect(bindings.skill1).toBe('Pad7');
    expect(bindings.attack).toBe('Pad4');
    // a pick on the ping's button leaves the ping alone
    const shared = rebindPad(defaultPadBindings(), 'pick1', 'Pad13');
    expect(shared.movedFrom).toBeNull();
    expect(shared.bindings.recall).toBe('Pad13');
  });

  it('saves only what changed, and reads saves safely', () => {
    const { bindings } = rebindPad(defaultPadBindings(), 'taunt', 'Pad2');
    const saved = padOverrides(bindings);
    expect(Object.keys(saved).sort()).toEqual(['callPass', 'taunt']);
    const back = resolvePadBindings(JSON.parse(JSON.stringify(saved)));
    expect(back.taunt).toBe('Pad2');
    const odd = resolvePadBindings({ jump: 'Pad99', forward: 'Pad3', attack: 'Pad0', taunt: null });
    expect(odd.jump).toBe('Pad0');
    expect(odd.forward).toBeNull();
    // attack took A, which jump keeps (listed first)
    expect(odd.attack).toBeNull();
    expect(odd.taunt).toBeNull();
  });

  it('names buttons for the controller in hand', () => {
    expect(padFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe('xbox');
    expect(padFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('playstation');
    expect(padFamily('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)')).toBe('nintendo');
    expect(padLabel('Pad0', 'xbox')).toBe('A');
    expect(padLabel('Pad0', 'playstation', true)).toBe('✕');
    expect(padLabel('Pad0', 'nintendo')).toBe('B');
    expect(padLabel('Pad6', 'playstation')).toBe('L2');
    expect(padLabel(null, 'xbox')).toBe('');
  });

  it('takes the dead zone off a stick without a jump at its edge', () => {
    const out = { x: 0, y: 0 };
    deadzoneStick(out, 0.1, 0, 0.15);
    expect(out.x).toBe(0);
    deadzoneStick(out, 0.16, 0, 0.15);
    expect(out.x).toBeGreaterThan(0);
    expect(out.x).toBeLessThan(0.02);
    deadzoneStick(out, 0.8, 0.8, 0.15);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(1);
  });

  it('runs and strafes at the keys\' speeds in their eight ways, and blends between', () => {
    const s = Math.SQRT1_2;
    expect(movePenalty(1, 0)).toBe(1);
    expect(movePenalty(s, s)).toBeCloseTo(1);
    expect(movePenalty(0, 1)).toBeCloseTo(0.8);
    expect(movePenalty(-s, -s)).toBeCloseTo(0.6);
    expect(movePenalty(-1, 0)).toBe(0.6);
    const between = movePenalty(Math.cos(1.2), Math.sin(1.2));
    expect(between).toBeGreaterThan(0.8);
    expect(between).toBeLessThan(1);
  });
});
