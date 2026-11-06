import { Arena } from '../scene/ArenaLayout';
import { CollisionWorld } from '../scene/Collision';
import { hypot } from '../core/math';
import { pitchTerrain, RUSH } from './Rush';
import type { SimTerrain } from './Sim';

/** The ruined columns (by place in the ring): how far their broken tops stand over the platform. The rest stand whole, and one has fallen. */
const BROKEN: Readonly<Record<number, number>> = { 4: 4.152, 5: 5.184, 6: 3.543, 8: 3.947, 9: 5.508 };
const INTACT = new Set([0, 1, 2, 11, 12, 13]);
/** The fallen column's drums, lying out over the steps: x, z, and the top of each over the ground there. */
const DRUMS: readonly [number, number, number][] = [[-15.223, -3.397, 2.2], [-16.634, -3.986, 2.2], [-18.278, -4.073, 1.88], [-19.666, -4.394, 1.24]];
/** The low lane walls inside the pitch, behind each gate: x, z, and height (they rise in one to three courses). */
const WALLS: readonly [number, number, number][] = [
  [-5.85, -29.6, 0.76], [-5.85, -31.15, 0.76], [-5.85, -32.7, 0.76], [5.85, -29.6, 2.28], [5.85, -31.15, 0.76], [5.85, -32.7, 2.28],
  [-5.85, 29.6, 1.52], [-5.85, 31.15, 0.76], [-5.85, 32.7, 1.52], [5.85, 29.6, 2.28], [5.85, 31.15, 0.76], [5.85, 32.7, 1.52],
];
/** Boulders on the pitch's outer ring as the game's terrain places them (it scatters them by its ground cover): x, z, radius, height. */
const BOULDERS: readonly [number, number, number, number][] = [
  [-28.71, 13.86, 0.91, 0.64], [-14.93, -19.39, 0.85, 0.6], [23.74, -16.63, 1.31, 0.92], [25.8, -1.73, 1.37, 0.97],
  [-19.61, -27.76, 0.99, 0.7], [-20.41, -13.27, 1.43, 1.01], [15.58, -26.5, 0.68, 0.48], [23.07, -12.63, 1.18, 0.83],
];

/**
 * The temple plaza's collision without its meshes, as Temple.ts builds it
 * (rushTestField.test.ts holds the two together): the raised platform and
 * its steps, the column ring with its north and south gaps (whole, broken
 * and fallen columns), the center pedestal on its dais, the braziers, the
 * two gateways' pillars, the south gate's fallen lintel, and the lane walls
 * and boulders at the pitch's edge. The ground off the platform is flat.
 */
export function rushTestWorld(): CollisionWorld {
  const p = Arena.plaza;
  const y0 = p.topY;
  const world = new CollisionWorld(() => 0);
  world.addSurface((x, z) => {
    const r = hypot(x, z);
    if (r > p.baseRadius) return null;
    return Math.min(p.stepCount, Math.floor((p.baseRadius - r) / p.stepDepth) + 1) * p.stepHeight;
  });
  const R = p.columnRadius;
  for (let i = 0; i < p.columnCount; i++) {
    const a = (i / p.columnCount) * Math.PI * 2 + Math.PI / p.columnCount;
    if (Math.abs(Math.cos(a)) < 0.12) continue;
    const x = Math.cos(a) * p.columnRing;
    const z = Math.sin(a) * p.columnRing;
    world.addCircle(x, z, R * 1.35, y0 + 0.6);
    if (INTACT.has(i)) world.addCircle(x, z, R * 1.1);
    else if (BROKEN[i] !== undefined) world.addCircle(x, z, R * 1.1, y0 + BROKEN[i]!);
  }
  for (const [x, z, top] of DRUMS) world.addCircle(x, z, R * 1.05, top);
  world.addSurface((x, z) => (hypot(x, z) < 2.9 ? y0 + 0.5 : hypot(x, z) < 3.6 ? y0 + 0.22 : null));
  world.addCircle(0, 0, 0.95, y0 + 0.54 + 1.26);
  for (const side of [-1, 1]) {
    const gz = side * RUSH.gates.order.z;
    for (const sx of [-1, 1]) {
      world.addBox(sx * 5.4, gz, 1, 1, 0);
      world.addCircle(sx * 4.45, side * (p.baseRadius + 7.5), 0.75, 1.7);
    }
  }
  // the south gate's lintel lies in two pieces
  world.addBox(7.6, RUSH.gates.order.z + 2.5, 3.3, 1.1, 0.5, 1.2);
  world.addBox(-8.4, RUSH.gates.order.z + 1.6, 2.8, 1.1, -0.35, 1.2);
  for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) world.addCircle(Math.cos(a) * 9.5, Math.sin(a) * 9.5, 0.75, y0 + 1.7);
  for (const [x, z, h] of WALLS) world.addBox(x, z, 0.5, 0.85, 0, h);
  for (const [x, z, r, h] of BOULDERS) world.addCircle(x, z, r, h);
  return world;
}

/** The temple plaza's collision with the pitch's edge as a wall, for headless Relic Rush matches (tests and bot tuning). */
export function rushTestField(): SimTerrain {
  return pitchTerrain(rushTestWorld());
}
