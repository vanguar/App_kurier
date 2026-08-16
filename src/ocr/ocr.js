// OCR wrapper around Tesseract.js. Runs fully in the browser (offline once cached).
// German + English trained data covers printed address labels and app screenshots.
import { createWorker } from 'tesseract.js';

let _worker = null;
let _initPromise = null;

async function getWorker(onProgress) {
  if (_worker) return _worker;
  if (!_initPromise) {
    _initPromise = (async () => {
      const worker = await createWorker(['deu', 'eng'], 1, {
        logger: (m) => {
          if (onProgress && m.status === 'recognizing text') onProgress(m.progress);
        },
      });
      _worker = worker;
      return worker;
    })();
  }
  return _initPromise;
}

// Recognize text from an image (File, Blob, data URL, or <img>/<canvas>).
export async function recognize(image, onProgress) {
  const worker = await getWorker(onProgress);
  const { data } = await worker.recognize(image);
  return data.text || '';
}

// Split recognized text into candidate address blocks.
// A screenshot list of parcels usually has one recipient per 1-2 lines; we group by
// blank lines and also treat lines that look like "<street> <number>" as block starts.
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
      // previous block already has a street line -> start a new block
      if (current.some((x) => looksLikeStreet(x))) {
        blocks.push(current.join('\n'));
        current = [];
      }
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join('\n'));

  // Keep only blocks that contain something street-like.
  return blocks.filter((b) => looksLikeStreet(b));
}

export async function terminate() {
  if (_worker) {
    await _worker.terminate();
    _worker = null;
    _initPromise = null;
  }
}
