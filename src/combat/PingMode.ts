import * as THREE from 'three/webgpu';
import type { Input } from '../core/Input';
import { hypot } from '../core/math';
import type { Team } from '../game/combatant';
import { contextKind, pingText, PINGS, PingLimiter, sectorOf, ultState, WHEEL, type PingDef, type PingKind } from '../sim/Pings';
import type { Sim } from '../sim/Sim';
import { isStructure, type Point, type SimEvent, type Unit } from '../sim/Unit';
import { PingHud, type PingMark } from '../ui/PingHud';
import { GroundDecal } from './GroundDecal';
import type { GodPalette } from './palette';

export type PingSound = PingDef['sound'] | 'wheel' | 'tick';

export interface PingDeps {
  sim: Sim;
  input: Input;
  camera: THREE.Camera;
  groundAt: (x: number, z: number) => number;
  /** The group the ground marks are added to. */
  parent: THREE.Object3D;
  /** The unit the local player controls. */
  player: () => Unit;
  headOf: (u: Unit, out: THREE.Vector3) => THREE.Vector3 | null;
  /** The ground under the crosshair and the unit on it, if any. */
  aim: () => { point: Point; unit: Unit | null };
  /** Send a ping: true when it went out, false when refused, null when the host decides (online guest). */
  send: (kind: PingKind, x: number, z: number, subject: Unit | null) => boolean | null;
  /** Online guest: its own pings show at once, and the host's echo of them is skipped. */
  guest: () => boolean;
  /** Whether input belongs to the fight right now (no menu open, match not over). */
  enabled: () => boolean;
  pillar: (p: GodPalette, x: number, z: number, size: number, width: number) => void;
  deny: (text: string) => void;
}

/** Hold the key this long (or move the mouse this far) and the wheel opens; a quicker tap pings what's under the crosshair. */
const WHEEL_AFTER = 0.16;
const TAP = 0.25;
/** Pixels of mouse travel before a wedge is picked, and the farthest the pointer goes. */
const PICK_AT = 26;
const REACH = 140;
/** Markers up at once; the oldest goes first. */
const MAX_MARKS = 8;
const DECALS = 4;
/** Where markers out of view are pinned: how far out from the middle (screen halves) sideways, up and down. */
const EDGE_X = 0.92;
const EDGE_TOP = 0.8;
const EDGE_BOTTOM = 0.55;
/** Seconds the ground mark's shockwave takes to sweep out. */
const SHOCK = 0.45;

interface Live {
  id: number;
  from: Unit;
  kind: PingKind;
  x: number;
  z: number;
  subject: Unit | null;
  who: string;
  text: string;
  age: number;
  life: number;
  mine: boolean;
  decal: GroundDecal | null;
  placed: { x: number; z: number; r: number } | null;
  /** Teammates who answered "on my way" to this call. */
  coming: string[];
}

/**
 * Pings for the local player: hold G for the call wheel (the mouse picks a
 * wedge, release sends it, right click or Esc cancels), or tap G or click the
 * middle mouse button to ping what is under the crosshair. Teammates' pings
 * show as markers over the spot, pinned to the screen's edge when out of view,
 * with a ground mark, a beam of light, a sound and a line in the call feed.
 */
export class PingMode {
  readonly hud = new PingHud();
  private hold: { t: number; point: Point; unit: Unit | null } | null = null;
  private readonly live: Live[] = [];
  private readonly decals: GroundDecal[] = [];
  private readonly free: GroundDecal[] = [];
  /** A guest's copy of the host's allowance, so a refused ping isn't shown. */
  private readonly limiter = new PingLimiter();
  private nextId = 1;
  private readonly v = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  /** A ping went up (its sound, and whether it was this player's), or the wheel opened or lit a wedge. */
  onSound: ((sound: PingSound, mine: boolean) => void) | null = null;
  private lastPick = -1;
  /** The minimap's marks (Conquest), refreshed each frame. */
  readonly mapMarks: { x: number; z: number; color: number; age: number }[] = [];

  constructor(private readonly deps: PingDeps) {
    for (let i = 0; i < DECALS; i++) {
      const d = new GroundDecal(deps.groundAt);
      d.mesh.visible = false;
      deps.parent.add(d.mesh);
      this.decals.push(d);
      this.free.push(d);
    }
  }

