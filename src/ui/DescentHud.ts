import { DESCENT, DEPTHS, KIND_NAMES, KIND_TEXT, type Descent } from '../sim/Descent';
import { scoreTable, type Scoreboard } from '../sim/Scoreboard';
import type { Unit } from '../sim/Unit';
import { CHAMBERS } from '../map/UnderworldLayout';
import { addResult } from './records';
import { awardLine } from './ascension';
import { skillIcon } from './icons';
import './clash.css';
import './descent.css';

const KEYS = 'ZXC';

/**
 * Underworld Descent readout: the depth and chamber, what is left of its
 * monsters, the curses on the team, the chamber's name card as the team
 * arrives, the team's reward vote and each god's skill draft, the black
 * fade between chambers, and the run's final tally.
 */
export class DescentHud {
  private readonly root = document.createElement('div');
  private readonly where: HTMLElement;
  private readonly state: HTMLElement;
  private readonly curses: HTMLElement;
  private readonly card: HTMLElement;
  private readonly cards: HTMLElement;
  private readonly fade: HTMLElement;
  private readonly end: HTMLElement;
  private shownEnd = false;
  private lastText = '';
  private shownCurses = '';
  private shownCard = -1;
  private shownOffer: unknown = null;
  private shownTally = '';
  private shownDraft: unknown = null;

