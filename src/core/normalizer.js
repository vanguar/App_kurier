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

// --- Street-line detection (content-based, position-independent) ------------
// A shipping label / list can carry lines that LOOK like a street but are not
// ("Brief 3", "Sendung 12345", "Absender ...", "auch Paket"). Instead of guessing
// by position (above/below the postcode), we SCORE every line by how address-like
// it is and pick the best one — so the real street wins wherever it is printed.
const NON_STREET_WORDS = /\b(brief(e)?|paket(e)?|p(ä|ae)ckchen|sendung\w*|zeitschrift(en)?|zeitung(en)?|magazin(e)?|absender|empf(ä|ae)nger|kunden?\w*|nummer|nr|tel(efon)?|fax|rechnung\w*|bestell\w*|auftrag\w*|datum|seite|blatt|barcode|code|referenz|auch|screenshot|scan)\b/i;
// German street "Grundwörter" (word endings) + locational prefixes: strong signals
// a line really is a street, even with no postcode nearby.
const STREET_SUFFIX = /(stra(ß|ss)e|str|weg|allee|platz|ring|damm|ufer|gasse|steig|steg|chaussee|graben|markt|anger|wall|hof|kamp|koppel|redder|twiete|reihe|zeile|winkel|kehre|pfad|promenade|berg|feld|br(ü|ue)cke|tor)$/i;
const STREET_PREFIX = /^(am|an|auf|bei|beim|hinter|im|in|vor|zum|zur|zu|neben|unter)\b/i;

function scoreStreetLine(text) {
  const t = text.trim();
  const nameOnly = t.replace(/[\s.,]*\d+\s*[a-zA-Z]?\s*$/, '').trim(); // drop trailing house no.
  const words = nameOnly.split(/\s+/).filter(Boolean);
  const lastWord = words[words.length - 1] || '';
  let score = 0;
  if (NON_STREET_WORDS.test(t)) score -= 100;                                    // caption/meta junk
  if (STREET_SUFFIX.test(lastWord) || STREET_PREFIX.test(nameOnly)) score += 10; // real street word
  if (/\d+\s*[a-zA-Z]?$/.test(t)) score += 3;                                    // ends with a house number
  score += Math.min(nameOnly.replace(/[^a-zA-ZäöüÄÖÜß]/g, '').length, 12) * 0.1; // has an actual name
  return score;
}

// Parse a raw address (one or more lines) into structured parts + matchKey.
export function parseAddress(raw) {
  const cleaned = (raw || '').replace(/\r/g, '').trim();
  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);

  // Postcode + city. A German PLZ is 5 digits FOLLOWED BY a city on the same line,
  // so prefer a "PLZ City" line — that way a stray 5-digit number (customer or
  // tracking no. like "Kundennummer 44823") is not mistaken for the postcode.
  // Fall back to any 5-digit group only if no "PLZ City" line exists.
  const PLZ_CITY = /\b(\d{5})\s+([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß.\- ]*)/;
  let pcLine = null;
  let postcode = '';
  let city = '';
  for (const l of lines) {
    const m = l.match(PLZ_CITY);
    if (m) { pcLine = l; postcode = m[1]; city = m[2].replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim(); break; }
  }
  if (!pcLine) {
    pcLine = lines.find((l) => /\b\d{5}\b/.test(l)) || null;
    if (pcLine) {
      const m = pcLine.match(/\b(\d{5})\b/);
      postcode = m ? m[1] : '';
      city = (pcLine.split(/\b\d{5}\b/)[1] || '').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  if (!postcode) postcode = extractPostcode(cleaned);

  // Isolate the "street + house" segment and IGNORE name/company lines.
  // On a mail label the street line is the one that has a house number; the
  // recipient name usually has no digits, so we pick the street line explicitly.
  const hasLetters = (l) => /[a-zA-ZäöüÄÖÜß]/.test(l);
  const hasHouseNo = (l) => /\d/.test(l);
  const pcIndex = pcLine ? lines.indexOf(pcLine) : -1;
  // Score every line that could be a street (has letters + a number, not the PLZ line)
  // and take the most address-like one. Position on the label does NOT matter — junk
  // like "Brief 3" / "Sendung 12345" / "Absender ..." is scored out by content.
  const streetCandidates = lines
    .map((l, idx) => ({ l, idx }))
    .filter((c) => c.idx !== pcIndex && hasLetters(c.l) && hasHouseNo(c.l))
    .map((c) => ({ ...c, score: scoreStreetLine(c.l) }))
    .sort((a, b) => b.score - a.score || b.l.length - a.l.length);

  let streetSegment;
  if (streetCandidates.length) {
    streetSegment = streetCandidates[0].l; // best-scoring line wins
  } else if (postcode && cleaned.indexOf(postcode) > 0) {
    // Single-line "Street 9a, 17109 City": take everything before the postcode.
    streetSegment = cleaned.slice(0, cleaned.indexOf(postcode));
  } else {
    streetSegment = cleaned.includes(',') ? cleaned.split(',')[0] : (lines[0] || cleaned);
  }
  streetSegment = streetSegment
    .replace(/\n/g, ' ')
    .replace(/[,;]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const { streetPart, houseNumber, houseLetter } = splitHouse(streetSegment);
  const normStreet = normalizeStreetName(streetPart);

  // matchKey decides "same point" AND is the online-geocode cache key. It MUST
  // include the postcode when present, because the same street+house exists in many
  // towns — without it, two different cities would collapse into one point (a real
  // parcel dropped as a "duplicate") and share a cached coordinate. Postcode is more
  // OCR-stable than the city name, so we key on it.
  const matchKey = normStreet
    ? `${normStreet}|${houseNumber}${houseLetter}${postcode ? `|${postcode}` : ''}`
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
