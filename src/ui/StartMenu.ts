import { controlRows } from '../settings/controls';
import { openSettings } from './SettingsMenu';
import { compatibilityMode, setCompatibilityMode } from './Fatal';
import type { GpuAdvice } from '../render/gpuAdvice';
import { mountLobby } from '../net/LobbyPanel';
import type { NetGameInfo } from '../net/roster';
import type { NetSession } from '../net/Session';
import './start.css';
import { DIFFICULTIES, parseDifficulty, type Difficulty } from '../game/difficulty';
import { recordLine } from './records';
import { heroArt, HEROES } from './heroArt';
import { paletteFor } from '../combat/palette';
import { rankBadge } from './ascension';
import type { JotunnRole } from '../combat/JotunnMode';
import { MODES, modeArt, modeInfo, modeThumb, type GameMode } from './modes';
import { embersHtml, parallax } from './menuFx';

export { mapOf, type GameMode } from './modes';

/** What the home page decides: the mode and its options (the god is picked on the next screen). */
export interface ModeChoice {
  mode: GameMode;
  /** An online match (the lobby's players and connections). */
  net?: NetSession;
  difficulty?: Difficulty;
  /** Underworld Descent alone: whether bots join your team, and whether a bot team descends against yours. */
  allies?: boolean;
  rivals?: boolean;
  /** The Jötunn: who plays the giant on your own (online, every player takes a turn). */
  role?: JotunnRole;
}

/** Everything a match starts from: the home page's choice and the god pick's. */
export interface StartChoice extends ModeChoice {
  god: string;
  /** Temple Duel: the rival god's id, or '' for a random one. */
  rival?: string;
  /** Picks the bots' gods, so the match plays the lineup the pick screen showed (src/game/lineup.ts). */
  seed?: number;
}

const STORAGE_KEY = 'ascendant.start';

/** Who plays the giant in a Jötunn match on your own. */
const GIANT_ROLES: { id: JotunnRole; name: string; text: string }[] = [
  { id: 'rotate', name: 'Take turns', text: 'Two rounds: a bot is the giant first, then you are' },
  { id: 'giant', name: 'Me', text: 'One round as the giant' },
  { id: 'god', name: 'A bot', text: 'One round as a god against a bot giant' },
];

function parseGiantRole(s: unknown): JotunnRole {
  return s === 'giant' || s === 'god' ? s : 'rotate';
}

/**
 * The controls, shared by the home page and the in-game help (H), as the
 * player has bound them (Settings > Controls). A snapshot: `controlsHtml()`
 * reads the bindings fresh each time.
 */
export const CONTROLS: [string, string][] = controlRows();

export function controlsHtml(): string {
  return `<div class="sm-controls">${controlRows().map(([k, v]) => `<div class="sm-key">${k}</div><div>${v}</div>`).join('')}</div>`;
}

interface Saved extends Partial<StartChoice> {}

function load(): Saved {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Saved;
  } catch {
    return {};
  }
}

const isMode = (m: unknown): m is GameMode => MODES.some((x) => x.id === m);

/** The mode the home page opens with: the last one played, Conquest at first. */
export function savedMode(): GameMode {
  const m = load().mode;
  return isMode(m) ? m : 'conquest';
}

/** The god the pick screen starts on (the last one played), and the last Duel rival. */
export function savedPick(): { god: string | undefined; rival: string } {
  const s = load();
  return { god: s.god, rival: typeof s.rival === 'string' ? s.rival : '' };
}

/** Remember the choices for next time (merged into what is kept). */
export function saveChoice(c: Partial<StartChoice>): void {
  try {
    const { net: _net, seed: _seed, ...keep } = c;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...load(), ...keep }));
  } catch {
    /* storage unavailable */
  }
}

/** A warning under the title, where it can't be missed. */
function showWarning(root: HTMLElement, content: string | HTMLElement): HTMLDivElement {
  const warn = document.createElement('div');
  warn.className = 'sm-warn';
  warn.append(content);
  root.querySelector('.hm-warns')!.appendChild(warn);
  return warn;
}

/** The slow-GPU warning: what's wrong on one line, and the numbered steps to fix it a click away. */
function gpuWarning(advice: GpuAdvice): HTMLElement {
  const box = document.createElement('details');
  box.className = 'sm-fix';
  const text = document.createElement('summary');
  text.textContent = advice.text;
  text.appendChild(document.createElement('span')).textContent = 'How to fix';
  const steps = document.createElement('ol');
  for (const step of advice.steps) steps.appendChild(document.createElement('li')).textContent = step;
  box.append(text, steps);
  if (advice.copy) {
    // browsers refuse links to their own settings pages, so offer the text instead
    const copy = document.createElement('button');
    copy.className = 'sm-compat';
    copy.textContent = 'Copy flag address';
    copy.addEventListener('click', () => {
      // (a refused clipboard leaves the address in the steps to copy by hand)
      navigator.clipboard?.writeText(advice.copy!).then(() => (copy.textContent = 'Copied: paste it in the address bar'), () => (copy.textContent = 'Copy it from the steps above'));
    });
    box.appendChild(copy);
  }
  return box;
}

