import type { CineKind } from '../combat/jotunnCine';
import { JOTUNN, lastStand, PART_IDS, PARTS, type Jotunn, type PartId } from '../sim/Jotunn';
import type { SimEvent, Unit } from '../sim/Unit';
import { awardLine } from './ascension';
import { clockText, jotunnAwards, mightText, type JotunnAwardKey } from './jotunnAwards';
import { JotunnRadar } from './JotunnRadar';
import { KillTally } from './killTally';
import { addResult } from './records';
import './match.css';
import './jotunn.css';

const PART_GLYPH: Record<PartId, string> = { kneeL: 'L', kneeR: 'R', rune: 'ᛟ', wristL: 'L', wristR: 'R', crown: '♛' };
const PART_GROUP: Record<PartId, string> = { kneeL: 'knee', kneeR: 'knee', rune: 'rune', wristL: 'wrist', wristR: 'wrist', crown: 'crown' };
const SHRINE_ULT: Record<string, string> = { rime: 'Frost Breath', avalanche: 'Avalanche', hail: 'Hailstorm' };
/** The end screen's frost medals: a sword, a cracked shard of ice, the giant's crown. */
const AWARD_ICON: Record<JotunnAwardKey, string> = {
  slayer: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1l3 3.6V14H9V4.6z"/><path d="M5.5 14h13v2.6h-13z"/><path d="M10.6 16.6h2.8v3.6l1.2 1.2V23H9.4v-1.6l1.2-1.2z"/></svg>',
  breaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5l7.5 10.5L12 22.5 4.5 12z"/><path d="M12.6 2.5l-1.8 5.6 2.9 3.1-2.4 4.2 1.3 6" fill="none" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  giant: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 18.5l1.8-12 4.4 5.2L12 3l3.3 8.7 4.4-5.2 1.8 12z"/><path d="M2.5 19.6h19v2.3h-19z"/></svg>',
};
/** Text for innerHTML (players' names come from their peers online). */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
/** Seconds the braziers' count stays on the state line once it changes (the bar keeps it), before the line clears off the giant's chest. */
const QUIET_AFTER = 6;

/**
 * The Jötunn readout: the giant's Might with its weak points beneath it (lit
 * while they can be struck, dark once broken), the four braziers, the three
 * shrines, the round and everyone's wins, and the result.
 */
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];

/** The round's aim in a line, for whichever side the player is on: under the waking card's name, and the countdown's state line. */
export function objective(giant: boolean): string {
  const n = (k: number) => WORDS[k] ?? String(k);
  return giant ? `Smash ${n(JOTUNN.braziersToWin)} of the ${n(JOTUNN.braziers.length)} braziers` : 'Guard the braziers: break its knees, then strike its crown';
}

export class JotunnHud {
  private readonly root = document.createElement('div');
  private readonly round: HTMLElement;
  private readonly who: HTMLElement;
  private readonly might: HTMLElement;
  private readonly lag: HTMLElement;
  private readonly pct: HTMLElement;
  private readonly parts: HTMLElement;
  private readonly braziers: HTMLElement;
  private readonly shrines: HTMLElement;
  private readonly state: HTMLElement;
  private readonly big: HTMLElement;
  private readonly wins: HTMLElement;
  private readonly end: HTMLElement;
  private readonly banner: HTMLElement;
  private bannerTime = 0;
  /** The giant's name card, while its waking shot runs. */
  private readonly card: HTMLElement;
  /** The valley at a glance, top right: the giant, the braziers, the shrines and the gods. */
  readonly radar: JotunnRadar;
  private readonly dipEl: HTMLElement;
  /** Takedowns this round: kept per round, so a streak never carries over to the next giant. */
  private tally: KillTally;
  private tallyRound = 0;
  private lag01 = 1;
  /** The braziers' count last said on the state line, and for how long. */
  private idleLine = '';
  private idleFor = 0;
  private readonly last: Record<string, string> = {};
  private shownEnd = false;
  /** The round whose fight came to its last stand (held once it does, as the music is). */
  private standRound = 0;

