import * as THREE from 'three/webgpu';
import { abs, attribute, float, length, max, min, mix, mx_noise_float, smoothstep, step, uniform, vec2, vec3 } from '../../render/tsl';
import { depthLook } from './palettes';

/**
 * Where the fighting has struck the floor in the Underworld Descent: every
 * big blow leaves its mark in the depth's own way, and the mark fades as the
 * fight moves on.
 */
export const SCARS = {
  /** Marks kept at once; the oldest makes room. */
  capacity: 40,
  /** Seconds a mark lasts, fading over its last `fade`. */
  life: 14,
  fade: 6,
  /** The square drawn round a mark, in its radii: room for its ragged rim, or for rings to run out past its edge (the Drowned Halls'). */
  extent: 1.35,
  ringsExtent: 1.7,
  /** Vertices along each side of a mark's square, every one dropped onto the floor beneath it, so a wide mark lies on an uneven floor. */
  grid: 5,
  /** Raised off the floor this much, so it never sinks into it. */
  lift: 0.04,
  /** The smallest blast that marks the floor and the widest mark drawn (meters). */
  minRadius: 1.8,
  maxRadius: 6,
  /** A Drowned Halls mark's rings: how far they run (in its radii) over `time` seconds. */
  rings: { reach: 1.6, time: 1.5 },
};

/** A struck area, as the sim flashes it (see FlashShape). */
export type ScarShape =
  | { type: 'circle'; x: number; z: number; radius: number }
  | { type: 'line'; x: number; z: number; yaw: number; length: number; width: number }
  | { type: 'cone'; x: number; z: number; yaw: number; range: number; angle: number };

/**
 * The round marks a struck area leaves (x, z, radius): one for a blast, a
 * row along a line, one out in front for a cone; none for one too small to
 * mark the floor.
 */
export function scarsFor(s: ScarShape): { x: number; z: number; r: number }[] {
  const { minRadius, maxRadius } = SCARS;
  const clamp = (r: number) => Math.min(maxRadius, r);
  if (s.type === 'circle') return s.radius >= minRadius ? [{ x: s.x, z: s.z, r: clamp(s.radius) }] : [];
  // (a shape's forward is (-sin yaw, -cos yaw))
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  if (s.type === 'line') {
    const r = s.width * 0.7;
    if (r * 2 < minRadius * 0.8 || s.length < minRadius) return [];
    const n = Math.max(1, Math.min(5, Math.round(s.length / (r * 1.6))));
    const marks: { x: number; z: number; r: number }[] = [];
    for (let k = 0; k < n; k++) {
      const t = ((k + 0.5) / n) * s.length;
      marks.push({ x: s.x + fx * t, z: s.z + fz * t, r: clamp(Math.max(minRadius * 0.6, r)) });
    }
    return marks;
  }
  const along = s.range * 0.55;
  const r = Math.min(s.range * 0.5, along * Math.sin(((s.angle / 2) * Math.PI) / 180) + 0.4);
  return r >= minRadius * 0.8 ? [{ x: s.x + fx * along, z: s.z + fz * along, r: clamp(r) }] : [];
}

/**
 * The marks: every one in one mesh and one draw. A blow rewrites its slot's
 * grid of vertices (each dropped onto the floor) and the shader draws the
 * mark from each vertex's place on it, in the depth's own way (`depthLook`,
 * so going down a depth builds no shader):
 *
 * - the Ashen Depths: a scorch blown into the ash, black at the heart and
 *   streaked outward, the ash thrown up into a pale rim, embers in it glowing
 *   and cooling;
 * - the Drowned Halls: the water thrown out of the stone, a dark glossy
 *   splash with wet specks round it, drying in from its edge, and rings
 *   running out across the wet floor;
 * - the Abyss: a spirit burn, cracks of green light through the stone and a
 *   glowing rim, flaring as the blow lands.
 */
export class DepthScars {
  readonly mesh: THREE.Mesh;
  private readonly position: THREE.BufferAttribute;
  private readonly local: THREE.BufferAttribute;
  private readonly info: THREE.BufferAttribute;
  private readonly now = uniform(0);
  private clock = 0;
  private next = 0;

