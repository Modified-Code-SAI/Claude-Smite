import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { Document } from '@gltf-transform/core';
import { compressGlb, readGlb } from '../../scripts/meshopt.mjs';

const DIR = 'public/models/gods/';

const near = (v: readonly number[]) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);

/**
 * A triangle list with each triangle turned to start at its smallest vertex:
 * meshopt's index codec may rotate a triangle's vertices (same triangle, same
 * winding), and nothing in the game depends on which vertex comes first.
 */
function triangles(a: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 3) {
    const t = [a[i]!, a[i + 1]!, a[i + 2]!];
    const k = t.indexOf(Math.min(...t));
    out.push(t[k]!, t[(k + 1) % 3]!, t[(k + 2) % 3]!);
  }
  return out;
}

/** Every accessor's data, in document order, plus what the game reads besides geometry. */
function contents(doc: Document) {
  const root = doc.getRoot();
  const indices = new Set(root.listMeshes().flatMap((m) => m.listPrimitives().map((p) => p.getIndices())));
  return {
    accessors: root.listAccessors().map((a) => {
      const array = Array.from(a.getArray() ?? []);
      return { type: a.getType(), normalized: a.getNormalized(), array: indices.has(a) ? triangles(array) : array };
    }),
    meshes: root.listMeshes().map((m) => ({ name: m.getName(), prims: m.listPrimitives().map((p) => p.listSemantics()) })),
    // (a transform within 1e-6 of the identity is written as the identity)
    nodes: root.listNodes().map((n) => ({ name: n.getName(), extras: n.getExtras(), t: near(n.getTranslation()), r: near(n.getRotation()), s: near(n.getScale()) })),
    skins: root.listSkins().map((s) => s.listJoints().map((j) => j.getName())),
    animations: root.listAnimations().map((a) => a.getName()),
    materials: root.listMaterials().map((m) => m.getName()),
  };
}

describe('compressed god models', () => {
  // the shared clips and one god cover animations, skins, custom attributes and extras
  for (const file of ['clips.glb', 'thor.glb']) {
    test(`${file} decodes to the data it was built with, in about half the bytes`, async () => {
      const raw = new Uint8Array(readFileSync(`${DIR}${file}`));
      const packed = await compressGlb(raw);
      expect(packed.length).toBeLessThan(raw.length * 0.85);
      const [a, b] = await Promise.all([readGlb(raw), readGlb(packed)]);
      expect(contents(b)).toEqual(contents(a));
      // compressing twice changes nothing
      expect(await compressGlb(packed)).toBe(packed);
    }, 60_000);
  }

  test('every model the game loads is a GLB in the folder the build compresses', () => {
    const files = readdirSync(DIR);
    expect(files).toContain('clips.glb');
    expect(files.every((f) => f.endsWith('.glb'))).toBe(true);
  });
});
