import { hex, SIDE_CSS } from '../combat/palette';
import { Arena } from '../scene/ArenaLayout';
import { JOTUNN, type Jotunn } from '../sim/Jotunn';
import type { Unit } from '../sim/Unit';

const GOLD = '#ffc23a';
const FIRE = '#ffa040';
const ICE = '#8fe4ff';
/** Each shrine's own glow (as its obelisk glows in JotunnView). */
const SHRINE_TINT: Record<string, string> = { rime: '#6fe6ff', avalanche: '#d4ecff', hail: '#8f9dff' };
/** Redraws a second: smooth enough for dots, and one small canvas a frame at most. */
const RATE = 20;
/** Seconds a brazier rings red after a blow lands on it. */
const STRUCK = 2.5;

/**
 * The part of the valley the radar shows: centered between the giant's lair
 * and the gods' fountain, and reaching both and all three shrines.
 */
export const RADAR = { cx: 0, cz: -12, reach: 62 };

/** The radar's CSS size on a screen `w` pixels wide (jotunn.css .jt-radar: clamp(120px, 15vw, 176px)). */
export function radarSize(w: number): number {
  return Math.min(176, Math.max(120, 0.15 * w));
}

/**
 * Where a spot on the map lands on a radar `size` CSS pixels across. `flip`
 * -1 turns it round for the giant, so whoever reads it has the other side at
 * the top: the giant's lair for the gods, the gods' fountain for the giant.
 */
export function radarPoint(x: number, z: number, size: number, flip: 1 | -1): [number, number] {
  const h = size / 2;
  const k = (h - 4) / RADAR.reach;
  return [h + (x - RADAR.cx) * flip * k, h + (z - RADAR.cz) * flip * k];
}

/**
 * Jötunn's radar, top right: the valley with its temple, lanes and paths;
 * the four braziers (burning with their health round them, ringing red while
 * the giant clubs one, sealed in ice once smashed); the three ice shrines
 * (lit when ready, filling as the giant claims one, gold while gods hold it);
 * the giant as a big red marker with a wedge showing where it faces (and a
 * gold ring while it kneels with its crown open); a planted wrist; the gods;
 * the team's pings; and you as an arrow. The map is drawn once per size for
 * each way round, and each redraw only paints what moves over it.
 */
export class JotunnRadar {
  readonly el = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  /** The valley drawn once per size: the gods' way round, then the giant's. */
  private readonly bases = [document.createElement('canvas'), document.createElement('canvas')];
  /** On-screen size in CSS pixels, and pixels per meter. */
  private size = 0;
  private scale = 1;
  /** The canvas's CSS width as last laid out (a resize observer keeps it, so no frame forces a layout to read it). */
  private css = 0;
  private wait = 0;
  private t = 0;
  private flip: 1 | -1 = 1;
  /** Where the last spot placed lands (place()), kept here so a redraw makes no garbage. */
  private x = 0;
  private y = 0;
  /** Each brazier's health at the last redraw, and when a blow last landed on it. */
  private readonly hp: number[] = [];
  private readonly struck: number[] = [];
  /** The team's pings (PingMode.mapMarks). */
  pings: readonly { x: number; z: number; color: number; age: number }[] = [];

  constructor(
    private readonly mode: Jotunn,
    /** The local player's own god (it sits the round out while they play the giant). */
    private readonly me: Unit,
  ) {
    this.el.className = 'jt-radar';
    this.g = this.el.getContext('2d')!;
    // (the first size arrives while the loading screen is still up, so the valley is drawn then)
    new ResizeObserver(([e]) => {
      this.css = e?.contentRect.width ?? 0;
      this.layout();
    }).observe(this.el);
  }

  private place(x: number, z: number): void {
    const h = this.size / 2;
    this.x = h + (x - RADAR.cx) * this.flip * this.scale;
    this.y = h + (z - RADAR.cz) * this.flip * this.scale;
  }

