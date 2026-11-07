import { GODS } from '../game/gods';
import { NetSession, PICK_SECONDS } from './Session';
import { NAME_MAX, type NetGameInfo, type NetMode, type NetPlayer } from './roster';
import './lobby.css';

const BASE = import.meta.env.BASE_URL;
const NAME_KEY = 'ascendant.name';

/** The name this player last went online with ('' for none yet: the host numbers them). */
function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage unavailable */
  }
}

/** A seat's portrait: the god the player last chose (a known god only: the id comes over the network). */
const face = (god: string) => `${BASE}portraits/${GODS.some((g) => g.id === god) ? god : GODS[0]!.id}.jpg`;

const MODE_NAMES: Record<NetMode, string> = { coop: 'Co-op', versus: 'Versus' };

/** A guest's connection to the host as signal bars and milliseconds (nothing until the host has timed it). */
function pingHtml(ms: number | undefined): string {
  if (ms === undefined) return '';
  const q = ms < 80 ? 'good' : ms < 160 ? 'fair' : 'poor';
  const say = q === 'good' ? 'a fast connection' : q === 'fair' ? 'an average connection' : 'a slow connection: expect some lag';
  return `<i class="lb-ping q-${q}" title="${ms} ms round trip to the host, ${say}"><b></b><b></b><b></b><em>${ms}</em></i>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A link that opens the title screen and joins this lobby (keeping a custom signaling server for testing). */
function inviteLink(code: string): string {
  const url = new URL(location.pathname, location.origin);
  const peer = new URLSearchParams(location.search).get('peer');
  if (peer) url.searchParams.set('peer', peer);
  url.searchParams.set('join', code);
  return url.toString();
}

/**
 * The home page's "Play with friends" box: your name, then host a lobby for
 * the selected game mode (its co-op or versus options, and share its code),
 * or join one with a code. In a lobby every seat is shown, the players in
 * theirs (their last god's portrait, the host's crown, their team) and the
 * open ones a bot will take; joins and leaves light up and sound. Calls
 * `onStart` when the host starts the match, which opens the god pick for
 * everyone (src/ui/GodPick.ts). `inLobby` tells the title screen to hold its
 * own Play button (and its mode) while a lobby is open; `onGame` tells it
 * which mode a joined lobby plays.
 */
export function mountLobby(
  box: HTMLElement,
  hooks: {
    /** The god a player joins with until the pick screen (their last one). */
    god: () => string;
    /** The game mode the title screen has selected, or a joined lobby's mode by id. */
    game: (id?: string) => NetGameInfo | null;
    inLobby: (on: boolean) => void;
    onGame: (id: string) => void;
    onStart: (s: NetSession) => void;
    /** A sound from the game's bank (ui.*). */
    sound?: (name: string, gain?: number) => void;
  },
): { gameChanged: () => void } {
  let session: NetSession | null = null;
  let busy = '';
  let error = '';
  /** A line about who just came or went, and until when it shows. */
  let news = '';
  let newsTimer: ReturnType<typeof setTimeout> | undefined;
  /** The players the last render showed, to see who joined and who left. */
  let seen: NetPlayer[] | null = null;
  let fresh = new Set<string>();
  /** The seats rise in once, as the lobby opens (later renders only light up a newcomer). */
  let entering = false;
  /** The news line last shown, so it slides in once and not on every update. */
  let shownNews = '';
  /** Which copy button was just used, until its "Copied" fades. */
  let copied = '';
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  // your name stays put above the lobby (re-rendering under it never steals the caret)
  box.innerHTML = `
    <label class="lb-me"><span>Your name</span><input class="lb-name" maxlength="${NAME_MAX}" placeholder="Player" spellcheck="false" autocomplete="nickname"></label>
    <div class="lb-body"></div>`;
  const nameInput = box.querySelector<HTMLInputElement>('.lb-name')!;
  const view = box.querySelector<HTMLDivElement>('.lb-body')!;
  nameInput.value = savedName();
  const commitName = () => {
    const name = nameInput.value.trim();
    saveName(name);
    if (session) session.rename(name);
  };
  nameInput.addEventListener('change', commitName);
  nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') nameInput.blur();
  });

  const tell = (text: string) => {
    news = text;
    clearTimeout(newsTimer);
    newsTimer = setTimeout(() => {
      news = '';
      render();
    }, 4000);
  };
  const flashCopied = (which: string) => {
    copied = which;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied = '';
      render();
    }, 1800);
    render();
  };

  /** Who joined or left since the last render: a line, a sound, and the new seat lit. */
  const noticeChanges = (s: NetSession) => {
    fresh = new Set();
    if (seen) {
      const before = new Map(seen.map((p) => [p.id, p]));
      const joined = s.players.filter((p) => !before.has(p.id) && p.id !== s.me);
      const left = seen.filter((p) => !s.players.some((x) => x.id === p.id));
      for (const p of joined) fresh.add(p.id);
      if (joined.length) {
        tell(`${joined.map((p) => p.name).join(' and ')} joined`);
        hooks.sound?.('ui.select', 0.8);
      } else if (left.length) {
        tell(`${left.map((p) => p.name).join(' and ')} left`);
        hooks.sound?.('ui.close', 0.7);
      }
    }
    seen = s.players.map((p) => ({ ...p }));
  };

  const render = () => {
    hooks.inLobby(session !== null);
    if (session) hooks.onGame(session.game);
    nameInput.disabled = !!busy;
    if (!session) {
      seen = null;
      const game = hooks.game();
      const hosts = game?.hosts ?? [];
      const most = Math.max(0, ...hosts.map((h) => h.cap));
      const note = hosts.length ? `One player hosts and runs the match; up to ${most} players.` : `${game?.name ?? 'This mode'} is single player for now. Pick a mode above with online play to host, or join a friend's lobby.`;
      view.innerHTML = `
        <div class="lb-row">
          ${hosts.map((h) => `<button class="lb-btn" data-host="${h.mode}"><b>${esc(h.label)}</b><span>${esc(h.text)}</span></button>`).join('')}
        </div>
        <div class="lb-row lb-join">
          <input class="lb-code" maxlength="5" placeholder="Lobby code" spellcheck="false" autocomplete="off">
          <button class="lb-small lb-go">Join</button>
        </div>
        <div class="lb-msg ${error ? 'lb-err' : ''}">${esc(busy || error || note)}</div>`;
      view.querySelectorAll<HTMLButtonElement>('[data-host]').forEach((b) => b.addEventListener('click', () => void host(b.dataset.host as NetMode)));
      const input = view.querySelector<HTMLInputElement>('.lb-code')!;
      const go = () => void join(input.value);
      view.querySelector('.lb-go')!.addEventListener('click', go);
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') go();
      });
      if (busy) view.querySelectorAll('button, input').forEach((el) => ((el as HTMLButtonElement).disabled = true));
      return;
    }
    const s = session;
    noticeChanges(s);
    // the field shows your name as everyone sees it (cleaned), unless you're typing in it
    const meNow = s.self();
    const typed = nameInput.value.trim();
    if (meNow && typed && typed !== meNow.name && document.activeElement !== nameInput) {
      nameInput.value = meNow.name;
      saveName(meNow.name);
    }
    const option = hooks.game(s.game)?.hosts.find((h) => h.mode === s.mode);
    const mine = s.self()?.team ?? 'order';
    // a team that may choose: its own players (or the host) turn its bot teammates on or off
    const teams = option?.bots ? (s.mode === 'versus' ? (['order', 'chaos'] as const) : (['order'] as const)) : [];
    const botRow = teams
      .map((t) => {
        const on = s.bots[t];
        const can = s.isHost || t === mine;
        const name = s.mode === 'versus' ? `${t === 'order' ? 'Order' : 'Chaos'}: ` : '';
        return `<button class="lb-small lb-bots${on ? ' on' : ''}" data-bots="${t}" ${can ? '' : 'disabled'} title="${can ? 'Click to change' : 'Only that team can change this'}">${name}${on ? 'Bots fill empty spots' : 'No bots'}</button>`;
      })
      .join('');
    // every seat: the players in theirs, the rest open for a friend (or a bot)
    const cap = option?.cap ?? s.cap ?? s.players.length;
    const hostId = s.players[0]?.id;
    const seatHtml = (p: NetPlayer | undefined, team: 'order' | 'chaos', i: number) => {
      if (!p) {
        const bot = option?.bots ? s.bots[team] : true;
        return `<div class="lb-seat open" style="--i:${i}"><div class="lb-face"><span>+</span></div><b>Open</b><span>${bot ? 'A bot plays' : 'Empty'}</span></div>`;
      }
      const me = p.id === s.me;
      return `<div class="lb-seat lb-player${me ? ' me' : ''}${fresh.has(p.id) ? ' new' : ''}" style="--i:${i}">
        ${p.id === hostId ? '' : pingHtml(p.ms)}
        <div class="lb-face" style="background-image:url(${face(p.god)})">${p.id === hostId ? '<i class="lb-crown" title="Host">♛</i>' : ''}</div>
        <b>${esc(p.name)}</b><span>${me ? 'You' : p.id === hostId ? 'Host' : 'Friend'}</span>
      </div>`;
    };
    const seatsFor = (team: 'order' | 'chaos', n: number) => {
      const here = s.players.filter((p) => s.mode !== 'versus' || p.team === team);
      const count = Math.max(n, here.length);
      return `<div class="lb-seats" style="--n:${count}">${Array.from({ length: count }, (_, i) => seatHtml(here[i], team, i)).join('')}</div>`;
    };
    // versus: the two teams face each other (side by side when they're small enough, else one above the other)
    const perTeam = Math.ceil(cap / 2);
    const duo = s.mode === 'versus' && perTeam <= 3;
    const side = (t: 'order' | 'chaos') => `<div class="lb-side lb-${t}"><div class="lb-tname">${t === 'order' ? 'Order' : 'Chaos'}${t === mine ? ' <i>your team</i>' : ''}</div>${seatsFor(t, perTeam)}</div>`;
    const seats = s.mode === 'versus' ? `${side('order')}${duo ? '<div class="lb-vs">VS</div>' : ''}${side('chaos')}` : `<div class="lb-side">${seatsFor('order', cap)}</div>`;
    const filled = s.players.length;
    const newsIn = news !== shownNews;
    shownNews = news;
    const enter = entering;
    entering = false;
    view.innerHTML = `
      <div class="lb-head">
        <div class="lb-title"><b>${esc(hooks.game(s.game)?.name ?? s.game)}</b><span>${MODE_NAMES[s.mode]} lobby &middot; ${filled} of ${cap}</span></div>
        <button class="lb-codebox" title="Copy the code" data-sound="none"><span class="lb-show">${esc(s.code)}</span><small>${copied === 'code' ? 'Copied' : 'Code'}</small></button>
        <button class="lb-small lb-copy${copied === 'link' ? ' done' : ''}" data-sound="none">${copied === 'link' ? 'Link copied' : 'Copy invite link'}</button>
      </div>
      <div class="lb-seatmap${s.mode === 'versus' ? ' versus' : ''}${duo ? ' duo' : ''}${enter ? ' enter' : ''}">${seats}</div>
      ${botRow ? `<div class="lb-row">${botRow}</div>` : ''}
      <div class="lb-row">
        ${s.mode === 'versus' ? '<button class="lb-small lb-switch">Switch team</button>' : ''}
        <button class="lb-small lb-leave" data-sound="none">Leave</button>
        ${s.isHost ? '<button class="lb-start" data-sound="none">Start match</button>' : '<span class="lb-msg lb-waiting">Waiting for the host to start</span>'}
      </div>
      <div class="lb-msg${news ? ' lb-news' : ''}${newsIn ? ' in' : ''}">${news ? esc(news) : s.isHost ? `${teams.length ? 'Share the code or link. Teams may be uneven: a smaller team hits harder and its souls count for more.' : 'Share the code or link. Open seats are played by bots.'} When you start, everyone has ${PICK_SECONDS} seconds to pick a god.` : `When the host starts, everyone has ${PICK_SECONDS} seconds to pick a god.`}</div>`;
    const copy = (text: string, which: string) => {
      void navigator.clipboard?.writeText(text).then(
        () => flashCopied(which),
        () => undefined,
      );
      hooks.sound?.('ui.toast', 0.7);
    };
    view.querySelector('.lb-codebox')!.addEventListener('click', () => copy(s.code, 'code'));
    view.querySelector('.lb-copy')!.addEventListener('click', () => copy(inviteLink(s.code), 'link'));
    view.querySelector('.lb-switch')?.addEventListener('click', () => s.switchTeam());
    view.querySelectorAll<HTMLButtonElement>('[data-bots]').forEach((b) => b.addEventListener('click', () => s.setBots(b.dataset.bots as 'order' | 'chaos', !s.bots[b.dataset.bots as 'order' | 'chaos'])));
    view.querySelector('.lb-leave')!.addEventListener('click', () => {
      s.close();
      session = null;
      error = '';
      news = '';
      hooks.sound?.('ui.close', 0.7);
      render();
    });
    view.querySelector('.lb-start')?.addEventListener('click', () => {
      hooks.sound?.('ui.play', 0.9);
      s.select();
    });
  };

  const opened = (s: NetSession) => {
    session = s;
    busy = '';
    seen = null;
    entering = true;
    shownNews = news = '';
    hooks.sound?.('ui.open', 0.8);
    s.onLobby = render;
    s.onSelect = () => hooks.onStart(s);
    s.onLeave = (id) => {
      if (id !== 'host' || s.started || s.selecting) return;
      session = null;
      error = 'The host closed the lobby.';
      hooks.sound?.('ui.deny', 0.7);
      render();
    };
    render();
  };

  const host = async (mode: NetMode) => {
    const game = hooks.game();
    const option = game?.hosts.find((h) => h.mode === mode);
    if (!game || !option) return;
    busy = 'Opening a lobby…';
    error = '';
    render();
    try {
      opened(await NetSession.host(mode, hooks.god(), game.id, option.cap, nameInput.value.trim()));
    } catch (e) {
      busy = '';
      error = (e as Error).message;
      render();
    }
  };

  const join = async (code: string) => {
    if (code.trim().length < 5) {
      error = 'Lobby codes are 5 letters and digits.';
      render();
      return;
    }
    busy = 'Joining…';
    error = '';
    render();
    try {
      opened(await NetSession.join(code, hooks.god(), nameInput.value.trim()));
    } catch (e) {
      busy = '';
      error = (e as Error).message;
      render();
    }
  };

  render();
  const invited = new URLSearchParams(location.search).get('join');
  if (invited) void join(invited);
  return {
    // the host buttons follow the title screen's mode (a lobby keeps its own)
    gameChanged: () => {
      if (!session) render();
    },
  };
}
