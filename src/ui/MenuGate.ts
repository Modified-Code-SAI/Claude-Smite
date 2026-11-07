/**
 * Loading work that holds the page for a while (a map's shader frames, up to a
 * quarter second each) waits for the menus, so they never stutter while used:
 * on the home page until it has been left alone a moment, on the god pick until
 * you're Ready. The trailer before them and the versus screen after them only
 * move on the compositor, so the work runs there at full speed.
 */
export const QUIET_MS = 700;

/** What counts as using a menu (the controller cursor sends pointer events too). */
const INPUTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export class MenuGate {
  private home = false;
  private lastInput = -Infinity;
  private pick: Promise<void> = Promise.resolve();

  constructor(
    target: EventTarget = window,
    private readonly now: () => number = () => performance.now(),
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    const used = () => (this.lastInput = this.now());
    for (const type of INPUTS) target.addEventListener(type, used, { capture: true, passive: true });
  }

  /** The home page came up (true) or gave way to the god pick (false). */
  homeShown(on: boolean): void {
    this.home = on;
  }

  /** The god pick is up: heavy work waits until nothing on it takes a click. */
  pickShown(settled: Promise<void>): void {
    this.pick = settled;
  }

  /** Resolves once heavy work may take a frame. */
  async clear(): Promise<void> {
    for (;;) {
      const pick = this.pick;
      await pick;
      // a god pick opened while waiting
      if (pick !== this.pick) continue;
      const left = this.home ? QUIET_MS - (this.now() - this.lastInput) : 0;
      if (left <= 0) return;
      await this.wait(left);
    }
  }
}
