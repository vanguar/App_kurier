// Deterministic, dependency-free tests for the OCR extractors + address identity.
// Run: node scripts/test-extractor.mjs
// These use hand-written OCR text fixtures (no cloud, no images) so they are stable in
// CI. Real photo end-to-end checks are a separate, manual step (cloud OCR is nondeterministic).
import { splitDeviceScreen, splitAddresses, pickReceiverBlock } from '../src/ocr/ocr.js';
import { parseAddress } from '../src/core/normalizer.js';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ FAIL:', name, detail); }
}

// Mirrors geocode.canonicalize()'s id formula (canonicalize() itself needs IndexedDB).
function canonId(parsed, index) {
  const m = index.filter((r) => r.lookupKey === parsed.lookupKey);
  if (m.length === 1) return m[0].postcode ? `${parsed.lookupKey}|${m[0].postcode}` : parsed.lookupKey;
  if (m.length > 1) {
    const h = parsed.postcode && m.find((x) => x.postcode === parsed.postcode);
    return h ? `${parsed.lookupKey}|${h.postcode}` : '(ambiguous)';
  }
  return parsed.matchKey || parsed.lookupKey;
}

// --- 1) courier-device screen: cards, no PLZ, route codes + UI chrome ----------
{
  const text = [
    'Q Поиск',
    'Hartmut Drews', '81-11',
    'Törpin 79', 'ulrike storch', '81-11',
    'Törpin 36', 'Martina Schumann', '81-11',
    'Gehmkow 6', 'Stefan Borchert', '81-11',
    'Готово 24/56', 'Остановки', 'Информация', 'Настройки',
  ].join('\n');
  const blocks = splitDeviceScreen(text, null);
  ok('device: 3 cards extracted', blocks.length === 3, `got ${blocks.length}`);
  const keys = blocks.map((b) => parseAddress(b).lookupKey);
  ok('device: keys correct', JSON.stringify(keys) === JSON.stringify(['toerpin|79', 'toerpin|36', 'gehmkow|6']), keys.join(','));
  // glued route code must NOT become a house range
  const glued = splitDeviceScreen('Törpin 79 81-11\nulrike storch', null);
  ok('device: glued route code stripped', parseAddress(glued[0]).lookupKey === 'toerpin|79', parseAddress(glued[0]).lookupKey);
}

// --- 2) cross-format identity: parcel (no PLZ) merges with letter (PLZ) ---------
{
  const index = [
    { lookupKey: 'gehmkow|6', postcode: '' },              // addr:place, no PLZ in OSM
    { lookupKey: 'hof peeneland|143', postcode: '17111' },
  ];
  const parcel = parseAddress('Gehmkow 6');
  const letter = parseAddress('Stefan Borchert\nGehmkow 6\n17111 Gehmkow');
  ok('identity: gehmkow parcel==letter', canonId(parcel, index) === canonId(letter, index) && canonId(parcel, index) === 'gehmkow|6');
  const p2 = parseAddress('Hof Peeneland 143');
  const l2 = parseAddress('Hof Peeneland 143\n17111 Kummerow');
  ok('identity: hof-peeneland parcel==letter', canonId(p2, index) === canonId(l2, index) && canonId(p2, index) === 'hof peeneland|143|17111');
}

// --- 3) letter/magazine: choose recipient, not sender / customer number ---------
{
  const sender = splitAddresses('Absender\nMusterstraße 1\n12345 Berlin\n\nMax Mustermann\nEmpfängerstraße 2\n54321 Hamburg', null);
  const r1 = parseAddress(pickReceiverBlock(sender));
  ok('mail: skips sender', r1.postcode === '54321', r1.postcode);
  const mag = splitAddresses('Zeitschrift\nKundennummer 44823\n\nMax Mustermann\nEmpfängerstraße 2\n54321 Hamburg', null);
  const r2 = parseAddress(pickReceiverBlock(mag));
  ok('mail: skips Kundennummer', r2.postcode === '54321' && /Empf/i.test(r2.street), `${r2.street} ${r2.postcode}`);
  const single = splitAddresses('Anna Krüger\nAm Markt 7\n17109 Demmin', null);
  const r3 = parseAddress(pickReceiverBlock(single));
  ok('mail: single label ok', r3.postcode === '17109' && r3.houseNumber === '7');
}

// --- 4) legacy PLZ list still splits (regression) -------------------------------
{
  const list = 'Anna Krüger\nAm Markt 7\n17109 Demmin\nBernd Hoffmann\nSchillerstraße 21\n17033 Neubrandenburg';
  const blocks = splitAddresses(list, null);
  ok('list: 2 blocks', blocks.length === 2, `got ${blocks.length}`);
}

// --- 5) the list TITLE / caption must NOT become an address ---------------------
{
  // Reproduces the real PAKETLISTE screenshot: a big gap after the title splits it into
  // its OWN block (>=6 lines so gap-splitting is active), which must then be dropped.
  const lines = [
    { text: 'PAKETLISTE 30 Pakete', top: 0, height: 20 },
    { text: 'Anna Krüger', top: 200, height: 16 },
    { text: 'Am Markt 7', top: 220, height: 18 },
    { text: '17109 Demmin', top: 242, height: 16 },
    { text: 'Bernd Hoffmann', top: 300, height: 16 },
    { text: 'Schillerstraße 21', top: 320, height: 18 },
    { text: '17033 Neubrandenburg', top: 342, height: 16 },
  ];
  const text = lines.map((l) => l.text).join('\n');
  const blocks = splitAddresses(text, lines);
  const streets = blocks.map((b) => parseAddress(b).street);
  ok('caption "PAKETLISTE 30 Pakete" dropped', !blocks.some((b) => /Pakete/i.test(b)), JSON.stringify(blocks));
  ok('real addresses survive', streets.includes('Am Markt') && streets.some((s) => /Schiller/.test(s)), streets.join(','));
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
