import type { GodDef, SkillDef } from '../game/types';
import { SLOT_KEYS } from '../game/loadout';
import { buildChoice, chooseBuild, startingBar } from '../game/builds';
import { lineupFor, type Lineup, type LineupSlot } from '../game/lineup';
import { jotunn } from '../game/gods/jotunn';
import type { JotunnRole } from '../combat/JotunnMode';
import type { NetPlayer } from '../net/roster';
import { PICK_SECONDS, type NetSession } from '../net/Session';
import { paletteFor } from '../combat/palette';
import { skillIcon } from './icons';
import { embersHtml, parallax } from './menuFx';
import { modeArt, modeBlur, modeInfo, type GameMode } from './modes';
import './godpick.css';

const BASE = import.meta.env.BASE_URL;
const ROLE_NAMES: Record<string, string> = { solo: 'Solo', jungle: 'Jungle', mid: 'Mid', carry: 'Carry', support: 'Support' };
const RANGE_NAMES: Record<string, string> = { melee: 'Melee', ranged: 'Ranged' };

/** The versus screen stays up at least this long (seconds), so the matchup reads even when the map is already built. */
const VERSUS_HOLD = 2.6;

/** Seconds a bot takes to lock in (cosmetic: their gods are fixed by the seed), and the cascade once every person is ready. */
const BOT_LOCK = { first: 1.2, spread: 5.5, cascade: 0.14 };

export interface PickSetup {
  mode: GameMode;
  net?: NetSession;
  gods: readonly GodDef[];
  /** The god the screen opens on (the last one played). */
  god: string;
  /** Temple Duel alone: the rival asked for last time ('' for random). */
  rival: string;
  allies?: boolean;
  rivals?: boolean;
  role?: JotunnRole;
  /** Picks the bots' gods (alone): the match is started with the same seed. */
  seed: number;
  /** A god was clicked: its voice says its line. */
  say?: (god: string) => void;
  /** A sound from the game's bank (ui.*). */
  sound?: (name: string, gain?: number) => void;
  /**
   * The music's intensity, 0 to 1, about ten times a second: low while
   * everyone chooses, rising over the second half of the clock, full at the lock.
   */
  mood?: (v: number) => void;
}

