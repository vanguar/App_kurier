// Deterministic, dependency-free tests for address DISAMBIGUATION — the logic that decides,
// when one "street|house" exists in several towns, whether to resolve automatically or ask
// the courier. Runs against the REAL resolveMatches() (the pure core of canonicalize), so the
// test can never silently drift from the shipped behaviour. No IndexedDB, no network.
// Run: node scripts/test-geocode.mjs
import { resolveMatches } from '../src/core/geocode.js';
import { parseAddress } from '../src/core/normalizer.js';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ FAIL:', name, detail); }
}
// A resolution "landed on town X" — record present, right postcode/city.
const landed = (res, postcode) => res.record && res.record.postcode === postcode && !res.candidates.length;
const prompted = (res) => !res.record && res.candidates.length > 0;

// A realistic slice of the district index: "Gartenstraße 2" exists in several towns, and
// Demmin carries THREE near-identical duplicate geometries (building + address node + entrance)
// — exactly the shape that produced five identical "17109 Demmin" buttons.
const gartenstr2 = [
  { id: 'w/1', lookupKey: 'gartenstrasse|2', street: 'Gartenstraße', houseNumber: '2', postcode: '17109', city: 'Demmin', lat: 53.90476, lng: 13.04223 },
  { id: 'n/2', lookupKey: 'gartenstrasse|2', street: 'Gartenstraße', houseNumber: '2', postcode: '17109', city: 'Demmin', lat: 53.9048, lng: 13.04225 },
  { id: 'n/3', lookupKey: 'gartenstrasse|2', street: 'Gartenstraße', houseNumber: '2', postcode: '17109', city: 'Demmin', lat: 53.90467, lng: 13.04221 },
  { id: 'w/4', lookupKey: 'gartenstrasse|2', street: 'Gartenstraße', houseNumber: '2', postcode: '17126', city: 'Jarmen', lat: 53.92042, lng: 13.32631 },
  { id: 'w/5', lookupKey: 'gartenstrasse|2', street: 'Gartenstraße', houseNumber: '2', postcode: '17139', city: 'Malchin', lat: 53.74181, lng: 12.75863 },
  { id: 'w/6', lookupKey: 'gartenstrasse|2', street: 'Gartenstraße', houseNumber: '2', postcode: '17129', city: 'Tutow', lat: 53.91958, lng: 13.23821 },
];

// --- 1) single index hit -> resolved, never a prompt ---------------------------
{
  const p = parseAddress('Am Markt 7\n17109 Demmin');
  const res = resolveMatches(p, [{ id: 'x/1', lookupKey: p.lookupKey, postcode: '17109', city: 'Demmin', lat: 53.9, lng: 13.0 }]);
  ok('single hit resolves', landed(res, '17109'), JSON.stringify(res.record));
}

// --- 2) same-town duplicate geometry collapses (THE five-Demmin-buttons bug) ----
{
  const demminOnly = gartenstr2.filter((r) => r.postcode === '17109'); // 3 identical Demmin dups
  const p = parseAddress('Gartenstraße 2'); // device card, no locality parsed here
  const res = resolveMatches(p, demminOnly);
  ok('3 Demmin dups collapse to 1 resolved', landed(res, '17109') && !prompted(res), JSON.stringify(res));
}

// --- 3) card shows the postcode -> resolve to that town, no prompt ---------------
{
  const p = parseAddress('Gartenstraße 2\n17109 Demmin');
  const res = resolveMatches(p, gartenstr2);
  ok('postcode 17109 pins Demmin', landed(res, '17109'), JSON.stringify(res.record || res.candidates));
}

// --- 4) postcode missing but CITY visible -> resolve by city (user's request) ----
{
  const p = { ...parseAddress('Gartenstraße 2'), postcode: '', city: 'Demmin' };
  const res = resolveMatches(p, gartenstr2);
  ok('city "Demmin" alone pins Demmin', landed(res, '17109'), JSON.stringify(res.record || res.candidates));
}

// --- 5) postcode MIS-READ but city right -> city fallback still resolves ---------
{
  const p = { ...parseAddress('Gartenstraße 2'), postcode: '99999', city: 'Demmin' };
  const res = resolveMatches(p, gartenstr2);
  ok('wrong PLZ + right city -> Demmin', landed(res, '17109'), JSON.stringify(res.record || res.candidates));
}

// --- 6) city transliteration variance (umlauts / OCR ae<->ä) still matches -------
{
  const towns = [
    { id: 'a', lookupKey: 'seestrasse|3', postcode: '17440', city: 'Lütow', lat: 54.0, lng: 13.7 },
    { id: 'b', lookupKey: 'seestrasse|3', postcode: '17509', city: 'Kröslin', lat: 54.1, lng: 13.6 },
  ];
  const p = { ...parseAddress('Seestraße 3'), postcode: '', city: 'Luetow' }; // OCR wrote ue for ü
  const res = resolveMatches(p, towns);
  ok('city "Luetow" == index "Lütow"', res.record && res.record.city === 'Lütow', JSON.stringify(res.record || res.candidates));
}

