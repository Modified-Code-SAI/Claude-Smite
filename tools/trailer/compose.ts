// The trailer's edit: draws any moment of it with `window.renderAt(t)`, so
// render.mjs can step through it frame by frame. Footage comes from film.mjs
// (out/frames), the rest is drawn here from the game's own data and icons.
// Served by Vite so it can import the game's modules.

import { GODS } from '../../src/game/gods';
import type { SkillDef } from '../../src/game/types';
import { skillIcon, talentIcon } from '../../src/ui/icons';
import { paletteFor } from '../../src/combat/palette';
// @ts-expect-error plain JS module shared with score.ts
import { FINALE, FRIENDS, HEROES, LENGTH, MODES, SKILLS, TITLE, TREES, VOICE } from './timeline.mjs';
import script from './script.json';

const W = 1920;
const H = 1080;
const FILM_FPS = 30;
const stage = document.getElementById('stage')!;
const lengths: Record<string, number> = await fetch('./out/voice/lengths.json').then((r) => r.json());

// ---------------------------------------------------------------------------
// Helpers

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x: number) => {
  const k = clamp(x);
  return k * k * (3 - 2 * k);
};
const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
/** 0 → 1 over [a, a+fadeIn], 1 → 0 over [b-fadeOut, b]. */
const window01 = (t: number, a: number, b: number, fadeIn = 0.35, fadeOut = 0.35) => Math.min(clamp((t - a) / fadeIn), clamp((b - t) / fadeOut));

/** When a word is spoken: its share of the line's characters, a rough but steady clock. */
function word(id: keyof typeof VOICE, w: string): number {
  const line = script.lines.find((l) => l.id === id)!;
  const i = line.text.indexOf(w);
  return VOICE[id] + (lengths[id] ?? 2) * ((i < 0 ? 0 : i) / line.text.length) * 0.94 + 0.08;
}

function el(cls: string, html = '', parent: HTMLElement = stage): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  parent.appendChild(d);
  return d;
}
function show(e: HTMLElement, o: number, transform = ''): void {
  e.style.opacity = String(o);
  e.style.display = o <= 0.001 ? 'none' : '';
  e.style.transform = transform;
}

// ---------------------------------------------------------------------------
// Footage: film.mjs frames, blended between neighbours when slowed down

const frameCount = new Map<string, number>();
async function countFrames(shot: string): Promise<number> {
  if (frameCount.has(shot)) return frameCount.get(shot)!;
  let lo = 0;
  let hi = 400;
  // binary search the last frame that exists
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const ok = await fetch(`./out/frames/${shot}/${String(mid).padStart(4, '0')}.jpg`, { method: 'HEAD' }).then((r) => r.ok && (r.headers.get('content-type') ?? '').includes('image'));
    if (ok) lo = mid;
    else hi = mid - 1;
  }
  const exists = await fetch(`./out/frames/${shot}/0000.jpg`, { method: 'HEAD' }).then((r) => r.ok && (r.headers.get('content-type') ?? '').includes('image'));
  const n = exists ? lo + 1 : 0;
  frameCount.set(shot, n);
  return n;
}

const images = new Map<string, Promise<HTMLImageElement>>();
function image(src: string): Promise<HTMLImageElement> {
  let p = images.get(src);
  if (!p) {
    const img = new Image();
    img.src = src;
    p = img.decode().then(() => img);
    images.set(src, p);
    if (images.size > 80) images.delete(images.keys().next().value!);
  }
  return p;
}

const canvas = document.createElement('canvas');
canvas.width = W;
canvas.height = H;
stage.appendChild(canvas);
const ctx = canvas.getContext('2d')!;

interface Clip {
  shot: string;
  start: number;
  end: number;
  /** Footage seconds per trailer second. */
  speed?: number;
  /** Footage second to start from. */
  from?: number;
  /** Zoom at the start and end (Ken Burns), and drift in pixels. */
  zoom?: [number, number];
  drift?: [number, number];
  /** Brightness multiplier (dims footage under overlays). */
  dim?: number;
  blur?: number;
}

