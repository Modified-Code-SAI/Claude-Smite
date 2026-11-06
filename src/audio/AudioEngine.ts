/**
 * The Web Audio side: one context (created on the first user gesture, as
 * browsers require), a mixer of buses with a shared reverb (the room the
 * world is heard in, rooms.ts), positional voices with distance falloff,
 * loops that follow moving things, and the player's volume settings.
 *
 * Sounds are rendered to Float32Arrays ahead of time (see bank.ts) and only
 * become AudioBuffers once the context exists.
 */

import { RATE } from './dsp';
import { hypot } from '../core/math';
import { ROOMS, roomGain, roomImpulse, type Room } from './rooms';

export type Bus = 'music' | 'sfx' | 'ui' | 'voice' | 'ambience';

export interface AudioSettings {
  master: number;
  music: number;
  sfx: number;
  voice: number;
  ambience: number;
  /** Menu clicks, pings and other interface sounds. */
  ui: number;
  muted: boolean;
}

const STORAGE_KEY = 'ascendant.audio';
export const AUDIO_DEFAULTS: AudioSettings = { master: 0.8, music: 0.55, sfx: 0.85, voice: 0.9, ambience: 0.6, ui: 0.85, muted: false };

/** Mixer trims so the sliders' defaults land at a good balance. */
const BUS_TRIM: Record<Bus, number> = { music: 0.55, sfx: 0.75, ui: 0.6, voice: 1, ambience: 0.7 };
/** Tonal weight per bus in dB (Austin wants more bass than treble); UI and voices stay as they are. */
const WEIGHT: Partial<Record<Bus, { low: number; sub: number; high: number }>> = {
  sfx: { low: 6, sub: 3, high: -4 },
  ambience: { low: 4, sub: 2, high: -3 },
  music: { low: 3, sub: 1.5, high: -2 },
};
const REVERB_SEND: Record<Bus, number> = { music: 0.28, sfx: 0.16, ui: 0.05, voice: 0.12, ambience: 0.1 };

export interface PlayOptions {
  /** World position; omit for flat (UI, music, the player's own feedback). */
  at?: { x: number; y?: number; z: number };
  gain?: number;
  /** Playback rate (pitch); a random spread is added on top when `vary` is set. */
  rate?: number;
  vary?: number;
  bus?: Bus;
  /** Seconds from now. */
  delay?: number;
  /** Extra reverb send (0..1) on top of the bus's. */
  wet?: number;
  /** Which variant to play; random when omitted. */
  variant?: number;
  /** Stereo pan for flat sounds (-1..1). */
  pan?: number;
  /** Positional reference distance (meters at full volume); bigger = carries further. */
  ref?: number;
  /** Loops: seconds into the buffer to start from (random when omitted, so beds never play in step). */
  offset?: number;
}

export interface LoopHandle {
  setPosition(x: number, y: number, z: number): void;
  setGain(g: number, ramp?: number): void;
  setRate(r: number): void;
  stop(fade?: number): void;
  readonly alive: boolean;
}

/** Positional sounds beyond this many meters from the listener are skipped. */
const CULL = 95;
const MAX_VOICES = 56;

/** One room's reverb: its input, the world's send into it, and whether that's connected (a room the world left long enough ago is cut off, so it costs nothing). */
interface RoomNode {
  input: GainNode;
  send: GainNode;
  live: boolean;
  timer: number;
}

