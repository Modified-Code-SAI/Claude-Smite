import type { Side } from '../game/combatant';
import { DESCENT, DEPTHS, KIND_NAMES, KIND_TEXT, type Descent } from '../sim/Descent';
import { scoreTable, type Scoreboard } from '../sim/Scoreboard';
import type { Unit } from '../sim/Unit';
import { CHAMBERS } from '../map/UnderworldLayout';
import { addResult } from './records';
import { awardLine } from './ascension';
import { skillIcon } from './icons';
import { KillTally } from './killTally';
import type { SimEvent } from '../sim/Unit';
import './match.css';
import './clash.css';
import './descent.css';

const KEYS = 'ZXC';

/**
 * Underworld Descent readout: the depth and chamber, what is left of its
 * monsters, the curses on the team, the chamber's name card as the team
 * arrives, the team's reward vote and each god's skill draft, the black
 * fade between chambers, and the run's final tally. A shared descent adds
 * both teams' souls to the top bar, with a pop for every gain.
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
  private readonly mine: Side;
  private readonly foe: Side;
  private readonly soulNum = new Map<Side, HTMLElement>();
  private readonly soulGain = new Map<Side, HTMLElement>();
  private readonly soulBox = new Map<Side, HTMLElement>();
  private readonly shownSouls: Record<Side, number> = { order: 0, chaos: 0 };
  /** A shared descent's takedown banners (co-op gods only fall to monsters). */
  private readonly tally: KillTally | null;
  private readonly banner: HTMLElement;
  private bannerUntil = 0;

  constructor(
    private readonly run: Descent,
    private readonly me: Unit,
    onPick: (i: number) => void,
    private readonly board?: Scoreboard,
  ) {
    this.mine = run.sideOf(me);
    this.foe = this.mine === 'order' ? 'chaos' : 'order';
    const souls = (cls: string, label: string) => `<div class="descent-souls ${cls}"><b>0</b><span>${label}</span><i></i></div>`;
    this.root.className = 'clash descent';
    this.root.innerHTML = `
      <div class="clash-bar">${run.versus ? souls('ally', 'Your souls') : ''}<div class="descent-where"></div>${run.versus ? souls('foe', 'Rival souls') : ''}</div>
      <div class="clash-state"></div>
      <div class="descent-curses"></div>
      <div class="descent-card"><div class="descent-card-depth"></div><div class="descent-card-name"></div><div class="descent-card-kind"></div></div>
      <div class="siege-boons descent-cards"></div>
      <div class="mh-banner"></div>
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
    this.banner = this.root.querySelector('.mh-banner')!;
    this.tally = run.versus ? new KillTally(() => me) : null;
    for (const [side, cls] of [[this.mine, 'ally'], [this.foe, 'foe']] as const) {
      const box = this.root.querySelector<HTMLElement>(`.descent-souls.${cls}`);
      if (!box) continue;
      this.soulBox.set(side, box);
      this.soulNum.set(side, box.querySelector('b')!);
      this.soulGain.set(side, box.querySelector('i')!);
    }
  }

  /** Takedown banners in a shared descent: the player's own downs of rival gods (and streaks), first blood, and the player falling. */
  onEvent(e: SimEvent): void {
    if (e.type !== 'death' || e.unit.kind !== 'god' || !this.tally || this.run.over) return;
    const killer = e.killer ? (e.killer.owner ?? e.killer) : null;
    const b = this.tally.onGodDeath(e.unit, killer, this.run.time);
    if (!b) return;
    this.banner.className = 'mh-banner';
    void this.banner.offsetWidth;
    this.banner.className = `mh-banner show mh-${b.side}`;
    // the underworld's words: nobody is slain here, only downed
    this.banner.textContent = b.title === 'Enemy Slain' ? 'Rival downed' : b.title === 'You have been slain' ? 'You are down' : b.title;
    const souls = Math.floor(DESCENT.versus.god * this.run.soulRate(this.mine));
    const sub = b.sub || (b.side === 'epic' ? `+${souls} souls` : '');
    if (sub) {
      const small = document.createElement('small');
      small.className = 'mh-banner-sub';
      small.textContent = sub;
      this.banner.appendChild(small);
    }
    this.bannerUntil = this.run.time + 3;
  }

  /** Both teams' souls, with a pop for each gain and a glow on the leader. */
  private souls(): void {
    const r = this.run;
    if (!r.versus) return;
    for (const side of [this.mine, this.foe]) {
      const now = Math.floor(r.souls[side]);
      const was = this.shownSouls[side];
      if (now === was) continue;
      this.shownSouls[side] = now;
      this.soulNum.get(side)!.textContent = String(now);
      const gain = this.soulGain.get(side)!;
      if (now > was) {
        gain.textContent = `+${now - was}`;
        // restart the pop
        gain.classList.remove('pop');
        void gain.offsetWidth;
        gain.classList.add('pop');
      }
    }
    const lead = this.shownSouls[this.mine] - this.shownSouls[this.foe];
    this.soulBox.get(this.mine)!.classList.toggle('lead', lead > 0);
    this.soulBox.get(this.foe)!.classList.toggle('lead', lead < 0);
  }

  frame(): void {
    const r = this.run;
    if (!r.chamber) return;
    const plan = r.current;
    if (this.bannerUntil && r.time > this.bannerUntil) {
      this.bannerUntil = 0;
      this.banner.classList.remove('show');
    }
    this.where.innerHTML = `<b>${DEPTHS[r.depth]!.name}</b><span>Chamber ${r.chamber} / ${DESCENT.chambers}</span>${r.obols ? `<em title="Charon's Obol: the next wipe is undone">&#9679; ${r.obols}</em>` : ''}`;
    this.souls();
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
    const me = this.me;
    const fallen = [...r.downed.keys()];
    const down = fallen.filter((g) => r.sideOf(g) === this.mine).length;
    const rivalsDown = fallen.length - down;
    const downText = (down ? ` · <b class="down">${down} down</b>: stand over a fallen ally to raise them` : '') + (rivalsDown ? ` · <b class="rivals">${rivalsDown} ${rivalsDown === 1 ? 'rival' : 'rivals'} down</b>` : '');
    switch (r.phase) {
      case 'enter':
        return 'The dead stir…';
      case 'fight': {
        const left = r.monsters.filter((m) => m !== r.gilded).length;
        let s = r.boss?.alive ? `${r.boss.name}: ${Math.ceil((r.boss.combatant.health / r.boss.combatant.stats.maxHealth) * 100)}%` : `${left} ${left === 1 ? 'monster' : 'monsters'} left`;
        if (r.spoils > 0) s += r.spoilsTeam === this.mine ? ` · Champion's spoils ${Math.ceil(r.spoils)}` : ` · the rivals took the Champion's spoils`;
        else if (r.champion?.alive) s += r.versus ? ' · a Champion leads them: its fall empowers whoever lands it' : ' · a Champion leads them';
        if (r.gilded) s += r.versus ? ' · catch the Gilded Thornback before the rivals!' : ' · catch the Gilded Thornback!';
        if (r.erupting) s += ' · soul fire!';
        return s + downText;
      }
      case 'reward':
        return r.offerTeams.includes(this.mine) ? `Choose your team's reward · ${Math.ceil(r.timer)}` : `The rivals claim the Gilded Thornback's prize… · ${Math.ceil(r.timer)}`;
      case 'draft':
        return r.drafts.has(me) ? `Learn a skill · ${Math.ceil(r.timer)}` : r.versus ? 'The gods are choosing their skills…' : 'Your allies are choosing their skills…';
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
    // a team votes only on its own offers (in a shared descent, the rivals may be taking a bonus reward alone)
    const offer = r.phase === 'reward' && r.offerTeams.includes(this.mine) ? r.offer : null;
    const tally = offer ? r.tally(this.mine).join(',') + ':' + (r.votes.get(this.me) ?? -1) : '';
    if (offer === this.shownOffer && draft === this.shownDraft && tally === this.shownTally) return;
    this.shownOffer = offer;
    this.shownDraft = draft;
    this.shownTally = tally;
    if (offer) {
      const t = r.tally(this.mine);
      const mine = r.votes.get(this.me);
      const team = r.humansOf(this.mine).length > 1;
      this.cards.innerHTML =
        `<div class="siege-boons-title">${team ? 'Vote for your team’s reward' : 'Choose your team’s reward'}${r.bonus[this.mine] > 0 ? ' · the Gilded Thornback brings another' : ''}</div>` +
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
    if (r.versus) return this.showVersusEnd();
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

  /** A shared descent's end: which team rules the underworld, by how many souls. */
  private showVersusEnd(): void {
    const r = this.run;
    const w = r.winner;
    const won = w === this.mine;
    const { award } = addResult('descent', { won, best: r.cleared });
    this.end.classList.add(won ? 'won' : 'lost');
    this.end.querySelector('.clash-end-title')!.textContent = w === 'draw' ? 'A dead heat in the dark' : won ? 'Your team rules the underworld' : 'The rivals rule the underworld';
    const mins = Math.floor(r.time / 60);
    const secs = String(Math.floor(r.time % 60)).padStart(2, '0');
    const ours = Math.floor(r.souls[this.mine]);
    const theirs = Math.floor(r.souls[this.foe]);
    const boons = r.boonTeam.filter((t) => t === this.mine).length;
    this.end.querySelector('.clash-end-score')!.textContent =
      `Souls ${ours} to ${theirs} · ${r.teamKills[this.mine]} monsters slain to ${r.teamKills[this.foe]} · ${boons} boons · ${mins}:${secs}`;
    this.end.querySelector('.clash-end-score')!.insertAdjacentHTML('afterend', awardLine(award));
    if (this.board) this.end.querySelector('.clash-end-table')!.innerHTML = scoreTable(this.board, this.me, 'gods');
    this.end.classList.add('show');
    document.exitPointerLock?.();
  }
}
