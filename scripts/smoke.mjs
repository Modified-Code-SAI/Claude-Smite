#!/usr/bin/env node
/**
 * Boot smoke test: starts every mode of the built game (dist/) in headless
 * Chromium on WebGL 2, plays about five seconds, and fails when
 *
 * - the page throws or logs an error,
 * - a frame comes out blank,
 * - a shader is generated during play (a mid-match freeze on real GPUs), or
 * - a frame sends more draw calls than the mode's budget in scripts/smoke-budgets.json.
 *
 * Usage:
 *   npx vite build && node scripts/smoke.mjs                 # every mode
 *   node scripts/smoke.mjs duel clash                         # some modes
 *   node scripts/smoke.mjs --shard 1/4                        # a quarter of the modes (CI)
 *   node scripts/smoke.mjs --update                           # rewrite the budgets from this run
 *
 * Budgets are the most draw calls seen in any sampled frame, plus 30%. A change
 * that adds draw calls on purpose updates them with `--update` in the same PR.
 * Software rendering is slow, so frames are stepped by `__game.capture`
 * (see src/main.ts) instead of a live loop: about 20-50 s for the first frame
 * (shader generation), then a few seconds of play.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const MODES = ['arena', 'conquest', 'clash', 'siege', 'duel', 'rush', 'descent', 'jotunn'];
const BUDGETS = path.resolve('scripts/smoke-budgets.json');
const MARGIN = 1.3;
/** Five seconds of play: 5 samples of 10 frames at the loop's 100 ms step cap. */
const SAMPLES = 5;
const FRAMES_PER_SAMPLE = 10;
const STEP_MS = 100;

const args = process.argv.slice(2);
const update = args.includes('--update');
const shardArg = args.indexOf('--shard');
let modes = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--shard');
if (!modes.length) modes = MODES;
if (shardArg >= 0) {
  const [k, n] = args[shardArg + 1].split('/').map(Number);
  modes = modes.filter((_, i) => i % n === k - 1);
}
const unknown = modes.filter((m) => !MODES.includes(m));
if (unknown.length) {
  console.error(`Unknown mode(s): ${unknown.join(', ')}. Modes: ${MODES.join(', ')}`);
  process.exit(2);
}

const root = path.resolve('dist');
if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('dist/index.html is missing: run `npx vite build` first.');
  process.exit(2);
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.json': 'application/json', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root + path.sep)) {
    res.statusCode = 403;
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    res.end(data);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;

const budgets = fs.existsSync(BUDGETS) ? JSON.parse(fs.readFileSync(BUDGETS, 'utf8')) : {};
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--disable-gpu-watchdog', '--enable-unsafe-swiftshader'] });
const results = [];

for (const mode of modes) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console error: ${m.text().slice(0, 400)}`);
  });
  const started = Date.now();
  const r = { mode, errors, draws: 0, triangles: 0, shadersDuringPlay: 0, shaderKinds: {}, blank: false, seconds: 0 };
  try {
    await page.goto(`http://127.0.0.1:${port}/?map=${mode}&quality=low&capture&webgl`);
    await page.waitForFunction(() => window.__game?.capture, null, { timeout: 300_000 });
    const out = await page.evaluate(
      async ({ samples, frames, step }) => {
        const g = window.__game;
        const info = g.renderer.info.render;
        /** Luminance spread of a frame, from a small copy of it. */
        const spread = async (url) => {
          const img = new Image();
          img.src = url;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = 64;
          c.height = 36;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, 64, 36);
          const d = ctx.getImageData(0, 0, 64, 36).data;
          let sum = 0;
          let sq = 0;
          for (let i = 0; i < d.length; i += 4) {
            const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            sum += l;
            sq += l * l;
          }
          const n = d.length / 4;
          return Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
        };
        let draws = 0;
        let triangles = 0;
        const first = await g.capture(1);
        draws = Math.max(draws, info.drawCalls);
        triangles = Math.max(triangles, info.triangles);
        const before = new Map(g.pipelines.builtFor);
        const builtBefore = g.pipelines.built;
        let last = first;
        for (let s = 0; s < samples; s++) {
          last = await g.capture(frames, step);
          draws = Math.max(draws, info.drawCalls);
          triangles = Math.max(triangles, info.triangles);
        }
        const kinds = {};
        for (const [what, n] of g.pipelines.builtFor) {
          const extra = n - (before.get(what) ?? 0);
          if (extra > 0) kinds[what] = extra;
        }
        return { draws, triangles, shaders: g.pipelines.built - builtBefore, kinds, spreadFirst: await spread(first), spreadLast: await spread(last) };
      },
      { samples: SAMPLES, frames: FRAMES_PER_SAMPLE, step: STEP_MS },
    );
    r.draws = out.draws;
    r.triangles = out.triangles;
    r.shadersDuringPlay = out.shaders;
    r.shaderKinds = out.kinds;
    r.blank = out.spreadFirst < 3 || out.spreadLast < 3;
  } catch (e) {
    errors.push(`did not finish: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  r.seconds = Math.round((Date.now() - started) / 1000);
  results.push(r);
  await page.close();
}
await browser.close();
server.close();

// ---------------------------------------------------------------------------
// Report

let failed = false;
const rows = [];
for (const r of results) {
  const problems = [...r.errors];
  if (r.blank) problems.push('a frame came out blank');
  if (r.shadersDuringPlay > 0) problems.push(`${r.shadersDuringPlay} shader(s) generated during play (would freeze a frame mid-match): ${JSON.stringify(r.shaderKinds)}`);
  const budget = budgets[r.mode]?.draws;
  if (!update && budget !== undefined && r.draws > budget) {
    problems.push(`${r.draws} draw calls in one frame, over the budget of ${budget}. If the increase is intended, run \`node scripts/smoke.mjs --update ${r.mode}\` and commit scripts/smoke-budgets.json.`);
  }
  if (!update && budget === undefined && !r.errors.length) problems.push('no draw-call budget yet: run with --update and commit scripts/smoke-budgets.json');
  if (problems.length) failed = true;
  rows.push(`| ${r.mode} | ${problems.length ? 'FAIL' : 'ok'} | ${r.draws} | ${budget ?? '-'} | ${(r.triangles / 1e6).toFixed(2)} M | ${r.shadersDuringPlay} | ${r.seconds} s |`);
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${r.mode}: ${r.draws} draws (budget ${budget ?? '-'}), ${(r.triangles / 1e6).toFixed(2)} M triangles, ${r.shadersDuringPlay} shaders during play, ${r.seconds} s`);
  for (const p of problems) console.log(`     - ${p}`);
}

if (update) {
  const next = { ...budgets };
  for (const r of results) {
    if (r.errors.length || r.blank) continue;
    next[r.mode] = { draws: Math.ceil(r.draws * MARGIN), measured: r.draws };
  }
  const sorted = Object.fromEntries(MODES.filter((m) => next[m]).map((m) => [m, next[m]]));
  fs.writeFileSync(BUDGETS, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Budgets written to ${path.relative(process.cwd(), BUDGETS)}`);
}

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  fs.appendFileSync(summary, ['### Boot smoke test', '', '| Mode | Result | Draw calls (max frame) | Budget | Triangles | Shaders during play | Time |', '| --- | --- | --- | --- | --- | --- | --- |', ...rows, ''].join('\n'));
}
process.exit(failed ? 1 : 0);
