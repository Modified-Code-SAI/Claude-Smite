import * as THREE from 'three/webgpu';
import {
  abs, atan, attribute, float, length, max, min, mix, mx_noise_float, mx_worley_noise_float, positionWorld, pow, sin, smoothstep, step, uniform, vec2, vec3,
} from '../render/tsl';

/**
 * Where the giant has been: frost left on the ground by its feet and its
 * blows, slowly breaking up into patches and melting away.
 */
export const PRINTS = {
  /** Prints kept at once; the oldest makes room for a new one. */
  capacity: 56,
  /** Seconds a footprint lasts, and a blow's frost; both melt over their last `melt` seconds. */
  footLife: 22,
  blowLife: 18,
  melt: 7,
  /** A footprint's size (meters) and how far ahead of the ankle its middle sits. */
  foot: { length: 2.6, width: 1.4, ahead: 0.75 },
  /** Raised off the ground this much, so it never sinks into it. */
  lift: 0.04,
};

/** A print's grid: CELLS x CELLS quads, each corner dropped onto the ground, so it follows steps and slopes. */
const CELLS = 3;
const SIDE = CELLS + 1;
const VERTS = SIDE * SIDE;

export type PrintKind = 'footL' | 'footR' | 'blow';
const KIND: Record<PrintKind, number> = { footL: 0, footR: 1, blow: 2 };

/**
 * The frost prints: every one in one mesh and one draw. A new print rewrites
 * its slot's few vertices (nothing changes between prints but one clock
 * uniform), and the shader draws the shape from each corner's place on the
 * print: a footprint (soft sole, a pushed-up rim, crystals feathering out of
 * it) or a blow (frost streaks bursting out of a pale core). Each grows in
 * over a moment and melts away in patches.
 */
export class FrostPrints {
  readonly mesh: THREE.Mesh;
  private readonly position: THREE.BufferAttribute;
  private readonly local: THREE.BufferAttribute;
  private readonly info: THREE.BufferAttribute;
  private readonly now = uniform(0);
  private clock = 0;
  private next = 0;

