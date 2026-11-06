import { SLOT_KEYS } from '../game/loadout';
import type { GodDef } from '../game/types';
import { compatibilityMode, setCompatibilityMode } from './Fatal';
import type { GpuAdvice } from '../render/gpuAdvice';
import { skillIcon } from './icons';
import { mountLobby } from '../net/LobbyPanel';
import type { NetGameInfo, NetHostOption } from '../net/roster';
import type { NetSession } from '../net/Session';
import './start.css';
import { DIFFICULTIES, parseDifficulty, type Difficulty } from '../game/difficulty';
import { recordLine } from './records';
import { rankBadge } from './ascension';
import type { JotunnRole } from '../combat/JotunnMode';
import { jotunn } from '../game/gods/jotunn';

export type GameMode = 'conquest' | 'arena' | 'clash' | 'siege' | 'duel' | 'rush' | 'descent' | 'jotunn';

/** The map a mode is played on. */
export function mapOf(mode: GameMode): 'conquest' | 'arena' | 'underworld' {
  return mode === 'conquest' ? 'conquest' : mode === 'descent' ? 'underworld' : 'arena';
}

export interface StartChoice {
  mode: GameMode;
  god: string;
  /** A multiplayer Conquest match (the lobby's players and connections). */
  net?: NetSession;
  difficulty?: Difficulty;
  /** Temple Duel: the rival god's id, or '' for a random one. */
  rival?: string;
  /** Underworld Descent alone: whether bots join your team, and whether a bot team descends against yours. */
  allies?: boolean;
  rivals?: boolean;
  /** The Jötunn: who plays the giant on your own (online, every player takes a turn). */
  role?: JotunnRole;
}

const STORAGE_KEY = 'ascendant.start';

/** A title-screen mode. `net` lists the lobbies it can host online (none: single player only). */
const MODES: { id: GameMode; name: string; text: string; net?: NetHostOption[] }[] = [
  {
    id: 'conquest',
    name: 'Conquest',
    text: '5v5 against bots. Destroy the enemy Titan to win. About 15–20 minutes.',
    net: [
      { mode: 'coop', label: 'Host co-op', text: 'Friends together against bots', cap: 5 },
      { mode: 'versus', label: 'Host versus', text: 'Friends on both teams, bots fill in', cap: 10 },
    ],
  },
  { id: 'clash', name: 'Temple Clash', text: '3v3 king of the hill. Hold the temple plaza and take down gods; the temple\'s blessing doubles points now and then. First to 115. About 4 minutes.' },
  { id: 'siege', name: 'Temple Siege', text: 'You and two bots hold the temple against endless monster waves, with a boss every fifth. Pick a team boon after each wave. How long can you last?' },
  {
    id: 'rush',
    name: 'Relic Rush',
    text: '3v3 sport. Carry the Sun Relic through the enemy gate or pass it in; stun the carrier to steal it. Nobody dies, they get dazed. First to 5 goals. About 5 minutes.',
    net: [
      { mode: 'coop', label: 'Host co-op', text: 'Friends on one team against bots', cap: 3 },
      { mode: 'versus', label: 'Host versus', text: 'Friends on both teams, bots fill in', cap: 6 },
    ],
  },
  {
    id: 'descent',
    name: 'Underworld Descent',
    text: 'Dungeon run: go down through fifteen chambers of the underworld, a boss every fifth. Vote on a reward after each chamber, learn new skills as you go, and raise fallen allies. Co-op, or team against team for the most souls. About 25 minutes.',
    net: [
      { mode: 'coop', label: 'Host co-op', text: 'Up to four friends descend together; bots fill the team to three if you like', cap: 4, bots: true },
      { mode: 'versus', label: 'Host versus', text: 'Two teams of up to three race the same chambers for souls; each team picks bots or none', cap: 6, bots: true },
    ],
  },
  {
    id: 'jotunn',
    name: 'The Jötunn',
    text: 'One frost giant against four gods. The giant wins a round by smashing three of the four braziers; the gods win by breaking it at its knees, wrists, back rune and crown. Shrines in the valley give the giant new ultimates. About 3 minutes a round.',
    net: [{ mode: 'coop', label: 'Host a hunt', text: 'Up to five friends take turns as the giant; bots fill the rest', cap: 5 }],
  },
  { id: 'duel', name: 'Temple Duel', text: 'One on one against a bot god. Win a round by taking them down; a ring of fire closes in so nobody can hide. First to 3 rounds. About 2–3 minutes.' },
  { id: 'arena', name: 'Training ground', text: 'Training posts and one enemy Thor. Swap gods and levels freely with K.' },
];

