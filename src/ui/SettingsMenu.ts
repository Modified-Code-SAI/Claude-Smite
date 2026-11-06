import { AUDIO_DEFAULTS, type AudioEngine, type AudioSettings } from '../audio/AudioEngine';
import { QUALITY_PRESETS, type QualityName } from '../render/Quality';
import { ACTION_GROUPS, ACTIONS, actionDef, bindingLabel, defaultBindings, keyLabel, rebind, RESERVED, type Action } from '../settings/bindings';
import { DEFAULTS, FRAME_CAPS, keyGate, LIMITS, onSettings, setSettings, settings, type Settings } from '../settings/store';
import { TEAM_COLOR_SETS } from '../settings/teamColors';
import { onKeyLabels } from '../settings/controls';
import { defaultPadBindings, padLabel, rebindPad, STICK_ACTIONS } from '../settings/padBindings';
import { pad } from '../core/Gamepad';
import { padCursor } from './PadCursor';
import { compatibilityMode, setCompatibilityMode } from './Fatal';
import './settings.css';

export type SettingsTab = 'gameplay' | 'controls' | 'audio' | 'graphics' | 'access';

/** What the graphics tab needs from the game (main.ts registers it once the renderer exists). */
export interface GraphicsHooks {
  quality(): QualityName;
  setQuality(q: QualityName): void;
  /** WebGPU, or the WebGL 2 fallback. */
  webgpu: boolean;
}

const ICONS: Record<SettingsTab, string> = {
  gameplay: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/>',
  controls: '<rect x="2.5" y="6.5" width="19" height="11" rx="2"/><path d="M6 10h1.5M9.25 10h1.5M12.5 10H14M15.75 10h1.5M7 14h10"/>',
  audio: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/>',
  graphics: '<rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M8.5 20h7M12 16.5V20"/><path d="M6.5 13l3.5-4 2.5 3 2-2 3 3"/>',
  access: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="7.6" r="1.4"/><path d="M7.5 10.2l4.5 1 4.5-1M12 11.2v3.3l-2.4 4M12 14.5l2.4 4"/>',
};
const TABS: { id: SettingsTab; name: string; text: string }[] = [
  { id: 'gameplay', name: 'Gameplay', text: 'Camera, casting and combat feedback' },
  { id: 'controls', name: 'Controls', text: 'Mouse, keys and controller, all rebindable' },
  { id: 'audio', name: 'Audio', text: 'Volume for each part of the mix' },
  { id: 'graphics', name: 'Graphics', text: 'Quality, resolution and frame rate' },
  { id: 'access', name: 'Accessibility', text: 'Team colors, interface size, subtitles, motion' },
];

const QUALITY_TEXT: Record<QualityName, string> = {
  low: 'For integrated graphics. Lighter grass and shadows, no ambient occlusion.',
  medium: 'Sharper shadows and more grass. No ambient occlusion.',
  high: 'Ambient occlusion, temporal anti-aliasing, full grass. Best for most cards.',
  ultra: 'Largest shadows, densest grass, full-resolution occlusion. For fast cards.',
};

const pct = (v: number) => `${Math.round(v * 100)}%`;
type SliderKey = keyof typeof LIMITS;
const SLIDERS: Record<SliderKey, { step: number; format: (v: number) => string }> = {
  sensitivity: { step: 0.05, format: (v) => `${v.toFixed(2)}×` },
  padSensitivity: { step: 0.05, format: (v) => `${v.toFixed(2)}×` },
  padDeadzone: { step: 0.01, format: pct },
  vibration: { step: 0.05, format: (v) => (v <= 0 ? 'Off' : pct(v)) },
  fov: { step: 1, format: (v) => `${Math.round(v)}°` },
  shake: { step: 0.05, format: (v) => (v <= 0 ? 'Off' : pct(v)) },
  resolution: { step: 0.05, format: pct },
  brightness: { step: 0.01, format: pct },
  uiScale: { step: 0.05, format: pct },
  subtitleBackground: { step: 0.05, format: (v) => (v <= 0 ? 'None' : pct(v)) },
};

