/**
 * The settings that act on the page as a whole, from the first frame of the
 * title screen: team colors, the HUD's size, what the HUD shows, the key
 * names, and the sound while the game is in the background. The rest (the
 * camera, the renderer) is applied by main.ts once those exist.
 */

import type { AudioEngine } from '../audio/AudioEngine';
import { watchKeyLabels } from './controls';
import { onSettings, settings } from './store';
import { applyTeamColors } from './teamColors';

export function applyPageSettings(audio: AudioEngine): void {
  const html = document.documentElement;
  // silence in another tab, or while another window has the focus
  const background = () => audio.setBackground(settings().muteInBackground && (document.hidden || !document.hasFocus()));
  document.addEventListener('visibilitychange', background);
  window.addEventListener('blur', background);
  window.addEventListener('focus', background);
  onSettings((s, changed) => {
    if (changed.has('teamColors')) applyTeamColors(s.teamColors);
    html.style.setProperty('--ui-scale', String(s.uiScale));
    html.classList.toggle('st-no-fps', !s.showFps);
    html.classList.toggle('st-no-dmg', !s.damageNumbers);
    html.classList.toggle('st-calm', s.reduceFlashes);
    if (changed.has('muteInBackground')) background();
  });
  watchKeyLabels();
}
