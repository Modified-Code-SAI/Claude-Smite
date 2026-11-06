import * as THREE from 'three/webgpu';
import {
  abs, atan, attribute, color, dot, exp, float, fract, fwidth, length, max, min, mix, mx_fractal_noise_float, mx_noise_float, normalLocal, normalView,
  mx_worley_noise_float, positionGeometry, positionView, pow, reflectView, saturate, select, sin, smoothstep, time, uv, vec3,
} from '../../render/tsl';
import { objectUniforms } from '../../render/shared';
import { reliefFade, reliefNormal, surfaceGradient } from './relief';

/**
 * Stylized PBR materials for the gods, keyed by the material names the build
 * script writes (tools/gods/forge). Mesh data channels:
 * - `color` (COLOR_0): per material. Skin: r = crease, g = ridge, b = face.
 *   Hair: r = root..tip. Eyes: r = 1 at the pupil.
 * - `_edge`: distance to an armor plate's border in meters (1 elsewhere).
 * - `_side`: 0 on the inside face of a plate.
 */
export interface GodPalette {
  skin: number;
  /** Second skin tone for creases and shadowed areas. */
  skinDeep: number;
  gold: number;
  steel: number;
  cloth: number;
  clothDeep: number;
  cloth2: number;
  leather: number;
  hair: number;
  hairTip: number;
  fur: number;
  glow: number;
  eye: number;
  gem: number;
  /** Tip color of fur (default: the fur lightened warm). */
  furTip?: number;
  /** Frost-rimed skin with icy shading instead of warm flesh (the Jötunn). */
  frost?: boolean;
  /** A scaly hide instead of warm flesh (Kukulkan, Cthulhu). */
  scaly?: boolean;
  /** Scaly hides: the belly and throat scales' color (default: the skin, paler). */
  belly?: number;
  /** Scaly hides: a faint glow of the deep at grazing angles (Cthulhu). */
  deep?: boolean;
}

const PALETTES: Record<string, GodPalette> = {
  zeus: {
    skin: 0xc48a66, skinDeep: 0x7a3a2a, gold: 0xf7c450, steel: 0xc8d2dc, cloth: 0x2457c8, clothDeep: 0x0d1f5c,
    cloth2: 0xe2d6bc, leather: 0x5a3420, hair: 0xaab4c4, hairTip: 0xf2f4f8, fur: 0xd8d0c0, glow: 0x6fd8ff,
    eye: 0x8fe8ff, gem: 0x39b8ff,
  },
  thor: {
    skin: 0xdba07e, skinDeep: 0x8f4030, gold: 0xe0a640, steel: 0xb4c0cc, cloth: 0xa01c1c, clothDeep: 0x420808,
    cloth2: 0x3a3f4a, leather: 0x4a2a18, hair: 0xa8381a, hairTip: 0xe8783a, fur: 0x5a3c26, glow: 0x9fd0ff,
    eye: 0xbfe4ff, gem: 0x4aa8ff,
  },
  odin: {
    skin: 0xc8906c, skinDeep: 0x7a3a28, gold: 0xe0a33a, steel: 0x7e8a9c, cloth: 0x2b3240, clothDeep: 0x0e1118,
    cloth2: 0x6a1c1c, leather: 0x3a2416, hair: 0xb8bcc2, hairTip: 0xeceef0, fur: 0x5a5048, glow: 0xffc955,
    eye: 0xffd27a, gem: 0xffa62a,
  },
  loki: {
    skin: 0xd8b49a, skinDeep: 0x6a3a40, gold: 0xd8bd4a, steel: 0x6a7480, cloth: 0x1c6a2c, clothDeep: 0x06200c,
    cloth2: 0x141418, leather: 0x241a14, hair: 0x14110f, hairTip: 0x3a2c22, fur: 0x2a2a26, glow: 0x6dff5a,
    eye: 0x9dff7a, gem: 0x3dff7a,
  },
  anubis: {
    skin: 0x2a2018, skinDeep: 0x0c0806, gold: 0xf2b84a, steel: 0x2a3e8a, cloth: 0xe6dac0, clothDeep: 0x8a7a5a,
    cloth2: 0x1c3f9a, leather: 0x3a2412, hair: 0x14100c, hairTip: 0x2a2018, fur: 0x1e1712, glow: 0xffa040,
    eye: 0xffb050, gem: 0x2fd0c0,
  },
  // the bringer of peaceful death: pale skin, black-violet chiton, dark iron, tarnished silver,
  // soul-blue fire, black wings frosted grey at the tips, poppy-red petals
  thanatos: {
    skin: 0xcdb9b0, skinDeep: 0x5e4450, gold: 0xa8b0bc, steel: 0x6a707c, cloth: 0x1c1826, clothDeep: 0x07060c,
    cloth2: 0x2e2846, leather: 0x1e1a1e, hair: 0x0e0c12, hairTip: 0x2a2632, fur: 0x15131b, glow: 0x74c4ff,
    eye: 0xbfe8ff, gem: 0xc81e2a, furTip: 0x6a6680,
  },
  // the feathered serpent: green scales and a gold belly, white cotton, Maya red, jade, gold, quetzal green shading to turquoise
  kukulkan: {
    skin: 0x27704a, skinDeep: 0x07261a, gold: 0xf0b848, steel: 0x56d6a2, cloth: 0xeee4cc, clothDeep: 0x8c7c5c,
    cloth2: 0xb8281e, leather: 0x5a3420, hair: 0x0c0a08, hairTip: 0x221c18, fur: 0x087a46, glow: 0x7affc8,
    eye: 0xffc030, gem: 0x2fbf86, furTip: 0x3cc890, scaly: true, belly: 0xe0c058,
  },
  // the dreamer in R'lyeh: sea-green rubbery hide, black kelp, dark horn claws, bioluminescent cyan-green
  cthulhu: {
    skin: 0x1d4430, skinDeep: 0x050f0a, gold: 0x6e8a6a, steel: 0x2a2822, cloth: 0x2c3e38, clothDeep: 0x0a1210,
    cloth2: 0x26321a, leather: 0x24261c, hair: 0x101410, hairTip: 0x203024, fur: 0x1a2a20, glow: 0x6effd8,
    eye: 0xb8ffe8, gem: 0x2ad8b0, furTip: 0x3a5a48, scaly: true, deep: true,
  },
  // the frost giant: glacier-blue skin, old bronze, black iron, dark bear fur frosted at the tips
  jotunn: {
    skin: 0x6c90c2, skinDeep: 0x16295a, gold: 0x9a7444, steel: 0x4e5560, cloth: 0x4a3a2e, clothDeep: 0x1e1610,
    cloth2: 0x4e3c30, leather: 0x4a3222, hair: 0xb8c6d8, hairTip: 0xf4f8ff, fur: 0x231c19, glow: 0x66e0ff,
    eye: 0x9ff0ff, gem: 0x8fdcff, furTip: 0x5c6470, frost: true,
  },
};

