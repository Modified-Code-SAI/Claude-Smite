import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import { buildLods, buildPieceLods, LOD_ERROR, LOD_MAX_PX, lodsOf, lodView, mergeLods, pickLod } from './lod';
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';

describe('distance levels of detail', () => {
  test('draws the coarsest level whose error stays under the pixel budget', () => {
    // close: even the finest simplified level would show
    expect(pickLod(LOD_MAX_PX / LOD_ERROR[1] * 2, 0)).toBe(0);
    // far: everything fits
    expect(pickLod(1, 0)).toBe(LOD_ERROR.length - 1);
    // just inside level 2's budget with room to spare
    expect(pickLod((LOD_MAX_PX * 0.8) / LOD_ERROR[2], 0)).toBe(2);
  });

  test('holds a level near its boundary instead of flickering', () => {
    const edge = LOD_MAX_PX / LOD_ERROR[2];
    // at the boundary, a model at level 1 stays there and one at level 2 stays there too
    expect(pickLod(edge, 1)).toBe(1);
    expect(pickLod(edge, 2)).toBe(2);
    // well past it, both agree
    expect(pickLod(edge * 1.3, 2)).toBe(1);
    expect(pickLod(edge * 0.7, 1)).toBe(2);
  });

  test('simplifies a dense piece into ever coarser levels that stay within its error', async () => {
    await MeshoptSimplifier.ready;
    const g = new THREE.SphereGeometry(0.3, 96, 64);
    buildPieceLods(g);
    const lods = lodsOf(g)!;
    expect(lods).toHaveLength(LOD_ERROR.length - 1);
    let prev = g.index!.count;
    for (const l of lods) {
      expect(l.length % 3).toBe(0);
      expect(l.length).toBeLessThanOrEqual(prev);
      prev = l.length;
    }
    expect(lods[2]!.length).toBeLessThan(g.index!.count * 0.5);
    // every vertex a coarse level keeps is still on the sphere (the mesh moves inward between vertices, never off them)
    const p = g.getAttribute('position');
    for (const i of lods[2]!) expect(Math.abs(Math.hypot(p.getX(i), p.getY(i), p.getZ(i)) - 0.3)).toBeLessThan(1e-5);
  });

  test('keeps small pieces whole', async () => {
    await MeshoptSimplifier.ready;
    const g = new THREE.BoxGeometry(1, 1, 1);
    buildPieceLods(g);
    for (const l of lodsOf(g)!) expect(l.length).toBe(g.index!.count);
  });

  test('merged pieces keep their levels, offset by the vertices before them', async () => {
    const a = new THREE.SphereGeometry(0.2, 48, 32);
    const b = new THREE.SphereGeometry(0.2, 48, 32).translate(1, 0, 0);
    const root = new THREE.Group();
    root.add(new THREE.Mesh(a), new THREE.Mesh(b));
    await buildLods(root);
    const merged = mergeLods([a, b])!;
    const n = a.getAttribute('position').count;
    for (let level = 0; level < merged.length; level++) {
      const la = lodsOf(a)![level]!;
      const lb = lodsOf(b)![level]!;
      expect(merged[level]!.length).toBe(la.length + lb.length);
      expect(merged[level]![0]).toBe(la[0]);
      expect(merged[level]![la.length]).toBe(lb[0]! + n);
    }
    expect(mergeLods([a, new THREE.SphereGeometry()])).toBeUndefined();
  });

  test('a model view shares the vertices and draws one level as a range of one index buffer', async () => {
    await MeshoptSimplifier.ready;
    const g = new THREE.SphereGeometry(0.3, 64, 48);
    g.computeBoundingSphere();
    buildPieceLods(g);
    const v1 = lodView(g)!;
    const v2 = lodView(g)!;
    expect(v1.geometry.getAttribute('position')).toBe(g.getAttribute('position'));
    expect(v1.geometry.index).toBe(v2.geometry.index);
    expect(v1.ranges).toHaveLength(LOD_ERROR.length);
    expect(v1.ranges[0]).toEqual({ start: 0, count: g.index!.count });
    expect(v1.geometry.drawRange).toEqual({ start: 0, count: g.index!.count });
    const idx = v1.geometry.index!.array;
    const r = v1.ranges[2]!;
    const lod = lodsOf(g)![1]!;
    expect(r.count).toBe(lod.length);
    for (let k = 0; k < r.count; k++) expect(idx[r.start + k]).toBe(lod[k]);
    // each model's range is its own
    v1.geometry.setDrawRange(r.start, r.count);
    expect(v2.geometry.drawRange.start).toBe(0);
    expect(lodView(new THREE.SphereGeometry())).toBeNull();
  });
});
