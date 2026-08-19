// IndexedDB data layer. Everything lives on-device (GDPR: recipient addresses never leave the phone).
import { openDB } from 'idb';

const DB_NAME = 'kurier';
const DB_VERSION = 3;

let _dbPromise = null;

function db() {
  if (!_dbPromise) {
    _dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d, oldVersion, newVersion, tx) {
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings'); // key-value: settings['app'] = {...}
        }
        // points: keyed by id, indexed by matchKey (legacy) + canonicalId (v2 merge id).
        if (!d.objectStoreNames.contains('points')) {
          const s = d.createObjectStore('points', { keyPath: 'id' });
          s.createIndex('matchKey', 'matchKey', { unique: false });
          s.createIndex('canonicalId', 'canonicalId', { unique: false });
        } else if (oldVersion < 2) {
          const pts = tx.objectStore('points');
          if (!pts.indexNames.contains('canonicalId')) {
            pts.createIndex('canonicalId', 'canonicalId', { unique: false });
          }
        }
        // addressIndex v3: keyed by a UNIQUE id (OSM type/id) so two distinct real places
        // that share a postcode-less lookupKey (e.g. "dorfstrasse|5" in two hamlets) both
        // survive instead of one overwriting the other — that ambiguity must reach the app
        // so the courier can choose. matchKey/lookupKey become (non-unique) indexes.
        // Pre-v3 stores were keyed by matchKey; drop and recreate (the file must be
        // regenerated for addr:place support anyway, so nothing useful is lost).
        if (d.objectStoreNames.contains('addressIndex') && oldVersion < 3) {
          d.deleteObjectStore('addressIndex');
        }
        if (!d.objectStoreNames.contains('addressIndex')) {
          const ix = d.createObjectStore('addressIndex', { keyPath: 'id' });
          ix.createIndex('matchKey', 'matchKey', { unique: false });
          ix.createIndex('lookupKey', 'lookupKey', { unique: false });
        }
      },
    });
  }
  return _dbPromise;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- settings (singleton) ----
const DEFAULT_SETTINGS = {
  // Pre-filled depot (route start/finish). User can change it in Settings.
  base: {
    address: {
      street: 'Neubrandenburger Straße',
      houseNumber: '9',
      houseLetter: 'a',
      postcode: '17109',
      city: 'Demmin',
      raw: 'Neubrandenburger Straße 9a, 17109 Demmin',
      display: 'Neubrandenburger Straße 9a',
      matchKey: 'neubrandenburgerstrasse|9a',
    },
    coords: { lat: 53.8924561, lng: 13.0401497 },
  },
  routeType: 'closed',
  language: null, // resolved on first run
  distanceMetric: 'haversine',
  routeMetric: 'road', // 'road' (OSRM, real roads) | 'straight' (haversine, offline)
  theme: 'auto', // 'auto' | 'light' | 'dark'
  navigator: 'ask', // 'ask' | 'google' | 'waze' | 'geo'  (which map app to open a stop in)
  ocrEngine: 'cloud', // 'device' (Tesseract, offline) | 'cloud' (OCR.space, accurate)
  ocrConsent: null, // null until the user makes an informed cloud-vs-device choice once

  ocrApiKey: '', // OCR.space free key (empty -> uses limited demo key)
  onlineGeocode: true, // look up coordinates online (OpenStreetMap) when local index misses
  geoLimit: true,      // restrict online geocoding to a radius around a centre (below)
  geoRadiusKm: 40,     // search radius in km (slider in Settings)
  geoCenter: null,     // { raw, coords:{lat,lng} } — defaults to the depot (base) when null
  parcelPriority: true, // pull parcel stops earlier on near-ties (parcels beat mail)
  onboarded: false, // first-run welcome + Base wizard completed?
};

