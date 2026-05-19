import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5174 },
  build: { target: 'esnext' },
  optimizeDeps: { include: ['snarkjs', 'ethers'] },
  worker: { format: 'es' },
});
