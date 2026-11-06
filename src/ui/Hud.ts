import { QUALITY_PRESETS, type QualityName } from '../render/Quality';
import { controlsHtml } from './StartMenu';
import { setCompatibilityMode } from './Fatal';
import { openSettings } from './SettingsMenu';
import { bindingLabel } from '../settings/bindings';
import { onKeyLabels } from '../settings/controls';
import { settings } from '../settings/store';

/** The hint's second line: how to reach the menus, with the player's keys. */
const menuLine = () => {
  const b = settings().bindings;
  return `${bindingLabel(b.menu)} game menu &middot; ${bindingLabel(b.settings)} settings &middot; Esc frees the mouse`;
};

/** Minimal overlay: FPS, backend, quality picker, controls hint, loading screen. */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly fps: HTMLSpanElement;
  private readonly stats: HTMLSpanElement;
  private readonly loading: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private frames = 0;
  private acc = 0;

  constructor(onQuality: (q: QualityName) => void) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-panel">
        <span class="hud-fps">-- fps</span>
        <span class="hud-stats"></span>
        <label>Quality
          <select class="hud-quality">
            ${Object.values(QUALITY_PRESETS).map((p) => `<option value="${p.name}">${p.label}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="hud-crosshair"></div>
      <div class="hud-hint"><b>Click to play</b><span>WASD move &middot; mouse aim &middot; left click attack &middot; 1&ndash;3 skills &middot; 4 or R ultimate</span><span class="hud-hint-menu"></span></div>
      <div class="hud-loading"><div class="hud-title">ASCENDANT</div><div class="hud-bar"><div></div></div><div class="hud-sub">Raising the temple&hellip;</div></div>
    `;
    document.body.appendChild(this.root);
    this.help = document.createElement('div');
    this.help.className = 'help';
    this.help.innerHTML = `<div class="help-panel"><h3>Controls</h3>${controlsHtml()}
      <div class="help-row help-settings"><button class="help-open-settings">Settings</button><button class="help-open-keys">Change keys</button><span class="help-report-note">Sound, graphics, team colors, interface size, subtitles and every key.</span></div>
      <h3 class="help-gap">Performance</h3>
      <div class="help-row"><button class="help-report">Copy performance report</button><span class="help-report-note">Frame timings from the last minute of play, to paste into a lag report.</span></div>
      <div class="help-actions"><button class="help-resume">Resume</button><button class="help-quit">Quit to title</button></div>
      <div class="help-foot">Press <span class="help-menu-key">H</span> to close.</div></div>`;
    this.help.addEventListener('click', (e) => {
      if (e.target === this.help) this.toggleHelp(false);
    });
    this.help.addEventListener('mousedown', (e) => e.stopPropagation());
    this.help.querySelector('.help-resume')!.addEventListener('click', () => this.toggleHelp(false));
    this.help.querySelector('.help-quit')!.addEventListener('click', () => location.reload());
    const helpKey = this.help.querySelector<HTMLSpanElement>('.help-menu-key')!;
    const setHelpKey = () => (helpKey.textContent = bindingLabel(settings().bindings.menu));
    setHelpKey();
    onKeyLabels(setHelpKey);
    this.help.querySelector('.help-open-settings')!.addEventListener('click', () => openSettings());
    this.help.querySelector('.help-open-keys')!.addEventListener('click', () => openSettings('controls'));
    this.help.querySelector('.help-report')!.addEventListener('click', () => this.copyReport());
    document.body.appendChild(this.help);
    this.fps = this.root.querySelector('.hud-fps')!;
    this.stats = this.root.querySelector('.hud-stats')!;
    this.loading = this.root.querySelector('.hud-loading')!;
    this.bar = this.root.querySelector('.hud-bar > div')!;
    this.hint = this.root.querySelector('.hud-hint')!;
    const menuHint = this.root.querySelector<HTMLSpanElement>('.hud-hint-menu')!;
    menuHint.innerHTML = menuLine();
    onKeyLabels(() => (menuHint.innerHTML = menuLine()));
    const select = this.root.querySelector<HTMLSelectElement>('.hud-quality')!;
    select.addEventListener('change', () => {
      onQuality(select.value as QualityName);
      select.blur();
    });
    this.setQuality = (q) => (select.value = q);
  }

  setQuality: (q: QualityName) => void;

  /** Builds the text the performance report button copies. */
  report: (() => string) | null = null;

  private copyReport(): void {
    if (!this.report) return;
    const text = this.report();
    const note = this.help.querySelector<HTMLSpanElement>('.help-report-note')!;
    const show = () => {
      // no clipboard access: show the text selected, ready for Ctrl+C
      let box = this.help.querySelector<HTMLTextAreaElement>('.help-report-text');
      if (!box) {
        box = document.createElement('textarea');
        box.className = 'help-report-text';
        box.readOnly = true;
        this.help.querySelector('.help-report')!.parentElement!.after(box);
      }
      box.value = text;
      box.select();
      note.textContent = 'Press Ctrl+C to copy the selected report.';
    };
    if (!navigator.clipboard) return show();
    navigator.clipboard.writeText(text).then(() => (note.textContent = 'Copied. Paste it into your message.'), show);
  }

  progress(f: number, text?: string): void {
    this.bar.style.width = `${Math.round(f * 100)}%`;
    if (text) this.root.querySelector('.hud-sub')!.textContent = text;
    this.loaded = { f, text: text ?? this.loaded.text };
    this.progressTo?.(f, text);
  }

  private loaded: { f: number; text?: string } = { f: 0 };
  private progressTo: ((f: number, text?: string) => void) | null = null;
  /** Where the slow-shaders note goes when another screen shows the loading (the god pick). */
  notesHost: HTMLElement | null = null;

  /** Another screen shows the loading progress too (it hears how far along it is now, then every step). */
  mirrorProgress(to: (f: number, text?: string) => void): void {
    this.progressTo = to;
    to(this.loaded.f, this.loaded.text);
  }

  /** Shown when shaders take long: says the wait is normal and offers the WebGL 2 renderer. */
  slowLoad(webgpu: boolean): void {
    if (this.loading.querySelector('.hud-slow') || this.notesHost?.querySelector('.hud-slow')) return;
    const el = document.createElement('div');
    el.className = 'hud-slow';
    el.textContent = 'Your graphics driver is still building shaders. This is only slow the first time.';
    if (webgpu) {
      const btn = document.createElement('button');
      btn.textContent = 'Too slow? Restart in compatibility mode (WebGL 2)';
      btn.addEventListener('click', () => setCompatibilityMode(true));
      el.appendChild(btn);
    }
    (this.notesHost ?? this.loading).appendChild(el);
  }

  ready(): void {
    this.loading.classList.add('done');
    setTimeout(() => this.loading.remove(), 1200);
  }

  get helpOpen(): boolean {
    return this.help.classList.contains('show');
  }

  toggleHelp(show = !this.helpOpen): void {
    this.help.classList.toggle('show', show);
    if (show) document.exitPointerLock?.();
  }

  setLocked(locked: boolean): void {
    this.hint.classList.toggle('hidden', locked);
    // keys in play must not type into a focused control (the quality picker jumps on letters)
    if (locked && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  /** A short message that fades on its own. */
  notice(text: string, seconds = 4): void {
    const el = document.createElement('div');
    el.className = 'hud-notice';
    el.textContent = text;
    this.root.appendChild(el);
    setTimeout(() => el.classList.add('gone'), seconds * 1000);
    setTimeout(() => el.remove(), seconds * 1000 + 1000);
  }

  setInfo(text: string): void {
    this.stats.textContent = text;
  }

  frame(dt: number): void {
    this.frames++;
    this.acc += dt;
    if (this.acc >= 0.5) {
      this.fps.textContent = `${Math.round(this.frames / this.acc)} fps`;
      this.frames = 0;
      this.acc = 0;
    }
  }

  error(message: string): void {
    this.loading.classList.remove('done');
    this.root.querySelector('.hud-sub')!.textContent = message;
  }
}
