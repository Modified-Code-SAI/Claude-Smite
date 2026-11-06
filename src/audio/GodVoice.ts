/**
 * The gods' spoken lines (godLines.ts): fetched per god as it shows up, and
 * said one at a time per god. A death or an ultimate cuts into whatever the
 * god was saying; other gods leave a little room between their lines so a
 * big fight doesn't turn into chatter; and a god never says the same line
 * twice running.
 */

import type { AudioEngine } from './AudioEngine';
import { lineUrl, VOICE_LINES, type VoiceKind } from './godLines';

/** What GodVoice needs from the engine (a stand-in in tests). */
export type VoiceEngine = Pick<AudioEngine, 'ready' | 'now' | 'has' | 'buffer' | 'play' | 'loadClips'>;

export interface SayOptions {
  /** The player's own god (or the one they are looking at in a menu): flat, never held back for others. */
  own: boolean;
  /** Where the god stands; omit for a flat line (your own, a team call). */
  at?: { x: number; y?: number; z: number };
  gain?: number;
  delay?: number;
  /** Which of the lines (wrapped); a fresh one when omitted. */
  variant?: number;
  /** Stop the god's current line for this one (a new pick on the god select screen). */
  cut?: boolean;
}

/** Seconds kept clear after another god's line before the next god may speak. */
export const ROOM_BETWEEN = 0.4;

const clip = (god: string, kind: VoiceKind) => `line.${god}.${kind}`;

export class GodVoice {
  private readonly loaded = new Set<string>();
  private readonly speaking = new WeakMap<object, { until: number; src: AudioBufferSourceNode }>();
  private readonly last = new Map<string, number>();
  private othersUntil = 0;

  constructor(
    private readonly engine: VoiceEngine,
    private readonly base: string,
  ) {}

  /** Fetch a god's (or the giant's) lines (once each), all of them or just some kinds. */
  load(god: string, kinds?: readonly VoiceKind[]): void {
    const lines = VOICE_LINES[god];
    if (!lines) return;
    for (const kind of kinds ?? (Object.keys(lines) as VoiceKind[])) {
      const texts = lines[kind];
      const key = clip(god, kind);
      if (!texts || this.loaded.has(key)) continue;
      this.loaded.add(key);
      void this.engine.loadClips(key, texts.map((_, n) => lineUrl(this.base, god, kind, n)));
    }
  }

  /** Say one of a god's lines for `speaker` (its unit). Returns how long until it ends, or 0 when it was not said. */
  say(speaker: object, god: string, kind: VoiceKind, o: SayOptions): number {
    const key = clip(god, kind);
    const count = VOICE_LINES[god]?.[kind]?.length ?? 0;
    if (!count || !this.engine.ready || !this.engine.has(key)) return 0;
    const now = this.engine.now;
    const cur = this.speaking.get(speaker);
    const urgent = kind === 'death' || kind === 'ult' || !!o.cut;
    if (cur && cur.until > now && !urgent) return 0;
    if (!o.own && !urgent && now < this.othersUntil) return 0;
    const prev = this.last.get(key) ?? -1;
    const variant = o.variant !== undefined ? o.variant % count : count > 1 ? (prev + 1 + Math.floor(Math.random() * (count - 1))) % count : 0;
    const buf = this.engine.buffer(key, variant);
    if (!buf) return 0;
    const delay = o.delay ?? 0;
    const src = this.engine.play(key, { bus: 'voice', gain: o.gain ?? 1, variant, at: o.at, ref: 9, wet: o.at ? 0.04 : 0, delay }, o.own ? 6 : 4);
    if (!src) return 0;
    if (cur && cur.until > now) {
      try {
        cur.src.stop();
      } catch {
        /* already done */
      }
    }
    this.last.set(key, variant);
    const until = now + delay + buf.duration;
    this.speaking.set(speaker, { until, src });
    if (!o.own) this.othersUntil = until + ROOM_BETWEEN;
    return delay + buf.duration;
  }
}
