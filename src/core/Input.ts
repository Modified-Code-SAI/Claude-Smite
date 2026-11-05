/**
 * Keyboard and mouse state. Mouse look uses pointer lock, so `consumeMouseDelta`
 * returns raw movement since the last call. Keys are tracked by `KeyboardEvent.code`
 * so the layout (WASD on AZERTY etc.) stays physical.
 */
export class Input {
  private readonly down = new Set<string>();
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
      // Tab is the scoreboard, never focus navigation: a held Tab's repeats would
      // otherwise land focus on the quality picker, where M or H then changes quality
      if (e.code === 'Tab' || (this.locked && e.code === 'Space')) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
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

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True once per physical key press (or mouse click, as 'Mouse0', 'Mouse2'…). Cleared by `endFrame`. */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  isMouseDown(button = 0): boolean {
    return (this.buttons & (1 << button)) !== 0;
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
  }
}
