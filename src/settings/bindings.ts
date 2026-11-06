/**
 * Every game key goes through this table: an action (move forward, cast
 * skill 1, open the scoreboard) and the two inputs bound to it, a keyboard
 * `KeyboardEvent.code` or a mouse button as 'Mouse0'..'Mouse4'. Codes are
 * physical keys, so WASD stays under the fingers on AZERTY; the labels show
 * the player's own layout where the browser can tell us it.
 */

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'attack'
  | 'skill1'
  | 'skill2'
  | 'skill3'
  | 'ultimate'
  | 'cancel'
  | 'recall'
  | 'skills'
  | 'taunt'
  | 'ping'
  | 'pingTarget'
  | 'callPass'
  | 'pick1'
  | 'pick2'
  | 'pick3'
  | 'scoreboard'
  | 'menu'
  | 'settings'
  | 'mute';

export type ActionGroup = 'Movement' | 'Combat' | 'Team' | 'Mode picks' | 'Interface';

export interface ActionDef {
  id: Action;
  name: string;
  group: ActionGroup;
  /** The default primary and secondary inputs. */
  keys: readonly [string | null, string | null];
  /** One line on what it does where it isn't obvious. */
  hint?: string;
}

export const ACTIONS: readonly ActionDef[] = [
  { id: 'forward', name: 'Move forward', group: 'Movement', keys: ['KeyW', 'ArrowUp'] },
  { id: 'back', name: 'Move back', group: 'Movement', keys: ['KeyS', 'ArrowDown'] },
  { id: 'left', name: 'Strafe left', group: 'Movement', keys: ['KeyA', 'ArrowLeft'] },
  { id: 'right', name: 'Strafe right', group: 'Movement', keys: ['KeyD', 'ArrowRight'] },
  { id: 'jump', name: 'Jump', group: 'Movement', keys: ['Space', null], hint: 'Relic Rush, carrying the relic: juke, a quick sidestep that slips a tackle' },
  { id: 'attack', name: 'Basic attack', group: 'Combat', keys: ['Mouse0', null], hint: 'Also casts an aimed skill, and passes the relic in Relic Rush' },
  { id: 'skill1', name: 'Skill 1', group: 'Combat', keys: ['Digit1', null], hint: 'Press to aim, release or click to cast' },
  { id: 'skill2', name: 'Skill 2', group: 'Combat', keys: ['Digit2', null] },
  { id: 'skill3', name: 'Skill 3', group: 'Combat', keys: ['Digit3', null] },
  { id: 'ultimate', name: 'Ultimate', group: 'Combat', keys: ['Digit4', 'KeyR'], hint: 'Unlocks at level 5' },
  { id: 'cancel', name: 'Cancel aim', group: 'Combat', keys: ['Mouse2', null], hint: 'Drops an aimed skill or closes the ping wheel' },
  { id: 'recall', name: 'Recall', group: 'Combat', keys: ['KeyB', null], hint: 'Back to the fountain' },
  { id: 'skills', name: 'Skills & trees', group: 'Combat', keys: ['KeyK', null], hint: 'Spend tree points; swap skills at the fountain' },
  { id: 'ping', name: 'Ping wheel', group: 'Team', keys: ['KeyG', null], hint: 'Hold for the wheel (attack, on my way, group up, fall back…), tap to ping what you aim at' },
  { id: 'pingTarget', name: 'Quick ping', group: 'Team', keys: ['Mouse1', null], hint: 'Pings what the crosshair is on' },
  { id: 'taunt', name: 'Taunt', group: 'Team', keys: ['KeyV', null], hint: 'Your god says something cutting to everyone near' },
  { id: 'callPass', name: 'Call for the pass', group: 'Team', keys: ['KeyF', null], hint: 'Relic Rush' },
  { id: 'pick1', name: 'Pick first', group: 'Mode picks', keys: ['KeyZ', null], hint: 'Boons, rewards and new skills in Temple Siege, Temple Duel and Underworld Descent' },
  { id: 'pick2', name: 'Pick second', group: 'Mode picks', keys: ['KeyX', null] },
  { id: 'pick3', name: 'Pick third', group: 'Mode picks', keys: ['KeyC', null] },
  { id: 'scoreboard', name: 'Scoreboard', group: 'Interface', keys: ['Tab', null], hint: 'Hold' },
  { id: 'menu', name: 'Game menu', group: 'Interface', keys: ['KeyH', null], hint: 'Controls, settings, performance report, quit' },
  { id: 'settings', name: 'Settings', group: 'Interface', keys: ['KeyO', null] },
  { id: 'mute', name: 'Mute sound', group: 'Interface', keys: ['KeyM', null] },
];

export const ACTION_GROUPS: readonly ActionGroup[] = ['Movement', 'Combat', 'Team', 'Mode picks', 'Interface'];

/** The four action-bar slots, in order. */
export const SLOT_ACTIONS: readonly Action[] = ['skill1', 'skill2', 'skill3', 'ultimate'];
/** The three pick keys (boons, rewards, drafted skills), in order. */
export const PICK_ACTIONS: readonly Action[] = ['pick1', 'pick2', 'pick3'];