const AUDIO_ROWS: [keyof AudioSettings, string, string][] = [
  ['master', 'Master volume', 'Everything at once.'],
  ['music', 'Music', 'The score: the title hymn and each mode\'s battle music.'],
  ['sfx', 'Effects', 'Skills, hits, footsteps, monsters and structures.'],
  ['voice', 'Voices', 'The herald\'s calls and the gods\' and the giant\'s lines.'],
  ['ambience', 'Ambience', 'Wind, fire, water and the crowd around the world.'],
  ['ui', 'Interface', 'Menu clicks, pings and other interface sounds.'],
];

let engine: AudioEngine | null = null;
let graphics: GraphicsHooks | null = null;
let root: HTMLDivElement | null = null;
let content: HTMLDivElement;
let toast: HTMLDivElement;
let tab: SettingsTab = 'gameplay';
/** A binding cell waiting for its input: a key or mouse button (slot 0 or 1), or a controller button. */
let listening: { action: Action; slot: 0 | 1 | 'pad'; el: HTMLElement } | null = null;
let padTimer: ReturnType<typeof setTimeout> | 0 = 0;
let toastTimer: ReturnType<typeof setTimeout> | 0 = 0;
const openListeners: ((open: boolean) => void)[] = [];

export function settingsOpen(): boolean {
  return !!root?.classList.contains('show');
}

/** Hear the menu open and close (the game menu hides under it, the HUD hint waits). */
export function onSettingsMenu(fn: (open: boolean) => void): void {
  openListeners.push(fn);
}

/** Give the graphics tab its hooks into the renderer. */
export function setGraphicsHooks(h: GraphicsHooks): void {
  graphics = h;
  if (settingsOpen() && tab === 'graphics') render();
}

export function openSettings(at: SettingsTab = tab): void {
  if (!root) return;
  tab = at;
  render();
  root.classList.add('show');
  keyGate.blocked = true;
  document.exitPointerLock?.();
  root.querySelector<HTMLElement>(`.st-tab[data-tab="${tab}"]`)?.focus({ preventScroll: true });
  for (const f of openListeners) f(true);
}

export function closeSettings(): void {
  if (!root || !settingsOpen()) return;
  stopListening();
  root.classList.remove('show');
  keyGate.blocked = false;
  for (const f of openListeners) f(false);
}

/** A key or field the player is typing into: global hotkeys leave it alone. */
export function typing(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox';
}

/**
 * The settings menu: five tabs over the game or the title screen, every
 * change applied and saved the moment it's made. Opened by the gear by the
 * sound button, O (rebindable), or the game menu.
 */
