import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import renderer from 'vite-plugin-electron-renderer';
import { fileURLToPath, URL } from 'node:url';

const alias = {
  '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
  '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
};

// `root` is src/renderer, so the electron entries must be absolute or rollup resolves them
// relative to the renderer root.
const abs = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const outRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: { alias },
  root: abs('./src/renderer'),
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: abs('./src/main/index.ts'),
        vite: {
          resolve: { alias },
          build: {
            outDir: abs('./dist-electron/main'),
            rollupOptions: {
              external: ['electron', 'castv2-client', 'bonjour-service', 'ffmpeg-static'],
            },
          },
        },
      },
      preload: {
        input: abs('./src/preload/index.ts'),
        vite: {
          resolve: { alias },
          build: {
            outDir: abs('./dist-electron/preload'),
            rollupOptions: { external: ['electron'] },
          },
        },
      },
    }),
    renderer(),
  ],
});
