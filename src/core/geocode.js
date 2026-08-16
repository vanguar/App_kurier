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

// ---- Online geocoding (OpenStreetMap / Nominatim) ----
// Free, no API key. Used when the local district index has no match, so the app
// "just works" like Google Maps. Throttled to respect Nominatim's ~1 req/sec.
let _lastNominatim = 0;
const _geoCache = new Map();

export async function onlineGeocode(parsed) {
  if (!parsed) return null;
  const key = parsed.matchKey || parsed.raw || '';
  if (_geoCache.has(key)) return _geoCache.get(key);

  const wait = 1100 - (Date.now() - _lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastNominatim = Date.now();

  const params = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'de' });
  if (parsed.street && parsed.houseNumber) {
    params.set('street', `${parsed.houseNumber}${parsed.houseLetter || ''} ${parsed.street}`.trim());
    if (parsed.city) params.set('city', parsed.city);
    if (parsed.postcode) params.set('postalcode', parsed.postcode);
  } else {
    params.set('q', parsed.raw || '');
  }

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    const arr = await res.json();
    const hit = Array.isArray(arr) && arr[0];
    const coords = hit ? { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) } : null;
    _geoCache.set(key, coords);
    return coords;
  } catch (e) {
    return null;
  }
}

// Convenience: parse + assess in one call. Falls back to online geocoding
// (unless disabled) when the local index has no coordinates.
export async function geocodeRaw(raw, { online = true } = {}) {
  const parsed = parseAddress(raw);
  const assessment = await assessAddress(parsed);
  if (!assessment.coords && online && navigator.onLine) {
    const coords = await onlineGeocode(parsed);
    if (coords) {
      return { parsed, ...assessment, coords, confidence: 'green', reason: 'online' };
    }
  }
  return { parsed, ...assessment };
}
