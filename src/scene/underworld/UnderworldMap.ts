import * as THREE from 'three/webgpu';
import { rng } from '../../core/random';
import { slice } from '../../core/slices';
import {
  addUnderworldColliders, CHAMBERS, chamberField, entranceSpot, GATE, type ChamberDef, type Palette,
} from '../../map/UnderworldLayout';
import {
  abs, atan, cameraPosition, cos, dot, exp, float, length, mix, mx_fractal_noise_float, mx_noise_float, normalWorld, positionWorld, sin, smoothstep, time,
  transformNormalToView, uv, vec2, vec3, vec4,
} from '../../render/tsl';
import type { QualitySettings } from '../../render/Quality';
import { boulder, chippedBlock, lathe } from '../Architecture';
import type { CollisionWorld } from '../Collision';
import { Fire } from '../Effects';
import { triplanar, type MaterialLibrary } from '../Materials';
import { mergeStatic } from '../merge';
import type { MapContent } from '../World';
import { DEPTH_COLORS, gateOpen, underworldGlow } from './palettes';
import { showRunes } from './UnderworldTerrain';

/** How tall the gate pylons stand, and the lintel across them. */
const PYLON_H = 7.2;
const LINTEL_Y = 6.4;

/**
 * The underworld's scenery: in each of the six chambers, obsidian columns,
 * bronze braziers of soul fire, glowing crystals and fallen rock along the
 * walls, and a gate at each end whose doorway lights up once the chamber is
 * cleared. Only the chamber the team is in is shown (the walls hide the rest),
 * and each chamber is baked into a handful of draws, one per material.
 */
export class UnderworldMap implements MapContent {
  readonly group = new THREE.Group();
  readonly fires: Fire[] = [];
  readonly lights: THREE.PointLight[] = [];
  readonly spawn: { x: number; z: number; yaw: number };
  readonly groundColor = new THREE.Color(0.05, 0.045, 0.055);
  /** Each chamber's scenery, in CHAMBERS order. */
  readonly chambers: THREE.Group[] = [];
  private shown = -1;
  private palette: Palette = 'ember';
  private readonly mats: ReturnType<typeof underworldMaterials>;

  private constructor(mats: MaterialLibrary) {
    this.group.name = 'underworld';
    this.mats = underworldMaterials(mats);
    const at = entranceSpot(CHAMBERS[0]!);
    this.spawn = { x: at.x, z: at.z, yaw: at.yaw };
  }

  static async create(mats: MaterialLibrary, collision: CollisionWorld): Promise<UnderworldMap> {
    const m = new UnderworldMap(mats);
    addUnderworldColliders(collision);
    for (let i = 0; i < CHAMBERS.length; i++) {
      m.chambers.push(m.buildChamber(CHAMBERS[i]!, i));
      await slice();
    }
    m.show(0);
    return m;
  }

  /** Shows one chamber's scenery and hides the rest (their lights drop out of the light pool too). */
  show(i: number): void {
    if (i === this.shown) return;
    this.shown = i;
    this.chambers.forEach((g, k) => (g.visible = k === i));
    showRunes(i);
  }

  /** Relights the underworld in a depth's colors: the glow, the fires and their lights. */
  setPalette(p: Palette): boolean {
    if (p === this.palette) return false;
    this.palette = p;
    const c = DEPTH_COLORS[p];
    underworldGlow.value.setHex(c.glow);
    for (const f of this.fires) {
      if (f.group.userData.gateFire) continue;
      f.low.setHex(c.fire.low);
      f.high.setHex(c.fire.high);
      f.ember.setHex(c.fire.ember);
      f.light.color.setHex(c.fire.light);
    }
    return true;
  }

