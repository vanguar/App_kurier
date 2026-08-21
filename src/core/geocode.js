// Local geocoding + OCR confidence, all offline against the district address index.
import { getIndexEntry, getIndexByLookup, getIndexStreets, indexCount } from './db.js';
import { normalizeStreetName, levenshtein, parseAddress, transliterate } from './normalizer.js';

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

// Collapse duplicate index records that describe the SAME real address (same postcode + city)
// down to one representative, preferring one with valid coordinates. The bundled OSM gazetteer
// stores SEVERAL geometry objects per house — a building polygon, an address node, entrance
// nodes — all at e.g. "Gartenstraße 2, 17109 Demmin". Left unmerged they (a) show the courier
// five IDENTICAL "17109 Demmin" buttons, and (b) break the neighbour auto-resolver: its
// runner-up test (best clearly closer than second) fails when the two closest candidates are
// duplicates of the SAME town at the same distance. Genuine ambiguity (same street+house in
// DIFFERENT towns) still yields one candidate per town.
// Canonical form of a city name for comparing the OCR'd locality against index records:
// transliterate umlauts (Demmin vs Malchín, Lütow vs Luetow), lowercase, keep only letters.
function normalizeCity(name) {
  return transliterate((name || '').toLowerCase()).replace(/[^a-z]/g, '');
}

function dedupeByTown(records) {
  const byTown = new Map();
  for (const r of records) {
    const key = `${r.postcode || ''}|${(r.city || '').toLowerCase().trim()}`;
    const prev = byTown.get(key);
    if (!prev) { byTown.set(key, r); continue; }
    const rHasCoords = typeof r.lat === 'number' && typeof r.lng === 'number';
    const prevHasCoords = typeof prev.lat === 'number' && typeof prev.lng === 'number';
    if (rHasCoords && !prevHasCoords) byTown.set(key, r); // upgrade to a record that can be routed
  }
  return [...byTown.values()];
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
    // Merge duplicate geometry for the same town FIRST, so "one street+house in one town"
    // resolves instead of prompting with a stack of identical buttons.
    let pool = dedupeByTown(matches);
    if (pool.length === 1) {
      return { canonicalId: recordCanonicalId(pool[0]), record: pool[0], candidates: [] };
    }
    // The town is only ambiguous when the OCR DIDN'T capture it. When the card/label shows a
    // locality — a postcode ("17109") and/or a city name ("Demmin") — there is nothing to
    // choose: narrow to that town instead of asking. Postcode first (most specific), then the
    // city name as a fallback for when the postcode was mis-read. A filter that pins exactly
    // one town resolves; one that only trims the list narrows the choices we still offer.
    const narrow = (subset) => {
      if (subset.length === 1) return subset[0]; // pinned exactly -> resolve, no prompt
      if (subset.length > 1) pool = subset;      // fewer towns -> offer only these
      return null;                               // 0 matches (mis-read) -> keep the wider pool
    };
    if (parsed.postcode) {
      const hit = narrow(pool.filter((m) => m.postcode === parsed.postcode));
      if (hit) return { canonicalId: recordCanonicalId(hit), record: hit, candidates: [] };
    }
    if (pool.length > 1 && parsed.city) {
      const c = normalizeCity(parsed.city);
      const hit = narrow(pool.filter((m) => normalizeCity(m.city) === c));
      if (hit) return { canonicalId: recordCanonicalId(hit), record: hit, candidates: [] };
    }
    return { canonicalId: '', record: null, candidates: pool }; // no locality on the scan -> user picks
  }
  return { canonicalId: parsed.matchKey || parsed.lookupKey, record: null, candidates: [] };
}

