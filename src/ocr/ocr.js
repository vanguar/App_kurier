// OCR wrapper around Tesseract.js. Runs fully in the browser (offline once cached).
// Speed/quality tactics:
//   - German-only model ('deu') — half the load/work of deu+eng
//   - downscale + grayscale + contrast-stretch the photo before OCR (phone photos
//     are ~12MP; feeding full-res is the #1 cause of slowness)
//   - page-segmentation mode tuned for a block/column of address lines
//   - warm the worker up-front so the model download isn't paid mid-scan
import { createWorker } from 'tesseract.js';
import { isAddressBlock } from '../core/normalizer.js';

let _worker = null;
let _initPromise = null;

async function getWorker(onStatus) {
  if (_worker) return _worker;
  if (!_initPromise) {
    _initPromise = (async () => {
      const worker = await createWorker('deu', 1, {
        logger: (m) => {
          if (!onStatus) return;
          if (m.status === 'recognizing text') onStatus('recognizing', m.progress);
          else onStatus('loading', m.progress); // downloading/initializing model
        },
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '6', // assume a single uniform block of text
        preserve_interword_spaces: '1',
      });
      _worker = worker;
      return worker;
    })();
  }
  return _initPromise;
}

// Kick off model loading early (call when the Scan screen opens).
export function warmUp(onStatus) {
  return getWorker(onStatus);
}

// Downscale + grayscale + contrast-stretch a photo for faster, cleaner OCR.
export async function preprocessImage(file, maxDim = 2000) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    let y = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    y = ((y - min) / range) * 255; // stretch contrast to full range
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Recognize text from a photo. Returns { text, lines } where each line carries
// its vertical position (for visual splitting). onStatus(phase, progress).
export async function recognize(file, onStatus) {
  const worker = await getWorker(onStatus);
  const canvas = await preprocessImage(file);
  const { data } = await worker.recognize(canvas);
  // Keep FULL geometry (x/y/w/h) + confidence per line. Horizontal position lets the
  // device-screen extractor drop the right-hand route-code column; confidence powers
  // diagnostics. Vertical position still drives visual gap splitting.
  const lines = (data.lines || []).map((l) => ({
    text: (l.text || '').trim(),
    top: l.bbox ? l.bbox.y0 : 0,
    height: l.bbox ? (l.bbox.y1 - l.bbox.y0) : 0,
    left: l.bbox ? l.bbox.x0 : 0,
    width: l.bbox ? (l.bbox.x1 - l.bbox.x0) : 0,
    confidence: typeof l.confidence === 'number' ? l.confidence : null,
  }));
  return { text: data.text || '', lines };
}

// Downscale + JPEG-compress a photo, keeping color, for upload to a cloud OCR.
// Keeps the request small (OCR.space free tier caps uploads at ~1 MB).
async function downscaleToBlob(file, maxDim = 1600, quality = 0.7) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// Cloud OCR via OCR.space (free API key, German model, high accuracy).
// Get a free key at https://ocr.space/ocrapi/freekey
// Returns { text, lines } — lines carry vertical position (MinTop/MaxHeight from
// the text overlay) so a parcel list can be split on visual gaps, not just PLZ.
export async function cloudRecognize(file, apiKey) {
  const blob = await downscaleToBlob(file);
  const form = new FormData();
  form.append('apikey', apiKey || 'helloworld');
  form.append('language', 'ger');
  form.append('OCREngine', '2'); // best general engine
  form.append('scale', 'true');
  form.append('detectOrientation', 'true');
  form.append('isTable', 'false');
  form.append('isOverlayRequired', 'true'); // needed for per-line coordinates
  form.append('file', blob, 'scan.jpg');

  const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form });
  const data = await res.json();
  if (data.IsErroredOnProcessing) {
    const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join(' ') : (data.ErrorMessage || 'OCR error');
    throw new Error(msg);
  }
  const results = data.ParsedResults || [];
  const text = results.map((r) => r.ParsedText || '').join('\n');
  const lines = [];
  for (const r of results) {
    const overlay = r.TextOverlay && r.TextOverlay.Lines;
    if (!Array.isArray(overlay)) continue;
    for (const ln of overlay) {
      // Derive horizontal extent from the line's words (OCR.space gives per-word
      // Left/Width, no line-level Left). Left/width let us drop the right route-code column.
      const words = Array.isArray(ln.Words) ? ln.Words : [];
      let left = 0;
      let width = 0;
      let conf = null;
      if (words.length) {
        const lefts = words.map((w) => (typeof w.Left === 'number' ? w.Left : 0));
        const rights = words.map((w) => (typeof w.Left === 'number' ? w.Left : 0) + (typeof w.Width === 'number' ? w.Width : 0));
        left = Math.min(...lefts);
        width = Math.max(...rights) - left;
      }
      lines.push({
        text: (ln.LineText || '').trim(),
        top: typeof ln.MinTop === 'number' ? ln.MinTop : 0,
        height: typeof ln.MaxHeight === 'number' ? ln.MaxHeight : 0,
        left,
        width,
        confidence: conf,
      });
    }
  }
  return { text, lines };
}

