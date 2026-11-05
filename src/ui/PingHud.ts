import { hex } from '../combat/palette';
import { PINGS, WHEEL, type PingKind } from '../sim/Pings';
import { pingIcon, PING_ICONS } from './pingIcons';
import './ping.css';

/** A ping's marker as the screen shows it this frame. */
export interface PingMark {
  id: number;
  kind: PingKind;
  /** Screen pixels: on the marked spot, or pinned to the screen's edge when it is out of view. */
  x: number;
  y: number;
  edge: boolean;
  /** Where the edge arrow points, radians (0 = right, clockwise). */
  angle: number;
  who: string;
  text: string;
  /** Who answered it ("Thor and Odin on the way"), or empty. */
  coming: string;
  /** Meters from the local player. */
  dist: number;
  /** Seconds since it went up, and how long it stays. */
  age: number;
  life: number;
  mine: boolean;
}

/** The wheel's size: the wedges' inner and outer radius and where the icons sit, pixels. */
const R_IN = 54;
const R_OUT = 148;
const R_ICON = 100;
/** Seconds a marker shows its words before shrinking to the icon and distance. */
const WORDS_FOR = 2.8;
const FEED_ROWS = 5;

function wedge(i: number): string {
  const half = (Math.PI / WHEEL.length) * 0.93;
  const mid = (i / WHEEL.length) * Math.PI * 2;
  const pt = (r: number, a: number) => `${(Math.sin(a) * r).toFixed(1)} ${(-Math.cos(a) * r).toFixed(1)}`;
  const a0 = mid - half;
  const a1 = mid + half;
  return `M${pt(R_IN, a0)} L${pt(R_OUT, a0)} A${R_OUT} ${R_OUT} 0 0 1 ${pt(R_OUT, a1)} L${pt(R_IN, a1)} A${R_IN} ${R_IN} 0 0 0 ${pt(R_IN, a0)}Z`;
}

/**
 * The ping wheel in the middle of the screen, the markers pings leave in the
 * world (pinned to the screen's edge when out of view), and a short feed of
 * the team's calls.
 */
export class PingHud {
  private readonly root = document.createElement('div');
  private readonly wheel: HTMLElement;
  private readonly wedges: SVGPathElement[];
  private readonly title: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly marks = new Map<number, { el: HTMLElement; who: HTMLElement; text: HTMLElement; coming: HTMLElement; dist: HTMLElement; full: boolean; edge: boolean; label: string; meters: number }>();
  private selected = -1;
  private context = '';

  constructor() {
    this.root.className = 'ping-hud';
    const slices = WHEEL.map((k, i) => {
      const a = (i / WHEEL.length) * Math.PI * 2;
      const x = Math.sin(a) * R_ICON;
      const y = -Math.cos(a) * R_ICON;
      return `<g class="pw-slice" style="--pc:${hex(PINGS[k].color)}"><path class="pw-wedge" d="${wedge(i)}"/><svg class="pw-icon" x="${(x - 14).toFixed(1)}" y="${(y - 21).toFixed(1)}" width="28" height="28" viewBox="0 0 24 24">${PING_ICONS[k]}</svg><text class="pw-label" x="${x.toFixed(1)}" y="${(y + 22).toFixed(1)}" text-anchor="middle">${PINGS[k].short}</text></g>`;
    }).join('');
    const size = R_OUT * 2 + 16;
    this.root.innerHTML = `
      <div class="ping-wheel"><svg viewBox="${-size / 2} ${-size / 2} ${size} ${size}" width="${size}" height="${size}"><circle class="pw-back" r="${R_OUT + 6}"/>${slices}<circle class="pw-hub" r="${R_IN - 6}"/></svg>
        <div class="pw-center"><b></b><span></span></div><i class="pw-dot"></i></div>
      <div class="ping-feed"></div>`;
    document.body.appendChild(this.root);
    this.wheel = this.root.querySelector('.ping-wheel')!;
    this.wedges = [...this.root.querySelectorAll<SVGPathElement>('.pw-wedge')];
    this.title = this.root.querySelector('.pw-center b')!;
    this.sub = this.root.querySelector('.pw-center span')!;
    this.dot = this.root.querySelector('.pw-dot')!;
    this.feed = this.root.querySelector('.ping-feed')!;
  }

