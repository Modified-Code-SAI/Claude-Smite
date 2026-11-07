import * as THREE from 'three/webgpu';
import { abs, attribute, exp, float, fract, max, mix, sin, smoothstep, step, uniform, uv, vec2, vec3, vec4 } from '../../render/tsl';
import { spriteQuads } from '../../render/shared';
import type { Palette } from '../../map/UnderworldLayout';

/**
 * What a god's feet throw up off each depth's floor as they come down in the
 * Underworld Descent: flecks of ash and now and then a spark off the forge's
 * hot rock, a spray of drops off the Drowned Halls' wet stone, and motes of
 * spirit light lifting off the Abyss's glass.
 */
export const KICKS = {
  /** Flecks kept at once; the oldest makes room (a team of four sprinting throws up about eighty a second). */
  capacity: 192,
  /**
   * Each kind's: seconds it lasts, its pull (m/s², up is +), how fast the air
   * slows it (1/s), its size (meters on the mannequin), and how strongly it shows.
   * The puffs (dust, mist, glow) swell as they go.
   */
  ash: { life: 1, pull: -1.6, drag: 3, size: 0.11, shows: 0.9 },
  spark: { life: 0.65, pull: -4.5, drag: 1.2, size: 0.06, shows: 1 },
  drop: { life: 0.6, pull: -9.8, drag: 0.8, size: 0.08, shows: 1 },
  mote: { life: 2, pull: 0.5, drag: 1.6, size: 0.14, shows: 1 },
  dust: { life: 0.9, pull: 0.3, drag: 3.5, size: 0.5, shows: 0.55 },
  mist: { life: 0.7, pull: 0.1, drag: 4, size: 0.44, shows: 0.3 },
  glow: { life: 0.9, pull: 0.35, drag: 3, size: 0.46, shows: 0.42 },
  /** How many of each a footfall throws up (one puff besides), and the share of forge steps that strike a spark. */
  per: { ash: 5, drop: 7, mote: 3, spark: 0.45 },
};

const KINDS = ['ash', 'spark', 'drop', 'mote', 'dust', 'mist', 'glow'] as const;
type Kind = (typeof KINDS)[number];
const LONGEST = Math.max(...KINDS.map((k) => KICKS[k].life));

/** Which kind an instance is, from its kind number, as a 0/1 weight. */
const is = (kind: any, k: number) => step(abs(kind.sub(k)), 0.5);
/** A steady 0..1 from any number (the seed of a fleck). */
const hash01 = (v: any) => fract(sin(v.mul(12.9898)).mul(43758.5453));

/**
 * The flecks: every one is a copy of one instanced sprite in one material,
 * moved on the GPU from where and when it was thrown and how fast, so the
 * whole lot is one draw (shown only while some are in the air) that builds
 * no shader as the depths change.
 */
export class DepthKicks {
  readonly sprite: THREE.Sprite;
  private readonly from: THREE.InstancedBufferAttribute;
  private readonly vel: THREE.InstancedBufferAttribute;
  private readonly now = uniform(0);
  private clock = 0;
  private next = 0;
  /** On this clock, when the last fleck thrown is gone. */
  private until = -1;
  private dirty = false;

