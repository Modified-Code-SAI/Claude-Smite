import type { Side } from '../game/combatant';
import { Arena } from '../scene/ArenaLayout';
import { RUSH, type Rush } from '../sim/Rush';
import type { Unit } from '../sim/Unit';

const ALLY = '#4fb2ff';
const FOE = '#ff4a38';
const GOLD = '#ffc23a';
/** Redraws a second: smooth enough for dots, and one small canvas a frame at most. */
const RATE = 30;

/**
 * Relic Rush's radar, top right: the whole round pitch with the enemy gate at
 * the top, every god as a dot in team color (you as an arrow showing where
 * you face), the relic as a gold star (ringed in its carrier's team color, and
 * with a dashed line to where a pass will land), and a pulse round teammates calling for it.
 * The markings are drawn once; each redraw only paints the dots over them.
 */
export class RushRadar {
  readonly el = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  private readonly base = document.createElement('canvas');
  /** On-screen size in CSS pixels, and pixels per meter. */
  private size = 0;
  /**
   * The canvas's CSS width as last laid out. A resize observer keeps it, so
   * no frame forces a layout to read it, and redraws the markings (tens of ms
   * the first time: not in a frame of play).
   */
  private css = 0;
  private scale = 1;
  private wait = 0;
  /** -1 flips the map for the side defending -z, so the enemy gate is always at the top. */
  private readonly flip: number;

  constructor(
    private readonly rush: Rush,
    private readonly me: Unit,
    private readonly gods: readonly Unit[],
  ) {
    this.el.className = 'rush-radar';
    this.g = this.el.getContext('2d')!;
    this.flip = (me.team as Side) === 'order' ? 1 : -1;
    // (the first size arrives while the loading screen is still up, so the markings are drawn then)
    new ResizeObserver(([e]) => {
      this.css = e?.contentRect.width ?? 0;
      this.layout();
    }).observe(this.el);
  }

  /** Map coordinates (CSS pixels) of a point on the pitch. */
  private at(x: number, z: number): [number, number] {
    const h = this.size / 2;
    return [h + x * this.flip * this.scale, h + z * this.flip * this.scale];
  }

  private layout(): boolean {
    const css = this.css;
    if (!css) return false;
    if (css === this.size && this.el.width === Math.round(css * devicePixelRatio)) return true;
    this.size = css;
    this.scale = (css / 2 - 4) / RUSH.pitchRadius;
    const px = Math.round(css * devicePixelRatio);
    this.el.width = this.el.height = this.base.width = this.base.height = px;
    this.drawBase();
    return true;
  }

  /** The pitch and its markings, drawn once per size. */
  private drawBase(): void {
    const g = this.base.getContext('2d')!;
    const h = this.size / 2;
    const k = this.scale;
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    g.clearRect(0, 0, this.size, this.size);
    // the field, darker toward the rim, and the temple's raised plaza a shade lighter
    const field = g.createRadialGradient(h, h, 0, h, h, h);
    field.addColorStop(0, 'rgba(46, 36, 20, 0.82)');
    field.addColorStop(1, 'rgba(10, 8, 5, 0.86)');
    g.fillStyle = field;
    g.beginPath();
    g.arc(h, h, RUSH.pitchRadius * k, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255, 236, 196, 0.07)';
    g.beginPath();
    g.arc(h, h, Arena.plaza.radius * k, 0, Math.PI * 2);
    g.fill();
    // gold markings: center circle, halfway line, the pitch's edge
    g.strokeStyle = 'rgba(255, 200, 90, 0.5)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(h, h, 6.2 * k, 0, Math.PI * 2);
    g.moveTo(h - Arena.plaza.radius * k, h);
    g.lineTo(h + Arena.plaza.radius * k, h);
    g.stroke();
    g.strokeStyle = 'rgba(231, 194, 122, 0.85)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(h, h, RUSH.pitchRadius * k, 0, Math.PI * 2);
    g.stroke();
    // each gate as a bar in its defenders' color, with its keeper's box
    for (const side of ['order', 'chaos'] as const) {
      const gate = RUSH.gates[side];
      const ours = side === this.me.team;
      const col = ours ? ALLY : FOE;
      const [x0, y0] = this.at(gate.x - RUSH.keeper.halfWidth, gate.z);
      const [x1, y1] = this.at(gate.x + RUSH.keeper.halfWidth, gate.z - Math.sign(gate.z) * RUSH.keeper.depth);
      g.strokeStyle = col;
      g.globalAlpha = 0.45;
      g.lineWidth = 1;
      g.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      g.globalAlpha = 1;
      const [ax, ay] = this.at(gate.x - RUSH.gateHalfWidth, gate.z);
      const [bx, by] = this.at(gate.x + RUSH.gateHalfWidth, gate.z);
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.shadowColor = col;
      g.shadowBlur = 6;
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke();
      g.shadowBlur = 0;
    }
  }

