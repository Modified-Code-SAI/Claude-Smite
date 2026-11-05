import type { Side } from '../game/combatant';
import { RUSH, type Rush } from '../sim/Rush';
import type { Unit } from '../sim/Unit';
import type { RushCall } from '../combat/RushMode';
import { addResult } from './records';
import { awardLine } from './ascension';
import './clash.css';
import './rush.css';

/** A raised open hand: the call for the pass. */
const HAND = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 58 V30 Q18 26 22 26 Q26 26 26 30 V14 Q26 10 30 10 Q34 10 34 14 V28 V12 Q34 8 38 8 Q42 8 42 12 V30 V18 Q42 14 46 14 Q50 14 50 18 V40 Q50 52 40 58 Z"/></svg>';

/** Seconds the post-goal dip takes to close, and to open again on the kickoff. */
const RUSH_CUT = { in: 0.3, out: 0.55 };

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
      <div class="rush-pointer"><i></i></div>
      <div class="rush-calls"></div>
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
    this.cut = this.root.querySelector('.rush-cut')!;
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

  private who(u: Unit): string {
    return u === this.me ? 'You' : u.name;
  }

  /** The line under the score: where the relic is and what this player should do about it. */
  private stateText(): { text: string; tone: string } {
    const r = this.rush;
    const relic = r.relic;
    const me = this.me;
    if (r.phase === 'over') return { text: '', tone: '' };
    if (r.phase === 'goal') return { text: 'Next kickoff in a moment', tone: '' };
    if (!me.alive) return { text: `Dazed: back on your feet at your gate in ${Math.max(1, Math.ceil(me.combatant.respawnTimer))}`, tone: 'foe' };
    if (r.phase === 'kickoff') return { text: r.overtime ? 'Golden relic: the next goal wins' : 'Kickoff: the Sun Relic waits on the pedestal', tone: r.overtime ? 'contested' : '' };
    const h = relic.holder;
    if (h === me) return { text: 'You have the relic! Run it through their gate, or left click to pass where you aim', tone: 'order' };
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

  frame(dt = 0): void {
    const r = this.rush;
    if (r.goalCount !== this.goalSeen) {
      this.goalSeen = r.goalCount;
      this.goalShow = RUSH.celebrate - 0.4;
    }
    this.goalShow = Math.max(0, this.goalShow - dt);
    if (this.wasKickoff && r.phase === 'play') this.rushShow = 0.9;
    this.wasKickoff = r.phase === 'kickoff';
    this.rushShow = Math.max(0, this.rushShow - dt);
    this.dip(dt);

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
    const s = this.stateText();
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
    const rows = [...this.gods]
      .sort((a, b) => Number(b.team === this.mine) - Number(a.team === this.mine) || (r.lines.get(b)?.goals ?? 0) - (r.lines.get(a)?.goals ?? 0))
      .map((u) => {
        const l = r.lines.get(u)!;
        const cls = [u === this.me ? 'me' : '', u.team === this.mine ? 'ally' : 'foe'].join(' ');
        return `<tr class="${cls}"><td>${esc(u.name)}${u === this.me ? ' (you)' : ''}</td><td>${l.goals}</td><td>${l.assists}</td><td>${l.passes}</td><td>${l.steals}</td><td>${l.tackles}</td><td>${l.dazed}</td></tr>`;
      })
      .join('');
    this.end.querySelector('.clash-end-table')!.innerHTML =
      `<table class="end-table"><tr><th></th><th>Goals</th><th>Assists</th><th>Passes</th><th>Steals</th><th>Tackles</th><th>Dazed</th></tr>${rows}</table>`;
    this.end.classList.add('show', won ? 'won' : 'lost');
    document.exitPointerLock?.();
  }
}