// Cache the index's normalized street list. assessAddress runs once per UNRESOLVED row, and
// re-reading + re-normalizing the whole ~38k-record index on every call is what froze the
// review screen on a 4-photo batch (cost scaled as rows × index size). Rebuild only when the
// index size changes (a load/reset), keyed off the cheap indexCount().
let _streetNormsCache = null;
let _streetNormsCount = -1;
async function getStreetNorms() {
  const cnt = await indexCount();
  if (_streetNormsCache && _streetNormsCount === cnt) return _streetNormsCache;
  const streets = await getIndexStreets();
  _streetNormsCache = streets.map((s) => ({ raw: s, norm: normalizeStreetName(s) }));
  _streetNormsCount = cnt;
  return _streetNormsCache;
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
  const streetNorms = await getStreetNorms();

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

// Search-area limit. When set, online geocoding is HARD-restricted to a box around a
// centre (the courier's district), so a street name that also exists 300 km away can
// never be returned. Set from Settings via setGeoBounds().
let _geoBounds = null; // { lat, lng, radiusKm }

export function setGeoBounds(b) {
  _geoBounds = (b && typeof b.lat === 'number' && typeof b.lng === 'number' && b.radiusKm > 0)
    ? { lat: b.lat, lng: b.lng, radiusKm: b.radiusKm }
    : null;
  _geoCache.clear(); // a changed area can change results, so drop cached coords
}

export function getGeoBounds() { return _geoBounds; }

// Nominatim viewbox + bounded=1 for the current area (empty object when no limit).
function boundsParams() {
  if (!_geoBounds) return {};
  const { lat, lng, radiusKm } = _geoBounds;
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const left = lng - dLng, right = lng + dLng, top = lat + dLat, bottom = lat - dLat;
  return { viewbox: `${left},${top},${right},${bottom}`, bounded: '1' };
}

async function nominatim(paramsObj, { bounded = true } = {}) {
  const wait = 1100 - (Date.now() - _lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastNominatim = Date.now();
  const limits = bounded ? boundsParams() : {};
  const params = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'de', ...limits, ...paramsObj });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  const arr = await res.json();
  const hit = Array.isArray(arr) && arr[0];
  return hit ? { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) } : null;
}

// Resolve the search-area CENTRE (a typed town/address). Deliberately UNbounded — the
// centre defines the box, so it can't be constrained by itself.
export async function geocodeCenter(raw) {
  const parsed = parseAddress(raw || '');
  const q = [
    parsed.street ? `${parsed.street} ${parsed.houseNumber || ''}${parsed.houseLetter || ''}`.trim() : '',
    parsed.postcode, parsed.city,
  ].filter(Boolean).join(' ').trim() || (raw || '').trim();
  if (!q) return null;
  try { return await nominatim({ q }, { bounded: false }); } catch (e) { return null; }
}

export async function onlineGeocode(parsed) {
  if (!parsed) return null;
  const key = parsed.matchKey || parsed.raw || '';
  if (_geoCache.has(key)) return _geoCache.get(key);

  // Apply the search-area limit ONLY to ambiguous lookups (no postcode). A full
  // "street + PLZ + city" query is already precise, so it must stay UNbounded — otherwise
  // a legitimately far, fully-addressed parcel (e.g. a PAKETLISTE stop in another town)
  // would be wrongly rejected. A postcode-less village name ("Seestrasse 25") is the case
  // that needs bounding, because Nominatim would otherwise grab a same-named street far away.
  const opts = { bounded: !parsed.postcode };
  let coords = null;
  try {
    // 1) structured query (most precise)
    if (parsed.street && parsed.houseNumber) {
      coords = await nominatim({
        street: `${parsed.houseNumber}${parsed.houseLetter || ''} ${parsed.street}`.trim(),
        ...(parsed.city ? { city: parsed.city } : {}),
        ...(parsed.postcode ? { postalcode: parsed.postcode } : {}),
      }, opts);
    }
    // 2) free-text fallback (catches addresses the structured query misses)
    if (!coords) {
      const q = [
        parsed.street ? `${parsed.street} ${parsed.houseNumber || ''}${parsed.houseLetter || ''}`.trim() : '',
        parsed.postcode,
        parsed.city,
      ].filter(Boolean).join(' ').trim() || (parsed.raw || '');
      if (q) coords = await nominatim({ q }, opts);
    }
  } catch (e) {
    coords = null;
  }
  _geoCache.set(key, coords);
  return coords;
}

// Is a coordinate inside the current search area? True when no limit is set. Used to
// re-validate ALREADY-STORED point coords (which may predate the limit) at route time.
export function withinBounds(coords) {
  if (!_geoBounds || !coords || typeof coords.lat !== 'number') return true;
  const { lat, lng, radiusKm } = _geoBounds;
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return Math.abs(coords.lat - lat) <= dLat && Math.abs(coords.lng - lng) <= dLng;
}

export function boundsActive() { return !!_geoBounds; }

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
