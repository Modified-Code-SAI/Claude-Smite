import type { Rush } from '../sim/Rush';

/**
 * Relic Rush's crowd chanting through a tight finish: both ends stamping and
 * clapping one pattern, a shout to close each phrase. The sound and the
 * stands keep to the same wall clock, so slow motion, a dropped frame or a
 * loop started late never knock the stamping out of time with what you hear.
 * (No imports but a type: the sound bank's worker builds the loop from this.)
 */
export const CHANT = {
  bpm: 100,
  /** Beats in the pattern (two bars of four). */
  beats: 8,
  /** Where the feet stamp, in beats from the top of the pattern. */
  stomps: [0, 2, 2.5, 4, 6, 6.5],
  /** Where the hands clap. */
  claps: [1, 3, 5],
  /** The shout that ends the pattern. */
  shout: 7,
  /** The sound plays the pattern this many times over, each hit made fresh, so the repeat isn't heard. */
  takes: 2,
  /** Seconds left when a game within a goal starts the stands chanting. */
  late: 45,
};

/** Seconds in a beat. */
export const CHANT_BEAT = 60 / CHANT.bpm;
/** Seconds the chant's sound lasts before it wraps. */
export const CHANT_LOOP = CHANT.beats * CHANT.takes * CHANT_BEAT;

/**
 * Whether Relic Rush is tight enough for the stands to chant: golden-relic
 * overtime, four apiece, or a game within a goal in its last 45 s. Never over
 * a goal's roar, nor once it's won.
 */
export function chanting(r: Rush): boolean {
  if (r.winner || r.phase === 'goal' || r.phase === 'over') return false;
  return r.overtime || r.matchPoint === 'both' || (r.clock <= CHANT.late && Math.abs(r.score.order - r.score.chaos) <= 1);
}

/** Seconds into the chant's sound at wall-clock `seconds` (where a loop starting now should start from). */
export function chantAt(seconds: number): number {
  const s = seconds % CHANT_LOOP;
  return s < 0 ? s + CHANT_LOOP : s;
}

/**
 * How far an end of the crowd breaks off the chant (0 to 1) as it gets to
 * its feet to cheer a run at the gate. The stands' shader mirrors it as
 * smoothstep(0.45, 0.8, heat).
 */
export function chantBreak(heat: number): number {
  const x = Math.min(1, Math.max(0, (heat - 0.45) / 0.35));
  return x * x * (3 - 2 * x);
}

/** Beats from `from` forward to `to`, round the pattern. */
const ahead = (from: number, to: number) => (((to - from) % CHANT.beats) + CHANT.beats) % CHANT.beats;

/**
 * How the stands move at wall-clock `seconds`: `bob` (0 to 1) lifts between
 * stamps and lands on each, a shorter gap a smaller hop; `pump` (0 to 1, more
 * for the shout) peaks with each clap, arms thrust up together.
 */
export function chantMotion(seconds: number, out: { bob: number; pump: number }): void {
  const b = chantAt(seconds) / CHANT_BEAT;
  let since = CHANT.beats;
  let until = CHANT.beats;
  for (const s of CHANT.stomps) {
    since = Math.min(since, ahead(s, b));
    until = Math.min(until, ahead(b, s) || CHANT.beats);
  }
  const gap = since + until;
  out.bob = Math.sin((since / gap) * Math.PI) * Math.min(1, gap);
  let pump = 0;
  for (const c of CHANT.claps) {
    const d = Math.min(ahead(c, b), ahead(b, c)) / 0.2;
    pump = Math.max(pump, Math.exp(-d * d));
  }
  const d = Math.min(ahead(CHANT.shout, b), ahead(b, CHANT.shout)) / 0.3;
  out.pump = Math.max(pump, 1.4 * Math.exp(-d * d));
}
