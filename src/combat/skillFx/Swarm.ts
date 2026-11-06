import * as THREE from 'three/webgpu';
import { abs, cos, float, fract, hash, instanceIndex, max, mix, sin, smoothstep, step, uv, vec2, vec3, vec4 } from '../../render/tsl';
import { instancedSprite, objectUniforms, useUniforms } from '../../render/shared';
import type { Live } from './pool';

export const SWARM_SIZE = 72;

/** How the swarm moves. */
export const SWARM_MODES = {
  /** Streaming forward (-Z) through a cone: locusts. */
  stream: 0,
  /** Circling a vortex, climbing: debris in a whirlwind. */
  orbit: 1,
  /** Thrown out from the middle and falling: feathers, chips of stone. */
  scatter: 2,
  /** Falling from hands and blades: venom drips. */
  drip: 3,
} as const;
export type SwarmMode = keyof typeof SWARM_MODES;

const swarmUniforms = () => ({
  main: new THREE.Color(),
  hot: new THREE.Color(),
  mode: 0,
  age: 0,
  /** Meters: the cone's reach, the vortex's radius, the scatter's throw. */
  range: 6,
  /** Tangent of the cone's half angle, or the vortex's height. */
  spread: 0.4,
  size: 0.16,
  fade: 1,
  /** Share of the swarm shown. */
  count: 1,
  /** 1 draws winged bugs (dark body, flickering wings), 0 soft flecks. */
  bugs: 0,
  seed: 0,
});

let material: THREE.SpriteNodeMaterial | null = null;

function makeMaterial(): THREE.SpriteNodeMaterial {
  const u = objectUniforms(swarmUniforms());
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  const id = instanceIndex.toFloat();
  const h1 = hash(id.add(u.seed));
  const h2 = hash(id.mul(2.3).add(u.seed));
  const h3 = hash(id.mul(5.7).add(u.seed));
  const t = u.age;
  const pick = (k: number) => step(abs(u.mode.sub(k)), 0.5);

  // stream: each bug loops down the cone on its own clock, weaving as it goes
  const life = fract(t.mul(h2.mul(0.5).add(0.7)).add(h1));
  const reach = life.mul(u.range);
  const weave = sin(t.mul(h3.mul(6).add(7)).add(h1.mul(40))).mul(0.35);
  const stream = vec3(h2.mul(2).sub(1).mul(reach).mul(u.spread).add(weave), h3.mul(1.5).add(0.5).add(sin(t.mul(9).add(h2.mul(30))).mul(0.2)), reach.negate());
  // orbit: round and up a vortex
  const ang = h1.mul(6.283).add(t.mul(h2.mul(2).add(2.5)));
  const climb = fract(h3.add(t.mul(h1.mul(0.25).add(0.15))));
  const rr = u.range.mul(h2.mul(0.6).add(0.4)).mul(climb.mul(0.7).add(0.3));
  const orbit = vec3(cos(ang).mul(rr), climb.mul(u.spread), sin(ang).mul(rr));
  // scatter: thrown out, slowed by the air, drifting down
  const k = float(1).sub(float(1).sub(t.div(1.4).clamp(0, 1)).pow(3));
  const dir = h1.mul(6.283);
  const throwR = k.mul(u.range).mul(h2.mul(0.7).add(0.3));
  const scatter = vec3(cos(dir).mul(throwR), h3.mul(2.2).mul(k).sub(t.mul(t).mul(0.5)).add(0.3).add(sin(t.mul(5).add(h1.mul(20))).mul(0.15)), sin(dir).mul(throwR));
  // drip: from around a point, falling a meter
  const fall = fract(t.mul(h2.mul(0.8).add(0.9)).add(h1));
  const drip = vec3(cos(dir).mul(u.range).mul(h3), fall.mul(fall).mul(-1.1), sin(dir).mul(u.range).mul(h3));

  m.positionNode = stream.mul(pick(0)).add(orbit.mul(pick(1))).add(scatter.mul(pick(2))).add(drip.mul(pick(3)));
  const sz = u.size.mul(h3.mul(0.6).add(0.7));
  m.scaleNode = vec2(sz, sz);

  const p = uv().sub(0.5).mul(2);
  // bugs: a dark body with two pale wings beating fast
  const beat = abs(sin(u.age.mul(70).add(h1.mul(30))));
  const body = smoothstep(0.42, 0.25, vec2(p.x.mul(2.4), p.y).length());
  const wing = smoothstep(0.5, 0.2, vec2(abs(p.x).sub(0.42).mul(1.6), p.y.sub(0.15).mul(mix(float(2.8), float(1.2), beat))).length());
  const fleck = smoothstep(1, 0, p.length()).pow(1.6);
  const shape = mix(fleck, max(body, wing.mul(0.55)), u.bugs);
  const shown = step(h1, u.count);
  // the stream fades in at the mouth and out at its far end, the drip as it falls
  const ends = mix(float(1), smoothstep(0, 0.12, life).mul(smoothstep(1, 0.75, life)), pick(0)).mul(mix(float(1), float(1).sub(fall), pick(3)));
  const tone = mix(u.main, u.hot, mix(h3.mul(0.5), wing.mul(beat).mul(0.6), u.bugs));
  m.colorNode = vec4(tone.mul(mix(float(2.5), float(1), u.bugs)), 1);
  m.opacityNode = shape.mul(shown).mul(ends).mul(u.fade);
  return m;
}

export interface SwarmOpts {
  x: number;
  y: number;
  z: number;
  /** Facing for a stream (the unit yaw convention: 0 faces -Z). */
  yaw?: number;
  mode: SwarmMode;
  main: number;
  hot: number;
  range: number;
  spread: number;
  size: number;
  life: number;
  bugs?: boolean;
  /** Share of the swarm shown (0..1). */
  count?: number;
}

/** Many small things moving together on the GPU: locusts, whirling debris, feathers, drips. One draw. */
export class Swarm implements Live {
  readonly group: THREE.Sprite;
  private readonly values = swarmUniforms();
  private o!: SwarmOpts;
  /** 0..1 an owner (a zone, an aura) sets to fade it with itself. */
  strength = 1;

  constructor() {
    this.group = instancedSprite((material ??= makeMaterial()), SWARM_SIZE);
    this.group.name = 'swarm';
    this.group.frustumCulled = false;
    this.group.renderOrder = 12;
    useUniforms(this.values, this.group);
  }

  start(o: SwarmOpts): this {
    this.o = o;
    this.strength = 1;
    const v = this.values;
    v.main.setHex(o.main);
    v.hot.setHex(o.hot);
    v.mode = SWARM_MODES[o.mode];
    v.age = 0;
    v.range = o.range;
    v.spread = o.spread;
    v.size = o.size;
    v.bugs = o.bugs ? 1 : 0;
    v.count = o.count ?? 1;
    v.seed = Math.random() * 60;
    this.group.position.set(o.x, o.y, o.z);
    this.group.rotation.set(0, o.yaw ?? 0, 0);
    this.update(0);
    return this;
  }

  move(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
  }

  stop(): void {
    this.o.life = Math.min(this.o.life, this.values.age + 0.4);
  }

  update(dt: number): boolean {
    const v = this.values;
    const k = (v.age += dt);
    const left = this.o.life - k;
    v.fade = Math.min(1, k / 0.15, left / 0.4) * this.strength;
    return k < this.o.life;
  }
}
