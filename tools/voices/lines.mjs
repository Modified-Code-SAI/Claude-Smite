// Prints the gods' lines (src/audio/godLines.ts) as JSON for speak.py. Node 22.18+ reads the .ts directly.
import { GOD_LINES } from '../../src/audio/godLines.ts';
process.stdout.write(JSON.stringify(GOD_LINES));
