import type { Action } from '../settings/bindings';
import { actionForCode, codesFor, keyGate } from '../settings/store';

/**
 * Keyboard and mouse state. Mouse look uses pointer lock, so `consumeMouseDelta`
 * returns raw movement since the last call. Keys are tracked by `KeyboardEvent.code`
 * so the layout (WASD on AZERTY etc.) stays physical. Gameplay asks about
 * actions (`actionDown('forward')`), which go through the player's bindings
 * (src/settings/bindings.ts); mouse buttons count as the codes 'Mouse0'..'Mouse4'.
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

  /** Either input bound to the action is held. */
  actionDown(a: Action): boolean {
    const [p, s] = codesFor(a);
    return (p !== null && this.isDown(p)) || (s !== null && this.isDown(s));
  }

  /** Either input bound to the action went down this frame. */
  actionPressed(a: Action): boolean {
    const [p, s] = codesFor(a);
    return (p !== null && this.pressed.has(p)) || (s !== null && this.pressed.has(s));
  }

  /** The first of `actions` pressed this frame, as its index, or -1. */
  pressedIndex(actions: readonly Action[]): number {
    for (let i = 0; i < actions.length; i++) if (this.actionPressed(actions[i]!)) return i;
    return -1;
  }

  /** WASD (or whatever moves) as forward and right, each -1, 0 or 1. */
  moveAxes(): { forward: number; right: number } {
    return {
      forward: (this.actionDown('forward') ? 1 : 0) - (this.actionDown('back') ? 1 : 0),
      right: (this.actionDown('right') ? 1 : 0) - (this.actionDown('left') ? 1 : 0),
    };
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
    // nothing stays held under the settings menu
    if (keyGate.blocked) this.keys.clear();
  }
}
