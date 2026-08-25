import { el, clear, toast } from './dom.js';
import { icon } from './icons.js';
import { t, setLang, getLang, resolveInitialLang, LANGS } from '../i18n/index.js';
import {
  getSettings, saveSettings, getPoints, putPoint, deletePoint, clearPoints,
  loadAddressIndex, indexCount, resetSettings,
  getRouteState, saveRouteState, migrateRouteState,
} from '../core/db.js';
import { parseAddress } from '../core/normalizer.js';
import { geocodeRaw, assessAddress, onlineGeocode, geocodeCenter, setGeoBounds, withinBounds, boundsActive } from '../core/geocode.js';
import { addItemAtAddress, makeItem, itemTypeCounts, pointStatus, aggregateCounts, migratePointsV2, sameScannedPlace } from '../core/matching.js';
import { computeRoute, orsOptimize, roadTrip, roadRoute } from '../core/route.js';
import { orderByRoute, reorderStopsFromSaved, loopMeters, routeGeoSig } from '../core/route-order.js';
import { autoResolveByNeighbors } from '../core/cluster.js';
import { navigationUrl, pointHasPostalAddress, pointNavOptions } from '../core/navigation.js';
import { recognize, cloudRecognize, splitAddresses, splitDeviceScreen, pickReceiverBlock, warmUp } from '../ocr/ocr.js';

let settings = null;
const app = document.getElementById('app');
// Public URL of our key-hiding Worker proxy. This value is safe to ship; the ORS API key is
// stored only as the Worker's ORS_API_KEY secret and never enters this bundle.
const ORS_PROXY_URL = (import.meta.env.VITE_ORS_PROXY_URL || '').trim();

// ---------- theme ----------
function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolved === 'dark' ? '#0f1319' : '#2f5bd6';
}

// ---------- install (Add to Home Screen) ----------
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (settings) render(); // reveal the Install button once available
});
window.addEventListener('appinstalled', () => { deferredPrompt = null; });

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
async function doInstall() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  render();
}
// Returns an install button (Android), an iOS hint, or null if already installed.
function installBlock() {
  if (isStandalone()) return null;
  if (deferredPrompt) {
    return el('button', { class: 'btn install big', text: '📲 ' + t('install_btn'), onclick: doInstall });
  }
  if (isIOS()) return el('p', { class: 'hint', text: t('install_ios') });
  return el('p', { class: 'hint', text: t('install_hint') });
}

// ---------- bootstrapping ----------
export async function start() {
  settings = await getSettings();
  const lang = resolveInitialLang(settings.language);
  setLang(lang);
  if (!settings.language) settings = await saveSettings({ language: lang });
  applyTheme(settings.theme);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'auto') applyTheme('auto');
  });
  window.addEventListener('hashchange', render);
  applyGeoBounds(); // restrict online geocoding to the saved search area
  // v2/v3 identity migration: backfill canonicalId + merge legacy duplicate points.
  try { await migratePointsV2(); } catch (e) { console.warn('point migration skipped:', e); }
  // Route history migration: fold the legacy per-point routeOrder into the unified routeState.
  try { await migrateRouteState(); } catch (e) { console.warn('route migration skipped:', e); }
  // The v3 DB upgrade drops the old address index (its key layout changed). If the user
  // already had points but the index is now empty, ask them to reload their district file.
  if (settings.onboarded) {
    try {
      const [pts, idx] = await Promise.all([getPoints(), indexCount()]);
      if (pts.length > 0 && idx === 0) toast(t('index_reload_hint'));
    } catch (e) { /* ignore */ }
  }
  if (!settings.onboarded) {
    renderOnboarding(0);
    return;
  }
  if (!location.hash) location.hash = '#/points';
  render();
}

// ---------- Onboarding wizard (first run): welcome -> Base -> scan ----------
function renderOnboarding(step) {
  clear(app);
  const wrap = el('div', { class: 'onboard' });
  app.appendChild(wrap);
  if (step === 0) onbWelcome(wrap);
  else onbBase(wrap);
}

function onbWelcome(wrap) {
  wrap.appendChild(el('div', { class: 'onb-logo', text: '📦🧭' }));
  wrap.appendChild(el('h1', { class: 'onb-title', text: t('onb_welcome_title') }));
  wrap.appendChild(el('p', { class: 'onb-text', text: t('onb_welcome_text') }));
  wrap.appendChild(el('label', { class: 'field-label center', text: t('onb_choose_lang') }));
  wrap.appendChild(
    el('div', { class: 'langgrid' },
      LANGS.map((l) =>
        el('button', {
          class: 'chip' + (getLang() === l.code ? ' on' : ''),
          onclick: async () => {
            setLang(l.code);
            settings = await saveSettings({ language: l.code });
            renderOnboarding(0);
          },
        }, l.label),
      ),
    ),
  );
  wrap.appendChild(el('button', {
    class: 'btn primary big', text: t('onb_start'),
    onclick: () => renderOnboarding(1),
  }));
  const ib = installBlock();
  if (ib) wrap.appendChild(ib);
}

function onbBase(wrap) {
  wrap.appendChild(el('p', { class: 'onb-step', text: t('onb_step', { n: 2, total: 2 }) }));
  wrap.appendChild(el('h1', { class: 'onb-title', text: t('onb_base_title') }));
  wrap.appendChild(el('p', { class: 'onb-text', text: t('onb_base_text') }));

  const input = el('input', {
    class: 'input', type: 'text',
    value: settings.base?.address?.raw || '',
    placeholder: t('settings_base_placeholder'),
  });
  wrap.appendChild(input);

  const cont = el('button', { class: 'btn primary big', text: t('onb_continue') });
  cont.addEventListener('click', async () => {
    const raw = input.value.trim();
    if (!raw) { input.focus(); return; }
    const coords = await resolveBaseCoords(raw);
    const parsed = parseAddress(raw);
    settings = await saveSettings({
      base: { address: { ...parsed }, coords },
      onboarded: true,
    });
    location.hash = '#/import'; // land on scanning next
    render();
  });
  wrap.appendChild(cont);

  wrap.appendChild(el('button', {
    class: 'link center', text: t('onb_back'),
    onclick: () => renderOnboarding(0),
  }));
}

// Apply the search-area limit to online geocoding from the saved settings. The centre is
// the user-typed town (settings.geoCenter) or, if none, the depot (base). No coords -> no
// limit (so we never accidentally block all geocoding).
function applyGeoBounds() {
  if (settings.geoLimit === false) { setGeoBounds(null); return; }
  const c = settings.geoCenter?.coords || settings.base?.coords;
  const r = Number(settings.geoRadiusKm) || 40;
  setGeoBounds(c && typeof c.lat === 'number' ? { lat: c.lat, lng: c.lng, radiusKm: r } : null);
}

// Fetch the district index bundled with the app (public/district-index.json) and load it
// into IndexedDB, then re-run identity migration so existing points canonicalize/merge.
// Shared by the Settings button and the Route-screen prompt. Returns the address count.
async function loadBundledDistrictIndex() {
  const res = await fetch(`${import.meta.env.BASE_URL}district-index.json`, { cache: 'force-cache' });
  if (!res.ok) throw new Error('http ' + res.status);
  const data = await res.json();
  const entries = Array.isArray(data) ? data : data.entries || [];
  const n = await loadAddressIndex(entries);
  await migratePointsV2().catch((e) => console.warn('point migration skipped:', e));
  return n;
}

// Resolve coordinates for the Base address. Try the local district index; if not
// found, keep the previously known depot coords when the address is unchanged
// (the depot often sits outside the delivery district the index covers).
async function resolveBaseCoords(raw) {
  const parsed = parseAddress(raw);
  const geo = await assessAddress(parsed);
  if (geo.coords) return geo.coords;
  const prev = settings.base;
  if (prev?.coords && prev.address?.raw === raw) return prev.coords;
  // Fall back to online geocoding (OpenStreetMap) so any typed depot gets coords.
  if ((settings.onlineGeocode !== false) && navigator.onLine) {
    const c = await onlineGeocode(parsed);
    if (c) return c;
  }
  return null;
}

const TYPE_LABELS = () => ({
  parcel: t('type_parcel'),
  magazine: t('type_magazine'),
  letter: t('type_letter'),
});
const TYPE_EMOJI = { parcel: '📦', magazine: '📖', letter: '✉️' };
// Lucide equivalents of the type emoji, for the redesigned Points screen (one line-icon set).
const TYPE_ICON = { parcel: 'package', magazine: 'book-open', letter: 'mail' };

// Scan MODES for the import selector. These are extraction modes, not item types:
// `device` (courier-device screen) still produces PARCEL items, just parsed differently.
// Both `parcel` and `device` produce PARCEL items — they differ only in WHERE the photo
// was taken (a shared list screenshot vs the courier device screen). Labels say so, so a
// new user doesn't think they are two different kinds of shipment.
const SCAN_LABELS = () => ({
  parcel: t('scan_parcel'),
  device: t('scan_device'),
  magazine: t('type_magazine'),
  letter: t('type_letter'),
});
// The delivered-item type a scan mode yields (device screen = a list of parcels).
const scanItemType = (mode) => (mode === 'device' ? 'parcel' : mode);

// ---------- shell ----------
function render() {
  clear(app);
  const route = (location.hash || '#/points').slice(2);
  app.appendChild(header());
  const main = el('main', { class: 'content' });
  app.appendChild(main);
  app.appendChild(nav(route));

  if (route === 'settings') renderSettings(main);
  else if (route === 'import') renderImport(main);
  else if (route === 'route') renderRoute(main);
  else renderPoints(main);
}