  private buildChamber(c: ChamberDef, index: number): THREE.Group {
    const g = new THREE.Group();
    g.name = `chamber-${index}`;
    // hidden chambers still get their shaders prepared while the map loads
    g.userData.shownLater = true;
    const random = rng(4100 + index * 31);
    const keep: THREE.Object3D[] = [];
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, cast = true): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };

    // obsidian columns: faceted, tapering monoliths with a carved collar
    for (const [x, z, r] of c.pillars) {
      const h = 9 + random() * 3.5;
      const column = add(obsidianColumn(r, h, Math.floor(random() * 1e5)), this.mats.obsidian, x, 0, z);
      column.rotation.y = random() * Math.PI;
    }

    // braziers against the walls
    const plinth = chippedBlock(1.1, 0.7, 1.1, 4100);
    const bowl = braZierBowl();
    const coalGeo = new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.25, 1);
    c.fires.forEach(([x, z], i) => {
      add(plinth, this.mats.obsidian, x, 0.3, z).rotation.y = random() * Math.PI;
      add(bowl, this.mats.bronze, x, 0.65, z);
      add(coalGeo, this.mats.coals, x, 0.65 + 0.84, z, false);
      const pal = DEPTH_COLORS.ember.fire;
      const fire = new Fire(new THREE.Vector3(x, 1.5, z), 0.9, index * 13.1 + i * 7.3, 22, pal);
      g.add(fire.group);
      keep.push(fire.group);
      this.fires.push(fire);
      this.lights.push(fire.light);
    });

    // the gates: two pylons and a lintel at each end, and the doorway's veil
    for (const side of [-1, 1]) {
      const zc = side * (c.extent + 0.6);
      for (const sx of [-1, 1]) {
        const pylon = add(chippedBlock(1.7, PYLON_H, 2.6, 4200 + index * 7 + sx + side * 3, 0.05), this.mats.obsidian, sx * GATE.pylon, PYLON_H / 2, zc);
        pylon.rotation.y = 0;
        add(chippedBlock(2.1, 0.5, 3.0, 4300 + index + sx), this.mats.obsidian, sx * GATE.pylon, PYLON_H + 0.25, zc);
      }
      add(chippedBlock(GATE.pylon * 2 + 2.2, 1.1, 2.2, 4400 + index * 3 + side), this.mats.obsidian, 0, LINTEL_Y + 0.55, zc);
      // the exit (north) opens when the chamber is cleared; the way back in stays sealed
      const veil = new THREE.Mesh(new THREE.PlaneGeometry(GATE.halfWidth * 2 + 0.4, LINTEL_Y, 1, 1), side < 0 ? this.mats.portal : this.mats.sealed);
      veil.position.set(0, LINTEL_Y / 2, side * (c.extent + GATE.depth - 0.4));
      veil.castShadow = false;
      veil.receiveShadow = false;
      veil.renderOrder = 5;
      g.add(veil);
      keep.push(veil);
      // a flame on each exit pylon, white-hot in every depth, so the way on is easy to find
      if (side < 0) {
        for (const sx of [-1, 1]) {
          const f = new Fire(new THREE.Vector3(sx * GATE.pylon, PYLON_H + 0.55, zc), 0.75, index * 5.7 + sx, 16, { low: 0xff6a20, high: 0xfff2c8, ember: 0xffc080, light: 0xffc890 });
          f.group.userData.gateFire = true;
          g.add(f.group);
          keep.push(f.group);
          this.fires.push(f);
          this.lights.push(f.light);
        }
      }
    }

    // fallen rock and soul crystals along the foot of the walls
    const rocks = Array.from({ length: 6 }, (_, i) => boulder(1, 4500 + i * 13, 3));
    const crystal = crystalCluster(4600 + index);
    const steps = 72;
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2 + random() * 0.05;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      // walk out from the middle to the wall
      let r = 2;
      while (r < 40 && chamberField(c, dx * r, dz * r) > -0.4) r += 0.35;
      const x = dx * r;
      const z = dz * r;
      // keep the gates' doorways clear
      if (Math.abs(x) < GATE.halfWidth + 2.5 && Math.abs(z) > c.extent - 6) continue;
      if (c.pit && r < c.pit + 1) continue;
      if (k % 9 === 4) {
        const cr = add(crystal, this.mats.crystal, x * 1.01, -0.2, z * 1.01, false);
        cr.rotation.set((random() - 0.5) * 0.5, random() * Math.PI, (random() - 0.5) * 0.5);
        cr.scale.setScalar(0.8 + random() * 0.7);
        continue;
      }
      const s = 1.1 + random() * 1.9;
      const rock = add(rocks[k % rocks.length]!, this.mats.basalt, x + dx * s * 0.45, s * 0.05, z + dz * s * 0.45);
      rock.scale.set(s, s * (0.7 + random() * 0.6), s);
      rock.rotation.y = random() * Math.PI * 2;
    }

    if (c.pit) keep.push(this.buildPit(g, c.pit));
    if (c.boss) this.buildThrone(add, c);

    mergeStatic(g, keep);
    g.position.set(c.x, 0, c.z);
    this.group.add(g);
    return g;
  }

  /** The Burning Pit's lake of fire, lit from below. */
  private buildPit(g: THREE.Group, r: number): THREE.Object3D {
    const lake = new THREE.Mesh(new THREE.CircleGeometry(r + 0.4, 64).rotateX(-Math.PI / 2), this.mats.lava);
    lake.position.y = -0.9;
    lake.receiveShadow = false;
    lake.castShadow = false;
    const light = new THREE.PointLight(DEPTH_COLORS.ember.glow, 60, 26, 2);
    light.position.y = 1.2;
    light.castShadow = false;
    lake.add(light);
    this.lights.push(light);
    g.add(lake);
    return lake;
  }

  /** The boss arena's dais and broken colossi along the walls. */
  private buildThrone(add: (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, cast?: boolean) => THREE.Mesh, c: ChamberDef): void {
    // a low round dais under the boss's spot
    const dais = lathe([[0, 0], [7.4, 0], [7.4, 0.12], [7.1, 0.2], [0, 0.2]], 64);
    add(dais, this.mats.obsidian, 0, -0.08, -c.extent * 0.35, false);
    // four great broken statues' plinths and stumps against the walls
    for (const a of [35, 145, 215, 325]) {
      const rad = (a * Math.PI) / 180;
      const x = Math.cos(rad) * (c.extent - 2.6);
      const z = Math.sin(rad) * (c.extent - 2.6);
      add(chippedBlock(3.2, 2.2, 3.2, 4700 + a), this.mats.obsidian, x, 1.1, z).rotation.y = -rad;
      add(obsidianColumn(1.2, 5 + (a % 3), 4800 + a), this.mats.obsidian, x, 2.2, z).rotation.y = rad;
    }
  }

  applyQuality(_q: QualitySettings): void {}

  update(_dt: number, time: number): void {
    for (const f of this.fires) f.update(time);
  }
}

