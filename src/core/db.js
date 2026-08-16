// IndexedDB data layer. Everything lives on-device (GDPR: recipient addresses never leave the phone).
import { openDB } from 'idb';

const DB_NAME = 'kurier';
const DB_VERSION = 1;

let _dbPromise = null;

function db() {
  if (!_dbPromise) {
    _dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings'); // key-value: settings['app'] = {...}
        }
        if (!d.objectStoreNames.contains('points')) {
          const s = d.createObjectStore('points', { keyPath: 'id' });
          s.createIndex('matchKey', 'matchKey', { unique: false });
        }
        if (!d.objectStoreNames.contains('addressIndex')) {
          d.createObjectStore('addressIndex', { keyPath: 'matchKey' });
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
  base: null, // { address:{...}, coords:{lat,lng} }
  routeType: 'closed',
  language: null, // resolved on first run
  distanceMetric: 'haversine',
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

export async function putPoint(point) {
  const d = await db();
  await d.put('points', point);
  return point;
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
  return (await d.get('addressIndex', matchKey)) || null;
}

export async function indexCount() {
  const d = await db();
  return d.count('addressIndex');
}

// Bulk-load the district address index (array of {matchKey,street,houseNumber,postcode,city,lat,lng}).
export async function loadAddressIndex(entries) {
  const d = await db();
  const tx = d.transaction('addressIndex', 'readwrite');
  for (const e of entries) tx.store.put(e);
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
