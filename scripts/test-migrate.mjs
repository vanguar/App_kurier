// Real DB upgrade test: build a v1 database (old schema), then let db.js open it at v3 and
// confirm the upgrade path runs without crashing, preserves points, and rekeys the address
// index. Must set up v1 BEFORE importing db.js (which opens at the current version).
// Run: node scripts/test-migrate.mjs
import 'fake-indexeddb/auto';
globalThis.navigator = { onLine: false };

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('  ✗ FAIL:', name, detail); } };
const reqDone = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

// --- 1) Create the ORIGINAL v1 schema and seed legacy data ----------------------
await new Promise((resolve, reject) => {
  const open = indexedDB.open('kurier', 1);
  open.onupgradeneeded = () => {
    const d = open.result;
    d.createObjectStore('settings');
    const pts = d.createObjectStore('points', { keyPath: 'id' });
    pts.createIndex('matchKey', 'matchKey', { unique: false });
    d.createObjectStore('addressIndex', { keyPath: 'matchKey' }); // v1 keyed by matchKey
  };
  open.onsuccess = async () => {
    const d = open.result;
    const tx = d.transaction(['points', 'addressIndex'], 'readwrite');
    tx.objectStore('points').put({ id: 'legacy1', matchKey: 'gehmkow|6', address: { postcode: '' }, items: [{ id: 'i1', type: 'parcel', status: 'pending' }], createdAt: 1 });
    tx.objectStore('addressIndex').put({ matchKey: 'gehmkow|6', street: 'Gehmkow', postcode: '', lat: 53.71, lng: 13.01 });
    tx.oncomplete = () => { d.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
  open.onerror = () => reject(open.error);
});

// --- 2) Now open through db.js (version 3) -> upgrade fires ----------------------
const dbmod = await import('../src/core/db.js');
const points = await dbmod.getPoints();
ok('v1->v3: legacy point survived', points.length === 1 && points[0].id === 'legacy1' && points[0].items.length === 1, `points=${points.length}`);

// addressIndex was dropped+recreated with keyPath 'id'; loading a v3 file must work.
await dbmod.loadAddressIndex([{ id: 'node/1', lookupKey: 'gehmkow|6', matchKey: 'gehmkow|6', postcode: '', lat: 53.71, lng: 13.01 }]);
const hits = await dbmod.getIndexByLookup('gehmkow|6');
ok('v1->v3: address index usable after upgrade', hits.length === 1 && hits[0].id === 'node/1', `hits=${hits.length}`);

// migration should now give the legacy point a canonicalId from the reloaded index.
const { migratePointsV2 } = await import('../src/core/matching.js');
await migratePointsV2();
const after = await dbmod.getPoints();
ok('v1->v3: legacy point canonicalized', after.length === 1 && after[0].canonicalId === 'index:node/1', after[0]?.canonicalId);

// A point already marked canonicalResolved must still have a stale coordinate healed from
// the authoritative index on the next launch (the old early-continue caused bad routes).
after[0].coords = { lat: 1, lng: 2 };
after[0].canonicalResolved = true;
await dbmod.putPoint(after[0]);
await migratePointsV2();
const healed = await dbmod.getPoints();
ok('migration heals stale coords of already-resolved points',
  healed[0].coords?.lat === 53.71 && healed[0].coords?.lng === 13.01,
  JSON.stringify(healed[0].coords));

// A courier-saved GPS entrance is stronger than the map index and must survive restarts.
healed[0].coords = { lat: 53.70001, lng: 13.02002 };
healed[0].coordinateManual = true;
await dbmod.putPoint(healed[0]);
await migratePointsV2();
const manual = await dbmod.getPoints();
ok('migration preserves courier-saved GPS entrance',
  manual[0].coords?.lat === 53.70001 && manual[0].coords?.lng === 13.02002 && manual[0].coordinateManual === true,
  JSON.stringify(manual[0]));

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
