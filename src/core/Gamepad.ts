import { padFamily, type PadFamily } from '../settings/padBindings';
import { settings } from '../settings/store';

/** What a browser's gamepad gives us, kept to the parts we read (some engines lack the haptics). */
interface Haptics {
  playEffect?(type: 'dual-rumble', params: { startDelay?: number; duration: number; weakMagnitude: number; strongMagnitude: number }): Promise<unknown>;
}

const BUTTONS = 16;

/**
 * The controller: one pad (the first in the standard layout), read once a
 * frame. Buttons are bits (bit i = 'Pad{i}'); the sticks come out with the
 * player's dead zone taken off and rescaled, so a stick just past the dead
 * zone is a small number, not a jump.
 *
 * Presses go to two places: the game (Input) and the menu cursor
 * (PadCursor). While the cursor has the controller (`menuMode`), the game
 * hears none of it, so the A that clicks Resume never also jumps.
 */
class Pad {
  connected = false;
  /** The controller was the last thing used, not the keyboard or mouse: prompts show its buttons. */
  active = false;
  family: PadFamily = 'xbox';
  /** The controller's name as the browser reports it, tidied. */
  name = '';
  /** Buttons held now. */
  down = 0;
  readonly left = { x: 0, y: 0 };
  readonly right = { x: 0, y: 0 };
  /** The menu cursor has the controller: the game hears none of it. */
  menuMode = false;
  /** The settings menu waiting for a button to bind: the next press goes here and nowhere else. */
  listen: ((code: string) => void) | null = null;
  /** Presses since the game last took them, and since the cursor last did. */
  gameLatch = 0;
  menuLatch = 0;

  private index = -1;
  private lastPoll = -1;
  private readonly triggerHeld = [false, false];
  private readonly listeners: (() => void)[] = [];
  private readonly frameHooks: ((dt: number) => void)[] = [];
  private running = false;
  private lastFrame = 0;
  private rumbleUntil = 0;
  private rumbleLevel = 0;

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('gamepadconnected', () => this.pick());
    window.addEventListener('gamepaddisconnected', () => this.pick());
    // the keyboard or mouse taking over (the cursor's own synthetic clicks don't count)
    const off = (e: Event) => {
      if (e.isTrusted) this.setActive(false);
    };
    window.addEventListener('keydown', off, true);
    window.addEventListener('mousedown', off, true);
    // a mouse only takes over after a real move, not a bumped desk
    let moved = 0;
    window.addEventListener(
      'mousemove',
      (e) => {
        if (!this.active || !e.isTrusted) return;
        moved += Math.abs(e.movementX) + Math.abs(e.movementY);
        if (moved > 80) {
          moved = 0;
          this.setActive(false);
        }
      },
      true,
    );
    // a pad already plugged in shows only once a button is pressed (browsers hide it until then)
    this.pick();
  }

  /** Hear the controller come and go, or take over from the keyboard (prompts change). */
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Run each frame while a controller is connected, after the poll (the menu cursor). */
  onFrame(fn: (dt: number) => void): void {
    this.frameHooks.push(fn);
  }

  held(code: string | null): boolean {
    return !!code && (this.down & (1 << Number(code.slice(3)))) !== 0;
  }

  /** Read the controller (at most once a frame: the game and the cursor both ask). */
  poll(): void {
    const now = performance.now();
    if (now - this.lastPoll < 2) return;
    this.lastPoll = now;
    if (!this.connected) return;
    const gp = navigator.getGamepads?.()[this.index];
    if (!gp) {
      this.pick();
      return;
    }
    let down = 0;
    const n = Math.min(BUTTONS, gp.buttons.length);
    for (let i = 0; i < n; i++) {
      const b = gp.buttons[i]!;
      const v = Math.max(b.value, b.pressed ? 1 : 0);
      let on: boolean;
      if (i === 6 || i === 7) {
        // the triggers: pressed past 40%, let go under 22%, so a resting finger doesn't chatter
        const t = i - 6;
        on = this.triggerHeld[t] ? v > 0.22 : v > 0.4;
        this.triggerHeld[t] = on;
      } else on = v > 0.5;
      if (on) down |= 1 << i;
    }
    const dz = settings().padDeadzone;
    stick(this.left, gp.axes[0] ?? 0, gp.axes[1] ?? 0, dz);
    stick(this.right, gp.axes[2] ?? 0, gp.axes[3] ?? 0, dz);
    const fresh = down & ~this.down;
    this.down = down;
    if (fresh) {
      if (this.listen) {
        const f = this.listen;
        this.listen = null;
        f(`Pad${31 - Math.clz32(fresh & -fresh)}`);
      } else {
        this.gameLatch |= fresh;
        this.menuLatch |= fresh;
      }
    }
    const moved = Math.max(Math.abs(this.left.x), Math.abs(this.left.y), Math.abs(this.right.x), Math.abs(this.right.y)) > 0.1;
    if (fresh || moved) this.setActive(true);
  }

  /**
   * A buzz for a hit or a blast, 0 to 1, scaled by Settings > Controls >
   * Vibration. A weaker one never cuts a stronger one short.
   */
  rumble(strength: number, ms = 80 + Math.min(1, strength) * 240): void {
    const k = settings().vibration * Math.min(1, strength);
    if (k < 0.03 || !this.active || !this.connected) return;
    const now = performance.now();
    if (now < this.rumbleUntil && k < this.rumbleLevel) return;
    const gp = navigator.getGamepads?.()[this.index] as (Gamepad & { vibrationActuator?: Haptics }) | null | undefined;
    const act = gp?.vibrationActuator;
    if (!act?.playEffect) return;
    this.rumbleUntil = now + ms;
    this.rumbleLevel = k;
    act.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: Math.min(1, k * 1.1), weakMagnitude: Math.min(1, k * 1.4) })?.catch(() => {});
  }

  /** Take the first controller in the standard layout (or any, if none is). */
  private pick(): void {
    const pads = [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p && p.connected);
    const gp = pads.find((p) => p.mapping === 'standard') ?? pads[0] ?? null;
    const was = this.connected;
    const wasName = this.name;
    this.connected = !!gp;
    this.index = gp?.index ?? -1;
    this.name = gp ? tidy(gp.id) : '';
    this.family = gp ? padFamily(gp.id) : 'xbox';
    if (!gp) {
      this.down = 0;
      this.left.x = this.left.y = this.right.x = this.right.y = 0;
      this.setActive(false);
    } else this.start();
    if (was !== this.connected || wasName !== this.name) for (const f of this.listeners) f();
  }

  private setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    for (const f of this.listeners) f();
  }

  /** Its own frame loop while connected, so the title screen and menus hear it with no game running. */
  private start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const step = (now: number) => {
      if (!this.connected) {
        this.running = false;
        return;
      }
      const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      this.poll();
      for (const f of this.frameHooks) f(dt);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

/** A stick with a round dead zone, rescaled so it starts from zero at its edge. */
function stick(out: { x: number; y: number }, x: number, y: number, dz: number): void {
  const m = Math.hypot(x, y);
  if (m <= dz) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  out.x = x * k;
  out.y = y * k;
}

/** 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)' -> 'Xbox Wireless Controller'. */
function tidy(id: string): string {
  const name = id.replace(/\s*\(.*\)\s*$/, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim();
  return name || 'Controller';
}

export const pad = new Pad();
export { stick as deadzoneStick };