  frame(dt: number, t: number): void {
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = 1 / RATE;
    if (!this.layout()) return;
    const g = this.g;
    const r = this.rush;
    const relic = r.relic;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.el.width, this.el.height);
    g.drawImage(this.base, 0, 0);
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    // a pass in the air: a dashed line from the relic to where it comes down
    if (relic.phase === 'flying') {
      const [x0, y0] = this.at(relic.x, relic.z);
      const [x1, y1] = this.at(relic.tx, relic.tz);
      g.strokeStyle = 'rgba(255, 210, 110, 0.85)';
      g.lineWidth = 1.2;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.arc(x1, y1, 3, 0, Math.PI * 2);
      g.stroke();
    }

    for (const u of this.gods) {
      if (u === this.me) continue;
      const [x, y] = this.at(u.x, u.z);
      const ours = u.team === this.me.team;
      // dazed gods are drawn hollow
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      if (u.alive) {
        g.fillStyle = ours ? ALLY : FOE;
        g.fill();
        g.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        g.lineWidth = 1;
        g.stroke();
      } else {
        g.strokeStyle = ours ? ALLY : FOE;
        g.globalAlpha = 0.6;
        g.lineWidth = 1.2;
        g.stroke();
        g.globalAlpha = 1;
      }
      // a teammate calling for the pass: a gold ring pulsing out
      const ago = ours ? r.calledAgo(u) : null;
      if (ago !== null) {
        const p = (ago * 2.2) % 1;
        g.strokeStyle = `rgba(255, 210, 90, ${(1 - p).toFixed(2)})`;
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(x, y, 5 + p * 7, 0, Math.PI * 2);
        g.stroke();
      }
    }

    // the relic: a gold star, ringing whoever carries it
    if (relic.phase !== 'gone') {
      const [x, y] = this.at(relic.x, relic.z);
      if (relic.holder) {
        // the ring in the carrier's team color, so whose it is reads at a glance
        g.strokeStyle = relic.holder.team === this.me.team ? ALLY : FOE;
        g.lineWidth = 2.2;
        g.beginPath();
        g.arc(x, y, 7 + Math.sin(t * 6) * 0.8, 0, Math.PI * 2);
        g.stroke();
      }
      star(g, x, y, relic.holder ? 3.6 : 4.6, GOLD);
    }

    // you, on top: an arrow pointing where you face
    {
      const [x, y] = this.at(this.me.x, this.me.z);
      const f = this.me.forward;
      const a = Math.atan2(f.z * this.flip, f.x * this.flip);
      g.save();
      g.translate(x, y);
      g.rotate(a);
      g.globalAlpha = this.me.alive ? 1 : 0.5;
      g.fillStyle = '#fff4d6';
      g.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      g.lineWidth = 1;
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
  }
}

/** A four-pointed star with a dark edge, so it reads over the dots. */
function star(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const d = i % 2 ? r * 0.42 : r;
    g.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  g.closePath();
  g.fillStyle = fill;
  g.shadowColor = 'rgba(255, 190, 60, 0.9)';
  g.shadowBlur = 6;
  g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = 'rgba(60, 30, 0, 0.9)';
  g.lineWidth = 1;
  g.stroke();
}
