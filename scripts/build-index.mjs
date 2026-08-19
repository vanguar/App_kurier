// Build the district address index from an OpenStreetMap Overpass export.
//
// One-time data step (free, offline afterwards). Steps:
//
// 1) Go to https://overpass-turbo.eu, zoom to YOUR delivery district, run this query.
//    IMPORTANT: rural villages (Törpin, Gehmkow, Hof Peeneland …) often have NO named
//    street — their houses are tagged with `addr:place` (the hamlet name) instead of
//    `addr:street`. The courier-device screen shows exactly these, so we must pull BOTH:
//
//      [out:json][timeout:90];
//      (
//        node["addr:housenumber"]["addr:street"]({{bbox}});
//        way["addr:housenumber"]["addr:street"]({{bbox}});
//        node["addr:housenumber"]["addr:place"]({{bbox}});
//        way["addr:housenumber"]["addr:place"]({{bbox}});
//      );
//      out center;
//
// 2) Export -> "raw data / GeoJSON" is fine, but easiest: Export -> "raw OSM data (JSON)".
//    Save it as overpass.json next to this script.
//
// 3) Run:  node scripts/build-index.mjs overpass.json public-index.json
//
// 4) In the app: Settings -> "Load index file (.json)" -> pick public-index.json.
//
// Street names are public map data (not personal data), so this file is safe to keep/host.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseAddress } from '../src/core/normalizer.js';

const [, , inPath, outPath = 'public-index.json'] = process.argv;
if (!inPath) {
  console.error('Usage: node scripts/build-index.mjs <overpass.json> [out.json]');
  process.exit(1);
}

const data = JSON.parse(readFileSync(inPath, 'utf8'));
const elements = data.elements || [];

const byKey = new Map();
for (const e of elements) {
  const tags = e.tags || {};
  // Prefer a named street; fall back to the hamlet/place name for street-less villages.
  const street = tags['addr:street'] || tags['addr:place'];
  const addressKind = tags['addr:street'] ? 'street' : (tags['addr:place'] ? 'place' : '');
  const house = tags['addr:housenumber'];
  if (!street || !house) continue;

  const lat = e.lat ?? e.center?.lat;
  const lng = e.lon ?? e.center?.lon;
  if (typeof lat !== 'number' || typeof lng !== 'number') continue;

  // Feed the postcode/city too so the full matchKey stays postcode-aware (same
  // street+house in different towns must stay distinct). But a MISSING postcode must
  // NOT drop the record — many rural OSM elements carry no addr:postcode (Nominatim
  // derives it from context). We keep them and rely on lookupKey (street|house) instead.
  const pc = tags['addr:postcode'] || '';
  const town = tags['addr:city'] || '';
  const parsed = parseAddress(`${street} ${house}\n${pc} ${town}`.trim());
  if (!parsed.lookupKey) continue;

  // Stable unique id from the OSM object (type + id). Dedupe on THIS, not on matchKey:
  // two distinct real places that share a postcode-less lookupKey must BOTH survive so
  // the app can offer a choice (previously one silently overwrote the other).
  const osmType = e.type || '';
  const osmId = e.id ?? '';
  const id = (osmType && osmId !== '') ? `${osmType}/${osmId}` : `${parsed.matchKey || parsed.lookupKey}@${lat},${lng}`;
  if (byKey.has(id)) continue; // same OSM object twice (node + way) -> keep first
  byKey.set(id, {
    id,
    osmType,
    osmId,
    matchKey: parsed.matchKey,     // full (may equal lookupKey when no postcode)
    lookupKey: parsed.lookupKey,   // postcode-free search key
    addressKind,                   // 'street' | 'place'
    street,
    houseNumber: parsed.houseNumber + parsed.houseLetter,
    postcode: pc,
    city: town,
    lat,
    lng,
  });
}

const out = [...byKey.values()];
writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${out.length} addresses to ${outPath}`);
