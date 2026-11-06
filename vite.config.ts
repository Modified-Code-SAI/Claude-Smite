import { defineConfig } from 'vite';
import { meshoptModels } from './scripts/meshopt.mjs';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    // sounds.html auditions every sound in the game
    rollupOptions: { input: { main: 'index.html', sounds: 'sounds.html' } },
  },
  server: { host: true },
  // the god models ship meshopt-compressed (GLTFLoader decodes them); public/ keeps the plain files
  plugins: [meshoptModels()],
});
