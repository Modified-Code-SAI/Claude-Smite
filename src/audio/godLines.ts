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
};

/** Where a line's recording is served from. */
export function lineUrl(base: string, god: string, kind: LineKind, n: number): string {
  return `${base}voices/${god}/${kind}-${n + 1}.mp3`;
}
