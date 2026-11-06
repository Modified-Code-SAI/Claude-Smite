import { pad } from '../core/Gamepad';
import './padCursor.css';

/**
 * A controller's way through the menus: whenever a menu or a screen without
 * play is up (the title screen, the game menu, the skill trees, settings,
 * end screens), the left stick moves an on-screen cursor and A clicks what
 * it's on. It slows over buttons so they're easy to land on; the right
 * stick scrolls; B (and Menu) go back; on a slider the D-pad steps it and A
 * drags it; LB and RB change tabs where there are tabs.
 *
 * The game says when it wants the cursor (`padCursor.wanted`), and what
 * "back" does on each screen (`padCursor.back`).
 */
export const padCursor = {
  /** Whether the screen is a menu now; main.ts narrows it once a match is in play. */
  wanted: (): boolean => true,
  /** B or Menu: close what's on top. Defaults to an Escape key. */
  back: (): void => escapeKey(),
  /** LB / RB: the previous or next tab, if the screen has tabs. Returns whether it did. */
  tabs: null as ((dir: -1 | 1) => boolean) | null,
};

const A = 1 << 0;
const B = 1 << 1;
const LB = 1 << 4;
const RB = 1 << 5;
const MENU = 1 << 9;
const LEFT = 1 << 14;
const RIGHT = 1 << 15;
const UP = 1 << 12;
const DOWN = 1 << 13;

const SPEED = 1500;
const CLICKABLE = 'button, a[href], input, select, label, summary, [role="button"], [data-tab], [data-val], [data-q], [data-act]';

/** An Escape key, as if pressed: what closes most screens. */
export function escapeKey(): void {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true }));
  target.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', key: 'Escape', bubbles: true }));
}