const EINHERJAR: Partial<GodPalette> = { cloth: 0x4a4f5a, clothDeep: 0x1a1d22, glow: 0x9ad8ff, eye: 0x9ad8ff };

export function paletteOf(id: string, variant?: string): GodPalette {
  const p = PALETTES[id] ?? PALETTES.zeus!;
  return variant === 'einherjar' ? { ...p, ...EINHERJAR } : p;
}

const edge = () => attribute('_edge', 'float');
const side = () => attribute('_side', 'float');
const data = () => attribute('color', 'vec4');
/** Baked per-vertex ambient occlusion (tools/gods/forge/ao.py). */
const ao = () => attribute('_ao', 'float');

/** Fresnel-ish rim factor in view space, for the painted rim light Smite characters have. */
const rim = () => pow(float(1).sub(saturate(normalView.dot(positionView.normalize().negate()))), 3);

/** A material with fine surface relief: its height in meters (see relief.ts). */
type Relief = THREE.MeshPhysicalNodeMaterial & { reliefNode?: any };
const relief = (m: THREE.MeshPhysicalNodeMaterial, height: any): void => {
  (m as Relief).reliefNode = height;
};

function skinMaterial(p: GodPalette): THREE.Material {
  // the peach fuzz of skin, tinted by the god's own skin so a dark hide doesn't glitter red
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.55, sheen: 0.35, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xff9a7a).lerp(new THREE.Color(p.skin), 0.45) });
  const d = data();
  const crease = d.x;
  const ridge = d.y;
  const mottle = mx_fractal_noise_float(positionGeometry.mul(18), 3).mul(0.5).add(0.5);
  const fine = mx_noise_float(positionGeometry.mul(220)).mul(0.04);
  const base = mix(color(p.skin), color(p.skinDeep), crease.mul(0.75).add(mottle.mul(0.12)));
  // warm subsurface-looking tint in creases, light catches the ridges of muscle
  // the fine grain scales with the skin's own tone: added flat, it speckled dark hides (Anubis)
  const lit = base.mul(float(1).add(ridge.mul(0.22)).add(fine.mul(2.5)));
  // painted face shading: deep eye sockets and tinted lips
  const lips = d.z;
  const socket = d.w;
  const lipColor = color(p.skin).mul(vec3(0.82, 0.5, 0.48));
  const painted = mix(mix(lit, color(p.skinDeep).mul(0.55), socket.mul(0.65)), lipColor, lips.mul(0.55));
  m.colorNode = painted;
  m.roughnessNode = float(0.5).add(crease.mul(0.15)).sub(ridge.mul(0.12)).add(mx_noise_float(positionGeometry.mul(90)).mul(0.06)).sub(lips.mul(0.2));
  // a little warm back-scatter at grazing angles
  m.emissiveNode = color(p.skinDeep).mul(rim().mul(0.18));
  // pores, and the soft lumps of flesh over muscle
  relief(m, fine.mul(0.004).mul(reliefFade(0.006)).add(mottle.mul(0.0009).mul(reliefFade(0.06))));
  return m;
}

