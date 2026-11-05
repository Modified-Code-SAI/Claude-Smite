import { describe, expect, it } from 'vitest';
import { GodVoice, ROOM_BETWEEN, type VoiceEngine } from './GodVoice';
import { GOD_LINES } from './godLines';

/** An engine stand-in: every clip one second long, the clock moved by hand. */
function fakeEngine() {
  const played: { name: string; variant: number; at: unknown; stopped: boolean }[] = [];
  const loads: [string, readonly string[]][] = [];
  const clips = new Set<string>();
  const e = {
    ready: true,
    now: 0,
    has: (n: string) => clips.has(n),
    buffer: () => ({ duration: 1 }) as AudioBuffer,
    play: (name: string, o: { variant?: number; at?: unknown } = {}) => {
      const p = { name, variant: o.variant ?? 0, at: o.at, stopped: false };
      played.push(p);
      return { stop: () => (p.stopped = true) } as unknown as AudioBufferSourceNode;
    },
    loadClips: (name: string, urls: readonly string[]) => {
      loads.push([name, urls]);
      clips.add(name);
      return Promise.resolve(true);
    },
  };
  return { e: e as unknown as VoiceEngine & { now: number }, played, loads };
}

describe('god voice', () => {
  it('fetches each line once, from the god folder', () => {
    const { e, loads } = fakeEngine();
    const v = new GodVoice(e, '/base/');
    v.load('thor');
    v.load('thor');
    expect(loads).toHaveLength(9);
    expect(loads.find(([n]) => n === 'line.thor.kill')![1]).toEqual(['/base/voices/thor/kill-1.mp3', '/base/voices/thor/kill-2.mp3', '/base/voices/thor/kill-3.mp3']);
    v.load('nobody');
    expect(loads).toHaveLength(9);
  });

  it('says nothing it has not loaded', () => {
    const { e, played } = fakeEngine();
    expect(new GodVoice(e, '').say({}, 'zeus', 'kill', { own: true })).toBe(0);
    expect(played).toHaveLength(0);
  });

  it('never says the same line twice running', () => {
    const { e, played } = fakeEngine();
    const v = new GodVoice(e, '');
    v.load('loki');
    const me = {};
    for (let i = 0; i < 40; i++) {
      e.now += 2;
      expect(v.say(me, 'loki', 'taunt', { own: true })).toBe(1);
    }
    for (let i = 1; i < played.length; i++) expect(played[i]!.variant).not.toBe(played[i - 1]!.variant);
    expect(new Set(played.map((p) => p.variant)).size).toBe(GOD_LINES.loki!.taunt.length);
  });

  it('lets a god finish, except for a death or an ultimate, which cut in', () => {
    const { e, played } = fakeEngine();
    const v = new GodVoice(e, '');
    v.load('odin');
    const odin = {};
    v.say(odin, 'odin', 'taunt', { own: true });
    e.now = 0.5;
    expect(v.say(odin, 'odin', 'kill', { own: true })).toBe(0);
    expect(v.say(odin, 'odin', 'death', { own: true })).toBe(1);
    expect(played.map((p) => [p.name, p.stopped])).toEqual([
      ['line.odin.taunt', true],
      ['line.odin.death', false],
    ]);
  });

  it('leaves room between other gods, but never holds back your own', () => {
    const { e } = fakeEngine();
    const v = new GodVoice(e, '');
    v.load('zeus');
    v.load('anubis');
    const [a, b, me] = [{}, {}, {}];
    expect(v.say(a, 'zeus', 'kill', { own: false, at: { x: 1, z: 1 } })).toBe(1);
    e.now = 1.2;
    expect(v.say(b, 'anubis', 'taunt', { own: false, at: { x: 2, z: 2 } })).toBe(0);
    expect(v.say(me, 'anubis', 'taunt', { own: true })).toBe(1);
    e.now = 1 + ROOM_BETWEEN + 0.01;
    expect(v.say(b, 'anubis', 'taunt', { own: false, at: { x: 2, z: 2 } })).toBe(1);
  });

  it('plays the line everyone was sent when a variant is named', () => {
    const { e, played } = fakeEngine();
    const v = new GodVoice(e, '');
    v.load('thor');
    v.say({}, 'thor', 'taunt', { own: false, variant: 7 });
    expect(played[0]!.variant).toBe(7 % GOD_LINES.thor!.taunt.length);
  });
});