/** Keys that can never be bound: Escape always frees the mouse and closes menus. */
export const RESERVED = new Set(['Escape']);

export type Binding = [string | null, string | null];
export type Bindings = Record<Action, Binding>;

export function defaultBindings(): Bindings {
  const out = {} as Bindings;
  for (const a of ACTIONS) out[a.id] = [a.keys[0], a.keys[1]];
  return out;
}

const VALID = /^(Mouse[0-4]|[A-Z][A-Za-z0-9]+)$/;

/**
 * Saved overrides laid over the defaults: an action the save doesn't name
 * keeps its default (so a new action gets its key), and anything malformed
 * is dropped. An input bound twice keeps only its first action.
 */
export function resolveBindings(saved: unknown): Bindings {
  const out = defaultBindings();
  if (saved && typeof saved === 'object') {
    for (const a of ACTIONS) {
      const v = (saved as Record<string, unknown>)[a.id];
      if (!Array.isArray(v)) continue;
      const pick = (c: unknown) => (typeof c === 'string' && VALID.test(c) && !RESERVED.has(c) ? c : null);
      out[a.id] = [pick(v[0]), pick(v[1])];
    }
  }
  const seen = new Set<string>();
  for (const a of ACTIONS) {
    const b = out[a.id];
    for (let i = 0; i < 2; i++) {
      const c = b[i];
      if (!c) continue;
      if (seen.has(c)) b[i] = null;
      else seen.add(c);
    }
  }
  return out;
}

/** Only what differs from the defaults is saved. */
export function bindingOverrides(b: Bindings): Partial<Bindings> {
  const out: Partial<Bindings> = {};
  for (const a of ACTIONS) {
    const v = b[a.id];
    if (v[0] !== a.keys[0] || v[1] !== a.keys[1]) out[a.id] = [v[0], v[1]];
  }
  return out;
}

export interface Rebind {
  bindings: Bindings;
  /** The action the input was taken from, if it was bound elsewhere. */
  movedFrom: Action | null;
}

/**
 * Bind `code` to one of an action's two slots. An input already bound to
 * another action moves here; that action gets whatever this slot held, so
 * swapping two keys is one step and nothing is silently lost.
 */
export function rebind(current: Bindings, action: Action, slot: 0 | 1, code: string | null): Rebind {
  const next = {} as Bindings;
  for (const a of ACTIONS) next[a.id] = [current[a.id][0], current[a.id][1]];
  const old = next[action][slot];
  let movedFrom: Action | null = null;
  if (code) {
    for (const a of ACTIONS) {
      const b = next[a.id];
      for (const i of [0, 1] as const) {
        if (b[i] !== code || (a.id === action && i === slot)) continue;
        if (a.id === action) b[i] = null;
        else {
          b[i] = old;
          movedFrom = a.id;
        }
      }
    }
  }
  next[action][slot] = code;
  // a secondary with no primary moves up
  if (!next[action][0] && next[action][1]) next[action] = [next[action][1], null];
  if (movedFrom && !next[movedFrom][0] && next[movedFrom][1]) next[movedFrom] = [next[movedFrom][1], null];
  return { bindings: next, movedFrom };
}

export function actionDef(a: Action): ActionDef {
  return ACTIONS.find((d) => d.id === a)!;
}

// ---------------------------------------------------------------------------
// Labels

const MOUSE = ['Left click', 'Middle click', 'Right click', 'Mouse 4', 'Mouse 5'];
const MOUSE_SHORT = ['LMB', 'MMB', 'RMB', 'M4', 'M5'];
const NAMED: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Backspace: 'Backspace',
  CapsLock: 'Caps Lock',
  ShiftLeft: 'Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Right Alt',
  MetaLeft: 'Win',
  MetaRight: 'Right Win',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  IntlBackslash: '\\',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  ContextMenu: 'Menu',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
  NumpadEnter: 'Num Enter',
};

/** What the player's keyboard prints on each key (Chromium shares it; others fall back to US names). */
let layout: Map<string, string> | null = null;

/** Ask the browser for the keyboard's layout once; labels refresh through `onLayout`. */
export function loadKeyboardLayout(onLayout: () => void): void {
  const kb = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
  kb?.getLayoutMap?.().then(
    (m) => {
      layout = m;
      onLayout();
    },
    () => {},
  );
}

/** A key's name as the player sees it: 'W', '1', 'Space', 'Right click'. */
export function keyLabel(code: string | null, short = false): string {
  if (!code) return '';
  if (code.startsWith('Mouse')) return (short ? MOUSE_SHORT : MOUSE)[Number(code.slice(5))] ?? code;
  if (NAMED[code]) return NAMED[code]!;
  const printed = layout?.get(code);
  if (printed && printed.trim()) return printed.toUpperCase();
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/** Both of an action's inputs, 'W / ↑', or 'Unbound'. */
export function bindingLabel(b: Binding, short = false): string {
  const parts = b.filter((c): c is string => !!c).map((c) => keyLabel(c, short));
  return parts.length ? parts.join(' / ') : 'Unbound';
}
