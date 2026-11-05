import { JOTUNN, PART_IDS, PARTS, type Jotunn, type PartId } from '../sim/Jotunn';
import type { Unit } from '../sim/Unit';
import './jotunn.css';

const PART_GLYPH: Record<PartId, string> = { kneeL: 'L', kneeR: 'R', rune: 'ᛟ', wristL: 'L', wristR: 'R', crown: '♛' };
const PART_GROUP: Record<PartId, string> = { kneeL: 'knee', kneeR: 'knee', rune: 'rune', wristL: 'wrist', wristR: 'wrist', crown: 'crown' };
const SHRINE_ULT: Record<string, string> = { rime: 'Frost Breath', avalanche: 'Avalanche', hail: 'Hailstorm' };

/**
 * The Jötunn readout: the giant's Might with its weak points beneath it (lit
 * while they can be struck, dark once broken), the four braziers, the three
 * shrines, the round and everyone's wins, and the result.
 */
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
  private lag01 = 1;
  private readonly last: Record<string, string> = {};
  private shownEnd = false;

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
        <div class="jt-parts"></div>
        <div class="jt-row"><div class="jt-braziers"></div><div class="jt-shrines"></div></div>
      </div>
      <div class="clash-state"></div>
      <div class="duel-big jt-big"></div>
      <div class="jt-wins"></div>
      <div class="clash-end"><div class="clash-end-title"></div><div class="clash-end-score"></div><button class="clash-again">Play again</button></div>`;
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
    this.parts.innerHTML = PART_IDS.map((id) => `<i class="jt-part ${PART_GROUP[id]}" data-id="${id}" title="${PARTS[id].name}"><b>${PART_GLYPH[id]}</b></i>`).join('');
    this.braziers.innerHTML = JOTUNN.braziers.map(() => '<i class="jt-brazier"></i>').join('');
    this.shrines.innerHTML = mode.shrines.map((s) => `<span class="jt-shrine" data-id="${s.def.id}" title="${s.def.name}: ${SHRINE_ULT[s.def.id] ?? ''}"><i></i><em></em></span>`).join('');
    q('.clash-again').addEventListener('click', () => location.reload());
  }

  /** Whether the local player is the giant this round. */
  private get giantIsMe(): boolean {
    return this.mode.giantPlayer.god === this.me;
  }

  private set(key: string, value: string, apply: (v: string) => void): void {
    if (this.last[key] === value) return;
    this.last[key] = value;
    apply(value);
  }

  frame(dt: number): void {
    const m = this.mode;
    const g = m.giant;
    const mine = this.giantIsMe;
    this.set('round', `${m.round}/${m.rounds}`, () => (this.round.textContent = `ROUND ${m.round} / ${m.rounds}`));
    this.set('who', `${mine}:${m.giantPlayer.name}`, () => (this.who.textContent = mine ? 'You are the Jötunn' : `${m.giantPlayer.name} is the Jötunn`));
    this.root.classList.toggle('as-giant', mine);

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
    if (m.phase === 'countdown') {
      big = String(Math.max(1, Math.ceil(m.timer)));
      text = mine ? 'Smash three of the four braziers' : 'Guard the braziers: break its knees, then strike its crown';
    } else if (m.phase === 'fight') {
      if (m.kneeling > 0) {
        text = mine ? `On your knees: your crown is open (${Math.ceil(m.kneeling)} s)` : `It kneels: strike the crown! (${Math.ceil(m.kneeling)} s)`;
        tone = mine ? 'chaos' : 'order';
      } else if (m.planted) {
        text = mine ? 'Your fist is planted: the wrist is open' : 'Its fist is planted: break the wrist!';
        tone = 'contested';
      } else if (m.fury > 0) {
        text = `The Jötunn's fury grows: +${Math.round(m.fury * 100)}% damage`;
        tone = 'chaos';
      } else {
        const left = m.braziersLeft;
        text = `${left} of ${JOTUNN.braziers.length} braziers burn · the giant needs ${JOTUNN.braziersToWin}`;
      }
    } else if (m.phase === 'over') {
      const giantWon = m.lastRound === 'giant';
      const won = mine ? giantWon : !giantWon;
      big = won ? 'ROUND WON' : 'ROUND LOST';
      text = giantWon ? `${mine ? 'You' : m.giantPlayer.name} smashed the braziers` : 'The Jötunn has fallen';
      tone = won ? 'order' : 'chaos';
    }
    this.set('state', `${tone}|${text}`, () => {
      this.state.textContent = text;
      this.state.dataset.state = tone;
      this.state.style.display = text ? '' : 'none';
    });
    this.set('big', big, () => {
      this.big.textContent = big;
      this.big.classList.toggle('show', !!big);
    });

    // everyone's wins, the giant's player marked
    const wins = m.players.map((p) => `${p.god === this.me ? 'You' : p.name}:${p.wins}:${p === m.giantPlayer}`).join('|');
    this.set('wins', wins, () => {
      this.wins.innerHTML = m.players
        .map((p) => `<span class="${p.god === this.me ? 'me' : ''} ${p === m.giantPlayer ? 'giant' : ''}">${p.god === this.me ? 'You' : p.name}<b>${p.wins}</b></span>`)
        .join('');
    });

    if (m.phase === 'done' && !this.shownEnd) {
      this.shownEnd = true;
      const champs = m.champions;
      const won = champs.some((p) => p.god === this.me);
      this.end.classList.add('show', won ? 'won' : 'lost');
      this.end.querySelector('.clash-end-title')!.textContent = won ? (champs.length > 1 ? 'Shared victory' : 'Victory') : 'Defeat';
      this.end.querySelector('.clash-end-score')!.innerHTML = this.table();
    }
  }

  private table(): string {
    const rows = [...this.mode.players]
      .sort((a, b) => b.wins - a.wins)
      .map((p) => {
        const r = p.giantRound;
        const asGiant = r ? `${r.won ? 'won' : 'lost'} · ${r.braziers} braziers · ${Math.floor(r.time / 60)}:${String(Math.floor(r.time % 60)).padStart(2, '0')}` : '–';
        return `<tr class="${p.god === this.me ? 'me' : ''}"><td>${p.god === this.me ? 'You' : p.name}</td><td>${p.wins}</td><td>${asGiant}</td></tr>`;
      })
      .join('');
    return `<table class="end-table"><tr><th>Player</th><th>Rounds won</th><th>As the Jötunn</th></tr>${rows}</table>`;
  }

  setVisible(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
  }
}
