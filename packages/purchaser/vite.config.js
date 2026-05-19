import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  server: { port: 5173 },
  build: { target: 'esnext' },
  resolve: {
    // No alias — use the package's `exports` map via the workspace symlink.
  },
  optimizeDeps: {
    // snarkjs ships ESM but pulls heavy deps (ffjavascript) — let Vite prebundle.
    include: ['snarkjs', 'ethers'],
  },
});