function header() {
  // App bar shows the brand on most screens; the Scan screen puts its own title here (the
  // in-content heading is dropped there), matching the mobile redesign.
  const route = (location.hash || '#/points').slice(2);
  const title = route === 'import' ? t('import_title') : t('app_title');
  return el('header', { class: 'appbar' }, [
    el('div', { class: 'appbar-brand' }, [
      el('span', { class: 'appbar-mark' }),
      el('span', { class: 'brand', text: title }),
    ]),
    el('span', { class: 'lang', text: getLang().toUpperCase() }),
  ]);
}

function nav(active) {
  const item = (hash, key, iconName) =>
    el('a', { href: `#/${hash}`, class: 'navitem' + (active === hash ? ' on' : '') }, [
      el('span', { class: 'ico' }, [icon(iconName, { size: 22 })]),
      el('span', { class: 'lbl', text: t(key) }),
    ]);
  return el('nav', { class: 'bottomnav' }, [
    item('import', 'nav_import', 'camera'),
    item('points', 'nav_points', 'map-pin'),
    item('route', 'nav_route', 'compass'),
    item('settings', 'nav_settings', 'settings'),
  ]);
}

function section(title) {
  return el('h2', { class: 'sec', text: title });
}

// ---------- Settings ----------
async function renderSettings(main) {
  main.appendChild(section(t('settings_title')));

  // Install to home screen
  const ib = installBlock();
  if (ib) main.appendChild(el('div', { class: 'card' }, [ib]));

  // OCR engine (accuracy vs offline)
  const engine = settings.ocrEngine || 'cloud';
  const keyInput = el('input', {
    class: 'input', type: 'text', value: settings.ocrApiKey || '',
    placeholder: 'OCR.space API key', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
  });
  const saveKey = async () => {
    settings = await saveSettings({ ocrApiKey: keyInput.value.trim() });
    toast(t('settings_saved'));
    render();
  };
  keyInput.addEventListener('change', saveKey); // autosave on blur too
  main.appendChild(el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('settings_ocr') }),
    el('div', { class: 'langgrid' }, [
      el('button', {
        class: 'chip' + (engine === 'cloud' ? ' on' : ''),
        onclick: async () => { settings = await saveSettings({ ocrEngine: 'cloud' }); render(); },
      }, t('ocr_cloud')),
      el('button', {
        class: 'chip' + (engine === 'device' ? ' on' : ''),
        onclick: async () => { settings = await saveSettings({ ocrEngine: 'device' }); render(); },
      }, t('ocr_device')),
    ]),
    engine === 'cloud'
      ? el('div', {}, [
          el('p', { class: 'hint', text: t('ocr_key_hint') }),
          keyInput,
          el('button', { class: 'btn primary', text: t('ocr_save_key'), onclick: saveKey }),
          settings.ocrApiKey
            ? el('p', { class: 'ok', text: t('ocr_key_saved') })
            : null,
          el('a', { class: 'link', href: 'https://ocr.space/ocrapi/freekey', target: '_blank', rel: 'noopener', text: t('ocr_get_key') }),
          el('p', { class: 'warn', text: t('ocr_cloud_warning') }),
        ])
      : el('p', { class: 'hint', text: t('ocr_device_hint') }),
  ]));

  // Theme
  const themes = [
    { code: 'auto', label: t('theme_auto') },
    { code: 'light', label: t('theme_light') },
    { code: 'dark', label: t('theme_dark') },
  ];
  main.appendChild(el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('settings_theme') }),
    el('div', { class: 'langgrid' },
      themes.map((th) =>
        el('button', {
          class: 'chip' + (settings.theme === th.code ? ' on' : ''),
          onclick: async () => {
            settings = await saveSettings({ theme: th.code });
            applyTheme(th.code);
            render();
          },
        }, th.label),
      ),
    ),
  ]));

  // Online geocoding (coordinates for routing)
  const geoOn = settings.onlineGeocode !== false;
  main.appendChild(el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('settings_geocode') }),
    el('p', { class: 'hint', text: t('settings_geocode_hint') }),
    el('div', { class: 'langgrid' }, [
      el('button', {
        class: 'chip' + (geoOn ? ' on' : ''),
        onclick: async () => { settings = await saveSettings({ onlineGeocode: true }); render(); },
      }, t('geocode_on')),
      el('button', {
        class: 'chip' + (!geoOn ? ' on' : ''),
        onclick: async () => { settings = await saveSettings({ onlineGeocode: false }); render(); },
      }, t('geocode_off')),
    ]),
  ]));

  // Search-area limit: only look for addresses within N km of a chosen town, so a
  // street that also exists far away (e.g. across Germany) is never picked by mistake.
  const geoLimitOn = settings.geoLimit !== false;
  const centerRaw = settings.geoCenter?.raw || settings.base?.address?.raw || '';
  const radiusKm = Number(settings.geoRadiusKm) || 40;
  const centerInput = el('input', {
    class: 'input', type: 'text', value: centerRaw,
    placeholder: t('settings_geoarea_placeholder'),
  });
  const radiusLabel = el('p', { class: 'hint', text: `${t('settings_georadius')}: ${radiusKm} ${t('km')}` });
  const radiusSlider = el('input', {
    class: 'slider', type: 'range', min: '5', max: '150', step: '5', value: String(radiusKm),
  });
  radiusSlider.addEventListener('input', () => {
    radiusLabel.textContent = `${t('settings_georadius')}: ${radiusSlider.value} ${t('km')}`;
  });
  const saveArea = async () => {
    const raw = centerInput.value.trim();
    let coords = settings.geoCenter?.coords || null;
    // Re-resolve the centre only when the town text changed (saves a network call).
    if (raw && raw !== (settings.geoCenter?.raw || '')) {
      coords = await geocodeCenter(raw);
      if (!coords) toast(t('settings_geoarea_notfound'));
    }
    settings = await saveSettings({
      geoLimit: geoLimitOn,
      geoRadiusKm: Number(radiusSlider.value),
      geoCenter: raw ? { raw, coords } : null,
    });
    applyGeoBounds();
    toast(t('settings_saved'));
    render();
  };
  main.appendChild(el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('settings_geoarea') }),
    el('p', { class: 'hint', text: t('settings_geoarea_hint') }),
    el('div', { class: 'langgrid' }, [
      el('button', {
        class: 'chip' + (geoLimitOn ? ' on' : ''),
        onclick: async () => { settings = await saveSettings({ geoLimit: true }); applyGeoBounds(); render(); },
      }, t('geoarea_on')),
      el('button', {
        class: 'chip' + (!geoLimitOn ? ' on' : ''),
        onclick: async () => { settings = await saveSettings({ geoLimit: false }); applyGeoBounds(); render(); },
      }, t('geoarea_off')),
    ]),
    geoLimitOn ? el('label', { class: 'field-label', text: t('settings_geoarea_center') }) : null,
    geoLimitOn ? centerInput : null,
    geoLimitOn ? radiusLabel : null,
    geoLimitOn ? radiusSlider : null,
    geoLimitOn ? el('button', { class: 'btn primary', text: t('settings_save'), onclick: saveArea }) : null,
    geoLimitOn && !(settings.geoCenter?.coords || settings.base?.coords)
      ? el('p', { class: 'warn', text: t('settings_geoarea_nocenter') })
      : null,
  ]));

  // Route optimization metric
  const road = (settings.routeMetric || 'road') === 'road';
  main.appendChild(el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('settings_routemetric') }),
    el('p', { class: 'hint', text: t('settings_routemetric_hint') }),
    el('div', { class: 'langgrid' }, [
      el('button', {
        class: 'chip' + (road ? ' on' : ''),
        onclick: async () => { settings = await saveSettings({ routeMetric: 'road' }); render(); },
      }, t('metric_road')),
      el('button', {
        class: 'chip' + (!road ? ' on' : ''),
        onclick: async () => { settings = await saveSettings({ routeMetric: 'straight' }); render(); },
      }, t('metric_straight')),
    ]),
  ]));

  // Parcel priority (pull parcel stops earlier on near-ties)
  const prio = settings.parcelPriority !== false;
  main.appendChild(el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('settings_priority') }),
    el('p', { class: 'hint', text: t('settings_priority_hint') }),
    el('div', { class: 'langgrid' }, [
      el('button', {
        class: 'chip' + (prio ? ' on' : ''),
        onclick: async () => { settings = await saveSettings({ parcelPriority: true }); render(); },
      }, t('priority_on')),
      el('button', {
        class: 'chip' + (!prio ? ' on' : ''),
        onclick: async () => { settings = await saveSettings({ parcelPriority: false }); render(); },
      }, t('priority_off')),
    ]),
  ]));

  // Default navigator
  const navs = [
    { code: 'ask', label: t('nav_ask') },
    { code: 'google', label: t('nav_google') },
    { code: 'waze', label: t('nav_waze') },
    { code: 'geo', label: t('nav_other') },
  ];
  main.appendChild(el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('settings_nav') }),
    el('div', { class: 'langgrid' },
      navs.map((nv) =>
        el('button', {
          class: 'chip' + ((settings.navigator || 'ask') === nv.code ? ' on' : ''),
          onclick: async () => { settings = await saveSettings({ navigator: nv.code }); render(); },
        }, nv.label),
      ),
    ),
  ]));

  // Language
  const langWrap = el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('settings_language') }),
    el('div', { class: 'langgrid' },
      LANGS.map((l) =>
        el('button', {
          class: 'chip' + (getLang() === l.code ? ' on' : ''),
          onclick: async () => {
            setLang(l.code);
            settings = await saveSettings({ language: l.code });
            render();
          },
        }, l.label),
      ),
    ),
  ]);
  main.appendChild(langWrap);

  // Base address
  const baseRaw = settings.base?.address?.raw || '';
  const input = el('input', {
    class: 'input', type: 'text', value: baseRaw,
    placeholder: t('settings_base_placeholder'),
  });
  const baseCard = el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('settings_base') }),
    el('p', { class: 'hint', text: t('settings_base_hint') }),
    input,
    el('button', {
      class: 'btn primary', text: t('settings_save'),
      onclick: async () => {
        const raw = input.value.trim();
        if (!raw) return;
        const coords = await resolveBaseCoords(raw);
        const parsed = parseAddress(raw);
        settings = await saveSettings({ base: { address: { ...parsed }, coords } });
        toast(t('settings_saved'));
        render();
      },
    }),
    settings.base && !settings.base.coords
      ? el('p', { class: 'warn', text: t('conf_yellow') })
      : null,
  ]);
  main.appendChild(baseCard);

  // Address index
  const cnt = await indexCount();
  const fileInput = el('input', { type: 'file', accept: '.json', class: 'hidden' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const data = JSON.parse(text);
      const entries = Array.isArray(data) ? data : data.entries || [];
      const n = await loadAddressIndex(entries);
      // Now that the index exists, re-run identity migration so village points (no PLZ)
      // resolve to their canonical id and any legacy duplicates finally merge.
      await migratePointsV2().catch((e) => console.warn('point migration skipped:', e));
      toast(t('settings_index_loaded', { n }));
      render();
    } catch (e) {
      toast('JSON error');
    }
  });
  // One-tap: fetch the district index bundled with the app (no file transfer needed).
  const idxStatus = el('p', { class: cnt ? 'ok' : 'hint',
    text: cnt ? t('settings_index_loaded', { n: cnt }) : t('settings_index_empty') });
  const bundledBtn = el('button', { class: 'btn primary', text: '⬇️ ' + t('settings_index_bundled') });
  bundledBtn.addEventListener('click', async () => {
    bundledBtn.disabled = true;
    idxStatus.className = 'hint';
    idxStatus.textContent = t('settings_index_downloading');
    try {
      const n = await loadBundledDistrictIndex();
      toast(t('settings_index_loaded', { n }));
      render();
    } catch (e) {
      bundledBtn.disabled = false;
      idxStatus.className = 'warn';
      idxStatus.textContent = t('settings_index_download_err');
    }
  });
  const idxCard = el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('settings_index') }),
    idxStatus,
    el('p', { class: 'hint', text: t('settings_index_bundled_hint') }),
    bundledBtn,
    el('button', { class: 'btn', text: t('settings_index_load'), onclick: () => fileInput.click() }),
    fileInput,
  ]);
  main.appendChild(idxCard);

  // Reset to factory defaults
  main.appendChild(el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('settings_reset') }),
    el('p', { class: 'hint', text: t('settings_reset_hint') }),
    el('button', {
      class: 'btn', text: t('settings_reset'),
      onclick: async () => {
        if (confirm(t('settings_reset_confirm'))) {
          settings = await resetSettings();
          setLang(resolveInitialLang(settings.language));
          applyTheme(settings.theme);
          toast(t('settings_saved'));
          location.hash = '';
          render();
        }
      },
    }),
  ]));

  // Danger zone
  const danger = el('div', { class: 'card danger' }, [
    el('label', { class: 'field-label', text: t('settings_danger') }),
    el('button', {
      class: 'btn danger', text: t('settings_clear_points'),
      onclick: async () => {
        if (confirm(t('settings_clear_confirm'))) {
          await clearPoints();
          toast('OK');
          render();
        }
      },
    }),
  ]);
  main.appendChild(danger);

  // Build stamp — lets you confirm the installed app updated to the latest version.
  main.appendChild(el('p', { class: 'hint center', text: `${t('settings_version')}: ${__BUILD__}` }));
  // Developer credit + contact for feedback/suggestions.
  main.appendChild(el('p', { class: 'hint center', text: `${t('settings_dev')}: @ObiVan1978` }));
  main.appendChild(el('p', { class: 'hint center' }, [
    document.createTextNode(`${t('settings_contact')}: `),
    el('a', { href: 'https://t.me/ObiVan1978', target: '_blank', rel: 'noopener', text: 'Telegram @ObiVan1978' }),
  ]));
}

