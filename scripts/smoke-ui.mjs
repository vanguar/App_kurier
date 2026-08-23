// Headless UI smoke test: mounts the real app in happy-dom (with fake-indexeddb) and
// walks the main flows, so a render-time crash (white screen) fails CI instead of shipping.
// We bundle the UI with esbuild (defining Vite-only globals) and run it under a DOM shim.
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import 'fake-indexeddb/auto';
import { pathToFileURL } from 'node:url';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 1) Bundle app.js (+ a couple of db helpers to seed state) for Node/happy-dom.
const result = await build({
  stdin: {
    contents: `
      export { start } from './src/ui/app.js';
      export { saveSettings, putPoint } from './src/core/db.js';
    `,
    resolveDir: process.cwd(),
    loader: 'js',
  },
  bundle: true, format: 'esm', platform: 'browser', write: false,
  define: {
    __BUILD__: '"smoke"',
    'import.meta.env': '{"BASE_URL":"/","VITE_ORS_PROXY_URL":"","DEV":false,"PROD":true,"MODE":"test"}',
  },
  logLevel: 'silent',
});
const tmp = join(tmpdir(), `kurier-smoke-${Date.now()}.mjs`);
writeFileSync(tmp, result.outputFiles[0].text);

// 2) Minimal browser environment.
const win = new Window({ url: 'https://localhost/App_kurier/#/points' });
const g = globalThis;
for (const k of ['window', 'document', 'navigator', 'location', 'history', 'HTMLElement',
  'Node', 'customElements', 'CSS', 'getComputedStyle', 'Event', 'CustomEvent', 'MutationObserver']) {
  try { g[k] = win[k]; } catch { /* readonly on some builds */ }
}
g.window = win; g.self = win;
g.requestAnimationFrame = (cb) => setTimeout(cb, 0);
g.cancelAnimationFrame = () => {};
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
g.matchMedia = win.matchMedia;
g.fetch = async () => { throw new Error('network disabled in smoke test'); };
document.body.innerHTML = '<div id="app"></div>';

const asyncErrors = [];
process.on('unhandledRejection', (e) => asyncErrors.push(String(e && e.stack || e)));

const mod = await import(pathToFileURL(tmp).href);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hashTo = (h) => { location.hash = h; win.dispatchEvent(new win.Event('hashchange')); };

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '\n    ', e && e.stack || e); }
}

await check('seed onboarded settings', async () => {
  await mod.saveSettings({ onboarded: true, ocrConsent: true, language: 'ru', onlineGeocode: false,
    base: { address: { raw: 'Marktplatz 1' }, coords: { lat: 53.9, lng: 13.0 } } });
});
await check('#/points renders (empty state, not white)', async () => {
  location.hash = '#/points';
  await mod.start();
  await wait(50); // render() kicks off async renderPoints without awaiting it
  const app = document.getElementById('app');
  if (!app.children.length) throw new Error('#app is empty (white screen)');
  if (!app.querySelector('.points-empty')) throw new Error('.points-empty missing');
});
await check('#/import renders (2x2 type grid + segment)', async () => {
  hashTo('#/import'); await wait(40);
  if (!document.querySelector('.typegrid')) throw new Error('.typegrid missing');
  if (!document.querySelector('.import-actions')) throw new Error('pinned .import-actions missing');
});
await check('"?" toggles the explanation panel', async () => {
  const hb = document.querySelectorAll('.hintbtn');
  if (hb.length < 2) throw new Error(`expected 2 hint buttons, got ${hb.length}`);
  hb[0].click(); await wait(30);
  if (!document.querySelector('.hintpanel')) throw new Error('.hintpanel did not open');
});
await check('manual entry -> review shows green "Add selected"', async () => {
  hashTo('#/import'); await wait(40);
  const input = document.querySelector('input.input');
  if (!input) throw new Error('manual input missing');
  input.value = 'Hauptstrasse 12, 17033 Neubrandenburg';
  const add = document.querySelector('.manual-row .addbtn');
  if (!add) throw new Error('manual Add button missing');
  add.click(); await wait(60);
  const commit = document.querySelector('#add-selected');
  if (!commit) throw new Error('#add-selected did not render');
  if (!commit.classList.contains('commit')) throw new Error('#add-selected should use the .commit colour');
});
await check('#/points renders a point card', async () => {
  await mod.putPoint({ id: 'p1', canonicalId: 'x', matchKey: 'x', createdAt: Date.now(),
    address: { raw: 'Hauptstr 1', display: 'Hauptstr 1', postcode: '17033', city: 'Neubrandenburg' },
    coords: { lat: 53.5, lng: 13.2 }, items: [{ id: 'i1', type: 'parcel', status: 'pending' }] });
  hashTo('#/points'); await wait(40);
  if (!document.querySelector('.point')) throw new Error('point card missing');
  if (!document.querySelector('.statsbar .stat-val')) throw new Error('counters missing');
});

await wait(60);
rmSync(tmp, { force: true });
if (asyncErrors.length) { console.log('\nAsync errors:'); asyncErrors.forEach((e) => console.log(' *', e)); }

if (fail || asyncErrors.length) {
  console.log(`\n✗ UI SMOKE FAILED — ${pass} passed, ${fail} failed, ${asyncErrors.length} async errors`);
  process.exit(1);
}
console.log(`\n✓ UI SMOKE PASS — ${pass} passed, 0 failed`);
process.exit(0);
