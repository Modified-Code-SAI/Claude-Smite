import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type { Side } from '../game/combatant';
import { cleanName, teamFor, TEAM_SIZE, type NetMode, type NetPlayer } from './roster';

/** Every message is a JSON object with a type tag. */
export interface Msg {
  t: string;
  [key: string]: unknown;
}

/** Peer ids on the shared signaling server start with this, so lobby codes stay short. */
const PREFIX = 'ascendant-lobby-';
/** No 0/O or 1/I, so a code read aloud or typed from a screenshot comes out right. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const JOIN_TIMEOUT = 45000;
/** How often the host times each guest's round trip while the lobby is open. */
const ECHO_EVERY = 2000;
/** How long everyone has to pick a god once the host starts the match. */
export const PICK_SECONDS = 20;

function newCode(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

/**
 * Where peers find each other. The free public PeerJS server by default;
 * `?peer=host:port` points at another one (a local `npx peerjs` for testing).
 */
function peerOptions(): PeerOptions {
  const custom = new URLSearchParams(location.search).get('peer');
  if (!custom) return {};
  const [host, port] = custom.split(':');
  return { host, port: Number(port ?? 9000), path: '/', secure: location.protocol === 'https:' };
}

/** Numbers in snapshots keep two decimals: centimeters and hundredths of a second. */
function round(_key: string, v: unknown): unknown {
  return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v;
}

export function encode(msg: Msg): string {
  return JSON.stringify(msg, round);
}

/**
 * A multiplayer lobby and, once it starts, the match's connections. One
 * player hosts: their browser runs the match, and everyone else connects to
 * them directly over WebRTC data channels (the signaling server only
 * introduces the peers). Guests send their inputs; the host sends the match.
 */
export class NetSession {
  players: NetPlayer[] = [];
  started = false;
  /**
   * The god pick before the match: the host pressed Start, and everyone has
   * PICK_SECONDS to choose and press Ready. The match starts when the clock
   * runs out or everyone is ready, each on the god they had then.
   */
  selecting = false;
  /** When the pick ends, on this browser's clock (performance.now). */
  pickEnds = 0;
  /** Lobby changes: someone joined, left, picked a god, switched teams or got ready. */
  onLobby: () => void = () => undefined;
  /** The host started the god pick. */
  onSelect: () => void = () => undefined;
  /** The pick is over: the match starts, with everyone's god final. */
  onStart: () => void = () => undefined;
  private pickTimer: ReturnType<typeof setTimeout> | null = null;
  private echoTimer: ReturnType<typeof setInterval> | null = null;
  /** Each guest's last few round trips (host only). */
  private readonly trips = new Map<string, number[]>();
  /** Someone left: a guest (on the host) or the host (on a guest, id 'host'). */
  onLeave: (id: string) => void = () => undefined;
  private handler: ((from: string, msg: Msg) => void) | null = null;
  private early: [string, Msg][] = [];
  private readonly conns = new Map<string, DataConnection>();

  /** The game mode the lobby plays (the title screen's mode id: 'conquest', …). */
  game = 'conquest';
  /** Most players the lobby takes (host only). */
  cap = TEAM_SIZE;
  /** Whether bots fill each team's empty spots (modes that let a team choose: Underworld Descent). */
  bots: Record<Side, boolean> = { order: true, chaos: true };

  private constructor(
    readonly role: 'host' | 'guest',
    public mode: NetMode,
    readonly code: string,
    private readonly peer: Peer,
  ) {}

  /** This player's id. */
  get me(): string {
    return this.peer.id;
  }

  get isHost(): boolean {
    return this.role === 'host';
  }

  /**
   * Open a lobby with a fresh code, for a game mode (Conquest by default) and
   * at most `cap` players (Conquest's five a team by default), under the
   * host's `name` (Player 1 without one).
   */
  static host(mode: NetMode, god: string, game = 'conquest', cap = mode === 'coop' ? TEAM_SIZE : TEAM_SIZE * 2, name = ''): Promise<NetSession> {
    return new Promise((resolve, reject) => {
      const attempt = (tries: number) => {
        const code = newCode();
        const peer = new Peer(PREFIX + code, peerOptions());
        let open = false;
        peer.on('open', () => {
          open = true;
          const s = new NetSession('host', mode, code, peer);
          s.game = game;
          s.cap = cap;
          s.players = [{ id: peer.id, name: cleanName(name, 'Player 1'), god, team: 'order' }];
          peer.on('connection', (c) => s.accept(c));
          s.echoTimer = setInterval(() => s.measure(), ECHO_EVERY);
          resolve(s);
        });
        peer.on('error', (err) => {
          // once open, the lobby lives on its direct connections; a signaling hiccup doesn't end it
          if (open) return;
          peer.destroy();
          if (err.type === 'unavailable-id' && tries > 0) attempt(tries - 1);
          else reject(new Error(describe(err.type)));
        });
      };
      attempt(3);
    });
  }

  /** Join the lobby with this code, under `name` (the host numbers a player without one). */
  static join(code: string, god: string, name = ''): Promise<NetSession> {
    code = code.trim().toUpperCase();
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerOptions());
      let joined = false;
      const fail = (why: string) => {
        if (joined) return;
        clearTimeout(timer);
        peer.destroy();
        reject(new Error(why));
      };
      const timer = setTimeout(() => fail('No answer from that lobby. Check the code, or ask the host to open a new one.'), JOIN_TIMEOUT);
      peer.on('error', (err) => fail(describe(err.type)));
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'raw' });
        const s = new NetSession('guest', 'coop', code, peer);
        conn.on('open', () => conn.send(encode({ t: 'hello', god, name })));
        conn.on('data', (d) => {
          const msg = JSON.parse(d as string) as Msg;
          if (msg.t === 'full') return fail(msg.why as string);
          if (msg.t === 'lobby' && !s.conns.has('host')) {
            joined = true;
            clearTimeout(timer);
            s.conns.set('host', conn);
            conn.on('close', () => s.lost('host'));
            resolve(s);
          }
          s.receive('host', msg);
        });
      });
    });
  }

  /** This player's lobby entry. */
  self(): NetPlayer | undefined {
    return this.players.find((p) => p.id === this.me);
  }

  /** Change this player's god in the lobby or the pick (not once they are ready). */
  pick(god: string): void {
    if (this.started || this.self()?.ready) return;
    if (this.isHost) this.update(this.me, { god });
    else this.send('host', { t: 'pick', god });
  }

  /** Change this player's name in the lobby (not once the pick has begun). */
  rename(name: string): void {
    if (this.started || this.selecting) return;
    const me = this.self();
    if (!me) return;
    if (this.isHost) this.update(this.me, { name: cleanName(name, me.name) });
    else this.send('host', { t: 'name', name });
  }

  /** Seconds left in the god pick. */
  get pickLeft(): number {
    return this.selecting ? Math.max(0, (this.pickEnds - performance.now()) / 1000) : 0;
  }

  /**
   * Host: time each guest's round trip (an echo they send straight back).
   * Runs every couple of seconds while the lobby is open; everyone sees the
   * result on the guest's seat.
   */
  measure(): void {
    if (!this.isHost || this.started || this.selecting) return;
    for (const id of this.conns.keys()) this.send(id, { t: 'echo', at: performance.now() });
  }

  /** Host: start the god pick for everyone in the lobby. */
  select(seconds = PICK_SECONDS): void {
    if (!this.isHost || this.started || this.selecting) return;
    this.stopEcho();
    this.selecting = true;
    this.pickEnds = performance.now() + seconds * 1000;
    for (const p of this.players) p.ready = false;
    this.broadcast({ t: 'select', mode: this.mode, game: this.game, players: this.players, bots: this.bots, left: seconds });
    this.pickTimer = setTimeout(() => this.start(), seconds * 1000);
    this.onSelect();
  }

  /** This player locks in their god. */
  lockIn(god?: string): void {
    if (!this.selecting || this.started) return;
    if (god) this.pick(god);
    if (this.isHost) {
      this.update(this.me, { ready: true });
      this.allReady();
    } else this.send('host', { t: 'lockin', god: god ?? this.self()?.god });
  }

  /** Host: everyone ready ends the pick early. */
  private allReady(): void {
    if (this.isHost && this.selecting && this.players.every((p) => p.ready)) this.start();
  }

  /** Switch this player's team (versus only). */
  switchTeam(): void {
    const p = this.self();
    if (!p || this.mode !== 'versus') return;
    const team: Side = p.team === 'order' ? 'chaos' : 'order';
    if (this.isHost) this.update(this.me, { team });
    else this.send('host', { t: 'team', team });
  }

  /** Turn bot teammates on or off for a team: the host for any team, a guest for their own. */
  setBots(team: Side, on: boolean): void {
    if (this.started) return;
    if (this.isHost) {
      this.bots[team] = on;
      this.changed();
    } else if (this.self()?.team === team) this.send('host', { t: 'bots', team, on });
  }

  /** Host: start the match for everyone in the lobby (at the end of the god pick). */
  start(): void {
    if (!this.isHost || this.started) return;
    if (this.pickTimer) clearTimeout(this.pickTimer);
    this.started = true;
    this.selecting = false;
    this.stopEcho();
    this.broadcast({ t: 'start', mode: this.mode, game: this.game, players: this.players, bots: this.bots });
    this.onStart();
  }

  /** In-match messages go here once the match is set up; earlier ones wait. */
  listen(handler: (from: string, msg: Msg) => void): void {
    this.handler = handler;
    for (const [from, msg] of this.early.splice(0)) handler(from, msg);
  }

  send(to: string, msg: Msg | string): void {
    const c = this.conns.get(to);
    if (c?.open) c.send(typeof msg === 'string' ? msg : encode(msg));
  }

  broadcast(msg: Msg | string): void {
    const text = typeof msg === 'string' ? msg : encode(msg);
    for (const id of this.conns.keys()) this.send(id, text);
  }

  /** Ids of the guests still connected (host only). */
  get guests(): string[] {
    return this.isHost ? [...this.conns.keys()] : [];
  }

  close(): void {
    if (this.pickTimer) clearTimeout(this.pickTimer);
    this.stopEcho();
    this.peer.destroy();
  }

  private stopEcho(): void {
    if (this.echoTimer) clearInterval(this.echoTimer);
    this.echoTimer = null;
  }

  // -------------------------------------------------------------------------

  private accept(conn: DataConnection): void {
    conn.on('data', (d) => this.receive(conn.peer, JSON.parse(d as string) as Msg, conn));
    conn.on('close', () => this.lost(conn.peer));
    conn.on('error', () => this.lost(conn.peer));
  }

  private receive(from: string, msg: Msg, conn?: DataConnection): void {
    switch (msg.t) {
      case 'hello': {
        if (!conn || !this.isHost) return;
        const why = this.started || this.selecting ? 'That match has already started.' : this.players.length >= this.cap ? 'That lobby is full.' : null;
        if (why) {
          conn.send(encode({ t: 'full', why }));
          setTimeout(() => conn.close(), 500);
          return;
        }
        this.conns.set(from, conn);
        this.players.push({ id: from, name: cleanName(msg.name, `Player ${this.players.length + 1}`), god: msg.god as string, team: teamFor(this.mode, this.players) });
        this.changed();
        return;
      }
      case 'pick':
        if (this.isHost && !this.started && !this.players.find((p) => p.id === from)?.ready) this.update(from, { god: msg.god as string });
        return;
      case 'lockin': {
        if (!this.isHost || !this.selecting || this.started) return;
        const p = this.players.find((x) => x.id === from);
        if (!p) return;
        this.update(from, { ready: true, ...(typeof msg.god === 'string' && !p.ready ? { god: msg.god } : {}) });
        this.allReady();
        return;
      }
      case 'echo':
        // a guest answers the host's echo at once, with the host's own clock reading
        if (!this.isHost && from === 'host') this.send('host', { t: 'echoed', at: msg.at });
        return;
      case 'echoed': {
        const p = this.players.find((x) => x.id === from);
        const at = Number(msg.at);
        if (!this.isHost || !p || this.started || this.selecting || !Number.isFinite(at)) return;
        // the best of the last few: a guest's page busy loading the match answers late, which isn't their connection
        const trips = [...(this.trips.get(from) ?? []), Math.max(0, performance.now() - at)].slice(-4);
        this.trips.set(from, trips);
        const ms = Math.round(Math.min(...trips));
        // shared only when it moves enough to read differently
        if (p.ms === undefined || Math.abs(ms - p.ms) >= 5) this.update(from, { ms });
        else p.ms = ms;
        return;
      }
      case 'name': {
        const p = this.players.find((x) => x.id === from);
        if (this.isHost && p && !this.started && !this.selecting) this.update(from, { name: cleanName(msg.name, p.name) });
        return;
      }
      case 'team':
        if (this.isHost && !this.started && !this.selecting && this.mode === 'versus') this.update(from, { team: msg.team as Side });
        return;
      case 'bots': {
        // a player may only speak for their own team
        const team = msg.team === 'chaos' ? 'chaos' : 'order';
        if (!this.isHost || this.started || this.selecting || this.players.find((p) => p.id === from)?.team !== team) return;
        this.bots[team] = msg.on !== false;
        this.changed();
        return;
      }
      case 'lobby':
        this.mode = msg.mode as NetMode;
        this.game = (msg.game as string | undefined) ?? 'conquest';
        this.players = readPlayers(msg.players);
        this.bots = readBots(msg.bots);
        // the host's clock keeps every pick screen's countdown in step
        if (this.selecting && typeof msg.left === 'number') this.pickEnds = performance.now() + msg.left * 1000;
        this.onLobby();
        return;
      case 'select':
        if (this.isHost || this.started || this.selecting) return;
        this.mode = msg.mode as NetMode;
        this.game = (msg.game as string | undefined) ?? 'conquest';
        this.players = readPlayers(msg.players);
        this.bots = readBots(msg.bots);
        this.selecting = true;
        this.pickEnds = performance.now() + (typeof msg.left === 'number' ? msg.left : PICK_SECONDS) * 1000;
        this.onSelect();
        return;
      case 'start':
        if (this.isHost || this.started) return;
        this.mode = msg.mode as NetMode;
        this.game = (msg.game as string | undefined) ?? 'conquest';
        this.players = readPlayers(msg.players);
        this.bots = readBots(msg.bots);
        this.started = true;
        this.selecting = false;
        this.onStart();
        return;
      default:
        if (this.handler) this.handler(from, msg);
        else this.early.push([from, msg]);
    }
  }

  private update(id: string, change: Partial<NetPlayer>): void {
    const p = this.players.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, change);
    this.changed();
  }

  private changed(): void {
    this.broadcast({ t: 'lobby', mode: this.mode, game: this.game, players: this.players, bots: this.bots, ...(this.selecting ? { left: this.pickLeft } : {}) });
    this.onLobby();
  }

  private lost(id: string): void {
    if (!this.conns.delete(id)) return;
    this.trips.delete(id);
    if (this.isHost && !this.started) {
      this.players = this.players.filter((p) => p.id !== id);
      this.changed();
      // whoever is left may all be ready now
      this.allReady();
    }
    this.onLeave(id);
  }
}

/** The host's player list, names cleaned as the host cleans them. */
function readPlayers(v: unknown): NetPlayer[] {
  return (Array.isArray(v) ? (v as NetPlayer[]) : []).map((p, i) => ({ ...p, name: cleanName(p.name, `Player ${i + 1}`), ms: typeof p.ms === 'number' && Number.isFinite(p.ms) ? Math.max(0, Math.round(p.ms)) : undefined }));
}

function readBots(v: unknown): Record<Side, boolean> {
  const b = (v ?? {}) as Partial<Record<Side, unknown>>;
  return { order: b.order !== false, chaos: b.chaos !== false };
}

function describe(type: string): string {
  switch (type) {
    case 'peer-unavailable':
      return 'No lobby with that code. Check it, or ask the host to open a new one.';
    case 'browser-incompatible':
      return 'This browser does not support peer-to-peer connections.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the matchmaking server. Check your connection and try again.';
    default:
      return `Connection failed (${type}).`;
  }
}