const JOTUNN_TIP =
  'As a god, strike the glowing weak points: break both knees and the giant kneels, opening its crown. As the giant, every blow winds up first, so aim where the gods are going. Claim a shrine for a new ultimate.';

/** Who plays the giant in a Jötunn match on your own. */
const GIANT_ROLES: { id: JotunnRole; name: string; text: string }[] = [
  { id: 'rotate', name: 'Take turns', text: 'Two rounds: a bot is the giant first, then you are' },
  { id: 'giant', name: 'Me', text: 'One round as the giant' },
  { id: 'god', name: 'A bot', text: 'One round as a god against a bot giant' },
];

function parseGiantRole(s: unknown): JotunnRole {
  return s === 'giant' || s === 'god' ? s : 'rotate';
}

const ROLE_NAMES: Record<string, string> = { solo: 'Solo', jungle: 'Jungle', mid: 'Mid', carry: 'Carry', support: 'Support' };

/** The controls, shared by the start screen and the in-game help (H). */
export const CONTROLS: [string, string][] = [
  ['Click', 'Capture the mouse and play'],
  ['W A S D', 'Move'],
  ['Mouse', 'Aim (the camera follows)'],
  ['Left click', 'Basic attack (Relic Rush: pass the relic)'],
  ['1  2  3', 'Skills: press to aim, press again or click to cast, right click cancels'],
  ['4 or R', 'Ultimate (unlocks at level 5)'],
  ['B', 'Recall to the fountain'],
  ['G (hold)', 'Ping wheel: attack, on my way, group up, fall back and more. Tap G or middle click to ping what you aim at'],
  ['V', 'Taunt: your god says something cutting to everyone near'],
  ['F', 'Relic Rush: call for the pass'],
  ['Space', 'Jump (Relic Rush carrying the relic: juke, a quick sidestep that slips a tackle)'],
  ['Z  X  C', 'Temple Siege and Underworld Descent: pick a boon, a reward or a skill'],
  ['K', 'Skills & trees: spend points; swap skills at the fountain'],
  ['Tab (hold)', 'Scoreboard'],
  ['Wheel', 'Camera zoom'],
  ['H', 'Show or hide this help'],
  ['M', 'Mute or unmute sound'],
  ['Esc', 'Release the mouse'],
];

export function controlsHtml(): string {
  return `<div class="sm-controls">${CONTROLS.map(([k, v]) => `<div class="sm-key">${k}</div><div>${v}</div>`).join('')}</div>`;
}

function load(): Partial<StartChoice> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<StartChoice>;
  } catch {
    return {};
  }
}

/** The mode the title screen opens with: the last one played, Conquest at first. */
export function savedMode(): GameMode {
  const m = load().mode;
  return m === 'arena' || m === 'clash' || m === 'siege' || m === 'duel' || m === 'rush' || m === 'descent' || m === 'jotunn' ? m : 'conquest';
}

function save(c: StartChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable */
  }
}

/** A warning under the title, where it can't be missed. */
function showWarning(root: HTMLElement, content: string | HTMLElement): HTMLDivElement {
  const warn = document.createElement('div');
  warn.className = 'sm-warn';
  warn.append(content);
  root.querySelector('.sm-title')!.after(warn);
  return warn;
}

