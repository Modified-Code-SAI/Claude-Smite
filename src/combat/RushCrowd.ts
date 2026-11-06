import * as THREE from 'three/webgpu';
import { abs, attribute, cameraPosition, color, cos, cross, dot, float, length, max, min, mix, normalView, normalize, positionLocal, positionView, sin, smoothstep, time, uniform, vec3 } from '../render/tsl';
import { RUSH, type Rush } from '../sim/Rush';
import type { Side } from '../game/combatant';

type Ground = (x: number, z: number) => number;

/**
 * Where the spirits stand: rows round the outside of the pitch's rim, clear of
 * the lanes that leave behind each gate and of the halfway line (where the two
 * ends of the crowd meet).
 */
export const CROWD = {
  rows: [
    { r: RUSH.pitchRadius + 2.2, gap: 1.2 },
    { r: RUSH.pitchRadius + 3.5, gap: 1.25 },
    { r: RUSH.pitchRadius + 4.8, gap: 1.3 },
  ],
  /** Meters either side of the lanes (x = 0) left clear behind each gate. */
  laneGap: 6.2,
  /** Meters either side of the halfway line left clear between the two ends. */
  halfGap: 1.6,
  /** How tall a spirit stands, in meters. */
  height: 1.95,
};

/**
 * How worked up each end of the crowd is, 0 (slumped) to 1 (on its feet).
 * Rises fast and settles slowly, so a goal's roar outlasts the goal.
 */
const HEAT = { idle: 0.1, overtime: 0.24, rise: 5, fall: 1.1, near: 18, beat: 0.4, save: 0.75 };

const GOLD_TRIM = 0xffc23a;
let crowdMaterial: THREE.MeshBasicNodeMaterial | null = null;
const heatOrder = uniform(HEAT.idle);
const heatChaos = uniform(HEAT.idle);
const tintOrder = uniform(new THREE.Color());
const tintChaos = uniform(new THREE.Color());

/** What a vertex belongs to (the `info.z` attribute): it decides how the vertex moves and is colored. */
const KIND = { body: 0, arm: 1, cloth: 3, pole: 4 } as const;
type Kind = (typeof KIND)[keyof typeof KIND];

/** 1 where `kind` is `k`, else 0 (kinds are whole numbers). */
const isKind = (kind: any, k: number) => smoothstep(k - 0.5, k - 0.4, kind).mul(smoothstep(k + 0.5, k + 0.4, kind));

/**
 * Spirits of the faithful, glowing in their team's color with a ball of light
 * for a head, and their teams' standards planted among them. Each spirit bobs on
 * its feet; as its end of the crowd heats up it starts to hop and throws its
 * arms up (each at its own threshold, so a near miss lifts only the keenest),
 * and the standards stream and flare. All the motion is in the vertex shader:
 * the CPU sets two numbers a frame.
 */
function makeCrowdMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const info = attribute('info', 'vec4');
  const pivot = attribute('pivot', 'vec3');
  const feet = attribute('feet', 'vec3');
  const cloth = attribute('cloth', 'vec2');
  const phase = info.x;
  const side = info.y;
  const kind = info.z;
  const glow = info.w;
  const arm = isKind(kind, KIND.arm);
  const isCloth = isKind(kind, KIND.cloth);
  const standard = smoothstep(2.5, 2.6, kind);
  const heat = mix(heatChaos, heatOrder, side);
  const rate = phase.mul(2.6).add(6.6);
  const beat = time.mul(rate).add(phase.mul(41));
  // the spirit faces the middle of the pitch; its side axis is what its arms swing round
  const f = normalize(vec3(feet.x.negate(), 0, feet.z.negate()));
  const axis = vec3(f.z.negate(), 0, f.x);
  // hop: a quick spring off the ground at each spirit's own beat (standards stay planted)
  const hop = max(sin(beat), 0).pow(1.6).mul(smoothstep(0.3, 0.9, heat)).mul(0.34).mul(float(1).sub(standard));
  // arms: hanging and swaying, then up over the head and pumping
  const keen = smoothstep(phase.mul(0.35).add(0.18), phase.mul(0.35).add(0.45), heat);
  const rest = sin(time.mul(0.9).add(phase.mul(30))).mul(0.1).add(0.14);
  const up = sin(beat.add(1.3)).mul(0.32).add(2.7);
  const angle = mix(rest, up, keen).mul(arm);
  const v = positionLocal.sub(pivot);
  const c = cos(angle);
  const swung = v.mul(c).add(cross(axis, v).mul(sin(angle))).add(axis.mul(dot(axis, v).mul(float(1).sub(c))));
  // a standard's cloth ripples toward the pitch, more toward its free end and harder when its end cheers
  const wave = sin(time.mul(2.4).add(cloth.x.mul(3.4)).add(phase.mul(17)));
  const ripple = wave.mul(float(1).sub(cloth.y)).mul(heat.mul(0.22).add(0.08)).mul(isCloth);
  const moved = pivot.add(swung).add(f.mul(ripple)).add(vec3(0, hop, 0));
  // spirits right by the camera shrink away instead of filling the screen
  const near = smoothstep(2.5, 5.5, length(cameraPosition.sub(feet)));
  m.positionNode = feet.add(moved.sub(feet).mul(near));

  // lit from within: dark mist at the feet, the team's color rising to a glowing head
  // (bright enough to bloom), glowing rims, and faint bands of light drifting up
  const tint = mix(tintChaos, tintOrder, side);
  const gold = color(GOLD_TRIM);
  const rim = float(1).sub(abs(dot(normalView, normalize(positionView).negate()))).pow(2.5);
  const body = tint.mul(mix(float(0.1), float(1.05), glow.pow(1.3)));
  const edge = mix(tint, color(0xffffff), 0.3).mul(rim.mul(1.7));
  const core = mix(tint, color(0xffffff), 0.35).mul(smoothstep(0.84, 1, glow).mul(2));
  const bands = sin(positionLocal.y.mul(9).sub(time.mul(2.6)).add(phase.mul(20))).mul(0.5).add(0.5).pow(4).mul(glow).mul(0.35);
  const flicker = sin(time.mul(2.3).add(phase.mul(57))).mul(0.07).add(1);
  const spirit = body.add(edge).add(core).add(tint.mul(bands)).mul(flicker);
  // a standard: the team's field with a gold border and sun disc, folds shaded by the ripple; a gilded pole
  const inner = min(min(cloth.x, float(1).sub(cloth.x)), min(cloth.y, float(1).sub(cloth.y)));
  const border = smoothstep(0.1, 0.07, inner);
  const sun = smoothstep(0.2, 0.17, length(vec3(cloth.x.sub(0.5), cloth.y.sub(0.56).mul(1.35), 0)));
  const field = mix(tint.mul(0.75), gold.mul(1.25), max(border, sun)).mul(wave.mul(0.14).add(0.9));
  const look = mix(spirit, mix(gold.mul(0.7), field, isCloth), standard);
  m.colorNode = look.mul(heat.mul(0.9).add(0.72));
  return m;
}

interface Part {
  g: THREE.BufferGeometry;
  kind: Kind;
  /** The point it moves round (local, before scaling): an arm's shoulder, a cloth's top edge; else the feet. */
  pivot?: THREE.Vector3;
  /** Brightness from a vertex's local position. */
  glow: (p: THREE.Vector3) => number;
}

/** One spirit, in its own frame (x to its side, y up, z toward the pitch), about 1.75 m tall. */
function spiritParts(): Part[] {
  const sh = 1.14;
  const head = sh + 0.3;
  const parts: Part[] = [
    // the robe, widening to the ground
    { g: new THREE.CylinderGeometry(0.17, 0.36, 1.18, 7, 1, true).translate(0, 0.59, 0), kind: KIND.body, glow: (p) => Math.min(1, Math.max(0, p.y / 1.3)) * 0.75 },
    // the shoulders
    { g: new THREE.SphereGeometry(0.2, 6, 3).scale(1.25, 0.55, 1).translate(0, sh + 0.02, 0), kind: KIND.body, glow: () => 0.72 },
    // the head, a ball of light
    { g: new THREE.SphereGeometry(0.16, 7, 5).translate(0, head, 0.02), kind: KIND.body, glow: () => 1 },
  ];
  for (const s of [-1, 1]) {
    const at = new THREE.Vector3(s * 0.25, sh, 0);
    parts.push({
      g: new THREE.CylinderGeometry(0.055, 0.075, 0.56, 5, 1, false).translate(at.x, sh - 0.28, 0),
      kind: KIND.arm,
      pivot: at,
      // brighter toward the hand
      glow: (p) => 0.6 + 0.4 * Math.min(1, (sh - p.y) / 0.56),
    });
  }
  return parts;
}