/**
 * A scaly hide (Kukulkan's serpent scales, Cthulhu's "scaly, rubbery-looking"
 * sea hide): small overlapping scales (worley cells, dark in their seams),
 * darker blotches, paler belly and throat scales, a slick clearcoat and, for
 * the deep, a faint glow at grazing angles.
 */
function scalySkinMaterial(p: GodPalette): THREE.Material {
  const deep = p.deep === true;
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.4, clearcoat: deep ? 0.16 : 0.45, clearcoatRoughness: 0.3, sheen: 0.12, sheenRoughness: 0.4, sheenColor: new THREE.Color(p.skin).lerp(new THREE.Color(p.glow), 0.3) });
  const d = data();
  const crease = d.x;
  const ridge = d.y;
  const socket = d.w;
  const blotch = mx_fractal_noise_float(positionGeometry.mul(7), 3).mul(0.5).add(0.5);
  // the deep's hide has coarser, rubbery scales; a serpent's are small and fine
  const freq = deep ? 54 : 70;
  const cell = mx_worley_noise_float(positionGeometry.mul(freq));
  const seam = smoothstep(0.28, 0.62, cell);
  // belly scales: a band down the front of the torso, and every underside (throat, jaw, inner arms)
  const front = smoothstep(0.45, 0.85, normalLocal.z).mul(float(1).sub(smoothstep(0.035, 0.075, abs(positionGeometry.x))));
  const under = smoothstep(0.2, 0.7, normalLocal.y.negate());
  const belly = saturate(max(front, under));
  // the deep: a dark back and mottled flanks, like something that lies on the sea floor
  const dorsal = deep ? float(1).sub(smoothstep(-0.6, 0.25, normalLocal.z)).mul(0.4) : float(0);
  const base = mix(color(p.skin), color(p.skinDeep), saturate(crease.mul(0.8).add(smoothstep(0.5, 0.8, blotch).mul(deep ? 0.55 : 0.35)).add(dorsal)));
  const pale = mix(base, p.belly !== undefined ? color(p.belly) : color(p.skin).mul(1.35), belly.mul(p.belly !== undefined ? 0.75 : 0.3));
  const scaled = pale.mul(float(1).sub(seam.mul(deep ? 0.42 : 0.3))).mul(float(1).add(ridge.mul(0.2)));
  m.colorNode = mix(scaled, color(p.skinDeep).mul(0.35), socket.mul(0.7));
  m.roughnessNode = float(deep ? 0.44 : 0.32).add(seam.mul(0.3)).add(crease.mul(0.15)).sub(ridge.mul(0.08));
  m.emissiveNode = p.deep ? color(p.glow).mul(rim().mul(0.1)).add(color(p.skinDeep).mul(rim().mul(0.15))) : color(p.skinDeep).mul(rim().mul(0.15));
  // each scale domed, sunk at its seams
  relief(m, float(1).sub(seam).mul(deep ? 0.0028 : 0.002).mul(reliefFade(1 / freq)).add(blotch.mul(0.001).mul(reliefFade(0.14))));
  return m;
}

/**
 * A frost giant's hide: glacier-blue skin, deep blue in the creases, a rime
 * of frost crusting the ridges and the surfaces that face the sky, with
 * pinpoint glints in it, and an icy rim light instead of warm back-scatter.
 */
