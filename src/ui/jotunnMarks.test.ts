import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { toScreen } from '../combat/screenEdge';
import { CLUSTER, clearOfHud, clusterBraziers, pickMarks, STACK, stackMarks, THREAT_HIT, TOP_CLEAR, type MarkScene, type Stackable } from './JotunnMarks';

const W = 1600;
const H = 900;

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(58, W / H, 0.1, 1000);
  cam.position.set(0, 2, 10);
  cam.lookAt(0, 2, 0);
  cam.updateMatrixWorld();
  return cam;
}

describe('screen edge', () => {
  it('puts a point in view on its spot', () => {
    const p = toScreen(new THREE.Vector3(0, 2, 0), camera(), W, H);
    expect(p.edge).toBe(false);
    expect(p.x).toBeCloseTo(W / 2, 3);
    expect(p.y).toBeCloseTo(H / 2, 3);
  });

  it('pins a point far to the right to the right edge, pointing right', () => {
    const p = toScreen(new THREE.Vector3(80, 2, 0), camera(), W, H);
    expect(p.edge).toBe(true);
    expect(p.x).toBeCloseTo(((0.92 + 1) / 2) * W, 1);
    expect(Math.abs(p.angle)).toBeLessThan(0.1);
  });

  it('pins a point behind the camera to the side it lies on', () => {
    const left = toScreen(new THREE.Vector3(-3, 2, 30), camera(), W, H);
    const right = toScreen(new THREE.Vector3(3, 2, 30), camera(), W, H);
    expect(left.edge && right.edge).toBe(true);
    expect(left.x).toBeLessThan(W / 2);
    expect(right.x).toBeGreaterThan(W / 2);
  });
});

function scene(o: Partial<MarkScene> = {}): MarkScene {
  return {
    piloting: false,
    phase: 'fight',
    cine: false,
    giant: { x: 0, y: 9, z: -40, alive: true },
    braziers: [
      { x: 7, y: 3, z: 7, alive: true, hitAgo: 99 },
      { x: -7, y: 3, z: 7, alive: true, hitAgo: 99 },
      { x: -7, y: 3, z: -7, alive: true, hitAgo: 99 },
      { x: 7, y: 3, z: -7, alive: false, hitAgo: 99 },
    ],
    shrines: [
      { x: 0, y: 8, z: -46, ready: true, contested: false, ult: 'Frost Breath' },
      { x: -42, y: 8, z: 2, ready: false, contested: false, ult: 'Avalanche' },
      { x: 44, y: 8, z: -3, ready: true, contested: true, ult: 'Hailstorm' },
    ],
    ...o,
  };
}

describe('Jötunn marks', () => {
  it('shows the giant every lit brazier, the nearest to smash, and the shrines it can claim', () => {
    const m = pickMarks(scene({ piloting: true, giant: { x: -10, y: 9, z: -12, alive: true } }));
    expect(m.filter((k) => k.kind === 'smash').map((k) => [k.key, k.label])).toEqual([
      ['b0', ''],
      ['b1', ''],
      ['b2', 'Smash'],
    ]);
    expect(m.filter((k) => k.kind === 'shrine').map((k) => [k.key, k.label])).toEqual([
      ['s0', 'Frost Breath'],
      ['s2', 'Held'],
    ]);
    expect(m.some((k) => k.kind === 'giant' || k.kind === 'defend')).toBe(false);
  });

  it('shows a god the giant (when out of view) and calls them to the brazier it closes on or strikes', () => {
    const far = pickMarks(scene());
    expect(far.map((k) => k.kind)).toEqual(['giant']);
    expect(far[0]!.edgeOnly).toBe(true);
    const close = pickMarks(scene({ giant: { x: -12, y: 9, z: -12, alive: true } }));
    expect(close.filter((k) => k.kind === 'defend').map((k) => k.key)).toEqual(['b2']);
    const struck = scene();
    struck.braziers = struck.braziers.map((b, i) => (i === 0 ? { ...b, hitAgo: THREAT_HIT - 1 } : b));
    expect(pickMarks(struck).filter((k) => k.kind === 'defend').map((k) => [k.key, k.label])).toEqual([['b0', 'Defend']]);
  });

  it('shows nothing during a camera shot, between rounds, or once the giant falls', () => {
    expect(pickMarks(scene({ cine: true }))).toEqual([]);
    expect(pickMarks(scene({ phase: 'over' }))).toEqual([]);
    expect(pickMarks(scene({ phase: 'countdown' }))).toEqual([]);
    expect(pickMarks(scene({ giant: { x: 0, y: 9, z: -40, alive: false } }))).toEqual([]);
    // the giant gets its bearings in the countdown
    expect(pickMarks(scene({ phase: 'countdown', piloting: true })).length).toBeGreaterThan(0);
  });
});

