// Build the district address index from an OpenStreetMap Overpass export.
//
// One-time data step (free, offline afterwards). Steps:
//
// 1) Go to https://overpass-turbo.eu, zoom to YOUR delivery district, run this query:
//
//      [out:json][timeout:60];
//      (
//        node["addr:housenumber"]["addr:street"]({{bbox}});
//        way["addr:housenumber"]["addr:street"]({{bbox}});
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
  const street = tags['addr:street'];
  const house = tags['addr:housenumber'];
  if (!street || !house) continue;

  const lat = e.lat ?? e.center?.lat;
  const lng = e.lon ?? e.center?.lon;
  if (typeof lat !== 'number' || typeof lng !== 'number') continue;

  const parsed = parseAddress(`${street} ${house}`);
  if (!parsed.matchKey) continue;

  // First occurrence wins (avoids duplicate node/way for the same address).
  if (byKey.has(parsed.matchKey)) continue;
  byKey.set(parsed.matchKey, {
    matchKey: parsed.matchKey,
    street,
    houseNumber: parsed.houseNumber + parsed.houseLetter,
    postcode: tags['addr:postcode'] || '',
    city: tags['addr:city'] || '',
    lat,
    lng,
  });
}

const out = [...byKey.values()];
writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${out.length} addresses to ${outPath}`);
