import * as THREE from 'three/webgpu';
import { rng } from '../../core/random';
import { slice } from '../../core/slices';
import {
  addUnderworldColliders, CHAMBERS, entranceSpot, GATE, type ChamberDef, type Palette,
} from '../../map/UnderworldLayout';
import {
  abs, atan, cos, dot, exp, float, length, mix, mx_fractal_noise_float, mx_noise_float, mx_worley_noise_float, normalWorld, positionWorld, sin, smoothstep, time,
  transformNormalToView, uv, vec2, vec3, vec4,
} from '../../render/tsl';
import type { QualitySettings } from '../../render/Quality';
import { chippedBlock } from '../Architecture';
import type { CollisionWorld } from '../Collision';
import { Fire } from '../Effects';
import { triplanar, type MaterialLibrary } from '../Materials';
import { mergeStatic } from '../merge';
import type { MapContent } from '../World';
import { abyssKit, drownedKit, FLAME_Y, forgeKit, type Kit } from './kits';
import { DEPTH_COLORS, depthLook, depthWeights, flameHot, gateOpen, underworldGlow } from './palettes';
import { showRunes } from './UnderworldTerrain';

/** How tall the gate pylons stand, and the lintel across them. */
const PYLON_H = 7.2;
const LINTEL_Y = 6.4;

/**
 * The underworld's scenery. Each of the six chambers has a shell shared by
 * every depth (its gates, their veils and flames, the fires at its brazier
 * spots and the Burning Pit's lake) and a dressing for each depth, built from
 * that depth's kit (see kits.ts): the same hall is a forge in the Ashen
 * Depths and something else further down. Only the chamber the team is in
 * shows, in the current depth's dressing (the walls hide the rest), and each
 * is baked into a handful of draws, one per material.
 */