// ---------- Import / Scan ----------
let importState = { type: 'parcel', rows: [] };
// Local-only UI flags: whether each "?" explanation panel is expanded. Not persisted.
let importHints = { cargo: false, ocr: false };

// Identity fields used to spot the SAME delivery scanned twice across overlapping photos
// (see sameScannedPlace). lookupKey is the anchor that survives auto-resolution.
const scanIdentity = (src) => ({
  canonicalId: src.canonicalId || '',
  lookupKey: src.parsed?.lookupKey || '',
  postcode: src.parsed?.postcode || '',
});
// True if `g` (a geocodeRaw result or a row) duplicates a row already in the review list.
const isDuplicateScan = (g) => importState.rows.some((r) => sameScannedPlace(scanIdentity(r), scanIdentity(g)));

// Drop duplicate review rows in place, keeping the first occurrence. Runs AFTER neighbour
// auto-resolution so it can compare by resolved identity (see sameScannedPlace) — this is what
// makes an overlap-scanned stop count once without ever risking a real cross-town delivery.
function dedupeReviewRows() {
  const kept = [];
  for (const r of importState.rows) {
    if (kept.some((k) => sameScannedPlace(scanIdentity(k), scanIdentity(r)))) continue;
    kept.push(r);
  }
  importState.rows = kept;
}

// Auto-pick the right village for ambiguous rows using their already-resolved list
// neighbours (the device list is ordered by route section, so neighbours are close). A
// newly resolved village then anchors the next ambiguous one, so we sweep a few passes.
function autoResolveNeighbors() {
  const rows = importState.rows;
  for (let pass = 0; pass < 5; pass++) {
    const stops = rows.map((r) => ({ coords: r.coords, candidates: r.candidates || [] }));
    const decisions = autoResolveByNeighbors(stops);
    let changed = 0;
    decisions.forEach((dec, i) => {
      if (!dec) return;
      const r = rows[i];
      const c = r.candidates && r.candidates[dec.chosenIndex];
      if (!c) return;
      const lk = r.parsed.lookupKey;
      const cache = c.postcode ? `${lk}|${c.postcode}` : lk;
      r.parsed = { ...r.parsed, postcode: c.postcode || '', city: c.city || '', matchKey: cache };
      r.canonicalId = (c.id != null) ? `index:${c.id}` : cache;
      r.canonicalResolved = true;
      r.coords = { lat: c.lat, lng: c.lng };
      r.confidence = 'green';
      r.coordinateSuspicious = !!c.coordinateSuspicious;
      r.coordinateDistanceM = c.coordinateDistanceM || 0;
      r.coordinateFallbackHouse = c.coordinateFallbackHouse || '';
      if (r.coordinateSuspicious) r.confidence = 'yellow';
      r.candidates = [];
      r.selected = true;
      r.autoResolved = c.city || c.street || ''; // which village won, for a review hint
      changed++;
    });
    if (!changed) break;
  }
}

// Re-attach the known postcode/city to an edited street line, so editing the house
// number (the review field shows only street+house) does not throw away that context.
function withAddrContext(streetValue, parsed) {
  const tail = [parsed?.postcode, parsed?.city].filter(Boolean).join(' ').trim();
  return tail ? `${streetValue}\n${tail}` : streetValue;
}

// Add a typed/dictated address into the review list (same flow as OCR results).
async function addManualRow(raw) {
  const value = (raw || '').trim();
  if (!value) return;
  const g = await geocodeRaw(value, { online: settings.onlineGeocode !== false });
  if (isDuplicateScan(g)) { toast(t('import_nothing')); return; }
  importState.rows.push({
    raw: value,
    editStreet: g.parsed.display,
    parsed: g.parsed,
    canonicalId: g.canonicalId,
    canonicalResolved: g.canonicalResolved,
    candidates: g.candidates,
    confidence: g.confidence,
    coords: g.coords,
    coordinateSuspicious: !!g.coordinateSuspicious,
    coordinateDistanceM: g.coordinateDistanceM || 0,
    coordinateFallbackHouse: g.coordinateFallbackHouse || '',
    suggestion: g.suggestion,
    selected: !(g.candidates && g.candidates.length),
  });
  render();
}

// Voice dictation via the browser Speech API (German). onEnd resets UI state.
function startVoice(targetInput, onEnd) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast(t('voice_unsupported')); if (onEnd) onEnd(); return; }
  const rec = new SR();
  rec.lang = 'de-DE'; // addresses are German regardless of UI language
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    let txt = '';
    for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
    targetInput.value = txt;
  };
  rec.onerror = () => { toast(t('voice_error')); };
  rec.onend = () => { if (onEnd) onEnd(); };
  try { rec.start(); } catch (e) { if (onEnd) onEnd(); }
}

