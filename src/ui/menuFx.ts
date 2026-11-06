import './menuFx.css';

/**
 * Drifting embers over menu art: a few dozen tiny CSS-animated dots (the
 * compositor moves them, not the main thread). Goes inside an element with
 * the `embers` class.
 */
export function embersHtml(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = (i * 37.7) % 100;
    const d = 9 + ((i * 7.3) % 9);
    const delay = -((i * 3.1) % d);
    const size = 2 + ((i * 5) % 3);
    const drift = ((i * 13) % 40) - 20;
    s += `<i style="left:${x.toFixed(1)}%;width:${size}px;height:${size}px;animation-duration:${d.toFixed(1)}s;animation-delay:${delay.toFixed(1)}s;--drift:${drift}px"></i>`;
  }
  return s;
}

/**
 * Menu art that leans with the pointer: `--px` and `--py` (-1 to 1, from the
 * middle of the screen) on `root`, which the stylesheet turns into small
 * `translate`s, the far layers moving less than the near ones, eased by CSS
 * transitions so a stalled frame (a map building behind the menu) never
 * jerks. Nothing with reduced motion asked for. Returns the stop.
 */
export function parallax(root: HTMLElement): () => void {
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return () => undefined;
  let raf = 0;
  let x = 0;
  let y = 0;
  const move = (e: PointerEvent) => {
    x = (e.clientX / Math.max(1, innerWidth)) * 2 - 1;
    y = (e.clientY / Math.max(1, innerHeight)) * 2 - 1;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      root.style.setProperty('--px', x.toFixed(3));
      root.style.setProperty('--py', y.toFixed(3));
    });
  };
  window.addEventListener('pointermove', move, { passive: true });
  return () => {
    window.removeEventListener('pointermove', move);
    cancelAnimationFrame(raf);
  };
}