export class UnderworldMap implements MapContent {
  readonly group = new THREE.Group();
  readonly fires: Fire[] = [];
  /** The Burning Pit's light from below, in the depth's glow. */
  private readonly lakeLights: THREE.PointLight[] = [];
  readonly lights: THREE.PointLight[] = [];
  /** Lights that beat like a heart, each with its full strength. */
  private readonly beats: { light: THREE.PointLight; full: number }[] = [];
  /** Parts that turn slowly about an axis of their own, each with the dressing it shows with. */
  private readonly spins: { part: THREE.Object3D; rest: THREE.Quaternion; axis: THREE.Vector3; speed: number; dressing: THREE.Object3D }[] = [];
  readonly spawn: { x: number; z: number; yaw: number };
  readonly groundColor = new THREE.Color(0.05, 0.045, 0.055);
  /** Each chamber's shell, in CHAMBERS order. */
  readonly chambers: THREE.Group[] = [];
  /** Each depth's dressing of each chamber: dressings[depth][chamber]. */
  readonly dressings: THREE.Group[][] = KITS.map(() => []);
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
      m.chambers.push(m.buildShell(CHAMBERS[i]!, i));
      await slice();
      for (let d = 0; d < KITS.length; d++) {
        m.dressings[d]!.push(m.buildDressing(CHAMBERS[i]!, i, d));
        await slice();
      }
    }
    m.show(0);
    return m;
  }

  /** Shows one chamber's shell and the current depth's dressing of it, and hides the rest (their lights drop out of the light pool too). */
  show(i: number): void {
    if (i === this.shown) return;
    this.shown = i;
    this.updateShown();
  }

  /** Relights the underworld in a depth's colors and dresses its chambers in that depth's kit: the glow, the fires and their lights. */
  setPalette(p: Palette): boolean {
    if (p === this.palette) return false;
    this.palette = p;
    const c = DEPTH_COLORS[p];
    underworldGlow.value.setHex(c.glow);
    flameHot.value.setHex(c.fire.high);
    for (const l of this.lakeLights) l.color.setHex(c.glow);
    depthLook.value.set(...depthWeights(p));
    for (const f of this.fires) {
      if (f.group.userData.gateFire) continue;
      f.low.setHex(c.fire.low);
      f.high.setHex(c.fire.high);
      f.ember.setHex(c.fire.ember);
      f.light.color.setHex(c.fire.light);
      f.group.scale.setScalar(c.fire.scale);
    }
    this.updateShown();
    return true;
  }

  private updateShown(): void {
    const depth = PALETTES.indexOf(this.palette);
    this.chambers.forEach((g, k) => (g.visible = k === this.shown));
    this.dressings.forEach((list, d) => list.forEach((g, k) => (g.visible = k === this.shown && d === depth)));
    showRunes(this.shown);
  }

  /** What every depth shares in a chamber: its gates, the fires at its brazier spots, and the pit. */
  private buildShell(c: ChamberDef, index: number): THREE.Group {
    const g = new THREE.Group();
    g.name = `chamber-${index}`;
    // hidden chambers still get their shaders prepared while the map loads
    g.userData.shownLater = true;
    const keep: THREE.Object3D[] = [];
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, cast = true): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };

    // the fires at the brazier spots (each depth's kit builds the vessel under them)
    c.fires.forEach(([x, z], i) => {
      const pal = DEPTH_COLORS.ember.fire;
      const fire = new Fire(new THREE.Vector3(x, FLAME_Y, z), 0.9, index * 13.1 + i * 7.3, 22, pal);
      fire.group.scale.setScalar(pal.scale);
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

    if (c.pit) keep.push(this.buildPit(g, c.pit));

    mergeStatic(g, keep);
    g.position.set(c.x, 0, c.z);
    this.group.add(g);
    return g;
  }

  /** One depth's dressing of a chamber, from that depth's kit. */
  private buildDressing(c: ChamberDef, index: number, depth: number): THREE.Group {
    const g = new THREE.Group();
    g.name = `chamber-${index}-${PALETTES[depth]}`;
    g.userData.shownLater = true;
    const keep: THREE.Object3D[] = [];
    const random = rng(4100 + index * 31 + depth * 7919);
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, cast = true): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };
    const light = (color: number, intensity: number, distance: number, x: number, y: number, z: number) => {
      const l = new THREE.PointLight(color, intensity, distance, 2);
      l.position.set(x, y, z);
      l.castShadow = false;
      g.add(l);
      keep.push(l);
      this.lights.push(l);
      return l;
    };
    const beat = (l: THREE.PointLight) => void this.beats.push({ light: l, full: l.intensity });
    const spin = (part: THREE.Object3D, axis: THREE.Vector3, speed: number) => {
      keep.push(part);
      this.spins.push({ part, rest: part.quaternion.clone(), axis: axis.clone().normalize(), speed, dressing: g });
    };
    KITS[depth]!({ c, index, random, mats: this.mats, group: g, add, light, beat, spin });
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
    this.lakeLights.push(light);
    g.add(lake);
    return lake;
  }

  applyQuality(_q: QualitySettings): void {}

  update(_dt: number, time: number): void {
    for (const f of this.fires) f.update(time);
    if (this.beats.length) {
      // lub-dub, then a rest, about 50 beats a minute
      const p = (time % 1.2) / 1.2;
      const pulse = Math.exp(-(((p - 0.06) / 0.05) ** 2)) + 0.55 * Math.exp(-(((p - 0.24) / 0.06) ** 2));
      for (const b of this.beats) b.light.intensity = b.full * (0.7 + 0.6 * pulse);
    }
    // (the map is static content: its matrices are only updated by hand)
    for (const s of this.spins) {
      if (!s.dressing.visible) continue;
      s.part.quaternion.copy(s.rest).multiply(turn.setFromAxisAngle(s.axis, s.speed * time));
      s.part.updateMatrix();
      s.part.updateMatrixWorld(true);
    }
  }
}

const turn = new THREE.Quaternion();

/** The depths in order, and the kit each dresses its chambers with. */
const PALETTES: readonly Palette[] = ['ember', 'soul', 'spirit'];
const KITS: readonly Kit[] = [forgeKit, drownedKit, abyssKit];