  private layout(): boolean {
    const css = this.css;
    if (!css) return false;
    if (css === this.size && this.el.width === Math.round(css * devicePixelRatio)) return true;
    this.size = css;
    this.scale = (css / 2 - 4) / RADAR.reach;
    const px = Math.round(css * devicePixelRatio);
    this.el.width = this.el.height = px;
    for (const b of this.bases) b.width = b.height = px;
    this.drawBase(this.bases[0]!, 1);
    this.drawBase(this.bases[1]!, -1);
    return true;
  }

  /** The valley: snow-dim floor inside the cliffs, the lanes and paths, the temple plaza and its columns. */
  private drawBase(c: HTMLCanvasElement, flip: 1 | -1): void {
    const g = c.getContext('2d')!;
    const s = this.size;
    const h = s / 2;
    const k = this.scale;
    this.flip = flip;
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    g.clearRect(0, 0, s, s);
    g.save();
    g.beginPath();
    g.arc(h, h, h - 1, 0, Math.PI * 2);
    g.clip();
    // the cliffs past the valley's rim, then its floor
    g.fillStyle = 'rgba(7, 10, 14, 0.9)';
    g.fillRect(0, 0, s, s);
    this.place(0, 0);
    const cx = this.x;
    const cy = this.y;
    const floor = g.createRadialGradient(cx, cy, 0, cx, cy, Arena.valleyRadius * k);
    floor.addColorStop(0, 'rgba(46, 60, 72, 0.88)');
    floor.addColorStop(1, 'rgba(22, 31, 40, 0.9)');
    g.fillStyle = floor;
    g.beginPath();
    g.arc(cx, cy, Arena.valleyRadius * k, 0, Math.PI * 2);
    g.fill();
    // the paved lanes north and south, and the dirt paths east and west
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(225, 238, 248, 0.11)';
    for (const l of Arena.lanes) {
      g.lineWidth = l.width * k;
      g.beginPath();
      this.place(l.from[0], l.from[1]);
      g.moveTo(this.x, this.y);
      this.place(l.to[0], l.to[1]);
      g.lineTo(this.x, this.y);
      g.stroke();
    }
    g.strokeStyle = 'rgba(205, 220, 230, 0.08)';
    for (const p of Arena.paths) {
      g.lineWidth = Math.max(1.5, p.width * k);
      g.beginPath();
      p.points.forEach(([x, z], i) => {
        this.place(x, z);
        if (i) g.lineTo(this.x, this.y);
        else g.moveTo(this.x, this.y);
      });
      g.stroke();
    }
    // the temple plaza and its ring of columns (gaps where the lanes cross, as Temple.ts builds it)
    const plaza = Arena.plaza;
    g.fillStyle = 'rgba(235, 246, 255, 0.11)';
    g.strokeStyle = 'rgba(190, 228, 248, 0.38)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, plaza.baseRadius * k, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = 'rgba(214, 234, 248, 0.5)';
    for (let i = 0; i < plaza.columnCount; i++) {
      const a = (i / plaza.columnCount) * Math.PI * 2 + Math.PI / plaza.columnCount;
      if (Math.abs(Math.cos(a)) < 0.12) continue;
      this.place(Math.cos(a) * plaza.columnRing, Math.sin(a) * plaza.columnRing);
      g.beginPath();
      g.arc(this.x, this.y, Math.max(0.8, plaza.columnRadius * k), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    // the rim
    g.strokeStyle = 'rgba(143, 228, 255, 0.55)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(h, h, h - 1, 0, Math.PI * 2);
    g.stroke();
  }

  frame(dt: number): void {
    this.t += dt;
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = 1 / RATE;
    if (!this.layout()) return;
    const m = this.mode;
    const t = this.t;
    const g = this.g;
    const giantMe = m.giantPlayer.god === this.me;
    this.flip = giantMe ? -1 : 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.el.width, this.el.height);
    g.drawImage(this.bases[giantMe ? 1 : 0]!, 0, 0);
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    // the two ends: the gods' fountain and the giant's lair, in the color of whose they are to you
    this.base(JOTUNN.bases.order, giantMe ? SIDE_CSS.foe : SIDE_CSS.ally);
    this.base(JOTUNN.bases.chaos, giantMe ? SIDE_CSS.ally : SIDE_CSS.foe);

    // the shrines: a diamond in its own glow while it is ready, dim while it rearms (the arc fills back)
    for (const s of m.shrines) {
      this.place(s.def.x, s.def.z);
      const ready = s.dormant <= 0;
      const tint = SHRINE_TINT[s.def.id] ?? ICE;
      if (ready && s.progress > 0) {
        g.strokeStyle = s.contested ? GOLD : tint;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(this.x, this.y, 7.5, -Math.PI / 2, -Math.PI / 2 + s.progress * Math.PI * 2);
        g.stroke();
      } else if (!ready) {
        g.strokeStyle = 'rgba(160, 190, 210, 0.4)';
        g.lineWidth = 1.2;
        g.beginPath();
        g.arc(this.x, this.y, 6.5, -Math.PI / 2, -Math.PI / 2 + Math.max(0, 1 - s.dormant / JOTUNN.shrineRearm) * Math.PI * 2);
        g.stroke();
      }
      diamond(g, this.x, this.y, ready ? 4.6 : 3.6, ready ? tint : 'rgba(120, 142, 158, 0.75)', ready);
    }

    // the braziers: flames with their health round them, a red ring while struck, ice once smashed
    for (let i = 0; i < m.braziers.length; i++) {
      const b = m.braziers[i]!;
      this.place(b.x, b.z);
      const hp = b.combatant.health;
      if (!b.alive) {
        this.hp[i] = 0;
        cross(g, this.x, this.y, 2.6, ICE);
        continue;
      }
      if (hp < (this.hp[i] ?? hp) - 0.5) this.struck[i] = t;
      this.hp[i] = hp;
      const ago = t - (this.struck[i] ?? -99);
      if (ago < STRUCK) {
        const p = (ago * 1.8) % 1;
        g.strokeStyle = `rgba(255, 74, 56, ${(1 - p).toFixed(2)})`;
        g.lineWidth = 1.6;
        g.beginPath();
        g.arc(this.x, this.y, 4.5 + p * 7, 0, Math.PI * 2);
        g.stroke();
      }
      const share = Math.max(0, Math.min(1, hp / b.combatant.stats.maxHealth));
      g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      g.lineWidth = 2.4;
      g.beginPath();
      g.arc(this.x, this.y, 4.6, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = FIRE;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(this.x, this.y, 4.6, -Math.PI / 2, -Math.PI / 2 + share * Math.PI * 2);
      g.stroke();
      g.fillStyle = '#ffd27a';
      g.shadowColor = 'rgba(255, 150, 50, 0.95)';
      g.shadowBlur = 5;
      g.beginPath();
      g.arc(this.x, this.y, 2.4, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
    }

    // a planted fist after a slam: its wrist can be broken
    if (m.planted) {
      this.place(m.planted.x, m.planted.z);
      const p = (t * 2) % 1;
      g.strokeStyle = `rgba(255, 194, 58, ${(1 - p).toFixed(2)})`;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(this.x, this.y, 3 + p * 6, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = GOLD;
      g.beginPath();
      g.arc(this.x, this.y, 2.4, 0, Math.PI * 2);
      g.fill();
    }

    // pings: a ring pulsing out around a bright dot, in the call's color
    for (const p of this.pings) {
      this.place(p.x, p.z);
      const col = hex(p.color);
      const k = p.age % 1;
      g.globalAlpha = 1 - k;
      g.strokeStyle = col;
      g.lineWidth = 1.8;
      g.beginPath();
      g.arc(this.x, this.y, 3.5 + k * 8, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = col;
      g.beginPath();
      g.arc(this.x, this.y, 2.6, 0, Math.PI * 2);
      g.fill();
    }

    // the gods (the giant player's own god sits the round out), hollow while down
    for (const p of m.players) {
      const u = p.god;
      if (p === m.giantPlayer || u === this.me) continue;
      this.place(u.x, u.z);
      const col = giantMe ? SIDE_CSS.foe : SIDE_CSS.ally;
      g.beginPath();
      g.arc(this.x, this.y, 3.6, 0, Math.PI * 2);
      if (u.alive) {
        g.fillStyle = col;
        g.fill();
        g.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        g.lineWidth = 1;
        g.stroke();
      } else {
        g.strokeStyle = col;
        g.globalAlpha = 0.55;
        g.lineWidth = 1.2;
        g.stroke();
        g.globalAlpha = 1;
      }
    }

    // the giant: big, with a wedge where it faces; a gold ring while it kneels
    const gi = m.giant;
    this.place(gi.x, gi.z);
    const gx = this.x;
    const gy = this.y;
    if (m.kneeling > 0) {
      g.strokeStyle = GOLD;
      g.lineWidth = 2;
      g.shadowColor = 'rgba(255, 194, 58, 0.9)';
      g.shadowBlur = 6;
      g.beginPath();
      g.arc(gx, gy, 9.5 + Math.sin(t * 7) * 1.2, 0, Math.PI * 2);
      g.stroke();
      g.shadowBlur = 0;
    }
    if (giantMe) arrow(g, gx, gy, gi.forward, this.flip, 1.45, gi.alive);
    else {
      const f = gi.forward;
      g.save();
      g.translate(gx, gy);
      g.rotate(Math.atan2(f.z * this.flip, f.x * this.flip));
      g.globalAlpha = gi.alive ? 1 : 0.5;
      g.fillStyle = SIDE_CSS.foe;
      g.beginPath();
      g.moveTo(11.5, 0);
      g.lineTo(4.5, 4.6);
      g.lineTo(4.5, -4.6);
      g.closePath();
      g.fill();
      g.beginPath();
      g.arc(0, 0, 6, 0, Math.PI * 2);
      g.fillStyle = '#1c3044';
      g.fill();
      g.strokeStyle = SIDE_CSS.foe;
      g.lineWidth = 2.2;
      g.stroke();
      g.fillStyle = ICE;
      g.beginPath();
      g.arc(0, 0, 2.2, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    // you, on top: an arrow pointing where you face
    if (!giantMe) {
      this.place(this.me.x, this.me.z);
      arrow(g, this.x, this.y, this.me.forward, this.flip, 1, this.me.alive);
    }
  }

  /** A side's base: a faint disc ringed in its color. */
  private base(b: { x: number; z: number; radius: number }, col: string): void {
    const g = this.g;
    this.place(b.x, b.z);
    g.globalAlpha = 0.16;
    g.fillStyle = col;
    g.beginPath();
    g.arc(this.x, this.y, Math.max(4, b.radius * this.scale), 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 0.7;
    g.strokeStyle = col;
    g.lineWidth = 1.2;
    g.stroke();
    g.globalAlpha = 1;
  }
}

/** The local player's marker: an arrow pointing the way they face, `k` times the usual size. */
function arrow(g: CanvasRenderingContext2D, x: number, y: number, f: { x: number; z: number }, flip: number, k: number, alive: boolean): void {
  g.save();
  g.translate(x, y);
  g.rotate(Math.atan2(f.z * flip, f.x * flip));
  g.scale(k, k);
  g.globalAlpha = alive ? 1 : 0.5;
  g.fillStyle = '#fff4d6';
  g.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  g.lineWidth = 1 / k;
  g.beginPath();
  g.moveTo(7, 0);
  g.lineTo(-4.5, 4.5);
  g.lineTo(-2, 0);
  g.lineTo(-4.5, -4.5);
  g.closePath();
  g.fill();
  g.stroke();
  g.restore();
}

/** A shrine: a diamond with a dark edge, glowing while it is ready. */
function diamond(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, glow: boolean): void {
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r * 0.72, y);
  g.lineTo(x, y + r);
  g.lineTo(x - r * 0.72, y);
  g.closePath();
  g.fillStyle = fill;
  if (glow) {
    g.shadowColor = fill;
    g.shadowBlur = 6;
  }
  g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = 'rgba(4, 16, 30, 0.9)';
  g.lineWidth = 1;
  g.stroke();
}

/** A smashed brazier: a small cross in ice. */
function cross(g: CanvasRenderingContext2D, x: number, y: number, r: number, col: string): void {
  g.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(x - r, y - r);
  g.lineTo(x + r, y + r);
  g.moveTo(x + r, y - r);
  g.lineTo(x - r, y + r);
  g.stroke();
  g.strokeStyle = col;
  g.lineWidth = 1.4;
  g.stroke();
}