export async function getSettings() {
  const d = await db();
  const s = await d.get('settings', 'app');
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function saveSettings(patch) {
  const d = await db();
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await d.put('settings', next, 'app');
  return next;
}

// Reset settings to factory defaults (restores preset depot, theme, etc.).
// Does not touch delivery points or the address index.
export async function resetSettings() {
  const d = await db();
  await d.delete('settings', 'app');
  return getSettings();
}

// ---- points ----
export async function getPoints() {
  const d = await db();
  return (await d.getAll('points')) || [];
}

export async function getPoint(id) {
  const d = await db();
  return d.get('points', id);
}

export async function findPointByKey(matchKey) {
  if (!matchKey) return null;
  const d = await db();
  return (await d.getFromIndex('points', 'matchKey', matchKey)) || null;
}

// Find a point by its cross-format identity (canonicalId), falling back to the legacy
// matchKey so points saved before v2 still merge.
export async function findPointByCanonical(canonicalId, matchKey) {
  const d = await db();
  if (canonicalId) {
    const byCanon = await d.getFromIndex('points', 'canonicalId', canonicalId);
    if (byCanon) return byCanon;
  }
  if (matchKey) {
    const byMatch = await d.getFromIndex('points', 'matchKey', matchKey);
    if (byMatch) return byMatch;
  }
  return null;
}

export async function putPoint(point) {
  const d = await db();
  await d.put('points', point);
  return point;
}

// Atomically replace a set of points with one merged survivor: save `keep` and delete the
// duplicate ids in a SINGLE transaction, so an interrupted merge can never leave the
// survivor saved AND the duplicates alive (which would re-append items on the next run).
export async function mergePointsTx(keep, deleteIds) {
  const d = await db();
  const tx = d.transaction('points', 'readwrite');
  await tx.store.put(keep);
  for (const id of deleteIds) if (id !== keep.id) await tx.store.delete(id);
  await tx.done;
}

export async function deletePoint(id) {
  const d = await db();
  await d.delete('points', id);
}

export async function clearPoints() {
  const d = await db();
  await d.clear('points');
}

// ---- address index (reference gazetteer from OSM) ----
export async function getIndexEntry(matchKey) {
  if (!matchKey) return null;
  const d = await db();
  return (await d.getFromIndex('addressIndex', 'matchKey', matchKey)) || null;
}

// Postcode-free lookup: all index records for a `street|house` key, regardless of PLZ.
// One hit -> canonicalize directly; several -> same street+house in >1 town (user picks).
export async function getIndexByLookup(lookupKey) {
  if (!lookupKey) return [];
  const d = await db();
  if (!d.objectStoreNames.contains('addressIndex')) return [];
  const store = d.transaction('addressIndex').store;
  if (!store.indexNames.contains('lookupKey')) return [];
  return (await store.index('lookupKey').getAll(lookupKey)) || [];
}

// Derive the postcode-free lookupKey from a full matchKey ("street|house|plz" -> "street|house").
function lookupFromMatch(matchKey) {
  const parts = (matchKey || '').split('|');
  return parts.length >= 2 ? `${parts[0]}|${parts[1]}` : (matchKey || '');
}

export async function indexCount() {
  const d = await db();
  return d.count('addressIndex');
}

// Bulk-load the district address index. Clears the previous index first (so stale
// records/coords from an old file don't linger) and backfills id/lookupKey/addressKind
// for older index files that predate those fields.
export async function loadAddressIndex(entries) {
  const d = await db();
  const tx = d.transaction('addressIndex', 'readwrite');
  await tx.store.clear(); // replace, don't merge — avoids stale leftovers
  let i = 0;
  const seen = new Set();
  for (const e of entries) {
    const entry = { ...e };
    if (!entry.lookupKey) entry.lookupKey = lookupFromMatch(entry.matchKey);
    if (!entry.addressKind) entry.addressKind = 'street';
    // Unique primary key: OSM id if present, else a synthetic per-address key. Dedupe
    // identical ids so a re-run doesn't throw on the keyPath.
    if (!entry.id) {
      entry.id = (entry.osmType && entry.osmId)
        ? `${entry.osmType}/${entry.osmId}`
        : `${entry.matchKey || entry.lookupKey}@${entry.lat},${entry.lng}`;
    }
    if (seen.has(entry.id)) entry.id = `${entry.id}#${i}`;
    seen.add(entry.id);
    tx.store.put(entry);
    i++;
  }
  await tx.done;
  return entries.length;
}

// Distinct street names present in the index — used for fuzzy "nearest street" suggestions.
export async function getIndexStreets() {
  const d = await db();
  const all = await d.getAll('addressIndex');
  const set = new Set();
  for (const e of all) set.add(e.street);
  return [...set];
}