describe('Jötunn marks and the HUD', () => {
  it('fades a mark under the Might bar or over the aim, and moves an edge mark out from under the bar', () => {
    expect(clearOfHud({ x: W / 2 + 100, y: 60, edge: false, angle: 0 }, W, H)).toBe(true);
    expect(clearOfHud({ x: W / 2 + 10, y: H / 2 - 20, edge: false, angle: 0 }, W, H)).toBe(true);
    expect(clearOfHud({ x: 120, y: 60, edge: false, angle: 0 }, W, H)).toBe(false);
    expect(clearOfHud({ x: W / 2 + 300, y: H / 2 + 200, edge: false, angle: 0 }, W, H)).toBe(false);
    const pinned = { x: W / 2 - 50, y: 0.1 * H, edge: true, angle: -1.5 };
    expect(clearOfHud(pinned, W, H)).toBe(false);
    expect(pinned.y).toBe(TOP_CLEAR);
    const side = { x: 0.04 * W, y: 0.1 * H, edge: true, angle: -2.5 };
    clearOfHud(side, W, H);
    expect(side.y).toBe(0.1 * H);
  });
});

describe('Jötunn marks from afar', () => {
  it('shows the giant its braziers as one mark on the temple while it is far off', () => {
    const m = pickMarks(scene({ piloting: true, clustered: true }));
    const smash = m.filter((k) => k.kind === 'smash');
    expect(smash.map((k) => [k.key, k.label])).toEqual([['bc', 'Smash']]);
    // in the middle of the lit ones (the fourth is out)
    expect(smash[0]!.x).toBeCloseTo(-7 / 3, 5);
    expect(smash[0]!.z).toBeCloseTo(7 / 3, 5);
    // the shrines still show on their own
    expect(m.filter((k) => k.kind === 'shrine').length).toBe(2);
  });

  it('joins and splits the braziers with some slack, so they never flicker on the line', () => {
    expect(clusterBraziers(false, CLUSTER.join + 1)).toBe(true);
    expect(clusterBraziers(false, CLUSTER.join - 1)).toBe(false);
    const between = (CLUSTER.join + CLUSTER.split) / 2;
    expect(clusterBraziers(true, between)).toBe(true);
    expect(clusterBraziers(false, between)).toBe(false);
    expect(clusterBraziers(true, CLUSTER.split - 1)).toBe(false);
    // none lit: nothing to join
    expect(clusterBraziers(false, Infinity)).toBe(true);
  });
});

describe('Jötunn marks stacking', () => {
  const mark = (tx: number, ty: number, meters: number): Stackable => ({ tx, ty, meters, lift: 0 });

  it('leaves marks apart where they are', () => {
    const a = mark(100, 300, 20);
    const b = mark(100 + STACK.w + 1, 300, 30);
    stackMarks([a, b]);
    expect([a.lift, b.lift]).toEqual([0, 0]);
  });

  it('lifts the farther of two marks on one another to just above the nearer', () => {
    const near = mark(400, 300, 18);
    const far = mark(410, 290, 58);
    stackMarks([far, near]);
    expect(near.lift).toBe(0);
    expect(far.ty + far.lift).toBe(300 - STACK.h);
  });

  it('stacks a pile of marks into a column, none covering another', () => {
    const items = [mark(400, 300, 50), mark(405, 296, 10), mark(398, 305, 30), mark(402, 250, 40)];
    stackMarks(items);
    const ys = items.map((k) => k.ty + k.lift);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const apart = Math.abs(items[i]!.tx - items[j]!.tx) >= STACK.w || Math.abs(ys[i]! - ys[j]!) >= STACK.h - 1e-9;
        expect(apart).toBe(true);
      }
    }
    // nearest first, and it never moves
    expect(items[0]!.meters).toBe(10);
    expect(items[0]!.lift).toBe(0);
  });
});
