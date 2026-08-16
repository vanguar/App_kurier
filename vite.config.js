import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Build stamp shown in Settings so the user can confirm which version is live.
  define: {
    __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'),
  },
  // GitHub Pages project site lives under /<repo>/. A fixed base is required so the
  // service worker scope and PWA manifest resolve correctly. If you rename the repo,
  // update this to match "/<new-repo-name>/".
  base: '/App_kurier/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      // Tesseract loads WASM + language data at runtime; allow larger precache entries.
      workbox: {
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,wasm}'],
        runtimeCaching: [
          {
            // Tesseract core + traineddata fetched from CDN on first use -> cache for offline.
            urlPattern: /^https:\/\/.*\.(?:wasm|traineddata\.gz|js)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tesseract-assets',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
        ],
      },
      manifest: {
        name: 'Kurier — Delivery Helper',
        short_name: 'Kurier',
        description: 'OCR addresses, match parcels + mail, offline route optimization',
        theme_color: '#0b5cff',
        background_color: '#f2f4f7',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
    }),
  ],
});
