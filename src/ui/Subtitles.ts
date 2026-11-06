import { hex, paletteFor } from '../combat/palette';
import { onCaption, type Caption } from '../settings/captions';
import { onSettings, settings } from '../settings/store';
import './subtitles.css';

/** Lines on screen at once; an older one gives way to a new one. */
const MAX_LINES = 3;
/** Seconds a line stays after it has been said, so it can be read. */
const LINGER = 1.6;
const MIN_SECONDS = 2.2;

/** Brighten a god's spell color so its name reads on the dark box. */
function nameColor(god: string | undefined, mood: Caption['mood']): string {
  if (!god) return mood === 'bad' ? '#ff9a86' : mood === 'good' ? '#ffe08a' : '#e7c27a';
  const c = paletteFor(god).vfx;
  const mix = (s: number) => Math.round(((c >> s) & 255) * 0.55 + 255 * 0.45);
  return hex((mix(16) << 16) | (mix(8) << 8) | mix(0));
}

/**
 * Subtitles for everything spoken: the herald's calls and the gods' and the
 * giant's lines. Off unless the player turns them on (Settings >
 * Accessibility), with the size, the box behind them and speaker names
 * theirs to choose.
 */
export function mountSubtitles(): void {
  const root = document.createElement('div');
  root.className = 'subs';
  root.setAttribute('aria-live', 'polite');
  document.body.appendChild(root);
  const lines: { el: HTMLElement; text: string; timer: ReturnType<typeof setTimeout> }[] = [];

  const drop = (l: (typeof lines)[number]) => {
    const i = lines.indexOf(l);
    if (i >= 0) lines.splice(i, 1);
    clearTimeout(l.timer);
    l.el.classList.add('gone');
    setTimeout(() => l.el.remove(), 300);
  };

  onSettings((s) => {
    root.dataset.size = s.subtitleSize;
    root.style.setProperty('--sub-bg', String(s.subtitleBackground));
    root.classList.toggle('no-names', !s.speakerNames);
    if (!s.subtitles) for (const l of [...lines]) drop(l);
  });

  onCaption((c) => {
    if (!settings().subtitles) return;
    const text = `${c.speaker}: ${c.text}`;
    const seconds = Math.max(MIN_SECONDS, c.seconds + LINGER);
    // the same line again (two towers at once) only stays longer
    const same = lines.find((l) => l.text === text);
    if (same) {
      clearTimeout(same.timer);
      same.timer = setTimeout(() => drop(same), seconds * 1000);
      return;
    }
    const el = document.createElement('div');
    el.className = 'sub-line';
    const who = document.createElement('b');
    who.className = 'sub-who';
    who.textContent = c.speaker;
    who.style.color = nameColor(c.god, c.mood);
    const said = document.createElement('span');
    said.textContent = c.text;
    el.append(who, said);
    root.appendChild(el);
    const line = { el, text, timer: setTimeout(() => drop(line), seconds * 1000) };
    lines.push(line);
    while (lines.length > MAX_LINES) drop(lines[0]!);
  });
}
