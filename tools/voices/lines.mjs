// Prints the gods' and the Jötunn's lines (src/audio/godLines.ts) as JSON for speak.py. Node 22.18+ reads the .ts directly.
import { VOICE_LINES } from '../../src/audio/godLines.ts';
process.stdout.write(JSON.stringify(VOICE_LINES));
