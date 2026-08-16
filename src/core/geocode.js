// Local geocoding + OCR confidence, all offline against the district address index.
import { getIndexEntry, getIndexStreets, indexCount } from './db.js';
import { normalizeStreetName, levenshtein, parseAddress } from './normalizer.js';

// Confidence levels for the review screen:
//   green  — street + house exist in the index  -> coords known
//   yellow — street exists but this house number not in index (plausible)
//   red    — street not found -> likely OCR error, suggest nearest street
export async function assessAddress(parsed) {
  const haveIndex = (await indexCount()) > 0;
  if (!parsed.matchKey) {
    return { confidence: 'red', coords: null, suggestion: null, reason: 'unparsed' };
  }

  const entry = await getIndexEntry(parsed.matchKey);
  if (entry) {
    return {
      confidence: 'green',
      coords: { lat: entry.lat, lng: entry.lng },
      suggestion: null,
      reason: 'exact',
    };
  }

  if (!haveIndex) {
    // No district index loaded yet — cannot verify, treat as yellow (accept but flag).
    return { confidence: 'yellow', coords: null, suggestion: null, reason: 'no-index' };
  }

  // Street exists in index but not this house number?
  const normStreet = normalizeStreetName(parsed.street);
  const streets = await getIndexStreets();
  const streetNorms = streets.map((s) => ({ raw: s, norm: normalizeStreetName(s) }));

  if (streetNorms.some((s) => s.norm === normStreet)) {
    return { confidence: 'yellow', coords: null, suggestion: null, reason: 'house-missing' };
  }

  // Street not found -> nearest by edit distance.
  let best = null;
  for (const s of streetNorms) {
    const d = levenshtein(normStreet, s.norm);
    if (!best || d < best.dist) best = { dist: d, raw: s.raw };
  }
  const suggestion = best && best.dist <= Math.max(2, Math.floor(normStreet.length * 0.3)) ? best.raw : null;
  return { confidence: 'red', coords: null, suggestion, reason: 'street-missing' };
}

// Convenience: parse + assess in one call.
export async function geocodeRaw(raw) {
  const parsed = parseAddress(raw);
  const assessment = await assessAddress(parsed);
  return { parsed, ...assessment };
}
