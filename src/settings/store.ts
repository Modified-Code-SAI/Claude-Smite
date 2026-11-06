/**
 * The player's settings: one object saved in localStorage, read everywhere,
 * changed only through `setSettings` so every listener hears the change.
 * Sound volumes live in the audio engine's own save (AudioEngine.settings)
 * and the quality preset in Quality.ts; the menu shows them all together.
 */

import { bindingOverrides, resolveBindings, SLOT_ACTIONS, type Action, type Binding, type Bindings } from './bindings';
import { padOverrides, resolvePadBindings, type PadBindings } from './padBindings';

export type TeamColorMode = 'default' | 'redgreen' | 'tritan' | 'contrast';
export type SubtitleSize = 'small' | 'medium' | 'large' | 'huge';

export interface Settings {
  // controls
  /** Multiplier on the base mouse turn rate. */
  sensitivity: number;
  invertY: boolean;
  /** Skills fire the moment their key goes down, at the crosshair, with no aim preview. */
  quickCast: boolean;
  bindings: Bindings;
  // controller
  /** Multiplier on the right stick's turn rate. */
  padSensitivity: number;
  padInvertY: boolean;
  /** How far a stick must move before it counts, 0 to 1 of its reach. */
  padDeadzone: number;
  /** Rumble strength, 0 (off) to 1. */
  vibration: number;
  /** The camera turns a little slower while the crosshair is on an enemy in reach. */
  aimSlowdown: boolean;
  padBindings: PadBindings;
  /** Damage and healing numbers float up from what you hit. */
  damageNumbers: boolean;
  // camera
  /** Vertical field of view, degrees. */
  fov: number;
  /** Camera shake strength, 0 (off) to 1. */
  shake: number;
  // graphics (the preset itself is in Quality.ts)
  showFps: boolean;
  /** Lower the render resolution by itself when the frame rate stays low. */
  autoResolution: boolean;
  /** Render resolution as a share of the screen's, 0.5 to 1. */
  resolution: number;
  /** Multiplier on the scene's exposure. */
  brightness: number;
  /** Frames per second cap, 0 for none (the display's rate). */
  frameCap: number;
  // accessibility
  teamColors: TeamColorMode;
  /** Size of the in-match HUD, 0.75 to 1.5. */
  uiScale: number;
  subtitles: boolean;
  subtitleSize: SubtitleSize;
  /** Opacity of the box behind subtitles, 0 to 1. */
  subtitleBackground: number;
  speakerNames: boolean;
  /** Softer hurt flashes, no low-health pulse, smaller impact flashes. */
  reduceFlashes: boolean;
  // sound (beside the engine's volumes)
  /** Silence the game while its tab or window is in the background. */
  muteInBackground: boolean;
}

export const DEFAULTS: Readonly<Omit<Settings, 'bindings' | 'padBindings'>> = {
  sensitivity: 1,
  invertY: false,
  padSensitivity: 1,
  padInvertY: false,
  padDeadzone: 0.14,
  vibration: 0.8,
  aimSlowdown: true,
  quickCast: false,
  damageNumbers: true,
  fov: 58,
  shake: 1,
  showFps: true,
  autoResolution: true,
  resolution: 1,
  brightness: 1,
  frameCap: 0,
  teamColors: 'default',
  uiScale: 1,
  subtitles: false,
  subtitleSize: 'medium',
  subtitleBackground: 0.6,
  speakerNames: true,
  reduceFlashes: false,
  muteInBackground: false,
};

export const LIMITS = {
  sensitivity: [0.25, 3],
  padSensitivity: [0.3, 3],
  padDeadzone: [0.05, 0.35],
  vibration: [0, 1],
  fov: [50, 75],
  shake: [0, 1],
  resolution: [0.5, 1],
  brightness: [0.7, 1.35],
  uiScale: [0.75, 1.5],
  subtitleBackground: [0, 1],
} as const satisfies Partial<Record<keyof Settings, readonly [number, number]>>;

export const FRAME_CAPS = [0, 30, 60, 120, 144] as const;
const TEAM_MODES: readonly TeamColorMode[] = ['default', 'redgreen', 'tritan', 'contrast'];
const SUB_SIZES: readonly SubtitleSize[] = ['small', 'medium', 'large', 'huge'];

const STORAGE_KEY = 'ascendant.settings';
/** Mouse sensitivity was saved on its own before the settings menu. */
const OLD_SENSITIVITY = 'ascendant.sensitivity';

