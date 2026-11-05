import { describe, expect, it } from 'vitest';
import { distToSegment } from '../scene/ArenaLayout';
import { RUSH } from '../sim/Rush';
import { COLUMNS, goalCamSpot } from './goalCam';

/** Where goals get scored from: dunks across each gate's mouth and shots from out on the pitch. */
function scorers(): { x: number; z: number; gate: { x: number; z: number } }[] {
  const out: { x: number; z: number; gate: { x: number; z: number } }[] = [];
  for (const gate of [RUSH.gates.order, RUSH.gates.chaos]) {
    const inward = -Math.sign(gate.z);
    for (let x = -4; x <= 4; x += 1) for (const dz of [-0.6, 0, 0.6]) out.push({ x, z: gate.z + dz, gate });
    for (let d = 6; d <= 16; d += 2) {
      for (let a = -1; a <= 1; a += 0.25) out.push({ x: gate.x + Math.sin(a) * d, z: gate.z + inward * Math.cos(a) * d, gate });
    }
  }
  return out;
}

/** Whether column p hides the scorer s from a camera at c. */
function inTheWay(p: { x: number; z: number; r: number }, c: { x: number; z: number }, s: { x: number; z: number }): boolean {
  if (Math.hypot(p.x - s.x, p.z - s.z) > p.r + 1.2) return distToSegment(p.x, p.z, c.x, c.z, s.x, s.z) < p.r + 0.5;
  // one the scorer stands right against may be beside or behind them in the shot, never in front
  const fx = s.x - c.x;
  const fz = s.z - c.z;
  const d = Math.hypot(fx, fz);
  const t = ((p.x - c.x) * fx + (p.z - c.z) * fz) / d;
  const l = Math.abs((p.x - c.x) * fz - (p.z - c.z) * fx) / d;
  return t < d - 0.5 && l < p.r + 0.5;
}

describe('goal cam', () => {
  it('stands on the pitch, clear of every column, with nothing between it and the scorer', () => {
    const bad: string[] = [];
    for (const s of scorers()) {
      const c = goalCamSpot(s.x, s.z, s.gate);
      const where = `scorer (${s.x.toFixed(1)}, ${s.z.toFixed(1)}) cam (${c.x.toFixed(1)}, ${c.z.toFixed(1)})`;
      const dist = Math.hypot(c.x - s.x, c.z - s.z);
      if (Math.hypot(c.x, c.z) > RUSH.pitchRadius - 1.5) bad.push(`${where}: off the pitch`);
      if (dist < 7 || dist > 10) bad.push(`${where}: ${dist.toFixed(1)} m away`);
      for (const p of COLUMNS) {
        if (Math.hypot(p.x - c.x, p.z - c.z) < p.r + 1.2) bad.push(`${where}: inside a column`);
        else if (inTheWay(p, c, s)) bad.push(`${where}: column at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) in the way`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('films each gate the same way, mirrored', () => {
    for (const s of scorers().filter((s) => s.gate === RUSH.gates.chaos)) {
      const a = goalCamSpot(s.x, s.z, s.gate);
      const b = goalCamSpot(s.x, -s.z, RUSH.gates.order);
      expect(Math.abs(b.z + a.z)).toBeLessThan(1e-6);
      expect(Math.abs(Math.abs(b.x) - Math.abs(a.x))).toBeLessThan(2);
    }
  });
});