interface Voice {
  src: AudioBufferSourceNode;
  started: number;
  priority: number;
  name: string;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses = {} as Record<Bus, GainNode>;
  /** Per-bus extra reverb sends, scaled by the bus volume like the dry signal. */
  private wetIns = {} as Record<Bus, GainNode>;
  private readonly settingsListeners: ((s: AudioSettings) => void)[] = [];
  /** The reverb's sends: the world's sounds go into the room they're heard in; the music and the interface always ring in the hall. */
  private reverbIn!: GainNode;
  private hallIn!: GainNode;
  /** The space the world is heard in (rooms.ts), and the rooms built so far. */
  private room: Room = 'hall';
  private readonly rooms = new Map<Room, RoomNode>();
  private readonly muffles: BiquadFilterNode[] = [];
  private readonly airLoops = new Set<AirSpot>();
  private readonly airFrom = { x: 0, z: 0 };
  private musicDuck!: GainNode;
  private muffle = 0;
  private readonly raw = new Map<string, { data: Float32Array[]; loop: boolean }>();
  private readonly layers = new Map<string, (data: Float32Array[], loop: boolean) => Float32Array[]>();
  private readonly buffers = new Map<string, AudioBuffer[]>();
  private readonly clipLoads = new Map<string, Promise<boolean>>();
  private readonly voices: Voice[] = [];
  private readonly lastPlayed = new Map<string, number>();
  readonly listenerPos = { x: 0, y: 0, z: 0 };
  settings: AudioSettings = loadSettings();
  private readonly unlockListeners: (() => void)[] = [];

