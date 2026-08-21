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
  } else if (geoInfo.coords && (!point.coords || geoInfo.canonicalResolved)) {
    // A confirmed index coordinate is authoritative. Older app versions could leave a
    // wrong Nominatim coordinate attached to an existing point forever because they only
    // filled an EMPTY coordinate. Refresh it whenever the exact index record is known.
    point.coords = geoInfo.coords;
    point.geocodeStatus = 'matched';
    if (geoInfo.canonicalResolved) {
      point.canonicalId = canonicalId;
      point.canonicalResolved = true;
      point.matchKey = parsed.matchKey || point.matchKey;
      point.address = {
        ...point.address,
        postcode: parsed.postcode || point.address?.postcode || '',
        city: parsed.city || point.address?.city || '',
      };
    }
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

  // 1) (Re)resolve canonicalId AND heal coordinates from the authoritative index. We also
  // revisit already-resolved points: older builds could preserve a stale/wrong coordinate
  // forever, which makes a correct optimizer produce a nonsensical town order.
  for (const p of points) {
    const parsed = {
      lookupKey: lookupFromMatch(p.matchKey),
      matchKey: p.matchKey,
      postcode: p.address?.postcode || '',
      city: p.address?.city || '',
    };
    const canon = await canonicalize(parsed);
    if (canon.record) {
      p.canonicalId = canon.canonicalId;
      p.canonicalResolved = true;
      if (typeof canon.record.lat === 'number' && typeof canon.record.lng === 'number') {
        p.coords = { lat: canon.record.lat, lng: canon.record.lng };
        p.geocodeStatus = 'matched';
      }
      if (canon.record.matchKey) p.matchKey = canon.record.matchKey;
      p.address = {
        ...p.address,
        postcode: canon.record.postcode || p.address?.postcode || '',
        city: canon.record.city || p.address?.city || '',
      };
    } else if (!p.canonicalResolved) {
      // Do not erase a previously confirmed identity merely because the index has not been
      // loaded yet on this launch. Only unresolved legacy points use the fallback identity.
      p.canonicalId = canon.canonicalId || p.matchKey || '';
      p.canonicalResolved = false;
    }
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

// De-duplicate scanned rows that are the SAME delivery across overlapping photos. Meant to run
// AFTER neighbour auto-resolution, so most rows already carry an index canonicalId.
//   - both resolved to an index record -> duplicate iff it is the SAME record (exact, safe);
//   - exactly ONE resolved -> NOT treated as a duplicate. A resolved town + a still-unresolved
//     "street|house" could be two DIFFERENT towns; merging them could silently drop a real
//     delivery, so we keep both (a visible duplicate is recoverable, a lost stop is not);
//   - NEITHER resolved -> duplicate only when street+house match AND the postcodes are
//     compatible (both empty, or equal): the genuine overlap of two raw re-scans in one batch.
// a/b: { canonicalId, lookupKey, postcode }.
export function sameScannedPlace(a, b) {
  const aRes = !!a.canonicalId && a.canonicalId.startsWith('index:');
  const bRes = !!b.canonicalId && b.canonicalId.startsWith('index:');
  if (aRes && bRes) return a.canonicalId === b.canonicalId;
  if (aRes || bRes) return false;
  if (a.lookupKey && a.lookupKey === b.lookupKey) return (!a.postcode && !b.postcode) || a.postcode === b.postcode;
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

// Totals across all points. `parcel`/`mail` are ITEM counts (how many of each to deliver),
// but `stops` — and the headline `total` — count the DELIVERY POINTS actually shown in the
// list. That is what the courier reads off the screen: a stop with two parcels is still ONE
// place to drive to, so the total must equal the number of rows in the list, not the number
// of items (which is why a double-scanned card once made the total read 24 for a 23-stop tour).
export function aggregateCounts(points) {
  const c = { parcel: 0, magazine: 0, letter: 0, delivered: 0 };
  for (const p of points) {
    for (const i of p.items) {
      if (c[i.type] != null) c[i.type]++;
      if (i.status === 'delivered') c.delivered++;
    }
  }
  c.mail = c.magazine + c.letter;
  c.items = c.parcel + c.magazine + c.letter; // total individual shipments
  c.stops = points.filter((p) => p.items && p.items.length).length; // delivery points in the list
  c.total = c.stops; // the headline number mirrors the visible list
  return c;
}
