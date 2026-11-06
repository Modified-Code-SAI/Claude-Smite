import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { GroundDecal } from './GroundDecal';

const attr = (d: GroundDecal, name: string) => d.mesh.geometry.getAttribute(name) as THREE.BufferAttribute;

describe('GroundDecal', () => {
  it('conforms a shape to the ground, and leaves it be when placed again on the same spot', () => {
    let floor = 1;
    const d = new GroundDecal(() => floor);
    d.place({ type: 'circle', radius: 2 }, 2, 3, 0);
    const pos = attr(d, 'position');
    // the first vertex is the center, the first of the outer row straight out along +z
    expect(Array.from(pos.array.slice(0, 3))).toEqual([2, Math.fround(1.07), 3]);
    const outer = (pos.count - 33) * 3;
    expect(pos.array[outer]).toBeCloseTo(2, 5);
    expect(pos.array[outer + 2]).toBeCloseTo(5, 5);
    const version = pos.version;
    // every frame with the same arguments: nothing conformed or uploaded again
    d.place({ type: 'circle', radius: 2 }, 2, 3, 0);
    expect(attr(d, 'position').version).toBe(version);
    // the ground rising under it does conform it again
    floor = 1.5;
    d.place({ type: 'circle', radius: 2 }, 2, 3, 0);
    expect(attr(d, 'position').version).toBeGreaterThan(version);
    expect(pos.array[1]).toBeCloseTo(1.57, 5);
  });

  it('resizes on the same grid without new attributes, and builds new ones for a new grid', () => {
    const d = new GroundDecal(() => 0);
    d.place({ type: 'circle', radius: 2 }, 0, 0, 0);
    const edge = attr(d, 'edge');
    const index = d.mesh.geometry.index;
    // a little bigger: the same 32 x 4 grid, only the vertices move
    d.place({ type: 'circle', radius: 2.5 }, 0, 0, 0);
    expect(attr(d, 'edge')).toBe(edge);
    expect(d.mesh.geometry.index).toBe(index);
    const pos = attr(d, 'position');
    expect(pos.array[(pos.count - 33) * 3 + 2]).toBeCloseTo(2.5, 5);
    // much bigger: a finer grid
    d.place({ type: 'circle', radius: 6 }, 0, 0, 0);
    expect(attr(d, 'edge')).not.toBe(edge);
    expect(attr(d, 'position').count).toBe(61 * 9);
    expect(d.mesh.geometry.index!.count).toBe(60 * 8 * 6);
    // and a cone after it faces -z at yaw 0
    d.place({ type: 'cone', range: 5, angle: 48 }, 0, 0, 0);
    const cone = attr(d, 'position');
    const mid = (cone.count - 1 - 6) * 3;
    expect(cone.array[mid]).toBeCloseTo(0, 5);
    expect(cone.array[mid + 2]).toBeCloseTo(-5, 5);
  });
});