  constructor(
    private readonly run: Descent,
    private readonly me: Unit,
    onPick: (i: number) => void,
    private readonly board?: Scoreboard,
  ) {
    this.root.className = 'clash descent';
    this.root.innerHTML = `
      <div class="clash-bar"><div class="descent-where"></div></div>
      <div class="clash-state"></div>
      <div class="descent-curses"></div>
      <div class="descent-card"><div class="descent-card-depth"></div><div class="descent-card-name"></div><div class="descent-card-kind"></div></div>
      <div class="siege-boons descent-cards"></div>
      <div class="descent-fade"></div>
      <div class="clash-end"><div class="clash-end-title"></div><div class="clash-end-score"></div><div class="clash-end-table"></div><button class="clash-again">Descend again</button></div>`;
    document.body.appendChild(this.root);
    this.where = this.root.querySelector('.descent-where')!;
    this.state = this.root.querySelector('.clash-state')!;
    this.curses = this.root.querySelector('.descent-curses')!;
    this.card = this.root.querySelector('.descent-card')!;
    this.cards = this.root.querySelector('.descent-cards')!;
    this.fade = this.root.querySelector('.descent-fade')!;
    this.end = this.root.querySelector('.clash-end')!;
    this.cards.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.siege-boon');
      if (card) onPick(Number(card.dataset.i));
    });
    this.root.querySelector('.clash-again')!.addEventListener('click', () => location.reload());
  }

  frame(): void {
    const r = this.run;
    if (!r.chamber) return;
    const plan = r.current;
    this.where.innerHTML = `<b>${DEPTHS[r.depth]!.name}</b><span>Chamber ${r.chamber} / ${DESCENT.chambers}</span>${r.obols ? `<em title="Charon's Obol: the next wipe is undone">&#9679; ${r.obols}</em>` : ''}`;
    this.fade.classList.toggle('show', r.phase === 'descend');

    // the chamber's name as the team walks in
    const cardKey = r.phase === 'enter' ? r.chamber : 0;
    if (cardKey !== this.shownCard) {
      this.shownCard = cardKey;
      if (cardKey) {
        this.card.querySelector('.descent-card-depth')!.textContent = plan.kind === 'boss' ? `${DEPTHS[r.depth]!.name} · its master` : DEPTHS[r.depth]!.name;
        this.card.querySelector('.descent-card-name')!.textContent = CHAMBERS[plan.layout]!.name;
        this.card.querySelector('.descent-card-kind')!.innerHTML = `<b>${KIND_NAMES[plan.kind]}</b> ${KIND_TEXT[plan.kind]}`;
      }
      this.card.classList.toggle('show', !!cardKey);
      this.card.dataset.kind = plan.kind;
    }

    const text = this.stateText();
    if (text !== this.lastText) {
      this.lastText = text;
      this.state.innerHTML = text;
      this.state.dataset.state = r.phase === 'exit' ? 'order' : r.downed.size ? 'chaos' : '';
    }

    const curseKey = `${r.curses.length}|${r.nextCurse?.id ?? ''}`;
    if (curseKey !== this.shownCurses) {
      this.shownCurses = curseKey;
      const next = r.nextCurse;
      this.curses.innerHTML =
        r.curses.map((c) => `<span title="${c.text}"><b>${c.name}</b></span>`).join('') +
        (next ? `<span class="next" title="${next.text}">Next chamber: <b>${next.name}</b> ${next.text}</span>` : '');
      this.curses.classList.toggle('show', r.curses.length > 0 || !!next);
    }

    this.rewardCards();

    if (r.over && !this.shownEnd) this.showEnd();
  }

  private stateText(): string {
    const r = this.run;
    const down = r.downed.size;
    const me = this.me;
    const downText = down ? ` · <b class="down">${down} down</b>: stand over a fallen ally to raise them` : '';
    switch (r.phase) {
      case 'enter':
        return 'The dead stir…';
      case 'fight': {
        const left = r.monsters.filter((m) => m !== r.gilded).length;
        let s = r.boss?.alive ? `${r.boss.name}: ${Math.ceil((r.boss.combatant.health / r.boss.combatant.stats.maxHealth) * 100)}%` : `${left} ${left === 1 ? 'monster' : 'monsters'} left`;
        if (r.spoils > 0) s += ` · Champion's spoils ${Math.ceil(r.spoils)}`;
        else if (r.champion?.alive) s += ' · a Champion leads them';
        if (r.gilded) s += ' · catch the Gilded Thornback!';
        if (r.erupting) s += ' · soul fire!';
        return s + downText;
      }
      case 'reward':
        return `Choose your team's reward · ${Math.ceil(r.timer)}`;
      case 'draft':
        return r.drafts.has(me) ? `Learn a skill · ${Math.ceil(r.timer)}` : 'Your allies are choosing their skills…';
      case 'exit':
        return `The way down is open: walk into the north gate · ${Math.ceil(r.timer)}`;
      case 'descend':
        return 'Descending…';
      default:
        return '';
    }
  }

  /** The vote's three cards (with each card's votes), or this god's three skills to draft. */
  private rewardCards(): void {
    const r = this.run;
    const draft = r.phase === 'draft' ? r.drafts.get(this.me) ?? null : null;
    const offer = r.phase === 'reward' ? r.offer : null;
    const tally = offer ? r.tally().join(',') + ':' + (r.votes.get(this.me) ?? -1) : '';
    if (offer === this.shownOffer && draft === this.shownDraft && tally === this.shownTally) return;
    this.shownOffer = offer;
    this.shownDraft = draft;
    this.shownTally = tally;
    if (offer) {
      const t = r.tally();
      const mine = r.votes.get(this.me);
      const team = r.humans.size > 1;
      this.cards.innerHTML =
        `<div class="siege-boons-title">${team ? 'Vote for your team’s reward' : 'Choose your team’s reward'}${r.bonusRewards > 0 ? ' · the Gilded Thornback brings another' : ''}</div>` +
        offer
          .map(
            (c, i) =>
              `<div class="siege-boon descent-reward ${c.kind}${mine === i ? ' voted' : ''}" data-i="${i}"><kbd>${KEYS[i]}</kbd><b>${c.name}</b><span>${c.text}</span>${team && t[i] ? `<em>${t[i]} ${t[i] === 1 ? 'vote' : 'votes'}</em>` : ''}</div>`,
          )
          .join('');
    } else if (draft) {
      const god = this.me.combatant.god.id;
      const slot = draft.slot === 3 ? 'your ultimate' : `skill ${draft.slot + 1}`;
      this.cards.innerHTML =
        `<div class="siege-boons-title">Forgotten Rite: learn ${slot}</div>` +
        draft.options
          .map((s, i) => `<div class="siege-boon descent-skill" data-i="${i}"><kbd>${KEYS[i]}</kbd><i class="descent-icon">${skillIcon(god, s)}</i><b>${s.name}</b><span>${s.description}</span></div>`)
          .join('');
    } else this.cards.innerHTML = '';
    this.cards.classList.toggle('show', !!offer || !!draft);
  }

  private showEnd(): void {
    this.shownEnd = true;
    const r = this.run;
    const won = r.phase === 'won';
    const cleared = r.cleared;
    const { best, award } = addResult('descent', { won, best: cleared });
    const record = cleared > best;
    this.end.classList.add(won ? 'won' : 'lost');
    this.end.querySelector('.clash-end-title')!.textContent = won ? 'You rise again' : 'Lost in the dark';
    const mins = Math.floor(r.time / 60);
    const secs = String(Math.floor(r.time % 60)).padStart(2, '0');
    this.end.querySelector('.clash-end-score')!.textContent =
      `${won ? 'All fifteen chambers cleared' : `${cleared} ${cleared === 1 ? 'chamber' : 'chambers'} cleared`} in ${mins}:${secs} · ${r.kills} monsters slain · ${r.boons.length} boons · ${record ? 'new best!' : `best ${best}`}`;
    this.end.querySelector('.clash-end-score')!.insertAdjacentHTML('afterend', awardLine(award));
    if (this.board) this.end.querySelector('.clash-end-table')!.innerHTML = scoreTable(this.board, this.me, 'monsters');
    this.end.classList.add('show');
    document.exitPointerLock?.();
  }
}
