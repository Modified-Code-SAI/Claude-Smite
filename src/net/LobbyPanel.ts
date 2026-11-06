import { NetSession, PICK_SECONDS } from './Session';
import type { NetGameInfo, NetMode } from './roster';
import './lobby.css';

const MODE_NAMES: Record<NetMode, string> = { coop: 'Co-op', versus: 'Versus' };

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
 * The home page's "Play with friends" box: host a lobby for the selected
 * game mode (its co-op or versus options, and share its code), or join one
 * with a code. Calls `onStart` when the host starts the match, which opens
 * the god pick for everyone (src/ui/GodPick.ts). `inLobby` tells
 * the title screen to hold its own Play button (and its mode) while a lobby is
 * open; `onGame` tells it which mode a joined lobby plays.
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
  },
): { gameChanged: () => void } {
  let session: NetSession | null = null;
  let busy = '';
  let error = '';

  const render = () => {
    hooks.inLobby(session !== null);
    if (session) hooks.onGame(session.game);
    if (!session) {
      const game = hooks.game();
      const hosts = game?.hosts ?? [];
      const most = Math.max(0, ...hosts.map((h) => h.cap));
      const note = hosts.length ? `One player hosts and runs the match; up to ${most} players.` : `${game?.name ?? 'This mode'} is single player for now. Pick a mode above with online play to host, or join a friend's lobby.`;
      box.innerHTML = `
        <div class="lb-row">
          ${hosts.map((h) => `<button class="lb-btn" data-host="${h.mode}"><b>${esc(h.label)}</b><span>${esc(h.text)}</span></button>`).join('')}
        </div>
        <div class="lb-row lb-join">
          <input class="lb-code" maxlength="5" placeholder="Lobby code" spellcheck="false" autocomplete="off">
          <button class="lb-small lb-go">Join</button>
        </div>
        <div class="lb-msg ${error ? 'lb-err' : ''}">${esc(busy || error || note)}</div>`;
      box.querySelectorAll<HTMLButtonElement>('[data-host]').forEach((b) => b.addEventListener('click', () => void host(b.dataset.host as NetMode)));
      const input = box.querySelector<HTMLInputElement>('.lb-code')!;
      const go = () => void join(input.value);
      box.querySelector('.lb-go')!.addEventListener('click', go);
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') go();
      });
      if (busy) box.querySelectorAll('button, input').forEach((el) => ((el as HTMLButtonElement).disabled = true));
      return;
    }
    const s = session;
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
    const rows = s.players
      .map((p, i) => {
        const you = p.id === s.me ? ' <i>(you)</i>' : '';
        const role = i === 0 ? '<span class="lb-host">Host</span>' : '<span></span>';
        const team = s.mode === 'versus' ? `<span class="lb-team lb-${p.team}">${p.team === 'order' ? 'Order' : 'Chaos'}</span>` : '<span></span>';
        return `<div class="lb-player"><span>${esc(p.name)}${you}</span>${role}${team}</div>`;
      })
      .join('');
    box.innerHTML = `
      <div class="lb-head">
        <span>${esc(hooks.game(s.game)?.name ?? s.game)} &middot; ${MODE_NAMES[s.mode]} lobby <b class="lb-show">${s.code}</b></span>
        <button class="lb-small lb-copy">Copy invite link</button>
      </div>
      <div class="lb-players">${rows}</div>
      ${botRow ? `<div class="lb-row">${botRow}</div>` : ''}
      <div class="lb-row">
        ${s.mode === 'versus' ? '<button class="lb-small lb-switch">Switch team</button>' : ''}
        <button class="lb-small lb-leave">Leave</button>
        ${s.isHost ? '<button class="lb-start">Start match</button>' : '<span class="lb-msg">Waiting for the host to start…</span>'}
      </div>
      <div class="lb-msg">${s.isHost ? `${teams.length ? 'Share the code or link. Teams may be uneven: a smaller team hits harder and its souls count for more.' : 'Share the code or link. Empty slots are played by bots.'} When you start, everyone has ${PICK_SECONDS} seconds to pick a god.` : `When the host starts, everyone has ${PICK_SECONDS} seconds to pick a god.`}</div>`;
    box.querySelector('.lb-copy')!.addEventListener('click', (e) => {
      void navigator.clipboard?.writeText(inviteLink(s.code));
      (e.currentTarget as HTMLButtonElement).textContent = 'Copied';
    });
    box.querySelector('.lb-switch')?.addEventListener('click', () => s.switchTeam());
    box.querySelectorAll<HTMLButtonElement>('[data-bots]').forEach((b) => b.addEventListener('click', () => s.setBots(b.dataset.bots as 'order' | 'chaos', !s.bots[b.dataset.bots as 'order' | 'chaos'])));
    box.querySelector('.lb-leave')!.addEventListener('click', () => {
      s.close();
      session = null;
      error = '';
      render();
    });
    box.querySelector('.lb-start')?.addEventListener('click', () => s.select());
  };

  const opened = (s: NetSession) => {
    session = s;
    busy = '';
    s.onLobby = render;
    s.onSelect = () => hooks.onStart(s);
    s.onLeave = (id) => {
      if (id !== 'host' || s.started || s.selecting) return;
      session = null;
      error = 'The host closed the lobby.';
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
      opened(await NetSession.host(mode, hooks.god(), game.id, option.cap));
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
      opened(await NetSession.join(code, hooks.god()));
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
