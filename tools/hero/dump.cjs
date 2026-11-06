// Saves each god's posed pieces for render.py: tools/hero/out/<god>.json.
//   npx vite            (in another terminal; the dev server on port 5173)
//   node tools/hero/dump.cjs [zeus,thor,...]
// Needs Playwright (npm i, or any install `require` can find).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ALL = 'zeus,thor,odin,loki,anubis,thanatos,kukulkan,cthulhu,jotunn';

(async () => {
  const gods = (process.argv[2] ?? ALL).split(',').filter(Boolean);
  const dir = path.join(__dirname, 'out');
  fs.mkdirSync(dir, { recursive: true });
  const base = process.env.DUMP_URL ?? 'http://localhost:5173/tools/hero/dump.html';
  const browser = await chromium.launch();
  for (const god of gods) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`${base}?god=${god}${process.env.DUMP_T ? `&t=${process.env.DUMP_T}` : ''}`);
    await page.waitForFunction(() => window.__dump, null, { timeout: 300000 });
    const json = await page.evaluate(() => window.__dump);
    const log = await page.evaluate(() => document.getElementById('log').textContent);
    if (json === 'error') throw new Error(log);
    fs.writeFileSync(path.join(dir, `${god}.json`), json);
    console.log(log);
    await page.close();
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