export function mountSettings(audio: AudioEngine): void {
  engine = audio;
  root = document.createElement('div');
  root.className = 'st';
  root.innerHTML = `
    <div class="st-panel" role="dialog" aria-label="Settings">
      <div class="st-head"><div class="st-title">Settings</div><div class="st-sub"></div><button class="st-x" data-act="close" title="Close (Esc)" aria-label="Close">&times;</button></div>
      <div class="st-main">
        <nav class="st-nav">${TABS.map((t) => `<button class="st-tab" data-tab="${t.id}"><svg viewBox="0 0 24 24">${ICONS[t.id]}</svg><span><b>${t.name}</b><small>${t.text}</small></span></button>`).join('')}</nav>
        <div class="st-content"></div>
      </div>
      <div class="st-foot"><div class="st-toast"></div><span class="st-saved">Changes apply and save at once</span><button class="st-btn" data-act="reset">Reset this tab</button><button class="st-btn st-done" data-act="close">Done</button></div>
    </div>`;
  document.body.appendChild(root);
  content = root.querySelector('.st-content')!;
  toast = root.querySelector('.st-toast')!;

  const gear = document.createElement('button');
  gear.className = 'st-gear';
  gear.title = 'Settings';
  gear.setAttribute('aria-label', 'Settings');
  gear.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.4a3.4 3.4 0 1 1 0-6.8 3.4 3.4 0 0 1 0 6.8z" transform="translate(-1 0)"/></svg>`;
  gear.addEventListener('click', (e) => {
    e.stopPropagation();
    if (settingsOpen()) closeSettings();
    else openSettings();
  });
  gear.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.appendChild(gear);

  // clicks on the menu never reach the game (or capture the mouse)
  root.addEventListener('mousedown', (e) => e.stopPropagation());
  root.addEventListener('click', (e) => {
    if (e.target === root) closeSettings();
  });
  root.querySelector('.st-nav')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab as SettingsTab;
    stopListening();
    render();
  });
  root.querySelectorAll<HTMLElement>('[data-act="close"]').forEach((b) => b.addEventListener('click', () => closeSettings()));
  root.querySelector('[data-act="reset"]')!.addEventListener('click', () => resetTab());

  content.addEventListener('input', (e) => onInput(e.target as HTMLInputElement));
  content.addEventListener('change', (e) => onInput(e.target as HTMLInputElement));
  content.addEventListener('click', (e) => onClick(e));

  // keys while open: the menu's own (Esc, a key to bind), never the game's
  window.addEventListener(
    'keydown',
    (e) => {
      if (!settingsOpen()) {
        if (!e.repeat && !keyGate.blocked && !typing(e) && settings().bindings.settings.includes(e.code)) {
          e.preventDefault();
          openSettings();
        }
        return;
      }
      e.stopImmediatePropagation();
      if (listening) {
        e.preventDefault();
        if (e.code === 'Escape') stopListening();
        else if (!e.repeat) bindTo(e.code);
        return;
      }
      if (e.code === 'Escape') {
        e.preventDefault();
        closeSettings();
      }
    },
    true,
  );
  window.addEventListener(
    'mousedown',
    (e) => {
      if (!listening) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (listening.slot === 'pad') stopListening();
      else bindTo(`Mouse${e.button}`);
    },
    true,
  );
  window.addEventListener('contextmenu', (e) => {
    if (settingsOpen()) e.preventDefault();
  });

  onSettings(() => {
    if (settingsOpen()) sync();
  }, false);
  audio.onSettings(() => {
    if (settingsOpen()) sync();
  });
  onKeyLabels(() => {
    if (settingsOpen() && tab === 'controls') render();
  });
  // a controller plugged in or out: the controller section says so
  let padName = pad.name;
  pad.onChange(() => {
    if (pad.name === padName) return;
    padName = pad.name;
    if (settingsOpen() && tab === 'controls' && !listening) render();
  });
  // LB and RB change tabs
  padCursor.tabs = (dir) => {
    if (!settingsOpen()) return false;
    const i = TABS.findIndex((t) => t.id === tab);
    tab = TABS[(i + dir + TABS.length) % TABS.length]!.id;
    stopListening();
    render();
    root!.querySelector<HTMLElement>(`.st-tab[data-tab="${tab}"]`)?.focus({ preventScroll: true });
    return true;
  };
}

// ---------------------------------------------------------------------------
// Rows

const row = (key: string, label: string, text: string, control: string, extra = '') =>
  `<div class="st-row${extra}" data-row="${key}"><div class="st-label"><b>${label}</b><span>${text}</span></div><div class="st-ctl">${control}</div></div>`;

const heading = (text: string) => `<h3 class="st-h">${text}</h3>`;

function slider(key: SliderKey, label: string, text: string): string {
  const [min, max] = LIMITS[key];
  const { step } = SLIDERS[key];
  return row(key, label, text, `<input type="range" class="st-range" data-set="${key}" min="${min}" max="${max}" step="${step}"><output class="st-val" data-val-of="${key}"></output>`);
}

function toggle(key: keyof Settings, label: string, text: string): string {
  return row(key, label, text, `<label class="st-switch"><input type="checkbox" data-set="${key}"><i></i></label>`);
}

function choice(key: keyof Settings, label: string, text: string, options: [string | number, string][]): string {
  return row(key, label, text, `<div class="st-seg">${options.map(([v, l]) => `<button class="st-opt" data-set="${key}" data-val="${v}">${l}</button>`).join('')}</div>`);
}

function audioSlider(key: keyof AudioSettings, label: string, text: string): string {
  return row(`audio-${key}`, label, text, `<input type="range" class="st-range" data-audio="${key}" min="0" max="1" step="0.01"><output class="st-val" data-val-of="audio-${key}"></output>`);
}