  constructor(
    private readonly mode: Jotunn,
    /** The local player's own god (the giant player's god sits their round out). */
    private readonly me: Unit,
  ) {
    this.root.className = 'clash jotunn';
    this.root.innerHTML = `
      <div class="jt-top">
        <div class="jt-head"><span class="jt-round"></span><span class="jt-who"></span></div>
        <div class="jt-might"><div class="jt-lag"></div><div class="jt-fill"></div><span class="jt-pct"></span></div>
        <div class="jt-row"><div class="jt-braziers"></div><div class="jt-parts"></div><div class="jt-shrines"></div></div>
      </div>
      <div class="clash-state"></div>
      <div class="duel-big jt-big"></div>
      <div class="jt-card"><small></small><b></b><span></span><em></em></div>
      <div class="mh-banner"></div>
      <div class="jt-wins"></div>
      <div class="clash-end"><div class="clash-end-title"></div><div class="clash-end-score"></div><button class="clash-again">Play again</button></div>
      <div class="jt-dip"></div>`;
    document.body.appendChild(this.root);
    const q = (s: string) => this.root.querySelector<HTMLElement>(s)!;
    this.round = q('.jt-round');
    this.who = q('.jt-who');
    this.might = q('.jt-fill');
    this.lag = q('.jt-lag');
    this.pct = q('.jt-pct');
    this.parts = q('.jt-parts');
    this.braziers = q('.jt-braziers');
    this.shrines = q('.jt-shrines');
    this.state = q('.clash-state');
    this.big = q('.jt-big');
    this.wins = q('.jt-wins');
    this.end = q('.clash-end');
    this.banner = q('.mh-banner');
    this.card = q('.jt-card');
    this.dipEl = q('.jt-dip');
    this.radar = new JotunnRadar(mode, me);
    this.root.insertBefore(this.radar.el, this.wins);
    this.tally = this.newTally();
    this.parts.innerHTML = PART_IDS.map((id) => `<i class="jt-part ${PART_GROUP[id]}" data-id="${id}" title="${PARTS[id].name}"><b>${PART_GLYPH[id]}</b></i>`).join('');
    this.braziers.innerHTML = JOTUNN.braziers.map(() => '<i class="jt-brazier"></i>').join('');
    this.shrines.innerHTML = mode.shrines.map((s) => `<span class="jt-shrine" data-id="${s.def.id}" title="${s.def.name}: ${SHRINE_ULT[s.def.id] ?? ''}"><i></i><em></em></span>`).join('');
    q('.clash-again').addEventListener('click', () => location.reload());
  }

  /** Whether the local player is the giant this round. */
  private get giantIsMe(): boolean {
    return this.mode.giantPlayer.god === this.me;
  }

  /** Counted for whatever the local player plays: the giant on their turn, their god otherwise. */
  private newTally(): KillTally {
    this.tallyRound = this.mode.round;
    return new KillTally(() => (this.giantIsMe ? this.mode.giant : this.me));
  }

  /**
   * Takedown banners: the gods the player crushes as the giant (a stomp that
   * catches two is a double kill), their kills and streaks as a god, and
   * first blood. The player's own fall has the death screen, and the giant's
   * is the round's end.
   */
  onEvent(e: SimEvent): void {
    const m = this.mode;
    if (e.type !== 'death' || e.unit.kind !== 'god' || e.unit === m.giant || m.phase !== 'fight') return;
    if (this.tallyRound !== m.round) this.tally = this.newTally();
    const killer = e.killer ? (e.killer.owner ?? e.killer) : null;
    const b = this.tally.onGodDeath(e.unit, killer, m.timer);
    // your own fall has its own screen (slain, returning in a few seconds)
    if (!b || e.unit === this.me) return;
    this.banner.className = 'mh-banner';
    void this.banner.offsetWidth;
    this.banner.className = `mh-banner show mh-${b.side}`;
    // a giant doesn't slay, it crushes
    const giant = this.giantIsMe && b.side === 'epic';
    this.banner.textContent = giant && b.title === 'Enemy Slain' ? `${e.unit.name} crushed` : b.title;
    if (b.sub) {
      const sub = document.createElement('small');
      sub.className = 'mh-banner-sub';
      sub.textContent = b.sub;
      this.banner.appendChild(sub);
    }
    this.bannerTime = 3;
  }

  private set(key: string, value: string, apply: (v: string) => void): void {
    if (this.last[key] === value) return;
    this.last[key] = value;
    apply(value);
  }

  /** A dip to dark lasting `seconds`, darkest halfway (it hides a shot's cut back to play). */
  dip(seconds: number): void {
    const d = this.dipEl;
    d.classList.remove('on');
    void d.offsetWidth;
    d.style.animationDuration = `${seconds}s`;
    d.classList.add('on');
  }

