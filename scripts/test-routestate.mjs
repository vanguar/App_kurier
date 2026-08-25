// Tests for the route history model (current/previous) and the saved-order reconstruction.
// Covers: first build, second build (previous <- old current), manual reorder (previous kept),
// restore = swap, legacy routeOrder migration, and reorderStopsFromSaved with new/removed/
// delivered points. Backed by fake-indexeddb (no browser). Run: node scripts/test-routestate.mjs
import 'fake-indexeddb/auto';
globalThis.navigator = { onLine: false };

const {
  getRouteState, saveRouteState, migrateRouteState, putPoint, clearPoints,
} = await import('../src/core/db.js');
const { reorderStopsFromSaved, orderByRoute, loopMeters, routeGeoSig } = await import('../src/core/route-order.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', name, detail); } };
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// A build pushes the old current onto previous, then stores the new order as current.
async function build(order) {
  const st = await getRouteState();
  await saveRouteState({
    current: { order, totalMeters: 0, provider: 'straight', manual: false, computedAt: Date.now() },
    previous: st.current,
  });
}

// --- fresh state ---
const empty = await getRouteState();
eq('fresh state has null current/previous', [empty.current, empty.previous], [null, null]);

// --- first build ---
await build(['a', 'b', 'c']);
let st = await getRouteState();
eq('first build sets current', st.current.order, ['a', 'b', 'c']);
ok('first build leaves previous null', st.previous === null);

// --- second build: previous <- old current ---
await build(['c', 'b', 'a']);
st = await getRouteState();
eq('second build updates current', st.current.order, ['c', 'b', 'a']);
eq('second build moves old current to previous', st.previous.order, ['a', 'b', 'c']);

// --- manual reorder: current changes, previous is NOT overwritten ---
async function manualReorder(order) {
  const s = await getRouteState();
  await saveRouteState({
    current: { order, totalMeters: 1, provider: 'straight', manual: true, computedAt: Date.now() },
    previous: s.previous, // keep previous untouched
  });
}
await manualReorder(['b', 'c', 'a']);
st = await getRouteState();
eq('manual reorder updates current', st.current.order, ['b', 'c', 'a']);
ok('manual reorder marks route manual', st.current.manual === true);
eq('manual reorder keeps previous (last build)', st.previous.order, ['a', 'b', 'c']);

// --- restore = swap current <-> previous (itself undoable) ---
async function restore() {
  const s = await getRouteState();
  await saveRouteState({ current: s.previous, previous: s.current });
}
await restore();
st = await getRouteState();
eq('restore brings previous into current', st.current.order, ['a', 'b', 'c']);
eq('restore pushes current into previous', st.previous.order, ['b', 'c', 'a']);
await restore();
st = await getRouteState();
eq('restore is reversible (swap back)', st.current.order, ['b', 'c', 'a']);

// --- legacy routeOrder migration ---
await saveRouteState({ current: null, previous: null }); // simulate no route history yet
await clearPoints();
await putPoint({ id: 'p1', createdAt: 1, routeOrder: 2, coords: { lat: 1, lng: 1 }, items: [] });
await putPoint({ id: 'p2', createdAt: 2, routeOrder: 0, coords: { lat: 1, lng: 1 }, items: [] });
await putPoint({ id: 'p3', createdAt: 3, routeOrder: 1, coords: { lat: 1, lng: 1 }, items: [] });
const migrated = await migrateRouteState();
eq('migration rebuilds current from routeOrder', migrated.current.order, ['p2', 'p3', 'p1']);
const again = await migrateRouteState();
eq('migration is idempotent (no-op when current exists)', again.current.order, ['p2', 'p3', 'p1']);

// --- reorderStopsFromSaved: keep saved order, append new, drop removed & delivered ---
const points = [
  { id: 'a', createdAt: 1, coords: { lat: 1, lng: 1 }, items: [{ type: 'parcel', status: 'pending' }] },
  { id: 'b', createdAt: 2, coords: { lat: 1, lng: 1 }, items: [{ type: 'letter', status: 'delivered' }] }, // delivered -> excluded
  { id: 'c', createdAt: 3, coords: { lat: 1, lng: 1 }, items: [{ type: 'parcel', status: 'pending' }] },
  { id: 'd', createdAt: 4, coords: null, items: [{ type: 'parcel', status: 'pending' }] },              // no coords -> excluded
  { id: 'e', createdAt: 5, coords: { lat: 1, lng: 1 }, items: [{ type: 'parcel', status: 'pending' }] }, // NEW, not in saved order
];
// saved order references 'c','a','b' and 'x' (x was removed since)
const shown = reorderStopsFromSaved(points, ['c', 'a', 'b', 'x']);
eq('reorder keeps saved order for existing active, appends new, drops removed/delivered/no-coord',
  shown, ['c', 'a', 'e']);

// --- orderByRoute: Points tab sorts by route order, unranked go last by createdAt ---
const sorted = orderByRoute(points, { order: ['e', 'c'] }).map((p) => p.id);
eq('orderByRoute honours saved order then createdAt', sorted, ['e', 'c', 'a', 'b', 'd']);

// --- loopMeters: closed loop is symmetric and non-zero for distinct points ---
const base = { lat: 53.9, lng: 13.0 };
const twoStops = [{ coords: { lat: 53.8, lng: 13.0 } }, { coords: { lat: 53.7, lng: 13.1 } }];
const m1 = loopMeters(base, twoStops);
const m2 = loopMeters(base, twoStops.slice().reverse());
ok('loopMeters is positive', m1 > 0);
ok('loopMeters same total for a reversed closed loop', Math.abs(m1 - m2) < 1);

// --- routeGeoSig: detects Base moves and per-point coordinate changes, not just id/order ---
const gBase = { lat: 53.9, lng: 13.0 };
const gp = [{ id: 'a', coords: { lat: 53.5, lng: 13.2 } }, { id: 'b', coords: { lat: 53.6, lng: 13.3 } }];
const sig0 = routeGeoSig(gBase, gp);
ok('geoSig stable for identical geometry', sig0 === routeGeoSig(gBase, gp));
ok('geoSig changes when order changes', sig0 !== routeGeoSig(gBase, gp.slice().reverse()));
ok('geoSig changes when Base moves',
  sig0 !== routeGeoSig({ lat: 53.91, lng: 13.0 }, gp));
ok('geoSig changes when a stop coordinate moves',
  sig0 !== routeGeoSig(gBase, [{ id: 'a', coords: { lat: 53.5001, lng: 13.2 } }, gp[1]]));
ok('geoSig ignores sub-metre jitter (rounded to 5 dp)',
  sig0 === routeGeoSig(gBase, [{ id: 'a', coords: { lat: 53.5000001, lng: 13.2 } }, gp[1]]));

if (fail) { console.log(`\n✗ ROUTE-STATE FAILED — ${pass} passed, ${fail} failed`); process.exit(1); }
console.log(`\n✓ ALL PASS — ${pass} passed, 0 failed`);
process.exit(0);