export interface PickScreen {
  /** The god (and Duel rival) once the pick is over: the clock ran out or everyone is ready. */
  chosen: Promise<{ god: string; rival: string }>;
  /** Loading, after the pick: how far along and what is happening. */
  progress(f: number, text?: string): void;
  /** Where loading notes go (the slow-shaders card). */
  readonly notes: HTMLElement;
  /** Resolves once the versus screen has been up long enough to read (VERSUS_HOLD). */
  shown(): Promise<void>;
  /** The match is ready: the screen fades away. */
  finish(): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

const portrait = (id: string) => `${BASE}portraits/${id}.jpg`;
/** A god's spell color as CSS: the light behind them on the pick screen. */
const godColor = (id: string) => `#${paletteFor(id).vfx.toString(16).padStart(6, '0')}`;
const splash = (id: string) => `${BASE}splash/${id}.jpg`;
/**
 * The gods with a full-length hero render (public/hero, made in Blender by
 * tools/hero): transparent, so they stand straight on the pick screen's light.
 * A god without one yet shows their splash instead.
 */
export const HEROES: ReadonlySet<string> = new Set(['zeus', 'thor', 'odin', 'loki', 'anubis', 'thanatos', 'kukulkan', 'cthulhu', 'jotunn']);
const hero = (id: string) => `${BASE}hero/${id}.webp`;
/** A god's full-length art: the hero render where there is one, else the splash. */
const fullArt = (id: string) => (HEROES.has(id) ? hero(id) : splash(id));
/** Two-digit hex alpha for a #rrggbb color. */
const alpha = (hex: string, a: number) => `${hex}${Math.round(a * 255).toString(16).padStart(2, '0')}`;

/** The silhouette shown for a god not chosen yet, or one the other team keeps hidden. */
const MYSTERY = `<svg viewBox="0 0 64 80" aria-hidden="true"><path d="M32 8c-9 0-15 7-15 16 0 6 3 11 7 14-9 3-16 10-18 20l-1 14h54l-1-14c-2-10-9-17-18-20 4-3 7-8 7-14 0-9-6-16-15-16z" fill="currentColor"/><text x="32" y="33" text-anchor="middle" font-size="20" font-family="Cinzel, Georgia, serif" fill="#0d0b08">?</text></svg>`;

/**
 * The god pick, between the home page and the match: everyone has twenty
 * seconds to choose a god and press Ready, and the pick ends early once
 * everyone is. Bots choose too (their gods come from the match's seed, so
 * the lineup shown is the one played), and the other team's picks stay
 * hidden until the end. Then the screen turns into the loading screen,
 * both teams face to face while the match finishes loading behind it.
 * Online, the host's clock and everyone's picks and Ready come over the
 * lobby's connections (NetSession.select / lockIn).
 */
export function showGodPick(setup: PickSetup): PickScreen {
  const { gods, net, mode } = setup;
  const info = modeInfo(mode);
  const godDef = (id: string) => gods.find((g) => g.id === id) ?? gods[0]!;
  let god = gods.some((g) => g.id === setup.god) ? setup.god : gods[0]!.id;
  let rival = setup.rival && gods.some((g) => g.id === setup.rival) ? setup.rival : '';
  let ready = false;
  let locked = false;
  /** Alone, the Jötunn played as the giant: no god to choose. */
  const asGiant = !net && mode === 'jotunn' && setup.role === 'giant';
  const builds = mode !== 'rush' && mode !== 'descent' && !asGiant;
  const opened = performance.now();
  // (`?picktime=` stretches the clock alone, for automated screenshots on slow machines)
  const seconds = Number(new URLSearchParams(location.search).get('picktime')) || PICK_SECONDS;
  const soloEnds = opened + seconds * 1000;
  const me = net?.me ?? 'me';
  if (net) {
    const self = net.self();
    if (self && gods.some((g) => g.id === self.god)) god = self.god;
    if (self?.god !== god) net.pick(god);
  }

  const root = document.createElement('div');
  root.className = 'gp';
  root.innerHTML = `
    <div class="gp-bg fx-far" style="background-image:url(${modeBlur(mode)}), url(${modeArt(mode)})"></div>
    <div class="gp-shade"></div>
    <div class="gp-embers embers fx-mid">${embersHtml(22)}</div>
    <header class="gp-head">
      <div class="gp-mode"><b>${info.name}</b><span>${info.tag}</span></div>
      <div class="gp-call">Choose your god</div>
      <div class="gp-clock">
        <svg viewBox="0 0 100 100"><circle class="gp-ring-bg" cx="50" cy="50" r="44"/><circle class="gp-ring" cx="50" cy="50" r="44"/></svg>
        <b class="gp-secs">${seconds}</b>
      </div>
    </header>
    <div class="gp-main">
      <aside class="gp-team gp-allies"><div class="gp-tlabel">Your team</div><div class="gp-slots"></div></aside>
      <section class="gp-hero">
        <div class="gp-art fx-near"><div class="gp-aura"><i></i></div><img alt=""><img alt=""></div>
        <div class="gp-info"></div>
      </section>
      <aside class="gp-team gp-foes"><div class="gp-tlabel"></div><div class="gp-slots"></div><div class="gp-rival"></div></aside>
    </div>
    <footer class="gp-foot">
      <div class="gp-strip" style="--n:${gods.length}">${gods
        .map((g, i) => `<button class="gp-god" data-god="${g.id}" style="--i:${i}"><img src="${portrait(g.id)}" alt="" onerror="this.remove()"><span>${g.name}</span></button>`)
        .join('')}</div>
      <div class="gp-go">
        <button class="gp-ready" data-sound="none"><span>Ready</span><small>Enter</small></button>
        <div class="gp-wait"></div>
      </div>
    </footer>
    <div class="gp-load">
      <div class="gp-versus"></div>
      <div class="gp-loadfoot">
        <div class="gp-tip"><b>Tip</b> ${esc(info.tip)}</div>
        <div class="gp-bar"><div></div></div>
        <div class="gp-sub">Entering the battle&hellip;</div>
        <div class="gp-notes"></div>
      </div>
    </div>
    <div class="gp-edge"></div>
    <div class="gp-flash"></div>`;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add('in'));
  const stopParallax = parallax(root);

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const secs = $<HTMLElement>('.gp-secs');
  const ring = $<SVGCircleElement & HTMLElement>('.gp-ring');
  const call = $<HTMLDivElement>('.gp-call');
  const allySlots = $<HTMLDivElement>('.gp-allies .gp-slots');
  const foeSlots = $<HTMLDivElement>('.gp-foes .gp-slots');
  const foeLabel = $<HTMLDivElement>('.gp-foes .gp-tlabel');
  const rivalRow = $<HTMLDivElement>('.gp-rival');
  const artBox = $<HTMLDivElement>('.gp-art');
  /** Two layers, so one god's art crossfades into the next's. */
  const arts = [...root.querySelectorAll<HTMLImageElement>('.gp-art img')];
  let artFront = 0;
  let artGod = '';
  const infoBox = $<HTMLDivElement>('.gp-info');
  const readyBtn = $<HTMLButtonElement>('.gp-ready');
  const wait = $<HTMLDivElement>('.gp-wait');
  const bar = $<HTMLDivElement>('.gp-bar > div');
  const sub = $<HTMLDivElement>('.gp-sub');