function frostSkinMaterial(p: GodPalette): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.6, sheen: 0.5, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xc8ecff) });
  const d = data();
  const crease = d.x;
  const ridge = d.y;
  const lips = d.z;
  const socket = d.w;
  const mottle = mx_fractal_noise_float(positionGeometry.mul(9), 3).mul(0.5).add(0.5);
  const fine = mx_noise_float(positionGeometry.mul(160)).mul(0.035);
  const base = mix(color(p.skin), color(p.skinDeep), crease.mul(0.85).add(mottle.mul(0.18)));
  // rime: patchy frost on the ridges and on top of the shoulders, arms and head
  const up = saturate(normalLocal.y);
  const patches = mx_fractal_noise_float(positionGeometry.mul(16), 3).mul(0.5).add(0.5);
  const frost = smoothstep(0.6, 0.9, ridge.mul(0.9).add(up.mul(0.45)).add(patches.mul(0.35)).sub(crease.mul(0.7))).mul(float(1).sub(lips));
  const lit = base.mul(float(1).add(ridge.mul(0.25))).add(fine);
  const frosted = mix(lit, color(0xdcecff), frost.mul(0.6));
  const painted = mix(mix(frosted, color(p.skinDeep).mul(0.4), socket.mul(0.7)), color(p.skinDeep).mul(0.8), lips.mul(0.6));
  m.colorNode = painted;
  m.roughnessNode = mix(float(0.58).add(crease.mul(0.12)).sub(ridge.mul(0.1)), float(0.3), frost);
  // ice glints in the frost, and a cold rim
  const glint = smoothstep(0.88, 0.95, mx_noise_float(positionGeometry.mul(420)).mul(0.5).add(0.5)).mul(frost);
  m.emissiveNode = color(p.glow).mul(rim().mul(0.35)).add(color(0xe8f8ff).mul(glint.mul(0.9)));
  // a crust of rime standing proud of the hide, gritty with ice
  relief(m, frost.mul(0.0025).mul(reliefFade(0.06)).add(frost.mul(fine).mul(0.014).mul(reliefFade(0.006))));
  return m;
}

function metalMaterial(base: number, trim: number, opts: { engrave?: boolean; dark?: number } = {}): THREE.Material {
  // not quite a mirror: a fifth of the color lights like paint, so metal keeps its color
  // where it reflects the ground (stylized metal). It reflects the map's own sky and
  // ground like everything else: a painted studio map came out of PMREM nearly black,
  // which is what made steel read as black plastic and gold as dark brown.
  const m = new THREE.MeshPhysicalNodeMaterial({ metalness: 0.82, roughness: 0.3, clearcoat: 0.4, clearcoatRoughness: 0.2 });
  const e = edge();
  const inside = float(1).sub(side());
  const band = float(1).sub(smoothstep(0.012, 0.02, e)); // polished trim along plate borders
  const groove = smoothstep(0.02, 0.024, e).mul(float(1).sub(smoothstep(0.026, 0.03, e))); // engraved line inside the trim
  const hammer = mx_fractal_noise_float(positionGeometry.mul(30), 2).mul(0.5).add(0.5);
  let col: any = mix(color(base).mul(0.88), color(base), hammer.mul(0.6).add(0.4));
  // beaten metal: shallow hammer dents, a raised polished trim and the engraved line inside it
  let height: any = hammer.mul(0.0013).mul(reliefFade(0.035)).add(band.mul(0.0012)).sub(groove.mul(0.0012));
  if (opts.engrave) {
    // scrolling filigree: a band of interference lines that reads as engraving
    const fil = abs(sin(positionGeometry.x.mul(140).add(sin(positionGeometry.y.mul(90)).mul(2.2)))).mul(abs(sin(positionGeometry.y.mul(120).add(positionGeometry.z.mul(60)))));
    const inBand = smoothstep(0.03, 0.035, e).mul(float(1).sub(smoothstep(0.06, 0.065, e)));
    const cut = smoothstep(0.75, 0.95, fil).mul(inBand);
    col = col.mul(float(1).sub(cut.mul(0.45)));
    height = height.sub(cut.mul(0.0009).mul(reliefFade(0.008)));
  }
  relief(m, height);
  col = mix(col, color(trim), band);
  col = col.mul(float(1).sub(groove.mul(0.55))).mul(float(1).sub(inside.mul(0.55)));
  // the dark-to-bright range of a studio, painted in from what each point mirrors (in view
  // space, so it reads the same from the game camera as up close): a bright band where the
  // metal faces the camera, darker where it turns to mirror the ground, a softer sky above.
  // The map's real sky alone is too even, and gold reads as flat yellow plastic in it.
  // Where it mirrors the ground the color also deepens (squared: gold goes amber, not
  // brown-grey), the way painted gold shades.
  const ry = reflectView.normalize().y;
  const low = float(1).sub(smoothstep(-0.55, -0.05, ry));
  const studio = mix(float(1), float(0.62), low).add(exp(ry.mul(ry).mul(-28)).mul(0.18)).sub(smoothstep(0.35, 0.95, ry).mul(0.14));
  col = mix(col, col.mul(col).mul(1.3), low.mul(0.8)).mul(studio);
  m.colorNode = col;
  m.roughnessNode = mix(float(0.3).add(hammer.mul(0.1)), float(0.16), band).add(groove.mul(0.3)).add(inside.mul(0.3));
  m.emissiveNode = color(trim).mul(rim().mul(0.08));
  return m;
}

