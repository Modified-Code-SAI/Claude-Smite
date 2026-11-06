import * as THREE from 'three/webgpu';
import { toScreen, type ScreenSpot } from '../combat/screenEdge';
import { hypot } from '../core/math';
import { JOTUNN, type Jotunn, type JotunnPhase, SHRINES } from '../sim/Jotunn';
import type { Point, SimEvent } from '../sim/Unit';
import { radarSize } from './JotunnRadar';

/**
 * Jötunn's objective marks: small markers over what the round is about, and
 * pinned to the screen's edge with an arrow when it is out of view. The giant
 * sees every lit brazier (the nearest to smash) and every shrine it may
 * claim, which are small and far from its high camera. A god sees the giant
 * when it is out of view, and the brazier it is clubbing or closing on.
 */
export type MarkKind = 'smash' | 'shrine' | 'defend' | 'giant';

export interface MarkWant {
  key: string;
  kind: MarkKind;
  x: number;
  y: number;
  z: number;
  label: string;
  /** Shown only while out of view (the giant is too big to miss on screen). */
  edgeOnly?: boolean;
}

export interface MarkScene {
  piloting: boolean;
  phase: JotunnPhase;
  /** A camera shot of the giant is playing. */
  cine: boolean;
  giant: { x: number; y: number; z: number; alive: boolean };
  /** y: where the mark floats. hitAgo: seconds since the giant last struck it. */
  braziers: readonly { x: number; y: number; z: number; alive: boolean; hitAgo: number }[];
  /** ready: claimable now (not resting after a claim). */
  shrines: readonly { x: number; y: number; z: number; ready: boolean; contested: boolean; ult: string }[];
}

/** A god is called to a brazier the giant is this close to (meters, center to center), or struck this recently (seconds). */
export const THREAT_RANGE = 12;
export const THREAT_HIT = 4;

const ULT_NAMES: Record<string, string> = { rime: 'Frost Breath', avalanche: 'Avalanche', hail: 'Hailstorm' };

/** The marks to show now. */
export function pickMarks(s: MarkScene): MarkWant[] {
  const out: MarkWant[] = [];
  if (s.cine || !s.giant.alive) return out;
  if (s.phase !== 'fight' && !(s.piloting && s.phase === 'countdown')) return out;
  const g = s.giant;
  if (s.piloting) {
    let near = -1;
    let best = Infinity;
    s.braziers.forEach((b, i) => {
      const d = hypot(b.x - g.x, b.z - g.z);
      if (b.alive && d < best) {
        best = d;
        near = i;
      }
    });
    s.braziers.forEach((b, i) => {
      if (b.alive) out.push({ key: `b${i}`, kind: 'smash', x: b.x, y: b.y, z: b.z, label: i === near ? 'Smash' : '' });
    });
    s.shrines.forEach((sh, i) => {
      if (sh.ready) out.push({ key: `s${i}`, kind: 'shrine', x: sh.x, y: sh.y, z: sh.z, label: sh.contested ? 'Held' : sh.ult });
    });
    return out;
  }
  out.push({ key: 'g', kind: 'giant', x: g.x, y: g.y, z: g.z, label: '', edgeOnly: true });
  let near = -1;
  let best = THREAT_RANGE;
  s.braziers.forEach((b, i) => {
    const d = hypot(b.x - g.x, b.z - g.z);
    if (b.alive && d < best) {
      best = d;
      near = i;
    }
  });
  s.braziers.forEach((b, i) => {
    if (b.alive && (i === near || b.hitAgo < THREAT_HIT)) out.push({ key: `b${i}`, kind: 'defend', x: b.x, y: b.y, z: b.z, label: 'Defend' });
  });
  return out;
}

