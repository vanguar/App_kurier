import './styles.css';
import { start } from './ui/app.js';

const RUNNING = __BUILD__;

// Wipe every cache and service worker registration for this origin.
async function nuke() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (self.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) { /* ignore */ }
}

// Freshness gate: compare the running build with the deployed version.json.
// If the server is newer, nuke everything and hard-reload onto the fresh build.
// Returns false when a reload was triggered (caller should stop).
async function ensureFreshOrReload() {
  try {
    const url = `${import.meta.env.BASE_URL}version.json?ts=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return true;
    const { build } = await res.json();
    if (!build || build === RUNNING) return true;

    // Guard against a reload loop if the freshly served index is still stale.
    const key = 'kurier_reloaded_for';
    if (sessionStorage.getItem(key) === build) return true;
    sessionStorage.setItem(key, build);

    await nuke();
    location.reload();
    return false;
  } catch (e) {
    return true; // offline or blocked -> run from cache
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({
        immediate: true,
        onRegisteredSW(_swUrl, registration) {
          if (!registration) return;
          registration.update();
          setInterval(() => registration.update(), 30 * 1000);
        },
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    })
    .catch(() => {});
}

(async function boot() {
  const fresh = await ensureFreshOrReload();
  if (!fresh) return; // reloading onto the new build
  registerServiceWorker();
  start();
})();
