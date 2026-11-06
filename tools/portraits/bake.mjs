// Bakes the god face cards into public/portraits/<god>.jpg, or with --splash
// the god pick screen's full-length art into public/splash/<god>.jpg.
// Renders each god with the `?showcase=<god>&view=bust` (or `view=splash`) dev
// view in headless Chromium (WebGL 2, the software GPU path that works on CI boxes).
//
//   npm run build && npx vite preview --port 4173 &
//   node tools/portraits/bake.mjs [http://localhost:4173] [zeus,thor,...] [--splash]
//
// Needs Playwright with Chromium. Re-run after god model changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// CommonJS resolution so a globally installed Playwright (NODE_PATH) works too
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const splash = args.includes('--splash');
const [base = 'http://localhost:4173', list] = args.filter((a) => !a.startsWith('--'));
const gods = (list ?? (splash ? 'zeus,thor,odin,loki,anubis,thanatos,kukulkan,jotunn' : 'zeus,thor,odin,loki,anubis,thanatos,kukulkan')).split(',');
const out = new URL(splash ? '../../public/splash/' : '../../public/portraits/', import.meta.url);
const size = splash ? { width: 720, height: 1080 } : { width: 480, height: 600 };
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--disable-gpu-watchdog'] });
for (const god of gods) {
  const page = await browser.newPage({ viewport: size });
  await page.goto(`${base}/?showcase=${god}&view=${splash ? 'splash' : 'bust'}&flip&capture&webgl&quality=high`);
  await page.waitForFunction(() => window.__game, null, { timeout: 900_000 });
  const jpg = await page.evaluate(async (splash) => {
    const png = await window.__game.capture(splash ? 16 : 24);
    const img = new Image();
    img.src = png;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/jpeg', 0.86);
  }, splash);
  writeFileSync(new URL(`${god}.jpg`, out), Buffer.from(jpg.split(',')[1], 'base64'));
  console.log('baked', god);
  await page.close();
}
await browser.close();