async function renderImport(main) {
  // Title lives in the app bar on this screen; the pinned "Take photo" button needs room.
  main.classList.add('is-import');

  const useCloud = (settings.ocrEngine || 'cloud') === 'cloud';

  // For the on-device engine, warm it up when the Scan screen opens so the model
  // download/init is not paid mid-scan. Cloud engine needs no warm-up.
  if (!useCloud) {
    warmUp((phase, p) => {
      if (importState.rows.length) return;
      const el2 = document.getElementById('ocr-status');
      if (!el2) return;
      if (phase === 'loading' && p < 1) el2.textContent = t('import_loading_engine', { p: Math.round(p * 100) });
      else if (phase === 'loading') el2.textContent = t('import_engine_ready');
    });
  }

  // Type selector — 2x2 radio grid. Same values as before (importState.type); the long
  // note is unchanged text, just tucked behind "?" instead of always filling the card.
  const typeCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('div', { class: 'card-title', text: t('import_type_label') }),
      el('button', {
        class: 'hintbtn', type: 'button', 'aria-label': '?',
        onclick: () => { importHints.cargo = !importHints.cargo; render(); },
      }, '?'),
    ]),
    el('div', { class: 'typegrid' },
      Object.entries(SCAN_LABELS()).map(([k, label]) =>
        el('button', {
          class: 'typecell' + (importState.type === k ? ' on' : ''),
          type: 'button',
          onclick: () => { importState.type = k; render(); },
        }, [
          el('span', { class: 'radio' }),
          el('span', { class: 'typecell-label', text: label }),
        ]),
      ),
    ),
    importHints.cargo ? el('p', { class: 'hintpanel', text: t('scan_note') }) : null,
  ]);
  main.appendChild(typeCard);

  const isDevice = importState.type === 'device';
  const isList = importState.type === 'parcel' || isDevice; // both are multi-address lists
  const hintKey = isDevice ? 'import_hint_device' : (isList ? 'import_hint_parcel' : 'import_hint_mail');
  const instruction = el('p', { class: 'hint', text: t(hintKey) });
  const progress = el('p', { class: 'hint', id: 'ocr-status', text: '' }); // OCR status only

  // Shared handler for BOTH the camera and the file/screenshot pickers.
  const handleFile = async (f) => {
    if (!f) return;
    let text = '';
    let lines = [];
    try {
      if (useCloud) {
        progress.textContent = t('import_recognizing_cloud');
        ({ text, lines } = await cloudRecognize(f, settings.ocrApiKey));
      } else {
        progress.textContent = t('import_loading_engine', { p: 0 });
        ({ text, lines } = await recognize(f, (phase, p) => {
          progress.textContent = phase === 'recognizing'
            ? t('import_recognizing', { p: Math.round(p * 100) })
            : t('import_loading_engine', { p: Math.round(p * 100) });
        }));
      }
    } catch (e) {
      progress.textContent = (useCloud ? 'Cloud OCR: ' : 'OCR: ') + (e && e.message ? e.message : 'error');
      return;
    }
    // PARCEL photo = a LIST -> split into many addresses (by PLZ + visual gaps).
    // MAGAZINE/LETTER photo = ONE address. If the shot accidentally caught two,
    // split them and keep the TOP real address block — i.e. the topmost block that
    // actually carries a postcode (so a caption/junk block above it is skipped).
    let blocks;
    if (isDevice) {
      // Courier-device screen: card layout, no postcodes, right-hand route codes.
      blocks = splitDeviceScreen(text, lines);
    } else if (isList) {
      blocks = splitAddresses(text, lines);
    } else {
      // MAGAZINE/LETTER = ONE address. If the shot caught the sender too, pick the
      // RECIPIENT block by scoring (sender markers penalised), not just "first with PLZ".
      const mail = splitAddresses(text, lines);
      const receiver = pickReceiverBlock(mail);
      blocks = receiver ? [receiver] : (text.trim() ? [text.trim()] : []);
    }
    if (!blocks.length) {
      progress.textContent = t('import_no_text');
      render();
      return;
    }
    // Accumulate across photos (a parcel list may span 2-3 photos). Add every block first, THEN
    // resolve + de-duplicate: an overlap duplicate can only be recognised safely once its town
    // is known, so the dedupe runs after autoResolveNeighbors (see sameScannedPlace / dedupeReviewRows).
    for (const b of blocks) {
      const g = await geocodeRaw(b, { online: settings.onlineGeocode !== false });
      importState.rows.push({
        raw: b,
        editStreet: g.parsed.display,
        parsed: g.parsed,
        canonicalId: g.canonicalId,
        canonicalResolved: g.canonicalResolved,
        candidates: g.candidates,
        confidence: g.confidence,
        coords: g.coords,
        coordinateSuspicious: !!g.coordinateSuspicious,
        coordinateDistanceM: g.coordinateDistanceM || 0,
        coordinateFallbackHouse: g.coordinateFallbackHouse || '',
        suggestion: g.suggestion,
        // An ambiguous address (several index matches) must NOT be auto-selected — the
        // courier has to pick which town first (see the chooser in renderReview).
        selected: g.confidence !== 'red' && !(g.candidates && g.candidates.length),
      });
    }
    autoResolveNeighbors(); // spatially disambiguate villages using resolved list neighbours
    dedupeReviewRows();     // now that towns are known, collapse overlap duplicates safely
    render();
  };

  // Two inputs so BOTH options always work: camera opens the camera; file lets
  // you pick a screenshot / gallery image (device choosers vary, so we split them).
  const cameraInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
  const fileInput = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  cameraInput.addEventListener('change', () => { const f = cameraInput.files[0]; cameraInput.value = ''; handleFile(f); });
  fileInput.addEventListener('change', () => { const f = fileInput.files[0]; fileInput.value = ''; handleFile(f); });

  // Recognition mode. The one-time consent gate is kept: until the courier picks a mode,
  // photo capture stays hidden so nothing leaves the device unasked. After consent, the same
  // choice becomes a persistent segment control writing the same settings.ocrEngine.
  if (settings.ocrConsent == null) {
    const choose = async (engine) => {
      settings = await saveSettings({ ocrConsent: true, ocrEngine: engine });
      render();
    };
    main.appendChild(el('div', { class: 'card' }, [
      el('h3', { class: 'card-title', text: t('ocr_consent_title') }),
      el('p', { class: 'hint', text: t('ocr_consent_body') }),
      el('div', { class: 'btnrow' }, [
        el('button', { class: 'btn primary', text: t('ocr_consent_cloud'), onclick: () => choose('cloud') }),
        el('button', { class: 'btn', text: t('ocr_consent_device'), onclick: () => choose('device') }),
      ]),
    ]));
  } else {
    const engine = settings.ocrEngine || 'cloud';
    main.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('div', { class: 'card-title', text: t('ocr_consent_title') }),
        el('button', {
          class: 'hintbtn', type: 'button', 'aria-label': '?',
          onclick: () => { importHints.ocr = !importHints.ocr; render(); },
        }, '?'),
      ]),
      el('div', { class: 'segmented' }, [
        el('button', {
          class: 'seg' + (engine === 'cloud' ? ' on' : ''), type: 'button',
          onclick: async () => { settings = await saveSettings({ ocrEngine: 'cloud' }); render(); },
        }, t('ocr_cloud')),
        el('button', {
          class: 'seg' + (engine === 'device' ? ' on' : ''), type: 'button',
          onclick: async () => { settings = await saveSettings({ ocrEngine: 'device' }); render(); },
        }, t('ocr_device')),
      ]),
      importHints.ocr ? el('p', { class: 'hintpanel', text: t('ocr_consent_body') }) : null,
    ]));

    // Photo help: the screenshot/gallery alternative + the per-type instruction. The primary
    // camera action is the pinned "Take photo" button at the bottom.
    main.appendChild(el('div', { class: 'card' }, [
      instruction,
      el('button', {
        class: 'btn', type: 'button', onclick: () => fileInput.click(),
      }, [icon('image', { size: 18 }), el('span', { text: t('import_pick_file_btn') })]),
      fileInput,
    ]));
  }

  // Manual / voice entry
  const manualInput = el('input', {
    class: 'input', type: 'text',
    placeholder: t('import_manual_placeholder'),
    autocapitalize: 'words', autocomplete: 'off',
  });
  const micBtn = el('button', { class: 'btn micbtn', type: 'button' }, [icon('mic', { size: 20 })]);
  const setMic = (listening) => {
    micBtn.classList.toggle('listening', listening);
    micBtn.disabled = listening;
    const label = listening ? t('voice_listening') : t('voice_start');
    micBtn.setAttribute('aria-label', label);
    micBtn.title = label;
  };
  setMic(false);
  micBtn.addEventListener('click', () => {
    setMic(true);
    startVoice(manualInput, () => setMic(false));
  });
  // "Добавить" is intentionally soft-blue, not solid: the one solid action per screen is
  // the pinned "Take photo" button.
  const manualCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title', text: t('import_manual_title') }),
    el('p', { class: 'hint', text: t('import_manual_hint') }),
    manualInput,
    el('div', { class: 'manual-row' }, [
      micBtn,
      el('button', {
        class: 'btn addbtn', type: 'button', text: t('import_manual_add'),
        onclick: async () => { await addManualRow(manualInput.value); },
      }),
    ]),
  ]);
  main.appendChild(manualCard);

  if (importState.rows.length) main.appendChild(renderReview());

  // Pinned primary action (only once photo capture is unlocked by consent). The camera input
  // and OCR status line live here so the same #ocr-status hook stays in the DOM during a scan.
  if (settings.ocrConsent != null) {
    main.appendChild(el('div', { class: 'import-actions' }, [
      cameraInput,
      progress,
      el('button', {
        class: 'btn primary big', type: 'button', onclick: () => cameraInput.click(),
      }, [icon('camera', { size: 18 }), el('span', { text: t('import_take_photo_btn') })]),
    ]));
  }
}

function confBadge(conf) {
  const map = { green: t('conf_green'), yellow: t('conf_yellow'), red: t('conf_red') };
  return el('span', { class: `badge ${conf}`, title: map[conf], text: map[conf] });
}

