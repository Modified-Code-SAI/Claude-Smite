/**
 * Spoken lines as text, for subtitles: the herald and the voice engine say
 * what they are saying here, and the subtitle box (src/ui/Subtitles.ts)
 * shows it when the player has subtitles on. No DOM here, so the audio code
 * stays testable.
 */

export interface Caption {
  /** Who is talking: 'Herald', a god's name. */
  speaker: string;
  text: string;
  /** How long the line takes to say, seconds. */
  seconds: number;
  /** The god or giant speaking, for the speaker's color. */
  god?: string;
  /** The herald's mood: good news gold, bad news red. */
  mood?: 'good' | 'bad' | 'neutral' | 'epic';
}

const listeners: ((c: Caption) => void)[] = [];

export function onCaption(fn: (c: Caption) => void): void {
  listeners.push(fn);
}

export function caption(c: Caption): void {
  for (const f of listeners) f(c);
}

/** A god id as a name: 'zeus' -> 'Zeus', the giant -> 'The Jötunn'. */
export function speakerName(god: string): string {
  if (god === 'jotunn') return 'The Jötunn';
  return god.charAt(0).toUpperCase() + god.slice(1);
}