  // -- the clock: a CSS ring (no per-frame work), the seconds ticked by a timer
  const left = () => (net ? net.pickLeft : Math.max(0, (soloEnds - performance.now()) / 1000));
  const syncRing = () => {
    const total = net ? PICK_SECONDS : seconds;
    ring.style.animationDuration = `${total}s`;
    ring.style.animationDelay = `${-(total - left())}s`;
  };
  syncRing();

  // -- bots choose at their own pace (cosmetic: their gods are already set)
  const botAt = new Map<string, number>();
  const botTime = (key: string) => {
    let t = botAt.get(key);
    if (t === undefined) {
      // a stable little stagger per slot
      let h = setup.seed;
      for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      t = BOT_LOCK.first + ((h % 1000) / 1000) * BOT_LOCK.spread;
      botAt.set(key, t);
    }
    return t;
  };
  let cascadeFrom = -1;
  const elapsed = () => (performance.now() - opened) / 1000;
  const botReady = (key: string, i: number) => locked || elapsed() >= botTime(key) || (cascadeFrom >= 0 && elapsed() >= cascadeFrom + i * BOT_LOCK.cascade);

  const players = (): NetPlayer[] => (net ? net.players : [{ id: 'me', name: 'You', god, team: 'order', ready }]);
  const lineup = (): Lineup =>
    lineupFor({
      mode,
      // (online in lobby order: every end builds the match's roster from it)
      players: players(),
      net: net ? { mode: net.mode, bots: net.bots } : undefined,
      seed: setup.seed,
      rival,
      allies: setup.allies,
      rivals: setup.rivals,
      role: setup.role,
    });
  const myTeam = () => (net?.self()?.team ?? 'order') as 'order' | 'chaos';