async function drawClip(c: Clip, t: number, alpha: number): Promise<void> {
  const n = await countFrames(c.shot);
  const local = t - c.start;
  const k = (c.end - c.start) > 0 ? local / (c.end - c.start) : 0;
  const z = c.zoom ? c.zoom[0] + (c.zoom[1] - c.zoom[0]) * ease(k) : 1.04;
  const dx = (c.drift?.[0] ?? 0) * (k - 0.5);
  const dy = (c.drift?.[1] ?? 0) * (k - 0.5);
  ctx.save();
  ctx.globalAlpha = alpha;
  const dim = c.dim ?? 1;
  ctx.filter = `contrast(1.08) saturate(1.12) brightness(${dim})${c.blur ? ` blur(${c.blur}px)` : ''}`;
  ctx.translate(W / 2 + dx, H / 2 + dy);
  ctx.scale(z, z);
  if (n === 0) {
    // not filmed yet: a placeholder so the edit still renders
    const g = ctx.createLinearGradient(0, -H / 2, 0, H / 2);
    g.addColorStop(0, '#2a3446');
    g.addColorStop(1, '#3a2a1a');
    ctx.fillStyle = g;
    ctx.fillRect(-W / 2, -H / 2, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '40px Cinzel';
    ctx.textAlign = 'center';
    ctx.fillText(c.shot, 0, 0);
  } else {
    const f = clamp(((c.from ?? 0) + local * (c.speed ?? 1)) * FILM_FPS, 0, n - 1);
    const i = Math.floor(f);
    const frac = f - i;
    const a = await image(`./out/frames/${c.shot}/${String(i).padStart(4, '0')}.jpg`);
    ctx.drawImage(a, -W / 2, -H / 2, W, H);
    if (frac > 0.02 && i + 1 < n) {
      const b = await image(`./out/frames/${c.shot}/${String(i + 1).padStart(4, '0')}.jpg`);
      ctx.globalAlpha = alpha * frac;
      ctx.drawImage(b, -W / 2, -H / 2, W, H);
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// The edit: title, the five gods, the kit, the modes, friends, the end card

type Hero = { god: string; at: number };
type Mode = { shot: string; name: string; sub: string; at: number };
const heroEnd = (i: number) => (i < HEROES.length - 1 ? HEROES[i + 1].at : SKILLS);
const modeEnd = (i: number) => (i < MODES.length - 1 ? MODES[i + 1].at : FRIENDS);
const clips: Clip[] = [
  ...HEROES.map((h: Hero, i: number) => ({ shot: `hero${h.god[0]!.toUpperCase()}${h.god.slice(1)}`, start: h.at, end: heroEnd(i), speed: 1, from: 0.25, zoom: [1.0, 1.06] as [number, number] })),
  { shot: 'brawlB', start: SKILLS, end: VOICE.modes - 0.3, speed: 0.3, from: 0.2, zoom: [1.0, 1.1], dim: 0.36, blur: 3 },
  ...MODES.map((m: Mode, i: number) => ({ shot: m.shot, start: m.at, end: modeEnd(i), speed: 0.9, from: i === 0 ? 0.2 : 0.3, zoom: (i % 2 ? [1.0, 1.06] : [1.06, 1.0]) as [number, number] })),
  { shot: 'cqFight', start: FRIENDS, end: FINALE, speed: 0.75, zoom: [1.0, 1.08] },
];
/** Crossfade length at each cut (0 = hard cut). */
const XF = 0.1;

// Title
const title = el('title gold', 'ASCENDANT');
const subtitle = el('subtitle', 'A WAR OF GODS');

// Hero name cards
const cards = HEROES.map((h: Hero) => {
  const g = GODS.find((d) => d.id === h.god)!;
  return el('card', `<div class="name gold">${g.name.toUpperCase()}</div><div class="rule"></div><div class="sub">${g.title.toUpperCase()}</div>`);
});

// Your skills: Zeus's loadout, three skills and the ultimate
const zeus = GODS.find((g) => g.id === 'zeus')!;
const loadout = zeus.defaultLoadout.map((id) => zeus.skills.find((s) => s.id === id)!);
const ULT = loadout.length - 1;
const slotHtml = (s: SkillDef, i: number) => `<div class="slot${i === ULT ? ' ult' : ''}"><div class="key">${i + 1}</div><div class="ico">${skillIcon(zeus.id, s)}</div><div class="sn">${s.name}</div></div>`;
const bar = el('bar', loadout.map(slotHtml).join(''));
const slots = [...bar.children] as HTMLElement[];
const skillsHeading = el('heading gold', 'YOUR SKILLS');
const skillsSub = el('points gold', `${zeus.skills.length} TO CHOOSE FROM  ·  SWAP ANY, EVEN THE ULTIMATE`);
skillsSub.style.top = '680px';
skillsSub.style.fontSize = '40px';

// Trees
const accent = '#' + paletteFor(zeus.id).vfx.toString(16).padStart(6, '0');
const trees = el('trees', zeus.trees.map((tr) => `<div class="tree"><h4>${tr.name.toUpperCase()}</h4><div class="theme">${tr.theme}</div>${[1, 2, 3, 4].map((tier) => `<div class="tier">${tr.nodes.filter((n) => n.tier === tier).map((n) => `<div class="node" data-max="${n.maxRank}">${talentIcon(zeus.id, n, zeus.skills, accent)}<span class="rk"></span></div>`).join('')}</div>`).join('')}</div>`).join(''));
const treeEls = [...trees.children] as HTMLElement[];
const nodeEls = treeEls.map((t) => [...t.querySelectorAll<HTMLElement>('.node')]);
const treesHeading = el('heading gold', 'YOUR PLAYSTYLE');
const points = el('points gold', '');

// Chips over the game footage
const chips = el('chips');
function setChips(items: [string, number][], t: number): void {
  const html = items.map(([s]) => `<div class="chip">${s}</div>`).join('');
  if (chips.dataset.html !== html) {
    chips.innerHTML = html;
    chips.dataset.html = html;
  }
  [...chips.children].forEach((c, i) => show(c as HTMLElement, easeOut((t - items[i]![1]) / 0.25), `translateY(${(1 - easeOut((t - items[i]![1]) / 0.25)) * 30}px)`));
  show(chips, items.length ? 1 : 0);
}
const modeCard = el('card', '<div class="name gold"></div><div class="rule"></div><div class="sub"></div>');
const modesHeading = el('heading gold', 'SEVEN MODES');

const vignette = el('bars');
const caption = el('caption');
const flash = el('flash');

// embers drifting over the title and the end card
const embers = Array.from({ length: 70 }, (_, i) => {
  const r = (k: number) => {
    const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  return { x: r(1) * W, y: r(2) * H, s: 1 + r(3) * 3, v: 30 + r(4) * 80, w: r(5) * 6.28 };
});
function drawEmbers(t: number, alpha: number): void {
  if (alpha <= 0) return;
  ctx.save();
  for (const e of embers) {
    const y = ((e.y - e.v * t) % H + H) % H;
    const x = e.x + Math.sin(t * 0.8 + e.w) * 30;
    const a = alpha * (0.4 + 0.6 * Math.abs(Math.sin(t * 2 + e.w)));
    const g = ctx.createRadialGradient(x, y, 0, x, y, e.s * 4);
    g.addColorStop(0, `rgba(255, 210, 130, ${a})`);
    g.addColorStop(1, 'rgba(255, 140, 40, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - e.s * 4, y - e.s * 4, e.s * 8, e.s * 8);
  }
  ctx.restore();
}

function backdrop(t: number, alpha: number): void {
  // a dark stormy sky behind the title cards
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(W / 2, H * 0.45, 50, W / 2, H * 0.5, W * 0.7);
  g.addColorStop(0, '#3a2a18');
  g.addColorStop(0.5, '#140e0a');
  g.addColorStop(1, '#030202');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  drawEmbers(t, alpha);
}

/** Captions: one per line, shown while it is spoken. */
const phrases = script.lines.map((l) => ({ text: l.text, at: VOICE[l.id as keyof typeof VOICE], end: VOICE[l.id as keyof typeof VOICE] + (lengths[l.id] ?? 2) }));

// ---------------------------------------------------------------------------

async function renderAt(t: number): Promise<void> {
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  // footage, crossfading into each new clip
  for (const c of clips) {
    if (t < c.start - XF || t >= c.end) continue;
    const a = clamp((t - (c.start - XF)) / XF);
    await drawClip(c, t, a);
  }
  const H0 = HEROES[0].at;
  const titleA = window01(t, TITLE, H0, 0.05, 0.3);
  backdrop(t, titleA);
  const endA = clamp((t - FINALE) / 0.08);
  backdrop(t, endA);

  // vignette
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.05);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);

  // title
  const tt = t - TITLE;
  show(title, titleA, `scale(${1.18 - 0.18 * easeOut(tt / 2.0)})`);
  show(subtitle, window01(t, TITLE + 0.6, H0, 0.5, 0.3), `translateY(${(1 - easeOut((tt - 0.6) / 0.5)) * 16}px)`);
  // end card
  if (t >= FINALE) {
    show(title, endA, `scale(${1.12 - 0.12 * easeOut((t - FINALE) / 1.5)})`);
    show(subtitle, clamp((t - FINALE - 0.5) / 0.5));
    subtitle.textContent = 'PLAY NOW';
  } else subtitle.textContent = 'A WAR OF GODS';

  // hero name cards
  cards.forEach((c: HTMLElement, i: number) => {
    const at = HEROES[i].at + 0.08;
    show(c, window01(t, at, heroEnd(i), 0.15, 0.12), `translateX(${(1 - easeOut((t - at) / 0.3)) * -50}px)`);
  });

  // your skills: the bar drops in, each tile glinting in turn
  const s1 = window01(t, SKILLS, TREES, 0.25, 0.25);
  show(skillsHeading, s1);
  show(bar, s1);
  show(skillsSub, s1 * clamp((t - SKILLS - 0.9) / 0.3));
  slots.forEach((s, i) => {
    const at = SKILLS + 0.15 + i * 0.18;
    const lit = window01(t, at + 0.2, at + 1.1, 0.12, 0.4);
    s.style.filter = lit > 0 ? `drop-shadow(0 0 ${18 * lit}px rgba(255, 210, 120, ${0.9 * lit}))` : '';
    show(s, easeOut((t - at) / 0.3), `translateY(${(1 - easeOut((t - at) / 0.3)) * 40}px) scale(${1 + 0.06 * lit})`);
  });

  // your playstyle: points flow into the three trees until all 35 are spent
  const s3 = window01(t, TREES, VOICE.modes - 0.3, 0.25, 0.25);
  show(trees, s3);
  show(treesHeading, s3);
  show(points, s3);
  const spendStart = TREES + 0.4;
  const spendEnd = VOICE.modes - 0.8;
  const spent = Math.round(35 * clamp((t - spendStart) / (spendEnd - spendStart)));
  points.textContent = `THREE TREES  ·  ${spent} / 35 POINTS`;
  // one tree filled up to its keystone, the rest into a second: mix and match
  const order: [number, number][] = [];
  for (const tr of [0, 1, 2]) nodeEls[tr]!.forEach((node, n) => { for (let r = 0; r < Number(node.dataset.max); r++) order.push([tr, n]); });
  const ranks = nodeEls.map((ns) => ns.map(() => 0));
  for (let k = 0; k < Math.min(spent, order.length); k++) ranks[order[k]![0]]![order[k]![1]]!++;
  nodeEls.forEach((ns, tr) => ns.forEach((n, i) => {
    const r = ranks[tr]![i]!;
    n.style.borderColor = r ? '#f0c977' : '#5a4424';
    n.style.filter = r ? 'none' : 'grayscale(0.85) brightness(0.55)';
    n.style.boxShadow = r ? '0 0 18px rgba(255, 200, 100, 0.55)' : 'none';
    n.querySelector('.rk')!.textContent = r ? `${r}/${n.dataset.max}` : '';
  }));
  treeEls.forEach((e, i) => show(e, s3 * easeOut((t - TREES - i * 0.12) / 0.3), `translateY(${(1 - easeOut((t - TREES - i * 0.12) / 0.3)) * 40}px)`));

  // the modes: a name card on each cut, and the count over them all
  let shown = false;
  MODES.forEach((m: Mode, i: number) => {
    if (t < m.at || t >= modeEnd(i)) return;
    shown = true;
    modeCard.querySelector('.name')!.textContent = m.name;
    modeCard.querySelector('.sub')!.textContent = m.sub;
    show(modeCard, window01(t, m.at + 0.05, modeEnd(i), 0.15, 0.1), `translateX(${(1 - easeOut((t - m.at) / 0.3)) * -50}px)`);
  });
  if (!shown) show(modeCard, 0);
  show(modesHeading, window01(t, MODES[0].at + 0.2, FRIENDS, 0.3, 0.25));

  // friends
  const fA = window01(t, FRIENDS, FINALE, 0.2, 0.2);
  if (t >= FRIENDS && t < FINALE) setChips([['SOLO', VOICE.friends + 0.05], ['CO-OP', VOICE.friends + 0.9], ['VERSUS', VOICE.friends + 1.15], ['ONLINE WITH FRIENDS', VOICE.friends + 1.4]], t);
  else setChips([], t);
  chips.style.opacity = String(fA);

  // letterbox bars while the game is on screen, gone for the title and the menus
  const ui = Math.max(titleA, s1, s3, endA);
  show(vignette, 1 - ui);

  // captions: the line being spoken
  let cap = '';
  for (const c of phrases) if (t >= c.at - 0.1 && t < c.end + 0.2) cap = c.text;
  caption.textContent = cap;
  show(caption, cap ? 1 : 0);

  // white flashes: the title hit, the mode cuts, the last hit
  const flashAt = [TITLE, ...MODES.map((m: Mode) => m.at), FINALE];
  let f = 0;
  for (const a of flashAt) if (t >= a) f = Math.max(f, (a === TITLE || a === FINALE ? 0.95 : 0.35) * Math.exp(-(t - a) * 8));
  show(flash, f);
  // fade to black at the very end
  if (t > LENGTH - 0.6) {
    flash.style.background = '#000';
    show(flash, clamp((t - (LENGTH - 0.6)) / 0.5));
  } else flash.style.background = '#fff';
}

await document.fonts.ready;
(window as unknown as { renderAt: typeof renderAt; ready: boolean }).renderAt = renderAt;
(window as unknown as { ready: boolean }).ready = true;
