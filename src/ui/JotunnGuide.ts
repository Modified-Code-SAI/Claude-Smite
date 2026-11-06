import { JOTUNN, PARTS, type JotunnPhase } from '../sim/Jotunn';
import './jotunnGuide.css';

const SEEN_KEY = 'ascendant.jotunnGuide';
/** Rounds a player sees the card for, on each side, before it stops showing. */
export const GUIDE_ROUNDS = 2;
/** Seconds into the fight the card stays up (it shows from the countdown on). */
export const GUIDE_FIGHT = 9;

export type GuideRole = 'god' | 'giant';

/**
 * A drawing of the giant with its weak points marked: the knees (1), the
 * crown (2, gold), the wrists and the back rune. Plain shapes, so it reads at
 * a glance at card size.
 */
function giantSvg(role: GuideRole): string {
  const ice = '#8fe4ff';
  const mark = (x: number, y: number, label: string, gold = false) =>
    `<g class="jg-mark${gold ? ' gold' : ''}"><circle cx="${x}" cy="${y}" r="7.5"/><text x="${x}" y="${y + 3.4}" text-anchor="middle">${label}</text></g>`;
  const body =
    // legs, torso, arms (fists low, as it stands), head
    `<path d="M47 92 L43 145 H53 L57 96 H63 L67 145 H77 L73 92 Z"/>` +
    `<path d="M38 44 Q60 36 82 44 L78 94 H42 Z"/>` +
    `<path d="M38 46 L24 92 L31 94 L44 60 Z M82 46 L96 92 L89 94 L76 60 Z"/>` +
    `<circle cx="27" cy="97" r="7"/><circle cx="93" cy="97" r="7"/>` +
    `<circle cx="60" cy="27" r="11"/>`;
  const crown = `<path class="jg-crown" d="M49 18 L49 9 L54 14 L60 6 L66 14 L71 9 L71 18 Z"/>`;
  // the back rune, round the far side: a dashed ring on the chest
  const rune = `<circle class="jg-rune" cx="60" cy="64" r="8"/><path class="jg-rune-glyph" d="M58 58 V70 M58 60 L63 63 L58 66"/>`;
  const marks = mark(47, 120, '1') + mark(73, 120, '1') + mark(60, 13, '2', true) + mark(27, 97, '!') + mark(93, 97, '!');
  return `<svg class="jg-giant ${role}" viewBox="0 0 120 150" aria-hidden="true"><g class="jg-body" fill="#26394b" stroke="${ice}" stroke-opacity="0.35" stroke-width="1">${body}</g>${crown}${rune}${marks}</svg>`;
}

/** The card's words for each side. */
export function guideLines(role: GuideRole): { title: string; steps: string[]; foot: string } {
  const crown = PARTS.crown.mult;
  const win = JOTUNN.braziersToWin;
  const of = JOTUNN.braziers.length;
  if (role === 'giant')
    return {
      title: 'You are the Jötunn',
      steps: [
        `<i class="fire">✦</i> <b>Smash ${win} of the ${of} braziers</b> on the temple to win the round`,
        `<i class="shrine">◆</i> Stand in an <b>ice shrine</b> to claim a new ultimate`,
        `<i>1</i> Guard your <b>knees</b>: if both break you kneel and your <b>crown</b> is open`,
      ],
      foot: 'Your planted fist after a slam and your back rune are weak points too.',
    };
  return {
    title: 'Bring down the Jötunn',
    steps: [
      `<i>1</i> Break both <b>knees</b>: it falls to its knees`,
      `<i class="gold">2</i> Strike the <b>crown</b> while it kneels: ×${crown} damage`,
      `<i>!</i> After a slam its fist is planted: break the <b>wrist</b>`,
    ],
    // it is immune to crowd control (Combatant.ccImmune): a bar of pulls and roots does next to nothing to it
    foot: `Keep it from the braziers: it needs ${win} of the ${of}. Its back rune breaks too. Stuns and pulls slide off it: bring damage.`,
  };
}

export function guideHtml(role: GuideRole): string {
  const g = guideLines(role);
  return `${giantSvg(role)}<div class="jg-text"><div class="jg-title">${g.title}</div><ol>${g.steps.map((s) => `<li>${s}</li>`).join('')}</ol><div class="jg-foot">${g.foot}</div></div>`;
}

function loadSeen(): Record<GuideRole, number> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Partial<Record<GuideRole, number>>;
    return { god: Number(v.god) || 0, giant: Number(v.giant) || 0 };
  } catch {
    return { god: 0, giant: 0 };
  }
}

/** Whether a player who has seen the card `seen` times on this side sees it again. */
export function showsGuide(seen: number): boolean {
  return seen < GUIDE_ROUNDS;
}

/**
 * The rules card for a player's first Jötunn rounds on each side: a drawing
 * of the giant with its weak points, and the three things to do. It shows
 * from the round's countdown until a few seconds into the fight, at the left,
 * clear of the giant's bar and the camera's opening shot.
 */
export class JotunnGuide {
  private readonly root = document.createElement('div');
  private shown = false;
  private role: GuideRole | null = null;

  constructor() {
    this.root.className = 'jg-card';
    document.body.appendChild(this.root);
  }

  /** A round starts with the player on this side: the card, if they are still new to it. */
  start(role: GuideRole): void {
    const seen = loadSeen();
    if (!showsGuide(seen[role])) {
      this.role = null;
      this.toggle(false);
      return;
    }
    seen[role]++;
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch {
      /* storage unavailable: it shows again next time */
    }
    this.root.innerHTML = guideHtml(role);
    this.role = role;
  }

  frame(phase: JotunnPhase, timer: number): void {
    if (phase === 'fight' && timer >= GUIDE_FIGHT) this.role = null;
    this.toggle(this.role !== null && (phase === 'countdown' || phase === 'fight'));
  }

  private toggle(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.root.classList.toggle('show', on);
  }
}
