import type { Side } from '../game/combatant';
import type { RushLine } from '../sim/Rush';

export type RushAwardKey = 'mvp' | 'playmaker' | 'wall';

export interface RushAward<U> {
  key: RushAwardKey;
  title: string;
  unit: U;
  /** What earned it, e.g. "2 goals · 1 assist". */
  stat: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The first two things this god did any of, e.g. "2 goals · 1 assist". */
const parts = (bits: [number, string, string?][]) =>
  bits
    .filter(([n]) => n > 0)
    .slice(0, 2)
    .map(([n, one, many]) => plural(n, one, many))
    .join(' · ');

const AWARDS: { key: RushAwardKey; title: string; winners?: boolean; score: (l: RushLine) => number; stat: (l: RushLine) => string }[] = [
  {
    // (steals are common, every loose relic picked up counts, so they weigh little)
    key: 'mvp',
    title: 'MVP',
    winners: true,
    score: (l) => l.goals * 4 + l.assists * 2.5 + l.tackles * 0.8 + l.steals * 0.4 + l.passes * 0.15,
    stat: (l) => parts([[l.goals, 'goal'], [l.assists, 'assist'], [l.tackles, 'tackle'], [l.steals, 'steal'], [l.passes, 'pass', 'passes']]),
  },
  {
    key: 'playmaker',
    title: 'Playmaker',
    score: (l) => l.passes + l.assists * 2,
    stat: (l) => parts([[l.passes, 'pass', 'passes'], [l.assists, 'assist']]),
  },
  {
    key: 'wall',
    title: 'The Wall',
    score: (l) => l.tackles + l.steals,
    stat: (l) => parts([[l.tackles, 'tackle'], [l.steals, 'steal']]),
  },
];

/**
 * Relic Rush's end-of-match awards: the MVP (always from the winning team,
 * as in most sports games), the Playmaker (passes and assists) and the Wall
 * (tackles and steals). Each goes to a different god where it can, and only
 * to one who earned it; ties go to the winning team, then to whoever was
 * dazed less.
 */
export function rushAwards<U extends { team: string }>(gods: readonly U[], lines: ReadonlyMap<U, RushLine>, winner: Side | null): RushAward<U>[] {
  const out: RushAward<U>[] = [];
  const taken = new Set<U>();
  for (const a of AWARDS) {
    const ranked = gods
      .filter((u) => lines.has(u) && a.score(lines.get(u)!) > 0 && (!a.winners || !winner || u.team === winner))
      .sort((x, y) => {
        const lx = lines.get(x)!;
        const ly = lines.get(y)!;
        return a.score(ly) - a.score(lx) || Number(y.team === winner) - Number(x.team === winner) || lx.dazed - ly.dazed;
      });
    const best = ranked.find((u) => !taken.has(u)) ?? ranked[0];
    if (!best) continue;
    taken.add(best);
    out.push({ key: a.key, title: a.title, unit: best, stat: a.stat(lines.get(best)!) });
  }
  return out;
}