function gameplayTab(): string {
  return [
    heading('Camera'),
    slider('fov', 'Field of view', 'How wide the camera sees. Wider shows more of the fight around you; narrower brings it closer.'),
    heading('Combat'),
    toggle('quickCast', 'Quick cast', 'Skills fire at the crosshair the moment their key goes down, with no aiming preview. Faster, but less precise.'),
    toggle('damageNumbers', 'Damage numbers', 'Numbers float up from everything you hit and heal.'),
    heading('Help'),
    row('tips', 'First-time tips', 'Tips for new players show once each. Bring them all back for your next match.', `<button class="st-btn" data-act="tips">Show tips again</button>`),
  ].join('');
}

function keyCell(a: Action, slot: 0 | 1): string {
  const code = settings().bindings[a][slot];
  const label = code ? keyLabel(code) : '';
  return `<button class="st-key${code ? '' : ' empty'}" data-bind="${a}" data-slot="${slot}" title="Click, then press a key or mouse button (Esc cancels)"><span>${label || '—'}</span>${code ? `<i data-clear="${a}" data-slot="${slot}" title="Unbind">&times;</i>` : ''}</button>`;
}

function controlsTab(): string {
  const groups = ACTION_GROUPS.map((g) => {
    const rows = ACTIONS.filter((a) => a.group === g)
      .map((a) => `<div class="st-bind" data-action="${a.id}"><div class="st-label"><b>${a.name}</b>${a.hint ? `<span>${a.hint}</span>` : ''}</div>${keyCell(a.id, 0)}${keyCell(a.id, 1)}</div>`)
      .join('');
    return `<h4 class="st-bind-group">${g}</h4>${rows}`;
  }).join('');
  return [
    heading('Mouse'),
    slider('sensitivity', 'Mouse sensitivity', 'How far the camera turns for each move of the mouse.'),
    toggle('invertY', 'Invert vertical look', 'Moving the mouse up looks down.'),
    heading('Keys'),
    `<div class="st-binds"><div class="st-bind st-bind-head"><span>Action</span><span>Primary</span><span>Secondary</span></div>${groups}</div>`,
    `<div class="st-row st-row-end"><div class="st-label"><span>Esc always frees the mouse and closes menus, so it can't be bound. A key taken from another action swaps with it.</span></div><div class="st-ctl"><button class="st-btn" data-act="reset-keys">Reset all keys</button></div></div>`,
    ...controllerSection(),
  ].join('');
}

function padCell(a: Action): string {
  const code = settings().padBindings[a];
  const label = padLabel(code, pad.family);
  return `<button class="st-key st-padkey${code ? '' : ' empty'}" data-padbind="${a}" title="Click, then press a controller button"><span>${label || '—'}</span>${code ? `<i data-padclear="${a}" title="Unbind">&times;</i>` : ''}</button>`;
}

