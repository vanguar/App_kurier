import './styles.css';
import { start } from './ui/app.js';

// Register the PWA service worker with robust auto-update, so an installed
// (home-screen) app doesn't get stuck on an old cached version.
if ('serviceWorker' in navigator) {
  import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({
        immediate: true,
        onRegisteredSW(_swUrl, registration) {
          if (!registration) return;
          // Check for a new deployment right away and every 30s while open.
          registration.update();
          setInterval(() => registration.update(), 30 * 1000);
        },
      });

      // When a new service worker takes control, reload once to show fresh UI.
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    })
    .catch(() => {});
}

start();
