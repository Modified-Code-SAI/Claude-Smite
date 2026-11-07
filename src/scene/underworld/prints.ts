import * as THREE from 'three/webgpu';
import { attribute, float, length, max, min, mix, mx_noise_float, smoothstep, step, uniform, vec2, vec3 } from '../../render/tsl';
import { depthLook } from './palettes';

/**
 * Where the gods have walked in the Underworld Descent: each footfall marks
 * the depth's floor its own way, and the mark fades as the next ones come.
 */
export const TRACKS = {
  /** Prints kept at once; the oldest makes room (a team of four sprinting lays about ten a second). */
  capacity: 96,
  /** Seconds a print lasts, fading over its last `fade`. */
  life: 9,
  fade: 4.5,
  /** A boot's size on a god of the UAL mannequin's height (meters), and how far behind the ball of the foot its middle sits. */
  foot: { length: 0.44, width: 0.2, behind: 0.08 },
  /** Raised off the floor this much, so it never sinks into it. */
  lift: 0.03,
  /** A step on wet stone sends rings out this far (meters on the mannequin) over `time` seconds; its print is drawn on a square that wide. */
  ripple: { reach: 0.6, time: 0.9 },
};

const VERTS = 4;

/**
 * The tracks: every print in one mesh and one draw. A footfall rewrites its
 * slot's four corners (each dropped onto the floor) and the shader draws a
 * boot sole from each corner's place on the print, in the depth's own way
 * (`depthLook`, so going down a depth builds no shader):
 *
 * - the Ashen Depths: a scuff pressed through the ash to the dark rock, its
 *   rim pushed up pale, the embers in it glowing a moment as the foot lands;
 * - the Drowned Halls: a wet print, dark and glossy with the soul-light
 *   caught round its edge, drying in from it, the step sending a ripple or
 *   two out across the wet stone;
 * - the Abyss: a print of faint green spirit light, brightest round its rim,
 *   flaring as the foot lands.
 */
export class DepthTracks {
  readonly mesh: THREE.Mesh;
  private readonly position: THREE.BufferAttribute;
  private readonly local: THREE.BufferAttribute;
  private readonly info: THREE.BufferAttribute;
  private readonly now = uniform(0);
  private clock = 0;
  private next = 0;

