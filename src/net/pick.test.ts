import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetSession, PICK_SECONDS, type Msg } from './Session';

/**
 * The god pick before an online match, with a host and guests joined in
 * memory: every message arrives at once, as over a perfect network.
 */
type End = NetSession;
/** The session's private message plumbing, which a test drives directly. */
type Raw = { receive(from: string, msg: Msg, conn?: unknown): void; lost(id: string): void; conns: Map<string, unknown> };
const raw = (s: NetSession) => s as unknown as Raw;

function make(role: 'host' | 'guest', id: string): End {
  const Ctor = NetSession as unknown as new (role: string, mode: string, code: string, peer: unknown) => End;
  return new Ctor(role, 'coop', 'ABCDE', { id, destroy() {} });
}

/** A connection whose sends land straight in `to`'s receive, as from `from`. */
function wire(to: End, from: string) {
  return {
    open: true,
    peer: from,
    send: (text: string) => raw(to).receive(to.isHost ? from : 'host', JSON.parse(text) as Msg),
    close() {},
    on() {},
  };
}

function lobby(guests: string[]) {
  const host = make('host', 'h');
  host.game = 'rush';
  host.cap = 6;
  host.players = [{ id: 'h', name: 'Player 1', god: 'zeus', team: 'order' }];
  const ends = guests.map((id) => {
    const g = make('guest', id);
    raw(g).conns.set('host', wire(host, id));
    raw(host).receive(id, { t: 'hello', god: 'thor' }, wire(g, 'h'));
    return g;
  });
  return { host, guests: ends };
}

describe('online god pick', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the host starts a 20 second pick for everyone, and the match starts when all are ready', () => {
    const { host, guests } = lobby(['a', 'b']);
    const selected: string[] = [];
    const started: string[] = [];
    for (const s of [host, ...guests]) {
      s.onSelect = () => selected.push(s.me);
      s.onStart = () => started.push(s.me);
    }
    host.select();
    expect(selected.sort()).toEqual(['a', 'b', 'h']);
    expect(PICK_SECONDS).toBe(20);
    for (const g of guests) {
      expect(g.selecting).toBe(true);
      expect(g.pickLeft).toBeGreaterThan(19);
      expect(g.pickLeft).toBeLessThanOrEqual(20);
    }
    // picks reach the host and everyone else
    guests[0]!.pick('loki');
    expect(host.players.find((p) => p.id === 'a')!.god).toBe('loki');
    expect(guests[1]!.players.find((p) => p.id === 'a')!.god).toBe('loki');
    // ready players can't change god; the match waits for the last one
    guests[0]!.lockIn();
    guests[0]!.pick('odin');
    expect(host.players.find((p) => p.id === 'a')!.god).toBe('loki');
    host.lockIn('anubis');
    expect(started).toEqual([]);
    guests[1]!.lockIn('odin');
    expect(started.sort()).toEqual(['a', 'b', 'h']);
    for (const g of guests) expect(g.players.map((p) => p.god)).toEqual(['anubis', 'loki', 'odin']);
    // the timer was cleared: nothing starts twice
    vi.advanceTimersByTime(PICK_SECONDS * 1000);
    expect(started).toHaveLength(3);
  });

  it('when the clock runs out the match starts with each god as picked', () => {
    const { host, guests } = lobby(['a']);
    let started = 0;
    host.onStart = () => started++;
    guests[0]!.onStart = () => started++;
    host.select();
    guests[0]!.pick('anubis');
    vi.advanceTimersByTime(PICK_SECONDS * 1000 - 100);
    expect(started).toBe(0);
    vi.advanceTimersByTime(200);
    expect(started).toBe(2);
    expect(guests[0]!.players.find((p) => p.id === 'a')!.god).toBe('anubis');
  });

  it('nobody can join, switch teams or change bots once the pick has begun', () => {
    const { host } = lobby(['a']);
    host.select();
    const sent: Msg[] = [];
    raw(host).receive('late', { t: 'hello', god: 'odin' }, { open: true, peer: 'late', send: (t: string) => sent.push(JSON.parse(t) as Msg), close() {}, on() {} });
    expect(host.players.map((p) => p.id)).toEqual(['h', 'a']);
    expect(sent[0]!.t).toBe('full');
    raw(host).receive('a', { t: 'bots', team: 'order', on: false });
    expect(host.bots.order).toBe(true);
  });

  it('a guest who leaves mid-pick no longer holds the others up', () => {
    const { host } = lobby(['a', 'b']);
    let started = false;
    host.onStart = () => (started = true);
    host.select();
    host.lockIn();
    raw(host).receive('a', { t: 'lockin', god: 'loki' });
    expect(started).toBe(false);
    raw(host).lost('b');
    expect(started).toBe(true);
  });
});