function clothMaterial(c: number, deep: number, trim: number, opts: { pattern?: boolean } = {}): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.82, sheen: 0.45, sheenRoughness: 0.5, side: THREE.DoubleSide });
  m.sheenColor = new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.25);
  const v = uv();
  const weave = mx_noise_float(positionGeometry.mul(vec3(260, 260, 260))).mul(0.03);
  // painted drape: long vertical folds plus a little broad variation
  const drape = mx_fractal_noise_float(positionGeometry.mul(vec3(10, 1.6, 10)), 2).mul(0.5).add(0.5);
  const broad = mx_fractal_noise_float(positionGeometry.mul(4), 2).mul(0.5).add(0.5);
  const folds = smoothstep(0.2, 0.8, drape.mul(0.7).add(broad.mul(0.3)));
  let col: any = mix(color(deep), color(c), folds.mul(0.65).add(0.35)).add(weave);
  // the folds stand out in relief, and the threads cross in a fine weave
  const threads = abs(sin(dot(positionGeometry, vec3(1, 0.35, 0.6)).mul(1400))).add(abs(sin(dot(positionGeometry, vec3(-0.4, 1, 0.5)).mul(1400))));
  let height: any = folds.mul(0.016).mul(reliefFade(0.12)).add(threads.mul(0.00015).mul(reliefFade(0.004)));
  if (opts.pattern) {
    // gold embroidered border: along uv edges (cloth panels have 0..1 uv)
    const ex = min(v.x, float(1).sub(v.x));
    const ey = float(1).sub(v.y);
    const borderX = float(1).sub(smoothstep(0.035, 0.05, ex));
    const borderY = float(1).sub(smoothstep(0.05, 0.065, ey));
    const meanderBand = smoothstep(0.08, 0.09, ey).mul(float(1).sub(smoothstep(0.16, 0.17, ey)));
    const meander = fract(v.x.mul(18).add(fract(v.y.mul(36)).step(0.5).mul(0.5))).step(0.5).mul(meanderBand);
    // shells cut from the body have no panel uv; their border comes from _edge
    const shellBorder = float(1).sub(smoothstep(0.018, 0.024, edge()));
    const t = max(max(max(borderX, borderY), meander), shellBorder);
    col = mix(col, color(trim), t);
    m.metalnessNode = t.mul(0.9);
    m.roughnessNode = mix(float(0.82), float(0.3), t);
    // gold thread embroidery sits on top of the cloth
    height = height.add(t.mul(0.0012));
  }
  m.colorNode = col;
  relief(m, height);
  return m;
}

/** Striped headcloth (a nemes): bands of cloth and gold along uv.y, gold-trimmed hem. */
function stripesMaterial(c: number, trim: number): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.7, sheen: 0.5, sheenRoughness: 0.4, side: THREE.DoubleSide });
  m.sheenColor = new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.4);
  const v = uv();
  const weave = mx_noise_float(positionGeometry.mul(vec3(240, 240, 240))).mul(0.05);
  const band = smoothstep(0.42, 0.5, fract(v.y.mul(9))).mul(float(1).sub(smoothstep(0.92, 1.0, fract(v.y.mul(9)))));
  const hem = float(1).sub(smoothstep(0.03, 0.045, min(v.x, float(1).sub(v.x)))).max(smoothstep(0.95, 0.965, v.y));
  const t = max(band, hem);
  m.colorNode = mix(color(c).add(weave), color(trim), t);
  m.metalnessNode = t.mul(0.9);
  m.roughnessNode = mix(float(0.7), float(0.28), t);
  relief(m, t.mul(0.0012));
  return m;
}

function leatherMaterial(c: number, trim: number): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.6, clearcoat: 0.15, clearcoatRoughness: 0.5 });
  const e = edge();
  const grain = mx_fractal_noise_float(positionGeometry.mul(70), 3).mul(0.5).add(0.5);
  const stitch = smoothstep(0.006, 0.008, e).mul(float(1).sub(smoothstep(0.01, 0.012, e))).mul(fract(positionGeometry.y.mul(260).add(positionGeometry.x.mul(260))).step(0.5));
  const band = float(1).sub(smoothstep(0.004, 0.006, e));
  let col: any = mix(color(c).mul(0.65), color(c).mul(1.15), grain);
  col = mix(col, color(0xd8c8a0), stitch.mul(0.6));
  col = mix(col, color(trim), band);
  m.colorNode = col;
  m.metalnessNode = band;
  m.roughnessNode = mix(float(0.55).add(grain.mul(0.2)), float(0.25), band);
  // pebbled grain, the stitches pressed in and the gilt edge raised
  relief(m, grain.mul(0.001).mul(reliefFade(0.014)).sub(stitch.mul(0.0008)).add(band.mul(0.0012)));
  return m;
}