function controllerSection(): string[] {
  const status = pad.connected
    ? `<b>${pad.name.replace(/[<&>]/g, '')}</b><span>Connected. The game shows its buttons whenever you play with it, and its cursor runs the menus.</span>`
    : `<b>No controller found</b><span>Plug one in or pair it, then press any button on it. Xbox, PlayStation and Switch Pro controllers name their own buttons.</span>`;
  const groups = ACTION_GROUPS.map((g) => {
    const rows = ACTIONS.filter((a) => a.group === g && !STICK_ACTIONS.includes(a.id))
      .map((a) => `<div class="st-bind st-bind-pad" data-action="${a.id}"><div class="st-label"><b>${a.name}</b>${a.group === 'Mode picks' && a.id === 'pick1' ? '<span>Only while a pick is offered, so they can share the D-pad with the ping, recall and trees</span>' : ''}</div>${padCell(a.id)}</div>`)
      .join('');
    const sticks = g === 'Movement' ? `<div class="st-bind st-bind-pad"><div class="st-label"><b>Move</b></div><span class="st-fixed">Left stick</span></div><div class="st-bind st-bind-pad"><div class="st-label"><b>Aim and look</b></div><span class="st-fixed">Right stick</span></div>` : '';
    return `<h4 class="st-bind-group">${g}</h4>${sticks}${rows}`;
  }).join('');
  return [
    heading('Controller'),
    `<div class="st-row st-pad-status${pad.connected ? ' on' : ''}" data-row="pad"><svg viewBox="0 0 24 24" class="st-pad-icon"><path d="M7.5 7h9a4.5 4.5 0 0 1 4.4 3.6l.9 4.6a2.6 2.6 0 0 1-4.6 2.1L15.6 15H8.4l-1.6 2.3a2.6 2.6 0 0 1-4.6-2.1l.9-4.6A4.5 4.5 0 0 1 7.5 7z"/><path d="M7.5 10v3M6 11.5h3"/><circle cx="15.5" cy="10.6" r=".6"/><circle cx="17.3" cy="12.4" r=".6"/></svg><div class="st-label">${status}</div></div>`,
    slider('padSensitivity', 'Look speed', 'How fast the right stick turns the camera. Holding it hard over speeds the turn up for a quick about-face.'),
    toggle('padInvertY', 'Invert vertical look', 'Pushing the right stick up looks down.'),
    slider('padDeadzone', 'Stick dead zone', 'How far a stick moves before it counts. Raise it if your god drifts or the camera creeps with the sticks at rest.'),
    slider('vibration', 'Vibration', 'Rumble when you are hit and from big blasts near you.'),
    toggle('aimSlowdown', 'Aim slowdown', 'The camera turns a little slower while the crosshair is on an enemy in reach, so the stick can hold a target.'),
    heading('Controller buttons'),
    `<div class="st-binds st-binds-pad"><div class="st-bind st-bind-pad st-bind-head"><span>Action</span><span>Button</span></div>${groups}</div>`,
    `<div class="st-row st-row-end"><div class="st-label"><span>A button taken from another action swaps with it. In menus the left stick moves the cursor, ${padLabel('Pad0', pad.family)} selects, ${padLabel('Pad1', pad.family)} goes back and ${padLabel('Pad4', pad.family)} / ${padLabel('Pad5', pad.family)} change tabs.</span></div><div class="st-ctl"><button class="st-btn" data-act="reset-pad">Reset controller buttons</button></div></div>`,
  ];
}

function audioTab(): string {
  return [
    heading('Volume'),
    ...AUDIO_ROWS.map(([k, l, t]) => audioSlider(k, l, t)),
    heading('Output'),
    row('audio-muted', 'Mute all sound', `Silence everything (${bindingLabel(settings().bindings.mute)} in game).`, `<label class="st-switch"><input type="checkbox" data-audio="muted"><i></i></label>`),
    toggle('muteInBackground', 'Mute in the background', 'Silence the game while you are in another tab or window.'),
  ].join('');
}

function graphicsTab(): string {
  const q = graphics?.quality();
  const quality = `<div class="st-cards">${(Object.keys(QUALITY_PRESETS) as QualityName[])
    .map((name) => `<button class="st-card${name === q ? ' on' : ''}" data-q="${name}"${graphics ? '' : ' disabled'}><b>${QUALITY_PRESETS[name].label}</b><span>${QUALITY_TEXT[name]}</span></button>`)
    .join('')}</div>`;
  const compat = compatibilityMode();
  const backend = graphics ? (graphics.webgpu ? 'WebGPU' : compat ? 'WebGL 2 (compatibility mode)' : 'WebGL 2') : 'Starting…';
  return [
    heading('Quality'),
    `<div class="st-row st-row-wide" data-row="quality"><div class="st-label"><b>Quality preset</b><span>Shadows, ambient occlusion, grass, anti-aliasing and lights. Changing it mid-match takes a moment while the new shaders build.</span></div>${quality}</div>`,
    heading('Resolution and frame rate'),
    toggle('autoResolution', 'Automatic resolution', 'Lower the render resolution by itself when the frame rate stays under 45, so a slower machine stays smooth.'),
    slider('resolution', 'Render resolution', 'Draw the scene at a share of your screen\'s resolution. Lower is faster and softer.'),
    choice('frameCap', 'Frame rate cap', 'Hold the frame rate down, for a cooler laptop and longer battery. Off runs at your display\'s rate.', FRAME_CAPS.map((c) => [c, c ? String(c) : 'Off'])),
    heading('Picture'),
    slider('brightness', 'Brightness', 'The scene\'s exposure. The interface is not affected.'),
    toggle('showFps', 'Performance panel', 'Frame rate, graphics card and the quick quality picker, top right.'),
    heading('Renderer'),
    row('renderer', 'Graphics backend', `Now: ${backend}. Compatibility mode uses WebGL 2, for black screens or glitches on older drivers. Switching restarts the game.`, `<button class="st-btn" data-act="compat">${compat ? 'Switch to WebGPU' : 'Use compatibility mode'}</button>`),
  ].join('');
}

