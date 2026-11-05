import { Arena } from '../scene/ArenaLayout';
import { CollisionWorld } from '../scene/Collision';
import { hypot } from '../core/math';
import { pitchTerrain, RUSH } from './Rush';
import type { SimTerrain } from './Sim';

/**
 * The temple plaza's collision without its meshes, for headless Relic Rush
 * matches (tests and bot tuning): the raised platform and its steps, the
 * column ring with its north and south gaps, the center pedestal, the two
 * gateways' pillars and the braziers behind them. Mirrors Temple.ts.
 */
export function rushTestField(): SimTerrain {
  const p = Arena.plaza;
  const world = new CollisionWorld(() => 0);
  world.addSurface((x, z) => {
    const r = hypot(x, z);
    if (r <= p.radius) return p.topY;
    const step = Math.ceil((r - p.radius) / p.stepDepth);
    return step <= p.stepCount ? p.topY - step * p.stepHeight : null;
  });
  const R = p.columnRadius;
  for (let i = 0; i < p.columnCount; i++) {
    const a = (i / p.columnCount) * Math.PI * 2 + Math.PI / p.columnCount;
    if (Math.abs(Math.cos(a)) < 0.12) continue;
    world.addCircle(Math.cos(a) * p.columnRing, Math.sin(a) * p.columnRing, R * 1.35);
  }
  world.addSurface((x, z) => (hypot(x, z) < 2.9 ? p.topY + 0.5 : hypot(x, z) < 3.6 ? p.topY + 0.22 : null));
  world.addCircle(0, 0, 0.95);
  for (const side of [-1, 1]) {
    const gz = side * RUSH.gates.order.z;
    for (const sx of [-1, 1]) {
      world.addBox(sx * 5.4, gz, 1, 1, 0);
      world.addCircle(sx * 4.45, side * (p.baseRadius + 7.5), 0.75);
    }
  }
  return pitchTerrain(world);
}