  constructor(private readonly ground: (x: number, z: number) => number) {
    const n = PRINTS.capacity * VERTS;
    const geo = new THREE.BufferGeometry();
    // every corner starts at the origin: no area, nothing drawn, until a print takes the slot
    this.position = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.local = new THREE.BufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.info = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const normal = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) normal[i * 3 + 1] = 1;
    geo.setAttribute('position', this.position);
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setAttribute('pLocal', this.local);
    geo.setAttribute('pInfo', this.info);
    const index: number[] = [];
    for (let s = 0; s < PRINTS.capacity; s++) {
      const o = s * VERTS;
      for (let j = 0; j < CELLS; j++) {
        for (let i = 0; i < CELLS; i++) {
          const a = o + j * SIDE + i;
          // wound to face up (rows run forward, columns to the right)
          index.push(a, a + 1, a + SIDE, a + 1, a + SIDE + 1, a + SIDE);
        }
      }
    }
    geo.setIndex(index);
    this.mesh = new THREE.Mesh(geo, this.material());
    this.mesh.name = 'frost-prints';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 4;
  }

  private material(): THREE.MeshStandardNodeMaterial {
    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 0.32, metalness: 0 });
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -4;
    const p = attribute('pLocal', 'vec2');
    const info = attribute('pInfo', 'vec3');
    const kind = info.x;
    const age = this.now.sub(info.y);
    const seed = info.z;
    const blow = step(1.5, kind);
    const life = mix(float(PRINTS.footLife), float(PRINTS.blowLife), blow);
    const wp = positionWorld.xz;
    // patches the frost melts away in, and the glints of its crystals
    const patch = mx_noise_float(vec3(wp.x.mul(1.6), wp.y.mul(1.6), seed)).mul(0.5).add(0.5);
    const grain = mx_noise_float(vec3(wp.x.mul(7), wp.y.mul(7), seed.add(3))).mul(0.5).add(0.5);
    const glint = smoothstep(0.16, 0.02, mx_worley_noise_float(vec3(wp.x.mul(5.5), wp.y.mul(5.5), seed.mul(0.7))));

    // -- a footprint: the right foot is the left one mirrored; its toes are +y
    const fx = mix(p.x, p.x.negate(), kind);
    const ellipse = (cx: number, cy: number, rx: number, ry: number) => length(vec2(fx.sub(cx).div(rx), p.y.sub(cy).div(ry))).sub(1);
    // heel, ball and three broad toes (its feet are wrapped), run together with a smooth union; the ball leans to the inside
    const smooth = (a: any, b: any, k: number) => {
      const h = max(float(k).sub(abs(a.sub(b))), 0).div(k);
      return min(a, b).sub(h.mul(h).mul(k * 0.25));
    };
    const heel = ellipse(0, -0.52, 0.46, 0.4);
    const ball = ellipse(0.06, 0.24, 0.66, 0.5);
    const toes = min(min(ellipse(-0.36, 0.78, 0.22, 0.2), ellipse(0.02, 0.84, 0.24, 0.2)), ellipse(0.4, 0.74, 0.2, 0.18));
    const sole = smooth(smooth(heel, ball, 0.45), toes, 0.3);
    const inside = smoothstep(0.04, -0.12, sole);
    // thin frost where the sole pressed, in cells like hoarfrost; a bright ridge pushed up at the rim; crystals feathering out past it
    const cells = smoothstep(0.42, 0.08, mx_worley_noise_float(vec3(wp.x.mul(2.6), wp.y.mul(2.6), seed.add(9))));
    const ridge = smoothstep(-0.3, -0.05, sole).mul(smoothstep(0.1, -0.03, sole));
    const ang = atan(p.y, fx);
    const feathers = pow(abs(sin(ang.mul(21).add(patch.mul(7)))), 5).mul(smoothstep(0.38, 0.0, sole)).mul(step(-0.03, sole));
    const footA = inside.mul(cells.mul(0.4).add(grain.mul(0.18)).add(0.16)).add(ridge.mul(0.75)).add(feathers.mul(0.6));

    // -- a blow: streaks of frost bursting out from a pale core, a ring where the shock spread
    const r = length(p);
    const burst = atan(p.y, p.x);
    const streaks = pow(abs(sin(burst.mul(7).add(patch.mul(4)).add(seed))), 10).mul(smoothstep(1, 0.25, r));
    const fine = pow(abs(sin(burst.mul(23).sub(grain.mul(5)))), 14).mul(smoothstep(0.75, 0.15, r)).mul(0.6);
    const core = smoothstep(0.5, 0.05, r).mul(grain.mul(0.3).add(0.3));
    const ring = smoothstep(0.08, 0, abs(r.sub(0.62))).mul(0.35);
    const blowA = max(max(core, streaks), max(fine, ring)).mul(smoothstep(1, 0.9, r));

    // grows out from the middle over a moment, then breaks up into patches and melts
    // (how far out from the middle each spot is: 1 at a footprint's edge, a blow's rim)
    const out = mix(sole.add(1), r, blow);
    const front = smoothstep(0, 0.45, age).mul(1.6);
    const grow = smoothstep(front, front.sub(0.15), out);
    const left = smoothstep(life, life.sub(PRINTS.melt), age);
    const melt = smoothstep(float(1).sub(left).sub(0.12), float(1).sub(left).add(0.12), patch.mul(0.85).add(0.15));
    const alpha = mix(footA, blowA, blow).mul(grow).mul(melt).mul(step(age, life));

    // ice blue where it is thin, white where it is thick (the ridge, a blow's streaks), glinting
    const thick = mix(ridge.add(feathers.mul(0.5)), max(streaks, core.mul(1.4)), blow).clamp(0, 1);
    m.colorNode = mix(vec3(0.5, 0.72, 0.92), vec3(0.93, 0.98, 1), thick.mul(0.75).add(glint.mul(0.25)));
    m.emissiveNode = vec3(0.3, 0.6, 0.85).mul(glint.mul(0.35).add(thick.mul(0.08)));
    m.opacityNode = alpha.clamp(0, 1).mul(0.85);
    return m;
  }

  /** A foot came down at `ankle`, the giant facing `yaw`. */
  foot(ankle: THREE.Vector3, yaw: number, kind: 'footL' | 'footR'): void {
    const f = PRINTS.foot;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    this.add(ankle.x + fx * f.ahead, ankle.z + fz * f.ahead, yaw, f.width / 2, f.length / 2, kind);
  }

  /** A blow struck the ground at (x, z), its frost spreading `radius` meters. */
  blow(x: number, z: number, radius: number): void {
    this.add(x, z, Math.random() * Math.PI * 2, radius, radius, 'blow');
  }

  private add(x: number, z: number, yaw: number, halfW: number, halfL: number, kind: PrintKind): void {
    const s = this.next;
    this.next = (this.next + 1) % PRINTS.capacity;
    // across and along the print
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = -fz;
    const rz = fx;
    const pos = this.position.array as Float32Array;
    const loc = this.local.array as Float32Array;
    const inf = this.info.array as Float32Array;
    const seed = Math.random() * 40;
    for (let j = 0; j < SIDE; j++) {
      for (let i = 0; i < SIDE; i++) {
        const u = (i / CELLS) * 2 - 1;
        const v = (j / CELLS) * 2 - 1;
        const px = x + rx * u * halfW + fx * v * halfL;
        const pz = z + rz * u * halfW + fz * v * halfL;
        const o = s * VERTS + j * SIDE + i;
        pos[o * 3] = px;
        pos[o * 3 + 1] = this.ground(px, pz) + PRINTS.lift;
        pos[o * 3 + 2] = pz;
        loc[o * 2] = u;
        loc[o * 2 + 1] = v;
        inf[o * 3] = KIND[kind];
        inf[o * 3 + 1] = this.clock;
        inf[o * 3 + 2] = seed;
      }
    }
    this.position.needsUpdate = true;
    this.local.needsUpdate = true;
    this.info.needsUpdate = true;
  }

  update(dt: number): void {
    this.clock += dt;
    this.now.value = this.clock;
  }
}