/**
 * The underworld's own materials, all shared across the chambers: obsidian
 * (glassy black with the depth's glow in its cracks), glowing coals, the lava
 * lake and the gate veils, then each depth's kit's own: the forge's stone,
 * iron, slag and fires, the crypt's limestone, verdigris and water, the
 * ossuary's bone, and the bosses' gold and molten metal.
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
    const seam = smoothstep(0.04, 0.0, abs(mx_noise_float(positionWorld.mul(vec3(0.9, 0.35, 0.9)).add(fine.color.sub(0.3).mul(0.6)))));
    obsidian.emissiveNode = underworldGlow.mul(seam.mul(smoothstep(0.06, 0.02, l)).mul(smoothstep(3.5, 0.2, positionWorld.y)).mul(2.2));
    obsidian.name = 'obsidian';
  }

  // dressed basalt for the forges' masonry: rougher than obsidian, so big faces don't mirror the haze, with the same glowing seams
  const forgeStone = new THREE.MeshStandardNodeMaterial();
  {
    const s = triplanar(tex.get('rock'), 0.22, 6);
    const fine = triplanar(tex.get('rock'), 0.7, 6);
    const l = lum(s.color.mul(fine.color).mul(1.8));
    forgeStone.colorNode = vec3(l).mul(vec3(0.21, 0.175, 0.165)).add(0.01);
    forgeStone.roughnessNode = mix(float(0.5), float(0.85), smoothstep(0.1, 0.35, l));
    forgeStone.metalnessNode = float(0);
    forgeStone.normalNode = transformNormalToView(s.normal.add(fine.normal).normalize().mix(normalWorld, 0.35).normalize());
    const seam = smoothstep(0.04, 0.0, abs(mx_noise_float(positionWorld.mul(vec3(0.9, 0.35, 0.9)).add(fine.color.sub(0.3).mul(0.7)))));
    forgeStone.emissiveNode = underworldGlow.mul(seam.mul(smoothstep(0.07, 0.02, l)).mul(smoothstep(4.5, 0.2, positionWorld.y)).mul(2.4));
    forgeStone.name = 'forgeStone';
  }

  const coals = new THREE.MeshStandardNodeMaterial({ color: 0x140a08, roughness: 0.9 });
  coals.emissiveNode = underworldGlow.mul(mx_noise_float(positionWorld.mul(3).add(vec3(0, time.mul(0.6), 0))).mul(0.5).add(0.5).mul(2.6));

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

  // wrought iron: near-black metal with rust in its grain, picking up the fires' light
  const iron = new THREE.MeshStandardNodeMaterial();
  {
    const s = triplanar(tex.get('rock'), 0.7, 6);
    const grain = lum(s.color);
    const rust = smoothstep(0.32, 0.18, grain);
    iron.colorNode = mix(vec3(0.075, 0.07, 0.068), vec3(0.2, 0.085, 0.04), rust.mul(0.7));
    iron.metalnessNode = mix(float(0.75), float(0.2), rust);
    iron.roughnessNode = mix(float(0.42), float(0.85), rust);
    iron.normalNode = transformNormalToView(s.normal.mix(normalWorld, 0.55).normalize());
    iron.name = 'iron';
  }

  // slag: a dark glassy crust over metal still glowing in its cracks, hottest low down
  const slag = new THREE.MeshStandardNodeMaterial();
  {
    const s = triplanar(tex.get('rock'), 0.35, 6);
    const l = lum(s.color.mul(1.6));
    slag.colorNode = vec3(l).mul(vec3(0.11, 0.085, 0.075));
    slag.roughnessNode = mix(float(0.25), float(0.7), smoothstep(0.1, 0.4, l));
    slag.metalnessNode = float(0);
    slag.normalNode = transformNormalToView(s.normal);
    const crack = smoothstep(0.08, 0.0, abs(mx_noise_float(positionWorld.mul(1.6))));
    const heat = smoothstep(1.6, 0.0, positionWorld.y).mul(0.7).add(0.3);
    const pulse = sin(time.mul(0.9).add(positionWorld.x.mul(0.5))).mul(0.2).add(0.8);
    slag.emissiveNode = underworldGlow.mul(crack.mul(3.2).add(smoothstep(0.2, 0.05, l).mul(0.35)).mul(heat).mul(pulse));
    slag.name = 'slag';
  }

  // a furnace's fire seen through its bars: white-hot at the bed, flames licking up
  const furnace = new THREE.MeshBasicNodeMaterial();
  {
    const u = uv();
    const n = mx_fractal_noise_float(vec3(u.x.mul(3.2), u.y.mul(2.2).sub(time.mul(1.3)), time.mul(0.25)), 3, 2.0, 0.5).mul(0.5).add(0.5);
    const heat = smoothstep(1.05, 0.0, u.y.add(n.mul(0.35).sub(0.15))).mul(n.mul(0.7).add(0.45));
    const sides = smoothstep(0.0, 0.18, u.x).mul(smoothstep(1.0, 0.82, u.x));
    furnace.colorNode = mix(underworldGlow.mul(2.4), vec3(1.0, 0.82, 0.48).mul(7), smoothstep(0.6, 1.0, heat)).mul(heat.mul(1.5).add(0.08)).mul(sides);
    furnace.name = 'furnace';
  }

  // a sheet of flames licking up off a bed of coals: soft at its sides and top, each sheet flickering on its own
  const flameBed = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  {
    const u = uv();
    const seed = positionWorld.x.mul(0.71).add(positionWorld.z.mul(0.37));
    const n = mx_fractal_noise_float(vec3(u.x.mul(6.5).add(seed), u.y.mul(2.6).sub(time.mul(2.6)), seed.add(time.mul(0.5))), 3, 2.0, 0.55).mul(0.5).add(0.5);
    // tongues: the noise eats the sheet from the top down, lower toward the sides
    const sides = smoothstep(0.0, 0.25, u.x).mul(smoothstep(1.0, 0.75, u.x));
    const reach = sides.mul(0.7).add(0.05);
    const body = smoothstep(reach, reach.mul(0.35), u.y.add(n.mul(0.8)).sub(0.42)).mul(smoothstep(0.0, 0.08, u.y)).mul(sides);
    const heat = body.mul(float(1).sub(u.y.mul(0.7))).mul(n.mul(0.5).add(0.6)).clamp(0, 1);
    flameBed.colorNode = vec4(mix(underworldGlow.mul(0.7), flameHot.mul(2.4), smoothstep(0.5, 0.95, heat)).mul(heat), 1);
    flameBed.name = 'flameBed';
  }

  // the Drowned Halls' masonry: pale limestone the water has worn and stained,
  // dark and slick below the old waterline, green with algae in its pores
  const tideStone = new THREE.MeshStandardNodeMaterial();
  {
    const s = triplanar(tex.get('rock'), 0.25, 6);
    const fine = triplanar(tex.get('rock'), 0.8, 6);
    const l = lum(s.color.mul(fine.color).mul(1.8));
    const line = mx_noise_float(positionWorld.xz.mul(0.4)).mul(0.25).add(1.4);
    const below = smoothstep(line.add(0.15), line.sub(0.15), positionWorld.y);
    const algae = smoothstep(0.24, 0.1, l).mul(below.mul(0.6).add(0.4));
    const pale = vec3(l).mul(vec3(0.68, 0.69, 0.64)).add(0.06);
    tideStone.colorNode = mix(mix(pale, pale.mul(vec3(0.42, 0.5, 0.5)), below), vec3(0.06, 0.11, 0.09), algae.mul(0.6));
    tideStone.roughnessNode = mix(mix(float(0.62), float(0.9), smoothstep(0.1, 0.35, l)), float(0.22), below);
    tideStone.metalnessNode = float(0);
    tideStone.normalNode = transformNormalToView(s.normal.add(fine.normal).normalize().mix(normalWorld, 0.3).normalize());
    tideStone.name = 'tideStone';
  }

  // bronze gone green: verdigris crusted in its hollows, the worn high spots still showing metal
  const verdigris = new THREE.MeshStandardNodeMaterial();
  {
    const s = triplanar(tex.get('rock'), 0.9, 6);
    const g = lum(s.color);
    const crust = smoothstep(0.38, 0.22, g);
    verdigris.colorNode = mix(vec3(0.42, 0.3, 0.16), vec3(0.16, 0.36, 0.3).mul(g.add(0.6)), crust);
    verdigris.metalnessNode = mix(float(0.85), float(0.05), crust);
    verdigris.roughnessNode = mix(float(0.35), float(0.8), crust);
    verdigris.normalNode = transformNormalToView(s.normal.mix(normalWorld, 0.5).normalize());
    verdigris.name = 'verdigris';
  }

  // falling water: streaks racing down a sheet, catching the soul light, thinning at its edges and breaking into spray at its foot
  const waterfall = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  {
    const u = uv();
    const fall = mx_fractal_noise_float(vec3(u.x.mul(14), u.y.mul(3).add(time.mul(1.7)), time.mul(0.2)), 3, 2.0, 0.5).mul(0.5).add(0.5);
    const streaks = smoothstep(0.42, 0.85, fall);
    const sides = smoothstep(0.0, 0.2, u.x).mul(smoothstep(1.0, 0.8, u.x));
    const foot = smoothstep(0.25, 0.0, u.y);
    const top = smoothstep(1.0, 0.85, u.y);
    const glow = streaks.mul(0.5).add(0.1).add(foot.mul(fall).mul(0.7)).mul(sides).mul(top).mul(0.55);
    waterfall.colorNode = vec4(mix(underworldGlow.mul(0.55), vec3(0.55, 0.78, 1.0), streaks.mul(0.4).add(foot.mul(0.35))).mul(glow), 1);
    waterfall.name = 'waterfall';
  }

  // a pool's still black water: a mirror for the lights, ripples spreading from where the water falls in
  const pool = new THREE.MeshStandardNodeMaterial({ roughness: 0.04, metalness: 0 });
  {
    const u = uv();
    const r = length(u.sub(vec2(0.5, 0.5)));
    const rings = sin(r.mul(48).sub(time.mul(4.5))).mul(smoothstep(0.5, 0.05, r));
    const n = mx_noise_float(vec3(positionWorld.xz.mul(1.3), time.mul(0.4)));
    pool.colorNode = vec3(0.006, 0.012, 0.018);
    pool.normalNode = transformNormalToView(vec3(rings.mul(0.06).add(n.mul(0.04)), 1, n.mul(0.04)).normalize());
    // foam where the fall lands
    pool.emissiveNode = underworldGlow.mul(0.15).add(vec3(0.5, 0.6, 0.7)).mul(smoothstep(0.16, 0.0, r).mul(n.mul(0.5).add(0.5)).mul(0.6));
    pool.name = 'pool';
  }

  // old bone: ivory gone yellow, brown in its pits and cracks, dull and dry
  const bone = new THREE.MeshStandardNodeMaterial();
  {
    const s = triplanar(tex.get('rock'), 1.1, 6);
    const l = lum(s.color);
    const pit = smoothstep(0.34, 0.16, l);
    bone.colorNode = mix(vec3(0.6, 0.55, 0.44), vec3(0.2, 0.15, 0.09), pit).mul(l.mul(0.5).add(0.75));
    bone.roughnessNode = mix(float(0.55), float(0.9), pit);
    bone.metalnessNode = float(0);
    bone.normalNode = transformNormalToView(s.normal.mix(normalWorld, 0.55).normalize());
    bone.name = 'bone';
  }

  // the Treasure Wyrm's gold: a heap of coins (cells of polished metal, dark
  // where they overlap), glints twinkling across it as the fire flickers
  const gold = new THREE.MeshStandardNodeMaterial();
  {
    const coin = smoothstep(0.62, 0.4, mx_worley_noise_float(positionWorld.mul(7.5)));
    const s = triplanar(tex.get('rock'), 1.4, 6);
    const tone = lum(s.color).mul(0.5).add(0.75);
    const base = vec3(1.0, 0.68, 0.26);
    gold.colorNode = base.mul(mix(float(0.22), float(1), coin)).mul(tone);
    gold.metalnessNode = float(1);
    gold.roughnessNode = mix(float(0.6), float(0.26), coin);
    gold.normalNode = transformNormalToView(s.normal.mix(normalWorld, 0.5).normalize());
    const glint = smoothstep(0.62, 0.8, mx_noise_float(positionWorld.mul(20).add(vec3(time.mul(0.35), time.mul(0.8), 0)))).mul(coin);
    gold.emissiveNode = base.mul(glint.mul(6).add(coin.mul(0.1)));
    gold.name = 'gold';
  }

  // an old bronze colossus: dark metal, green verdigris crusted in its hollows
  // and run down it in streaks where the water has fallen on it for ages
  const bronze = new THREE.MeshStandardNodeMaterial();
  {
    const s = triplanar(tex.get('rock'), 0.5, 6);
    const g = lum(s.color);
    const streak = smoothstep(0.1, 0.45, mx_noise_float(positionWorld.mul(vec3(2.2, 0.18, 2.2))).add(g.sub(0.3).mul(0.8)));
    const crust = smoothstep(0.36, 0.2, g).max(streak.mul(0.85));
    bronze.colorNode = mix(vec3(0.2, 0.12, 0.055).mul(g.add(0.7)), vec3(0.09, 0.24, 0.2).mul(g.add(0.65)), crust);
    bronze.metalnessNode = mix(float(0.8), float(0.05), crust);
    bronze.roughnessNode = mix(float(0.4), float(0.85), crust);
    bronze.normalNode = transformNormalToView(s.normal.mix(normalWorld, 0.45).normalize());
    bronze.name = 'bronze';
  }

  // the Molten Colossus's metal, always its own orange whatever the depth:
  // white-hot where it pours, a dark crust drifting over it where it lies
  const molten = new THREE.MeshBasicNodeMaterial();
  {
    const u = uv();
    const n = mx_fractal_noise_float(vec3(u.x.mul(10).sub(time.mul(1.8)), u.y.mul(4), time.mul(0.3)), 3, 2.0, 0.5).mul(0.5).add(0.5);
    const lying = smoothstep(1.2, 0.8, positionWorld.y);
    const crust = smoothstep(0.52, 0.72, mx_noise_float(vec3(positionWorld.xz.mul(1.1), time.mul(0.05))).mul(0.5).add(0.5)).mul(lying);
    const hot = mix(vec3(1.0, 0.32, 0.05).mul(3), vec3(1.0, 0.84, 0.5).mul(8), smoothstep(0.5, 0.9, n));
    molten.colorNode = mix(hot.mul(n.add(0.35)), vec3(0.05, 0.025, 0.015), crust.mul(0.9));
    molten.name = 'molten';
  }

  return { obsidian, forgeStone, coals, lava, portal, sealed, iron, slag, furnace, flameBed, tideStone, verdigris, waterfall, pool, bone, gold, molten, bronze };
}