  /** Whether the wheel is up (the basic attack and camera wait while it is). */
  get busy(): boolean {
    return this.hold !== null;
  }

  /** Show the ground marks through a loading frame so their shader is ready (they share the skill decals' material). */
  prime(): () => void {
    for (const d of this.decals) {
      d.setStyle('flash');
      d.place({ type: 'circle', radius: 1.8 }, this.deps.player().x, this.deps.player().z, 0);
      d.mesh.visible = true;
    }
    return () => {
      for (const d of this.decals) if (this.free.includes(d)) d.mesh.visible = false;
    };
  }

  /** Allied gods to talk to: no wheel in a duel or alone on the training ground. */
  private hasTeam(me: Unit): boolean {
    return this.deps.sim.units.some((u) => u !== me && u.kind === 'god' && u.team === me.team);
  }

  /** Each frame before the fight's own input: the ping key, the middle button and the wheel. */
  controls(dt: number): void {
    const { input } = this.deps;
    const me = this.deps.player();
    if (!this.deps.enabled() || !this.hasTeam(me)) {
      this.cancel();
      return;
    }
    if (!this.hold && input.wasPressed('KeyG')) this.press();
    else if (!this.hold && input.wasPressed('Mouse1')) {
      const aim = this.deps.aim();
      this.ping(contextKind(aim.unit, me.team), aim.point, aim.unit);
    }
    if (this.hold) this.steer(dt);
  }

  /** Each frame once the units are placed: age the markers and draw them. */
  frame(dt: number): void {
    this.age(dt);
  }

  private press(): void {
    const aim = this.deps.aim();
    this.hold = { t: 0, point: { ...aim.point }, unit: aim.unit };
    this.deps.input.capture = { x: 0, y: 0 };
  }

  private steer(dt: number): void {
    const { input } = this.deps;
    const h = this.hold!;
    h.t += dt;
    const c = input.capture ?? { x: 0, y: 0 };
    const len = hypot(c.x, c.y);
    if (len > REACH) {
      c.x *= REACH / len;
      c.y *= REACH / len;
    }
    const pick = len > PICK_AT ? sectorOf(c.x, c.y) : -1;
    if (!this.hud.wheelOpen && (h.t > WHEEL_AFTER || len > PICK_AT)) {
      this.hud.openWheel(this.context(h.unit));
      this.onSound?.('wheel', true);
      this.lastPick = -1;
    }
    if (pick !== this.lastPick && this.hud.wheelOpen) {
      if (pick >= 0) this.onSound?.('tick', true);
      this.lastPick = pick;
    }
    const k = Math.min(1, len / REACH) * 38;
    this.hud.select(pick, len > 0 ? (c.x / len) * k : 0, len > 0 ? (c.y / len) * k : 0);
    if (input.wasPressed('Mouse2') || input.wasPressed('Escape')) {
      this.cancel();
      return;
    }
    const clicked = input.wasPressed('Mouse0');
    if (!clicked && input.isDown('KeyG')) return;
    const quick = !clicked && pick < 0 && h.t < TAP;
    this.cancel();
    if (pick >= 0) this.ping(WHEEL[pick]!, h.point, h.unit);
    else if (quick) this.ping(contextKind(h.unit, this.deps.player().team), h.point, h.unit);
  }

  private cancel(): void {
    if (!this.hold) return;
    this.hold = null;
    this.deps.input.capture = null;
    this.hud.closeWheel();
  }

  /** What the wheel's calls would be about, for the line under the call's name. */
  private context(u: Unit | null): string {
    if (!u || !u.alive) return 'at the crosshair';
    const me = this.deps.player();
    return u.kind === 'god' ? `on ${u.name}` : isStructure(u) ? `on ${u.team === me.team ? 'our' : 'their'} ${u.kind === 'tower' ? 'tower' : u.name}` : `on the ${u.name}`;
  }

  /** The unit a call is about, if the one under the crosshair fits it. */
  private subjectFor(kind: PingKind, u: Unit | null, team: Team): Unit | null {
    if (!u || !u.alive) return null;
    switch (kind) {
      case 'ult':
      case 'thanks':
      case 'back':
      case 'missing':
        return null;
      case 'help':
        return u.kind === 'god' && u.team === team ? u : null;
      case 'attack':
        return u.team !== team || isStructure(u) ? u : null;
      default:
        return u;
    }
  }

