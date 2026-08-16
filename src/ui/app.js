import { el, clear, toast } from './dom.js';
import { t, setLang, getLang, resolveInitialLang, LANGS } from '../i18n/index.js';
import {
  getSettings, saveSettings, getPoints, putPoint, deletePoint, clearPoints,
  loadAddressIndex, indexCount, resetSettings,
} from '../core/db.js';
import { parseAddress } from '../core/normalizer.js';
import { geocodeRaw, assessAddress } from '../core/geocode.js';
import { addItemAtAddress, makeItem, itemTypeCounts, pointStatus, aggregateCounts } from '../core/matching.js';
import { computeRoute } from '../core/route.js';
import { recognize, cloudRecognize, splitIntoAddressBlocks, warmUp } from '../ocr/ocr.js';

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

// Resolve coordinates for the Base address. Try the local district index; if not
// found, keep the previously known depot coords when the address is unchanged
// (the depot often sits outside the delivery district the index covers).
async function resolveBaseCoords(raw) {
  const parsed = parseAddress(raw);
  const geo = await assessAddress(parsed);
  if (geo.coords) return geo.coords;
  const prev = settings.base;
  if (prev?.coords && prev.address?.raw === raw) return prev.coords;
  return null;
}

const TYPE_LABELS = () => ({
  parcel: t('type_parcel'),
  magazine: t('type_magazine'),
  letter: t('type_letter'),
});
const TYPE_EMOJI = { parcel: '📦', magazine: '📖', letter: '✉️' };

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
      toast(t('settings_index_loaded', { n }));
      render();
    } catch (e) {
      toast('JSON error');
    }
  });
  const idxCard = el('div', { class: 'card' }, [
    el('label', { class: 'field-label', text: t('settings_index') }),
    el('p', { class: cnt ? 'ok' : 'hint',
      text: cnt ? t('settings_index_loaded', { n: cnt }) : t('settings_index_empty') }),
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

// Add a typed/dictated address into the review list (same flow as OCR results).
async function addManualRow(raw) {
  const value = (raw || '').trim();
  if (!value) return;
  const g = await geocodeRaw(value);
  const existing = new Set(importState.rows.map((r) => r.parsed.matchKey).filter(Boolean));
  if (g.parsed.matchKey && existing.has(g.parsed.matchKey)) { toast(t('import_nothing')); return; }
  importState.rows.push({
    raw: value,
    editStreet: g.parsed.display,
    parsed: g.parsed,
    confidence: g.confidence,
    coords: g.coords,
    suggestion: g.suggestion,
    selected: true,
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
      Object.entries(TYPE_LABELS()).map(([k, label]) =>
        el('button', {
          class: 'chip' + (importState.type === k ? ' on' : ''),
          onclick: () => { importState.type = k; render(); },
        }, `${TYPE_EMOJI[k]} ${label}`),
      ),
    ),
  ]);
  main.appendChild(typeSel);

  // Parcels arrive as an on-screen LIST -> pick a screenshot/file (no forced camera).
  // Mail (magazine/letter) is physical, ONE address -> open the camera directly.
  const isList = importState.type === 'parcel';
  const photo = el('input', isList
    ? { type: 'file', accept: 'image/*', class: 'hidden' }
    : { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
  const instruction = el('p', { class: 'hint', text: isList ? t('import_hint_parcel') : t('import_hint_mail') });
  const progress = el('p', { class: 'hint', id: 'ocr-status', text: '' }); // OCR status only
  photo.addEventListener('change', async () => {
    const f = photo.files[0];
    if (!f) return;
    let text = '';
    try {
      if (useCloud) {
        progress.textContent = t('import_recognizing_cloud');
        text = await cloudRecognize(f, settings.ocrApiKey);
      } else {
        progress.textContent = t('import_loading_engine', { p: 0 });
        text = await recognize(f, (phase, p) => {
          progress.textContent = phase === 'recognizing'
            ? t('import_recognizing', { p: Math.round(p * 100) })
            : t('import_loading_engine', { p: Math.round(p * 100) });
        });
      }
    } catch (e) {
      progress.textContent = (useCloud ? 'Cloud OCR: ' : 'OCR: ') + (e && e.message ? e.message : 'error');
      return;
    }
    // PARCEL photo = a LIST -> split into many addresses.
    // MAGAZINE/LETTER photo = exactly ONE address -> never split.
    const blocks = isList
      ? splitIntoAddressBlocks(text)
      : (text.trim() ? [text.trim()] : []);
    photo.value = ''; // allow re-picking the same file / taking the next photo
    if (!blocks.length) {
      progress.textContent = t('import_no_text');
      render();
      return;
    }
    // Accumulate across photos (a parcel list may span 2-3 photos), de-duplicating
    // by matchKey so overlapping shots don't create doubles.
    const existingKeys = new Set(importState.rows.map((r) => r.parsed.matchKey).filter(Boolean));
    let added = 0;
    for (const b of blocks) {
      const g = await geocodeRaw(b);
      if (g.parsed.matchKey && existingKeys.has(g.parsed.matchKey)) continue;
      if (g.parsed.matchKey) existingKeys.add(g.parsed.matchKey);
      importState.rows.push({
        raw: b,
        editStreet: g.parsed.display,
        parsed: g.parsed,
        confidence: g.confidence,
        coords: g.coords,
        suggestion: g.suggestion,
        selected: g.confidence !== 'red',
      });
      added++;
    }
    render();
  });

  const btnLabel = isList ? t('import_btn_parcel') : t('import_btn_mail');
  const photoCard = el('div', { class: 'card' }, [
    el('button', {
      class: 'btn primary big',
      text: (importState.rows.length ? '+ ' : '') + btnLabel,
      onclick: () => photo.click(),
    }),
    photo,
    instruction,
    progress,
    importState.rows.length
      ? el('button', {
          class: 'btn danger sm', text: t('import_clear'),
          onclick: () => { importState.rows = []; render(); },
        })
      : null,
  ]);
  main.appendChild(photoCard);

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
      const g = await geocodeRaw(streetInput.value);
      row.parsed = g.parsed;
      row.confidence = g.confidence;
      row.coords = g.coords;
      row.suggestion = g.suggestion;
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
                const g = await geocodeRaw(streetInput.value);
                row.parsed = g.parsed; row.confidence = g.confidence;
                row.coords = g.coords; row.suggestion = g.suggestion;
                render();
              },
            })
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
    const chosen = importState.rows.filter((r) => r.selected && r.parsed.matchKey);
    if (!chosen.length) { toast(t('import_nothing')); return; }
    for (const r of chosen) {
      const item = makeItem({ type: importState.type, source: 'ocr', rawText: r.raw });
      await addItemAtAddress(r.parsed, item, { coords: r.coords, verified: true });
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
  main.appendChild(el('p', { class: 'hint', text: t('points_count', { n: points.length }) }));

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
  return el('label', { class: 'itemrow' + (done ? ' done' : '') }, [
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
    const stops = points
      .filter((p) => p.coords)
      .map((p) => ({ id: p.id, lat: p.coords.lat, lng: p.coords.lng }));
    const skippedNoCoord = points.filter((p) => !p.coords);

    if (!stops.length) {
      clear(result);
      result.appendChild(el('p', { class: 'warn', text: t('route_need_points') }));
      return;
    }

    const { orderedIds, totalMeters } = computeRoute(settings.base.coords, stops);

    // persist routeOrder
    const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
    for (const p of points) {
      p.routeOrder = orderMap.has(p.id) ? orderMap.get(p.id) : null;
      await putPoint(p);
    }

    renderRouteResult(result, points, orderedIds, totalMeters, skippedNoCoord.length);
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

function renderRouteResult(result, points, orderedIds, totalMeters, skipped) {
  clear(result);
  const byId = new Map(points.map((p) => [p.id, p]));
  const km = (totalMeters / 1000).toFixed(1);

  result.appendChild(el('p', { class: 'route-sum', text: t('route_summary', { n: orderedIds.length, km }) }));
  result.appendChild(el('div', { class: 'stop base', text: `🏁 ${t('route_base')}` }));

  orderedIds.forEach((id, i) => {
    const p = byId.get(id);
    const counts = itemTypeCounts(p);
    const badges = Object.entries(counts).filter(([, n]) => n > 0)
      .map(([type, n]) => `${TYPE_EMOJI[type]}${n}`).join(' ');
    const label = p.address.display || p.address.raw;
    result.appendChild(el('button', {
      class: 'stop', onclick: () => openNav(p.coords, label),
    }, [
      el('span', { class: 'stop-n', text: String(i + 1) }),
      el('div', { class: 'stop-body' }, [
        el('div', { class: 'stop-addr', text: label }),
        el('div', { class: 'stop-badges', text: badges }),
      ]),
      el('span', { class: 'stop-go', text: '🧭' }),
    ]));
  });

  result.appendChild(el('div', { class: 'stop base', text: `🏁 ${t('route_base_end')}` }));
  if (skipped > 0) {
    result.appendChild(el('p', { class: 'warn', text: t('route_skipped', { n: skipped }) }));
  }
}