interface BatteryManager extends EventTarget {
  readonly charging: boolean;
}

/** Calls `then` if this is a laptop running on battery (Chromium reports it; other browsers don't). */
async function onBattery(then: (battery: BatteryManager) => void): Promise<void> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
  try {
    const battery = await nav.getBattery?.();
    if (battery && !battery.charging) then(battery);
  } catch {
    /* not allowed here */
  }
}

/** What the home page says about the graphics setup. */
export interface GraphicsInfo {
  webgpu: boolean;
  advice: GpuAdvice | null;
}

/**
 * The home page: choose a mode and its options, then Play (or open a lobby
 * and play with friends). The mode's art fills the screen behind the menu.
 * Shown while the game loads behind it. `picked` hears 'jotunn' when the
 * player picks the giant's mode or asks to play the giant (it says its line);
 * `sound` plays the lobby's joins, leaves and copies.
 */
export function showStartMenu(graphics: Promise<GraphicsInfo>, defaultGod: string, picked?: (god: string) => void, sound?: (name: string, gain?: number) => void): Promise<ModeChoice> {
  const prev = load();
  let mode = savedMode();
  let difficulty: Difficulty = parseDifficulty(prev.difficulty);
  let allies = prev.allies !== false;
  let rivals = prev.rivals === true;
  let role = parseGiantRole(prev.role);

  const root = document.createElement('div');
  root.className = 'sm hm';
  root.innerHTML = `
    <div class="hm-art"><div class="hm-img fx-far"></div><div class="hm-img fx-far"></div></div>
    <div class="hm-shade"></div>
    <div class="hm-embers embers fx-mid">${embersHtml(28)}</div>
    <div class="hm-hero fx-near" aria-hidden="true"><img alt=""><img alt=""></div>
    <div class="hm-flash"></div>
    <div class="hm-frame">
      <header class="hm-top">
        <div class="hm-logo"><span class="hm-word">ASCENDANT</span><span class="hm-sub">A war of gods</span></div>
        ${rankBadge()}
        <div class="hm-tools"><button class="hm-tool" data-tool="controls">Controls</button><button class="hm-tool" data-tool="settings">Settings</button></div>
      </header>
      <div class="hm-warns"></div>
      <div class="hm-body">
        <nav class="hm-modes sm-modes">
          <div class="hm-label">Choose a mode</div>
          ${MODES.map(
            (m, i) => `<button class="hm-mode sm-mode" data-mode="${m.id}" style="--i:${i}">
              <span class="hm-thumb" style="background-image:url(${modeThumb(m.id)})"></span>
              <span class="hm-mtext"><b>${m.name}</b><span>${m.tag}</span></span>
              ${m.net ? '<span class="hm-online" title="Can be played online">Online</span>' : ''}
            </button>`,
          ).join('')}
        </nav>
        <section class="hm-card">
          <div class="hm-detail"></div>
          <div class="hm-opts">
            <div class="hm-opt" data-row="dif"><span>Bots</span>${DIFFICULTIES.map((d) => `<button class="hm-seg" data-dif="${d.id}" title="${d.text}">${d.name}</button>`).join('')}</div>
            <div class="hm-opt" data-row="role"><span>Giant</span>${GIANT_ROLES.map((r) => `<button class="hm-seg" data-role="${r.id}" title="${r.text}">${r.name}</button>`).join('')}</div>
            <div class="hm-opt" data-row="descent"><span>Allies</span><button class="hm-seg" data-allies="1" title="Two bot gods descend with you">Two bots</button><button class="hm-seg" data-allies="0" title="Go down alone: the underworld sends fewer monsters">Alone</button></div>
            <div class="hm-opt" data-row="descent"><span>Rivals</span><button class="hm-seg" data-rivals="0" title="Co-op: your team against the underworld">None</button><button class="hm-seg" data-rivals="1" title="A shared descent: a team of three bots races you through the same chambers for souls">Bot team</button></div>
          </div>
          <div class="hm-actions">
            <button class="hm-play sm-play"><span>Play</span><small>Choose your god next</small></button>
          </div>
          <div class="hm-friends">
            <div class="hm-label">Play with friends</div>
            <div class="sm-net"></div>
          </div>
        </section>
      </div>
      <footer class="hm-foot"><span class="sm-note"></span><span class="hm-keys">&uarr; &darr; choose &middot; Enter play</span></footer>
    </div>
    <div class="hm-modal"><div class="hm-modal-panel"><div class="hm-label">Controls</div>${controlsHtml()}<button class="hm-close">Close</button></div></div>`;
  document.body.appendChild(root);
  const stopParallax = parallax(root);

  // the backdrop crossfades between two layers, each with a slow push-in
  const layers = [...root.querySelectorAll<HTMLDivElement>('.hm-img')];
  let front = 0;
  let shown = '';
  const showArt = (id: string) => {
    if (shown === id) return;
    shown = id;
    const next = layers[1 - front]!;
    const url = modeArt(id);
    const img = new Image();
    const swap = () => {
      next.style.backgroundImage = `url(${url})`;
      // restart its slow zoom
      next.classList.remove('on');
      void next.offsetWidth;
      next.classList.add('on');
      layers[front]!.classList.remove('on');
      front = 1 - front;
    };
    img.onload = swap;
    img.onerror = swap;
    img.src = url;
  };

  // your god (the giant, in its own mode) stands in their light between the modes and the card
  const heroBox = root.querySelector<HTMLDivElement>('.hm-hero')!;
  const heroes = [...heroBox.querySelectorAll('img')];
  let heroFront = 0;
  let heroShown = '';
  const showHero = (id: string) => {
    if (heroShown === id) return;
    heroShown = id;
    if (!HEROES.has(id)) {
      heroes.forEach((img) => img.classList.remove('show'));
      return;
    }
    const next = heroes[1 - heroFront]!;
    next.classList.remove('show');
    next.onload = () => {
      if (heroShown !== id) return;
      heroBox.style.setProperty('--god', `#${paletteFor(id).vfx.toString(16).padStart(6, '0')}`);
      heroes[heroFront]!.classList.remove('show');
      next.classList.add('show');
      heroFront = 1 - heroFront;
    };
    next.src = heroArt(id);
  };

  const detail = root.querySelector<HTMLDivElement>('.hm-detail')!;
  const render = () => {
    const m = modeInfo(mode);
    root.querySelectorAll<HTMLButtonElement>('.hm-mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    root.querySelectorAll<HTMLButtonElement>('[data-dif]').forEach((b) => b.classList.toggle('on', b.dataset.dif === difficulty));
    root.querySelectorAll<HTMLButtonElement>('[data-role]').forEach((b) => b.classList.toggle('on', b.dataset.role === role));
    root.querySelectorAll<HTMLButtonElement>('[data-allies]').forEach((b) => b.classList.toggle('on', (b.dataset.allies === '1') === allies));
    root.querySelectorAll<HTMLButtonElement>('[data-rivals]').forEach((b) => b.classList.toggle('on', (b.dataset.rivals === '1') === rivals));
    root.querySelector<HTMLDivElement>('[data-row="role"]')!.classList.toggle('hide', mode !== 'jotunn');
    root.querySelectorAll<HTMLDivElement>('[data-row="descent"]').forEach((row) => row.classList.toggle('hide', mode !== 'descent'));
    // the training ground's lone Thor has no difficulty to choose
    root.querySelector<HTMLDivElement>('[data-row="dif"]')!.classList.toggle('hide', mode === 'arena');
    const rec = recordLine(mode);
    const online = m.net ? `Online up to ${Math.max(...m.net.map((h) => h.cap))}` : 'Single player';
    detail.innerHTML = `
      <div class="hm-kicker"><span>${m.tag}</span><span>${m.time}</span><span>${online}</span></div>
      <h1 class="hm-name">${m.name}</h1>
      <p class="hm-desc">${m.text}</p>
      ${rec ? `<div class="hm-rec">${rec}</div>` : ''}`;
    // replay the card's entrance on each new mode
    detail.classList.remove('in');
    void detail.offsetWidth;
    detail.classList.add('in');
    showArt(mode);
    showHero(mode === 'jotunn' ? 'jotunn' : (load().god ?? defaultGod));
  };
  render();

  const choose = (id: GameMode) => {
    if (root.querySelector('.hm-modes')!.classList.contains('held') || id === mode) return;
    const was = mode;
    mode = id;
    render();
    lobby.gameChanged();
    if (mode === 'jotunn' && was !== 'jotunn') picked?.('jotunn');
  };
  root.querySelectorAll<HTMLButtonElement>('[data-role]').forEach((b) =>
    b.addEventListener('click', () => {
      role = parseGiantRole(b.dataset.role);
      render();
      // the giant answers whoever means to play it
      if (role !== 'god') picked?.('jotunn');
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-allies]').forEach((b) =>
    b.addEventListener('click', () => {
      allies = b.dataset.allies === '1';
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-rivals]').forEach((b) =>
    b.addEventListener('click', () => {
      rivals = b.dataset.rivals === '1';
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-dif]').forEach((b) =>
    b.addEventListener('click', () => {
      difficulty = parseDifficulty(b.dataset.dif);
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('.hm-mode').forEach((b) => b.addEventListener('click', () => choose(b.dataset.mode as GameMode)));

  const modal = root.querySelector<HTMLDivElement>('.hm-modal')!;
  const toggleModal = (on = !modal.classList.contains('show')) => modal.classList.toggle('show', on);
  root.querySelector('[data-tool="controls"]')!.addEventListener('click', () => toggleModal(true));
  root.querySelector('[data-tool="settings"]')!.addEventListener('click', () => openSettings());
  root.querySelector('.hm-close')!.addEventListener('click', () => toggleModal(false));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) toggleModal(false);
  });

  const play = root.querySelector<HTMLButtonElement>('.hm-play')!;
  let started: ((c: ModeChoice) => void) | null = null;
  const gameInfo = (id: string = mode): NetGameInfo | null => {
    const m = MODES.find((x) => x.id === id);
    return m ? { id: m.id, name: m.name, hosts: m.net ?? [] } : null;
  };
  const lobby = mountLobby(root.querySelector<HTMLDivElement>('.sm-net')!, {
    god: () => load().god ?? defaultGod,
    game: gameInfo,
    inLobby: (on) => {
      play.classList.toggle('held', on);
      // a lobby plays one mode: the mode list waits until it closes
      root.querySelector('.hm-modes')!.classList.toggle('held', on);
      root.classList.toggle('in-lobby', on);
    },
    onGame: (id) => {
      if (id === mode || !isMode(id)) return;
      mode = id;
      render();
    },
    onStart: (net) => started?.({ mode: isMode(net.game) ? net.game : 'conquest', net, difficulty }),
    sound,
  });

  const note = root.querySelector<HTMLSpanElement>('.sm-note')!;
  void graphics.then(({ webgpu, advice }) => {
    const forced = compatibilityMode();
    note.innerHTML = webgpu
      ? 'Running on WebGPU. Black screen or glitches? <button class="sm-compat">Use compatibility mode</button>'
      : forced
        ? 'Compatibility mode (WebGL 2). <button class="sm-compat">Switch to WebGPU</button>'
        : 'WebGPU is unavailable, so the game uses WebGL 2. Chrome or Edge on a recent GPU runs best.';
    note.querySelector('.sm-compat')?.addEventListener('click', () => setCompatibilityMode(!forced));
    if (advice) showWarning(root, gpuWarning(advice));
  });
  void onBattery((battery) => {
    const warn = showWarning(root, 'Your laptop is on battery. Plug it in for a smooth game: on battery Windows and the browser slow the graphics card down.');
    battery.addEventListener('chargingchange', () => warn.classList.toggle('gone', battery.charging));
  });

  // keyboard: arrows walk the mode list, Enter plays
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (modal.classList.contains('show')) {
      if (e.code === 'Escape') toggleModal(false);
      return;
    }
    const i = MODES.findIndex((m) => m.id === mode);
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      e.preventDefault();
      // (through the button, so the keys sound like a click)
      const next = root.querySelector<HTMLButtonElement>(`.hm-mode[data-mode="${MODES[(i + (e.code === 'ArrowDown' ? 1 : MODES.length - 1)) % MODES.length]!.id}"]`);
      if (!root.querySelector('.hm-modes')!.classList.contains('held')) next?.click();
      next?.focus({ preventScroll: true });
    } else if (e.code === 'Enter' && !play.classList.contains('held') && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      play.click();
    }
  };
  window.addEventListener('keydown', onKey);

  return new Promise((resolve) => {
    const finish = (choice: ModeChoice) => {
      window.removeEventListener('keydown', onKey);
      stopParallax();
      saveChoice({ mode: choice.mode, difficulty, role, allies, rivals });
      // the menu flies apart and the art rushes in, under the god pick fading up
      root.classList.add('done');
      setTimeout(() => root.remove(), 1000);
      resolve(choice);
    };
    started = finish;
    play.addEventListener('click', () => finish({ mode, difficulty, role, allies, rivals }));
  });
}