  constructor() {
    const unlock = () => {
      this.unlock();
      if (this.ctx?.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Runs `fn` once audio is unlocked (immediately if it already is). */
  onUnlock(fn: () => void): void {
    if (this.ready) fn();
    else this.unlockListeners.push(fn);
  }

  /** Create or resume the context. Must run inside a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor({ latencyHint: 'interactive' });
      } catch {
        return;
      }
      this.build();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().then(() => this.flushUnlock());
    else this.flushUnlock();
  }

  private flushUnlock(): void {
    if (!this.ready) return;
    const fns = this.unlockListeners.splice(0);
    for (const f of fns) f();
  }

  private build(): void {
    const ctx = this.ctx!;
    // a gentle bus compressor and limiter keep big fights from clipping
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(limiter).connect(ctx.destination);

    this.reverbIn = ctx.createGain();
    this.hallIn = ctx.createGain();
    this.hallIn.connect(this.roomNode('hall').input);
    const room = this.roomNode(this.room);
    room.send.gain.value = 1;
    this.reverbIn.connect(room.send);
    room.live = true;

    for (const b of Object.keys(BUS_TRIM) as Bus[]) {
      const g = ctx.createGain();
      // the world (effects and ambience) can be muffled while the player is dead
      const muffled = b === 'sfx' || b === 'ambience';
      if (b === 'music') this.musicDuck = ctx.createGain();
      const post: AudioNode = muffled ? this.muffleFilter() : b === 'music' ? this.musicDuck : g;
      // weight: the world's sounds lean on their low end and soften their top, the music a little
      const eq = WEIGHT[b];
      if (eq && post !== g) {
        const w = this.weight(eq);
        g.connect(w.input);
        w.output.connect(post);
      } else if (post !== g) g.connect(post);
      post.connect(this.master);
      const send = ctx.createGain();
      send.gain.value = REVERB_SEND[b];
      // (the music isn't anywhere, so it keeps its own hall wherever the world is)
      const into = b === 'music' || b === 'ui' ? this.hallIn : this.reverbIn;
      post.connect(send).connect(into);
      this.buses[b] = g;
      const wet = ctx.createGain();
      if (muffled) wet.connect(this.muffleFilter()).connect(into);
      else wet.connect(into);
      this.wetIns[b] = wet;
    }
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = 0;
      l.positionY.value = 0;
      l.positionZ.value = 0;
    }
    this.applySettings();
    for (const [name, r] of this.raw) this.toBuffers(name, r.data);
    // keep audio going across tab switches
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.ctx?.state === 'suspended') void this.ctx.resume();
    });
  }

  private muffleFilter(): BiquadFilterNode {
    const f = this.ctx!.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 20000;
    f.Q.value = 0.9;
    this.muffles.push(f);
    return f;
  }

  /** Low shelf and sub bump up, high shelf down: the bus's tonal weight. */
  private weight(eq: { low: number; sub: number; high: number }): { input: AudioNode; output: AudioNode } {
    const ctx = this.ctx!;
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 220;
    low.gain.value = eq.low;
    const sub = ctx.createBiquadFilter();
    sub.type = 'peaking';
    sub.frequency.value = 85;
    sub.Q.value = 0.9;
    sub.gain.value = eq.sub;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 4500;
    high.gain.value = eq.high;
    low.connect(sub).connect(high);
    return { input: low, output: high };
  }

  /**
   * Muffle the world: 0 is clear, 1 is heard from far away (effects and
   * ambience lose their highs, the music drops back). Smoothed here, so it
   * can be called every frame.
   */
  setMuffle(amount: number): void {
    if (!this.ctx) return;
    const m = Math.min(1, Math.max(0, amount));
    if (Math.abs(m - this.muffle) < 0.001) return;
    this.muffle = m;
    const now = this.ctx.currentTime;
    // sweep on a log scale, from wide open down to about 550 Hz
    const hz = 20000 * Math.pow(550 / 20000, m);
    for (const f of this.muffles) f.frequency.setTargetAtTime(hz, now, 0.25);
    this.musicDuck.gain.setTargetAtTime(1 - 0.45 * m, now, 0.4);
  }

  /** Dip the music for a big moment (`depth` 0..1), then bring it back after `hold` seconds. */
  duckMusic(depth: number, hold: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const base = 1 - 0.45 * this.muffle;
    const g = this.musicDuck.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(base * (1 - depth), now, 0.04);
    g.setTargetAtTime(base, now + hold, 0.5);
  }

  // -------------------------------------------------------------------------
  // Settings

  setSettings(s: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...s };
    saveSettings(this.settings);
    this.applySettings();
    for (const f of this.settingsListeners) f(this.settings);
  }

  /** Whether the game is silenced while in the background (Settings > Audio). */
  private background = false;

  /** Silence (or bring back) everything while the game's tab or window is in the background. */
  setBackground(on: boolean): void {
    if (on === this.background) return;
    this.background = on;
    this.applySettings();
    for (const f of this.settingsListeners) f(this.settings);
  }

  /** No sound reaches the speakers: muted, the master at zero, or silenced in the background. */
  get silent(): boolean {
    return this.settings.muted || this.background || this.settings.master <= 0.01;
  }

  /** Called after every settings change (the herald's speech bypasses the mixer). */
  onSettings(fn: (s: AudioSettings) => void): void {
    this.settingsListeners.push(fn);
  }

  private applySettings(): void {
    if (!this.ctx) return;
    const s = this.settings;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.muted || this.background ? 0 : s.master, now, this.background ? 0.15 : 0.03);
    const vol: Record<Bus, number> = { music: s.music, sfx: s.sfx, ui: s.ui, voice: s.voice, ambience: s.ambience };
    for (const b of Object.keys(BUS_TRIM) as Bus[]) {
      const g = vol[b] * vol[b] * BUS_TRIM[b] * 1.4;
      this.buses[b].gain.setTargetAtTime(g, now, 0.03);
      this.wetIns[b].gain.setTargetAtTime(g, now, 0.03);
    }
  }

  /** The bus node, for modules that build their own graphs (music). */
  bus(b: Bus): GainNode | null {
    return this.ctx ? this.buses[b] : null;
  }

  // -------------------------------------------------------------------------
  // Sounds

  /** Store rendered sample data under a name. */
  register(name: string, data: Float32Array[], loop = false): void {
    const mix = this.layers.get(name);
    if (mix) {
      this.layers.delete(name);
      data = mix(data, loop);
    }
    this.raw.set(name, { data, loop });
    if (this.ctx) this.toBuffers(name, data);
  }

  /**
   * A recording to mix under a synthesized sound (layers.ts): applied once,
   * now if the sound is already rendered, otherwise as it arrives.
   */
  layer(name: string, mix: (data: Float32Array[], loop: boolean) => Float32Array[]): void {
    const raw = this.raw.get(name);
    if (!raw) {
      this.layers.set(name, mix);
      return;
    }
    const data = mix(raw.data, raw.loop);
    this.raw.set(name, { data, loop: raw.loop });
    if (this.ctx) this.toBuffers(name, data);
  }

  /**
   * Moves the world's sounds into another space (rooms.ts): their reverb
   * send crossfades over `fade` seconds, and what already rings in the old
   * room rings out there. Before audio is unlocked, it's the room it starts in.
   */
  setRoom(room: Room, fade = 2): void {
    if (room === this.room) return;
    const from = this.room;
    this.room = room;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const [name, to] of [[from, 0], [room, 1]] as const) {
      const n = this.roomNode(name);
      clearTimeout(n.timer);
      if (!n.live) {
        this.reverbIn.connect(n.send);
        n.live = true;
      }
      const g = n.send.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(to, now + Math.max(fade, 0.02));
    }
    // once the old room's send has closed and its tail rung out, it's cut off
    const old = this.roomNode(from);
    old.timer = window.setTimeout(() => {
      if (this.room === from || !old.live) return;
      this.reverbIn.disconnect(old.send);
      old.live = false;
    }, (fade + ROOMS[from].seconds + 0.5) * 1000);
  }

