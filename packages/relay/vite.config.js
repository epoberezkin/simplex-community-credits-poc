import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5175 },
  build: { target: 'esnext' },
  optimizeDeps: { include: ['ethers'] },
});
