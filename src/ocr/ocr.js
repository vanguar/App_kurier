// OCR wrapper around Tesseract.js. Runs fully in the browser (offline once cached).
// Speed/quality tactics:
//   - German-only model ('deu') — half the load/work of deu+eng
//   - downscale + grayscale + contrast-stretch the photo before OCR (phone photos
//     are ~12MP; feeding full-res is the #1 cause of slowness)
//   - page-segmentation mode tuned for a block/column of address lines
//   - warm the worker up-front so the model download isn't paid mid-scan
import { createWorker } from 'tesseract.js';

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
  const lines = (data.lines || []).map((l) => ({
    text: (l.text || '').trim(),
    top: l.bbox ? l.bbox.y0 : 0,
    height: l.bbox ? (l.bbox.y1 - l.bbox.y0) : 0,
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
      lines.push({
        text: (ln.LineText || '').trim(),
        top: typeof ln.MinTop === 'number' ? ln.MinTop : 0,
        height: typeof ln.MaxHeight === 'number' ? ln.MaxHeight : 0,
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
  const hasStreetish = (b) => /[a-zA-ZäöüÄÖÜß]/.test(b) && /\d/.test(b);

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

  return blocks.filter(hasStreetish);
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
  const hasStreetish = (b) => /[a-zA-ZäöüÄÖÜß]/.test(b) && /\d/.test(b);

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

  return blocks.filter(hasStreetish);
}

export async function terminate() {
  if (_worker) {
    await _worker.terminate();
    _worker = null;
    _initPromise = null;
  }
}
