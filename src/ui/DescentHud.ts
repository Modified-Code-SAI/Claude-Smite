import type { Side } from '../game/combatant';
import { DESCENT, DEPTHS, KIND_NAMES, KIND_TEXT, type Descent } from '../sim/Descent';
import { scoreTable, type Scoreboard } from '../sim/Scoreboard';
import type { Unit } from '../sim/Unit';
import { CHAMBERS } from '../map/UnderworldLayout';
import { addResult } from './records';
import { awardLine } from './ascension';
import { relicById, type RelicId } from '../sim/Relics';
import { relicIcon, skillIcon } from './icons';
import { KillTally } from './killTally';
import { BOSS_EPITHET, BOSS_FALL_LINE } from './bossNames';
import type { SimEvent } from '../sim/Unit';
import './match.css';
import './clash.css';
import './descent.css';

const KEYS = 'ZXC';

/** How to fight a new kind of monster, shown under the status line for a while in the first chamber it rises in. */
const HINT_TIME = 14;
const HINTS: readonly (readonly [tag: string, hint: string])[] = [
  [':shade', 'Shades blink away when you close in: sidestep their slow bolts'],
  [':gravekeeper', 'Gravekeepers mend the monsters around them: take them down first'],
  [':ossuaryKing', 'The King rains soul fire where you stand: keep moving'],
];

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
  /** The first chamber each new monster rose in this run, and when, so its hint shows there for a while. */
  private readonly hintAt = new Map<string, { chamber: number; at: number }>();
  private readonly hint: HTMLElement;
  private lastHint = '';
  /** What the top of the screen holds, as body classes (descent-cursed, descent-boss-up) that stack it. */
  private readonly stack = { cursed: false, boss: false };
  /** A boss's name and title as it rises (see DESCENT.bossIntro). */
  private readonly bossCard: HTMLElement;
  private bossShown = '';
  /** The team's relics down the left edge, each lighting up as it goes off. */
  private readonly relicTray: HTMLElement;
  private readonly relicEls = new Map<RelicId, HTMLElement>();
  private shownRelics = '';
  private lastProc = 0;

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
      <div class="descent-hint"></div>
      <div class="descent-card"><div class="descent-card-depth"></div><div class="descent-card-name"></div><div class="descent-card-kind"></div></div>
      <div class="descent-boss"><small></small><b></b><span></span></div>
      <div class="siege-boons descent-cards"></div>
      <div class="descent-relics"></div>
      <div class="mh-banner"></div>
      <div class="descent-fade"></div>
      <div class="clash-end"><div class="clash-end-title"></div><div class="clash-end-score"></div><div class="clash-end-table"></div><button class="clash-again">Descend again</button></div>`;
    document.body.appendChild(this.root);
    document.body.classList.add('descent-mode');
    this.where = this.root.querySelector('.descent-where')!;
    this.state = this.root.querySelector('.clash-state')!;
    this.curses = this.root.querySelector('.descent-curses')!;
    this.hint = this.root.querySelector('.descent-hint')!;
    this.card = this.root.querySelector('.descent-card')!;
    this.bossCard = this.root.querySelector('.descent-boss')!;
    this.cards = this.root.querySelector('.descent-cards')!;
    this.fade = this.root.querySelector('.descent-fade')!;
    this.end = this.root.querySelector('.clash-end')!;
    this.relicTray = this.root.querySelector('.descent-relics')!;
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

  /** A boss rising: its name and title under it, held while its chamber waits (they fade as the camera comes back). */
  private bossIntro(): void {
    const r = this.run;
    // its name as it rises, and again (in gold) a moment after it falls
    const rising = r.intro > 0.4;
    const falling = r.fall > 0.5 && r.fall < DESCENT.bossFall - 0.35;
    const boss = rising || falling ? r.boss : null;
    const key = boss ? `${boss.id}${falling ? ':fell' : ''}` : '';
    if (key === this.bossShown) return;
    this.bossShown = key;
    if (boss) {
      const type = boss.tag.split(':')[1] ?? '';
      const last = r.chamber === DESCENT.chambers;
      const theirs = r.versus && r.bossBy && r.bossBy !== this.mine;
      this.bossCard.querySelector('small')!.textContent = falling ? (theirs ? 'Felled by the rivals' : 'Vanquished') : last ? 'The bottom of the underworld' : `The master of ${DEPTHS[r.depth]!.name}`;
      this.bossCard.querySelector('b')!.textContent = boss.name;
      this.bossCard.querySelector('span')!.textContent = (falling ? BOSS_FALL_LINE[type] : BOSS_EPITHET[type]) ?? '';
      this.bossCard.classList.toggle('fell', falling);
    }
    this.bossCard.classList.toggle('show', !!boss);
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
        // the bottom of the run: its lord, by name
        const last = plan.kind === 'boss' && r.chamber === DESCENT.chambers;
        this.card.querySelector('.descent-card-kind')!.innerHTML = last ? '<b>The Ossuary King</b> The lord of the Abyss. End this.' : `<b>${KIND_NAMES[plan.kind]}</b> ${KIND_TEXT[plan.kind]}`;
      }
      this.card.classList.toggle('show', !!cardKey);
      this.card.dataset.kind = plan.kind;
    }
    this.bossIntro();

    const text = this.stateText();
    if (text !== this.lastText) {
      this.lastText = text;
      this.state.innerHTML = text;
      this.state.dataset.state = r.phase === 'exit' ? 'order' : r.downed.size ? 'chaos' : '';
    }

    const hint = this.hintText();
    if (hint !== this.lastHint) {
      this.lastHint = hint;
      if (hint) this.hint.innerHTML = hint;
      this.hint.classList.toggle('show', !!hint);
    }
    // the top of the screen stacks: status line, curses, a boss's bar, hints (see descent.css)
    const cursed = r.curses.length > 0 || !!r.nextCurse;
    const bossUp = r.phase === 'fight' && !!r.boss?.alive;
    if (cursed !== this.stack.cursed) document.body.classList.toggle('descent-cursed', (this.stack.cursed = cursed));
    if (bossUp !== this.stack.boss) document.body.classList.toggle('descent-boss-up', (this.stack.boss = bossUp));

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
    this.relics();

    if (r.over && !this.shownEnd) this.showEnd();
  }

  /** The team's relics: a new one flies in, each flares as it goes off for this god (or the team), and Spite burns while it rages. */
  private relics(): void {
    const rel = this.run.relics;
    const mine = rel.ofSide(this.mine);
    const key = mine.join();
    if (key !== this.shownRelics) {
      const had = new Set(this.relicEls.keys());
      this.shownRelics = key;
      this.relicTray.innerHTML = mine
        .map((id) => {
          const r = relicById(id)!;
          return `<div class="descent-relic${had.has(id) ? '' : ' new'}" data-id="${id}"><i>${relicIcon(id)}</i><span><b>${r.name}</b>${r.text}</span></div>`;
        })
        .join('');
      this.relicEls.clear();
      for (const el of this.relicTray.querySelectorAll<HTMLElement>('.descent-relic')) this.relicEls.set(el.dataset.id as RelicId, el);
      this.relicTray.classList.toggle('show', mine.length > 0);
    }
    for (const p of rel.procs) {
      if (p.id <= this.lastProc) continue;
      this.lastProc = p.id;
      // a god's own relics (a shield, a refund, a heal, a rage) flare for that god's player only
      if (p.side !== this.mine || (p.god !== undefined && this.run.gods[p.god] !== this.me)) continue;
      const el = this.relicEls.get(p.k);
      if (!el) continue;
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
    this.relicEls.get('spite')?.classList.toggle('lit', rel.spiting(this.me));
    // between fights, every relic says what it does
    this.relicTray.classList.toggle('open', this.run.phase === 'reward' || this.run.phase === 'draft' || this.run.phase === 'exit');
  }

  /** How to fight each kind of monster rising for the first time this run, one line each, for HINT_TIME seconds. */
  private hintText(): string {
    const r = this.run;
    if (r.phase !== 'fight') return '';
    let s = '';
    for (const [tag, hint] of HINTS) {
      if (!this.hintAt.has(tag) && r.monsters.some((m) => m.alive && m.tag.endsWith(tag))) this.hintAt.set(tag, { chamber: r.chamber, at: r.time });
      const seen = this.hintAt.get(tag);
      if (seen && seen.chamber === r.chamber && r.time - seen.at < HINT_TIME) s += `<span>${hint}</span>`;
    }
    return s;
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
              `<div class="siege-boon descent-reward ${c.kind}${mine === i ? ' voted' : ''}" data-i="${i}"><kbd>${KEYS[i]}</kbd>${c.relic ? `<i class="descent-icon">${relicIcon(c.relic.id)}</i><small>Relic</small>` : ''}<b>${c.name}</b><span>${c.text}</span>${team && t[i] ? `<em>${t[i]} ${t[i] === 1 ? 'vote' : 'votes'}</em>` : ''}</div>`,
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
      `${won ? 'All fifteen chambers cleared' : `${cleared} ${cleared === 1 ? 'chamber' : 'chambers'} cleared`} in ${mins}:${secs} · ${r.kills} monsters slain · ${r.boons.length} boons${relics(r.relics.ofSide('order').length)} · ${record ? 'new best!' : `best ${best}`}`;
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
      `Souls ${ours} to ${theirs} · ${r.teamKills[this.mine]} monsters slain to ${r.teamKills[this.foe]} · ${boons} boons${relics(r.relics.ofSide(this.mine).length)} · ${mins}:${secs}`;
    this.end.querySelector('.clash-end-score')!.insertAdjacentHTML('afterend', awardLine(award));
    if (this.board) this.end.querySelector('.clash-end-table')!.innerHTML = scoreTable(this.board, this.me, 'gods');
    this.end.classList.add('show');
    document.exitPointerLock?.();
  }
}

const relics = (n: number): string => (n ? ` · ${n} ${n === 1 ? 'relic' : 'relics'}` : '');