function renderReview() {
  const wrap = el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h3', { class: 'card-title', text: t('import_review_title') }),
      el('button', {
        class: 'btn danger sm', type: 'button', text: t('import_clear'),
        onclick: () => { importState.rows = []; render(); },
      }),
    ]),
    el('p', { class: 'hint', text: t('import_review_hint') }),
  ]);

  importState.rows.forEach((row, i) => {
    const streetInput = el('input', {
      class: 'input sm', type: 'text', value: row.editStreet,
    });
    streetInput.addEventListener('change', async () => {
      row.editStreet = streetInput.value;
      // Keep the known PLZ/city as CONTEXT so an edit to the house number does not
      // strip them (canonicalization via the index still overrides them authoritatively).
      const g = await geocodeRaw(withAddrContext(streetInput.value, row.parsed), { online: settings.onlineGeocode !== false });
      row.parsed = g.parsed;
      row.canonicalId = g.canonicalId;
      row.canonicalResolved = g.canonicalResolved;
      row.candidates = g.candidates;
      row.confidence = g.confidence;
      row.coords = g.coords;
      row.coordinateSuspicious = !!g.coordinateSuspicious;
      row.coordinateDistanceM = g.coordinateDistanceM || 0;
      row.coordinateFallbackHouse = g.coordinateFallbackHouse || '';
      row.suggestion = g.suggestion;
      if (g.candidates && g.candidates.length) row.selected = false;
      render();
    });

    const cb = el('input', { type: 'checkbox' });
    cb.checked = row.selected;
    cb.addEventListener('change', () => { row.selected = cb.checked; updateAddBtn(); });

    const rowEl = el('div', { class: `review-row ${row.confidence}` }, [
      el('label', { class: 'rev-check' }, [cb]),
      el('div', { class: 'rev-body' }, [
        streetInput,
        confBadge(row.confidence),
        row.coordinateSuspicious
          ? el('p', { class: 'warn', text: t('coord_outlier_warning', { m: row.coordinateDistanceM }) })
          : null,
        row.autoResolved
          ? el('p', { class: 'ok', text: `📍 ${t('import_auto_neighbor')}${row.autoResolved ? ` — ${row.autoResolved}` : ''}` })
          : null,
        row.suggestion
          ? el('button', {
              class: 'link', text: `${t('suggest_prefix')} ${row.suggestion} — ${t('apply_suggestion')}`,
              onclick: async () => {
                const house = `${row.parsed.houseNumber}${row.parsed.houseLetter}`;
                streetInput.value = `${row.suggestion} ${house}`.trim();
                row.editStreet = streetInput.value;
                const g = await geocodeRaw(withAddrContext(streetInput.value, row.parsed));
                row.parsed = g.parsed; row.canonicalId = g.canonicalId; row.candidates = g.candidates;
                row.canonicalResolved = g.canonicalResolved;
                row.confidence = g.confidence;
                row.coords = g.coords; row.suggestion = g.suggestion;
                row.coordinateSuspicious = !!g.coordinateSuspicious;
                row.coordinateDistanceM = g.coordinateDistanceM || 0;
                row.coordinateFallbackHouse = g.coordinateFallbackHouse || '';
                render();
              },
            })
          : null,
        // Ambiguous: same street+house in several towns. Force an explicit choice —
        // never silently guess (a wrong "green" is worse than a yellow prompt).
        row.candidates && row.candidates.length
          ? el('div', { class: 'cand-choose' }, [
              el('p', { class: 'warn', text: t('import_ambiguous') }),
              ...row.candidates.map((c) => el('button', {
                class: 'btn sm',
                text: `${c.postcode || '—'} ${c.city || c.street}`.trim(),
                onclick: () => {
                  const lk = row.parsed.lookupKey;
                  // Identity ties to the CHOSEN OSM record (index:<id>), so two towns that
                  // share street+house(+postcode) never collapse to one canonicalId.
                  const cid = (c.id != null) ? `index:${c.id}` : (c.postcode ? `${lk}|${c.postcode}` : lk);
                  const cache = c.postcode ? `${lk}|${c.postcode}` : lk;
                  row.parsed = { ...row.parsed, postcode: c.postcode || '', city: c.city || '', matchKey: cache };
                  row.canonicalId = cid;
                  row.canonicalResolved = true;
                  row.coords = (typeof c.lat === 'number') ? { lat: c.lat, lng: c.lng } : row.coords;
                  row.coordinateSuspicious = !!c.coordinateSuspicious;
                  row.coordinateDistanceM = c.coordinateDistanceM || 0;
                  row.coordinateFallbackHouse = c.coordinateFallbackHouse || '';
                  row.confidence = row.coordinateSuspicious ? 'yellow' : 'green';
                  row.candidates = [];
                  row.selected = true;
                  render();
                },
              })),
            ])
          : null,
      ]),
    ]);
    wrap.appendChild(rowEl);
  });

  // Distinct colour (green = confirm) so it is never confused with the blue pinned
  // "Take photo" action that sits just below it.
  const addBtn = el('button', { class: 'btn big commit', id: 'add-selected' });
  const updateAddBtn = () => {
    const n = importState.rows.filter((r) => r.selected).length;
    addBtn.textContent = t('import_add_selected', { n });
    addBtn.disabled = n === 0;
  };
  addBtn.addEventListener('click', async () => {
    const chosen = importState.rows.filter(
      (r) => r.selected && (r.canonicalId || r.parsed.matchKey) && !(r.candidates && r.candidates.length),
    );
    if (!chosen.length) { toast(t('import_nothing')); return; }
    const itemType = scanItemType(importState.type); // device screen -> parcel items
    for (const r of chosen) {
      const item = makeItem({ type: itemType, source: 'ocr', rawText: r.raw });
      await addItemAtAddress(r.parsed, item, {
        coords: r.coords,
        verified: true,
        canonicalId: r.canonicalId,
        canonicalResolved: r.canonicalResolved,
        coordinateSuspicious: !!r.coordinateSuspicious,
        coordinateDistanceM: r.coordinateDistanceM || 0,
        coordinateFallbackHouse: r.coordinateFallbackHouse || '',
      });
    }
    toast(t('import_added', { n: chosen.length }));
    importState.rows = [];
    location.hash = '#/points';
  });
  wrap.appendChild(addBtn);
  setTimeout(updateAddBtn, 0);
  return wrap;
}

// ---------- Points ----------
async function renderPoints(main) {
  const points = await getPoints();
  const routeState = await getRouteState();
  // The "ТОЧКИ ДОСТАВКИ" heading is gone — it only duplicated the active tab.
  main.appendChild(statsBar(points));
  if (!points.length) {
    main.classList.add('is-points'); // column layout: counters top, empty centered, actions bottom
    main.appendChild(emptyPoints());
    return;
  }
  main.appendChild(el('div', { class: 'points-actions' }, [
    el('span', { class: 'hint', text: t('points_count', { n: points.length }) }),
    el('button', {
      class: 'btn danger sm', text: '🗑 ' + t('settings_clear_points'),
      onclick: async () => {
        if (confirm(t('settings_clear_confirm'))) { await clearPoints(); toast('OK'); render(); }
      },
    }),
  ]));

  const ordered = orderByRoute(points, routeState.current);
  for (const p of ordered) {
    main.appendChild(pointCard(p));
  }
}

function statsBar(points) {
  const c = aggregateCounts(points);
  // One segmented card. Colour now carries meaning only in a small marker dot before the
  // label (parcels blue, mail amber); the total gets no dot. Number is bigger than label.
  const cell = (label, value, cls, dot) =>
    el('div', { class: `stat ${cls || ''}` }, [
      el('div', { class: 'stat-val', text: String(value) }),
      el('div', { class: 'stat-lbl' }, [
        dot ? el('span', { class: 'stat-dot' }) : null,
        el('span', { text: label }),
      ]),
    ]);
  return el('div', { class: 'card statsbar' }, [
    cell(t('type_parcel'), c.parcel, 'parcel', true),
    el('div', { class: 'stat-div' }),
    cell(t('stat_mail'), c.mail, 'mail', true),
    el('div', { class: 'stat-div' }),
    // Headline = number of delivery POINTS in the list (stops), not the item count, so it
    // always matches the rows the courier sees.
    cell(t('stat_total'), c.stops, 'total', false),
  ]);
}

// Empty Points screen: a soft placeholder icon, the existing empty message, and the two
// primary entry points. Both buttons just navigate to the Scan screen (route only, no new
// logic): the first for the photo flow, the second for the manual/dictate entry card.
function emptyPoints() {
  return el('div', { class: 'points-empty' }, [
    el('div', { class: 'points-empty-art' }, [
      el('div', { class: 'points-empty-badge' }, [el('span', { class: 'points-empty-dot' })]),
      el('p', { class: 'points-empty-text', text: t('points_empty') }),
    ]),
    el('div', { class: 'points-empty-actions' }, [
      el('button', {
        class: 'btn primary big', onclick: () => { location.hash = '#/import'; },
      }, [icon('camera', { size: 18 }), el('span', { text: t('points_empty_scan') })]),
      el('button', {
        class: 'btn', onclick: () => { location.hash = '#/import'; },
      }, [el('span', { text: t('points_empty_manual') })]),
    ]),
  ]);
}

function pointNavLabel(point) {
  const address = point?.address || {};
  const street = address.display || address.raw || '';
  const locality = [address.postcode, address.city].filter(Boolean).join(' ').trim();
  return [street, locality].filter(Boolean).join(', ');
}

function savePointGps(point) {
  if (!navigator.geolocation) { toast(t('coord_gps_unsupported')); return; }
  toast(t('coord_gps_locating'));
  navigator.geolocation.getCurrentPosition(async (position) => {
    point.coords = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
    };
    point.coordinateManual = true;
    point.coordinateAccuracyM = Math.round(position.coords.accuracy || 0);
    point.coordinateSuspicious = false;
    point.coordinateDistanceM = 0;
    point.coordinateFallbackHouse = '';
    point.geocodeStatus = 'manual';
    await putPoint(point);
    toast(t('coord_gps_saved'));
    render();
  }, () => toast(t('coord_gps_error')), {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 0,
  });
}

