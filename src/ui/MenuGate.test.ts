import { describe, expect, it } from 'vitest';
import { MenuGate, QUIET_MS } from './MenuGate';

/** A gate on a fake clock: `wait` moves the clock instead of sleeping. */
function rig() {
  const target = new EventTarget();
  let t = 1000;
  const waits: number[] = [];
  const gate = new MenuGate(target, () => t, async (ms) => {
    waits.push(ms);
    t += ms;
  });
  const use = (type = 'pointermove') => target.dispatchEvent(new Event(type));
  const at = (ms: number) => (t = ms);
  return { gate, use, at, waits, now: () => t };
}

describe('MenuGate', () => {
  it('lets loading through at once with no menu up (trailer, versus screen, ?map= links)', async () => {
    const { gate, use, waits } = rig();
    use();
    await gate.clear();
    expect(waits).toEqual([]);
  });

  it('holds loading on the home page until it has been left alone a moment', async () => {
    const { gate, use, at, waits, now } = rig();
    gate.homeShown(true);
    await gate.clear();
    expect(waits).toEqual([]);
    at(5000);
    use('keydown');
    at(5200);
    await gate.clear();
    expect(waits).toEqual([QUIET_MS - 200]);
    expect(now()).toBe(5000 + QUIET_MS);
  });

  it('holds loading on the god pick until you are Ready, whatever the mouse does', async () => {
    const { gate, use, waits } = rig();
    gate.homeShown(true);
    use('pointerdown');
    gate.homeShown(false);
    let ready!: () => void;
    gate.pickShown(new Promise<void>((r) => (ready = r)));
    let through = false;
    const cleared = gate.clear().then(() => (through = true));
    await Promise.resolve();
    expect(through).toBe(false);
    ready();
    await cleared;
    expect(through).toBe(true);
    // the home page is gone: a click on the pick doesn't hold the versus screen's loading
    use('pointerdown');
    waits.length = 0;
    await gate.clear();
    expect(waits).toEqual([]);
  });

  it('a god pick that opens while loading waits on the home page is waited for too', async () => {
    const target = new EventTarget();
    let t = 0;
    let ready!: () => void;
    const gate = new MenuGate(target, () => t, async (ms) => {
      t += ms;
      // Play is pressed during the wait
      gate.homeShown(false);
      gate.pickShown(new Promise<void>((r) => (ready = r)));
    });
    gate.homeShown(true);
    target.dispatchEvent(new Event('pointermove'));
    let through = false;
    const cleared = gate.clear().then(() => (through = true));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(through).toBe(false);
    ready();
    await cleared;
    expect(through).toBe(true);
  });
});
