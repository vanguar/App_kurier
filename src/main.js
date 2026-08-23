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

// Compare the running build with the deployed version.json. If the server is
// newer, nuke everything and hard-reload onto the fresh build.
async function checkFresh() {
  try {
    const url = `${import.meta.env.BASE_URL}version.json?ts=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return;
    const { build } = await res.json();
    if (!build || build === RUNNING) return;

    // Loop guard: don't re-nuke for the same build if the served index stays stale.
    const key = 'kurier_reloaded_for';
    if (sessionStorage.getItem(key) === build) return;
    sessionStorage.setItem(key, build);

    await nuke();
    location.reload();
  } catch (e) { /* offline -> run from cache */ }
}

// Throttle so returning to the app fires at most one check every few seconds.
let lastCheck = 0;
function checkFreshThrottled() {
  const now = Date.now();
  if (now - lastCheck < 4000) return;
  lastCheck = now;
  checkFresh();
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

// Re-check for a new version whenever the app comes to the foreground
// (switch back to it / unlock) — so "swap to the app" = latest version.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkFreshThrottled();
});
window.addEventListener('focus', checkFreshThrottled);
window.addEventListener('pageshow', (e) => { if (e.persisted) checkFreshThrottled(); });

(function boot() {
  // Paint immediately. Previously boot() awaited the version.json fetch BEFORE the first
  // render, which left a blank white screen for as long as that request took on slow mobile
  // networks. The freshness check now runs in the background: checkFresh() still compares the
  // deployed build, nukes caches and reloads onto it when newer, and is guarded against reload
  // loops — the only change is that the first paint no longer waits for the network.
  start();
  registerServiceWorker();
  lastCheck = Date.now();
  checkFresh();
})();