  constructor(private readonly ground: (x: number, z: number) => number) {
    const g = SCARS.grid;
    const per = g * g;
    const n = SCARS.capacity * per;
    const geo = new THREE.BufferGeometry();
    // every vertex starts at the origin: no area, nothing drawn, until a mark takes the slot
    this.position = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.local = new THREE.BufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.info = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const normal = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) normal[i * 3 + 1] = 1;
    geo.setAttribute('position', this.position);
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setAttribute('sLocal', this.local);
    geo.setAttribute('sInfo', this.info);
    const index: number[] = [];
    for (let s = 0; s < SCARS.capacity; s++) {
      const b = s * per;
      // vertex (i, j) at b + j * g + i, i along x and j along z; wound to face up
      for (let j = 0; j < g - 1; j++) {
        for (let i = 0; i < g - 1; i++) {
          const a = b + j * g + i;
          index.push(a, a + g, a + 1, a + 1, a + g, a + g + 1);
        }
      }
    }
    geo.setIndex(index);
    this.mesh = new THREE.Mesh(geo, this.material());
    this.mesh.name = 'depth-scars';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    // (under the gods' prints, which are laid over it)
    this.mesh.renderOrder = 3;
  }

  private material(): THREE.MeshStandardNodeMaterial {
    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, metalness: 0 });
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -3;
    // each vertex's place on the mark in its radii, and the mark's birth, seed and radius (meters)
    const p = attribute('sLocal', 'vec2');
    const info = attribute('sInfo', 'vec3');
    const age = this.now.sub(info.x);
    const seed = info.y;
    const size = info.z;
    const forge = depthLook.x;
    const drowned = depthLook.y;
    const abyss = depthLook.z;

    const d0 = length(p);
    const dir = p.div(max(d0, 0.001));
    // a ragged edge (noise round the rim), and lines thrown out from the heart (noise that turns with the direction, bent a little as it runs out)
    const rag = mx_noise_float(vec2(dir.x.mul(1.7).add(seed), dir.y.mul(1.7).sub(seed))).mul(0.17);
    const rays = (k: number, width: number, shift: number) =>
      smoothstep(width, 0, abs(mx_noise_float(vec2(dir.x.mul(k).add(d0.mul(0.9)).add(seed.mul(shift)), dir.y.mul(k).sub(d0.mul(0.6))))));
    // the floor's grain under it, about half a meter across whatever the mark's size
    const meters = p.mul(size);
    const grain = mx_noise_float(meters.mul(1.9).add(seed)).mul(0.5).add(0.5);
    const fine = mx_noise_float(meters.mul(6.5).sub(seed.mul(0.7))).mul(0.5).add(0.5);

    // fades as it ages, in patches; blown out to its full size the moment it lands
    const left = smoothstep(SCARS.life, SCARS.life - SCARS.fade, age);
    const grow = smoothstep(0, 0.04, age);
    const spread = smoothstep(0, 0.16, age).mul(0.45).add(0.55);
    const d = d0.add(rag).div(spread);
    const inside = smoothstep(1, 0.78, d);
    const core = smoothstep(0.8, 0.05, d);
    // (the rim broken up by the grain, so it never draws as an outline)
    const rimIn = smoothstep(0.7, 0.93, d).mul(smoothstep(1.16, 0.98, d));
    const rim = rimIn.mul(smoothstep(0.3, 0.75, grain));
    const patchy = smoothstep(float(1).sub(left).sub(0.2), float(1).sub(left).add(0.2), grain.mul(0.8).add(0.2));

    // -- the forge: soot black at the heart, raked with paler streaks thrown outward, ash heaped up round it; molten a moment, then a few embers cooling
    const hot = smoothstep(5, 0, age);
    const streaks = rays(5.5, 0.22, 1.3).mul(smoothstep(0.15, 0.7, d));
    const soot = mix(vec3(0.008, 0.006, 0.005), vec3(0.075, 0.064, 0.056), streaks.mul(0.8).add(min(d, 1).mul(0.2)));
    const ashColor = mix(soot, vec3(0.4, 0.36, 0.32), rim.mul(0.8));
    const ashA = inside.mul(core.mul(0.22).add(0.7)).add(rim.mul(0.4)).mul(patchy);
    const molten = core.mul(core).mul(smoothstep(1.3, 0, age));
    const embers = smoothstep(0.78, 0.88, fine).mul(smoothstep(0.45, 0.7, grain)).mul(inside).mul(patchy);
    const emberGlow = mix(vec3(0.5, 0.06, 0.01), vec3(1, 0.48, 0.12), hot)
      .mul(embers.mul(hot).mul(hot.mul(2).add(0.3)))
      .add(vec3(1, 0.42, 0.08).mul(molten.mul(2.6)));
    // -- the Drowned Halls: a dark glossy splash drying in from its edge, wet specks thrown round it, rings running out
    const dry = float(1).sub(left).mul(0.7);
    const wet = smoothstep(1, 0.8, d.add(dry));
    const specks = smoothstep(0.74, 0.8, fine).mul(smoothstep(0.95, 1.05, d)).mul(smoothstep(1.5, 1.25, d)).mul(left);
    const wetA = wet.mul(0.62).add(specks.mul(0.55));
    const { reach, time } = SCARS.rings;
    const ring = (delay: number, speed: number) => {
      const a = age.sub(delay);
      const r = a.mul(speed).add(0.55);
      // (a ring's width in meters, so a wide splash doesn't draw fat rings)
      const w = a.mul(0.07).add(0.06).div(size);
      return smoothstep(w, 0, d0.sub(r).abs()).mul(smoothstep(time, 0, a)).mul(step(0, a));
    };
    const rings = max(max(ring(0, 0.85), ring(0.2, 0.62).mul(0.65)), ring(0.45, 0.48).mul(0.4)).mul(smoothstep(reach + 0.08, reach - 0.25, d0));
    const wetColor = vec3(0.006, 0.01, 0.016);
    // the soul-light caught softly along the water's edge, where the grain lets it
    const shore = smoothstep(0.55, 0.9, d.add(dry)).mul(smoothstep(1.08, 0.92, d.add(dry)));
    const sheen = shore.mul(grain).mul(0.7).add(wet.mul(grain).mul(0.08)).mul(left);
    // -- the Abyss: a spirit burn, fractures of green light running out from the heart and a broken glowing rim, flaring as it lands
    const fractures = rays(4.5, 0.05, 0.9)
      .mul(smoothstep(0.04, 0.2, d))
      .mul(smoothstep(1.02, 0.3, d))
      .add(smoothstep(0.035, 0, abs(mx_noise_float(meters.mul(0.75).add(seed.mul(0.9))))).mul(inside).mul(0.6));
    const flare = smoothstep(0.7, 0, age).mul(2.5).add(1);
    const ghostA = inside.mul(0.38).add(rim.mul(0.35)).add(fractures.mul(0.3)).mul(patchy);
    const ghostColor = vec3(0.01, 0.03, 0.02);
    // (the landing flares from the heart and along the fractures; the rim only smoulders)
    const ghost = rim.mul(0.7).add(fractures.mul(1.1).add(core.mul(0.2)).mul(flare)).mul(left.mul(0.7).add(0.3)).mul(patchy);

    m.colorNode = ashColor.mul(forge).add(wetColor.mul(drowned)).add(ghostColor.mul(abyss));
    m.roughnessNode = forge.mul(0.97).add(drowned.mul(0.07)).add(abyss.mul(0.6));
    m.emissiveNode = emberGlow
      .mul(forge)
      .add(vec3(0.3, 0.62, 1).mul(sheen.mul(0.45).add(rings.mul(0.85)).mul(drowned)))
      .add(vec3(0.25, 1, 0.55).mul(ghost.mul(abyss).mul(1.25)));
    m.opacityNode = ashA
      .mul(forge)
      .mul(left)
      .add(wetA.mul(left).add(rings.mul(0.4)).mul(drowned))
      .add(ghostA.mul(left).mul(abyss))
      .mul(grow)
      .clamp(0, 1);
    return m;
  }

  /** A blow struck the floor round (x, z), `r` meters across its middle; on wet stone (`rings`) it sends rings out across it. */
  mark(x: number, z: number, r: number, rings = false): void {
    const g = SCARS.grid;
    const extent = rings ? SCARS.ringsExtent : SCARS.extent;
    const s = this.next;
    this.next = (this.next + 1) % SCARS.capacity;
    const pos = this.position.array as Float32Array;
    const loc = this.local.array as Float32Array;
    const inf = this.info.array as Float32Array;
    const seed = Math.random() * 40;
    for (let j = 0; j < g; j++) {
      for (let i = 0; i < g; i++) {
        const u = (i / (g - 1)) * 2 - 1;
        const v = (j / (g - 1)) * 2 - 1;
        const px = x + u * extent * r;
        const pz = z + v * extent * r;
        const o = s * g * g + j * g + i;
        pos[o * 3] = px;
        pos[o * 3 + 1] = this.ground(px, pz) + SCARS.lift;
        pos[o * 3 + 2] = pz;
        loc[o * 2] = u * extent;
        loc[o * 2 + 1] = v * extent;
        inf[o * 3] = this.clock;
        inf[o * 3 + 1] = seed;
        inf[o * 3 + 2] = r;
      }
    }
    this.position.needsUpdate = true;
    this.local.needsUpdate = true;
    this.info.needsUpdate = true;
  }

  /** Wipes every mark (the team has gone on to another chamber). */
  clear(): void {
    (this.position.array as Float32Array).fill(0);
    this.position.needsUpdate = true;
  }

  update(dt: number): void {
    this.clock += dt;
    this.now.value = this.clock;
  }
}