/** A faceted obsidian monolith: an eight-sided shaft tapering up from a collar, with a flared cap. */
function obsidianColumn(radius: number, height: number, seed: number): THREE.BufferGeometry {
  const random = rng(seed);
  const pts: [number, number][] = [
    [radius * 1.35, 0], [radius * 1.35, 0.5], [radius * 1.12, 0.62], [radius * 1.05, 1.1], [radius * 1.18, 1.25],
    [radius * 1.0, 1.4], [radius * 0.82, height * 0.82], [radius * 0.98, height * 0.86], [radius * 0.86, height * 0.9],
    [radius * 1.15, height - 0.35], [radius * 1.2, height], [0, height],
  ];
  const geo = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 8);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  // a slight lean and uneven facets, so no two columns match
  const lean = (random() - 0.5) * 0.06;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setX(i, pos.getX(i) * (1 + (random() - 0.5) * 0.03) + lean * y);
  }
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

function braZierBowl(): THREE.BufferGeometry {
  return lathe([
    [0, 0], [0.22, 0], [0.25, 0.05], [0.12, 0.1], [0.1, 0.55], [0.18, 0.62], [0.55, 0.72], [0.72, 0.9],
    [0.76, 1.0], [0.7, 1.02], [0.52, 0.86], [0, 0.82],
  ], 32);
}

/** A cluster of long crystals leaning out from one root. */
function crystalCluster(seed: number): THREE.BufferGeometry {
  const random = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const h = 1.2 + random() * 2.2;
    const geo = new THREE.OctahedronGeometry(1, 0).scale(0.22 + random() * 0.14, h, 0.22 + random() * 0.14);
    geo.translate(0, h * 0.75, 0);
    const tilt = new THREE.Euler((random() - 0.5) * 0.9, random() * Math.PI * 2, (random() - 0.5) * 0.9);
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(tilt));
    geo.translate((random() - 0.5) * 0.7, 0, (random() - 0.5) * 0.7);
    parts.push(geo.index ? geo.toNonIndexed() : geo);
  }
  const merged = mergeGeos(parts);
  merged.computeVertexNormals();
  return merged;
}