  get wheelOpen(): boolean {
    return this.wheel.classList.contains('show');
  }

  /** Show the wheel; `context` names what the call would be about ("on Loki"). */
  openWheel(context: string): void {
    this.context = context;
    this.selected = -2;
    this.select(-1);
    this.wheel.classList.add('show');
  }

  closeWheel(): void {
    this.wheel.classList.remove('show');
  }

  /** Light the wedge the mouse points at (-1: none), and move the pointer dot (pixels from the center). */
  select(i: number, dx = 0, dy = 0): void {
    this.dot.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    if (i === this.selected) return;
    this.selected = i;
    this.wedges.forEach((w, j) => w.parentElement!.classList.toggle('on', j === i));
    if (i < 0) {
      this.title.textContent = 'Pick a call';
      this.sub.textContent = 'release to cancel';
      return;
    }
    const k = WHEEL[i]!;
    this.title.textContent = PINGS[k].label;
    this.sub.textContent = PINGS[k].at === 'self' && k !== 'help' ? 'to your team' : this.context;
  }

  /** Place every live marker; ones not in the list are taken down. */
  setMarks(list: readonly PingMark[]): void {
    const live = new Set<number>();
    for (const m of list) {
      live.add(m.id);
      let v = this.marks.get(m.id);
      if (!v) {
        const el = document.createElement('div');
        el.className = `ping-mark pop${m.mine ? ' mine' : ''}`;
        el.style.setProperty('--pc', hex(PINGS[m.kind].color));
        el.innerHTML = `<div class="pm-disc">${pingIcon(m.kind)}</div><i class="pm-arrow"></i><div class="pm-under"><div class="pm-text"><b></b> <span></span><em></em></div><div class="pm-dist"></div></div>`;
        this.root.appendChild(el);
        v = { el, who: el.querySelector('.pm-text b')!, text: el.querySelector('.pm-text span')!, coming: el.querySelector('.pm-text em')!, dist: el.querySelector('.pm-dist')!, full: true, edge: false, label: '', meters: -1 };
        this.marks.set(m.id, v);
      }
      const label = `${m.who}\n${m.text}\n${m.coming}`;
      if (label !== v.label) {
        // someone answering brings the words back for a moment
        if (m.coming && !v.label.endsWith(`\n${m.coming}`) && v.label) v.el.classList.add('answered');
        v.label = label;
        v.who.textContent = m.who;
        v.text.textContent = m.text;
        v.coming.textContent = m.coming;
      }
      const meters = Math.round(m.dist);
      if (meters !== v.meters) {
        v.meters = meters;
        v.dist.textContent = `${meters} m`;
      }
      const full = m.age < WORDS_FOR;
      if (full !== v.full) {
        v.full = full;
        v.el.classList.toggle('brief', !full);
      }
      if (m.edge !== v.edge) {
        v.edge = m.edge;
        v.el.classList.toggle('edge', m.edge);
      }
      const fade = Math.min(1, (m.life - m.age) / 0.6);
      v.el.style.opacity = fade.toFixed(2);
      v.el.style.transform = `translate(${m.x.toFixed(0)}px, ${m.y.toFixed(0)}px)`;
      if (m.edge) v.el.style.setProperty('--turn', `${m.angle.toFixed(3)}rad`);
    }
    for (const [id, v] of this.marks) {
      if (live.has(id)) continue;
      v.el.remove();
      this.marks.delete(id);
    }
  }

  /** A line in the team's call feed: who called what. */
  pushFeed(kind: PingKind, who: string, text: string, mine: boolean): void {
    const row = document.createElement('div');
    row.className = 'ping-row';
    row.style.setProperty('--pc', hex(PINGS[kind].color));
    row.innerHTML = `${pingIcon(kind)}<b class="${mine ? 'me' : ''}"></b><span></span>`;
    row.querySelector('b')!.textContent = who;
    row.querySelector('span')!.textContent = text;
    this.feed.appendChild(row);
    setTimeout(() => row.classList.add('out'), 6000);
    setTimeout(() => row.remove(), 6600);
    while (this.feed.children.length > FEED_ROWS) this.feed.firstElementChild!.remove();
  }

  dispose(): void {
    this.root.remove();
  }
}