function pointCard(p) {
  const counts = itemTypeCounts(p);
  const status = pointStatus(p);
  const navLabel = pointNavLabel(p);
  const canNavigate = !!p.coords || pointHasPostalAddress(p);
  const badges = el('div', { class: 'typebadges' },
    Object.entries(counts).filter(([, n]) => n > 0).map(([type, n]) =>
      el('span', { class: `tb ${type}` }, [
        icon(TYPE_ICON[type], { size: 15 }),
        el('span', { text: String(n) }),
      ]),
    ),
  );

  const items = el('div', { class: 'items' },
    p.items.map((it) => itemRow(p, it)),
  );

  const addWrap = el('div', { class: 'addrow' },
    Object.entries(TYPE_LABELS()).map(([type, label]) =>
      el('button', {
        class: 'chip sm',
        onclick: async () => {
          p.items.push(makeItem({ type, source: 'manual' }));
          await putPoint(p);
          render();
        },
      }, [icon('plus', { size: 15 }), icon(TYPE_ICON[type], { size: 15 }), el('span', { text: label })]),
    ),
  );

  return el('div', { class: `card point ${status}` }, [
    el('div', { class: 'point-head' }, [
      el('div', {}, [
        el('div', {
          class: 'addr' + (canNavigate ? ' addr-nav' : ''),
          onclick: canNavigate ? () => openNav(p.coords || { lat: 0, lng: 0 }, navLabel, pointNavOptions(p)) : null,
        }, [
          canNavigate ? icon('navigation', { size: 16 }) : null,
          el('span', { text: p.address.display || p.address.raw }),
        ]),
        p.address.city ? el('div', { class: 'city', text: `${p.address.postcode} ${p.address.city}`.trim() }) : null,
        p.coordinateManual
          ? el('div', { class: 'ok', text: '✓ ' + t('coord_gps_manual', { m: p.coordinateAccuracyM || '?' }) })
          : null,
        p.coordinateSuspicious
          ? el('div', { class: 'nocoord', text: '⚠ ' + t('coord_outlier_warning', { m: p.coordinateDistanceM || '?' }) })
          : null,
        p.coords && !p.coordinateManual && !p.coordinateSuspicious
          ? el('div', { class: 'hint', text: t('coord_auto_unverified') })
          : null,
        !p.coords ? el('div', { class: 'nocoord', text: '⚠ ' + t('conf_yellow') }) : null,
      ]),
      badges,
    ]),
    items,
    addWrap,
    el('button', {
      class: 'btn sm',
      onclick: () => savePointGps(p),
    }, [icon('map-pin', { size: 16 }), el('span', { text: t(p.coordinateManual ? 'coord_gps_update' : 'coord_gps_save') })]),
    el('button', {
      class: 'btn danger sm', text: t('point_delete'),
      onclick: async () => {
        if (confirm(t('point_delete_confirm'))) { await deletePoint(p.id); render(); }
      },
    }),
  ]);
}

function itemRow(p, it) {
  const done = it.status === 'delivered';
  const cb = el('input', { type: 'checkbox' });
  cb.checked = done;
  cb.addEventListener('change', async () => {
    it.status = cb.checked ? 'delivered' : 'pending';
    it.deliveredAt = cb.checked ? Date.now() : null;
    await putPoint(p);
    render();
  });
  return el('label', { class: `itemrow ${it.type}` + (done ? ' done' : '') }, [
    cb,
    el('span', { class: 'it-type' }, [
      icon(TYPE_ICON[it.type], { size: 16 }),
      el('span', { text: TYPE_LABELS()[it.type] }),
    ]),
    done ? el('span', { class: 'it-done', text: t('point_delivered') }) : null,
  ]);
}

// ---------- Route ----------
async function renderRoute(main) {
  main.appendChild(section(t('route_title')));

  if (!settings.base?.coords) {
    main.appendChild(el('p', { class: 'warn', text: t('route_need_base') }));
    return;
  }

  // Proactively offer the district index when it's not loaded yet — village addresses
  // (no postcode) are only reliable with it, so prompt here instead of hiding it in Settings.
  if ((await indexCount()) === 0) {
    const promptStatus = el('p', { class: 'hint', text: t('route_index_prompt') });
    const loadBtn = el('button', { class: 'btn primary', text: '⬇️ ' + t('settings_index_bundled') });
    loadBtn.addEventListener('click', async () => {
      loadBtn.disabled = true;
      promptStatus.textContent = t('settings_index_downloading');
      try {
        const n = await loadBundledDistrictIndex();
        toast(t('settings_index_loaded', { n }));
        render();
      } catch (e) {
        loadBtn.disabled = false;
        promptStatus.className = 'warn';
        promptStatus.textContent = t('settings_index_download_err');
      }
    });
    main.appendChild(el('div', { class: 'card' }, [
      el('label', { class: 'field-label', text: t('route_index_prompt_title') }),
      promptStatus,
      loadBtn,
    ]));
  }

  const buildBtn = el('button', { class: 'btn primary big', text: t('route_build') });
  // "Map" opens the graphical Leaflet view of the current order (numbered pins + a thin line).
  // Editing stays in the list; the map only mirrors it and redraws live on manual reorder.
  const mapBtn = el('button', {
    class: 'btn map-btn', title: t('route_map_open'), 'aria-label': t('route_map_open'),
    onclick: () => openRouteMap(),
  }, [el('span', { class: 'map-btn-ico', text: '🗺️' }), el('span', { text: t('route_map_open') })]);
  main.appendChild(el('div', { class: 'route-actions' }, [buildBtn, mapBtn]));
  const result = el('div', {});
  main.appendChild(result);

  // Re-opening the tab shows the last saved route immediately (no need to rebuild).
  const savedState = await getRouteState();
  if (savedState.current) {
    const points = await getPoints();
    const cur = savedState.current;
    const orderedIds = reorderStopsFromSaved(points, cur.order);
    const delivered = points.filter((p) => p.coords && pointStatus(p) === 'done');
    const skipped = points.filter((p) => !p.coords && pointStatus(p) !== 'done').length;
    const byId = new Map(points.map((p) => [p.id, p]));

    if (orderedIds.length) {
      // The saved distance/provider only hold if the route's GEOMETRY is unchanged — same
      // stops in the same order AND the same Base/stop coordinates. A stored geoSig captures
      // all of that, so it also catches a corrected Base address or a GPS entrance saved on
      // site (which move the line but not the id list). When it no longer matches we recompute
      // the straight-line loop and flag the route as OUTDATED (rebuild needed), rather than
      // pretending the stale order was optimized.
      const displayed = orderedIds.map((id) => byId.get(id)).filter(Boolean);
      const sig = routeGeoSig(settings.base?.coords, displayed);
      const outdated = sig !== cur.geoSig || cur.provider === 'legacy' || !(cur.totalMeters > 0);
      if (outdated) {
        const meters = loopMeters(settings.base?.coords, displayed);
        renderRouteResult(result, points, orderedIds, meters, skipped, 'straight', delivered, savedState.previous, false, true);
      } else {
        renderRouteResult(result, points, orderedIds, cur.totalMeters, skipped, cur.provider || 'straight', delivered, savedState.previous, !!cur.manual, false);
      }
    } else if (delivered.length) {
      // Every stop is delivered — celebrate, but still list the done stops (dimmed).
      result.appendChild(el('p', { class: 'route-sum', text: t('route_all_done') }));
      renderDeliveredStops(result, delivered);
    }
  }

  buildBtn.addEventListener('click', async () => {
    if (buildBtn.disabled) return;
    buildBtn.disabled = true;
    try {
      const points = await getPoints();

    // Overall budget for the ONLINE geocoding phase. Each Nominatim call is throttled to ~1/s,
    // so on many missing points the sequential loop could otherwise run for minutes and look
    // frozen. When the budget runs out we stop geocoding and route with the coords we already
    // have; the rest are reported as "skipped — no coordinates", not left to hang.
    const GEO_BUDGET_MS = 18000;
    const geoDeadline = Date.now() + GEO_BUDGET_MS;

    // Re-validate STORED coords against the search area. An ambiguous (no-postcode) point
    // whose saved coordinate lands outside the area was geocoded to a wrong same-named town
    // BEFORE the limit existed (the route uses stored coords, so the old error persisted).
    // Re-geocode it inside the area, or drop the coordinate so it won't drag the route 100 km.
    if (boundsActive() && (settings.onlineGeocode !== false) && navigator.onLine) {
      const stale = points.filter((p) => p.coords && !p.address?.postcode && !withinBounds(p.coords));
      if (stale.length) {
        clear(result);
        const status = el('p', { class: 'hint' });
        result.appendChild(status);
        for (let i = 0; i < stale.length; i++) {
          if (Date.now() > geoDeadline) break;
          status.textContent = t('route_revalidating', { i: i + 1, n: stale.length });
          const p = stale[i];
          const c = await onlineGeocode({ ...p.address, matchKey: p.matchKey });
          p.coords = (c && withinBounds(c)) ? c : null;
          p.geocodeStatus = p.coords ? 'matched' : 'notfound';
          await putPoint(p);
        }
      }
    }

    // Fill in coordinates for any points that don't have them yet (online),
    // so already-added stops also become routable.
    const missing = points.filter((p) => !p.coords);
    if (missing.length && (settings.onlineGeocode !== false) && navigator.onLine) {
      clear(result);
      const status = el('p', { class: 'hint' });
      result.appendChild(status);
      for (let i = 0; i < missing.length; i++) {
        if (Date.now() > geoDeadline) break; // overall budget spent -> route with what we have
        status.textContent = t('route_geocoding', { i: i + 1, n: missing.length });
        const p = missing[i];
        const c = await onlineGeocode({ ...p.address, matchKey: p.matchKey });
        if (c) { p.coords = c; p.geocodeStatus = 'matched'; await putPoint(p); }
      }
    }

    // A stop is "priority" if it holds at least one parcel (parcels beat mail on ties).
    const prioOn = settings.parcelPriority !== false;
    const hasParcel = (p) => Array.isArray(p.items) && p.items.some((i) => i.type === 'parcel');
    const localityGroup = (p) => {
      const postcode = String(p.address?.postcode || '').trim();
      const city = String(p.address?.city || '').trim().toLocaleLowerCase('de-DE');
      return (postcode || city) ? `${postcode}|${city}` : '';
    };
    // Only NOT-fully-delivered points are optimized into the active route. Delivered
    // points drop out of the recalculation (so the count/route reflect what's left)
    // but are still shown, dimmed, so the courier sees where they've already been.
    const deliveredWithCoords = points.filter((p) => p.coords && pointStatus(p) === 'done');
    const stops = points
      .filter((p) => p.coords && pointStatus(p) !== 'done')
      .map((p) => ({
        id: p.id,
        lat: p.coords.lat,
        lng: p.coords.lng,
        priority: prioOn && hasParcel(p),
        group: localityGroup(p),
      }));
    const skippedNoCoord = points.filter((p) => !p.coords && pointStatus(p) !== 'done');

    if (!stops.length) {
      clear(result);
      if (deliveredWithCoords.length) {
        // Nothing left to deliver — celebrate, but still list the done stops (dimmed).
        result.appendChild(el('p', { class: 'route-sum', text: t('route_all_done') }));
        renderDeliveredStops(result, deliveredWithCoords);
      } else {
        result.appendChild(el('p', { class: 'warn', text: t('route_need_points') }));
      }
      return;
    }

    // Online priority: openrouteservice/VROOM through our key-hiding Worker proxy. If ORS is
    // unavailable or not configured, fall back to OSRM and finally to the offline solver.
    // One shared deadline bounds the entire online-routing phase instead of stacking several
    // independent long waits that look like a frozen button.
    clear(result);
    const status = el('p', { class: 'hint' });
    result.appendChild(status);
    let routed = null;
    const wantRoad = (settings.routeMetric || 'road') === 'road';
    if (wantRoad && navigator.onLine && stops.length <= 100) {
      const onlineDeadline = Date.now() + 15000;
      const remaining = () => Math.max(0, onlineDeadline - Date.now());
      if (ORS_PROXY_URL && stops.length <= 48) {
        status.textContent = t('route_calc_ors');
        try {
          routed = await orsOptimize(settings.base.coords, stops, {
            endpoint: ORS_PROXY_URL,
            priority: prioOn,
            timeoutMs: Math.min(12000, remaining()),
          });
        } catch (e) {
          console.warn('ORS optimization unavailable; falling back:', e?.message || e);
        }
      }
      if (!routed && remaining() > 1000) {
        status.textContent = t('route_calc_road');
        try {
          routed = await roadRoute(settings.base.coords, stops, {
            priority: prioOn,
            timeoutMs: Math.min(6000, remaining()),
          });
        } catch (e) {
          console.warn('OSRM table unavailable; falling back:', e?.message || e);
        }
      }
      if (!routed && remaining() > 1000) {
        try {
          routed = await roadTrip(settings.base.coords, stops, {
            timeoutMs: Math.min(3000, remaining()),
          });
        } catch (e) {
          routed = null;
        }
      }
    }
    if (!routed) routed = computeRoute(settings.base.coords, stops);
    const { orderedIds, totalMeters, provider = 'straight' } = routed;

    // Persist into the unified routeState. A successful build pushes the old current onto
    // previous (so "restore previous route" always has the last full route to swap back to),
    // then stores the freshly computed order as current. `manual:false` = solver output.
    const prevState = await getRouteState();
    const byId = new Map(points.map((p) => [p.id, p]));
    const newCurrent = {
      order: orderedIds.slice(),
      totalMeters,
      provider,
      manual: false,
      computedAt: Date.now(),
      geoSig: routeGeoSig(settings.base.coords, orderedIds.map((id) => byId.get(id)).filter(Boolean)),
    };
    await saveRouteState({ current: newCurrent, previous: prevState.current });

      renderRouteResult(result, points, orderedIds, totalMeters, skippedNoCoord.length, provider, deliveredWithCoords, prevState.current, false, false);
    } finally {
      buildBtn.disabled = false;
    }
  });
}

