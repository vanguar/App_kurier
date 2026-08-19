import { el, clear, toast } from './dom.js';
import { t, setLang, getLang, resolveInitialLang, LANGS } from '../i18n/index.js';
import {
  getSettings, saveSettings, getPoints, putPoint, deletePoint, clearPoints,
  loadAddressIndex, indexCount, resetSettings,
} from '../core/db.js';
import { parseAddress } from '../core/normalizer.js';
import { geocodeRaw, assessAddress, onlineGeocode, geocodeCenter, setGeoBounds, withinBounds, boundsActive } from '../core/geocode.js';
import { addItemAtAddress, makeItem, itemTypeCounts, pointStatus, aggregateCounts, migratePointsV2 } from '../core/matching.js';
import { computeRoute, roadTrip, roadRoute } from '../core/route.js';
import { recognize, cloudRecognize, splitAddresses, splitDeviceScreen, pickReceiverBlock, warmUp } from '../ocr/ocr.js';

let settings = null;
const app = document.getElementById('app');

// ---------- theme ----------
function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolved === 'dark' ? '#0f1319' : '#0b5cff';
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
const SCAN_EMOJI = { parcel: '📦', device: '📱', magazine: '📖', letter: '✉️' };
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
  return el('header', { class: 'appbar' }, [
    el('span', { class: 'brand', text: t('app_title') }),
    el('span', { class: 'lang', text: getLang().toUpperCase() }),
  ]);
}