const ICONS: Record<MarkKind, string> = {
  // a flame
  smash: '<path d="M12 2.5c.6 3.6 5.2 5.7 5.2 10.9a5.2 5.2 0 0 1-10.4 0c0-2.8 1.6-4.2 2.3-6.6 1.3 1.1 1.9 2.4 2 3.9 1.3-2.4 1.5-5.2.9-8.2z"/>',
  defend: '<path d="M12 2.5c.6 3.6 5.2 5.7 5.2 10.9a5.2 5.2 0 0 1-10.4 0c0-2.8 1.6-4.2 2.3-6.6 1.3 1.1 1.9 2.4 2 3.9 1.3-2.4 1.5-5.2.9-8.2z"/>',
  // a six-armed snowflake
  shrine: '<g fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.6 4.6 12 6.6l2.4-2M9.6 19.4l2.4-2 2.4 2M4.6 10.6l2.9-.9-.6-3M19.4 13.4l-2.9.9.6 3M4.6 13.4l2.9.9-.6 3M19.4 10.6l-2.9-.9.6-3"/></g>',
  // a horned head
  giant: '<path d="M3 3.5c.4 3.7 2.2 5.9 4.6 6.9V14c0 3.6 2 6.2 4.4 7.5 2.4-1.3 4.4-3.9 4.4-7.5v-3.6c2.4-1 4.2-3.2 4.6-6.9-2 1.9-4 2.8-6.1 2.8H9.1C7 6.3 5 5.4 3 3.5zm6.3 9.1 2 .9-2 .9zm5.4 0v1.8l-2-.9z"/>',
};

interface Shown {
  el: HTMLElement;
  label: HTMLElement;
  dist: HTMLElement;
  kind: MarkKind | '';
  text: string;
  meters: number;
  on: boolean;
  edge: boolean;
  near: boolean;
  x: number;
  y: number;
  turn: number;
}

/** Marks near the middle of the screen (the aim) fade back, so they never sit over what you're hitting. Pixels. */
const CLEAR_MIDDLE = 80;
/**
 * The top HUD (jotunn.css: the Might bar block, min(60vw, 520px) wide, and
 * the state line under it, about 100 px down): a mark in view under it
 * fades back, and an edge mark pins just below it. Pixels.
 */
export const TOP_CLEAR = 118;
/** The round's wins under the radar (jotunn.css .jt-wins: five rows at most). Pixels. */
export const WINS_CLEAR = 110;

/**
 * Keeps a mark clear of the HUD on a w x h screen: an edge mark under the top
 * HUD moves below it, and one in the radar's corner slides out along its edge;
 * returns whether a mark in view should fade back (under the top HUD or the
 * radar, or over the aim).
 */
export function clearOfHud(p: ScreenSpot, w: number, h: number): boolean {
  const underTop = p.y < TOP_CLEAR && Math.abs(p.x - w / 2) < Math.min(0.3 * w, 260) + 24;
  // the radar's corner, top right (12 px in, a little room round it), and the round's wins under it
  const corner = radarSize(w) + 22;
  const below = corner + WINS_CLEAR;
  const underRadar = p.x > w - corner && p.y < below;
  if (p.edge) {
    if (underTop) p.y = TOP_CLEAR;
    // an edge mark slides out of the corner along its own edge
    else if (underRadar) {
      if (w - p.x < p.y) p.y = below;
      else p.x = w - corner;
    }
    return false;
  }
  return underTop || underRadar || (Math.abs(p.x - w / 2) < CLEAR_MIDDLE && Math.abs(p.y - h / 2) < CLEAR_MIDDLE);
}

export class JotunnMarks {
  private readonly root = document.createElement('div');
  private readonly shown = new Map<string, Shown>();
  private readonly hitAt: number[];
  private readonly spot: ScreenSpot = { x: 0, y: 0, edge: false, angle: 0 };
  private readonly v = new THREE.Vector3();
  private readonly brazierY: number[];
  private readonly shrineY: number[];
  private t = 0;