  /** `cine`: the shot of the giant on screen, if any (see JotunnCine): the play readout steps aside for it. */
  frame(dt: number, cine: CineKind | null = null): void {
    const m = this.mode;
    const g = m.giant;
    const mine = this.giantIsMe;
    this.set('cine', cine ?? '', (v) => {
      this.root.dataset.cine = v;
      document.body.classList.toggle('jotunn-cine', !!v);
    });
    // the waking: who the giant is this round
    const card = cine === 'wake' ? `${m.round}|${mine}|${m.giantPlayer.name}` : '';
    this.set('card', card, () => {
      this.card.classList.toggle('show', !!card);
      if (!card) return;
      const last = m.round === m.rounds && m.rounds > 1;
      this.card.querySelector('small')!.textContent = last ? 'Final round' : `Round ${m.round} of ${m.rounds}`;
      this.card.querySelector('b')!.textContent = mine ? 'You' : m.giantPlayer.name;
      this.card.querySelector('span')!.textContent = mine ? 'are the Jötunn' : 'is the Jötunn';
      this.card.querySelector('em')!.textContent = objective(mine);
    });
    if (this.bannerTime > 0) {
      this.bannerTime -= dt;
      // the round's end takes the screen
      if (this.bannerTime <= 0 || m.phase !== 'fight') {
        this.bannerTime = 0;
        this.banner.classList.remove('show');
      }
    }
    this.set('round', `${m.round}/${m.rounds}`, () => (this.round.textContent = `ROUND ${m.round} / ${m.rounds}`));
    this.set('who', `${mine}:${m.giantPlayer.name}`, () => (this.who.textContent = mine ? 'You are the Jötunn' : `${m.giantPlayer.name} is the Jötunn`));
    this.root.classList.toggle('as-giant', mine);
    this.radar.frame(dt);
    // the last stand: the Might bar pulses with a cold light for the rest of the round
    if (lastStand(m)) this.standRound = m.round;
    const stand = this.standRound === m.round && m.phase === 'fight';
    this.root.classList.toggle('jt-stand', stand);

    // Might: the bar falls at once, the pale lag behind it follows
    const hp = g.alive ? g.combatant.health / g.combatant.stats.maxHealth : 0;
    this.lag01 = hp > this.lag01 ? hp : Math.max(hp, this.lag01 - dt * 0.25);
    this.might.style.width = `${(hp * 100).toFixed(2)}%`;
    this.lag.style.width = `${(this.lag01 * 100).toFixed(2)}%`;
    this.set('pct', `${Math.ceil(hp * 100)}`, (v) => (this.pct.textContent = `MIGHT ${v}%`));

    // weak points: lit while open to blows, dark while broken
    for (const el of this.parts.children as HTMLCollectionOf<HTMLElement>) {
      const id = el.dataset.id as PartId;
      const u = m.parts.get(id)!;
      const regrow = m.regrow.get(id);
      const s = !u.alive ? 'broken' : u.untargetable <= 0 && m.phase === 'fight' ? 'open' : 'shut';
      this.set(`part-${id}`, s, (v) => (el.dataset.s = v));
      const health = u.alive ? u.combatant.health / u.combatant.stats.maxHealth : 0;
      el.style.setProperty('--hp', health.toFixed(2));
      el.title = `${PARTS[id].name}${regrow ? `: grows back in ${Math.ceil(regrow)} s` : ''}`;
    }

    m.braziers.forEach((b, i) => {
      const el = this.braziers.children[i] as HTMLElement;
      this.set(`brazier-${i}`, b.alive ? `lit:${Math.round((b.combatant.health / b.combatant.stats.maxHealth) * 10)}` : 'out', (v) => {
        el.dataset.s = v.startsWith('lit') ? 'lit' : 'out';
        el.style.setProperty('--hp', v.startsWith('lit') ? String(Number(v.slice(4)) / 10) : '0');
      });
    });

    m.shrines.forEach((s, i) => {
      const el = this.shrines.children[i] as HTMLElement;
      const st = s.dormant > 0 ? 'spent' : s.contested && s.progress > 0 ? 'held' : s.progress > 0 ? 'claiming' : 'ready';
      this.set(`shrine-${i}`, `${st}:${Math.round(s.progress * 20)}`, () => {
        el.dataset.s = st;
        el.style.setProperty('--claim', s.progress.toFixed(2));
        el.querySelector('em')!.textContent = st === 'spent' ? `${Math.ceil(s.dormant)} s` : SHRINE_ULT[s.def.id] ?? '';
      });
    });

    // the round's state line and the big countdown
    let text = '';
    let tone = '';
    let big = '';
    let quiet = false;
    if (m.phase === 'countdown') {
      this.idleLine = '';
      big = String(Math.max(1, Math.ceil(m.timer)));
      text = objective(mine);
    } else if (m.phase === 'fight') {
      if (m.kneeling > 0) {
        text = mine ? `On your knees: your crown is open (${Math.ceil(m.kneeling)} s)` : `It kneels: strike the crown! (${Math.ceil(m.kneeling)} s)`;
        tone = mine ? 'chaos' : 'order';
      } else if (m.planted) {
        text = mine ? 'Your fist is planted: the wrist is open' : 'Its fist is planted: break the wrist!';
        tone = 'contested';
      } else if (stand) {
        const brink = m.braziersLeft <= JOTUNN.braziers.length - JOTUNN.braziersToWin + 1;
        if (brink) text = mine ? 'One more brazier and the temple is yours' : 'One more brazier and the temple falls: hold it!';
        else text = mine ? 'Your Might is failing: smash the braziers!' : 'Its Might is failing: bring it down!';
        tone = mine === brink ? 'order' : 'chaos';
      } else if (m.fury > 0) {
        text = `The Jötunn's fury grows: +${Math.round(m.fury * 100)}% damage`;
        tone = 'chaos';
      } else {
        const left = m.braziersLeft;
        text = `${left} of ${JOTUNN.braziers.length} braziers burn · the giant needs ${JOTUNN.braziersToWin}`;
        if (text !== this.idleLine) {
          this.idleLine = text;
          this.idleFor = 0;
        }
        this.idleFor += dt;
        quiet = this.idleFor > QUIET_AFTER;
      }
    } else if (m.phase === 'over') {
      const giantWon = m.lastRound === 'giant';
      const won = mine ? giantWon : !giantWon;
      big = won ? 'ROUND WON' : 'ROUND LOST';
      text = giantWon ? `${mine ? 'You' : m.giantPlayer.name} smashed the braziers` : 'The Jötunn has fallen';
      tone = won ? 'order' : 'chaos';
    }
    this.set('state', `${tone}|${text}|${quiet}`, () => {
      this.state.textContent = text;
      this.state.dataset.state = tone;
      this.state.style.display = text ? '' : 'none';
      this.state.classList.toggle('quiet', quiet);
    });
    this.set('big', big, () => {
      this.big.textContent = big;
      this.big.classList.toggle('show', !!big);
    });

    // everyone's wins, the giant's player marked
    const wins = m.players.map((p) => `${p.god === this.me ? 'You' : p.name}:${p.wins}:${p === m.giantPlayer}`).join('|');
    this.set('wins', wins, () => {
      this.wins.innerHTML = m.players
        .map((p) => `<span class="${p.god === this.me ? 'me' : ''} ${p === m.giantPlayer ? 'giant' : ''}">${this.nameOf(p)}<b>${p.wins}</b></span>`)
        .join('');
    });

    if (m.phase === 'done' && !this.shownEnd) {
      this.shownEnd = true;
      const champs = m.champions;
      const won = champs.some((p) => p.god === this.me);
      this.end.classList.add('show', won ? 'won' : 'lost');
      this.end.querySelector('.clash-end-title')!.textContent = won ? (champs.length > 1 ? 'Shared victory' : 'Victory') : 'Defeat';
      const score = this.end.querySelector('.clash-end-score')!;
      score.innerHTML = this.table();
      // the match's awards, as frost medals over the table
      const medals = jotunnAwards(m.players)
        .map((a) => `<div class="jt-award${a.player.god === this.me ? ' me' : ''}" data-award="${a.key}"><i>${AWARD_ICON[a.key]}</i><b>${a.title}</b><span>${this.nameOf(a.player)}</span><small>${esc(a.stat)}</small></div>`)
        .join('');
      if (medals) score.insertAdjacentHTML('beforebegin', `<div class="jt-awards">${medals}</div>`);
      const { award } = addResult('jotunn', { won, rounds: m.rounds });
      score.insertAdjacentHTML('afterend', awardLine(award));
    }
  }