function hairMaterial(root: number, tip: number): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.45, sheen: 0.35, sheenRoughness: 0.35, side: THREE.DoubleSide });
  m.sheenColor = new THREE.Color(tip);
  const v = uv();
  const phase = v.x.mul(7).add(mx_noise_float(positionGeometry.mul(40)).mul(0.32));
  // the strands settle to their average once a pixel spans one, instead of beating
  // into moire stripes across a fur collar or a beard seen from the game camera
  const fw = fwidth(phase);
  const strands = mix(abs(sin(phase.mul(6.283))).pow(0.6), float(0.73), smoothstep(0.2, 0.55, fw));
  const t = data().x; // root 0 .. tip 1
  const tint = data().y.mul(0.16).add(0.88); // per-clump variation
  // roots sit in the shadow of the clumps around them
  const occl = smoothstep(0.0, 0.45, t).mul(0.55).add(0.45);
  // painted shine band a third of the way down each lock, broken up by the strands
  const shine = smoothstep(0.18, 0.3, t).mul(float(1).sub(smoothstep(0.38, 0.52, t))).mul(strands).mul(0.22);
  m.colorNode = mix(color(root), color(tip), t.mul(0.8)).mul(strands.mul(0.3).add(0.62)).mul(occl).mul(tint).add(color(tip).mul(shine));
  m.roughnessNode = float(0.5).sub(strands.mul(0.15));
  // each lock is a bundle of strands: smooth ridges along it catch the light. The bump
  // goes long before the color does: a ridge a few pixels across already flips the
  // normal from pixel to pixel and reads as a checkered dither on thin locks
  relief(m, sin(phase.mul(6.283)).mul(0.00075).mul(float(1).sub(smoothstep(0.06, 0.2, fw))).mul(reliefFade(0.005)));
  // strand sheen (Kajiya-Kay): hair shines in bands across the strands, not in spots. The
  // lock runs the way its root-to-tip value rises over the surface, and a key light above
  // and beside the camera lights it twice: a tight pale band, and a wider one tinted by the
  // hair, shifted toward the tips (light that went into the strand and back out)
  const g = surfaceGradient(t).grad;
  const along = g.div(max(length(g), float(1e-12)));
  const hv = vec3(-0.3, 0.55, 0.78).normalize().add(positionView.normalize().negate()).normalize();
  const band = (shift: number, power: number): any => {
    const th = dot(along.add(normalView.mul(shift)).normalize(), hv);
    return pow(saturate(float(1).sub(th.mul(th))), power);
  };
  const lit = strands.mul(occl).mul(tint);
  m.emissiveNode = vec3(1, 0.97, 0.92).mul(band(-0.1, 110).mul(0.3)).add(color(tip).mul(band(0.14, 20).mul(0.22))).mul(lit);
  return m;
}

function glowMaterial(c: number, strength = 6): THREE.Material {
  const m = new THREE.MeshBasicNodeMaterial();
  const flicker = sin(time.mul(9)).mul(0.08).add(sin(time.mul(23.0)).mul(0.05)).add(1);
  m.colorNode = color(c).mul(strength).mul(flicker);
  return m;
}

