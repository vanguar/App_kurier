// Matching: attach a delivered item (parcel/magazine/letter) to a point.
// If a point with the same matchKey exists, the item "sticks" to it (that's how a
// magazine ends up on the same checklist as a parcel). Otherwise a new point is created.
import { findPointByKey, putPoint, uid } from './db.js';

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

export function makePoint(parsed, { coords = null, geocodeStatus = 'notfound', verified = false } = {}) {
  return {
    id: uid(),
    matchKey: parsed.matchKey,
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

// Add an item at an address. Merges into an existing point by matchKey when possible.
export async function addItemAtAddress(parsed, item, geoInfo = {}) {
  let point = await findPointByKey(parsed.matchKey);
  if (!point) {
    point = makePoint(parsed, {
      coords: geoInfo.coords || null,
      geocodeStatus: geoInfo.coords ? 'matched' : 'notfound',
      verified: geoInfo.verified || false,
    });
  } else if (!point.coords && geoInfo.coords) {
    point.coords = geoInfo.coords;
    point.geocodeStatus = 'matched';
  }
  point.items.push(item);
  await putPoint(point);
  return point;
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
