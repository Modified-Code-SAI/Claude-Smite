import { Arena } from '../scene/ArenaLayout';
import { RUSH } from '../sim/Rush';

/**
 * The goal cam: a moment after a goal the view cuts to a camera out on the
 * pitch beside the scorer, low, looking at them with the gate they scored
 * through to one side and the crowd behind (and their teammates running
 * over). It holds until the dip to dark, under which the follow camera takes
 * over again for the kickoff. `turns`: how far round from straight out of the
 * gate the camera may stand, either side (radians), at `dists` from the
 * scorer; the spot with the fewest columns looming in the frame wins.
 * `cutAt`: seconds into the celebration (the player sees the goal go in from
 * their own view first). The camera creeps in at `push` m/s, no nearer than
 * `near`. `behind`: how far behind the gate line "out from the gate" is
 * measured from.
 */
export const GOAL_CAM = { dists: [7.5, 9.5], height: 2.6, look: 1.4, turns: [0.55, 0.85, 1.15, 1.45], cutAt: 0.3, follow: 4, push: 0.45, near: 5, behind: 3 } as const;

/** The plaza's columns and the gates' pillars, which the goal cam keeps out of its way. */
export const COLUMNS: { x: number; z: number; r: number }[] = (() => {
  const p = Arena.plaza;
  const out: { x: number; z: number; r: number }[] = [];
  for (let i = 0; i < p.columnCount; i++) {
    const a = (i / p.columnCount) * Math.PI * 2 + Math.PI / p.columnCount;
    if (Math.abs(Math.cos(a)) >= 0.12) out.push({ x: Math.cos(a) * p.columnRing, z: Math.sin(a) * p.columnRing, r: p.columnRadius });
  }
  for (const side of [-1, 1]) for (const sx of [-1, 1]) out.push({ x: sx * 5.4, z: side * RUSH.gates.order.z, r: 1 });
  return out;
})();

/**
 * How badly the temple spoils a camera at (cx, cz) looking at (tx, tz): each
 * column in the frame counts by how big it looms (near ones fill the screen)
 * and how central it is, one standing in front of the subject counts heavily
 * (one behind them is a backdrop), and so does the edge of the temple's
 * platform running between them.
 */
export function framingCost(cx: number, cz: number, tx: number, tz: number): number {
  const fx = tx - cx;
  const fz = tz - cz;
  const d = Math.hypot(fx, fz) || 1;
  let cost = 0;
  for (const p of COLUMNS) {
    const rx = p.x - cx;
    const rz = p.z - cz;
    const t = (rx * fx + rz * fz) / d;
    const l = Math.abs(rx * fz - rz * fx) / d;
    if (Math.hypot(rx, rz) < p.r + 1.2) cost += 20;
    if (t <= 0.2) continue;
    // half the screen's width is about one unit of offset per unit of depth (58° tall, 16:9)
    const centred = 1 - (l - p.r) / t;
    if (centred <= 0) continue;
    cost += (p.r / t) * 6 * Math.min(1, centred);
    if (t < d - 0.5 && l < p.r + 0.7) cost += 6;
  }
  if (Math.hypot(cx, cz) > RUSH.pitchRadius - 1.5) cost += 20;
  // the temple's top step between the camera and the subject crosses the foreground as a bright band
  const top = Arena.plaza.radius + 0.4;
  if (Math.hypot(cx, cz) < top !== Math.hypot(tx, tz) < top) cost += 2.5;
  return cost;
}

/**
 * Where the goal cam stands for a scorer at (ux, uz) who scored through
 * `gate`: out from the gate past the scorer (straight in from the gate when
 * they have run on through it), turned to either side, at whichever of the
 * candidate spots frames them most cleanly.
 */
export function goalCamSpot(ux: number, uz: number, gate: { x: number; z: number }): { x: number; z: number } {
  // measured from a point behind the gate, so a scorer in its mouth looks out on to the pitch, not along the gate line
  const side = Math.sign(gate.z);
  let ox = ux - gate.x;
  let oz = uz - (gate.z + side * GOAL_CAM.behind);
  const d = Math.hypot(ox, oz);
  if (oz * side > -1) {
    ox = 0;
    oz = -side;
  } else {
    ox /= d;
    oz /= d;
  }
  let best = { x: ux, z: uz, cost: Infinity };
  for (const t of GOAL_CAM.turns) {
    for (const turn of [t, -t]) {
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      for (const dist of GOAL_CAM.dists) {
        const x = ux + (ox * c - oz * s) * dist;
        const z = uz + (ox * s + oz * c) * dist;
        // a nudge toward the middle of the choices, so a clean frame isn't traded for a slightly cleaner odd one
        const cost = framingCost(x, z, ux, uz) + Math.abs(t - 0.85) * 0.4 + Math.abs(dist - 8.5) * 0.1;
        if (cost < best.cost) best = { x, z, cost };
      }
    }
  }
  return { x: best.x, z: best.z };
}

/** The match's last shot: how far it drifts round the winners (radians), settling over about `settle` seconds. */
export const WIN_CAM = { drift: 0.5, settle: 5 } as const;

/**
 * Which way the match's last shot drifts round a subject at (ux, uz) from a
 * camera at (cx, cz): toward whichever side keeps the temple's columns out of
 * the frame once it has pushed in (see GOAL_CAM.near), or not at all when
 * both would spoil it.
 */
export function winDrift(cx: number, cz: number, ux: number, uz: number): number {
  const ox = cx - ux;
  const oz = cz - uz;
  const d = Math.hypot(ox, oz) || 1;
  const r = GOAL_CAM.near + 0.5;
  const cost = (a: number) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return framingCost(ux + ((ox * c - oz * s) / d) * r, uz + ((ox * s + oz * c) / d) * r, ux, uz);
  };
  const still = cost(0);
  const left = cost(WIN_CAM.drift);
  const right = cost(-WIN_CAM.drift);
  if (Math.min(left, right) > still + 1.5) return 0;
  return left <= right ? WIN_CAM.drift : -WIN_CAM.drift;
}