// ---------- navigation to a stop ----------
function openUrl(url) {
  const a = el('a', { href: url, target: '_blank', rel: 'noopener' });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Open a stop: use the preferred navigator, or show a chooser sheet when 'ask'.
function openNav(coords, label, options = {}) {
  const pref = settings.navigator || 'ask';
  if (pref !== 'ask') {
    openUrl(navigationUrl(pref, coords, label, options));
    return;
  }
  navSheet(coords, label, options);
}

function navSheet(coords, label, options = {}) {
  const overlay = el('div', {
    class: 'sheet-overlay',
    onclick: (e) => { if (e.target === overlay) overlay.remove(); },
  });
  const choose = (key) => { overlay.remove(); openUrl(navigationUrl(key, coords, label, options)); };
  const opt = (icon, text, key) =>
    el('button', { class: 'sheet-opt', onclick: () => choose(key) }, [
      el('span', { class: 'so-ico', text: icon }),
      el('span', { text }),
    ]);
  const sheet = el('div', { class: 'sheet' }, [
    el('div', { class: 'sheet-title', text: label || t('nav_choose_title') }),
    opt('🗺️', t('nav_google'), 'google'),
    opt('🚗', t('nav_waze'), 'waze'),
    opt('🧭', t('nav_other'), 'geo'),
    isIOS() ? opt('🍎', 'Apple Maps', 'apple') : null,
    el('button', { class: 'btn', text: t('close'), onclick: () => overlay.remove() }),
  ]);
  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
}

function renderRouteResult(result, points, orderedIds, totalMeters, skipped, provider, delivered = [], previous = null, manual = false, outdated = false) {
  clear(result);
  const byId = new Map(points.map((p) => [p.id, p]));
  const km = (totalMeters / 1000).toFixed(1);

  result.appendChild(el('p', { class: 'route-sum', text: t('route_summary', { n: orderedIds.length, km }) }));
  // Describe how the shown order was produced. `outdated` = the stop set or coordinates changed
  // since the route was built, so the order was NOT re-optimized — we show a straight-line
  // distance and prompt a rebuild. `manual` = the courier hand-reordered it. Otherwise report
  // the solver that produced it.
  const sourceText = outdated
    ? t('route_by_outdated')
    : (manual
      ? t('route_by_manual')
      : (provider === 'ors'
        ? t('route_by_ors')
        : (provider === 'osrm' ? t('route_by_road') : t('route_by_straight'))));
  result.appendChild(el('p', { class: outdated ? 'warn' : 'hint', text: sourceText }));

  // "Restore previous route" — available whenever a previous saved order exists. Restoring
  // SWAPS current<->previous, so an accidental restore can itself be undone the same way.
  if (previous && Array.isArray(previous.order) && previous.order.length) {
    result.appendChild(el('button', {
      class: 'btn sm route-restore', text: '↩ ' + t('route_restore_prev'),
      onclick: async () => {
        const st = await getRouteState();
        await saveRouteState({ current: st.previous, previous: st.current });
        render();
      },
    }));
  }

  // Hint: press-and-hold a stop to drag it up/down (the list is the single place to edit
  // order; the map only mirrors it).
  if (orderedIds.length > 1) {
    result.appendChild(el('p', { class: 'hint reorder-hint', text: '↕ ' + t('route_reorder_hint') }));
  }

  result.appendChild(el('div', { class: 'stop base', text: `🏁 ${t('route_base')}` }));

  const list = el('div', { class: 'stops-list' });
  orderedIds.forEach((id, i) => {
    const p = byId.get(id);
    list.appendChild(stopButton(p, String(i + 1)));
  });
  result.appendChild(list);

  // Press-and-hold drag reorder. On drop we recompute the loop length by straight-line
  // (a hand-reordered route no longer matches the road solver) and save it as the new
  // current WITHOUT touching `previous`, so "restore previous route" still points at the
  // last solver build. Then re-render (renumbers stops and redraws the map if open).
  enableDragReorder(list, async (newIds) => {
    const base = settings.base?.coords;
    const orderedPts = newIds.map((id) => byId.get(id)).filter(Boolean);
    const meters = loopMeters(base, orderedPts);
    const st = await getRouteState();
    const newCurrent = {
      order: newIds.slice(), totalMeters: meters, provider: 'straight', manual: true,
      computedAt: Date.now(), geoSig: routeGeoSig(base, orderedPts),
    };
    await saveRouteState({ current: newCurrent, previous: st.previous });
    renderRouteResult(result, points, newIds, meters, skipped, 'straight', delivered, st.previous, true, false);
    updateRouteMap(orderedPts);
  });

  result.appendChild(el('div', { class: 'stop base', text: `🏁 ${t('route_base_end')}` }));
  if (skipped > 0) {
    result.appendChild(el('p', { class: 'warn', text: t('route_skipped', { n: skipped }) }));
  }
  renderDeliveredStops(result, delivered);
}

// Drag-to-reorder for the stop list, initiated from a dedicated side handle. Uses Pointer
// Events where available and falls back to Touch events for very old firmware. Deliberately
// NOT HTML5 drag-and-drop (unreliable on Android WebView).
//
// The handle carries `touch-action: none` in CSS, so scrolling is disabled for gestures
// starting on it from the very first touch — the reliable way per the Pointer Events spec
// (flipping touch-action after a long-press can be ignored once the browser has decided the
// gesture is a scroll). A short hold (or a small movement) arms the drag and reveals the
// pulsing arrow hint; because dragging starts on the handle and the address body is a separate
// element, a tap on the address still opens navigation with no ambiguity.
function enableDragReorder(list, onReorder) {
  const HOLD_MS = 180;    // brief hold to reveal the hint; movement also arms immediately
  const MOVE_ARM = 6;     // px of movement on the handle that means "start dragging now"
  let dragging = null;
  let pending = null;     // stop awaiting the hold timer
  let holdTimer = null;
  let armed = false;
  let startY = 0, startX = 0;
  let activeId = null;
  let orderAtArm = null;  // stop ids when the drag armed — to detect "held but not moved"

  const stops = () => Array.from(list.children).filter((n) => n.classList && n.classList.contains('stop'));
  const idsOf = () => stops().map((e) => e.getAttribute('data-pid'));
  const sameOrder = (a, b) => a && b && a.length === b.length && a.every((id, i) => id === b[i]);

  function markEnds() {
    const els = stops();
    els.forEach((e) => e.classList.remove('at-top', 'at-bottom'));
    if (!dragging) return;
    if (dragging === els[0]) dragging.classList.add('at-top');
    if (dragging === els[els.length - 1]) dragging.classList.add('at-bottom');
  }

  function arm(stop) {
    if (armed || !stop) return;
    armed = true;
    dragging = stop;
    orderAtArm = idsOf();
    stop.classList.add('dragging');
    markEnds();
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* ignore */ } }
  }

  function moveTo(clientY) {
    const others = stops().filter((e) => e !== dragging);
    let before = null;
    for (const e of others) {
      const r = e.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { before = e; break; }
    }
    if (before) list.insertBefore(dragging, before);
    else list.appendChild(dragging);
    markEnds();
  }

  function cleanup() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (dragging) dragging.classList.remove('dragging', 'at-top', 'at-bottom');
    dragging = null;
    pending = null;
    armed = false;
    activeId = null;
    orderAtArm = null;
  }

  function finish(commit) {
    // Only report a reorder when the order ACTUALLY changed. A plain press-and-hold (to peek at
    // the arrows) then release must not rewrite the route — otherwise it would needlessly flip
    // it to "manually changed" and replace the real road distance with a straight-line one.
    let ids = null;
    if (armed && commit) {
      const now = idsOf();
      if (!sameOrder(now, orderAtArm)) ids = now;
    }
    cleanup();
    if (ids) onReorder(ids);
  }

  function onDown(clientX, clientY, target, id) {
    const handle = target.closest && target.closest('.drag-handle');
    if (!handle || !list.contains(handle)) return false;
    const stop = handle.closest('.stop');
    if (!stop) return false;
    pending = stop;
    activeId = id;
    startX = clientX; startY = clientY;
    holdTimer = setTimeout(() => arm(pending), HOLD_MS);
    return true;
  }
  function onMove(clientX, clientY, ev) {
    if (!armed) {
      if (pending && (Math.abs(clientY - startY) > MOVE_ARM || Math.abs(clientX - startX) > MOVE_ARM)) {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        arm(pending);
      }
      if (!armed) return;
    }
    if (ev.cancelable) ev.preventDefault();
    moveTo(clientY);
  }

  if (window.PointerEvent) {
    list.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const handle = ev.target.closest && ev.target.closest('.drag-handle');
      if (!handle) return;
      if (onDown(ev.clientX, ev.clientY, ev.target, ev.pointerId)) {
        try { handle.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      }
    });
    list.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== activeId) return;
      onMove(ev.clientX, ev.clientY, ev);
    });
    list.addEventListener('pointerup', (ev) => { if (ev.pointerId === activeId) finish(true); });
    list.addEventListener('pointercancel', (ev) => { if (ev.pointerId === activeId) finish(false); });
  } else {
    // Old-firmware fallback: Touch events. passive:false so preventDefault can stop scroll.
    list.addEventListener('touchstart', (ev) => {
      const tch = ev.changedTouches[0];
      onDown(tch.clientX, tch.clientY, ev.target, tch.identifier);
    }, { passive: true });
    list.addEventListener('touchmove', (ev) => {
      const tch = ev.changedTouches[0];
      if (tch.identifier !== activeId) return;
      onMove(tch.clientX, tch.clientY, ev);
    }, { passive: false });
    list.addEventListener('touchend', (ev) => {
      const tch = ev.changedTouches[0];
      if (tch.identifier === activeId) finish(true);
    });
    list.addEventListener('touchcancel', () => finish(false));
  }
}