  constructor(private readonly rand: () => number = Math.random) {
    const n = KICKS.capacity;
    const geo = spriteQuads(n, true);
    // every fleck starts long gone: thrown before the clock began
    const from = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) from[i * 4 + 3] = -1e4;
    this.from = new THREE.InstancedBufferAttribute(from, 4).setUsage(THREE.DynamicDrawUsage);
    this.vel = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('kFrom', this.from);
    geo.setAttribute('kVel', this.vel);
    this.sprite = new THREE.Sprite(this.material());
    this.sprite.geometry = geo;
    this.sprite.name = 'depth-kicks';
    this.sprite.frustumCulled = false;
    this.sprite.matrixAutoUpdate = false;
    this.sprite.renderOrder = 11;
    this.sprite.visible = false;
  }

  private material(): THREE.SpriteNodeMaterial {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const from = attribute('kFrom', 'vec4');
    const vel = attribute('kVel', 'vec4');
    // (kVel.w: the kind in its whole part, the fleck's size in meters its fraction)
    const kind = vel.w.floor();
    const size = vel.w.fract().max(0.005);
    const age = this.now.sub(from.w);
    const w = KINDS.map((_, i) => is(kind, i));
    const [ash, spark, drop, mote, dust, mist, glow] = w;
    const puff = dust.add(mist).add(glow);
    const pick = (key: 'life' | 'pull' | 'drag' | 'shows') => w.reduce((sum: any, wi: any, i: number) => sum.add(wi.mul(KICKS[KINDS[i]!][key])), float(0));
    const life = pick('life');
    const pull = pick('pull');
    const drag = pick('drag');
    const t = age.clamp(0, life);

    // thrown, slowed by the air and pulled down (or, the light and the breath of a puff, up); a mote wanders as it climbs
    const slowed = float(1).sub(exp(drag.negate().mul(t))).div(drag);
    // (each fleck of a footfall is thrown its own way, so its throw tells them apart)
    const seed = from.x.mul(7.31).add(from.z.mul(3.7)).add(vel.x.mul(13.1)).add(vel.z.mul(17.3)).add(vel.y.mul(5.9));
    const wander = vec3(sin(t.mul(2.6).add(seed)), 0, sin(t.mul(2.1).add(seed.mul(1.7)))).mul(t.mul(0.09)).mul(mote);
    const rise = vel.y.mul(slowed).add(pull.mul(t).mul(t).mul(0.5));
    // (what falls comes to rest on the floor it was thrown from)
    const y = max(rise, float(-0.01));
    m.positionNode = from.xyz.add(vec3(vel.x.mul(slowed), y, vel.z.mul(slowed))).add(wander);
    const landed = step(0.0001, t).mul(step(rise, -0.005)).mul(drop.add(spark));

    // how fast it is going up or down now, for the streak of a falling drop and a climbing spark
    const fall = vel.y.mul(exp(drag.negate().mul(t))).add(pull.mul(t)).abs();
    const k = t.div(life);
    const shrink = mix(float(1), float(1).sub(k.mul(0.7)), spark.add(ash.mul(0.5)));
    const swell = mix(float(1), smoothstep(0, 0.25, k).mul(0.6).add(0.4), mote);
    const billow = mix(float(1), float(1).sub(float(1).sub(k).pow(2)).mul(1.05).add(0.45), puff);
    const sz = size.mul(shrink).mul(swell).mul(billow);
    const streak = float(1).add(fall.mul(drop.mul(0.5).add(spark.mul(0.3))));
    const alive = step(age, life).mul(step(0, age)).mul(float(1).sub(landed));
    m.scaleNode = vec2(sz, sz.mul(streak)).mul(alive);

    const r = uv().sub(0.5).mul(2).length();
    const soft = smoothstep(1, 0, r);
    const core = smoothstep(0.5, 0, r);
    // ash: kicked up glowing off the hot rock and cooling grey as it settles, out of a puff of soot; a spark: white-hot, cooling to orange
    const ashTone = mix(vec3(2.6, 0.85, 0.2), vec3(0.2, 0.16, 0.13), smoothstep(0.05, 0.55, k.add(hash01(seed).mul(0.25))));
    const sparkTone = mix(vec3(6, 3.6, 1.7), vec3(3, 0.85, 0.16), smoothstep(0, 0.6, k));
    // a drop catches the soul-light over a breath of spray; a mote is green spirit light, pulsing, over a breath of it
    const pulse = sin(age.mul(9).add(seed)).mul(0.25).add(0.75);
    const tone = ashTone
      .mul(ash)
      .add(sparkTone.mul(spark))
      .add(vec3(1.1, 1.5, 2.1).mul(drop))
      .add(vec3(0.5, 1.9, 1).mul(pulse).mul(mote))
      .add(vec3(0.34, 0.28, 0.24).mul(dust))
      .add(vec3(0.6, 0.76, 0.92).mul(mist))
      .add(vec3(0.24, 1, 0.55).mul(glow));
    m.colorNode = vec4(tone.mul(mix(core.mul(0.6).add(0.7), float(1), puff)), 1);
    const fadeIn = mix(float(1), smoothstep(0, mix(float(0.12), float(0.18), puff), k), mote.add(puff));
    const fadeOut = smoothstep(1, mix(float(0.45), float(0.6), mote).sub(puff.mul(0.25)), k);
    const shape = soft.pow(mix(float(1.4), float(2.2), mote.add(spark).add(puff.mul(0.4))));
    m.opacityNode = shape.mul(pick('shows')).mul(fadeIn).mul(fadeOut).mul(alive);
    return m;
  }

  /**
   * A foot came down at (x, y, z) (y the floor beneath it), the god heading
   * along (dx, dz) (a unit vector), `size` its height against the mannequin's:
   * throws up what the depth's floor holds.
   */
  step(x: number, y: number, z: number, dx: number, dz: number, size: number, palette: Palette): void {
    const rand = this.rand;
    const per = KICKS.per;
    if (palette === 'ember') {
      // ash scuffed up behind the heel and settling out of a puff of its dust, and now and then a spark struck off the rock
      this.throw('dust', x - dx * 0.1 * size, y + 0.14 * size, z - dz * 0.1 * size, -dx * 0.5 * size, 0.3 * size, -dz * 0.5 * size, size * (0.85 + rand() * 0.3));
      for (let i = 0; i < per.ash; i++) {
        const back = 0.35 + rand() * 0.9;
        const side = (rand() - 0.5) * 1.1;
        this.throw('ash', x, y + 0.04, z, (-dx * back + dz * side) * size, (0.5 + rand() * 0.8) * size, (-dz * back - dx * side) * size, size * (0.7 + rand() * 0.6));
      }
      if (rand() < per.spark) {
        const a = rand() * Math.PI * 2;
        const out = 0.3 + rand() * 0.6;
        this.throw('spark', x, y + 0.05, z, Math.sin(a) * out * size, (1.6 + rand() * 1.4) * size, Math.cos(a) * out * size, size * (0.8 + rand() * 0.5));
      }
    } else if (palette === 'soul') {
      // a spray off the wet stone, flung out round the foot and pattering back down through a breath of mist
      this.throw('mist', x, y + 0.08 * size, z, dx * 0.35 * size, 0.12 * size, dz * 0.35 * size, size * (0.85 + rand() * 0.3));
      for (let i = 0; i < per.drop; i++) {
        const a = rand() * Math.PI * 2;
        const out = 0.4 + rand() * 0.9;
        // (more of it thrown on ahead than back)
        const ahead = 0.35 + rand() * 0.45;
        this.throw('drop', x, y + 0.03, z, (Math.sin(a) * out + dx * ahead) * size, (0.9 + rand() * 1.1) * size, (Math.cos(a) * out + dz * ahead) * size, size * (0.7 + rand() * 0.6));
      }
    } else {
      // spirit light shaken loose from the glass in a soft breath of it, drifting up out of the print
      this.throw('glow', x, y + 0.12 * size, z, 0, 0.2 * size, 0, size * (0.85 + rand() * 0.3));
      for (let i = 0; i < per.mote; i++) {
        const a = rand() * Math.PI * 2;
        const out = 0.08 + rand() * 0.22;
        this.throw('mote', x + Math.sin(a) * 0.08, y + 0.06, z + Math.cos(a) * 0.08, Math.sin(a) * out * size, (0.2 + rand() * 0.35) * size, Math.cos(a) * out * size, size * (0.7 + rand() * 0.7));
      }
    }
  }

  private throw(kind: Kind, x: number, y: number, z: number, vx: number, vy: number, vz: number, scale: number): void {
    const i = this.next;
    this.next = (this.next + 1) % KICKS.capacity;
    const size = Math.min(0.999, KICKS[kind].size * scale);
    this.from.setXYZW(i, x, y, z, this.clock);
    this.vel.setXYZW(i, vx, vy, vz, KINDS.indexOf(kind) + size);
    this.until = this.clock + LONGEST;
    this.dirty = true;
  }

  /** Every fleck gone at once (the team moved on to the next chamber). */
  clear(): void {
    const a = this.from.array as Float32Array;
    for (let i = 0; i < KICKS.capacity; i++) a[i * 4 + 3] = -1e4;
    this.from.needsUpdate = true;
    this.until = -1;
    this.sprite.visible = false;
  }

  update(dt: number): void {
    this.clock += dt;
    this.now.value = this.clock;
    if (this.dirty) {
      this.from.needsUpdate = true;
      this.vel.needsUpdate = true;
      this.dirty = false;
    }
    this.sprite.visible = this.clock < this.until;
  }

  /** Shows the flecks for the loading frames that prepare shaders; returns the undo. */
  prime(): () => void {
    const shown = this.sprite.visible;
    this.sprite.visible = true;
    return () => {
      this.sprite.visible = shown;
    };
  }
}
