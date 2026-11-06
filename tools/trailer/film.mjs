// Films the trailer's in-game shots (shots.mjs) into out/frames/<shot>/NNNN.jpg.
// Each shot loads the game with `?stage` (src/dev/Stage.ts) in headless
// Chromium on the software WebGL 2 path, runs its `setup` in the page, then
// steps the game one frame at a time with `director` flying the camera.
//
//   npm run build && npx vite preview --port 4173 &
//   node tools/trailer/film.mjs [shot,shot,...] [--base http://localhost:4173] [--frames N] [--plate]
//
// `--plate` also films the last frame's instant again, settled, with every god,
// unit and effect hidden (NNNN-plate.jpg) and then shown (NNNN-full.jpg): the bare
// scenery is what tools/textures/keyart.py paints, and the difference between
// the two tells it where the gods are.
//
// Arena shots take ~15 s a frame at 1280x720, Conquest ~20 s (quality medium).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SHOTS } from './shots.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : def;
};
const base = opt('--base', 'http://localhost:4173');
const maxFrames = Number(opt('--frames', Infinity));
const width = Number(opt('--width', 1280));
const plate = args.includes('--plate') && !!args.splice(args.indexOf('--plate'), 1);
const height = Math.round((width * 9) / 16);
const names = (args[0] ?? Object.keys(SHOTS).join(',')).split(',');

const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--disable-gpu-watchdog'] });
for (const name of names) {
  try {
    await film(name);
  } catch (e) {
    // one bad shot shouldn't cost the rest of the queue
    console.log(name, 'failed:', e.message);
  }
}
await browser.close();

async function film(name) {
  const shot = SHOTS[name];
  if (!shot) throw new Error(`no shot ${name}`);
  const dir = new URL(`out/frames/${name}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => m.type() === 'error' && console.log(name, 'console:', m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log(name, 'page error:', e.message));
  const t0 = Date.now();
  await page.goto(`${base}/?stage&capture&webgl&${shot.url}`);
  await page.waitForFunction(() => window.__game, null, { timeout: 1_800_000 });
  const info = await page.evaluate(`(${shot.setup})(window.__game.stage, window.__game)`);
  if (info) console.log(name, 'setup:', JSON.stringify(info));
  await page.evaluate(`window.__game.stage.director = ${shot.director}`);
  // settle temporal AA and shaders on the opening view, with the shot's clock held at 0
  await page.evaluate(async (n) => {
    const s = window.__game.stage;
    s.hold = true;
    await window.__game.capture(n);
    s.hold = false;
  }, shot.warm ?? 4);
  const frames = Math.min(shot.frames, maxFrames);
  for (let f = 0; f < frames; f++) {
    const file = new URL(`${String(f).padStart(4, '0')}.jpg`, dir);
    const jpg = await page.evaluate(async () => {
      const png = await window.__game.capture(0, 1000 / 30);
      const img = new Image();
      img.src = png;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/jpeg', 0.92);
    });
    writeFileSync(file, Buffer.from(jpg.split(',')[1], 'base64'));
    if (plate && f === frames - 1) {
      // the same instant (no time step) rendered until temporal AA settles, without and then
      // with the gods, so the two differ only where the gods, units and effects are
      for (const [suffix, show] of [['plate', false], ['full', true]]) {
        const still = await page.evaluate(async (show) => {
          const g = window.__game, w = g.world;
          w.stageLit ??= w.spellLights.map((l) => l.intensity);
          w.actors.visible = w.vfx.visible = show;
          w.spellLights.forEach((l, i) => (l.intensity = show ? w.stageLit[i] : 0));
          const img = new Image();
          img.src = await g.capture(6, 0);
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          c.getContext('2d').drawImage(img, 0, 0);
          return c.toDataURL('image/jpeg', 0.95);
        }, show);
        writeFileSync(new URL(`${String(f).padStart(4, '0')}-${suffix}.jpg`, dir), Buffer.from(still.split(',')[1], 'base64'));
      }
    }
    if (f % 10 === 0) console.log(name, `frame ${f}/${frames}`, `${Math.round((Date.now() - t0) / 1000)} s`);
  }
  console.log(name, 'done', `${Math.round((Date.now() - t0) / 1000)} s`);
  await page.close();
}