// Build one route stop as a BLOCK per address: a tappable header (opens the
// navigator) plus one color-coded row per delivery (parcel / magazine / letter),
// so several items at the same building read as one block with separated items.
// Delivered stops render dimmed (a ✓ instead of a number, address struck through)
// but stay tappable, in case the courier needs to go back for something forgotten.
function stopButton(p, indexLabel) {
  const label = p.address.display || p.address.raw;
  const navLabel = pointNavLabel(p);
  const done = pointStatus(p) === 'done';
  const labels = TYPE_LABELS();

  const head = el('button', {
    class: 'stop-head', onclick: () => openNav(p.coords, navLabel, pointNavOptions(p)),
  }, [
    el('span', { class: 'stop-n', text: done ? '✓' : indexLabel }),
    el('div', { class: 'stop-body' }, [
      el('div', { class: 'stop-addr', text: (p.coordinateSuspicious ? '⚠ ' : '') + label }),
      p.address.city
        ? el('div', { class: 'stop-city', text: `${p.address.postcode} ${p.address.city}`.trim() })
        : null,
    ]),
    el('span', { class: 'stop-go', text: '🧭' }),
  ]);

  // One row per item so each parcel/letter/magazine is visually separated even
  // when several sit at the same address.
  const items = el('div', { class: 'stop-items' },
    p.items.map((it) => {
      const idone = it.status === 'delivered';
      return el('div', { class: `stop-item ${it.type}` + (idone ? ' done' : '') }, [
        el('span', { class: 'si-ico', text: TYPE_EMOJI[it.type] }),
        el('span', { class: 'si-type', text: labels[it.type] }),
        it.note ? el('span', { class: 'si-note', text: it.note }) : null,
        idone ? el('span', { class: 'si-done', text: '✓ ' + t('point_delivered') }) : null,
      ]);
    }),
  );

  // Dedicated drag handle on the side. It carries `touch-action: none` (in CSS) so the browser
  // knows from the very first touch that a gesture starting here must NOT scroll the page —
  // switching touch-action after a long-press is unreliable per the Pointer Events spec. A grip
  // glyph shows it's draggable; while held/dragged it reveals a pulsing move hint. The middle of
  // the list alternates ▲/▼ (both directions possible); the top stop shows only ▼ and the bottom
  // only ▲, driven by CSS via the .at-top/.at-bottom classes the drag handler toggles.
  // Not a real button (no keyboard action), so no button role/tabindex — just a labelled grip.
  const handle = el('div', {
    class: 'drag-handle', 'aria-label': t('route_reorder_hint'),
  }, [
    el('span', { class: 'grip', 'aria-hidden': 'true', text: '⠿' }),
    el('div', { class: 'drag-arrows', 'aria-hidden': 'true' }, [
      el('span', { class: 'arr arr-up', text: '▲' }),
      el('span', { class: 'arr arr-down', text: '▼' }),
    ]),
  ]);

  const stopMain = el('div', { class: 'stop-main' }, [head, items]);
  return el('div', { class: 'stop' + (done ? ' done' : ''), 'data-pid': p.id }, [stopMain, handle]);
}

// Redraw the route line + numbered markers when the order changes. A no-op until the map
// widget is opened (implemented with the Leaflet map); kept as a stable hook so the drag
// handler doesn't need to know whether the map is currently visible. `fit:false` keeps the
// courier's current pan/zoom while the order changes under them.
function updateRouteMap(orderedPoints) {
  if (_routeMap && typeof _routeMap.update === 'function') _routeMap.update(orderedPoints, false);
}
let _routeMap = null;

// Open the full-screen graphical map of the current route. Leaflet is dynamically imported so
// it (and its CSS) only load when the courier actually opens the map.
async function openRouteMap() {
  const base = settings.base?.coords;
  const points = await getPoints();
  const st = await getRouteState();
  const orderedIds = st.current ? reorderStopsFromSaved(points, st.current.order) : [];
  const byId = new Map(points.map((p) => [p.id, p]));
  const ordered = orderedIds.map((id) => byId.get(id)).filter((p) => p && p.coords);

  if (!ordered.length) { toast(t('route_need_points')); return; }

  const mapEl = el('div', { class: 'route-map' });
  const overlay = el('div', { class: 'map-overlay' }, [
    el('div', { class: 'map-bar' }, [
      el('span', { class: 'map-title', text: t('route_map_title') }),
      el('button', { class: 'btn sm', text: '✕ ' + t('close'), onclick: () => close() }),
    ]),
    mapEl,
  ]);
  document.body.appendChild(overlay);

  function close() {
    if (_routeMap && typeof _routeMap.destroy === 'function') _routeMap.destroy();
    _routeMap = null;
    overlay.remove();
  }

  try {
    const { createRouteMap } = await import('./routeMap.js');
    _routeMap = createRouteMap(mapEl, base);
    _routeMap.update(ordered, true); // first draw fits all pins
    // Leaflet needs a size recalc once the container has been laid out in the DOM.
    setTimeout(() => { if (_routeMap) _routeMap.invalidate(); }, 60);
  } catch (e) {
    console.warn('map failed to load:', e);
    close();
    toast(t('route_map_open') + ' — ✕');
  }
}

// Dimmed section listing already-delivered stops (kept visible for orientation).
function renderDeliveredStops(result, delivered) {
  if (!delivered || !delivered.length) return;
  result.appendChild(el('p', { class: 'hint done-sep', text: t('route_done_section', { n: delivered.length }) }));
  for (const p of delivered) result.appendChild(stopButton(p, '✓'));
}
