import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Single build stamp used both in the bundle (__BUILD__) and in version.json,
// so the client can detect "server has a newer build than I'm running".
const BUILD = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';

// Emit a tiny, never-precached version.json for the client-side freshness gate.
function emitVersion() {
  return {
    name: 'emit-version',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD }) });
    },
  };
}

export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(BUILD),
  },
  // GitHub Pages project site lives under /<repo>/. A fixed base is required so the
  // service worker scope and PWA manifest resolve correctly. If you rename the repo,
  // update this to match "/<new-repo-name>/".
  base: '/App_kurier/',
  plugins: [
    emitVersion(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      workbox: {
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,wasm}'], // note: version.json intentionally excluded
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
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
          {
            // Bundled district index (public/district-index.json). NOT precached (would
            // bloat install by ~7 MB); fetched on the one tap that loads it, then cached
            // so a re-load works offline.
            urlPattern: /district-index\.json$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'district-index',
              expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 180 },
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