/** A team's standard, planted among its spirits: a gilded pole and crossbar with a cloth hanging from it. */
function standardParts(): Part[] {
  const top = 3.3;
  return [
    { g: new THREE.BoxGeometry(0.08, top + 0.15, 0.08).translate(0, (top + 0.15) / 2, 0), kind: KIND.pole, glow: () => 0.8 },
    { g: new THREE.BoxGeometry(1.05, 0.07, 0.07).translate(0, top - 0.05, 0), kind: KIND.pole, glow: () => 0.8 },
    { g: new THREE.SphereGeometry(0.09, 6, 4).translate(0, top + 0.18, 0), kind: KIND.pole, glow: () => 1 },
    // (just in front of the pole, facing the pitch)
    { g: new THREE.PlaneGeometry(0.92, 1.3, 5, 4).translate(0, top - 0.1 - 0.65, 0.06), kind: KIND.cloth, pivot: new THREE.Vector3(0, top - 0.1, 0.06), glow: () => 1 },
  ];
}

/**
 * Relic Rush's crowd: a few hundred spirits standing round the pitch, each end
 * in the colors of the team whose gate it stands behind. All one static mesh
 * (one draw, no shadow), animated on the GPU.
 */
export class RushCrowd {
  readonly mesh: THREE.Mesh;
  /** Spirits placed, and standards planted among them. */
  readonly count: number;
  readonly standards: number;
  private readonly heat = { order: HEAT.idle, chaos: HEAT.idle };
  /** Extra excitement from a moment of play (a steal, a catch), fading. */
  private readonly spike = { order: 0, chaos: 0 };
  private readonly seen = { steal: 0, catch: 0, fumble: 0, shrug: 0, save: 0 };

  constructor(ground: Ground, mine: Side, colors: { ally: number; foe: number }) {
    tintOrder.value.setHex(mine === 'order' ? colors.ally : colors.foe);
    tintChaos.value.setHex(mine === 'chaos' ? colors.ally : colors.foe);
    const spirit = spiritParts();
    const flag = standardParts();
    const pos: number[] = [];
    const nor: number[] = [];
    const piv: number[] = [];
    const ft: number[] = [];
    const inf: number[] = [];
    const cl: number[] = [];
    const index: number[] = [];
    // a fixed seed, so the crowd stands in the same places every match
    let seed = 1234567;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const local = new THREE.Vector3();
    const normalM = new THREE.Matrix3();
    const clear = (x: number, z: number, margin: number) => Math.abs(x) >= CROWD.laneGap + margin && Math.abs(z) >= CROWD.halfGap + margin;
    /** Adds one figure's parts, standing at (x, z) and facing `yaw`. */
    const add = (parts: Part[], x: number, z: number, yaw: number, scale: number, phase: number) => {
      const y = ground(x, z);
      m.makeRotationY(yaw).scale(p.set(scale, scale, scale)).setPosition(x, y, z);
      normalM.getNormalMatrix(m);
      const side = z > 0 ? 1 : 0; // Order defends +z, and its end of the crowd stands there
      for (const part of parts) {
        const base = pos.length / 3;
        const gp = part.g.attributes.position!;
        const gn = part.g.attributes.normal!;
        const guv = part.g.attributes.uv!;
        const pv = part.pivot ? p.copy(part.pivot).applyMatrix4(m) : p.set(x, y, z);
        const [px, py, pz] = [pv.x, pv.y, pv.z];
        for (let k = 0; k < gp.count; k++) {
          local.fromBufferAttribute(gp, k);
          const glow = part.glow(local);
          p.copy(local).applyMatrix4(m);
          n.fromBufferAttribute(gn, k).applyMatrix3(normalM).normalize();
          pos.push(p.x, p.y, p.z);
          nor.push(n.x, n.y, n.z);
          piv.push(px, py, pz);
          ft.push(x, y, z);
          inf.push(phase, side, part.kind, glow);
          if (part.kind === KIND.cloth) cl.push(guv.getX(k), guv.getY(k));
          else cl.push(0, 1);
        }
        const gi = part.g.index;
        if (gi) for (let k = 0; k < gi.count; k++) index.push(base + gi.getX(k));
        else for (let k = 0; k < gp.count; k++) index.push(base + k);
      }
    };
    // the standards first, so no spirit stands in one's pole
    const poles: [number, number][] = [];
    const rs = CROWD.rows[1]!.r + 0.6;
    for (let i = 0; i < 16; i++) {
      const a = ((i + 0.5) / 16) * Math.PI * 2;
      const x = Math.sin(a) * rs;
      const z = Math.cos(a) * rs;
      if (!clear(x, z, 1.5)) continue;
      poles.push([x, z]);
      add(flag, x, z, Math.atan2(-x, -z), 1, rand());
    }
    this.standards = poles.length;
    let count = 0;
    for (const [row, { r, gap }] of CROWD.rows.entries()) {
      const steps = Math.floor((Math.PI * 2 * r) / gap);
      for (let i = 0; i < steps; i++) {
        const a = ((i + (row % 2) * 0.5 + (rand() - 0.5) * 0.35) / steps) * Math.PI * 2;
        const rr = r + (rand() - 0.5) * 0.5;
        const x = Math.sin(a) * rr;
        const z = Math.cos(a) * rr;
        if (!clear(x, z, 0)) continue;
        // a few gaps, so it reads as people gathered rather than a fence
        if (rand() < 0.1) continue;
        if (poles.some(([px, pz]) => Math.hypot(x - px, z - pz) < 0.75)) continue;
        // facing the middle of the pitch, give or take
        add(spirit, x, z, Math.atan2(-x, -z) + (rand() - 0.5) * 0.5, (CROWD.height / 1.75) * (0.88 + rand() * 0.24), rand());
        count++;
      }
    }
    for (const part of [...spirit, ...flag]) part.g.dispose();
    this.count = count;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('pivot', new THREE.Float32BufferAttribute(piv, 3));
    g.setAttribute('feet', new THREE.Float32BufferAttribute(ft, 3));
    g.setAttribute('info', new THREE.Float32BufferAttribute(inf, 4));
    g.setAttribute('cloth', new THREE.Float32BufferAttribute(cl, 2));
    g.setIndex(index);
    g.computeBoundingSphere();
    // (hops and raised arms reach a little past the resting shape)
    g.boundingSphere!.radius += 1;
    this.mesh = new THREE.Mesh(g, (crowdMaterial ??= makeCrowdMaterial()));
    this.mesh.name = 'rush-crowd';
    this.mesh.matrixAutoUpdate = false;
  }

