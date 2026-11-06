/**
 * Controller buttons for each action, beside the keyboard's (bindings.ts).
 * A button is 'Pad0'..'Pad15', the W3C standard gamepad layout's index:
 * 0-3 the face buttons (bottom, right, left, top), 4/5 the bumpers, 6/7 the
 * triggers, 8/9 View and Menu, 10/11 the stick clicks, 12-15 the D-pad.
 * Movement and the camera are the sticks and aren't rebindable.
 *
 * The mode picks are a layer of their own: they only count while a pick is
 * on offer (boons between Siege waves, a Duel underdog's boon, a Descent
 * reward), and then they take the press before anything else on the button.
 * So the D-pad can pick in those moments and ping, recall and open the
 * trees the rest of the time.
 */

import { ACTIONS, PICK_ACTIONS, type Action } from './bindings';

export type PadBindings = Record<Action, string | null>;
export type PadFamily = 'xbox' | 'playstation' | 'nintendo';

/** Actions the sticks do, with no button of their own. */
export const STICK_ACTIONS: readonly Action[] = ['forward', 'back', 'left', 'right'];

const DEFAULTS: Partial<Record<Action, string>> = {
  jump: 'Pad0',
  cancel: 'Pad1',
  callPass: 'Pad2',
  ultimate: 'Pad3',
  skill1: 'Pad4',
  skill2: 'Pad5',
  skill3: 'Pad6',
  attack: 'Pad7',
  scoreboard: 'Pad8',
  menu: 'Pad9',
  taunt: 'Pad10',
  pingTarget: 'Pad11',
  ping: 'Pad12',
  recall: 'Pad13',
  skills: 'Pad15',
  pick1: 'Pad14',
  pick2: 'Pad12',
  pick3: 'Pad15',
};

const isPadCode = (c: unknown): c is string => typeof c === 'string' && /^Pad(1[0-5]|[0-9])$/.test(c);

/** Which layer an action's button lives in: the picks share buttons with the rest. */
export function padLayer(a: Action): 'pick' | 'main' {
  return PICK_ACTIONS.includes(a) ? 'pick' : 'main';
}

export function defaultPadBindings(): PadBindings {
  const b = {} as PadBindings;
  for (const a of ACTIONS) b[a.id] = STICK_ACTIONS.includes(a.id) ? null : DEFAULTS[a.id] ?? null;
  return b;
}

/** Saved overrides over the defaults; nonsense and a button used twice in a layer are dropped. */
export function resolvePadBindings(saved: unknown): PadBindings {
  const b = defaultPadBindings();
  if (!saved || typeof saved !== 'object') return b;
  const s = saved as Record<string, unknown>;
  for (const a of ACTIONS) {
    if (!(a.id in s) || STICK_ACTIONS.includes(a.id)) continue;
    const v = s[a.id];
    if (v === null) b[a.id] = null;
    else if (isPadCode(v)) b[a.id] = v;
  }
  // a button bound twice in one layer keeps the first action listed
  const seen = { pick: new Set<string>(), main: new Set<string>() };
  for (const a of ACTIONS) {
    const c = b[a.id];
    if (!c) continue;
    const layer = seen[padLayer(a.id)];
    if (layer.has(c)) b[a.id] = null;
    else layer.add(c);
  }
  return b;
}

/** Only what differs from the defaults, for the save. */
export function padOverrides(b: PadBindings): Partial<PadBindings> {
  const d = defaultPadBindings();
  const out: Partial<PadBindings> = {};
  for (const a of ACTIONS) if (b[a.id] !== d[a.id]) out[a.id] = b[a.id];
  return out;
}

/**
 * Put `code` on `action` (null clears it). A button another action in the
 * same layer had swaps over: that action takes this one's old button.
 */
export function rebindPad(current: PadBindings, action: Action, code: string | null): { bindings: PadBindings; movedFrom: Action | null } {
  const b = { ...current };
  const old = b[action];
  let movedFrom: Action | null = null;
  if (code) {
    for (const a of ACTIONS) {
      if (a.id !== action && padLayer(a.id) === padLayer(action) && b[a.id] === code) {
        b[a.id] = old;
        movedFrom = a.id;
      }
    }
  }
  b[action] = code;
  return { bindings: b, movedFrom };
}

/** The controller's maker from its id string, for the button names. */
export function padFamily(id: string): PadFamily {
  if (/dualsense|dualshock|playstation|sony|054c/i.test(id)) return 'playstation';
  if (/nintendo|pro controller|joy-?con|057e/i.test(id)) return 'nintendo';
  return 'xbox';
}

const NAMES: Record<PadFamily, readonly string[]> = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'Left stick click', 'Right stick click', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right'],
  playstation: ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right'],
  // the standard layout reports the bottom button first, which Nintendo labels B
  nintendo: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', 'Minus', 'Plus', 'Left stick click', 'Right stick click', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right'],
};

const SHORT: Record<PadFamily, readonly string[]> = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', '↑', '↓', '←', '→'],
  playstation: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', '↑', '↓', '←', '→'],
  nintendo: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '−', '+', 'LS', 'RS', '↑', '↓', '←', '→'],
};

/** A button's name on this kind of controller ('' for none); `short` for a key badge. */
export function padLabel(code: string | null, family: PadFamily, short = false): string {
  if (!code) return '';
  const i = Number(code.slice(3));
  return (short ? SHORT : NAMES)[family][i] ?? code;
}
