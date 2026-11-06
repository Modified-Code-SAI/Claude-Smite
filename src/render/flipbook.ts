import * as THREE from 'three/webgpu';
import { float, floor, mix, mod, texture, vec2 } from './tsl';

/**
 * Flipbooks: smoke, fire, dust and a blast, simulated and rendered offline
 * (tools/vfx/flipbooks.py) into 8x8 sheets of frames. Each sheet packs
 *   R = the smoke as lit by a sun above and to the left (sqrt-encoded),
 *   G = opacity,
 *   B = flame heat (sqrt-encoded),
 * so one sheet serves every tint and team color: effects color the smoke and
 * the flame themselves. Frames are blended, so a sheet plays smoothly at any
 * speed.
 */
export type FlipbookName = 'fire' | 'smoke' | 'dust' | 'blast';

export const FLIPBOOK_COLS = 8;
export const FLIPBOOK_ROWS = 8;
export const FLIPBOOK_FRAMES = FLIPBOOK_COLS * FLIPBOOK_ROWS;

/** Frame width over height of each sheet's frames. */
export const FLIPBOOK_ASPECT: Record<FlipbookName, number> = { fire: 0.5, smoke: 1, dust: 2, blast: 1 };

const sheets = new Map<FlipbookName, THREE.Texture>();

/**
 * The sheet's texture. The same object before and after it loads, so
 * materials can be built at any time; `loadFlipbooks` fills it in.
 */
export function flipbook(name: FlipbookName): THREE.Texture {
  let t = sheets.get(name);
  if (!t) {
    t = new THREE.Texture();
    t.name = `flipbook-${name}`;
    // packed data, not color
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    sheets.set(name, t);
  }
  return t;
}

/** Loads every sheet (about 3 MB in all). Call once while the game loads, before building effects' shaders. */
export async function loadFlipbooks(): Promise<void> {
  const loader = new THREE.ImageLoader();
  await Promise.all((Object.keys(FLIPBOOK_ASPECT) as FlipbookName[]).map(async (name) => {
    const image = await loader.loadAsync(`${import.meta.env.BASE_URL}fx/${name}.webp`);
    const t = flipbook(name);
    t.image = image;
    t.needsUpdate = true;
  }));
}

/**
 * Samples a sheet at `frame` (0 .. FLIPBOOK_FRAMES, fractional; wraps when
 * `loop`, else holds the last frame), blending the two nearest frames.
 * `at` is the uv within the frame (0..1, y up). Returns the raw packed vec4.
 */
export function sampleFlipbook(name: FlipbookName, frame: any, at: any, loop: boolean): any {
  const n = FLIPBOOK_FRAMES;
  const f = loop ? mod(frame, n) : frame.clamp(0, n - 1.001);
  const f0 = floor(f);
  const w = f.sub(f0);
  const f1 = loop ? mod(f0.add(1), n) : f0.add(1).min(n - 1);
  const map = flipbook(name);
  // frame i sits in column i % COLS of row i / COLS, rows counted from the top of the image
  const cell = (i: any) => {
    const col = mod(i, FLIPBOOK_COLS);
    const row = floor(i.div(FLIPBOOK_COLS));
    return vec2(col.add(at.x).div(FLIPBOOK_COLS), float(FLIPBOOK_ROWS - 1).sub(row).add(at.y).div(FLIPBOOK_ROWS));
  };
  return mix(texture(map, cell(f0)), texture(map, cell(f1)), w);
}

/** The decoded channels of a sample: `lit` and `heat` back to linear, `alpha` as stored. */
export function unpackFlipbook(s: any): { lit: any; alpha: any; heat: any } {
  return { lit: s.r.mul(s.r), alpha: s.g, heat: s.b.mul(s.b) };
}
