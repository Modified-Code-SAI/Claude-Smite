import { describe, expect, it } from 'vitest';
import { NetSession, type Msg } from './Session';
import { cleanName, NAME_MAX } from './roster';

/** Players' names in a lobby, with a host and guests joined in memory (as in pick.test.ts). */
type Raw = { receive(from: string, msg: Msg, conn?: unknown): void; conns: Map<string, unknown> };
const raw = (s: NetSession) => s as unknown as Raw;

function make(role: 'host' | 'guest', id: string): NetSession {
  const Ctor = NetSession as unknown as new (role: string, mode: string, code: string, peer: unknown) => NetSession;
  return new Ctor(role, 'coop', 'ABCDE', { id, destroy() {} });
}

function wire(to: NetSession, from: string) {
  return { open: true, peer: from, send: (text: string) => raw(to).receive(to.isHost ? from : 'host', JSON.parse(text) as Msg), close() {}, on() {} };
}

function lobby(names: (string | undefined)[]) {
  const host = make('host', 'h');
  host.players = [{ id: 'h', name: cleanName('Austin', 'Player 1'), god: 'zeus', team: 'order' }];
  const guests = names.map((name, i) => {
    const id = `g${i}`;
    const g = make('guest', id);
    raw(g).conns.set('host', wire(host, id));
    raw(host).receive(id, { t: 'hello', god: 'thor', ...(name === undefined ? {} : { name }) }, wire(g, 'h'));
    return g;
  });
  return { host, guests };
}

describe('player names', () => {
  it('keeps letters, digits, spaces and . _ \' - only, folded and cut to length', () => {
    expect(cleanName('  Thor   Fan  ', 'X')).toBe('Thor Fan');
    expect(cleanName('<img src=x onerror=alert(1)>', 'X')).toBe('img srcx onerror');
    expect(cleanName('Zoë_the-Brave.', 'X')).toBe('Zoë_the-Brave.');
    expect(cleanName('名前テスト', 'X')).toBe('名前テスト');
    expect(cleanName('&"<>', 'Player 2')).toBe('Player 2');
    expect(cleanName(42, 'Player 2')).toBe('Player 2');
    expect(Array.from(cleanName('a'.repeat(40), 'X'))).toHaveLength(NAME_MAX);
    // an emoji pair is not cut in half: it is dropped whole
    expect(cleanName('Loki😈', 'X')).toBe('Loki');
  });

  it('a guest joins under their own name, or is numbered without one; everyone sees the same list', () => {
    const { host, guests } = lobby(['Sam', undefined, '<b>Rae</b>']);
    expect(host.players.map((p) => p.name)).toEqual(['Austin', 'Sam', 'Player 3', 'bRaeb']);
    for (const g of guests) expect(g.players.map((p) => p.name)).toEqual(host.players.map((p) => p.name));
  });

  it('a player renames in the lobby, but not once the pick has begun', () => {
    const { host, guests } = lobby(['Sam']);
    guests[0]!.rename('Samwise');
    host.rename('Austin P');
    expect(guests[0]!.players.map((p) => p.name)).toEqual(['Austin P', 'Samwise']);
    host.select();
    guests[0]!.rename('Late');
    host.rename('Later');
    expect(host.players.map((p) => p.name)).toEqual(['Austin P', 'Samwise']);
    host.close();
  });

  it('a guest cleans names a host sends', () => {
    const g = make('guest', 'g');
    raw(g).receive('host', { t: 'lobby', mode: 'coop', game: 'rush', players: [{ id: 'h', name: '<script>x</script>', god: 'zeus', team: 'order' }], bots: {} });
    expect(g.players[0]!.name).toBe('scriptxscript');
  });
});