function eyeMaterial(c: number, glow = 1.4): THREE.Material {
  // a lit, wet eye: off-white sclera under the shadow of the upper lid, a large stylized
  // iris streaked out from the pupil with a dark limbal ring and a bright collarette,
  // a faint godly glow in the iris only, and the catchlight of a key light in the cornea
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.03 });
  const e = data();
  const d = e.x; // 1 at the pupil, falling off toward the white
  const real = e.w; // a real eyeball, with its up and across directions in y and z
  const up = e.y.mul(2).sub(1).mul(real);
  const iris = smoothstep(0.78, 0.81, d);
  const limbal = iris.mul(float(1).sub(smoothstep(0.81, 0.86, d)));
  const pupil = smoothstep(0.955, 0.965, d);
  const collarette = smoothstep(0.9, 0.935, d).mul(float(1).sub(pupil));
  const grain = mx_noise_float(positionGeometry.mul(900)).mul(0.25).add(0.85);
  // fibers radiate from the pupil: streaks around the eye's axis, broken up by noise
  const around = atan(e.y.mul(2).sub(1), e.z.mul(2).sub(1));
  const streak = abs(sin(around.mul(19).add(mx_noise_float(positionGeometry.mul(500)).mul(2.5)))).mul(0.35).add(0.75);
  const fibers = mix(grain, grain.mul(streak), real);
  const sclera = mix(color(0xd8cfc4), color(0xf2ece4), smoothstep(0.3, 0.75, d));
  // darker toward the rim, so even a pale god's iris stands clear of the white
  const irisTone = smoothstep(0.81, 0.93, d).mul(0.5).add(0.5);
  let col: any = mix(sclera, color(c).mul(fibers).mul(irisTone).mul(float(1).add(collarette.mul(0.45))), iris);
  col = mix(col, color(c).mul(0.12), limbal.mul(0.85));
  col = mix(col, color(0x050404), pupil);
  // the upper lid shades the top of the eye, and the corners sit in shadow
  const lid = float(1).sub(smoothstep(0.05, 0.6, up).mul(0.5)).mul(float(1).sub(float(1).sub(smoothstep(0.2, 0.55, d)).mul(real).mul(0.35)));
  m.colorNode = col.mul(lid);
  const key = smoothstep(0.991, 0.996, normalView.dot(vec3(-0.25, 0.32, 1).normalize())).mul(real);
  m.emissiveNode = color(c).mul(iris.mul(float(1).sub(pupil)).mul(fibers).mul(irisTone).mul(lid).mul(glow)).add(vec3(1, 0.98, 0.95).mul(key.mul(2.2)));
  return m;
}

function gemMaterial(c: number): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.05, metalness: 0, clearcoat: 1, transmission: 0 });
  m.colorNode = color(c).mul(0.6);
  m.emissiveNode = color(c).mul(rim().mul(2).add(0.8).mul(sin(time.mul(2)).mul(0.2).add(1)));
  return m;
}

const cache = new Map<string, Map<string, THREE.Material>>();

/** Materials for one god (shared by every instance), keyed by the material names the build script writes. */
export function godMaterials(id: string, variant?: string): Map<string, THREE.Material> {
  const key = `${id}/${variant ?? ''}`;
  let m = cache.get(key);
  if (!m) cache.set(key, (m = buildMaterials(id, variant)));
  return m;
}

function buildMaterials(id: string, variant?: string): Map<string, THREE.Material> {
  const p = paletteOf(id, variant);
  const m = new Map<string, THREE.Material>();
  m.set('skin', p.frost ? frostSkinMaterial(p) : p.scaly ? scalySkinMaterial(p) : skinMaterial(p));
  m.set('gold', metalMaterial(p.gold, 0xffe7a0, { engrave: true }));
  m.set('goldplain', metalMaterial(p.gold, 0xffe7a0));
  m.set('steel', metalMaterial(p.steel, p.gold, { engrave: true }));
  m.set('cloth', clothMaterial(p.cloth, p.clothDeep, p.gold, { pattern: true }));
  m.set('clothplain', clothMaterial(p.cloth, p.clothDeep, p.gold));
  m.set('cloth2', clothMaterial(p.cloth2, new THREE.Color(p.cloth2).multiplyScalar(0.55).getHex(), p.gold, { pattern: true }));
  m.set('leather', leatherMaterial(p.leather, p.gold));
  m.set('stripes', stripesMaterial(p.cloth2, p.gold));
  m.set('hair', hairMaterial(p.hair, p.hairTip));
  m.set('fur', hairMaterial(p.fur, p.furTip ?? new THREE.Color(p.fur).lerp(new THREE.Color(0xffe8c8), 0.3).getHex()));
  m.set('glow', glowMaterial(p.glow));
  // a frost giant's eyes burn cold, visible across the valley
  m.set('eye', eyeMaterial(p.eye, p.frost ? 6 : 1.4));
  m.set('gem', gemMaterial(p.gem));
  m.set('default', new THREE.MeshStandardNodeMaterial({ color: 0x888888 }));
  for (const [name, mat] of m) {
    mat.name = name;
    // contact shadows on everything lit; glow and eyes stay bright
    const nm = mat as THREE.MeshPhysicalNodeMaterial;
    if (nm.colorNode && name !== 'glow' && name !== 'eye') nm.colorNode = nm.colorNode.mul(mix(float(1), ao(), 0.92));
    const h = (mat as Relief).reliefNode;
    if (h) nm.normalNode = reliefNormal(h);
  }
  return m;
}

/**
 * The part materials each combined material draws, in the order of the
 * `_part` vertex attribute: the metals, and everything else (the body).
 */
export const COMBINED: Record<string, readonly string[]> = {
  metal: ['gold', 'goldplain', 'steel'],
  body: ['skin', 'cloth', 'clothplain', 'cloth2', 'stripes', 'leather', 'hair', 'fur', 'eye', 'gem', 'glow'],
};