  /** Builds rooms ahead (a long impulse takes a moment to set up), as soon as audio is unlocked. */
  prepareRooms(rooms: readonly Room[]): void {
    this.onUnlock(() => {
      for (const r of rooms) this.roomNode(r);
    });
  }

  /** A room's reverb, built the first time it's needed: its send, the convolver and its level out to the master. */
  private roomNode(room: Room): RoomNode {
    let n = this.rooms.get(room);
    if (n) return n;
    const ctx = this.ctx!;
    const [l, r] = roomImpulse(ROOMS[room], ctx.sampleRate);
    const buffer = ctx.createBuffer(2, l.length, ctx.sampleRate);
    buffer.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
    const conv = ctx.createConvolver();
    conv.buffer = buffer;
    const input = ctx.createGain();
    const send = ctx.createGain();
    send.gain.value = 0;
    send.connect(input);
    const out = ctx.createGain();
    out.gain.value = 0.9 * roomGain(room);
    input.connect(conv).connect(out).connect(this.master);
    n = { input, send, live: false, timer: 0 };
    this.rooms.set(room, n);
    return n;
  }

  has(name: string): boolean {
    return this.raw.has(name) || this.buffers.has(name);
  }

  /**
   * Recorded clips (the gods' spoken lines) under a name, one variant per
   * file, fetched and decoded once audio is unlocked. Resolves false when
   * any of them fails, and the name stays silent.
   */
  loadClips(name: string, urls: readonly string[]): Promise<boolean> {
    let p = this.clipLoads.get(name);
    if (!p) {
      p = new Promise<void>((r) => this.onUnlock(r))
        .then(() =>
          Promise.all(
            urls.map(async (url) => {
              const res = await fetch(url);
              if (!res.ok) throw new Error(`${url}: ${res.status}`);
              return this.ctx!.decodeAudioData(await res.arrayBuffer());
            }),
          ),
        )
        .then((list) => {
          this.buffers.set(name, list);
          return true;
        })
        .catch(() => false);
      this.clipLoads.set(name, p);
    }
    return p;
  }

  private toBuffers(name: string, data: Float32Array[]): void {
    const ctx = this.ctx!;
    this.buffers.set(
      name,
      data.map((d) => {
        const b = ctx.createBuffer(1, d.length, RATE);
        b.copyToChannel(d as Float32Array<ArrayBuffer>, 0);
        return b;
      }),
    );
  }

  buffer(name: string, variant?: number): AudioBuffer | null {
    const list = this.buffers.get(name);
    if (!list || !list.length) return null;
    return list[variant !== undefined ? variant % list.length : Math.floor(Math.random() * list.length)]!;
  }

  /** Whether a positional sound here would be audible at all. */
  audible(x: number, z: number, range = CULL): boolean {
    return hypot(x - this.listenerPos.x, z - this.listenerPos.z) < range;
  }

