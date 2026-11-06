/**
 * What the gods say: original lines, spoken with Kokoro TTS (an Apache-2.0
 * open model) by tools/voices/speak.py into public/voices/<god>/<kind>-<n>.mp3.
 * Edit a line here, then run the script again for that god.
 */

export type LineKind = 'select' | 'start' | 'kill' | 'streak' | 'ult' | 'death' | 'respawn' | 'taunt' | 'omw';

export const LINE_KINDS: readonly LineKind[] = ['select', 'start', 'kill', 'streak', 'ult', 'death', 'respawn', 'taunt', 'omw'];

export const GOD_LINES: Record<string, Record<LineKind, readonly string[]>> = {
  // a king who expects the sky to agree with him
  zeus: {
    select: ['The sky answers to me.'],
    start: ['Olympus is watching. Let us give it a show.', 'Clouds gather. So do I.'],
    kill: ['Struck down.', 'You should have bowed.', 'The sky has judged you.'],
    streak: ['Who else would argue with the storm?', 'On your knees. All of you.'],
    ult: ['Let the heavens fall!', 'Storm, obey me!'],
    death: ['Impossible...', 'The sky... will remember this.'],
    respawn: ['A king returns.', 'The storm rolls back in.'],
    taunt: ['I have thrown bolts at better than you before breakfast.', 'Look up. That is where I will be.', 'Pray. It might even help.'],
    omw: ['On my way.', 'Thunder is coming.'],
  },
  // a brawler who is having the time of his life
  thor: {
    select: ['The hammer is hungry!'],
    start: ['What a fine day for a brawl!', "Let's make some noise!"],
    kill: ['Down you go!', "Ha! You felt that one, didn't you?", 'Another one for the songs!'],
    streak: ['Keep them coming!', 'Is that all of you?'],
    ult: ['Here comes the hammer!', 'Thunder, with me!'],
    death: ['Not... like this.', 'Save me a seat... in the hall.'],
    respawn: ['Round two!', 'Back, and angrier.'],
    taunt: ['I have fought frost giants with better footwork.', "Come closer. The hammer won't bite. Much.", 'You hit like a summer breeze.'],
    omw: ['On my way!', 'Coming! Save some for me!'],
  },
  // grave and patient; he has seen how this ends
  odin: {
    select: ['I have seen how this ends.'],
    start: ['Every war is a lesson. Learn it quickly.', 'The ravens fly. So it begins.'],
    kill: ['Your thread is cut.', 'As it was foreseen.', 'Valhalla will not open for you.'],
    streak: ['The ravens feast tonight.', 'None can stand against me.'],
    ult: ['Rise, my spears!', 'Stand within the ring, and fall.'],
    death: ['Even I... did not see this.', 'My thread... unravels.'],
    respawn: ['Death is a door. I know it well.', 'I return, and I am wiser.'],
    taunt: ['I gave an eye for wisdom. You gave nothing, and it shows.', 'My ravens find you dull.', 'You fight like a riddle with no answer.'],
    omw: ['I am coming.', 'Hold fast. Odin comes.'],
  },
  // the trickster, enjoying every second of it
  loki: {
    select: ['Oh, this will be fun.'],
    start: ["Let's see who trusts whom.", 'Smile, everyone. It makes the knife go in easier.'],
    kill: ['Surprise!', "Didn't see that coming? Nobody ever does.", 'Hush now. Sleep.'],
    streak: ["I'm on a roll, aren't I?", "Who's next? Don't all volunteer at once."],
    ult: ['Behind you.', 'Now you see me...'],
    death: ['That was cheating! How rude.', 'Well. That was... unplanned.'],
    respawn: ['Did you miss me?', "I'm back, and still lovely."],
    taunt: ["I'd say good fight, but I lie for a living.", 'Over here! No, over here!', "You're so easy to fool. It's charming, really."],
    omw: ['On my way. Probably.', "Coming. Try not to die before I get there."],
  },
  // slow, dry and final, like the tomb
  anubis: {
    select: ['The scales await.'],
    start: ['All things come to me, in time.', 'The sands are shifting.'],
    kill: ['Weighed, and found wanting.', 'Your heart is heavy.', 'The underworld claims you.'],
    streak: ['The dead march behind me.', 'So many hearts to weigh.'],
    ult: ['Judgment!', 'Feel the weight of the dead.'],
    death: ['Death... cannot hold me.', 'I will return... as all things do.'],
    respawn: ['I know the road back from death.', 'The tomb could not keep me.'],
    taunt: ['I have embalmed kings. You will not take long.', 'Your heart is lighter than a feather. That is not a compliment.', 'Run. The sand remembers your steps.'],
    omw: ['I am coming.', 'Death is on its way.'],
  },
  // gentle and patient, never cruel: he is the death that comes kindly
  thanatos: {
    select: ['Hush now. I am here.'],
    start: ['Every road ends with me. Let us walk it gently.', 'Sleep keeps my left hand. I keep the rest.'],
    kill: ['Rest now.', 'There. No more pain.', 'Close your eyes.'],
    streak: ['So many lanterns going out.', 'The ferryman will be busy tonight.'],
    ult: ['Sleep, all of you.', 'Lie down, and do not wake.'],
    death: ['Even I... may rest...', 'My brother... will keep my place...'],
    respawn: ['Death does not stay dead.', 'I was never far away.'],
    taunt: ['Do not fight it. Nobody ever wins.', 'I have met kings and beggars. You are not special.', 'You are tired. I can tell.'],
    omw: ['I am coming, softly.', 'On black wings. Wait for me.'],
  },
};

