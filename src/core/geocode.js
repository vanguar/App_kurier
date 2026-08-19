// Local geocoding + OCR confidence, all offline against the district address index.
import { getIndexEntry, getIndexByLookup, getIndexStreets, indexCount } from './db.js';
import { normalizeStreetName, levenshtein, parseAddress } from './normalizer.js';

// Canonicalize an OCR candidate against the district index. This — not "restore the
// PLZ" — is the heart of cross-format identity: a device-screen parcel (no postcode,
// "gehmkow|6") and a letter with a postcode ("gehmkow|6|17111") both resolve to the
// SAME index record and therefore the SAME canonicalId, so their deliveries merge.
//   1 index hit  -> canonicalId from that record's authoritative postcode (+ coords/city)
//   >1 hits      -> same street+house in several towns; caller must let the user choose
//   0 hits       -> unresolved; canonicalId falls back to matchKey|lookupKey (flagged)
//
// The canonicalId of a RESOLVED address is `index:<record.id>` — tied to the exact OSM
// object, NOT to `lookupKey|postcode`. This matters because two different towns can share
// the same street, house AND postcode; `lookupKey|postcode` would collapse them, the OSM
// id never does. Cross-format merge still works: a device parcel (no PLZ) and a letter
// (with PLZ) both resolve to the SAME record, hence the same `index:<id>`.
export function recordCanonicalId(record) {
  return record && record.id != null ? `index:${record.id}` : '';
}

export async function canonicalize(parsed) {
  if (!parsed || !parsed.lookupKey) {
    return { canonicalId: parsed?.matchKey || '', record: null, candidates: [] };
  }
  const matches = await getIndexByLookup(parsed.lookupKey);
  if (matches.length === 1) {
    return { canonicalId: recordCanonicalId(matches[0]), record: matches[0], candidates: [] };
  }
  if (matches.length > 1) {
    // Narrow by the OCR postcode when we have one. Only auto-resolve if it pins EXACTLY
    // one record — if several share that postcode too, it's still ambiguous (user picks).
    let pool = matches;
    if (parsed.postcode) {
      const byPc = matches.filter((m) => m.postcode === parsed.postcode);
      if (byPc.length === 1) return { canonicalId: recordCanonicalId(byPc[0]), record: byPc[0], candidates: [] };
      if (byPc.length > 1) pool = byPc; // narrow the choices we offer
    }
    return { canonicalId: '', record: null, candidates: pool }; // ambiguous -> user picks
  }
  return { canonicalId: parsed.matchKey || parsed.lookupKey, record: null, candidates: [] };
}

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

async function nominatim(paramsObj) {
  const wait = 1100 - (Date.now() - _lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastNominatim = Date.now();
  const params = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'de', ...paramsObj });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  const arr = await res.json();
  const hit = Array.isArray(arr) && arr[0];
  return hit ? { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) } : null;
}

export async function onlineGeocode(parsed) {
  if (!parsed) return null;
  const key = parsed.matchKey || parsed.raw || '';
  if (_geoCache.has(key)) return _geoCache.get(key);

  let coords = null;
  try {
    // 1) structured query (most precise)
    if (parsed.street && parsed.houseNumber) {
      coords = await nominatim({
        street: `${parsed.houseNumber}${parsed.houseLetter || ''} ${parsed.street}`.trim(),
        ...(parsed.city ? { city: parsed.city } : {}),
        ...(parsed.postcode ? { postalcode: parsed.postcode } : {}),
      });
    }
    // 2) free-text fallback (catches addresses the structured query misses)
    if (!coords) {
      const q = [
        parsed.street ? `${parsed.street} ${parsed.houseNumber || ''}${parsed.houseLetter || ''}`.trim() : '',
        parsed.postcode,
        parsed.city,
      ].filter(Boolean).join(' ').trim() || (parsed.raw || '');
      if (q) coords = await nominatim({ q });
    }
  } catch (e) {
    coords = null;
  }
  _geoCache.set(key, coords);
  return coords;
}

// Parse + locate in one call, returning a result-driven confidence:
//   green  — coordinates found (local index or online) -> routable
//   yellow — parsed an address but not verified (offline / online disabled)
//   red    — could not identify/locate an address -> needs a fix
export async function geocodeRaw(raw, { online = true } = {}) {
  const parsed = parseAddress(raw);

  // 1) Canonicalize against the district index first — the authoritative source.
  const canon = await canonicalize(parsed);
  if (canon.record) {
    // The index is AUTHORITATIVE for this street+house: overwrite postcode/city with its
    // values (not just fill blanks). This both completes a device-screen address (no PLZ)
    // AND fixes a stale PLZ left over from editing (old "Dorfstraße 48, PLZ A" -> typed
    // "Seestraße 25" must take Seestraße's PLZ B, never keep A).
    if (canon.record.postcode) parsed.postcode = canon.record.postcode;
    if (canon.record.city) parsed.city = canon.record.city;
    // Keep matchKey (the geocode cache key) consistent with the authoritative postcode.
    if (parsed.lookupKey) {
      parsed.matchKey = parsed.postcode ? `${parsed.lookupKey}|${parsed.postcode}` : parsed.lookupKey;
    }
    return {
      parsed,
      canonicalId: canon.canonicalId,
      canonicalResolved: true, // confirmed by the district index
      coords: { lat: canon.record.lat, lng: canon.record.lng },
      confidence: 'green',
      suggestion: null,
      candidates: [],
      reason: 'index',
    };
  }
  if (canon.candidates.length) {
    // Same street+house in several towns — routable but ambiguous; user must choose.
    return {
      parsed,
      canonicalId: '',
      canonicalResolved: false,
      coords: null,
      confidence: 'yellow',
      suggestion: null,
      candidates: canon.candidates,
      reason: 'ambiguous',
    };
  }

  // 2) Not in the local index — fuzzy assess + optional online geocode.
  const assessment = await assessAddress(parsed);
  let coords = assessment.coords;

  let triedOnline = false;
  if (!coords && parsed.matchKey && online && navigator.onLine) {
    triedOnline = true;
    coords = await onlineGeocode(parsed);
  }

  let confidence;
  if (coords) {
    // A first Nominatim hit for a bare village (no postcode/city to anchor on) is a
    // guess — keep it routable but flag it YELLOW instead of a false-confident green.
    const anchored = assessment.coords || parsed.postcode || parsed.city;
    confidence = anchored ? 'green' : 'yellow';
  } else if (!parsed.matchKey) confidence = 'red'; // no recognizable street+house
  else if (triedOnline) confidence = 'red'; // looked it up, nothing found -> fix it
  else confidence = 'yellow'; // parsed but not verified (offline)

  return {
    parsed,
    canonicalId: canon.canonicalId, // matchKey||lookupKey fallback identity
    canonicalResolved: false, // not index-confirmed -> migration may re-resolve later
    coords: coords || null,
    confidence,
    suggestion: assessment.suggestion,
    candidates: [],
    reason: assessment.reason,
  };
}
