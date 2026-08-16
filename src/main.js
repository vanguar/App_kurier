import './styles.css';
import { start } from './ui/app.js';

// Register the PWA service worker (offline support) — injected by vite-plugin-pwa.
if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  }).catch(() => {});
}

start();
