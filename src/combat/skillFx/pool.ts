import type * as THREE from 'three/webgpu';

/** Recycles effect objects so nothing is created (or compiled) mid-fight. */
export class Pool<T extends { group: THREE.Object3D }> {
  private readonly free: T[] = [];
  constructor(
    private readonly parent: THREE.Object3D,
    private readonly make: () => T,
    warm: number,
  ) {
    for (let i = 0; i < warm; i++) this.release(this.make());
  }

  take(): T {
    const t = this.free.pop() ?? this.make();
    this.parent.add(t.group);
    t.group.visible = true;
    return t;
  }

  release(t: T): void {
    t.group.visible = false;
    this.parent.remove(t.group);
    this.free.push(t);
  }

  /** Shows every idle object, all of its parts, until the returned function puts them away again. */
  prime(): () => void {
    const flipped: THREE.Object3D[] = [];
    const shown = [...this.free];
    for (const t of shown) {
      this.parent.add(t.group);
      t.group.traverse((o) => {
        if (o.visible) return;
        o.visible = true;
        flipped.push(o);
      });
    }
    return () => {
      for (const o of flipped) o.visible = !o.visible;
      for (const t of shown) this.parent.remove(t.group);
    };
  }
}

/** A running effect: `update` returns false once it is done and can go back to its pool. */
export interface Live {
  readonly group: THREE.Object3D;
  /** Counts the times it was started from its pool, so a holder can tell its run from a later one. */
  gen?: number;
  update(dt: number, t: number): boolean;
}

/**
 * The effects of one kind that are playing: each frame updates them and
 * returns the finished ones to the pool. Iterates without allocating.
 */
export class Running<T extends Live> {
  readonly list: T[] = [];
  constructor(readonly pool: Pool<T>) {}

  start(): T {
    const t = this.pool.take();
    t.gen = (t.gen ?? 0) + 1;
    this.list.push(t);
    return t;
  }

  update(dt: number, t: number): void {
    const l = this.list;
    for (let i = l.length - 1; i >= 0; i--) {
      const fx = l[i]!;
      if (fx.update(dt, t)) continue;
      l[i] = l[l.length - 1]!;
      l.pop();
      this.pool.release(fx);
    }
  }
}