// Split recognized text (a parcel LIST) into one block per recipient.
// A German address ends with its postcode line (5-digit PLZ), so we group all
// lines up to and including a postcode line into one address — this keeps
// "Ernst-Thälmann-Str" and "18465 Tribsees" together instead of splitting them.
export function splitIntoAddressBlocks(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const isPostcodeLine = (l) => /\b\d{5}\b/.test(l);

  const blocks = [];
  let current = [];
  for (const line of lines) {
    current.push(line);
    if (isPostcodeLine(line)) {
      blocks.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length) blocks.push(current.join('\n'));

  return blocks.filter(isAddressBlock);
}

// Smarter list splitter that uses TWO markers to be sure where one address ends:
//   1) the postcode line (5-digit PLZ) — the textual end of a German address, and
//   2) a large VISUAL vertical gap between lines — official-app lists separate
//      recipients with extra whitespace, so a gap noticeably bigger than the normal
//      line spacing marks a boundary even when a PLZ was mis-read.
// `lines` are positioned rows ({text, top, height}) from recognize()/cloudRecognize().
// Falls back to postcode-only splitting when no geometry is available.
export function splitAddresses(text, lines) {
  const positioned = (lines || []).filter(
    (l) => l && typeof l.top === 'number' && (l.text || '').trim().length,
  );
  if (positioned.length < 2) return splitIntoAddressBlocks(text);

  const L = positioned
    .map((l) => ({ text: l.text.trim(), top: l.top, height: l.height || 0 }))
    .sort((a, b) => a.top - b.top);

  const isPostcodeLine = (l) => /\b\d{5}\b/.test(l);

  // Gap between consecutive lines = top of next minus bottom of current.
  const gaps = [];
  for (let i = 0; i < L.length - 1; i++) {
    gaps.push(Math.max(0, L[i + 1].top - (L[i].top + L[i].height)));
  }
  const median = (arr) => {
    const s = arr.filter((v) => v > 0).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const medGap = median(gaps);
  const medHeight = median(L.map((l) => l.height));
  // A boundary gap is clearly larger than the normal in-address line spacing.
  const gapThreshold = Math.max(medGap * 1.8, medHeight * 0.8);
  // Only trust gaps on a real list (protects a single-address parcel photo, where
  // any accidental gap must not shatter one address into several).
  const useGaps = L.length >= 6 && gapThreshold > 0;

  const blocks = [];
  let current = [];
  for (let i = 0; i < L.length; i++) {
    current.push(L[i].text);
    const endsOnPostcode = isPostcodeLine(L[i].text);
    const bigGapAfter = useGaps && i < L.length - 1 && gaps[i] > gapThreshold;
    if (endsOnPostcode || bigGapAfter) {
      blocks.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length) blocks.push(current.join('\n'));

  return blocks.filter(isAddressBlock);
}

// --- Courier-device screen extractor ---------------------------------------
// The official courier app (a rugged handheld) lists deliveries as CARDS, not as a
// postal list: each card is `Street House` (bold) then the recipient name, plus UI
// chrome (search box, bottom nav, a right-hand route-code column like "81-11", small
// count badges, a "Готово 24/56" progress line). There is NO postcode. So neither the
// PLZ delimiter nor the visual-gap heuristic in splitAddresses() fits — we split on the
// START of each address instead (a `<name> <house>` line), and scrub the chrome first.

// A route code: two short numbers joined by a dash ("81-11"), on its own or glued right.
const ROUTE_CODE_ONLY = /^\s*\d{1,3}\s*[-–]\s*\d{1,3}\s*$/;
// UI chrome / progress / nav labels (German + Russian + English). Whole-line matches.
// Includes the device screen HEADER ("Tour 705") and the two list TABS ("Unsortiert (23)",
// "Sortiert (0)") — these are the courier's own tour title, not a delivery address, so they
// must never become a red "address" row.
const DEVICE_CHROME = /^(q?\s*(поиск|search|suche)|остановки|информация|настройки|stops|info(rmation)?|settings|einstellungen|fertig|готово|gotowe|zrobione|tour|(un)?sortiert|adressen|karte|map|адреса|карта)\b/i;
// A progress counter like "24/56" or "Готово 24 / 56".
const COUNTER = /\b\d{1,4}\s*\/\s*\d{1,4}\b/;

// Drop a route code glued to the RIGHT of an address ("Törpin 79 81-11" -> "Törpin 79").
// Only when a real house number already precedes it, so a genuine range ("12-14") stays.
function stripTrailingRouteCode(line) {
  return line.replace(/^(.*\d+[a-zA-Z]?)\s+\d{1,3}\s*[-–]\s*\d{1,3}\s*$/, '$1').trim();
}

// Is this line pure UI noise (chrome, a counter, a route code, a bare badge number)?
function isDeviceNoise(line) {
  const s = line.trim();
  if (!s) return true;
  if (ROUTE_CODE_ONLY.test(s)) return true;
  if (DEVICE_CHROME.test(s)) return true;
  if (COUNTER.test(s) && !/[a-zA-ZäöüÄÖÜß]/.test(s.replace(COUNTER, ''))) return true;
  if (/^\d{1,2}$/.test(s)) return true; // lone count badge "1"
  if (!/[a-zA-Z0-9äöüÄÖÜß]/.test(s)) return true; // icons / punctuation only
  return false;
}

// Does the line look like the START of a card — an address "<name…> <house>"?
// House = trailing number (+ optional letter), and there must be a real name before it.
function isAddressStart(line) {
  const s = stripTrailingRouteCode(line);
  const m = s.match(/^(.+?)[\s.,]*\d+\s*[a-zA-Z]?$/);
  if (!m) return false;
  const name = m[1].replace(/[^a-zA-ZäöüÄÖÜß]/g, '');
  return name.length >= 2; // "Törpin", "Gehmkow", "Am Markt" — but not a bare number
}

// Split a courier-device screen into one block per card. Geometry optional; when line
// `left`/`width` are present, a short line sitting in the far-RIGHT column (the route-code
// column, e.g. "81-11") is dropped by position even if it wasn't caught textually.
export function splitDeviceScreen(text, lines) {
  const positioned = (lines || []).filter((l) => l && (l.text || '').trim().length);
  const haveGeom = positioned.length && positioned.some((l) => (l.width || 0) > 0);

  // Right-column threshold: the address column starts at the left; a code column sits to
  // the right. Anything whose LEFT edge is past ~62% of the widest content is right-column.
  let rightCut = Infinity;
  if (haveGeom) {
    const minLeft = Math.min(...positioned.map((l) => l.left || 0));
    const maxRight = Math.max(...positioned.map((l) => (l.left || 0) + (l.width || 0)));
    // Measure from the content's OWN left edge, not absolute 0 (a screenshot may be
    // inset/cropped), so the right route-code column is found relative to the card area.
    rightCut = minLeft + (maxRight - minLeft) * 0.62;
  }

  const rows = positioned.length
    ? positioned.slice().sort((a, b) => (a.top || 0) - (b.top || 0))
    : text.split('\n').map((l) => ({ text: l.trim(), left: 0, width: 0 })).filter((l) => l.text);

  const blocks = [];
  let current = [];
  const flush = () => { if (current.length) blocks.push(current.join('\n')); current = []; };

  for (const row of rows) {
    const raw = (row.text || '').trim();
    // Geometry drop: a short line parked in the right column is a route code / badge.
    if (haveGeom && (row.left || 0) > rightCut && raw.replace(/[^a-zA-ZäöüÄÖÜß]/g, '').length < 3) continue;
    if (isDeviceNoise(raw)) continue;
    const line = stripTrailingRouteCode(raw);
    if (isAddressStart(line)) {
      flush();            // a new card begins
      current.push(line);
    } else if (current.length) {
      current.push(line); // recipient name / continuation of the current card
    }
    // a stray non-address line before the first card is ignored
  }
  flush();

  return blocks.filter(isAddressBlock);
}

// --- Letter / magazine: pick the RECIPIENT block ----------------------------
// A letter often prints the SENDER on top (small) and the recipient below. The old
// "first block that has a postcode" rule could route to the sender. Instead we score
// each candidate block and pick the recipient: sender markers penalise, recipient
// markers reward, and on a tie we prefer the LOWER block (recipients sit below senders).
const SENDER_HINT = /\b(absender|abs\.?|retoure|r(ü|ue)cksende\w*|return(\s|-)?to|sender)\b/i;
const RECIPIENT_HINT = /\b(empf(ä|ae)nger|z\.?\s?h(d)?\.?|zu\s?h(ä|ae)nden|an:\s|herr(n)?|frau|familie|firma)\b/i;

export function pickReceiverBlock(blocks) {
  const list = (blocks || []).filter((b) => b && b.trim());
  if (!list.length) return null;
  let best = list[0];
  let bestScore = -Infinity;
  list.forEach((b) => {
    let s = 0;
    if (/\b\d{5}\b/.test(b)) s += 3;          // a full address ends in a postcode
    if (SENDER_HINT.test(b)) s -= 10;         // this is the sender — avoid
    if (RECIPIENT_HINT.test(b)) s += 5;       // explicit recipient marker
    if (/[a-zäöüß].*\d/i.test(b)) s += 1;     // has a street-ish line
    s += Math.min((b.match(/\n/g) || []).length, 3) * 0.5; // fuller block
    if (s >= bestScore) { bestScore = s; best = b; } // tie -> prefer lower block
  });
  return best;
}

export async function terminate() {
  if (_worker) {
    await _worker.terminate();
    _worker = null;
    _initPromise = null;
  }
}
