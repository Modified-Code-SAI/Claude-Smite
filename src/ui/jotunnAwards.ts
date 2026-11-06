import type { JotunnPlayer } from '../sim/Jotunn';

export type JotunnAwardKey = 'slayer' | 'breaker' | 'giant';

export interface JotunnAward<P> {
  key: JotunnAwardKey;
  title: string;
  player: P;
  /** What earned it, e.g. "34k Might · felled it". */
  stat: string;
}

type Line = Pick<JotunnPlayer, 'tally' | 'giantRound'>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Might as the end screen shows it: 860, 4.2k, 34k. */
export function mightText(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

/** Seconds as a clock: 2:41. */
export function clockText(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

const felledText = (n: number) => (n === 1 ? 'felled it' : `felled it ${n} times`);

/**
 * Rounds as the giant, best first: a win, then braziers smashed; between two
 * wins the quicker, between two losses the one that took down more gods (then
 * the longer stand).
 */
function giantOrder(a: Line, b: Line): number {
  const x = a.giantRound!;
  const y = b.giantRound!;
  const takedowns = b.tally.takedowns - a.tally.takedowns;
  const time = x.won ? x.time - y.time : y.time - x.time;
  return Number(y.won) - Number(x.won) || y.braziers - x.braziers || (x.won ? time || takedowns : takedowns || time);
}

/**
 * Jötunn's end-of-match awards: the Giant Slayer (most Might torn from the
 * giant as a god) and the Breaker (most weak points broken), each to a
 * different player where it can, and the Mightiest Jötunn (the best round as
 * the giant, see giantOrder), given only when more than one player took a
 * turn as it. Each goes only to someone who earned it.
 */
export function jotunnAwards<P extends Line>(players: readonly P[]): JotunnAward<P>[] {
  const out: JotunnAward<P>[] = [];
  const slayers = players.filter((p) => p.tally.might > 0).sort((a, b) => b.tally.might - a.tally.might || b.tally.felled - a.tally.felled || b.tally.breaks - a.tally.breaks);
  const slayer = slayers[0];
  if (slayer) {
    const t = slayer.tally;
    const more = t.felled > 0 ? felledText(t.felled) : t.breaks > 0 ? `${plural(t.breaks, 'weak point')} broken` : '';
    out.push({ key: 'slayer', title: 'Giant Slayer', player: slayer, stat: [`${mightText(t.might)} Might`, more].filter(Boolean).join(' · ') });
  }
  const breakers = players.filter((p) => p.tally.breaks > 0).sort((a, b) => b.tally.breaks - a.tally.breaks || b.tally.might - a.tally.might);
  const breaker = breakers.find((p) => p !== slayer) ?? breakers[0];
  if (breaker) {
    const t = breaker.tally;
    out.push({ key: 'breaker', title: 'Breaker', player: breaker, stat: [`${plural(t.breaks, 'weak point')} broken`, t.felled > 0 ? felledText(t.felled) : ''].filter(Boolean).join(' · ') });
  }
  const giants = players.filter((p) => p.giantRound);
  const best = giants.length > 1 ? [...giants].sort(giantOrder)[0] : undefined;
  const r = best?.giantRound;
  if (best && r && (r.won || r.braziers > 0 || best.tally.takedowns > 0)) {
    const bits = [r.won ? `won in ${clockText(r.time)}` : '', r.braziers > 0 ? plural(r.braziers, 'brazier') : '', best.tally.takedowns > 0 ? plural(best.tally.takedowns, 'takedown') : ''];
    out.push({ key: 'giant', title: 'Mightiest Jötunn', player: best, stat: bits.filter(Boolean).slice(0, 2).join(' · ') });
  }
  return out;
}