  /**
   * Play a one-shot. `minGap` drops repeats of the same name closer together
   * than that many seconds (crowds of minions hitting at once).
   */
  play(name: string, o: PlayOptions = {}, priority = 1, minGap = 0): AudioBufferSourceNode | null {
    if (!this.ready || this.settings.muted) return null;
    const ctx = this.ctx!;
    if (o.at && !this.audible(o.at.x, o.at.z, CULL * (o.ref ?? 6) / 6)) return null;
    const now = ctx.currentTime;
    if (minGap > 0) {
      const last = this.lastPlayed.get(name) ?? -1;
      if (now - last < minGap) return null;
    }
    const buffer = this.buffer(name, o.variant);
    if (!buffer) return null;
    if (!this.makeRoom(priority)) return null;
    this.lastPlayed.set(name, now);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const rate = (o.rate ?? 1) * (o.vary ? 1 + (Math.random() * 2 - 1) * o.vary : 1);
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    src.connect(g);
    this.route(g, o);
    const when = now + (o.delay ?? 0);
    src.start(when);
    const v: Voice = { src, started: when, priority, name };
    this.voices.push(v);
    src.onended = () => {
      const i = this.voices.indexOf(v);
      if (i >= 0) this.voices.splice(i, 1);
      g.disconnect();
    };
    return src;
  }

  /** Start a loop that can follow something around. */
  loop(name: string, o: PlayOptions = {}): LoopHandle | null {
    if (!this.ready) return null;
    const ctx = this.ctx!;
    const buffer = this.buffer(name, o.variant ?? 0);
    if (!buffer) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = o.rate ?? 1;
    const g = ctx.createGain();
    const target = o.gain ?? 1;
    g.gain.value = 0;
    g.gain.setTargetAtTime(target, ctx.currentTime, 0.05);
    src.connect(g);
    const { panner, air, send } = this.route(g, o);
    src.start(ctx.currentTime, o.offset !== undefined ? o.offset % buffer.duration : Math.random() * buffer.duration);
    let alive = true;
    // the air between loop and listener changes as either one moves
    const spot: AirSpot | null = air && send && o.at ? { air, send, base: o.wet ?? 0, x: o.at.x, z: o.at.z } : null;
    if (spot) this.airLoops.add(spot);
    return {
      get alive() {
        return alive;
      },
      setPosition: (x, y, z) => {
        if (!panner || !alive) return;
        setPannerPos(panner, x, y, z, ctx.currentTime);
        if (spot) {
          spot.x = x;
          spot.z = z;
          this.applyAir(spot, ctx.currentTime, 0.1);
        }
      },
      setGain: (v, ramp = 0.08) => {
        if (alive) g.gain.setTargetAtTime(v, ctx.currentTime, ramp);
      },
      setRate: (r) => {
        if (alive) src.playbackRate.setTargetAtTime(r, ctx.currentTime, 0.05);
      },
      stop: (fade = 0.15) => {
        if (!alive) return;
        alive = false;
        if (spot) this.airLoops.delete(spot);
        const t = ctx.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + fade);
        src.stop(t + fade + 0.05);
        src.onended = () => g.disconnect();
      },
    };
  }

  /**
   * Connect a voice's gain to its bus, through a panner when positioned.
   * Positioned sounds also pass through "air": a low-pass that closes with
   * distance, and a reverb send that grows with it, so far fights sound far
   * away rather than just quiet.
   */
  private route(g: GainNode, o: PlayOptions): { panner: PannerNode | null; air: BiquadFilterNode | null; send: GainNode | null } {
    const ctx = this.ctx!;
    const bus = this.buses[o.bus ?? 'sfx'];
    let node: AudioNode = g;
    let panner: PannerNode | null = null;
    let air: BiquadFilterNode | null = null;
    let wet = o.wet ?? 0;
    if (o.at) {
      const d = this.distTo(o.at.x, o.at.z);
      air = ctx.createBiquadFilter();
      air.type = 'lowpass';
      air.Q.value = 0.5;
      air.frequency.value = airCutoff(d);
      node.connect(air);
      node = air;
      wet += distantWet(d);
      panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = o.ref ?? 6;
      panner.maxDistance = 400;
      panner.rolloffFactor = 1.1;
      setPannerPos(panner, o.at.x, o.at.y ?? 1.5, o.at.z, ctx.currentTime, true);
      node.connect(panner);
      node = panner;
    } else if (o.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = o.pan;
      node.connect(p);
      node = p;
    }
    node.connect(bus);
    let send: GainNode | null = null;
    // positioned sounds always get a send, since their distance (and so their reverb) can change
    if (wet > 0 || o.at) {
      send = ctx.createGain();
      send.gain.value = wet;
      node.connect(send).connect(this.wetIns[o.bus ?? 'sfx']);
    }
    return { panner, air, send };
  }

  /** Re-fit a loop's air filter and reverb send to its current distance. */
  private applyAir(a: AirSpot, t: number, ramp: number): void {
    const d = this.distTo(a.x, a.z);
    a.air.frequency.setTargetAtTime(airCutoff(d), t, ramp);
    a.send.gain.setTargetAtTime(a.base + distantWet(d), t, ramp);
  }

  private distTo(x: number, z: number): number {
    return hypot(x - this.listenerPos.x, z - this.listenerPos.z);
  }

  /** How many one-shots are sounding right now (for thinning crowds). */
  get busy(): number {
    return this.voices.length;
  }

  /** Steal the oldest, least important voice when the pool is full. */
  private makeRoom(priority: number): boolean {
    if (this.voices.length < MAX_VOICES) return true;
    let worst = -1;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i]!;
      if (v.priority > priority) continue;
      if (worst < 0 || v.priority < this.voices[worst]!.priority || (v.priority === this.voices[worst]!.priority && v.started < this.voices[worst]!.started)) worst = i;
    }
    if (worst < 0) return false;
    const v = this.voices.splice(worst, 1)[0]!;
    try {
      v.src.stop();
    } catch {
      /* already stopped */
    }
    return true;
  }

  /** Place the ears: at `pos`, facing `forward` (horizontal), up is +Y. */
  setListener(x: number, y: number, z: number, fx: number, fz: number): void {
    this.listenerPos.x = x;
    this.listenerPos.y = y;
    this.listenerPos.z = z;
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    // stationary loops (fountains, braziers) re-filter as the listener walks around them
    if (hypot(x - this.airFrom.x, z - this.airFrom.z) > 1) {
      this.airFrom.x = x;
      this.airFrom.z = z;
      for (const a of this.airLoops) this.applyAir(a, t, 0.2);
    }
    const len = hypot(fx, fz) || 1;
    if (l.positionX) {
      l.positionX.setTargetAtTime(x, t, 0.02);
      l.positionY.setTargetAtTime(y, t, 0.02);
      l.positionZ.setTargetAtTime(z, t, 0.02);
      l.forwardX.setTargetAtTime(fx / len, t, 0.02);
      l.forwardY.setTargetAtTime(0, t, 0.02);
      l.forwardZ.setTargetAtTime(fz / len, t, 0.02);
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(x, y, z);
      l.setOrientation(fx / len, 0, fz / len, 0, 1, 0);
    }
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }
}

