import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { CollisionWorld } from '../scene/Collision';
import { Temple } from '../scene/Temple';
import { RUSH } from './Rush';
import { rushTestWorld } from './rushTestField';

type Collider = CollisionWorld['colliders'][number];

/** The temple's colliders on the Relic Rush pitch, built without its looks (any material will do) on flat ground. */
async function temple(): Promise<CollisionWorld> {
  const mat = new THREE.MeshStandardNodeMaterial();
  const mats = new Proxy({}, { get: () => mat }) as never;
  const terrain = { heightAt: () => 0, maskAt: () => ({ dirt: 0, paved: 0 }) } as never;
  const world = new CollisionWorld(() => 0);
  await Temple.create(mats, terrain, world);
  return world;
}

const onPitch = (c: Collider) => Math.hypot(c.x, c.z) < RUSH.pitchRadius + 2;
// boulders go where the terrain's ground cover lets them (the flat stand-in ground has none), so only the rest must match
const boulder = (c: Collider) => c.kind === 'circle' && Math.hypot(c.x, c.z) >= 24 && !(Math.abs(c.x) < 9 && Math.abs(c.z) > 18);
const key = (c: Collider) => `${c.kind} ${c.x.toFixed(2)},${c.z.toFixed(2)}`;
const shape = (c: Collider, w: CollisionWorld) => {
  const top = Number.isFinite(c.top) ? +(c.top - w.groundAt(c.x, c.z)).toFixed(1) : 'none';
  return c.kind === 'circle' ? `r ${c.r.toFixed(2)} top ${top}` : `${c.hx.toFixed(2)} x ${c.hz.toFixed(2)} turned ${c.yaw.toFixed(2)} top ${top}`;
};

describe('the headless Relic Rush pitch', () => {
  it('has every column, brazier, pillar and wall the temple puts on the pitch, as big and as tall', async () => {
    const real = await temple();
    const field = rushTestWorld();
    const list = (w: CollisionWorld) => Object.fromEntries(w.colliders.filter((c) => onPitch(c) && !boulder(c)).map((c) => [key(c), shape(c, w)]));
    expect(list(field)).toEqual(list(real));
  });

  it('stands its boulders only on the pitch’s outer ring, where the temple scatters them', () => {
    const field = rushTestWorld();
    const stones = field.colliders.filter(boulder);
    expect(stones.length).toBeGreaterThan(4);
    for (const c of stones) expect(Math.hypot(c.x, c.z)).toBeLessThan(RUSH.pitchRadius + 2);
  });
});
