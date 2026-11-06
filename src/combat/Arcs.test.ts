import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { ArcView } from './Arcs';

const inside = (a: ArcView) => a as unknown as { pos: Float32Array; heat: Float32Array; segments: number; geometry: THREE.BufferGeometry };
/** Center of a segment's first ribbon at its start (end = false) or its end. */
function center(a: ArcView, s: number, end: boolean): THREE.Vector3 {
  const p = inside(a).pos;
  const o = s * 24 + (end ? 6 : 0);
  return new THREE.Vector3((p[o]! + p[o + 3]!) / 2, (p[o + 1]! + p[o + 4]!) / 2, (p[o + 2]! + p[o + 5]!) / 2);
}

describe('ArcView', () => {
  it('runs a joined bolt from a to b, with crossed ribbons as wide as asked', () => {
    const arc = new ArcView();
    const a = new THREE.Vector3(1, 2, 3);
    const b = new THREE.Vector3(9, 1, -4);
    arc.bolt(a, b, 0.4);
    const { pos, segments, geometry } = inside(arc);
    expect(segments).toBeGreaterThan(8);
    expect(geometry.drawRange.count).toBe(segments * 12);
    expect(center(arc, 0, false).distanceTo(a)).toBeLessThan(1e-5);
    expect(center(arc, segments - 1, true).distanceTo(b)).toBeLessThan(1e-5);
    for (let s = 1; s < segments; s++) expect(center(arc, s, false).distanceTo(center(arc, s - 1, true))).toBeLessThan(1e-5);
    // the first segment is full width: both ribbons w/2 to a side, square to the segment and to each other
    const d = center(arc, 0, true).sub(center(arc, 0, false));
    const p1 = new THREE.Vector3(pos[3]! - pos[0]!, pos[4]! - pos[1]!, pos[5]! - pos[2]!).multiplyScalar(0.5);
    const p2 = new THREE.Vector3(pos[15]! - pos[12]!, pos[16]! - pos[13]!, pos[17]! - pos[14]!).multiplyScalar(0.5);
    const taper = 1 - (1 / (segments + 1)) * 0.55;
    expect(p1.length()).toBeCloseTo(0.2 * taper, 5);
    expect(p2.length()).toBeCloseTo(0.2 * taper, 5);
    expect(Math.abs(p1.dot(d))).toBeLessThan(1e-5);
    expect(Math.abs(p2.dot(d))).toBeLessThan(1e-5);
    expect(Math.abs(p1.dot(p2))).toBeLessThan(1e-5);
  });

  it('keeps a straight-down strike visible, with forks that leave the trunk', () => {
    const arc = new ArcView();
    const top = new THREE.Vector3(0, 18, 0);
    const foot = new THREE.Vector3(0, 0.1, 0);
    arc.bolt(top, foot, 0.4, 0.12, 1);
    const trunk = inside(arc).segments;
    arc.clear();
    arc.strike(top, foot, 0.4, 3, 0.12);
    const { pos, segments } = inside(arc);
    expect(segments).toBeGreaterThan(trunk);
    for (let i = 0; i < segments * 24; i++) expect(Number.isFinite(pos[i])).toBe(true);
    // no ribbon collapses to a line on a near-vertical bolt
    expect(Math.hypot(pos[3]! - pos[0]!, pos[4]! - pos[1]!, pos[5]! - pos[2]!)).toBeGreaterThan(0.1);
  });

  it('uploads only the spans in use, through one reused range', () => {
    const arc = new ArcView();
    const position = inside(arc).geometry.getAttribute('position') as THREE.BufferAttribute;
    const heat = inside(arc).geometry.getAttribute('heat') as THREE.BufferAttribute;
    for (let i = 0; i < 5; i++) {
      arc.clear();
      arc.strike(new THREE.Vector3(i, 18, 0), new THREE.Vector3(i, 0, 2), 0.4, 3);
      const n = inside(arc).segments;
      expect(position.updateRanges).toHaveLength(1);
      expect(position.updateRanges[0]).toEqual({ start: 0, count: n * 24 });
      expect(heat.updateRanges[0]).toEqual({ start: 0, count: n * 8 });
    }
  });
});
