import type { Side } from '../game/combatant';
import { RUSH, type Rush } from '../sim/Rush';
import type { Point, Unit } from '../sim/Unit';
import type { RushCall, RushCatch } from '../combat/RushMode';
import { addResult } from './records';
import { awardLine } from './ascension';
import { RushRadar } from './RushRadar';
import { rushAwards, type RushAwardKey } from './rushAwards';
import './clash.css';
import './rush.css';

/** What a throw would do (see Rush.passRead). */
type PassRead = ReturnType<Rush['passRead']>;

/** A raised open hand: the call for the pass. */
const HAND = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 58 V30 Q18 26 22 26 Q26 26 26 30 V14 Q26 10 30 10 Q34 10 34 14 V28 V12 Q34 8 38 8 Q42 8 42 12 V30 V18 Q42 14 46 14 Q50 14 50 18 V40 Q50 52 40 58 Z"/></svg>';

/** The end screen's award medals: a star, a pass's arc, a shield. */
const AWARD_ICON: Record<RushAwardKey, string> = {
  mvp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6z"/></svg>',
  playmaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 18.5C6 11 12 7.5 18 8.6" fill="none" stroke-width="2.6" stroke-linecap="round"/><path d="M15.6 4.6l6 4.4-6.6 3.3z"/><circle cx="4.5" cy="19" r="2.2"/></svg>',
  wall: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 9.1-8 11-4.6-1.9-8-6-8-11V5z"/></svg>',
};

/** Seconds the post-goal dip takes to close, and to open again on the kickoff. */
const RUSH_CUT = { in: 0.3, out: 0.55 };
/** Seconds the match card takes to fade once play starts. */
const RUSH_INTRO_FADE = 0.7;
/**
 * Pops played through the Web Animations API: restarting a CSS animation
 * means reading layout between dropping and re-adding its class, and that
 * forced layout cost milliseconds a frame while the catch marker hopped
 * between gods.
 */
const CATCH_POP: Keyframe[] = [{ transform: 'scale(0.2)' }, { transform: 'none' }];
const COUNT_POP: Keyframe[] = [{ transform: 'scale(1.7)', opacity: 0.2 }, { transform: 'none', opacity: 1 }];

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

/**
 * Relic Rush readout: goals as pips around the clock, where the relic is and
 * what to do about it, the kickoff countdown, goal banners, and the result
 * with every god's sport tallies.
 */
export class RushHud {
  private readonly root = document.createElement('div');
  private readonly pips: Record<Side, HTMLElement>;
  private readonly clock: HTMLElement;
  private readonly state: HTMLElement;
  private readonly big: HTMLElement;
  private readonly end: HTMLElement;
  private readonly mine: Side;
  private readonly foe: Side;
  private lastPips = '';
  private lastClock = '';
  private lastState = '';
  private lastBig = '';
  private shownEnd = false;
  private goalSeen = 0;
  /** Seconds left on the current goal banner, and on the "Rush!" call after a kickoff. */
  private goalShow = 0;
  private rushShow = 0;
  private wasKickoff = true;
  private readonly arrow: HTMLElement;
  private arrowTone = '';
  /** The dip to dark that hides the kickoff reset after a goal, and how far it has faded back out. */
  private readonly cut: HTMLElement;
  private cutOut = 0;
  private lastCut = '';
  private wasGoal = false;
  /** The whole pitch at a glance, top right. */
  private readonly radar: RushRadar;
  private time = 0;
  /** The match card over the first kickoff (who plays whom, and how to win), and how much of it is left as it fades. */
  private readonly intro: HTMLElement;
  private introLeft = 0;
  private lastIntro = '';
  private readonly introCount: HTMLElement;
  private lastCount = '';
  /** Call-for-the-pass bubbles over teammates' heads, reused. */
  private readonly bubbles: { el: HTMLElement; name: HTMLElement; on: boolean; label: string }[] = [];

