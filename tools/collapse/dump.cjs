// Saves a Tower's and a Phoenix's parts, as the game builds them, for bake.py.
//   npx vite            (in another terminal; the dev server on port 5173)
//   node tools/collapse/dump.cjs [out.json]
// Needs Playwright (npm i -g playwright, or any install `require` can find).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const out = process.argv[2] ?? path.join(__dirname, 'out', 'parts.json');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(process.env.DUMP_URL ?? 'http://localhost:5173/tools/collapse/dump.html');
  await page.waitForFunction(() => window.__dump, null, { timeout: 300000 });
  const json = await page.evaluate(() => window.__dump);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json);
  console.log(await page.evaluate(() => document.getElementById('log').textContent), '->', out);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
