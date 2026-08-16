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

// Recognize text from a photo. onStatus(phase, progress) where phase is
// 'loading' (model) or 'recognizing'.
export async function recognize(file, onStatus) {
  const worker = await getWorker(onStatus);
  const canvas = await preprocessImage(file);
  const { data } = await worker.recognize(canvas);
  return data.text || '';
}

// Split recognized text into candidate address blocks.
export function splitIntoAddressBlocks(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const blocks = [];
  let current = [];
  const looksLikeStreet = (l) => /\d/.test(l) && /[a-zA-ZäöüÄÖÜß]/.test(l);

  for (const line of lines) {
    if (current.length && looksLikeStreet(line)) {
      if (current.some((x) => looksLikeStreet(x))) {
        blocks.push(current.join('\n'));
        current = [];
      }
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join('\n'));

  return blocks.filter((b) => looksLikeStreet(b));
}

export async function terminate() {
  if (_worker) {
    await _worker.terminate();
    _worker = null;
    _initPromise = null;
  }
}