  private ping(kind: PingKind, at: Point, unit: Unit | null): void {
    const me = this.deps.player();
    const subject = this.subjectFor(kind, unit, me.team);
    if (this.deps.guest()) {
      if (!this.limiter.take(me, this.deps.sim.time)) {
        this.deps.deny('Slow down: too many pings');
        return;
      }
      this.deps.send(kind, at.x, at.z, subject);
      // the host's check is the same, so show it now instead of a beat later
      const self = PINGS[kind].at === 'self' && !subject;
      const p = subject ?? (self ? me : at);
      this.show(me, kind, p.x, p.z, subject, kind === 'ult' ? ultState(me.combatant) : undefined);
      return;
    }
    // alone or hosting: the simulation's event comes straight back through onEvent
    if (this.deps.send(kind, at.x, at.z, subject) === false) this.deps.deny('Slow down: too many pings');
  }

  onEvent(e: SimEvent): void {
    if (e.type !== 'ping') return;
    const me = this.deps.player();
    if (e.unit.team !== me.team) return;
    if (e.unit === me && this.deps.guest()) return;
    this.show(e.unit, e.kind, e.x, e.z, e.subject, e.ult);
  }

  private show(from: Unit, kind: PingKind, x: number, z: number, subject: Unit | null, ult?: number): void {
    const me = this.deps.player();
    const mine = from === me;
    // a pinger's new call of the same kind replaces their last one
    const same = this.live.findIndex((l) => l.from === from && l.kind === kind);
    if (same >= 0) this.drop(same);
    while (this.live.length >= MAX_MARKS) this.drop(0);
    const def = PINGS[kind];
    const who = mine ? 'You' : from.name;
    const text = pingText(kind, subject, me.team, ult);
    // "on my way" to a call that is still up joins that call's marker instead of stacking another on it
    if (kind === 'omw') {
      const call = this.live.find((l) => l.kind !== 'omw' && l.from !== from && ((subject && l.subject === subject) || hypot(l.x - x, l.z - z) < 5));
      if (call) {
        if (!call.coming.includes(who)) call.coming.push(who);
        call.life = Math.max(call.life, call.age + 3);
        this.hud.pushFeed(kind, who, text, mine);
        this.onSound?.(def.sound, mine);
        return;
      }
    }
    const decal = this.free.pop() ?? null;
    if (decal) {
      decal.setColors(def.color, 0xffffff);
      decal.setStyle('flash');
      decal.values.wave = 0;
      decal.values.opacity = 1;
      decal.mesh.visible = true;
    }
    this.live.push({ id: this.nextId++, from, kind, x, z, subject, who, text, age: 0, life: def.life, mine, decal, placed: null, coming: [] });
    const self = def.at === 'self' && !subject;
    if (!self) this.deps.pillar(beam(def.color), x, z, 0.34, 0.22);
    this.hud.pushFeed(kind, who, text, mine);
    this.onSound?.(def.sound, mine);
  }

  private drop(i: number): void {
    const [l] = this.live.splice(i, 1);
    if (l?.decal) {
      l.decal.mesh.visible = false;
      this.free.push(l.decal);
    }
  }