  constructor(
    private readonly rush: Rush,
    private readonly me: Unit,
    private readonly gods: readonly Unit[],
    online: boolean,
  ) {
    this.mine = me.team as Side;
    this.foe = this.mine === 'order' ? 'chaos' : 'order';
    this.root.className = 'clash duel rush';
    this.root.innerHTML = `
      <div class="rush-cut"></div>
      <div class="clash-bar">
        <div class="clash-side ally"><span class="duel-name">Your team</span><div class="duel-pips"></div></div>
        <div class="rush-clock"></div>
        <div class="clash-side foe"><div class="duel-pips"></div><span class="duel-name">Enemies</span></div>
      </div>
      <div class="clash-state"></div>
      <div class="duel-big"></div>
      <div class="rush-intro"><b>Relic Rush</b><small>First to ${RUSH.goals} goals: carry or throw the Sun Relic through their gate</small><div class="rush-intro-teams"><div class="ally">${this.lineUp(this.mine)}</div><i class="rush-intro-count"></i><div class="foe">${this.lineUp(this.foe)}</div></div></div>
      <div class="rush-pointer"><i></i></div>
      <div class="rush-calls"></div>
      <div class="rush-catch"><span><b></b><i><svg viewBox="0 0 24 24"><path d="M3 6h18l-9 13z"/></svg></i></span></div>
      <div class="clash-end"><div class="clash-end-title"></div><div class="clash-end-score"></div><div class="clash-end-table"></div><button class="clash-again">${online ? 'Back to the title screen' : 'Play again'}</button></div>`;
    document.body.appendChild(this.root);
    this.pips = {
      [this.mine]: this.root.querySelector('.ally .duel-pips')!,
      [this.foe]: this.root.querySelector('.foe .duel-pips')!,
    } as Record<Side, HTMLElement>;
    this.clock = this.root.querySelector('.rush-clock')!;
    this.state = this.root.querySelector('.clash-state')!;
    this.big = this.root.querySelector('.duel-big')!;
    this.end = this.root.querySelector('.clash-end')!;
    this.arrow = this.root.querySelector('.rush-pointer')!;
    this.catchEl = this.root.querySelector('.rush-catch')!;
    this.catchLabel = this.catchEl.querySelector('b')!;
    this.catchPop = this.catchEl.querySelector('span')!;
    this.cut = this.root.querySelector('.rush-cut')!;
    this.intro = this.root.querySelector('.rush-intro')!;
    this.introCount = this.root.querySelector('.rush-intro-count')!;
    // only a match that's just starting gets the card (not a guest joining mid-game)
    if (rush.phase === 'kickoff' && rush.goalCount === 0 && !rush.overtime) {
      this.introLeft = 1;
      this.intro.classList.add('show');
    }
    this.radar = new RushRadar(rush, me, gods);
    this.root.querySelector('.clash-bar')!.after(this.radar.el);
    const calls = this.root.querySelector('.rush-calls')!;
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('div');
      el.className = 'rush-call';
      el.innerHTML = `<i>${HAND}</i><b>Pass!</b><span></span>`;
      calls.appendChild(el);
      this.bubbles.push({ el, name: el.querySelector('span')!, on: false, label: '' });
    }
    // the death screen reads as a daze in this mode (see rush.css)
    document.body.classList.add('rush-mode');
    this.root.querySelector('.clash-again')!.addEventListener('click', () => (online ? location.assign(location.pathname) : location.reload()));
  }

  /** Teammates calling for the pass: a bubble over each one's head, fading out. */
  calls(list: readonly RushCall[]): void {
    this.bubbles.forEach((b, i) => {
      const c = list[i];
      if (!c) {
        if (b.on) b.el.classList.remove('show', 'pop');
        b.on = false;
        return;
      }
      if (!b.on) {
        b.el.classList.add('show', 'pop');
        b.on = true;
      }
      if (c.name !== b.label) {
        b.label = c.name;
        b.name.textContent = c.name;
        b.el.classList.toggle('mine', c.mine);
      }
      b.el.style.transform = `translate(${c.x.toFixed(0)}px, ${c.y.toFixed(0)}px)`;
      b.el.style.opacity = (1 - c.age ** 3).toFixed(2);
    });
  }

  private readonly catchEl: HTMLElement;
  private readonly catchLabel: HTMLElement;
  private readonly catchPop: HTMLElement;
  private catchKey = '';

  /** The marker over whoever would catch the carrier's throw (null hides it). */
  catcher(c: RushCatch | null): void {
    const key = c ? `${c.name}|${c.label}|${c.raised ? 'r' : ''}` : '';
    if (key !== this.catchKey) {
      this.catchKey = key;
      this.catchEl.classList.toggle('show', !!c);
      if (c) {
        this.catchEl.classList.toggle('foe', !c.ally);
        this.catchEl.classList.toggle('raised', c.raised);
        this.catchLabel.textContent = c.label;
        // re-pop when it lands on somebody new or changes its call
        this.catchPop.animate(CATCH_POP, { duration: 350, easing: 'cubic-bezier(0.3, 1.6, 0.5, 1)' });
      }
    }
    if (c) this.catchEl.style.transform = `translate(${c.x.toFixed(0)}px, ${c.y.toFixed(0)}px)`;
  }

  /** The arrow at the screen's edge toward an out-of-sight relic (null hides it). */
  pointer(p: { x: number; y: number; angle: number; tone: string } | null): void {
    this.arrow.classList.toggle('show', !!p);
    if (!p) return;
    this.arrow.style.transform = `translate(${p.x.toFixed(0)}px, ${p.y.toFixed(0)}px) rotate(${p.angle.toFixed(3)}rad)`;
    if (p.tone !== this.arrowTone) {
      this.arrowTone = p.tone;
      this.arrow.dataset.tone = p.tone;
    }
  }

  /** One team's gods for the match card, this player first. */
  private lineUp(side: Side): string {
    return this.gods
      .filter((u) => u.team === side)
      .sort((a, b) => Number(b === this.me) - Number(a === this.me))
      .map((u) => (u === this.me ? `<span class="me">${esc(u.name)} <em>(you)</em></span>` : `<span>${esc(u.name)}</span>`))
      .join('');
  }

  /**
   * The match card holds through the first countdown (which it shows between
   * the two teams, in place of the big one), then fades as play starts.
   */
  private introFrame(dt: number): void {
    if (this.introLeft <= 0) return;
    const r = this.rush;
    const kickoff = r.phase === 'kickoff' && r.goalCount === 0;
    if (!kickoff) this.introLeft = Math.max(0, this.introLeft - dt / RUSH_INTRO_FADE);
    const count = kickoff ? String(Math.max(1, Math.ceil(r.timer))) : 'Rush!';
    if (count !== this.lastCount) {
      this.lastCount = count;
      this.introCount.textContent = count;
      this.introCount.classList.toggle('go', !kickoff);
      // each new number pops in
      this.introCount.animate(COUNT_POP, { duration: 450, easing: 'cubic-bezier(0.3, 1.5, 0.5, 1)' });
    }
    const v = this.introLeft.toFixed(2);
    if (v === this.lastIntro) return;
    this.lastIntro = v;
    this.intro.style.opacity = v;
    if (this.introLeft <= 0) this.intro.classList.remove('show');
  }

  private who(u: Unit): string {
    return u === this.me ? 'You' : u.name;
  }

  /** The line under the score: where the relic is and what this player should do about it (`read`: what their throw at `aim` would do). */
  private stateText(read: PassRead | null, aim: Point | null): { text: string; tone: string } {
    const r = this.rush;
    const relic = r.relic;
    const me = this.me;
    if (r.phase === 'over') return { text: '', tone: '' };
    if (r.phase === 'goal') return { text: 'Next kickoff in a moment', tone: '' };
    if (!me.alive) return { text: `Dazed: back on your feet at your gate in ${Math.max(1, Math.ceil(me.combatant.respawnTimer))}`, tone: 'foe' };
    if (r.phase === 'kickoff') return { text: r.overtime ? 'Golden relic: the next goal wins' : 'Kickoff: the Sun Relic waits on the pedestal', tone: r.overtime ? 'contested' : '' };
    const h = relic.holder;
    if (h === me) {
      if (read?.goal) return { text: 'On target! Left click to shoot it through their gate', tone: 'contested' };
      const by = read?.catcher;
      if (by && by.team === me.team) return { text: `Left click to pass to ${by.name}`, tone: 'order' };
      if (by) return { text: r.shotOnTarget(me, aim ?? me.aim) ? `${by.name} would save that shot` : `${by.name} would cut that pass off`, tone: 'chaos' };
      return { text: 'You have the relic! Run it through their gate, or left click to pass where you aim', tone: 'order' };
    }
    if (h && h.team === me.team) return { text: `${h.name} has the relic: get open, and press F to call for the pass`, tone: 'order' };
    if (h) return { text: `${h.name} has the relic: stun or knock them back to make them drop it`, tone: 'chaos' };
    if (relic.phase === 'center') return { text: 'Grab the Sun Relic from the pedestal', tone: 'contested' };
    if (relic.phase === 'flying' && relic.thrower) {
      return relic.thrower.team === me.team ? { text: `${this.who(relic.thrower)} passes!`, tone: 'order' } : { text: 'Enemy pass in the air: cut it off', tone: 'chaos' };
    }
    return { text: 'The relic is loose: grab it!', tone: 'contested' };
  }

  private bigText(): { html: string; side: string } {
    const r = this.rush;
    // the first countdown and its "Rush!" are on the match card
    if (this.introLeft > 0) return { html: '', side: '' };
    if (r.phase === 'kickoff') return { html: String(Math.max(1, Math.ceil(r.timer))), side: '' };
    const g = r.lastGoal;
    if (this.goalShow > 0 && g) {
      const ours = g.team === this.mine;
      const you = g.scorer === this.me;
      const how = g.kind === 'shot' ? `${this.who(g.scorer)} ${you ? 'score' : 'scores'} from range` : `${this.who(g.scorer)} ${you ? 'carry' : 'carries'} it in`;
      const sub = g.assist ? `${how} · assist ${this.who(g.assist)}` : how;
      return { html: `${ours ? 'Goal!' : 'They score'}<small>${esc(sub)}</small>`, side: ours ? 'ally' : 'foe' };
    }
    if (this.rushShow > 0) return { html: r.overtime ? 'Golden relic!' : 'Rush!', side: '' };
    return { html: '', side: '' };
  }

  /** `read` and `aim`: what the local carrier's throw would do, and where it would go (see RushView). */
  frame(dt = 0, read: PassRead | null = null, aim: Point | null = null): void {
    const r = this.rush;
    if (r.goalCount !== this.goalSeen) {
      this.goalSeen = r.goalCount;
      this.goalShow = RUSH.celebrate - 0.4;
    }
    this.goalShow = Math.max(0, this.goalShow - dt);
    // (not after the first kickoff: the match card already called it, and outlasting the card it would flash up again)
    if (this.wasKickoff && r.phase === 'play') this.rushShow = this.introLeft > 0 ? 0 : 0.9;
    this.wasKickoff = r.phase === 'kickoff';
    this.rushShow = Math.max(0, this.rushShow - dt);
    this.dip(dt);
    this.introFrame(dt);
    this.time += dt;
    if (!this.shownEnd) this.radar.frame(dt, this.time);

    const pips = `${r.score.order}:${r.score.chaos}`;
    if (pips !== this.lastPips) {
      const was = this.lastPips ? this.lastPips.split(':').map(Number) : [0, 0];
      this.lastPips = pips;
      (['order', 'chaos'] as const).forEach((side, k) => {
        // a new goal's pip pops in
        const fresh = r.score[side] > was[k]! ? r.score[side] - 1 : -1;
        this.pips[side].innerHTML = Array.from({ length: RUSH.goals }, (_, i) => `<i class="${i < r.score[side] ? 'on' : ''}${i === fresh ? ' new' : ''}"></i>`).join('');
      });
    }
    const time = r.overtime ? 'Golden relic' : clock(Math.ceil(r.clock));
    if (time !== this.lastClock) {
      this.lastClock = time;
      this.clock.textContent = time;
      this.clock.classList.toggle('gold', r.overtime);
      this.clock.classList.toggle('late', !r.overtime && r.clock <= 30);
    }
    const s = this.stateText(read, aim);
    const key = `${s.text}|${s.tone}`;
    if (key !== this.lastState) {
      this.lastState = key;
      this.state.textContent = s.text;
      this.state.dataset.state = s.tone;
      this.state.style.display = s.text ? '' : 'none';
    }
    const b = this.bigText();
    const bk = `${b.html}|${b.side}`;
    if (bk !== this.lastBig) {
      this.lastBig = bk;
      this.big.innerHTML = b.html;
      this.big.classList.toggle('show', b.html !== '');
      this.big.dataset.side = b.side;
    }
    if (r.winner && !this.shownEnd) this.showEnd();
  }

  /**
   * After a goal the screen dips to dark as the celebration ends, so every god
   * (and the camera) jumping back to the kickoff marks happens out of sight,
   * then it opens again on the new kickoff.
   */
  private dip(dt: number): void {
    const r = this.rush;
    const goal = r.phase === 'goal';
    if (this.wasGoal && !goal && r.phase === 'kickoff') this.cutOut = RUSH_CUT.out;
    this.wasGoal = goal;
    this.cutOut = Math.max(0, this.cutOut - dt);
    const a = goal ? Math.max(0, 1 - r.timer / RUSH_CUT.in) : this.cutOut / RUSH_CUT.out;
    const v = (a * a * (3 - 2 * a)).toFixed(2);
    if (v === this.lastCut) return;
    this.lastCut = v;
    this.cut.style.opacity = v;
    this.cut.style.display = v === '0.00' ? 'none' : 'block';
  }

  private showEnd(): void {
    this.shownEnd = true;
    const r = this.rush;
    const won = r.winner === this.mine;
    const { award } = addResult('rush', { won });
    this.end.querySelector('.clash-end-title')!.textContent = won ? 'Victory' : 'Defeat';
    const score = this.end.querySelector('.clash-end-score')!;
    score.textContent = `${r.score[this.mine]} – ${r.score[this.foe]}${r.overtime ? ' · won on the golden relic' : ''}`;
    score.insertAdjacentHTML('afterend', awardLine(award));
    // the match's awards, as medals over the table
    const awards = rushAwards(this.gods, r.lines, r.winner as Side);
    const mvp = awards.find((a) => a.key === 'mvp')?.unit ?? null;
    if (awards.length) {
      const medals = awards
        .map((a) => {
          const cls = a.unit.team === this.mine ? 'ally' : 'foe';
          const name = `${esc(a.unit.name)}${a.unit === this.me ? ' (you)' : ''}`;
          return `<div class="rush-award ${cls}" data-award="${a.key}"><i>${AWARD_ICON[a.key]}</i><b>${a.title}</b><span>${name}</span><small>${esc(a.stat)}</small></div>`;
        })
        .join('');
      this.end.querySelector('.clash-end-table')!.insertAdjacentHTML('beforebegin', `<div class="rush-awards">${medals}</div>`);
    }
    const rows = [...this.gods]
      .sort((a, b) => Number(b.team === this.mine) - Number(a.team === this.mine) || (r.lines.get(b)?.goals ?? 0) - (r.lines.get(a)?.goals ?? 0))
      .map((u) => {
        const l = r.lines.get(u)!;
        const cls = [u === this.me ? 'me' : '', u.team === this.mine ? 'ally' : 'foe'].join(' ');
        const star = u === mvp ? '<span class="rush-mvp" title="MVP">★</span>' : '';
        return `<tr class="${cls}"><td>${star}${esc(u.name)}${u === this.me ? ' (you)' : ''}</td><td>${l.goals}</td><td>${l.assists}</td><td>${l.passes}</td><td>${l.steals}</td><td>${l.tackles}</td><td>${l.dazed}</td></tr>`;
      })
      .join('');
    this.end.querySelector('.clash-end-table')!.innerHTML =
      `<table class="end-table"><tr><th></th><th>Goals</th><th>Assists</th><th>Passes</th><th>Steals</th><th>Tackles</th><th>Dazed</th></tr>${rows}</table>`;
    this.end.classList.add('show', won ? 'won' : 'lost');
    document.exitPointerLock?.();
  }
}