/** Moments only the Jötunn speaks to, besides its waking, its kills and its fall. */
export type GiantLineKind = 'brazier' | 'kneel' | 'shrine' | 'stand' | 'win';

/** Anything a voice may say: a god's moment or the giant's. */
export type VoiceKind = LineKind | GiantLineKind;

export const GIANT_KINDS = ['start', 'kill', 'streak', 'brazier', 'kneel', 'shrine', 'stand', 'win', 'death', 'select'] as const satisfies readonly VoiceKind[];

/**
 * The Jötunn: old as the ice, slow, and contemptuous of the little gods
 * until they bring it to its knees. Said in a voice deeper than any god's,
 * and heard across the whole temple.
 */
export const GIANT_LINES: Record<(typeof GIANT_KINDS)[number], readonly string[]> = {
  start: ['Little gods. Your fires end tonight.', 'I have slept for an age. No more.', 'The long night wakes.'],
  kill: ['Crushed, like the rest.', 'Like frost underfoot.', 'Stay down, little god.'],
  streak: ['Who is next to break?', 'Your gods grow few.'],
  brazier: ['Another fire dies.', 'Your light goes dark.', 'Burn out, little flame.'],
  kneel: ['You dare?', 'I will rise!'],
  shrine: ['The old cold answers me.', 'This power is mine.'],
  stand: ['Enough! Now face the true winter!', 'I will not fall to insects!'],
  win: ['The long winter begins.', 'Your temple is mine to freeze.'],
  death: ['The winter... ends...', 'Even the mountain... falls.'],
  // on the title screen, when the player picks the giant (last, so the others keep their recordings)
  select: ['I am the winter that walks.', 'Bring me their fires.', 'Wake me, and the cold wakes with me.'],
};

/** Everyone with lines, by god id: the gods, and the Jötunn. */
export const VOICE_LINES: Record<string, Partial<Record<VoiceKind, readonly string[]>>> = { ...GOD_LINES, jotunn: GIANT_LINES };

/** Where a line's recording is served from. */
export function lineUrl(base: string, god: string, kind: VoiceKind, n: number): string {
  return `${base}voices/${god}/${kind}-${n + 1}.mp3`;
}