function nav(active) {
  const item = (hash, key, icon) =>
    el('a', { href: `#/${hash}`, class: 'navitem' + (active === hash ? ' on' : '') }, [
      el('span', { class: 'ico', text: icon }),
      el('span', { class: 'lbl', text: t(key) }),
    ]);
  return el('nav', { class: 'bottomnav' }, [
    item('import', 'nav_import', '📷'),
    item('points', 'nav_points', '📍'),
    item('route', 'nav_route', '🧭'),
    item('settings', 'nav_settings', '⚙️'),
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
      const res = await fetch(`${import.meta.env.BASE_URL}district-index.json`, { cache: 'force-cache' });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      const entries = Array.isArray(data) ? data : data.entries || [];
      const n = await loadAddressIndex(entries);
      await migratePointsV2().catch((e) => console.warn('point migration skipped:', e));
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
}

// ---------- Import / Scan ----------
let importState = { type: 'parcel', rows: [] };

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
  const gKey = g.canonicalId || g.parsed.matchKey || '';
  const existing = new Set(importState.rows.map((r) => r.canonicalId || r.parsed.matchKey).filter(Boolean));
  if (gKey && existing.has(gKey)) { toast(t('import_nothing')); return; }
  importState.rows.push({
    raw: value,
    editStreet: g.parsed.display,
    parsed: g.parsed,
    canonicalId: g.canonicalId,
    canonicalResolved: g.canonicalResolved,
    candidates: g.candidates,
    confidence: g.confidence,
    coords: g.coords,
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
  main.appendChild(section(t('import_title')));

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

  // Type selector
  const typeSel = el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('import_type_label') }),
    el('div', { class: 'langgrid' },
      Object.entries(SCAN_LABELS()).map(([k, label]) =>
        el('button', {
          class: 'chip' + (importState.type === k ? ' on' : ''),
          onclick: () => { importState.type = k; render(); },
        }, `${SCAN_EMOJI[k]} ${label}`),
      ),
    ),
    el('p', { class: 'hint', text: t('scan_note') }),
  ]);
  main.appendChild(typeSel);

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
    // Accumulate across photos (a parcel list may span 2-3 photos), de-duplicating
    // by identity (canonicalId, else matchKey) so overlapping shots don't create doubles.
    const rowKey = (r) => r.canonicalId || r.parsed.matchKey || '';
    const existingKeys = new Set(importState.rows.map(rowKey).filter(Boolean));
    for (const b of blocks) {
      const g = await geocodeRaw(b, { online: settings.onlineGeocode !== false });
      const key = g.canonicalId || g.parsed.matchKey || '';
      if (key && existingKeys.has(key)) continue;
      if (key) existingKeys.add(key);
      importState.rows.push({
        raw: b,
        editStreet: g.parsed.display,
        parsed: g.parsed,
        canonicalId: g.canonicalId,
        canonicalResolved: g.canonicalResolved,
        candidates: g.candidates,
        confidence: g.confidence,
        coords: g.coords,
        suggestion: g.suggestion,
        // An ambiguous address (several index matches) must NOT be auto-selected — the
        // courier has to pick which town first (see the chooser in renderReview).
        selected: g.confidence !== 'red' && !(g.candidates && g.candidates.length),
      });
    }
    render();
  };

  // Two inputs so BOTH options always work: camera opens the camera; file lets
  // you pick a screenshot / gallery image (device choosers vary, so we split them).
  const cameraInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
  const fileInput = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  cameraInput.addEventListener('change', () => { const f = cameraInput.files[0]; cameraInput.value = ''; handleFile(f); });
  fileInput.addEventListener('change', () => { const f = fileInput.files[0]; fileInput.value = ''; handleFile(f); });

  const photoCard = el('div', { class: 'card' }, [
    instruction,
    el('div', { class: 'btnrow' }, [
      el('button', { class: 'btn primary', text: '📷 ' + t('import_take_photo_btn'), onclick: () => cameraInput.click() }),
      el('button', { class: 'btn', text: '🖼️ ' + t('import_pick_file_btn'), onclick: () => fileInput.click() }),
    ]),
    cameraInput,
    fileInput,
    progress,
    importState.rows.length
      ? el('button', {
          class: 'btn danger sm', text: t('import_clear'),
          onclick: () => { importState.rows = []; render(); },
        })
      : null,
  ]);

  // One-time informed consent before any photo can be sent to the cloud OCR. Until the
  // user chooses, the photo buttons are hidden — nothing leaves the device unasked.
  if (settings.ocrConsent == null) {
    const choose = async (engine) => {
      settings = await saveSettings({ ocrConsent: true, ocrEngine: engine });
      render();
    };
    main.appendChild(el('div', { class: 'card' }, [
      el('h3', { class: 'field-label', text: t('ocr_consent_title') }),
      el('p', { class: 'hint', text: t('ocr_consent_body') }),
      el('div', { class: 'btnrow' }, [
        el('button', { class: 'btn primary', text: t('ocr_consent_cloud'), onclick: () => choose('cloud') }),
        el('button', { class: 'btn', text: t('ocr_consent_device'), onclick: () => choose('device') }),
      ]),
    ]));
  } else {
    main.appendChild(photoCard);
  }

  // Manual / voice entry
  const manualInput = el('input', {
    class: 'input', type: 'text',
    placeholder: t('import_manual_placeholder'),
    autocapitalize: 'words', autocomplete: 'off',
  });
  const micBtn = el('button', { class: 'btn' });
  const setMic = (listening) => {
    micBtn.textContent = listening ? '🔴 ' + t('voice_listening') : '🎤 ' + t('voice_start');
    micBtn.disabled = listening;
  };
  setMic(false);
  micBtn.addEventListener('click', () => {
    setMic(true);
    startVoice(manualInput, () => setMic(false));
  });
  const manualCard = el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('import_manual_title') }),
    el('p', { class: 'hint', text: t('import_manual_hint') }),
    manualInput,
    el('div', { class: 'btnrow' }, [
      micBtn,
      el('button', {
        class: 'btn primary', text: t('import_manual_add'),
        onclick: async () => { await addManualRow(manualInput.value); },
      }),
    ]),
  ]);
  main.appendChild(manualCard);

  if (importState.rows.length) main.appendChild(renderReview());
}

function confBadge(conf) {
  const map = { green: t('conf_green'), yellow: t('conf_yellow'), red: t('conf_red') };
  return el('span', { class: `badge ${conf}`, title: map[conf], text: map[conf] });
}