function accessTab(): string {
  const mode = settings().teamColors;
  const team = `<div class="st-cards st-teams">${(Object.keys(TEAM_COLOR_SETS) as (keyof typeof TEAM_COLOR_SETS)[])
    .map((k) => {
      const s = TEAM_COLOR_SETS[k];
      const c = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
      return `<button class="st-card st-team${k === mode ? ' on' : ''}" data-set="teamColors" data-val="${k}"><div class="st-team-art"><em style="--c:${s.bars.ally}"><i style="width:78%"></i></em><em style="--c:${s.bars.enemy}"><i style="width:56%"></i></em><span><i style="background:${c(s.ally.main)}"></i><i style="background:${c(s.foe.main)}"></i><i style="background:${s.bars.self}"></i></span></div><b>${s.name}</b><span>${s.text}</span></button>`;
    })
    .join('')}</div>`;
  return [
    heading('Color'),
    `<div class="st-row st-row-wide" data-row="teamColors"><div class="st-label"><b>Team colors</b><span>The colors that tell your side from theirs: health bars, the minimap, radars, scores and world marks. Minions and structures keep their banner colors.</span></div>${team}</div>`,
    heading('Interface'),
    slider('uiScale', 'Interface scale', 'Size of the in-match HUD: your bars and skills, scores, the minimap and radars, banners and tips.'),
    heading('Motion and flashes'),
    slider('shake', 'Screen shake', 'How hard the camera shakes from hits and big blasts.'),
    toggle('reduceFlashes', 'Reduce flashing', 'A softer red flash when you are hit, no pulsing at low health, and smaller impact flashes.'),
    heading('Subtitles'),
    toggle('subtitles', 'Subtitles', 'Show what the herald, the gods and the giant say, even with voices muted.'),
    choice('subtitleSize', 'Subtitle size', 'How large subtitles are.', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['huge', 'Huge']]),
    slider('subtitleBackground', 'Subtitle background', 'How dark the box behind subtitles is.'),
    toggle('speakerNames', 'Speaker names', 'Name who is talking before each line.'),
    `<div class="st-subs-preview"><div class="sub-line"><b class="sub-who" style="color:#e7c27a">Herald</b><span>The enemy Titan is exposed!</span></div></div>`,
  ].join('');
}

