// Address normalizer — the heart of matching.
// Produces two forms per address:
//   display  — pretty, original German text (shown to user, sent to navigation)
//   matchKey — aggressive, canonical key used to decide "same point"
//
// German-specific rules:
//   - transliterate umlauts/ß: ä→ae ö→oe ü→ue ß→ss  (also fixes common OCR ü/u mixups)
//   - canonicalize street suffix: straße / strasse / str. / str  → strasse
//     (only as a trailing suffix/word so "Am Markt" is left untouched)
//   - split house number + optional letter, support ranges "12-14"

const UMLAUTS = [
  [/ä/g, 'ae'], [/ö/g, 'oe'], [/ü/g, 'ue'], [/ß/g, 'ss'],
  [/Ä/g, 'ae'], [/Ö/g, 'oe'], [/Ü/g, 'ue'],
];

export function transliterate(s) {
  let out = s;
  for (const [re, rep] of UMLAUTS) out = out.replace(re, rep);
  return out;
}

// Extract a 5-digit German postcode if present anywhere.
function extractPostcode(s) {
  const m = s.match(/\b(\d{5})\b/);
  return m ? m[1] : '';
}

// Split "<street> <house><letter?>" — house = trailing number (or range) + optional letter.
// Returns { streetPart, houseNumber, houseLetter }.
function splitHouse(line) {
  // number or range, optional trailing letter, optionally glued to street ("Goethestr.5")
  const m = line.match(/^(.*?)[\s.,]*?(\d+(?:\s*[-\/]\s*\d+)?)\s*([a-zA-Z])?\s*$/);
  if (!m) return { streetPart: line.trim(), houseNumber: '', houseLetter: '' };
  return {
    streetPart: m[1].trim(),
    houseNumber: m[2].replace(/\s+/g, ''),
    houseLetter: (m[3] || '').toLowerCase(),
  };
}

// Canonicalize the street name into its matchKey form.
export function normalizeStreetName(streetPart) {
  let s = transliterate(streetPart.toLowerCase().trim());
  s = s.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  // Unify the "straße" suffix into "strasse", covering both forms:
  //   glued  "goethestr"  -> "goethestrasse"
  //   spaced "haupt str"  -> "haupt strasse"
  s = s.replace(/str$/, 'strasse');
  // Glue a separated suffix back onto its name: "haupt strasse" -> "hauptstrasse".
  // (A genuine two-word street like "alte poststrasse" has no space right before
  //  "strasse", so it is left intact.)
  s = s.replace(/\s+strasse$/, 'strasse');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Parse a raw address (one or more lines) into structured parts + matchKey.
export function parseAddress(raw) {
  const cleaned = (raw || '').replace(/\r/g, '').trim();
  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);

  const postcode = extractPostcode(cleaned);

  // City: the token(s) after the postcode, if any.
  let city = '';
  const pcLine = lines.find((l) => /\b\d{5}\b/.test(l));
  if (pcLine) {
    const after = pcLine.split(/\b\d{5}\b/)[1] || '';
    city = after.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Isolate the "street + house" segment, stripping the postcode/city tail.
  // Handles both single-line ("Neubrandenburger Straße 9a, 17109 Demmin")
  // and multi-line ("Hauptstraße 12\n17033 Neubrandenburg") inputs.
  let streetSegment;
  if (postcode) {
    streetSegment = cleaned.slice(0, cleaned.indexOf(postcode));
  } else {
    // No postcode: take the part before the first comma, else the first line.
    streetSegment = cleaned.includes(',') ? cleaned.split(',')[0] : (lines[0] || cleaned);
  }
  streetSegment = streetSegment
    .replace(/\n/g, ' ')
    .replace(/[,;]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const { streetPart, houseNumber, houseLetter } = splitHouse(streetSegment);
  const normStreet = normalizeStreetName(streetPart);

  const matchKey = normStreet
    ? `${normStreet}|${houseNumber}${houseLetter}`
    : '';

  // Pretty display form: the cleaned "street + house" segment.
  const display = streetSegment || cleaned;

  return {
    raw: cleaned,
    display,
    street: streetPart,
    houseNumber,
    houseLetter,
    postcode,
    city,
    matchKey,
  };
}

// Levenshtein distance for "nearest street" suggestions on red (not-found) rows.
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}
