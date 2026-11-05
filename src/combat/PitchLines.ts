import * as THREE from 'three/webgpu';
import { abs, attribute, color, max, mix, sin, smoothstep, time, vec3, vec4 } from '../render/tsl';
import { Arena } from '../scene/ArenaLayout';
import { RUSH } from '../sim/Rush';

type Ground = (x: number, z: number) => number;

/** Seconds a glint takes to run 1 m along the lines (they shimmer like polished metal). */
const GLINT_SPEED = 1.6;

let pitchMaterial: THREE.MeshBasicNodeMaterial | null = null;

/**
 * The markings inlaid in the plaza for Relic Rush: gold strips set into the
 * marble with a dark engraved edge, and a glint that runs along them now and
 * then. The strips have a strong `tint` (vertex color) and an `across` value
 * (-1 at one edge, 1 at the other) for the inlay profile, and `along` (meters)
 * so the glint travels.
 */
function makePitchMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const tint = attribute('tint', 'vec3');
  const a = abs(attribute('across', 'float'));
  const along = attribute('along', 'float');
  const core = smoothstep(0.64, 0.5, a);
  const edge = smoothstep(1, 0.78, a);
  const glint = smoothstep(0.93, 1, sin(along.mul(0.33).sub(time.mul(GLINT_SPEED)))).mul(core);
  const metal = tint.mul(1.05).add(tint.mul(glint).mul(2.2)).add(vec3(glint.mul(0.5)));
  m.colorNode = vec4(mix(color(0x2e1d08), metal, core), 1);
  m.opacityNode = max(core.mul(0.9), edge.mul(0.42));
  return m;
}

interface Strip {
  pts: [number, number][];
  width: number;
  tint: THREE.Color;
  closed?: boolean;
}

/**
 * Relic Rush's pitch markings, all in one static mesh (one draw): the center
 * circle round the dais, the halfway line, a keeper's box in front of each gate
 * (in the colors of the team that defends it, the box where keepers catch
 * farther and higher), and the kickoff marks.
 */
export class PitchLines {
  readonly mesh: THREE.Mesh;

  constructor(ground: Ground, mine: 'order' | 'chaos', colors: { ally: number; foe: number; gold: number }) {
    const gold = new THREE.Color(colors.gold);
    const strips: Strip[] = [];
    const circle = (cx: number, cz: number, r: number, width: number, tint: THREE.Color) => {
      const n = Math.max(24, Math.ceil(r * 8));
      const pts: [number, number][] = [];
      for (let i = 0; i < n; i++) pts.push([cx + Math.sin((i / n) * Math.PI * 2) * r, cz + Math.cos((i / n) * Math.PI * 2) * r]);
      strips.push({ pts, width, tint, closed: true });
    };
    // the center circle round the dais, and the halfway line out to the plaza's edge
    const center = 6.2;
    const edge = Arena.plaza.radius - 0.6;
    circle(0, 0, center, 0.26, gold);
    strips.push({ pts: [[-edge, 0], [-center, 0]], width: 0.32, tint: gold });
    strips.push({ pts: [[center, 0], [edge, 0]], width: 0.32, tint: gold });
    for (const side of ['order', 'chaos'] as const) {
      const tint = new THREE.Color(side === mine ? colors.ally : colors.foe);
      // the keeper's box: from the gate's mouth out to the foot of the temple steps
      const g = RUSH.gates[side];
      const K = RUSH.keeper;
      const front = g.z - Math.sign(g.z) * K.depth;
      strips.push({ pts: [[g.x - K.halfWidth, g.z], [g.x - K.halfWidth, front], [g.x + K.halfWidth, front], [g.x + K.halfWidth, g.z]], width: 0.22, tint });
      for (const at of RUSH.kickoff[side]) circle(at.x, at.z, 0.55, 0.13, tint);
    }

    const pos: number[] = [];
    const tints: number[] = [];
    const across: number[] = [];
    const alongs: number[] = [];
    const index: number[] = [];
    for (const s of strips) {
      // resample every half meter so the strip hugs the ground
      const pts: [number, number][] = [];
      const n = s.pts.length;
      const segs = s.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const [ax, az] = s.pts[i]!;
        const [bx, bz] = s.pts[(i + 1) % n]!;
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
        for (let k = 0; k < steps; k++) pts.push([ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps]);
      }
      if (s.closed) pts.push(pts[0]!);
      else pts.push(s.pts[n - 1]!);
      let dist = 0;
      const base = pos.length / 3;
      for (let i = 0; i < pts.length; i++) {
        const [x, z] = pts[i]!;
        // the side direction: averaged between the segments meeting here, so corners stay joined
        const [px, pz] = pts[Math.max(0, i - 1)]!;
        const [nx, nz] = pts[Math.min(pts.length - 1, i + 1)]!;
        let dx = nx - px;
        let dz = nz - pz;
        if (s.closed && (i === 0 || i === pts.length - 1)) {
          const [qx, qz] = pts[pts.length - 2]!;
          const [rx, rz] = pts[1]!;
          dx = rx - qx;
          dz = rz - qz;
        }
        const len = Math.hypot(dx, dz) || 1;
        // a sharp corner (the keeper's box) is mitred so the strip keeps its width
        let miter = 1;
        if (i > 0 && i < pts.length - 1) {
          const ax = x - px, az = z - pz, bx = nx - x, bz = nz - z;
          const cos = (ax * bx + az * bz) / ((Math.hypot(ax, az) || 1) * (Math.hypot(bx, bz) || 1));
          miter = 1 / Math.max(0.5, Math.sqrt((1 + cos) / 2));
        }
        const ox = (-dz / len) * (s.width / 2) * miter;
        const oz = (dx / len) * (s.width / 2) * miter;
        if (i > 0) dist += Math.hypot(x - px, z - pz);
        for (const k of [-1, 1]) {
          const vx = x + ox * k;
          const vz = z + oz * k;
          pos.push(vx, ground(vx, vz) + 0.035, vz);
          tints.push(s.tint.r, s.tint.g, s.tint.b);
          across.push(k);
          alongs.push(dist);
        }
        if (i > 0) {
          const a = base + (i - 1) * 2;
          index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('tint', new THREE.Float32BufferAttribute(tints, 3));
    g.setAttribute('across', new THREE.Float32BufferAttribute(across, 1));
    g.setAttribute('along', new THREE.Float32BufferAttribute(alongs, 1));
    g.setIndex(index);
    g.computeBoundingSphere();
    this.mesh = new THREE.Mesh(g, (pitchMaterial ??= makePitchMaterial()));
    this.mesh.name = 'pitch-lines';
    // under the zone decals and the throw preview
    this.mesh.renderOrder = 4;
    this.mesh.matrixAutoUpdate = false;
  }
}