function render(): void {
  if (!root) return;
  root.querySelectorAll<HTMLElement>('.st-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  root.querySelector('.st-sub')!.textContent = TABS.find((t) => t.id === tab)!.text;
  const scroll = content.dataset.tab === tab ? content.scrollTop : 0;
  content.dataset.tab = tab;
  content.innerHTML = tab === 'gameplay' ? gameplayTab() : tab === 'controls' ? controlsTab() : tab === 'audio' ? audioTab() : tab === 'graphics' ? graphicsTab() : accessTab();
  content.scrollTop = scroll;
  sync();
}

/** Bring every control in the tab to the current values (no rebuild, so a dragged slider keeps its grip). */
function sync(): void {
  const s = settings();
  const a = engine?.settings;
  content.querySelectorAll<HTMLInputElement>('input[data-set]').forEach((i) => {
    const k = i.dataset.set as keyof Settings;
    if (i.type === 'checkbox') i.checked = !!s[k];
    else i.value = String(s[k]);
    if (i.type === 'range') fill(i);
  });
  content.querySelectorAll<HTMLInputElement>('input[data-audio]').forEach((i) => {
    const k = i.dataset.audio as keyof AudioSettings;
    if (!a) return;
    if (i.type === 'checkbox') i.checked = !!a[k];
    else {
      i.value = String(a[k]);
      fill(i);
    }
  });
  content.querySelectorAll<HTMLOutputElement>('output[data-val-of]').forEach((o) => {
    const k = o.dataset.valOf!;
    if (k.startsWith('audio-')) o.textContent = a ? String(Math.round((a[k.slice(6) as keyof AudioSettings] as number) * 100)) : '';
    else o.textContent = SLIDERS[k as SliderKey].format(s[k as SliderKey]);
  });
  content.querySelectorAll<HTMLElement>('[data-val][data-set]').forEach((b) => b.classList.toggle('on', String(s[b.dataset.set as keyof Settings]) === b.dataset.val));
  // a row that does nothing with its parent setting off is dimmed
  dim('subtitleSize', !s.subtitles);
  dim('subtitleBackground', !s.subtitles);
  dim('speakerNames', !s.subtitles);
  const preview = content.querySelector<HTMLElement>('.st-subs-preview');
  if (preview) {
    preview.dataset.size = s.subtitleSize;
    preview.style.setProperty('--sub-bg', String(s.subtitleBackground));
    preview.classList.toggle('no-names', !s.speakerNames);
    preview.classList.toggle('off', !s.subtitles);
  }
}

function dim(key: string, off: boolean): void {
  content.querySelector(`[data-row="${key}"]`)?.classList.toggle('dim', off);
}

/** A range input's gold fill up to its thumb. */
function fill(i: HTMLInputElement): void {
  const min = Number(i.min);
  const max = Number(i.max);
  i.style.setProperty('--p', `${((Number(i.value) - min) / (max - min)) * 100}%`);
}

function onInput(i: HTMLInputElement): void {
  if (i.dataset.set) {
    const k = i.dataset.set as keyof Settings;
    setSettings({ [k]: i.type === 'checkbox' ? i.checked : Number(i.value) } as Partial<Settings>);
    // feel the strength just picked
    if (k === 'vibration') pad.rumble(0.7, 200);
  } else if (i.dataset.audio && engine) {
    const k = i.dataset.audio as keyof AudioSettings;
    engine.setSettings({ [k]: i.type === 'checkbox' ? i.checked : Number(i.value) });
  }
}

function onClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const clear = t.closest<HTMLElement>('[data-clear]');
  if (clear) {
    e.stopPropagation();
    const { bindings } = rebind(settings().bindings, clear.dataset.clear as Action, Number(clear.dataset.slot) as 0 | 1, null);
    setSettings({ bindings });
    render();
    return;
  }
  const padClear = t.closest<HTMLElement>('[data-padclear]');
  if (padClear) {
    e.stopPropagation();
    setSettings({ padBindings: rebindPad(settings().padBindings, padClear.dataset.padclear as Action, null).bindings });
    render();
    return;
  }
  const padKey = t.closest<HTMLElement>('[data-padbind]');
  if (padKey) {
    startListening(padKey.dataset.padbind as Action, 'pad', padKey);
    return;
  }
  const key = t.closest<HTMLElement>('[data-bind]');
  if (key) {
    startListening(key.dataset.bind as Action, Number(key.dataset.slot) as 0 | 1, key);
    return;
  }
  const opt = t.closest<HTMLElement>('[data-val][data-set]');
  if (opt) {
    const k = opt.dataset.set as keyof Settings;
    const raw = opt.dataset.val!;
    setSettings({ [k]: /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw } as Partial<Settings>);
    if (k === 'teamColors') render();
    return;
  }
  const q = t.closest<HTMLElement>('[data-q]');
  if (q && graphics) {
    graphics.setQuality(q.dataset.q as QualityName);
    render();
    return;
  }
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'reset-keys') {
    setSettings({ bindings: defaultBindings() });
    say('Every key is back to its default.');
    render();
  } else if (act === 'reset-pad') {
    setSettings({ padBindings: defaultPadBindings() });
    say('Every controller button is back to its default.');
    render();
  } else if (act === 'tips') {
    try {
      localStorage.removeItem('ascendant.coachSeen');
    } catch {
      /* storage unavailable */
    }
    say('Tips will show again from your next match.');
  } else if (act === 'compat') {
    setCompatibilityMode(!compatibilityMode());
  }
}

