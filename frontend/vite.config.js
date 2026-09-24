import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: { exclude: ['@powersync/web'] },
  worker: { format: 'es' },
});
