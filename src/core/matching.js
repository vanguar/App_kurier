// Matching: attach a delivered item (parcel/magazine/letter) to a point.
// If a point with the same matchKey exists, the item "sticks" to it (that's how a
// magazine ends up on the same checklist as a parcel). Otherwise a new point is created.
import { findPointByCanonical, getPoints, putPoint, mergePointsTx, uid } from './db.js';
import { canonicalize } from './geocode.js';

// "street|house|plz" -> "street|house" (postcode-free key), for pre-v2 points.
function lookupFromMatch(matchKey) {
  const parts = (matchKey || '').split('|');
  return parts.length >= 2 ? `${parts[0]}|${parts[1]}` : (matchKey || '');
}

export function makeItem({ type, source = 'manual', rawText = '', note = '' }) {
  return {
    id: uid(),
    type, // 'parcel' | 'magazine' | 'letter'
    source, // 'ocr' | 'manual'
    status: 'pending', // 'pending' | 'delivered' | 'failed'
    rawText,
    note,
    addedAt: Date.now(),
    deliveredAt: null,
  };
}

export function makePoint(parsed, { coords = null, geocodeStatus = 'notfound', verified = false, canonicalId = '', canonicalResolved = false } = {}) {
  return {
    id: uid(),
    matchKey: parsed.matchKey,
    // Cross-format merge identity (from the district index). Falls back to matchKey so
    // pre-index points still have a stable id. This is what unifies parcel + letter.
    canonicalId: canonicalId || parsed.matchKey || parsed.lookupKey || '',
    canonicalResolved, // true only if the index confirmed the id (else migration retries)
    address: {
      street: parsed.street,
      houseNumber: parsed.houseNumber,
      houseLetter: parsed.houseLetter,
      postcode: parsed.postcode,
      city: parsed.city,
      raw: parsed.raw,
      display: parsed.display,
    },
    coords,
    geocodeStatus, // 'matched' | 'notfound' | 'manual'
    verified,
    items: [],
    routeOrder: null,
    createdAt: Date.now(),
  };
}

// Add an item at an address. Merges into an existing point by canonicalId (cross-format
// identity) when possible, falling back to matchKey for pre-v2 points.
export async function addItemAtAddress(parsed, item, geoInfo = {}) {
  const canonicalId = geoInfo.canonicalId || parsed.matchKey || parsed.lookupKey || '';
  let point = await findPointByCanonical(canonicalId, parsed.matchKey);
  if (!point) {
    point = makePoint(parsed, {
      coords: geoInfo.coords || null,
      geocodeStatus: geoInfo.coords ? 'matched' : 'notfound',
      verified: geoInfo.verified || false,
      canonicalId,
      canonicalResolved: !!geoInfo.canonicalResolved,
    });
  } else if (!point.coords && geoInfo.coords) {
    point.coords = geoInfo.coords;
    point.geocodeStatus = 'matched';
  }
  point.items.push(item);
  await putPoint(point);
  return point;
}

// One-time (idempotent) migration to v2 identity: give every pre-v2 point a canonicalId,
// then merge points that share the SAME non-empty canonicalId — this is where a parcel
// captured from the device screen (no PLZ) finally joins the letter/magazine that carried
// a PLZ. Merges preserve all items, delivery statuses, coords and the earliest createdAt.
// Safe to call repeatedly (and again after the district index is (re)loaded).
export async function migratePointsV2() {
  const points = await getPoints();
  if (!points.length) return { merged: 0 };

  // 1) (Re)resolve canonicalId. A point whose id came from the INDEX (canonicalResolved)
  // is final; one that only got a matchKey fallback (index not loaded yet) is retried on
  // every call, so it upgrades once the district index arrives.
  for (const p of points) {
    if (p.canonicalResolved) continue;
    const parsed = {
      lookupKey: lookupFromMatch(p.matchKey),
      matchKey: p.matchKey,
      postcode: p.address?.postcode || '',
    };
    const canon = await canonicalize(parsed);
    p.canonicalId = canon.canonicalId || p.matchKey || '';
    p.canonicalResolved = !!canon.record; // true only when the index confirmed it
    await putPoint(p);
  }

  // 2) Merge duplicates that now share a canonicalId (never merge across different ids).
  const groups = new Map();
  for (const p of await getPoints()) {
    if (!p.canonicalId) continue;
    if (!groups.has(p.canonicalId)) groups.set(p.canonicalId, []);
    groups.get(p.canonicalId).push(p);
  }
  let merged = 0;
  for (const grp of groups.values()) {
    if (grp.length < 2) continue;
    grp.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const keep = grp[0];
    // Merge items DEDUPED by item.id: if an earlier run was interrupted after saving the
    // survivor but before deleting a duplicate, re-running must not re-append the same
    // items. Unique ids make the whole merge idempotent.
    const seen = new Set((keep.items || []).map((i) => i.id));
    const dupIds = [];
    for (const dup of grp.slice(1)) {
      for (const it of (dup.items || [])) {
        if (!seen.has(it.id)) { keep.items.push(it); seen.add(it.id); }
      }
      if (!keep.coords && dup.coords) { keep.coords = dup.coords; keep.geocodeStatus = 'matched'; }
      keep.createdAt = Math.min(keep.createdAt || Date.now(), dup.createdAt || Date.now());
      dupIds.push(dup.id);
      merged++;
    }
    // One transaction: save survivor + delete all duplicates together (crash-atomic).
    await mergePointsTx(keep, dupIds);
  }
  return { merged };
}

// De-duplicate scanned rows ACROSS overlapping photos. Auto-resolving a village REWRITES a
// row's canonicalId AND its matchKey (the chosen postcode gets appended), so neither is stable
// between a freshly-scanned duplicate ("jahnstrasse|14") and its already-resolved twin
// ("index:…", "jahnstrasse|14|17109"). The postcode-free lookupKey is the one stable anchor.
// Two identities are the SAME delivery when they resolved to the same index record, OR share
// street+house AND don't name two DIFFERENT towns (so a rare "same street in two towns" mail
// batch stays split, while the overlap-duplicate — one side still postcode-less — is caught).
// a/b: { canonicalId, lookupKey, postcode }.
export function sameScannedPlace(a, b) {
  if (a.canonicalId && a.canonicalId.startsWith('index:') && a.canonicalId === b.canonicalId) return true;
  if (a.lookupKey && a.lookupKey === b.lookupKey) return !a.postcode || !b.postcode || a.postcode === b.postcode;
  return false;
}

// Whole-point delivery status derived from its items.
export function pointStatus(point) {
  if (!point.items.length) return 'empty';
  const done = point.items.every((i) => i.status === 'delivered' || i.status === 'failed');
  return done ? 'done' : 'pending';
}

export function itemTypeCounts(point) {
  const c = { parcel: 0, magazine: 0, letter: 0 };
  for (const i of point.items) if (c[i.type] != null) c[i.type]++;
  return c;
}

// Totals across all points: parcels, mail (magazines + letters), and grand total.
export function aggregateCounts(points) {
  const c = { parcel: 0, magazine: 0, letter: 0, delivered: 0 };
  for (const p of points) {
    for (const i of p.items) {
      if (c[i.type] != null) c[i.type]++;
      if (i.status === 'delivered') c.delivered++;
    }
  }
  c.mail = c.magazine + c.letter;
  c.total = c.parcel + c.magazine + c.letter;
  return c;
}