export function mountPadCursor(): void {
  const el = document.createElement('div');
  el.className = 'pad-cursor';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  let x = innerWidth / 2;
  let y = innerHeight / 2;
  let on = false;
  /** What's under the cursor, and the clickable thing it belongs to. */
  let under: Element | null = null;
  let hover: HTMLElement | null = null;
  let dragging: HTMLInputElement | null = null;
  let repeatAt = 0;
  /** Scroll carried over between frames, so a slight tilt still moves a whole pixel now and then. */
  let scrollAcc = 0;

  const pointer = (type: string, t: Element) => {
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window };
    t.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(type, init));
  };

  const setHover = (h: HTMLElement | null, raw: Element | null) => {
    if (raw !== under) {
      if (under) {
        pointer('pointerout', under);
        pointer('mouseout', under);
      }
      if (raw) {
        pointer('pointerover', raw);
        pointer('mouseover', raw);
      }
      under = raw;
    }
    if (h === hover) return;
    if (hover) {
      hover.classList.remove('pad-hover');
      hover.dispatchEvent(new MouseEvent('mouseleave', { clientX: x, clientY: y }));
    }
    hover = h;
    if (hover) {
      hover.classList.add('pad-hover');
      hover.dispatchEvent(new MouseEvent('mouseenter', { clientX: x, clientY: y }));
    }
    el.classList.toggle('over', !!hover);
  };

  const find = (): void => {
    const raw = document.elementFromPoint(x, y);
    const h = raw && raw !== el ? raw.closest<HTMLElement>(CLICKABLE) : null;
    setHover(h && !(h as HTMLButtonElement).disabled ? h : null, raw);
  };

  const setRange = (r: HTMLInputElement, value: number) => {
    const min = Number(r.min || 0);
    const max = Number(r.max || 100);
    const step = Number(r.step) || 1;
    const v = Math.min(max, Math.max(min, Math.round((value - min) / step) * step + min));
    if (String(v) === r.value) return;
    r.value = String(v);
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const rangeAt = (r: HTMLInputElement) => {
    const box = r.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (x - box.left) / Math.max(1, box.width)));
    setRange(r, Number(r.min || 0) + k * (Number(r.max || 100) - Number(r.min || 0)));
  };

  const click = () => {
    if (!under) return;
    const h = hover;
    if (h instanceof HTMLInputElement && h.type === 'range') {
      dragging = h;
      rangeAt(h);
      return;
    }
    if (h instanceof HTMLSelectElement) {
      h.selectedIndex = (h.selectedIndex + 1) % Math.max(1, h.options.length);
      h.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const t = h ?? under;
    pointer('pointerdown', t);
    pointer('mousedown', t);
    pointer('pointerup', t);
    pointer('mouseup', t);
    if (h instanceof HTMLInputElement && (h.type === 'text' || h.type === 'search' || h.type === 'number')) h.focus();
    pointer('click', t);
  };

  /** The D-pad over a slider or a list steps it; elsewhere it nudges the cursor a button's width. */
  const nudge = (dir: -1 | 1, vertical: boolean) => {
    const h = hover;
    if (!vertical && h instanceof HTMLInputElement && h.type === 'range') {
      setRange(h, Number(h.value) + dir * (Number(h.step) || 1));
      return;
    }
    if (!vertical && h instanceof HTMLSelectElement) {
      const n = h.options.length;
      h.selectedIndex = (h.selectedIndex + dir + n) % n;
      h.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    jump(dir, vertical);
  };

  /** Hop to the nearest clickable thing that way (D-pad navigation for players who prefer it). */
  const jump = (dir: -1 | 1, vertical: boolean) => {
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const c of document.querySelectorAll<HTMLElement>(CLICKABLE)) {
      if (c === hover || (c as HTMLButtonElement).disabled) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const along = vertical ? (cy - y) * dir : (cx - x) * dir;
      const across = vertical ? Math.abs(cx - x) : Math.abs(cy - y);
      if (along < 8) continue;
      // only what's really under the cursor's spot counts (not a card under a modal)
      const top = document.elementFromPoint(cx, cy);
      if (!top || !(c === top || c.contains(top))) continue;
      const score = along + across * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) return;
    const r = best.getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
    find();
  };

  /** The scrollable box under the cursor (or the page). */
  const scroller = (): Element | null => {
    for (let n: Element | null = under; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 2) return n;
    }
    return document.scrollingElement;
  };

  pad.onFrame((dt) => {
    const want = pad.active && padCursor.wanted();
    if (want !== on) {
      on = want;
      el.classList.toggle('on', on);
      document.documentElement.classList.toggle('pad-menus', on);
      // presses from the moment it changed hands belong to the other side
      pad.menuLatch = 0;
      if (!on) {
        setHover(null, null);
        dragging = null;
      }
    }
    pad.menuMode = on;
    if (!on) {
      pad.menuLatch = 0;
      return;
    }
    // the game hears none of this
    pad.gameLatch = 0;
    const fresh = pad.menuLatch;
    pad.menuLatch = 0;

    const { x: sx, y: sy } = pad.left;
    const m = Math.hypot(sx, sy);
    if (m > 0) {
      // slower over a button so it's easy to stop on
      const k = SPEED * m ** 0.6 * (hover ? 0.5 : 1) * dt;
      x = Math.min(innerWidth - 2, Math.max(2, x + sx * k));
      y = Math.min(innerHeight - 2, Math.max(2, y + sy * k));
    }
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    if (m > 0 || !under || !under.isConnected) find();

    if (dragging) {
      if (pad.held('Pad0') && dragging.isConnected) rangeAt(dragging);
      else dragging = null;
    }
    if (fresh & A) {
      el.classList.remove('press');
      void el.offsetWidth;
      el.classList.add('press');
      click();
      // what was under the cursor may have changed (a menu opened)
      requestAnimationFrame(find);
    }
    if (fresh & (B | MENU)) {
      padCursor.back();
      requestAnimationFrame(find);
    }
    if (fresh & (LB | RB) && padCursor.tabs?.(fresh & LB ? -1 : 1)) requestAnimationFrame(find);
    // the D-pad: a press, then repeats while held
    const now = performance.now();
    const dirs = pad.down & (LEFT | RIGHT | UP | DOWN);
    if (fresh & dirs || (dirs && now > repeatAt)) {
      repeatAt = now + (fresh & dirs ? 380 : 90);
      if (dirs & LEFT) nudge(-1, false);
      else if (dirs & RIGHT) nudge(1, false);
      else if (dirs & UP) nudge(-1, true);
      else if (dirs & DOWN) nudge(1, true);
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    const scroll = pad.right.y;
    scrollAcc = scroll ? scrollAcc + scroll * Math.abs(scroll) * 1400 * dt : 0;
    const whole = Math.trunc(scrollAcc);
    if (whole) {
      scrollAcc -= whole;
      scroller()?.scrollBy({ top: whole });
    }
  });
  addEventListener('resize', () => {
    x = Math.min(x, innerWidth - 2);
    y = Math.min(y, innerHeight - 2);
  });
}
