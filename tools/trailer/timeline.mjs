// When everything in the trailer happens, in seconds. compose.html cuts the
// picture to it and score.ts lays the narration, music and effects on it.
// The music runs at 96 bpm from the title hit, so a bar is 2.5 s.

export const FPS = 30;
export const LENGTH = 20;
export const TITLE = 0.3;
export const BAR = 2.5;

/** Narration line starts (ids from script.json). */
export const VOICE = {
  choose: 2.0,
  build: 6.6,
  modes: 10.8,
  friends: 15.9,
  ascend: 18.5,
};

/** Hero clips: which god, and when its cut starts (a fifth of a bar and more each). */
export const HEROES = ['zeus', 'thor', 'odin', 'loki', 'anubis'].map((god, i) => ({ god, at: 2.3 + 0.8 * i }));
/** The skill bar, then the playstyle trees. */
export const SKILLS = 6.3;
export const TREES = 8.4;
/** The mode montage: Conquest first, then a cut per mode. */
export const MODES = [
  { shot: 'cqClash', name: 'CONQUEST', sub: '5V5 · THREE LANES', at: 10.5 },
  { shot: 'mdClash', name: 'TEMPLE CLASH', sub: '3V3 · KING OF THE HILL', at: 11.6 },
  { shot: 'mdRush', name: 'RELIC RUSH', sub: '3V3 · A SPORT OF THE GODS', at: 12.4 },
  { shot: 'mdDescent', name: 'UNDERWORLD DESCENT', sub: 'CO-OP · FIFTEEN CHAMBERS', at: 13.2 },
  { shot: 'mdJotunn', name: 'THE JÖTUNN', sub: 'FIVE GODS · ONE GIANT', at: 14.0 },
  { shot: 'mdSiege', name: 'TEMPLE SIEGE', sub: 'CO-OP · ENDLESS WAVES', at: 14.8 },
];
export const FRIENDS = 15.6;

/** The final hit, on "Ascend". */
export const FINALE = VOICE.ascend;