  constructor(
    private readonly mode: Jotunn,
    private readonly camera: THREE.Camera,
    groundAt: (x: number, z: number) => number,
  ) {
    this.root.className = 'jm-layer';
    document.body.appendChild(this.root);
    this.hitAt = JOTUNN.braziers.map(() => -99);
    // a brazier stands 2.4 m; a shrine's obelisk about 7
    this.brazierY = JOTUNN.braziers.map((b) => groundAt(b.x, b.z) + 3.3);
    this.shrineY = SHRINES.map((s) => groundAt(s.x, s.z) + 8.2);
  }

  onEvent(e: SimEvent): void {
    if (e.type !== 'damage' || e.target.kind !== 'brazier') return;
    const i = this.mode.braziers.indexOf(e.target);
    if (i >= 0) this.hitAt[i] = this.t;
  }

  /** `me` is the unit the player drives (the giant when piloting): distances are from it. */
  frame(dt: number, piloting: boolean, cine: boolean, me: Point): void {
    this.t += dt;
    const m = this.mode;
    const g = m.giant;
    const want = pickMarks({
      piloting,
      phase: m.phase,
      cine,
      giant: { x: g.x, y: g.body.y + 9, z: g.z, alive: g.alive },
      braziers: m.braziers.map((b, i) => ({ x: b.x, y: this.brazierY[i]!, z: b.z, alive: b.alive, hitAgo: this.t - this.hitAt[i]! })),
      shrines: m.shrines.map((s, i) => ({ x: s.def.x, y: this.shrineY[i]!, z: s.def.z, ready: s.dormant <= 0, contested: s.contested, ult: ULT_NAMES[s.def.id] ?? '' })),
    });
    const w = window.innerWidth;
    const h = window.innerHeight;
    const live = new Set<string>();
    for (const k of want) {
      const p = toScreen(this.v.set(k.x, k.y, k.z), this.camera, w, h, this.spot);
      if (k.edgeOnly && !p.edge) continue;
      live.add(k.key);
      const s = this.mark(k.key);
      if (s.kind !== k.kind) {
        s.kind = k.kind;
        s.el.className = `jm jm-${k.kind}`;
        s.el.querySelector('svg')!.innerHTML = ICONS[k.kind];
        s.on = true;
        s.edge = false;
        s.near = false;
      }
      if (!s.on) {
        s.on = true;
        s.el.classList.remove('hide');
      }
      if (s.text !== k.label) {
        s.text = k.label;
        s.label.textContent = k.label;
      }
      const meters = Math.round(hypot(k.x - me.x, k.z - me.z));
      if (meters !== s.meters) {
        s.meters = meters;
        s.dist.textContent = `${meters} m`;
      }
      if (p.edge !== s.edge) {
        s.edge = p.edge;
        s.el.classList.toggle('edge', p.edge);
      }
      const near = clearOfHud(p, w, h);
      if (near !== s.near) {
        s.near = near;
        s.el.classList.toggle('near', near);
      }
      if (Math.abs(p.x - s.x) > 0.4 || Math.abs(p.y - s.y) > 0.4) {
        s.x = p.x;
        s.y = p.y;
        s.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
      }
      if (p.edge && Math.abs(p.angle - s.turn) > 0.01) {
        s.turn = p.angle;
        s.el.style.setProperty('--turn', `${p.angle.toFixed(3)}rad`);
      }
    }
    for (const [key, s] of this.shown) {
      if (s.on && !live.has(key)) {
        s.on = false;
        s.el.classList.add('hide');
      }
    }
  }

  private mark(key: string): Shown {
    let s = this.shown.get(key);
    if (s) return s;
    const el = document.createElement('div');
    el.className = 'jm hide';
    el.innerHTML = '<div class="jm-disc"><svg viewBox="0 0 24 24"></svg></div><div class="jm-arrow"></div><div class="jm-under"><span class="jm-label"></span><span class="jm-dist"></span></div>';
    this.root.appendChild(el);
    s = { el, label: el.querySelector('.jm-label')!, dist: el.querySelector('.jm-dist')!, kind: '', text: '', meters: -1, on: false, edge: false, near: false, x: -1e9, y: -1e9, turn: -1e9 };
    this.shown.set(key, s);
    return s;
  }
}