  interface SlotView {
    god: string | null;
    name: string;
    sub: string;
    me: boolean;
    ready: boolean;
    tag?: string;
  }
  const playerOf = (s: LineupSlot) => (s.player ? players().find((p) => p.id === s.player) : undefined);
  const viewOf = (s: LineupSlot, i: number, side: 'ally' | 'foe', key: string): SlotView => {
    const p = playerOf(s);
    const mine = s.player === me;
    const human = !!s.player;
    // a Duel rival the player named is there from the start
    const named = side === 'foe' && mode === 'duel' && !!rival;
    const isReady = mine ? ready || locked : human ? !!p?.ready || locked : named || botReady(key, i);
    // the other team's gods stay hidden until both teams are revealed; so does a bot that hasn't chosen yet
    const hidden = (side === 'foe' && !locked && !(mode === 'duel' && rival)) || (!human && !isReady);
    const g = godDef(s.god);
    const who = mine ? 'You' : human ? esc(p?.name ?? 'Player') : 'Bot';
    return {
      god: hidden ? null : s.god,
      name: hidden ? (isReady ? 'Locked in' : 'Choosing…') : g.name,
      sub: who,
      me: mine,
      ready: isReady,
      tag: s.giant ? 'Giant first' : undefined,
    };
  };
  const slotHtml = (v: SlotView, i: number) => `
    <div class="gp-slot${v.me ? ' me' : ''}${v.ready ? ' ready' : ''}${v.god ? '' : ' hidden'}" style="--i:${i}">
      <div class="gp-face" ${v.god ? `style="background-image:url(${portrait(v.god)})"` : ''}>${v.god ? '' : MYSTERY}</div>
      <div class="gp-who"><b>${v.name}</b><span>${v.sub}${v.tag ? ` · <em>${v.tag}</em>` : ''}</span></div>
      <div class="gp-state">${v.ready ? 'Ready' : 'Picking'}</div>
    </div>`;

  let lastTeams = '';
  const renderTeams = () => {
    const l = lineup();
    const mine = myTeam();
    const allies = mine === 'order' ? l.order : l.chaos;
    const foes = mine === 'order' ? l.chaos : l.order;
    let allyViews: SlotView[];
    let foeViews: SlotView[] = foes.map((s, i) => viewOf(s, i, 'foe', `f${i}`));
    let foeCard = '';
    if (mode === 'jotunn') {
      // the giant of the first round faces the other four
      const giant = allies.find((s) => s.giant);
      allyViews = allies.filter((s) => !s.giant).map((s, i) => viewOf(s, i, 'ally', `a${i}`));
      const who = giant?.player === me ? 'You are the giant' : giant?.player ? `${esc(playerOf(giant)?.name ?? 'A friend')} is the giant first` : 'A bot is the giant first';
      foeCard = foeCardHtml('jotunn', 'The Jötunn', who + (setup.role === 'rotate' && !net ? '; then you are' : ''));
    } else {
      allyViews = allies.map((s, i) => viewOf(s, i, 'ally', `a${i}`));
      if (!foes.length && info.foe) foeCard = foeCardHtml(mode, info.foe.name, info.foe.text);
    }
    if (mode === 'arena') foeViews = [];
    foeLabel.textContent = foeViews.length ? (net?.mode === 'versus' ? 'Enemy team' : mode === 'duel' ? 'Your rival' : 'Enemy team') : 'You face';
    const html = allyViews.map(slotHtml).join('') + '|' + foeCard + foeViews.map(slotHtml).join('');
    if (html === lastTeams) return;
    // a slot that just locked in flashes
    const wasReady = new Set([...root.querySelectorAll('.gp-team .gp-slot.ready')].map((el) => el.parentElement!.className + [...el.parentElement!.children].indexOf(el)));
    lastTeams = html;
    allySlots.innerHTML = allyViews.map(slotHtml).join('');
    foeSlots.innerHTML = foeCard + foeViews.map(slotHtml).join('');
    let newly = 0;
    root.querySelectorAll('.gp-team .gp-slot.ready').forEach((el) => {
      if (!wasReady.has(el.parentElement!.className + [...el.parentElement!.children].indexOf(el))) {
        el.classList.add('flash');
        newly++;
      }
    });
    if (newly && !locked) setup.sound?.('ui.point', 0.35);
  };
  const foeCardHtml = (id: string, name: string, text: string) =>
    `<div class="gp-foecard${id === 'jotunn' && HEROES.has('jotunn') ? ' hero' : ''}" style="background-image:${id === 'jotunn' ? `url(${fullArt('jotunn')}), ` : ''}url(${modeArt(id)})"><b>${esc(name)}</b><span>${text}</span></div>`;

