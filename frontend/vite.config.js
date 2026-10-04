import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const powersyncDir = path.join(__dirname, 'public', '@powersync');
const powersyncPrecache = fs.existsSync(powersyncDir)
  ? fs
      .readdirSync(powersyncDir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => ({ url: `/@powersync/${name}`, revision: null }))
  : [];

export default defineConfig({
  optimizeDeps: { exclude: ['@powersync/web', '@journeyapps/wa-sqlite'] },
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: {
        enabled: true,
        type: 'module',
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/],
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,wasm}'],
        additionalManifestEntries: powersyncPrecache,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ sameOrigin, url }) =>
              sameOrigin &&
              !url.pathname.startsWith('/api') &&
              !url.hostname.includes('8080'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'app-shell-runtime',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 256, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
