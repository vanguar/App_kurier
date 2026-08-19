// Integration tests for the REAL identity pipeline: db.js + geocode.canonicalize +
// matching (addItemAtAddress / migratePointsV2), backed by fake-indexeddb (no browser).
// Covers the riskiest guarantee: a parcel from the device screen (no PLZ) and a letter
// (with PLZ) end up on ONE point — and that distinct places never collapse.
// Run: node scripts/test-db.mjs
import 'fake-indexeddb/auto';
globalThis.navigator = { onLine: false }; // force offline: no Nominatim calls in tests

const { loadAddressIndex, getPoints, clearPoints, putPoint } = await import('../src/core/db.js');
const { geocodeRaw, canonicalize, recordCanonicalId } = await import('../src/core/geocode.js');
const { addItemAtAddress, makeItem, migratePointsV2 } = await import('../src/core/matching.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('  ✗ FAIL:', name, detail); } };

// District index. Gehmkow (addr:place, NO postcode), Hof Peeneland (with PLZ), Seestraße,
// Dorfstraße 5 in two towns w/ DIFFERENT PLZ, Kirchweg 1 in two towns w/ the SAME PLZ,
// and Moorweg 2 in two towns with NO PLZ at all (both edge cases the reviewer raised).
const INDEX = [
  { id: 'node/1', lookupKey: 'gehmkow|6', matchKey: 'gehmkow|6', postcode: '', city: '', lat: 53.71, lng: 13.01 },
  { id: 'node/2', lookupKey: 'hof peeneland|143', matchKey: 'hof peeneland|143|17111', postcode: '17111', city: 'Kummerow', lat: 53.72, lng: 13.02 },
  { id: 'node/3', lookupKey: 'seestrasse|25', matchKey: 'seestrasse|25|17033', postcode: '17033', city: 'Neubrandenburg', lat: 53.55, lng: 13.26 },
  { id: 'node/4', lookupKey: 'dorfstrasse|5', matchKey: 'dorfstrasse|5|17111', postcode: '17111', city: 'Town A', lat: 53.60, lng: 13.10 },
  { id: 'node/5', lookupKey: 'dorfstrasse|5', matchKey: 'dorfstrasse|5|17153', postcode: '17153', city: 'Town B', lat: 53.65, lng: 13.20 },
  { id: 'node/6', lookupKey: 'kirchweg|1', matchKey: 'kirchweg|1|17111', postcode: '17111', city: 'Town C', lat: 53.61, lng: 13.11 },
  { id: 'node/7', lookupKey: 'kirchweg|1', matchKey: 'kirchweg|1|17111', postcode: '17111', city: 'Town D', lat: 53.62, lng: 13.12 },
  { id: 'node/8', lookupKey: 'moorweg|2', matchKey: 'moorweg|2', postcode: '', city: 'Village E', lat: 53.63, lng: 13.13 },
  { id: 'node/9', lookupKey: 'moorweg|2', matchKey: 'moorweg|2', postcode: '', city: 'Village F', lat: 53.64, lng: 13.14 },
];
await loadAddressIndex(INDEX);

// --- 1) NEW parcel (device, no PLZ) + NEW letter (PLZ) -> ONE merged point ------
{
  await clearPoints();
  const gp = await geocodeRaw('Gehmkow 6', { online: false });
  ok('parcel resolved to record id', gp.canonicalId === 'index:node/1' && gp.canonicalResolved === true && gp.coords, gp.canonicalId);
  await addItemAtAddress(gp.parsed, makeItem({ type: 'parcel', source: 'ocr' }), { coords: gp.coords, canonicalId: gp.canonicalId, canonicalResolved: gp.canonicalResolved });

  const gl = await geocodeRaw('Stefan Borchert\nGehmkow 6\n17111 Gehmkow', { online: false });
  ok('letter resolves to SAME record id', gl.canonicalId === 'index:node/1', gl.canonicalId);
  await addItemAtAddress(gl.parsed, makeItem({ type: 'letter', source: 'ocr' }), { coords: gl.coords, canonicalId: gl.canonicalId, canonicalResolved: gl.canonicalResolved });

  const pts = await getPoints();
  ok('CORE: parcel+letter on ONE point', pts.length === 1 && pts[0].items.length === 2, `points=${pts.length} items=${pts[0]?.items.length}`);
}

// --- 2) migratePointsV2 merges LEGACY duplicates (pre-v2, no canonicalId) --------
{
  await clearPoints();
  await putPoint({ id: 'a', matchKey: 'gehmkow|6', address: { postcode: '' }, items: [makeItem({ type: 'parcel' })], createdAt: 1 });
  await putPoint({ id: 'b', matchKey: 'gehmkow|6|17111', address: { postcode: '17111' }, items: [makeItem({ type: 'letter' })], createdAt: 2 });
  await migratePointsV2();
  const pts = await getPoints();
  ok('migration merged legacy dupes', pts.length === 1 && pts[0].items.length === 2, `points=${pts.length}`);
  ok('survivor keeps both items', pts[0]?.items.some((i) => i.type === 'parcel') && pts[0]?.items.some((i) => i.type === 'letter'));
}

// --- 3) ambiguous: same street+house, DIFFERENT postcodes -> candidates ----------
{
  const amb = await geocodeRaw('Dorfstraße 5', { online: false });
  ok('diff-PLZ ambiguous -> candidates', Array.isArray(amb.candidates) && amb.candidates.length === 2, `cands=${amb.candidates?.length}`);
  ok('ambiguous has NO id / coords', !amb.canonicalId && !amb.coords && amb.confidence === 'yellow');
}

// --- 3b) SAME postcode in two towns must STILL be ambiguous (reviewer P1) --------
{
  const amb = await geocodeRaw('Kirchweg 1\n17111 Town', { online: false });
  ok('same-PLZ two towns -> candidates (not silent first)', amb.candidates.length === 2 && !amb.canonicalId, `cands=${amb.candidates.length} id=${amb.canonicalId}`);
}

// --- 3c) two PLZ-less candidates -> choosing each yields DIFFERENT canonicalId ----
{
  const amb = await geocodeRaw('Moorweg 2', { online: false });
  ok('PLZ-less two places -> candidates', amb.candidates.length === 2, `cands=${amb.candidates.length}`);
  const ids = amb.candidates.map(recordCanonicalId);
  ok('PLZ-less candidates get DISTINCT ids', ids[0] !== ids[1] && ids[0] === 'index:node/8' && ids[1] === 'index:node/9', ids.join(','));
}

// --- 4) authoritative PLZ on street change (P1#3) --------------------------------
{
  const g = await geocodeRaw('Seestraße 25\n99999 Oldtown', { online: false });
  ok('index overrides stale PLZ', g.parsed.postcode === '17033' && g.canonicalId === 'index:node/3', `${g.parsed.postcode} / ${g.canonicalId}`);
}

// --- 5) migration is IDEMPOTENT after an interrupted merge (reviewer P1) ---------
{
  await clearPoints();
  const shared = makeItem({ type: 'parcel' }); // the item that was already copied over
  // Survivor 'a' already absorbed the item; duplicate 'b' still exists with the SAME item.
  await putPoint({ id: 'a', matchKey: 'gehmkow|6', canonicalId: 'index:node/1', canonicalResolved: true, address: { postcode: '' }, items: [shared], createdAt: 1 });
  await putPoint({ id: 'b', matchKey: 'gehmkow|6|17111', address: { postcode: '17111' }, items: [shared], createdAt: 2 });
  await migratePointsV2();
  const pts = await getPoints();
  ok('interrupted-merge re-run: ONE point', pts.length === 1, `points=${pts.length}`);
  ok('interrupted-merge re-run: item NOT duplicated', pts[0]?.items.length === 1, `items=${pts[0]?.items.length}`);
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
