// Pure helpers for turning a saved route order into a displayable stop list, and for measuring
// a hand-reordered loop. Kept framework-free so both the UI and the tests can use them.
import { pointStatus } from './matching.js';
import { haversine } from './route.js';

// Single source of truth for stop order on the Points tab: sort `points` by the saved route's
// `order` array, then append any points not in it (newly added, or never routed) by creation
// time. Points whose id is in `order` but no longer exist are simply skipped. Base is not a
// point here.
export function orderByRoute(points, route) {
  const order = Array.isArray(route && route.order) ? route.order : [];
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...points].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
    const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
    return (ra - rb) || (a.createdAt - b.createdAt);
  });
}

// Turn a saved order into the list of stop ids to actually display on the Route tab: keep only
// points that still exist, have coordinates and aren't delivered, in the saved order; then
// append any active points missing from it (added since the last build) by creation time.
// Delivered/removed points are never resurrected. (Base is implicit and handled by the caller.)
export function reorderStopsFromSaved(points, savedOrder) {
  const active = points.filter((p) => p.coords && pointStatus(p) !== 'done');
  const activeById = new Map(active.map((p) => [p.id, p]));
  const seen = new Set();
  const ordered = [];
  for (const id of (savedOrder || [])) {
    if (activeById.has(id) && !seen.has(id)) { ordered.push(id); seen.add(id); }
  }
  for (const p of active.slice().sort((a, b) => a.createdAt - b.createdAt)) {
    if (!seen.has(p.id)) { ordered.push(p.id); seen.add(p.id); }
  }
  return ordered;
}

// A geometry signature of a route: base coordinates + each stop's id and coordinates, in order.
// Stored on a saved route so re-opening can tell whether the DISTANCE is still valid: it goes
// stale not only when the stop set/order changes but also when the Base or any stop coordinate
// moves (e.g. a corrected Base address, or a GPS entrance saved on site). Rounded to ~1 m.
export function routeGeoSig(base, pts) {
  const c = (co) => (co ? `${co.lat.toFixed(5)},${co.lng.toFixed(5)}` : '-');
  const b = base ? c(base) : '-';
  const s = (pts || []).map((p) => `${p.id}:${c(p.coords)}`).join('|');
  return `${b}#${s}`;
}

// Length of the closed loop base -> stops (in order) -> base, by straight-line (haversine).
// Used to show a distance for hand-reordered routes, where the road-network figure no longer holds.
export function loopMeters(base, pts) {
  if (!base || !pts.length) return 0;
  let m = 0;
  let prev = base;
  for (const p of pts) {
    if (!p.coords) continue;
    m += haversine(prev, p.coords);
    prev = p.coords;
  }
  return m + haversine(prev, base);
}