const combinedCache = new Map<string, Map<string, THREE.Material>>();

/**
 * Each god model's own hit flash (`hit` 0..1 in `hitColor`), read by the
 * combined materials every model of a god shares, so a struck god flashes
 * without a material of its own (see GodModel.flash).
 */
export const hitUniforms = () => ({ hit: 0, hitColor: new THREE.Color(0xffffff) });
let hitNodes: ReturnType<typeof objectUniforms<ReturnType<typeof hitUniforms>>> | null = null;

/**
 * One material per `COMBINED` group for one god (shared by every instance),
 * shading each vertex's part (`_part`) exactly as that part's own material
 * does, so a god draws in two calls instead of one per material. Only the
 * `present` parts are compiled in.
 */
export function combinedMaterials(id: string, variant: string | undefined, present: ReadonlySet<string>): Map<string, THREE.Material> {
  const key = `${id}/${variant ?? ''}`;
  let out = combinedCache.get(key);
  if (!out) {
    const mats = godMaterials(id, variant);
    out = new Map();
    for (const [name, parts] of Object.entries(COMBINED)) {
      const used = parts.map((p) => (present.has(p) ? (mats.get(p) as THREE.MeshPhysicalNodeMaterial) : undefined));
      if (used.some(Boolean)) out.set(name, combine(name, used));
    }
    combinedCache.set(key, out);
  }
  return out;
}

function combine(name: string, parts: readonly (THREE.MeshPhysicalNodeMaterial | undefined)[]): THREE.MeshPhysicalNodeMaterial {
  const part = attribute('_part', 'float');
  // Every part's nodes run and the vertex's part picks one (`uniformFlow`
  // makes each pick a select() rather than an if: values shared between parts,
  // like the vertex data, would otherwise be computed only inside the first
  // part's branch). Parts are small on screen, so the extra math is cheap.
  const pick = (of: (m: THREE.MeshPhysicalNodeMaterial, lit: boolean) => any): any => {
    let node: any = null;
    parts.forEach((m, i) => {
      if (!m) return;
      const v = of(m, !(m as unknown as THREE.MeshBasicNodeMaterial).isMeshBasicNodeMaterial);
      node = node === null ? v : select(part.sub(i).abs().lessThan(0.5), v, node).uniformFlow();
    });
    // As a variable: a uniform-flow select built a second time (three reads
    // metalness twice) returns a variable it never assigned, which shaded
    // metal with full diffuse, grey instead of mirror-dark.
    return node.toVar();
  };
  const used = parts.filter((m): m is THREE.MeshPhysicalNodeMaterial => !!m);
  const c = new THREE.MeshPhysicalNodeMaterial({ side: used.some((m) => m.side === THREE.DoubleSide) ? THREE.DoubleSide : THREE.FrontSide });
  // an unlit glow becomes pure emission
  c.colorNode = pick((m, lit) => (lit ? vec3(m.colorNode ?? color(m.color)) : vec3(0)));
  // a struck god flashes for a moment: white-hot along the silhouette, a lighter wash over the rest
  const h = (hitNodes ??= objectUniforms(hitUniforms()));
  const emissive = pick((m, lit) => (lit ? vec3(m.emissiveNode ?? color(m.emissive).mul(m.emissiveIntensity)) : vec3(m.colorNode)));
  c.emissiveNode = emissive.add(h.hitColor.mul(h.hit.mul(rim().mul(4).add(0.6))));
  c.roughnessNode = pick((m, lit) => (lit ? float(m.roughnessNode ?? m.roughness) : float(1)));
  c.metalnessNode = pick((m, lit) => (lit ? float(m.metalnessNode ?? m.metalness) : float(0)));
  // zero sheen and zero clearcoat shade exactly as a material without them
  if (used.some((m) => m.sheen > 0)) {
    c.sheenNode = pick((m, lit) => (lit && m.sheen > 0 ? color(m.sheenColor).mul(m.sheen) : vec3(0)));
    c.sheenRoughnessNode = pick((m, lit) => float(lit ? m.sheenRoughness : 1));
  }
  if (used.some((m) => m.clearcoat > 0)) {
    c.clearcoatNode = pick((m, lit) => float(lit ? m.clearcoat : 0));
    c.clearcoatRoughnessNode = pick((m, lit) => float(lit ? m.clearcoatRoughness : 0));
  }
  // one bump for the whole god from each part's relief height
  if (used.some((m) => (m as Relief).reliefNode)) c.normalNode = reliefNormal(pick((m, lit) => (lit && (m as Relief).reliefNode ? float((m as Relief).reliefNode) : float(0))));
  c.name = name;
  return c;
}
