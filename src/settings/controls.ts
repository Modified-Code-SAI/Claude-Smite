/**
 * The controls as the player has bound them: the list on the title screen
 * and in the game menu, the action bar's key badges, and key names inside
 * tips. Everything here reads the live bindings.
 */

import { SLOT_KEYS } from '../game/loadout';
import { ACTIONS, bindingLabel, keyLabel, loadKeyboardLayout, SLOT_ACTIONS, type Action } from './bindings';
import { codesFor, onSettings } from './store';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const key = (a: Action) => esc(keyLabel(codesFor(a)[0]) || '—');
const both = (a: Action) => esc(bindingLabel(codesFor(a)).replace(' / ', ' or '));

/** The controls list: what to press, and what it does. */
export function controlRows(): [string, string][] {
  const move = (['forward', 'left', 'back', 'right'] as const).map(key).join(' ');
  const skills = SLOT_ACTIONS.slice(0, 3).map(key).join('  ');
  return [
    ['Click', 'Capture the mouse and play'],
    [move, 'Move'],
    ['Mouse', 'Aim (the camera follows)'],
    [key('attack'), 'Basic attack (Relic Rush: pass the relic)'],
    [skills, `Skills: press to aim, release or ${key('attack').toLowerCase()} to cast, ${key('cancel').toLowerCase()} cancels`],
    [both('ultimate'), 'Ultimate (unlocks at level 5)'],
    [key('recall'), 'Recall to the fountain'],
    [`${key('ping')} (hold)`, `Ping wheel: attack, on my way, group up, fall back and more. Tap ${key('ping')} or ${key('pingTarget').toLowerCase()} to ping what you aim at`],
    [key('taunt'), 'Taunt: your god says something cutting to everyone near'],
    [key('callPass'), 'Relic Rush: call for the pass'],
    [key('jump'), 'Jump (Relic Rush carrying the relic: juke, a quick sidestep that slips a tackle)'],
    [(['pick1', 'pick2', 'pick3'] as const).map(key).join('  '), 'Temple Siege and Underworld Descent: pick a boon, a reward or a skill'],
    [key('skills'), 'Skills & trees: spend points; swap skills at the fountain'],
    [`${key('scoreboard')} (hold)`, 'Scoreboard'],
    ['Wheel', 'Camera zoom'],
    [key('menu'), 'Game menu: controls, settings, performance report, quit'],
    [key('settings'), 'Settings: keys, sound, graphics, accessibility'],
    [key('mute'), 'Mute or unmute sound'],
    ['Esc', 'Release the mouse'],
  ];
}

/** Each action's default key name, to find it inside a tip's text. */
const DEFAULT_LABEL = new Map<string, Action>();
for (const a of ACTIONS) {
  const c = a.keys[0];
  if (c && !DEFAULT_LABEL.has(keyLabel(c))) DEFAULT_LABEL.set(keyLabel(c), a.id);
}

/**
 * Rewrites `<kbd>K</kbd>`-style key names written for the default keys into
 * the keys the player has bound now, so a tip never names a key that no
 * longer does the thing.
 */
export function boundKeys(html: string): string {
  return html.replace(/<kbd>([^<]+)<\/kbd>/g, (whole, label: string) => {
    const a = DEFAULT_LABEL.get(label) ?? (label === 'R' ? 'ultimate' : undefined);
    if (!a) return whole;
    const code = a === 'ultimate' && label === 'R' ? codesFor(a)[1] ?? codesFor(a)[0] : codesFor(a)[0];
    return `<kbd>${keyLabel(code) || label}</kbd>`;
  });
}

const labelListeners: (() => void)[] = [];

/** Hear when key names change (a rebind, or the keyboard layout arriving). */
export function onKeyLabels(fn: () => void): void {
  labelListeners.push(fn);
}

function refreshLabels(): void {
  SLOT_ACTIONS.forEach((a, i) => (SLOT_KEYS[i] = keyLabel(codesFor(a)[0], true) || '—'));
  // controls lists already on screen (the title screen's, the game menu's)
  if (typeof document !== 'undefined') {
    const rows = controlRows()
      .map(([k, v]) => `<div class="sm-key">${k}</div><div>${v}</div>`)
      .join('');
    document.querySelectorAll('.sm-controls').forEach((el) => (el.innerHTML = rows));
  }
  for (const f of labelListeners) f();
}

/** Keep the action bar's key badges in step with the bindings, and ask for the keyboard's layout. */
export function watchKeyLabels(): void {
  onSettings((_, changed) => {
    if (changed.has('bindings')) refreshLabels();
  });
  loadKeyboardLayout(refreshLabels);
}