  // -- Temple Duel alone: choose the rival (or let it be a surprise)
  const renderRival = () => {
    if (mode !== 'duel' || net) return;
    if (rival === god) rival = '';
    rivalRow.innerHTML = `<span>Rival</span><button class="gp-chip${rival ? '' : ' on'}" data-rival="">Random</button>${gods
      .filter((g) => g.id !== god)
      .map((g) => `<button class="gp-chip${rival === g.id ? ' on' : ''}" data-rival="${g.id}">${g.name}</button>`)
      .join('')}`;
    rivalRow.querySelectorAll<HTMLButtonElement>('[data-rival]').forEach((b) =>
      b.addEventListener('click', () => {
        if (locked) return;
        rival = b.dataset.rival ?? '';
        renderRival();
        renderTeams();
      }),
    );
  };

  // -- the chosen god: art, name, passive, skills and build
  let hovered: SkillDef | null = null;
  /**
   * Once the first god stands, the other hero renders load in the background,
   * nearest in the strip first, so a swap (and the versus screen) never waits.
   */
  const warm: HTMLImageElement[] = [];
  const warmHeroes = (from: string) => {
    if (warm.length) return;
    const order = gods.map((g) => g.id);
    const at = Math.max(0, order.indexOf(from));
    const ids = [...HEROES].filter((id) => id !== from).sort((a, b) => dist(a) - dist(b));
    function dist(id: string) {
      const i = order.indexOf(id);
      return i < 0 ? order.length : Math.abs(i - at);
    }
    const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 300));
    idle(() =>
      ids.forEach((id) => {
        const img = new Image();
        img.decoding = 'async';
        img.src = hero(id);
        warm.push(img);
      }),
    );
  };
  const renderHero = () => {
    const def = asGiant ? jotunn : godDef(god);
    root.querySelectorAll<HTMLButtonElement>('.gp-god').forEach((b) => b.classList.toggle('on', b.dataset.god === god));
    // the light behind the god (and the screen's glow) takes their color
    root.style.setProperty('--god', godColor(def.id));
    if (artGod !== def.id) {
      artGod = def.id;
      // the new god loads into the back layer, then steps in as the last one steps out
      const next = arts[1 - artFront]!;
      const id = def.id;
      // the hero render, else the splash, else the face card framed the same way
      const tries = HEROES.has(id) ? [hero(id), splash(id)] : [splash(id)];
      let k = 0;
      next.classList.remove('show', 'out', 'bust', 'hero');
      next.classList.toggle('hero', tries[0] === hero(id));
      next.onerror = () => {
        if (artGod !== id) return;
        if (++k < tries.length) {
          next.classList.remove('hero');
          next.src = tries[k]!;
          return;
        }
        next.onerror = null;
        next.classList.add('bust');
        next.src = portrait(id);
      };
      next.onload = () => {
        if (artGod !== id) return;
        const prev = arts[artFront]!;
        if (prev !== next && prev.classList.contains('show')) prev.classList.replace('show', 'out');
        next.classList.add('show');
        artFront = arts.indexOf(next);
        warmHeroes(id);
      };
      next.src = tries[0]!;
    }
    const choice = builds ? buildChoice(def) : { list: [], active: null };
    const active = choice.list.find((b) => b.id === choice.active);
    const bar = asGiant ? def.defaultLoadout : active ? active.loadout : startingBar(def);
    const skills = bar.map((id) => def.skills.find((s) => s.id === id)).filter((s): s is SkillDef => !!s);
    const focus = hovered && skills.includes(hovered) ? hovered : null;
    infoBox.innerHTML = `
      <div class="gp-kick">${esc(def.pantheon)} &middot; ${ROLE_NAMES[def.role] ?? def.role} &middot; ${RANGE_NAMES[def.attackRange] ?? def.attackRange}</div>
      <h2 class="gp-name" data-name="${esc(def.name)}">${esc(def.name)}</h2>
      <div class="gp-title">${esc(def.title)}</div>
      <div class="gp-skills">${skills
        .map(
          (s, i) => `<div class="gp-skill${s.kind === 'ultimate' ? ' ult' : ''}${focus === s ? ' on' : ''}" data-skill="${s.id}"><div class="gp-ico">${skillIcon(def.id, s)}</div><div class="gp-key">${SLOT_KEYS[i]}</div><div class="gp-sn">${esc(s.name)}</div></div>`,
        )
        .join('')}</div>
      <div class="gp-desc">${focus ? `<b>${esc(focus.name)}</b> ${esc(focus.description)}` : `<b>${esc(def.passive.name)}</b> <i>passive</i> ${esc(def.passive.description)}`}</div>
      ${
        builds
          ? `<div class="gp-builds"><span>Build</span><button class="gp-chip${choice.active ? '' : ' on'}" data-build="">By hand</button>${choice.list
              .map((b) => `<button class="gp-chip${b.id === choice.active ? ' on' : ''}" data-build="${b.id}" title="${b.id.startsWith('tree:') ? 'Skills for this tree, its points spent for you' : 'Your saved build'}">${esc(b.name)}</button>`)
              .join('')}</div>`
          : asGiant
            ? '<div class="gp-note">You play the giant this match.</div>'
            : ''
      }`;
    infoBox.querySelectorAll<HTMLDivElement>('.gp-skill').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        hovered = def.skills.find((s) => s.id === el.dataset.skill) ?? null;
        renderHero();
      });
      el.addEventListener('mouseleave', () => {
        hovered = null;
        renderHero();
      });
    });
    infoBox.querySelectorAll<HTMLButtonElement>('[data-build]').forEach((b) =>
      b.addEventListener('click', () => {
        chooseBuild(def, b.dataset.build || null);
        renderHero();
      }),
    );
  };

  /** The last god whose voice was heard, so Ready speaks for one chosen without a click. */
  let said = '';
  const say = (id: string) => {
    said = id;
    setup.say?.(id);
  };
  const indexOf = (id: string) => gods.findIndex((g) => g.id === id);
  const pick = (id: string) => {
    if (ready || locked || asGiant || id === god || !gods.some((g) => g.id === id)) return;
    // the new god steps in from the side the strip moved toward
    artBox.style.setProperty('--from', `${indexOf(id) > indexOf(god) ? 22 : -22}px`);
    god = id;
    hovered = null;
    net?.pick(god);
    renderHero();
    renderRival();
    renderTeams();
    // the hero card's entrance replays for a new god
    const hero = $<HTMLElement>('.gp-hero');
    hero.classList.remove('swap');
    void hero.offsetWidth;
    hero.classList.add('swap');
    say(god);
  };
  root.querySelectorAll<HTMLButtonElement>('.gp-god').forEach((b) => b.addEventListener('click', () => pick(b.dataset.god!)));
  if (asGiant) root.classList.add('giant');

  // -- Ready, the clock, and the end of the pick
  let resolve!: (r: { god: string; rival: string }) => void;
  const chosen = new Promise<{ god: string; rival: string }>((r) => (resolve = r));
  const renderGo = () => {
    readyBtn.classList.toggle('done', ready);
    readyBtn.querySelector('span')!.textContent = ready ? 'Ready' : 'Ready';
    readyBtn.querySelector('small')!.textContent = ready ? 'Locked in' : 'Enter';
    let note = '';
    if (net && ready && !locked) {
      const waiting = net.players.filter((p) => !p.ready).length;
      note = waiting ? `Waiting for ${waiting} ${waiting === 1 ? 'player' : 'players'}…` : 'Everyone is ready';
    }
    wait.textContent = note;
  };
  const pressReady = () => {
    if (ready || locked) return;
    ready = true;
    root.classList.add('is-ready');
    setup.sound?.('ui.lock', 0.9);
    if (said !== god && !asGiant) say(god);
    if (net) net.lockIn(god);
    else {
      // the bots still choosing lock in one after another, then the match is on
      cascadeFrom = elapsed();
      const bots = lineup().order.length + lineup().chaos.length;
      setTimeout(() => lock('ready'), Math.min(1200, 350 + bots * BOT_LOCK.cascade * 1000));
    }
    renderGo();
    renderTeams();
  };
  readyBtn.addEventListener('click', pressReady);

  const onKey = (e: KeyboardEvent) => {
    if (locked) return;
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      pressReady();
    } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft' || /^Digit[1-9]$/.test(e.code)) {
      const i = gods.findIndex((g) => g.id === god);
      const n = /^Digit/.test(e.code) ? Number(e.code.slice(5)) - 1 : (i + (e.code === 'ArrowRight' ? 1 : gods.length - 1)) % gods.length;
      // (through the card, so the keys sound like a click)
      if (gods[n] && !ready && !asGiant) root.querySelector<HTMLButtonElement>(`.gp-god[data-god="${gods[n]!.id}"]`)?.click();
    }
  };
  window.addEventListener('keydown', onKey, true);

  let lastSec = -1;
  const tick = setInterval(() => {
    if (locked) return;
    const t = left();
    const s = Math.ceil(t);
    if (s !== lastSec) {
      lastSec = s;
      secs.textContent = String(s);
      root.classList.toggle('hurry', s <= 5);
      if (s <= 5 && s > 0 && !ready) setup.sound?.('ui.tick', s <= 3 ? 0.9 : 0.6);
    }
    renderTeams();
    // the music builds over the second half of the clock (and stands ready with you)
    const total = net ? PICK_SECONDS : seconds;
    setup.mood?.(Math.max(ready ? 0.55 : 0, Math.min(1, (1 - t / total - 0.4) / 0.5)));
    if (!net && t <= 0) lock('time');
    // online the host ends the pick for everyone; a guest whose clock ran out waits for its word
    if (net && t <= 0 && !ready) {
      ready = true;
      renderGo();
      wait.textContent = 'Starting…';
    }
  }, 100);

  if (net) {
    net.onLobby = () => {
      syncRing();
      renderTeams();
      renderGo();
    };
    net.onStart = () => {
      const self = net.self();
      if (self) god = self.god;
      lock(net.players.every((p) => p.ready) ? 'ready' : 'time');
    };
    net.onLeave = (id) => {
      if (id !== 'host' || net.started) return;
      locked = true;
      clearInterval(tick);
      root.classList.add('lost');
      wait.innerHTML = '';
      call.textContent = 'The host left';
      const back = document.createElement('button');
      back.className = 'gp-back';
      back.textContent = 'Back to the title screen';
      back.addEventListener('click', () => location.assign(location.pathname));
      $<HTMLDivElement>('.gp-go').replaceChildren(back);
    };
  }

  let swell: ReturnType<typeof setInterval> | undefined;
  let versusDone!: () => void;
  const versusShown = new Promise<void>((r) => (versusDone = r));
  /** The pick is over: everyone's god is final; both teams are revealed and the loading begins. */
  function lock(why: 'ready' | 'time'): void {
    if (locked) return;
    locked = true;
    ready = true;
    clearInterval(tick);
    window.removeEventListener('keydown', onKey, true);
    // the music swells to the lock; the god chosen for you speaks too
    swell = setInterval(() => setup.mood?.(1), 100);
    setTimeout(() => clearInterval(swell), 1800);
    if (said !== god && !asGiant) say(god);
    secs.textContent = '0';
    call.textContent = why === 'ready' ? 'All gods ready' : 'Locked in';
    root.classList.add('locked');
    renderTeams();
    renderGo();
    // the versus screen: both teams face to face (hidden picks revealed)
    setTimeout(() => {
      buildVersus();
      root.classList.add('loading');
      setup.sound?.('ui.versus', 0.85);
      setTimeout(versusDone, VERSUS_HOLD * 1000);
    }, 650);
    resolve({ god, rival });
  }

  const buildVersus = () => {
    const l = lineup();
    const mine = myTeam();
    let allies = mine === 'order' ? l.order : l.chaos;
    let foes = mine === 'order' ? l.chaos : l.order;
    let giant: LineupSlot | undefined;
    if (mode === 'jotunn') {
      giant = allies.find((s) => s.giant);
      allies = allies.filter((s) => !s.giant);
      foes = [];
    }
    if (mode === 'arena') foes = [];
    const card = (s: LineupSlot, i: number) => {
      const p = playerOf(s);
      const who = s.player === me ? 'You' : s.player ? esc(p?.name ?? 'Player') : 'Bot';
      const g = godDef(s.god);
      // a hero render stands in the god's own light; a splash already has its scene
      const art = HEROES.has(g.id)
        ? `class="gp-vimg hero" style="background-image:url(${hero(g.id)}), radial-gradient(ellipse 72% 56% at 50% 34%, ${alpha(godColor(g.id), 0.42)}, transparent 76%)"`
        : `class="gp-vimg" style="background-image:url(${splash(g.id)}), url(${portrait(g.id)})"`;
      return `<div class="gp-vcard${s.player === me ? ' me' : ''}" style="--i:${i}"><div ${art}></div><div class="gp-vname"><b>${g.name}</b><span>${who}</span></div></div>`;
    };
    const foeSide = foes.length
      ? foes.map(card).join('')
      : giant
        ? `<div class="gp-vcard gp-vgiant"><div class="gp-vimg${HEROES.has('jotunn') ? ' hero' : ''}" style="background-image:url(${fullArt('jotunn')}), url(${modeArt('jotunn')})"></div><div class="gp-vname"><b>The Jötunn</b><span>${giant.player === me ? 'You' : giant.player ? esc(playerOf(giant)?.name ?? 'Player') : 'Bot'}</span></div></div>`
        : info.foe
          ? `<div class="gp-vcard gp-vfoe"><div class="gp-vimg" style="background-image:url(${modeArt(mode)})"></div><div class="gp-vname"><b>${esc(info.foe.name)}</b><span>${esc(info.foe.text)}</span></div></div>`
          : '';
    const versus = $<HTMLDivElement>('.gp-versus');
    versus.style.setProperty('--n', String(Math.max(1, allies.length, foes.length)));
    versus.innerHTML = `
      <div class="gp-vside gp-vallies">${allies.map(card).join('')}</div>
      <div class="gp-vs"><span>VS</span><b>${info.name}</b></div>
      <div class="gp-vside gp-vfoes">${foeSide}</div>`;
  };

  renderHero();
  // (the hero card's entrance plays for the first god too)
  $<HTMLElement>('.gp-hero').classList.add('swap');
  renderRival();
  renderTeams();
  renderGo();
  if (asGiant) say('jotunn');

  return {
    chosen,
    progress(f: number, text?: string) {
      bar.style.width = `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;
      if (text) sub.textContent = text;
    },
    notes: $<HTMLDivElement>('.gp-notes'),
    shown: () => versusShown,
    finish() {
      clearInterval(tick);
      clearInterval(swell);
      stopParallax();
      window.removeEventListener('keydown', onKey, true);
      root.classList.add('done');
      setTimeout(() => root.remove(), 900);
    },
  };
}