function renderReview() {
  const wrap = el('div', { class: 'card' }, [
    el('h3', { class: 'field-label', text: t('import_review_title') }),
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
                  row.confidence = 'green';
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

  const addBtn = el('button', { class: 'btn primary big', id: 'add-selected' });
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
      await addItemAtAddress(r.parsed, item, { coords: r.coords, verified: true, canonicalId: r.canonicalId, canonicalResolved: r.canonicalResolved });
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
  main.appendChild(section(t('points_title')));
  main.appendChild(statsBar(points));
  if (!points.length) {
    main.appendChild(el('p', { class: 'empty', text: t('points_empty') }));
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

  points.sort((a, b) => (a.routeOrder ?? 1e9) - (b.routeOrder ?? 1e9) || a.createdAt - b.createdAt);

  for (const p of points) {
    main.appendChild(pointCard(p));
  }
}

function statsBar(points) {
  const c = aggregateCounts(points);
  const cell = (icon, label, value, cls) =>
    el('div', { class: `stat ${cls || ''}` }, [
      el('div', { class: 'stat-ico', text: icon }),
      el('div', { class: 'stat-val', text: String(value) }),
      el('div', { class: 'stat-lbl', text: label }),
    ]);
  return el('div', { class: 'card statsbar' }, [
    cell('📦', t('type_parcel'), c.parcel, 'parcel'),
    cell('📖✉️', t('stat_mail'), c.mail, 'mail'),
    cell('Σ', t('stat_total'), c.total, 'total'),
  ]);
}

function pointCard(p) {
  const counts = itemTypeCounts(p);
  const status = pointStatus(p);
  const badges = el('div', { class: 'typebadges' },
    Object.entries(counts).filter(([, n]) => n > 0).map(([type, n]) =>
      el('span', { class: `tb ${type}`, text: `${TYPE_EMOJI[type]} ${n}` }),
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
      }, `+ ${TYPE_EMOJI[type]} ${label}`),
    ),
  );

  return el('div', { class: `card point ${status}` }, [
    el('div', { class: 'point-head' }, [
      el('div', {}, [
        el('div', {
          class: 'addr' + (p.coords ? ' addr-nav' : ''),
          text: (p.coords ? '🧭 ' : '') + (p.address.display || p.address.raw),
          onclick: p.coords ? () => openNav(p.coords, p.address.display || p.address.raw) : null,
        }),
        p.address.city ? el('div', { class: 'city', text: `${p.address.postcode} ${p.address.city}`.trim() }) : null,
        !p.coords ? el('div', { class: 'nocoord', text: '⚠ ' + t('conf_yellow') }) : null,
      ]),
      badges,
    ]),
    items,
    addWrap,
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
    el('span', { class: 'it-type', text: `${TYPE_EMOJI[it.type]} ${TYPE_LABELS()[it.type]}` }),
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

  const buildBtn = el('button', { class: 'btn primary big', text: t('route_build') });
  main.appendChild(buildBtn);
  const result = el('div', {});
  main.appendChild(result);

  buildBtn.addEventListener('click', async () => {
    const points = await getPoints();

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
        status.textContent = t('route_geocoding', { i: i + 1, n: missing.length });
        const p = missing[i];
        const c = await onlineGeocode({ ...p.address, matchKey: p.matchKey });
        if (c) { p.coords = c; p.geocodeStatus = 'matched'; await putPoint(p); }
      }
    }

    // A stop is "priority" if it holds at least one parcel (parcels beat mail on ties).
    const prioOn = settings.parcelPriority !== false;
    const hasParcel = (p) => Array.isArray(p.items) && p.items.some((i) => i.type === 'parcel');
    // Only NOT-fully-delivered points are optimized into the active route. Delivered
    // points drop out of the recalculation (so the count/route reflect what's left)
    // but are still shown, dimmed, so the courier sees where they've already been.
    const deliveredWithCoords = points.filter((p) => p.coords && pointStatus(p) === 'done');
    const stops = points
      .filter((p) => p.coords && pointStatus(p) !== 'done')
      .map((p) => ({ id: p.id, lat: p.coords.lat, lng: p.coords.lng, priority: prioOn && hasParcel(p) }));
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

    // Prefer real-road optimization (OSRM). Fall back to straight-line on error/offline.
    clear(result);
    const status = el('p', { class: 'hint' });
    result.appendChild(status);
    let routed = null;
    const wantRoad = (settings.routeMetric || 'road') === 'road';
    if (wantRoad && navigator.onLine && stops.length <= 100) {
      status.textContent = t('route_calc_road');
      // Prefer the priority-aware road solver (OSRM table + our TSP); if that
      // endpoint fails, fall back to OSRM trip (no priority), then straight-line.
      try {
        routed = await roadRoute(settings.base.coords, stops, { priority: prioOn });
      } catch (e) {
        try {
          routed = await roadTrip(settings.base.coords, stops);
        } catch (e2) {
          routed = null;
        }
      }
    }
    const byRoad = !!routed;
    if (!routed) routed = computeRoute(settings.base.coords, stops);
    const { orderedIds, totalMeters } = routed;

    // persist routeOrder
    const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
    for (const p of points) {
      p.routeOrder = orderMap.has(p.id) ? orderMap.get(p.id) : null;
      await putPoint(p);
    }

    renderRouteResult(result, points, orderedIds, totalMeters, skippedNoCoord.length, byRoad, deliveredWithCoords);
  });
}

// ---------- navigation to a stop ----------
const NAV_URLS = {
  google: ({ lat, lng }) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
  waze: ({ lat, lng }) => `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`,
  geo: ({ lat, lng }, label) => `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(label || '')})`,
  apple: ({ lat, lng }) => `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`,
};

function openUrl(url) {
  const a = el('a', { href: url, target: '_blank', rel: 'noopener' });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Open a stop: use the preferred navigator, or show a chooser sheet when 'ask'.
function openNav(coords, label) {
  const pref = settings.navigator || 'ask';
  if (pref !== 'ask' && NAV_URLS[pref]) {
    openUrl(NAV_URLS[pref](coords, label));
    return;
  }
  navSheet(coords, label);
}

function navSheet(coords, label) {
  const overlay = el('div', {
    class: 'sheet-overlay',
    onclick: (e) => { if (e.target === overlay) overlay.remove(); },
  });
  const choose = (key) => { overlay.remove(); openUrl(NAV_URLS[key](coords, label)); };
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

function renderRouteResult(result, points, orderedIds, totalMeters, skipped, byRoad, delivered = []) {
  clear(result);
  const byId = new Map(points.map((p) => [p.id, p]));
  const km = (totalMeters / 1000).toFixed(1);

  result.appendChild(el('p', { class: 'route-sum', text: t('route_summary', { n: orderedIds.length, km }) }));
  result.appendChild(el('p', { class: 'hint', text: byRoad ? t('route_by_road') : t('route_by_straight') }));
  result.appendChild(el('div', { class: 'stop base', text: `🏁 ${t('route_base')}` }));

  orderedIds.forEach((id, i) => {
    const p = byId.get(id);
    result.appendChild(stopButton(p, String(i + 1)));
  });

  result.appendChild(el('div', { class: 'stop base', text: `🏁 ${t('route_base_end')}` }));
  if (skipped > 0) {
    result.appendChild(el('p', { class: 'warn', text: t('route_skipped', { n: skipped }) }));
  }
  renderDeliveredStops(result, delivered);
}

// Build one route stop as a BLOCK per address: a tappable header (opens the
// navigator) plus one color-coded row per delivery (parcel / magazine / letter),
// so several items at the same building read as one block with separated items.
// Delivered stops render dimmed (a ✓ instead of a number, address struck through)
// but stay tappable, in case the courier needs to go back for something forgotten.
function stopButton(p, indexLabel) {
  const label = p.address.display || p.address.raw;
  const done = pointStatus(p) === 'done';
  const labels = TYPE_LABELS();

  const head = el('button', {
    class: 'stop-head', onclick: () => openNav(p.coords, label),
  }, [
    el('span', { class: 'stop-n', text: done ? '✓' : indexLabel }),
    el('div', { class: 'stop-body' }, [
      el('div', { class: 'stop-addr', text: label }),
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

  return el('div', { class: 'stop' + (done ? ' done' : '') }, [head, items]);
}

// Dimmed section listing already-delivered stops (kept visible for orientation).
function renderDeliveredStops(result, delivered) {
  if (!delivered || !delivered.length) return;
  result.appendChild(el('p', { class: 'hint done-sep', text: t('route_done_section', { n: delivered.length }) }));
  for (const p of delivered) result.appendChild(stopButton(p, '✓'));
}