  /** Age every marker, keep its ground mark on what it follows, and place it on screen. */
  private age(dt: number): void {
    const me = this.deps.player();
    const cam = this.deps.camera;
    cam.getWorldDirection(this.fwd);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const marks: PingMark[] = [];
    this.mapMarks.length = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const l = this.live[i]!;
      l.age += dt;
      // a ping on a unit ends early when the unit falls
      if (l.age >= l.life || (l.subject && !l.subject.alive)) {
        this.drop(i);
        continue;
      }
      const self = PINGS[l.kind].at === 'self' && !l.subject;
      const on = l.subject ?? (self ? l.from : null);
      if (on) {
        l.x = on.x;
        l.z = on.z;
      }
      if (l.decal) this.ground(l, on);
      // the marker floats over a unit's head, or a little above the marked ground
      const head = on ? this.deps.headOf(on, this.v) : null;
      if (head) head.y += 1.1;
      else this.v.set(l.x, this.deps.groundAt(l.x, l.z) + 1.6, l.z);
      const p = this.toScreen(this.v, w, h);
      // your own call about yourself needs no marker over your head: the feed says it
      if (!(self && l.mine)) marks.push({ id: l.id, kind: l.kind, x: p.x, y: p.y, edge: p.edge, angle: p.angle, who: l.who, text: l.text, coming: comingLine(l.coming), dist: hypot(l.x - me.x, l.z - me.z), age: l.age, life: l.life, mine: l.mine });
      this.mapMarks.push({ x: l.x, z: l.z, color: PINGS[l.kind].color, age: l.age });
    }
    // two calls on nearly the same spot stack instead of printing over each other
    for (let i = 1; i < marks.length; i++) {
      const m = marks[i]!;
      for (let j = 0; j < i; j++) {
        const o = marks[j]!;
        if (Math.abs(o.x - m.x) < 60 && Math.abs(o.y - m.y) < 40) m.y = o.y - 44;
      }
    }
    this.hud.setMarks(marks);
  }

  /** The ground mark: a shockwave sweeping out when the ping lands, then a pulsing marked circle fading out. */
  private ground(l: Live, on: Unit | null): void {
    const d = l.decal!;
    const r = on ? on.radius + 1 : 1.8;
    if (!l.placed || hypot(l.placed.x - l.x, l.placed.z - l.z) > 0.05 || l.placed.r !== r) {
      d.place({ type: 'circle', radius: r }, l.x, l.z, 0, 0.09);
      l.placed = { x: l.x, z: l.z, r };
    }
    if (l.age < SHOCK) d.values.wave = l.age / SHOCK;
    else if (d.values.style !== 0) d.setStyle('telegraph');
    d.values.opacity = Math.min(1, (l.life - l.age) / 0.8) * (l.age < SHOCK ? 1 : 0.85);
  }

  /**
   * Screen pixels for a world point, pinned to the screen's edge (with the way
   * to it) when out of view: above or below the view along its line, and to
   * the left or right side when it is behind the camera.
   */
  private toScreen(at: THREE.Vector3, w: number, h: number): { x: number; y: number; edge: boolean; angle: number } {
    const cam = this.deps.camera;
    const behind = this.fwd.dot(this.v2.copy(at).sub(cam.position)) < 0;
    const p = this.v2.copy(at).project(cam);
    let ex: number;
    let ey: number;
    if (behind) {
      // the projection mirrors through the camera: flip it back to find the side
      ex = -p.x >= 0 ? EDGE_X : -EDGE_X;
      ey = Math.max(-0.35, Math.min(0.35, -p.y * 0.5));
    } else {
      if (Math.abs(p.x) < 0.92 && p.y < 0.86 && p.y > -0.9) return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, edge: false, angle: 0 };
      // shrink toward the middle until it sits inside the edge box (lower edge kept clear of the skill bar)
      const k = Math.min(Math.abs(p.x) > EDGE_X ? EDGE_X / Math.abs(p.x) : 1, p.y > EDGE_TOP ? EDGE_TOP / p.y : p.y < -EDGE_BOTTOM ? EDGE_BOTTOM / -p.y : 1);
      ex = p.x * k;
      ey = p.y * k;
    }
    const x = ((ex + 1) / 2) * w;
    const y = ((1 - ey) / 2) * h;
    return { x, y, edge: true, angle: Math.atan2(y - h / 2, x - w / 2) };
  }

  private readonly v2 = new THREE.Vector3();

  dispose(): void {
    this.cancel();
    this.hud.dispose();
    for (const d of this.decals) {
      d.mesh.removeFromParent();
      d.dispose();
    }
  }
}

/** "Thor on the way", "Thor and Odin on the way", "Thor, Odin and Loki on the way". */
function comingLine(names: readonly string[]): string {
  if (!names.length) return '';
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
  return `${list} on the way`;
}

const beams = new Map<number, GodPalette>();
/** A palette for a ping's beam of light: its color, with a white-hot core. */
function beam(color: number): GodPalette {
  let p = beams.get(color);
  if (!p) beams.set(color, (p = { cloth: color, trim: color, glow: color, vfx: color, core: 0xffffff }));
  return p;
}
