import type { Action } from '../settings/bindings';
import { actionForCode, codesFor, keyGate, padCodeFor, settings } from '../settings/store';
import { pad } from './Gamepad';

/** How far the ping wheel's pick reaches, in the mouse pixels PingMode counts (its REACH). */
const WHEEL_REACH = 140;

/**
 * Keyboard and mouse state. Mouse look uses pointer lock, so `consumeMouseDelta`
 * returns raw movement since the last call. Keys are tracked by `KeyboardEvent.code`
 * so the layout (WASD on AZERTY etc.) stays physical. Gameplay asks about
 * actions (`actionDown('forward')`), which go through the player's bindings
 * (src/settings/bindings.ts); mouse buttons count as the codes 'Mouse0'..'Mouse4'.
 * A controller (src/core/Gamepad.ts) answers the same questions through its
 * own buttons (padBindings.ts): the left stick moves, the right stick looks.
 */
export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  private wheel = 0;
  private buttons = 0;
  locked = false;
  /**
   * While set, mouse movement collects here instead of turning the camera
   * (the ping wheel picks a call with it).
   */
  capture: { x: number; y: number } | null = null;
  /**
   * The crosshair is on an enemy in reach: with a controller the camera turns
   * a little slower there (Settings > Controls > Aim slowdown). Set by the fight.
   */
  aimFriction = false;
  /** Controller buttons pressed this frame. */
  private padPressed = 0;
  private lastLook = 0;
  /** Seconds the right stick has been held hard over, for the turn that speeds up. */
  private fullFor = 0;
  private readonly look = { yaw: 0, pitch: 0 };

  constructor(element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      // the settings menu is over the game (or waiting for a key to bind)
      if (keyGate.blocked) return;
      // Tab is the scoreboard, never focus navigation: a held Tab's repeats would
      // otherwise land focus on the quality picker, where M or H then changes quality.
      // In play, a bound key does only its game action (Space would scroll, / or ' open
      // Firefox's quick find); with Ctrl, Alt or Cmd held the browser keeps it (Ctrl+R).
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.code === 'Tab' || (this.locked && plain && (e.code === 'Space' || actionForCode(e.code)))) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    element.addEventListener('mousedown', (e) => {
      this.buttons |= 1 << e.button;
      // a click shorter than a frame still counts once: wasPressed('Mouse0')
      this.pressed.add(`Mouse${e.button}`);
      if (!this.locked) element.requestPointerLock?.();
    });
    window.addEventListener('mouseup', (e) => (this.buttons &= ~(1 << e.button)));
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      if (this.capture) {
        this.capture.x += e.movementX;
        this.capture.y += e.movementY;
        return;
      }
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    element.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
    });
  }

  /** A raw key code (or 'Mouse0'…) held down. Gameplay should ask `actionDown` instead. */
  isDown(code: string): boolean {
    if (code.startsWith('Mouse')) return this.isMouseDown(Number(code.slice(5)));
    return this.keys.has(code);
  }

  /** True once per physical key press (or mouse click, as 'Mouse0', 'Mouse2'…). Cleared by `endFrame`. */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  isMouseDown(button = 0): boolean {
    return (this.buttons & (1 << button)) !== 0;
  }

  /** Playing with the mouse captured, or with a controller: game input counts. */
  get engaged(): boolean {
    return this.locked || pad.active;
  }

  /** Either input bound to the action is held (or its controller button). */
  actionDown(a: Action): boolean {
    const [p, s] = codesFor(a);
    return (p !== null && this.isDown(p)) || (s !== null && this.isDown(s)) || (!pad.menuMode && pad.held(padCodeFor(a)));
  }

  /** Either input bound to the action went down this frame (or its controller button). */
  actionPressed(a: Action): boolean {
    const [p, s] = codesFor(a);
    return (p !== null && this.pressed.has(p)) || (s !== null && this.pressed.has(s)) || (this.padPressed & this.padBit(a)) !== 0;
  }

  /** Only the controller's button for the action went down this frame. */
  padActionPressed(a: Action): boolean {
    return (this.padPressed & this.padBit(a)) !== 0;
  }

  /**
   * Use up this frame's press of an action, so another action sharing its
   * controller button (a mode pick on the D-pad) doesn't fire as well.
   */
  consume(a: Action): void {
    for (const c of codesFor(a)) if (c) this.pressed.delete(c);
    this.padPressed &= ~this.padBit(a);
  }

  private padBit(a: Action): number {
    const c = padCodeFor(a);
    return c ? 1 << Number(c.slice(3)) : 0;
  }

  /** The first of `actions` pressed this frame, as its index, or -1. */
  pressedIndex(actions: readonly Action[]): number {
    for (let i = 0; i < actions.length; i++) if (this.actionPressed(actions[i]!)) return i;
    return -1;
  }

  /**
   * WASD (or whatever moves) as forward and right, each -1, 0 or 1; or the
   * left stick's way, at full length: any tilt past the dead zone runs, so a
   * controller is never slower than the keys.
   */
  moveAxes(): { forward: number; right: number } {
    const l = pad.left;
    if (!pad.menuMode && (l.x || l.y)) {
      const m = Math.hypot(l.x, l.y);
      return { forward: -l.y / m, right: l.x / m };
    }
    return {
      forward: (this.actionDown('forward') ? 1 : 0) - (this.actionDown('back') ? 1 : 0),
      right: (this.actionDown('right') ? 1 : 0) - (this.actionDown('left') ? 1 : 0),
    };
  }

  /** Each frame first: read the controller and take its presses for this frame. */
  beginFrame(): void {
    pad.poll();
    this.padPressed = pad.menuMode || keyGate.blocked ? 0 : pad.gameLatch;
    pad.gameLatch = 0;
  }

  /**
   * The right stick's turn this frame, radians (reused object). A curve keeps
   * small moves fine, holding it hard over speeds the turn up for a quick
   * about-face, and over an enemy in reach it slows a little. While the ping
   * wheel is up the stick points at a call instead.
   */
  padLook(): { yaw: number; pitch: number } {
    const now = performance.now();
    const dt = this.lastLook ? Math.min(0.05, (now - this.lastLook) / 1000) : 0;
    this.lastLook = now;
    const out = this.look;
    out.yaw = 0;
    out.pitch = 0;
    const { x, y } = pad.right;
    const m = Math.hypot(x, y);
    if (pad.menuMode || keyGate.blocked || !m) {
      this.fullFor = 0;
      return out;
    }
    if (this.capture) {
      this.capture.x = x * WHEEL_REACH;
      this.capture.y = y * WHEEL_REACH;
      return out;
    }
    const s = settings();
    const curve = m ** 0.75; // (x, y) * m^0.75: magnitude m^1.75
    this.fullFor = Math.abs(x) > 0.9 ? this.fullFor + dt : 0;
    const boost = 1 + Math.min(1, Math.max(0, (this.fullFor - 0.2) / 0.35)) * 0.75;
    const slow = this.aimFriction && s.aimSlowdown ? 0.6 : 1;
    out.yaw = x * curve * 3.4 * s.padSensitivity * boost * slow * dt;
    out.pitch = y * curve * 2.0 * s.padSensitivity * slow * dt * (s.padInvertY ? -1 : 1);
    return out;
  }

  consumeMouseDelta(): { x: number; y: number } {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  endFrame(): void {
    this.pressed.clear();
    this.padPressed = 0;
    // nothing stays held under the settings menu
    if (keyGate.blocked) this.keys.clear();
  }
}