  constructor(private readonly ground: (x: number, z: number) => number) {
    const n = TRACKS.capacity * VERTS;
    const geo = new THREE.BufferGeometry();
    // every corner starts at the origin: no area, nothing drawn, until a print takes the slot
    this.position = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.local = new THREE.BufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.info = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const normal = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) normal[i * 3 + 1] = 1;
    geo.setAttribute('position', this.position);
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setAttribute('tLocal', this.local);
    geo.setAttribute('tInfo', this.info);
    const index: number[] = [];
    // corners: back left, back right, front left, front right; wound to face up
    for (let s = 0; s < TRACKS.capacity; s++) index.push(s * 4, s * 4 + 1, s * 4 + 2, s * 4 + 1, s * 4 + 3, s * 4 + 2);
    geo.setIndex(index);
    this.mesh = new THREE.Mesh(geo, this.material());
    this.mesh.name = 'depth-tracks';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 4;
  }

  private material(): THREE.MeshStandardNodeMaterial {
    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, metalness: 0 });
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -4;
    const p = attribute('tLocal', 'vec2');
    const info = attribute('tInfo', 'vec3');
    const age = this.now.sub(info.y);
    const seed = info.z;
    const forge = depthLook.x;
    const drowned = depthLook.y;
    const abyss = depthLook.z;

    // a boot sole, toes +y; the right is the left mirrored, the ball leaning to the inside
    const fx = mix(p.x, p.x.negate(), info.x);
    const ellipse = (cx: number, cy: number, rx: number, ry: number) => length(vec2(fx.sub(cx).div(rx), p.y.sub(cy).div(ry))).sub(1);
    const heel = ellipse(0, -0.56, 0.6, 0.4);
    const ball = ellipse(0.07, 0.28, 0.8, 0.66);
    const k = 0.4;
    const h = max(float(k).sub(heel.sub(ball).abs()), 0).div(k);
    const sole = min(heel, ball).sub(h.mul(h).mul(k * 0.25));
    // the tread and the scatter of whatever the floor holds, each print its own stretch of noise
    const grain = mx_noise_float(vec2(p.x.mul(3.2).add(seed), p.y.mul(7.5).sub(seed.mul(0.61)))).mul(0.5).add(0.5);
    const tread = smoothstep(0.35, 0.65, mx_noise_float(vec2(fx.mul(2.2), p.y.mul(11).add(seed.mul(1.7)))).mul(0.5).add(0.5));

    // fades as it ages: the wet print dries in from its edge, the others thin out in patches
    const left = smoothstep(TRACKS.life, TRACKS.life - TRACKS.fade, age);
    const shrink = drowned.mul(float(1).sub(left).mul(0.75));
    const inside = smoothstep(0.03, -0.1, sole.add(shrink));
    const rim = smoothstep(-0.22, -0.04, sole).mul(smoothstep(0.12, -0.01, sole));
    const patchy = smoothstep(float(1).sub(left).sub(0.2), float(1).sub(left).add(0.2), grain.mul(0.8).add(0.2));
    const grow = smoothstep(0, 0.05, age);
    // rings running out from a wet step (meters from the print's middle; only a rippling print's square reaches them)
    const f = TRACKS.foot;
    const out = length(vec2(p.x.mul(f.width / 2), p.y.mul(f.length / 2)));
    const { reach, time } = TRACKS.ripple;
    const ring = (delay: number, speed: number) => {
      const a = age.sub(delay);
      const r = a.mul(speed).add(0.1);
      return smoothstep(a.mul(0.05).add(0.03), 0, out.sub(r).abs()).mul(smoothstep(time, 0, a)).mul(step(0, a));
    };
    const ripple = max(ring(0, 0.62), ring(0.16, 0.46).mul(0.6)).mul(smoothstep(reach, reach * 0.75, out));

    // -- the forge: the dark rock under the ash, a pale rim of ash pushed up, and embers in it glowing as it lands
    const hot = smoothstep(2, 0, age);
    const ashA = inside.mul(tread.mul(0.25).add(0.6)).add(rim.mul(0.55)).mul(patchy);
    const ashColor = mix(vec3(0.016, 0.013, 0.012), vec3(0.42, 0.38, 0.34), rim.mul(0.85));
    const embers = smoothstep(0.5, 0.85, grain).mul(inside).mul(hot).mul(patchy);
    // -- the Drowned Halls: darker and glossy where the water lies, the soul-light caught round its edge
    const wetA = inside.mul(0.72).add(rim.mul(0.2)).mul(tread.mul(0.2).add(0.8));
    const wetColor = vec3(0.006, 0.01, 0.016);
    const sheen = rim.mul(0.8).add(inside.mul(tread).mul(0.12)).mul(left);
    // -- the Abyss: spirit light, brightest round the rim, drawing in as it fades
    const ghostA = inside.mul(0.4).add(rim.mul(0.7)).mul(patchy);
    const ghostColor = vec3(0.01, 0.03, 0.02);
    const flare = smoothstep(0.4, 0, age).mul(2.5).add(1);
    const ghost = rim.mul(1.1).add(inside.mul(tread.mul(0.35).add(0.15))).mul(left.mul(0.7).add(0.3)).mul(patchy).mul(flare);

    m.colorNode = ashColor.mul(forge).add(wetColor.mul(drowned)).add(ghostColor.mul(abyss));
    m.roughnessNode = forge.mul(0.95).add(drowned.mul(0.08)).add(abyss.mul(0.6));
    m.emissiveNode = vec3(1, 0.36, 0.08)
      .mul(embers.mul(forge).mul(2.4))
      .add(vec3(0.3, 0.62, 1).mul(sheen.mul(0.5).add(ripple.mul(0.95)).mul(drowned)))
      .add(vec3(0.25, 1, 0.55).mul(ghost.mul(abyss).mul(1.8)));
    m.opacityNode = ashA.mul(forge).add(wetA.add(ripple.mul(0.4)).mul(drowned)).add(ghostA.mul(abyss)).mul(left).mul(grow).clamp(0, 1);
    return m;
  }

  /**
   * A foot came down with the ball of it at (x, z), the god heading along
   * (dx, dz) (a unit vector), `size` its height against the mannequin's.
   * A `ripple` print (wet stone) is drawn on a square wide enough for its rings.
   */
  step(x: number, z: number, dx: number, dz: number, right: boolean, size: number, ripple = false): void {
    const f = TRACKS.foot;
    const cx = x - dx * f.behind * size;
    const cz = z - dz * f.behind * size;
    const s = this.next;
    this.next = (this.next + 1) % TRACKS.capacity;
    // across the print (its right) and along it
    const rx = -dz;
    const rz = dx;
    // the square's half sides, and the boot's own across them (the shader draws the sole in -1..1 of those)
    const hw = (ripple ? TRACKS.ripple.reach : f.width / 2) * size;
    const hl = (ripple ? TRACKS.ripple.reach : f.length / 2) * size;
    const lw = hw / ((f.width / 2) * size);
    const ll = hl / ((f.length / 2) * size);
    const pos = this.position.array as Float32Array;
    const loc = this.local.array as Float32Array;
    const inf = this.info.array as Float32Array;
    const seed = Math.random() * 40;
    for (let c = 0; c < VERTS; c++) {
      const u = c & 1 ? 1 : -1;
      const v = c & 2 ? 1 : -1;
      const px = cx + rx * u * hw + dx * v * hl;
      const pz = cz + rz * u * hw + dz * v * hl;
      const o = s * VERTS + c;
      pos[o * 3] = px;
      pos[o * 3 + 1] = this.ground(px, pz) + TRACKS.lift;
      pos[o * 3 + 2] = pz;
      loc[o * 2] = u * lw;
      loc[o * 2 + 1] = v * ll;
      inf[o * 3] = right ? 1 : 0;
      inf[o * 3 + 1] = this.clock;
      inf[o * 3 + 2] = seed;
    }
    this.position.needsUpdate = true;
    this.local.needsUpdate = true;
    this.info.needsUpdate = true;
  }

  /** Wipes every print (the team has gone on to another chamber). */
  clear(): void {
    (this.position.array as Float32Array).fill(0);
    this.position.needsUpdate = true;
  }

  update(dt: number): void {
    this.clock += dt;
    this.now.value = this.clock;
  }
}