// --- 7) NO locality anywhere -> genuine prompt, ONE entry per town (deduped) ------
{
  const p = parseAddress('Gartenstraße 2'); // truly no city/postcode
  const res = resolveMatches(p, gartenstr2);
  ok('no locality -> prompt', prompted(res), JSON.stringify(res));
  const towns = res.candidates.map((c) => c.city).sort();
  ok('prompt has 4 distinct towns (Demmin dups merged)',
    JSON.stringify(towns) === JSON.stringify(['Demmin', 'Jarmen', 'Malchin', 'Tutow']), towns.join(','));
  ok('no two candidates share a town',
    new Set(res.candidates.map((c) => `${c.postcode}|${c.city}`)).size === res.candidates.length);
}

// --- 8) city that matches NO candidate must NOT be force-resolved -----------------
{
  const p = { ...parseAddress('Gartenstraße 2'), postcode: '', city: 'Rostock' }; // not among towns
  const res = resolveMatches(p, gartenstr2);
  ok('unknown city -> still prompt (never a wrong guess)', prompted(res), JSON.stringify(res.record || res.candidates));
}

// --- 9) postcode narrows to a subset (>1 town share it) then city decides ---------
{
  // Contrived: two different towns printed with the same (mis-shared) postcode, city breaks the tie.
  const towns = [
    { id: 'p', lookupKey: 'ringstrasse|5', postcode: '17111', city: 'Alpha', lat: 53.8, lng: 13.1 },
    { id: 'q', lookupKey: 'ringstrasse|5', postcode: '17111', city: 'Beta', lat: 53.9, lng: 13.2 },
    { id: 'r', lookupKey: 'ringstrasse|5', postcode: '17222', city: 'Gamma', lat: 54.0, lng: 13.3 },
  ];
  const p = { ...parseAddress('Ringstraße 5'), postcode: '17111', city: 'Beta' };
  const res = resolveMatches(p, towns);
  ok('postcode subset + city -> Beta', res.record && res.record.city === 'Beta', JSON.stringify(res.record || res.candidates));
}

// --- 10) zero matches -> unresolved fallback identity (not a crash / not a prompt) -
{
  const p = parseAddress('Nirgendwostraße 1');
  const res = resolveMatches(p, []);
  ok('no matches -> fallback id, no candidates', !res.record && !res.candidates.length && !!res.canonicalId, JSON.stringify(res));
}

// --- 11) proximity de-dup: only CO-LOCATED geometry merges (Codex: 3.2 km apart bug) -
{
  // Two records share street+house+postcode+city but sit 3.2 km apart -> DIFFERENT houses
  // (real case: "Dorfstraße 17" in two hamlets both addressed "Bartow"). Must stay 2 candidates,
  // never silently collapse to one coordinate.
  const bartow = [
    { id: 'a', lookupKey: 'dorfstrasse|17', postcode: '', city: 'Bartow', lat: 53.8300, lng: 13.2000 },
    { id: 'b', lookupKey: 'dorfstrasse|17', postcode: '', city: 'Bartow', lat: 53.8000, lng: 13.2300 }, // ~3.6 km away
  ];
  const res = resolveMatches(parseAddress('Dorfstraße 17'), bartow);
  ok('far-apart same-town houses stay separate', prompted(res) && res.candidates.length === 2, JSON.stringify(res.record || res.candidates));

  // The Demmin trio (within metres) must still collapse to one.
  const demminTrio = gartenstr2.filter((r) => r.postcode === '17109');
  const res2 = resolveMatches(parseAddress('Gartenstraße 2'), demminTrio);
  ok('co-located geometry still merges to 1', landed(res2, '17109'), JSON.stringify(res2.record || res2.candidates));
}

// --- 12) postcode/city CONTRADICTION -> prompt, never a silent wrong town (Codex) ---
{
  // Card shows "Demmin", but the 5 digits were mis-read into Jarmen's real postcode. Trusting
  // the postcode alone would deliver to the wrong town; the two towns must be offered instead.
  const p = { ...parseAddress('Gartenstraße 2'), postcode: '17126', city: 'Demmin' };
  const res = resolveMatches(p, gartenstr2);
  ok('conflict PLZ(Jarmen)+city(Demmin) -> prompt, not silent', prompted(res), JSON.stringify(res.record || res.candidates));
  const towns = new Set(res.candidates.map((c) => c.city));
  ok('conflict prompt offers exactly the two plausible towns', towns.size === 2 && towns.has('Demmin') && towns.has('Jarmen'), [...towns].join(','));
  ok('conflict never resolves to the mis-read town', !(res.record && res.record.city === 'Jarmen'));
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