  /** Each end of the crowd follows the play: goals, a run at the gate, steals and catches. */
  frame(rush: Rush, dt: number): void {
    const relic = rush.relic;
    const seen = this.seen;
    const b = rush.beats;
    if (b.steal !== seen.steal || b.catch !== seen.catch || b.fumble !== seen.fumble || b.shrug !== seen.shrug || b.save !== seen.save) {
      const beat = rush.lastBeat;
      // the end whose team just won (or kept) the relic gets up
      const team = !beat ? null : beat.kind === 'fumble' ? (beat.by?.team as Side | undefined) : (beat.unit.team as Side);
      // (a save brings the keeper's end to its feet)
      if (team) this.spike[team] = Math.max(this.spike[team], beat?.kind === 'save' ? HEAT.save : HEAT.beat);
      seen.steal = b.steal;
      seen.catch = b.catch;
      seen.fumble = b.fumble;
      seen.shrug = b.shrug;
      seen.save = b.save;
    }
    const base = rush.overtime ? HEAT.overtime : HEAT.idle;
    for (const side of ['order', 'chaos'] as const) {
      let target = base;
      const goal = rush.lastGoal;
      if (rush.winner) target = rush.winner === side ? 1 : 0;
      else if (rush.phase === 'goal' && goal) target = goal.team === side ? 1 : 0;
      else {
        // a run at the other gate lifts this end, more the closer it gets
        const carrier = relic.phase === 'held' ? relic.holder : relic.phase === 'flying' ? relic.thrower : null;
        if (carrier && carrier.team === side) {
          const gate = RUSH.gates[side === 'order' ? 'chaos' : 'order'];
          const d = Math.hypot(relic.x - gate.x, relic.z - gate.z);
          target = Math.max(target, 0.12 + 0.55 * Math.max(0, 1 - d / HEAT.near));
        }
        target = Math.max(target, this.spike[side]);
      }
      this.spike[side] = Math.max(0, this.spike[side] - dt * 0.35);
      const h = this.heat[side];
      this.heat[side] = h + (target - h) * Math.min(1, dt * (target > h ? HEAT.rise : HEAT.fall));
    }
    heatOrder.value = this.heat.order;
    heatChaos.value = this.heat.chaos;
  }

  /** How worked up each end is now (0 to 1). */
  excitement(side: Side): number {
    return this.heat[side];
  }
}