interface AirSpot {
  air: BiquadFilterNode;
  send: GainNode;
  /** The loop's own reverb amount, before distance adds to it. */
  base: number;
  x: number;
  z: number;
}

/** Far sounds are mostly room: extra reverb that grows with distance. */
function distantWet(d: number): number {
  return Math.min(0.22, d / 250);
}

/** Air absorbs highs over distance: wide open up close, about 2.5 kHz at the edge of hearing. */
function airCutoff(d: number): number {
  return Math.max(2500, 20000 * Math.exp(-d / 40));
}

function setPannerPos(p: PannerNode, x: number, y: number, z: number, t: number, snap = false): void {
  if (p.positionX) {
    if (snap) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else {
      p.positionX.setTargetAtTime(x, t, 0.03);
      p.positionY.setTargetAtTime(y, t, 0.03);
      p.positionZ.setTargetAtTime(z, t, 0.03);
    }
  } else p.setPosition(x, y, z);
}

function loadSettings(): AudioSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<AudioSettings>;
    // interface sounds followed the effects slider before they had their own
    return { ...AUDIO_DEFAULTS, ui: saved.sfx ?? AUDIO_DEFAULTS.ui, ...saved };
  } catch {
    return { ...AUDIO_DEFAULTS };
  }
}

function saveSettings(s: AudioSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