/** The slow-GPU warning: what's wrong, then numbered steps to fix it. */
function gpuWarning(advice: GpuAdvice): HTMLElement {
  const box = document.createElement('div');
  const text = document.createElement('div');
  text.textContent = advice.text;
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

/**
 * The title screen: pick a mode and a god, read the controls, press Play.
 * Shown over the loading screen while textures and models load behind it.
 */
/** What the title screen says about the graphics setup. */
export interface GraphicsInfo {
  webgpu: boolean;
  advice: GpuAdvice | null;
}

/** `picked` hears each god the player clicks (it says its line). */
export function showStartMenu(gods: readonly GodDef[], graphics: Promise<GraphicsInfo>, picked?: (god: string) => void): Promise<StartChoice> {
  const prev = load();
  let mode = savedMode();
  let god = gods.some((g) => g.id === prev.god) ? prev.god! : gods[0]!.id;
  let difficulty: Difficulty = parseDifficulty(prev.difficulty);
  let rival = gods.some((g) => g.id === prev.rival) ? prev.rival! : '';
  let allies = prev.allies !== false;
  let rivals = prev.rivals === true;
  let role = parseGiantRole(prev.role);

  const root = document.createElement('div');
  root.className = 'sm';
  root.innerHTML = `
    <div class="sm-panel">
      <div class="sm-title">ASCENDANT</div>
      ${rankBadge()}
      <div class="sm-gods">${gods.map((g) => `<button class="sm-god" data-god="${g.id}"><img src="${import.meta.env.BASE_URL}portraits/${g.id}.jpg" alt="" onerror="this.remove()"><span class="sm-face"><b>${g.name}</b><span>${ROLE_NAMES[g.role] ?? g.role} &middot; ${g.attackRange}</span></span></button>`).join('')}</div>
      <div class="sm-cols">
        <div class="sm-col">
          <h3>Mode</h3>
          <div class="sm-modes">${MODES.map((m) => `<button class="sm-mode" data-mode="${m.id}"><b>${m.name}</b><span>${m.text}</span>${recordLine(m.id) ? `<em class="sm-rec">${recordLine(m.id)}</em>` : ''}</button>`).join('')}</div>
          <div class="sm-diff"><span>Bots</span>${DIFFICULTIES.map((d) => `<button class="sm-dif" data-dif="${d.id}" title="${d.text}">${d.name}</button>`).join('')}</div>
          <div class="sm-diff sm-role"><span>Giant</span>${GIANT_ROLES.map((r) => `<button class="sm-dif" data-role="${r.id}" title="${r.text}">${r.name}</button>`).join('')}</div>
          <div class="sm-diff sm-rival"><span>Rival</span><button class="sm-dif" data-rival="">Random</button>${gods.map((g) => `<button class="sm-dif" data-rival="${g.id}">${g.name}</button>`).join('')}</div>
          <div class="sm-diff sm-descent"><span>Allies</span><button class="sm-dif" data-allies="1" title="Two bot gods descend with you">Two bots</button><button class="sm-dif" data-allies="0" title="Go down alone: the underworld sends fewer monsters">Alone</button></div>
          <div class="sm-diff sm-descent"><span>Rivals</span><button class="sm-dif" data-rivals="0" title="Co-op: your team against the underworld">None</button><button class="sm-dif" data-rivals="1" title="A shared descent: a team of three bots races you through the same chambers for souls">Bot team</button></div>
          <div class="sm-detail"></div>
          <h3 class="help-gap">Play with friends</h3>
          <div class="sm-net"></div>
        </div>
        <div class="sm-col">
          <h3>Controls</h3>
          ${controlsHtml()}
        </div>
      </div>
      <div class="sm-foot">
        <span class="sm-note"></span>
        <button class="sm-play">Play</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const detail = root.querySelector<HTMLDivElement>('.sm-detail')!;
  const render = () => {
    root.querySelectorAll<HTMLButtonElement>('.sm-mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    root.querySelectorAll<HTMLButtonElement>('.sm-god').forEach((b) => b.classList.toggle('on', b.dataset.god === god));
    root.querySelectorAll<HTMLButtonElement>('.sm-dif[data-dif]').forEach((b) => b.classList.toggle('on', b.dataset.dif === difficulty));
    // a rival row only for the duel; your own god can't be your rival
    if (rival === god) rival = '';
    root.querySelector<HTMLDivElement>('.sm-rival')!.classList.toggle('hide', mode !== 'duel');
    root.querySelectorAll<HTMLDivElement>('.sm-descent').forEach((row) => row.classList.toggle('hide', mode !== 'descent'));
    root.querySelectorAll<HTMLButtonElement>('[data-allies]').forEach((b) => b.classList.toggle('on', (b.dataset.allies === '1') === allies));
    root.querySelectorAll<HTMLButtonElement>('[data-rivals]').forEach((b) => b.classList.toggle('on', (b.dataset.rivals === '1') === rivals));
    // the Jötunn: who plays the giant
    root.querySelector<HTMLDivElement>('.sm-role')!.classList.toggle('hide', mode !== 'jotunn');
    root.querySelectorAll<HTMLButtonElement>('[data-role]').forEach((b) => b.classList.toggle('on', b.dataset.role === role));
    root.querySelectorAll<HTMLButtonElement>('[data-rival]').forEach((b) => {
      b.classList.toggle('on', b.dataset.rival === rival);
      b.hidden = b.dataset.rival === god;
    });
    // picking yourself as the Jötunn's giant shows the giant you'll play
    const def = mode === 'jotunn' && role === 'giant' ? jotunn : gods.find((g) => g.id === god)!;
    const skills = def.defaultLoadout.map((id) => def.skills.find((s) => s.id === id)!);
    const keys = SLOT_KEYS;
    detail.innerHTML = `
      <div class="sm-name">${def.name} <span>${def.title} &middot; ${def.pantheon}</span></div>
      <div class="sm-passive"><b>${def.passive.name}</b> (passive): ${def.passive.description}</div>
      <div class="sm-skills">${skills
        .map((s, i) => `<div class="sm-skill" title="${s.description.replace(/"/g, '&quot;')}"><div class="sm-ico">${skillIcon(def.id, s)}</div><div class="sm-k">${keys[i]}</div><div class="sm-sn">${s.name}</div></div>`)
        .join('')}</div>
      <div class="sm-tip">${mode === 'conquest' ? 'You start mid with four allied bots in the other lanes. Go wherever you like.' : mode === 'clash' ? 'You and two bots start at level 8. Stand on the plaza with no enemy on it to score.' : mode === 'siege' ? 'Monsters on the plaza corrupt it. Meet them at the gates, north and south.' : mode === 'descent' ? (rivals ? 'Both teams go down the same chambers. Every kill pays souls to the team that makes it, rival gods included; the most souls at the bottom wins. A fallen god rises at the gate, or sooner if an ally stands over them.' : 'You start with one skill; a Forgotten Rite reward teaches you another. A fallen god stays down until an ally stands over them.') : mode === 'duel' ? 'Both gods start at level 9 and gain two levels every round. Stay inside the ring once it closes.' : mode === 'rush' ? 'Everyone starts at level 10. The carrier is slower and can\'t fight, so pass to open teammates, juke a tackle with Space, and use your stuns and knockbacks to break up their rushes.' : mode === 'jotunn' ? JOTUNN_TIP : 'Swap gods and jump levels with K at the fountain.'}${mode === 'jotunn' ? '' : ' Press K at your fountain to swap skills and spend tree points.'}</div>`;
  };
  render();

  root.querySelectorAll<HTMLButtonElement>('[data-role]').forEach((b) =>
    b.addEventListener('click', () => {
      role = parseGiantRole(b.dataset.role);
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-rival]').forEach((b) =>
    b.addEventListener('click', () => {
      rival = b.dataset.rival ?? '';
      render();
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
  root.querySelectorAll<HTMLButtonElement>('.sm-dif[data-dif]').forEach((b) =>
    b.addEventListener('click', () => {
      difficulty = parseDifficulty(b.dataset.dif);
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('.sm-mode').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.parentElement!.classList.contains('held')) return;
      mode = b.dataset.mode as GameMode;
      render();
      lobby.gameChanged();
    }),
  );
  const play = root.querySelector<HTMLButtonElement>('.sm-play')!;
  let started: ((c: StartChoice) => void) | null = null;
  const gameInfo = (id: string = mode): NetGameInfo | null => {
    const m = MODES.find((x) => x.id === id);
    return m ? { id: m.id, name: m.name, hosts: m.net ?? [] } : null;
  };
  const lobby = mountLobby(root.querySelector<HTMLDivElement>('.sm-net')!, {
    god: () => god,
    game: gameInfo,
    inLobby: (on) => {
      play.classList.toggle('held', on);
      // a lobby plays one mode: the mode list waits until it closes
      root.querySelector('.sm-modes')!.classList.toggle('held', on);
    },
    onGame: (id) => {
      if (id === mode || !MODES.some((m) => m.id === id)) return;
      mode = id as GameMode;
      render();
    },
    onStart: (net) => started?.({ mode: (MODES.some((m) => m.id === net.game) ? net.game : 'conquest') as GameMode, god: net.self()?.god ?? god, net, difficulty }),
  });
  root.querySelectorAll<HTMLButtonElement>('.sm-god').forEach((b) =>
    b.addEventListener('click', () => {
      god = b.dataset.god!;
      render();
      lobby.godChanged();
      picked?.(god);
    }),
  );

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

  return new Promise((resolve) => {
    const finish = (choice: StartChoice) => {
      save({ mode: choice.mode, god: choice.god, difficulty, rival, role, allies, rivals });
      root.classList.add('done');
      setTimeout(() => root.remove(), 400);
      resolve(choice);
    };
    started = finish;
    play.addEventListener('click', () => finish({ mode, god, difficulty, rival, role, allies, rivals }));
  });
}