function mergeGeos(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    const a = p.getAttribute('position').array as Float32Array;
    pos.set(a, o);
    o += a.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

/**
 * The underworld's own materials, all shared across the chambers: obsidian
 * (glassy black with the depth's glow in its cracks), dark basalt rock,
 * bronze, glowing coals and crystals, the lava lake and the gate veils.
 */
function underworldMaterials(lib: MaterialLibrary) {
  const tex = lib.textures;
  const lum = (c: any) => dot(c, vec3(0.3, 0.59, 0.11));

  const obsidian = new THREE.MeshStandardNodeMaterial();
  {
    const s = triplanar(tex.get('rock'), 0.18, 6);
    const fine = triplanar(tex.get('rock'), 0.6, 6);
    const l = lum(s.color.mul(fine.color).mul(1.8));
    obsidian.colorNode = vec3(l).mul(vec3(0.16, 0.15, 0.19)).add(0.012);
    obsidian.roughnessNode = mix(float(0.18), float(0.55), smoothstep(0.1, 0.35, l));
    obsidian.metalnessNode = float(0);
    obsidian.normalNode = transformNormalToView(s.normal.mix(normalWorld, 0.45).normalize());
    // a faint seam of the depth's glow low down in the deepest cracks
    const seam = smoothstep(0.04, 0.0, abs(mx_noise_float(positionWorld.mul(vec3(0.9, 0.35, 0.9)))));
    obsidian.emissiveNode = underworldGlow.mul(seam.mul(smoothstep(0.06, 0.02, l)).mul(smoothstep(3.5, 0.2, positionWorld.y)).mul(2.2));
    obsidian.name = 'obsidian';
  }

  const basalt = new THREE.MeshStandardNodeMaterial();
  {
    const s = triplanar(tex.get('rock'), 0.12, 6);
    const l = lum(s.color.mul(1.6));
    basalt.colorNode = vec3(l).mul(vec3(0.3, 0.29, 0.31));
    basalt.roughnessNode = float(0.85);
    basalt.metalnessNode = float(0);
    basalt.normalNode = transformNormalToView(s.normal);
    basalt.name = 'basalt';
  }

  const coals = new THREE.MeshStandardNodeMaterial({ color: 0x140a08, roughness: 0.9 });
  coals.emissiveNode = underworldGlow.mul(mx_noise_float(positionWorld.mul(3).add(vec3(0, time.mul(0.6), 0))).mul(0.5).add(0.5).mul(2.6));

  const crystal = new THREE.MeshStandardNodeMaterial({ roughness: 0.2, metalness: 0 });
  {
    // light runs up each shard; the facets turned away from the eye glow
    // brightest, so the flat-shaded shards read as cut glass, not paper
    const along = sin(positionWorld.y.mul(2.2).sub(time.mul(1.4))).mul(0.25).add(0.75);
    const view = cameraPosition.sub(positionWorld).normalize();
    const edge = float(1).sub(abs(dot(normalWorld.normalize(), view))).pow(1.5);
    const core = smoothstep(3.2, 0.2, positionWorld.y).mul(0.5).add(0.5);
    crystal.colorNode = vec3(0.02, 0.02, 0.03);
    crystal.emissiveNode = underworldGlow.mul(edge.mul(2.6).add(0.3)).mul(along).mul(core);
  }

  // the lake: dark crust drifting over a bright molten flow
  const lava = new THREE.MeshBasicNodeMaterial();
  {
    const p = positionWorld.xz;
    const flow = mx_fractal_noise_float(vec3(p.mul(0.35), time.mul(0.12)), 4, 2.0, 0.5).mul(0.5).add(0.5);
    const crust = smoothstep(0.42, 0.62, mx_noise_float(vec3(p.mul(0.6).add(vec2(time.mul(0.05), 0)), time.mul(0.04))).mul(0.5).add(0.5));
    const hot = mix(underworldGlow.mul(4.5), vec3(1.0, 0.9, 0.6).mul(6), smoothstep(0.7, 0.95, flow));
    lava.colorNode = mix(hot.mul(flow.add(0.4)), vec3(0.03, 0.02, 0.02), crust.mul(0.85));
  }

  // the exit's veil: a vortex in the depth's color that widens as the gate
  // opens, spiral arms turning round a dark eye with a white-hot rim
  const portal = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  {
    const u = uv();
    const p = vec2(u.x.sub(0.5).mul((GATE.halfWidth * 2 + 0.4) / LINTEL_Y), u.y.sub(0.47));
    const r = length(p);
    const twist = atan(p.y, p.x).add(r.mul(-9)).add(time.mul(1.5));
    const arms = sin(twist.mul(3)).mul(0.5).add(0.5).pow(2.2);
    // noise on the circle (cos, sin) so the angle's wrap leaves no seam
    const flow = mx_fractal_noise_float(vec3(cos(twist).mul(1.4), sin(twist).mul(1.4), r.mul(6).sub(time.mul(0.9))), 3, 2.0, 0.5).mul(0.5).add(0.5);
    const reach = gateOpen.mul(0.6).add(0.06);
    const body = smoothstep(reach, reach.sub(0.2), r);
    const eye = smoothstep(0.03, 0.24, r);
    const rim = exp(abs(r.sub(reach.sub(0.05))).mul(-26)).mul(gateOpen);
    const frame = smoothstep(0.0, 0.07, u.x).mul(smoothstep(1.0, 0.93, u.x)).mul(smoothstep(1.0, 0.94, u.y)).mul(smoothstep(0.0, 0.04, u.y));
    const glow = arms.mul(0.75).add(flow.mul(0.55)).mul(body).mul(eye).add(rim.mul(0.9)).mul(frame);
    const hot = arms.mul(flow).mul(0.5).add(rim.mul(0.5)).clamp(0, 1);
    portal.colorNode = vec4(mix(underworldGlow, vec3(1, 0.95, 0.85), hot).mul(glow).mul(gateOpen.mul(2.6).add(0.06)), 1);
  }

  // the way back in: a faint, still haze
  const sealed = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  {
    const u = uv();
    const edge = smoothstep(0.0, 0.25, u.x).mul(smoothstep(1.0, 0.75, u.x)).mul(smoothstep(1.0, 0.6, u.y));
    sealed.colorNode = vec4(underworldGlow.mul(edge.mul(0.12)), 1);
  }

  return { obsidian, basalt, coals, crystal, lava, portal, sealed, bronze: lib.bronze };
}