/** Bring a saved object to a full, valid Settings: unknown or out-of-range values take the default. */
export function normalize(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (k: keyof typeof LIMITS) => {
    const v = r[k];
    const [lo, hi] = LIMITS[k];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULTS[k];
  };
  const bool = (k: keyof Settings) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (DEFAULTS[k as keyof typeof DEFAULTS] as boolean));
  const pick = <T extends string>(k: keyof Settings, list: readonly T[]) => (list.includes(r[k] as T) ? (r[k] as T) : (DEFAULTS[k as keyof typeof DEFAULTS] as T));
  return {
    sensitivity: num('sensitivity'),
    invertY: bool('invertY'),
    quickCast: bool('quickCast'),
    bindings: resolveBindings(r.bindings),
    padSensitivity: num('padSensitivity'),
    padInvertY: bool('padInvertY'),
    padDeadzone: num('padDeadzone'),
    vibration: num('vibration'),
    aimSlowdown: bool('aimSlowdown'),
    padBindings: resolvePadBindings(r.padBindings),
    damageNumbers: bool('damageNumbers'),
    fov: num('fov'),
    shake: num('shake'),
    showFps: bool('showFps'),
    autoResolution: bool('autoResolution'),
    resolution: num('resolution'),
    brightness: num('brightness'),
    frameCap: (FRAME_CAPS as readonly number[]).includes(r.frameCap as number) ? (r.frameCap as number) : DEFAULTS.frameCap,
    teamColors: pick('teamColors', TEAM_MODES),
    uiScale: num('uiScale'),
    subtitles: bool('subtitles'),
    subtitleSize: pick('subtitleSize', SUB_SIZES),
    subtitleBackground: num('subtitleBackground'),
    speakerNames: bool('speakerNames'),
    reduceFlashes: bool('reduceFlashes'),
    muteInBackground: bool('muteInBackground'),
  };
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));
    const old = Number(localStorage.getItem(OLD_SENSITIVITY));
    return normalize(old > 0 ? { sensitivity: old } : {});
  } catch {
    return normalize({});
  }
}

let current: Settings = load();
type Listener = (s: Settings, changed: ReadonlySet<keyof Settings>) => void;
const listeners: Listener[] = [];

export function settings(): Readonly<Settings> {
  return current;
}

/** Change some settings, save them, and tell every listener which keys moved. */
export function setSettings(patch: Partial<Settings>): void {
  const next = normalize({ ...current, ...patch });
  const changed = new Set<keyof Settings>();
  for (const k of Object.keys(next) as (keyof Settings)[]) {
    if (JSON.stringify(next[k]) !== JSON.stringify(current[k])) changed.add(k);
  }
  if (!changed.size) return;
  current = next;
  save();
  for (const l of listeners) l(current, changed);
}

/** Hear every change; also called once now so the listener starts in step. */
export function onSettings(fn: Listener, now = true): void {
  listeners.push(fn);
  if (now) fn(current, new Set(Object.keys(current) as (keyof Settings)[]));
}

function save(): void {
  try {
    const { bindings, padBindings, ...rest } = current;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...rest, bindings: bindingOverrides(bindings), padBindings: padOverrides(padBindings) }));
  } catch {
    /* storage unavailable */
  }
}

/** The inputs bound to an action, primary first. */
export function codesFor(a: Action): Binding {
  return current.bindings[a];
}

/** The controller button bound to an action, or null. */
export function padCodeFor(a: Action): string | null {
  return current.padBindings[a];
}

/** The action a keyboard code or mouse button triggers, or null. */
export function actionForCode(code: string): Action | null {
  for (const [a, b] of Object.entries(current.bindings) as [Action, Binding][]) if (b[0] === code || b[1] === code) return a;
  return null;
}

/** The action-bar slot a key or button casts with the current bindings, or -1. */
export function slotForCode(code: string): number {
  const a = actionForCode(code);
  return a ? SLOT_ACTIONS.indexOf(a) : -1;
}

/**
 * While the settings menu waits for a key to bind (or is open over the
 * game), the game itself hears no keys.
 */
export const keyGate = { blocked: false };

/** For a test: forget what's saved and start from the defaults. */
export function resetForTest(raw: unknown = {}): void {
  current = normalize(raw);
  listeners.length = 0;
}