  private nameOf(p: { god: Unit; name: string }): string {
    return p.god === this.me ? 'You' : esc(p.name);
  }

  /** Everyone's match: rounds won, what they tore from the giant as a god, and their own round as it. */
  private table(): string {
    const rows = [...this.mode.players]
      .sort((a, b) => b.wins - a.wins || b.tally.might - a.tally.might)
      .map((p) => {
        const r = p.giantRound;
        const t = p.tally;
        const asGiant = r ? [r.won ? 'won' : 'lost', `${r.braziers} brazier${r.braziers === 1 ? '' : 's'}`, t.takedowns > 0 ? `${t.takedowns} takedown${t.takedowns === 1 ? '' : 's'}` : '', clockText(r.time)].filter(Boolean).join(' · ') : '–';
        // the blow that felled the giant, marked by the name
        const felled = t.felled > 0 ? `<span class="jt-felled" title="Struck the blow that felled the giant${t.felled > 1 ? ` (${t.felled} times)` : ''}">⚔</span>` : '';
        return `<tr class="${p.god === this.me ? 'me' : ''}"><td>${felled}${this.nameOf(p)}</td><td>${p.wins}</td><td>${mightText(t.might)}</td><td>${t.breaks}</td><td>${asGiant}</td></tr>`;
      })
      .join('');
    const legend = this.mode.players.some((p) => p.tally.felled > 0) ? '<div class="jt-legend">⚔ struck the blow that felled the giant</div>' : '';
    return `<table class="end-table"><tr><th>Player</th><th>Rounds won</th><th>Might torn</th><th>Weak points</th><th>As the Jötunn</th></tr>${rows}</table>${legend}`;
  }

  setVisible(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
  }
}