function startListening(action: Action, slot: 0 | 1 | 'pad', el: HTMLElement): void {
  stopListening();
  listening = { action, slot, el };
  el.classList.add('listening');
  if (slot === 'pad') {
    el.querySelector('span')!.textContent = 'Press a button…';
    say(`Press a controller button for ${actionDef(action).name}. A click or Esc cancels.`, 0);
    // (the press that chose this cell is already in; the next one binds)
    pad.listen = (code) => bindPad(code);
    padTimer = setTimeout(() => stopListening(), 8000);
    return;
  }
  el.querySelector('span')!.textContent = 'Press a key…';
  say(`Press a key or mouse button for ${actionDef(action).name}. Esc cancels.`, 0);
}

function stopListening(): void {
  if (!listening) return;
  const { el, action, slot } = listening;
  listening = null;
  pad.listen = null;
  if (padTimer) clearTimeout(padTimer);
  padTimer = 0;
  el.classList.remove('listening');
  const label = slot === 'pad' ? padLabel(settings().padBindings[action], pad.family) : keyLabel(settings().bindings[action][slot]);
  el.querySelector('span')!.textContent = label || '—';
  say('');
}

function bindPad(code: string): void {
  if (!listening || listening.slot !== 'pad') return;
  const { action } = listening;
  if (padTimer) clearTimeout(padTimer);
  padTimer = 0;
  listening = null;
  const { bindings, movedFrom } = rebindPad(settings().padBindings, action, code);
  setSettings({ padBindings: bindings });
  render();
  const name = actionDef(action).name;
  const label = padLabel(code, pad.family);
  if (movedFrom) {
    const now = padLabel(bindings[movedFrom], pad.family);
    say(`${label} moved from ${actionDef(movedFrom).name} to ${name}. ${actionDef(movedFrom).name} is now ${now ? `on ${now}` : 'unbound'}.`, 6);
  } else say(`${name}: ${label}.`, 2.5);
}

function bindTo(code: string): void {
  if (!listening || RESERVED.has(code)) return;
  const { action, slot } = listening;
  if (slot === 'pad') return;
  const before = settings().bindings;
  const { bindings, movedFrom } = rebind(before, action, slot, code);
  listening = null;
  setSettings({ bindings });
  render();
  const name = actionDef(action).name;
  if (movedFrom) {
    const now = bindingLabel(bindings[movedFrom]);
    say(`${keyLabel(code)} moved from ${actionDef(movedFrom).name} to ${name}. ${actionDef(movedFrom).name} is now ${now === 'Unbound' ? 'unbound' : `on ${now}`}.`, 6);
  } else say(`${name}: ${keyLabel(code)}.`, 2.5);
  // the click that bound the left button must not land on whatever is under it
  if (code === 'Mouse0') {
    const swallow = (e: Event) => e.stopPropagation();
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 700);
  }
}

/** A line in the footer; `seconds` 0 keeps it until replaced. */
function say(text: string, seconds = 4): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = 0;
  toast.textContent = text;
  toast.classList.toggle('show', !!text);
  if (text && seconds > 0) toastTimer = setTimeout(() => toast.classList.remove('show'), seconds * 1000);
}

function resetTab(): void {
  const keys: Record<SettingsTab, (keyof typeof DEFAULTS)[]> = {
    gameplay: ['fov', 'quickCast', 'damageNumbers'],
    controls: ['sensitivity', 'invertY', 'padSensitivity', 'padInvertY', 'padDeadzone', 'vibration', 'aimSlowdown'],
    audio: ['muteInBackground'],
    graphics: ['autoResolution', 'resolution', 'frameCap', 'brightness', 'showFps'],
    access: ['teamColors', 'uiScale', 'shake', 'reduceFlashes', 'subtitles', 'subtitleSize', 'subtitleBackground', 'speakerNames'],
  };
  const patch: Partial<Settings> = {};
  for (const k of keys[tab]) (patch as Record<string, unknown>)[k] = DEFAULTS[k];
  if (tab === 'controls') {
    patch.bindings = defaultBindings();
    patch.padBindings = defaultPadBindings();
  }
  setSettings(patch);
  if (tab === 'audio') engine?.setSettings({ ...AUDIO_DEFAULTS });
  render();
  say(`${TABS.find((t) => t.id === tab)!.name} settings are back to their defaults.`);
}
