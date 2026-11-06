import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { FrostPrints, PRINTS } from './frostPrints';

const ground = (x: number, z: number) => 0.5 + x * 0.01 + z * 0.02;
const VERTS = 16;

function slot(p: FrostPrints, s: number) {
  const pos = p.mesh.geometry.getAttribute('position').array as Float32Array;
  const info = p.mesh.geometry.getAttribute('pInfo').array as Float32Array;
  const pts: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < VERTS; i++) {
    const o = s * VERTS + i;
    pts.push({ x: pos[o * 3]!, y: pos[o * 3 + 1]!, z: pos[o * 3 + 2]! });
  }
  const mid = pts.reduce((a, b) => ({ x: a.x + b.x / VERTS, y: 0, z: a.z + b.z / VERTS }), { x: 0, y: 0, z: 0 });
  return { pts, mid, kind: info[s * VERTS * 3]!, birth: info[s * VERTS * 3 + 1]! };
}

describe('frost prints', () => {
  it('draws nothing until a print is laid', () => {
    const p = new FrostPrints(ground);
    const pos = p.mesh.geometry.getAttribute('position').array as Float32Array;
    expect(pos.every((v) => v === 0)).toBe(true);
    expect(p.mesh.geometry.index!.count).toBe(PRINTS.capacity * 9 * 6);
  });

  it('lays a footprint ahead of the ankle, along the way the giant faces, on the ground', () => {
    const p = new FrostPrints(ground);
    p.update(3);
    // facing -z (yaw 0): the print's middle sits ahead of the ankle, toward -z
    p.foot(new THREE.Vector3(10, 4, 20), 0, 'footL');
    const s = slot(p, 0);
    expect(s.mid.x).toBeCloseTo(10, 5);
    expect(s.mid.z).toBeCloseTo(20 - PRINTS.foot.ahead, 5);
    const zs = s.pts.map((q) => q.z);
    const xs = s.pts.map((q) => q.x);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(PRINTS.foot.length, 5);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(PRINTS.foot.width, 5);
    for (const q of s.pts) expect(q.y).toBeCloseTo(ground(q.x, q.z) + PRINTS.lift, 5);
    expect(s.kind).toBe(0);
    expect(s.birth).toBe(3);
    // the right foot, facing east: ahead is +x
    p.foot(new THREE.Vector3(0, 0, 0), -Math.PI / 2, 'footR');
    const r = slot(p, 1);
    expect(r.mid.x).toBeCloseTo(PRINTS.foot.ahead, 5);
    expect(r.kind).toBe(1);
  });

  it('faces up, so it is seen from above', () => {
    const p = new FrostPrints(ground);
    p.foot(new THREE.Vector3(0, 0, 0), 0.7, 'footL');
    const pos = p.mesh.geometry.getAttribute('position');
    const idx = p.mesh.geometry.index!;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < 18; t++) {
      a.fromBufferAttribute(pos, idx.getX(t * 3));
      b.fromBufferAttribute(pos, idx.getX(t * 3 + 1));
      c.fromBufferAttribute(pos, idx.getX(t * 3 + 2));
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      expect(n.y).toBeGreaterThan(0);
    }
  });

  it('spreads a blow round where it struck, and makes room by replacing the oldest', () => {
    const p = new FrostPrints(ground);
    p.blow(-4, 6, 3);
    const s = slot(p, 0);
    expect(s.mid.x).toBeCloseTo(-4, 5);
    expect(s.mid.z).toBeCloseTo(6, 5);
    expect(s.kind).toBe(2);
    for (const q of s.pts) expect(Math.hypot(q.x + 4, q.z - 6)).toBeLessThanOrEqual(3 * Math.SQRT2 + 1e-5);
    for (let i = 1; i < PRINTS.capacity; i++) p.blow(50, 50, 1);
    p.update(1);
    p.foot(new THREE.Vector3(30, 0, 30), 0, 'footL');
    // the first slot is the one taken again
    expect(slot(p, 0).mid.x).toBeCloseTo(30, 5);
    expect(slot(p, 0).birth).toBe(1);
  });
});
