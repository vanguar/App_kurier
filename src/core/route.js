// Route ordering: closed loop Base -> ... -> Base.
// Distance metric: haversine (straight-line). Solver: nearest-neighbor + 2-opt/Or-opt.
// Runs entirely on-device; handles up to ~100 stops instantly.

const R = 6371000; // Earth radius, meters

// fetch + parse JSON with a hard timeout. The public OSRM/Nominatim servers occasionally
// stall; without an abort the whole "Build route" tap hangs forever and no route is drawn.
// On timeout this throws (AbortError) so the caller falls back to the offline solver.
async function fetchJson(url, {
  timeoutMs = 12000,
  fetchImpl = globalThis.fetch,
  method = 'GET',
  headers,
  body,
} = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal });
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (e) { /* ignore unreadable error bodies */ }
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Primary online solver: the app talks to OUR proxy, never directly to HeiGIT, so the
// openrouteservice API key is not embedded in the public PWA bundle. The proxy forwards this
// VROOM-compatible request to https://api.heigit.org/vroom/v0.
//
// The numeric job ids are deliberately local to this request. App point ids are strings, so a
// map restores them after VROOM returns the optimized step order.
export async function orsOptimize(base, stops, {
  endpoint,
  priority = true,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!endpoint) throw new Error('ORS proxy URL is not configured');
  const usable = stops.filter((s) => s && typeof s.lat === 'number' && typeof s.lng === 'number');
  const skipped = stops.filter((s) => !(s && typeof s.lat === 'number' && typeof s.lng === 'number'));
  if (!usable.length) return { orderedIds: [], totalMeters: 0, usableCount: 0, skipped, provider: 'ors' };

  const idMap = new Map();
  const jobs = usable.map((s, i) => {
    const id = i + 1;
    idMap.set(id, s.id);
    return {
      id,
      location: [s.lng, s.lat], // ORS/VROOM uses [longitude, latitude]
      ...(priority && s.priority ? { priority: 100 } : {}),
      // The proxy uses this only as a courier-friendly tie-break: stops in the same
      // locality should stay together when doing so does not materially lengthen the loop.
      // It is stripped before the payload is forwarded to VROOM.
      ...(s.group ? { group: String(s.group) } : {}),
    };
  });
  const payload = {
    jobs,
    vehicles: [{
      id: 1,
      profile: 'driving-car',
      start: [base.lng, base.lat],
      end: [base.lng, base.lat],
    }],
  };
  const data = await fetchJson(endpoint, {
    timeoutMs,
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const route = Array.isArray(data.routes) && data.routes[0];
  if (!route || !Array.isArray(route.steps)) {
    throw new Error(data.error || 'ORS optimization returned no route');
  }
  const orderedIds = route.steps
    .filter((step) => step && step.type === 'job' && idMap.has(step.id))
    .map((step) => idMap.get(step.id));
  if (orderedIds.length !== usable.length || (Array.isArray(data.unassigned) && data.unassigned.length)) {
    throw new Error('ORS optimization left one or more stops unassigned');
  }
  return {
    orderedIds,
    totalMeters: typeof data.road_distance === 'number'
      ? data.road_distance
      : (typeof route.distance === 'number' ? route.distance : 0),
    usableCount: usable.length,
    skipped,
    provider: 'ors',
  };
}

export function haversine(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function buildMatrix(nodes) {
  const n = nodes.length;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const d = haversine(nodes[i], nodes[j]);
      m[i][j] = d;
      m[j][i] = d;
    }
  return m;
}

// order: array of node indices forming the tour Base(0) -> ... -> Base(0) (closed).
function tourLength(order, m) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) total += m[order[i]][order[i + 1]];
  total += m[order[order.length - 1]][order[0]]; // close the loop
  return total;
}

function nearestNeighbor(m, n) {
  const visited = new Array(n).fill(false);
  const order = [0]; // start at Base
  visited[0] = true;
  for (let step = 1; step < n; step++) {
    const last = order[order.length - 1];
    let best = -1;
    let bestD = Infinity;
    for (let j = 1; j < n; j++) {
      if (!visited[j] && m[last][j] < bestD) {
        bestD = m[last][j];
        best = j;
      }
    }
    order.push(best);
    visited[best] = true;
  }
  return order;
}

// True length change of reversing order[i..k] on matrix m. Reversing flips the direction of
// every INTERNAL edge too, so on an ASYMMETRIC (directed) matrix — like an OSRM road-distance
// table where A→B ≠ B→A — the internal edges must be re-summed, not assumed unchanged. The old
// "boundary edges only" delta was valid only for symmetric matrices; on a directed one it
// mis-scored moves, which both worsened routes AND could cycle forever (the reported hang).
// For a symmetric matrix the internal sums cancel and this reduces to the classic 2-opt delta.
function reverseDelta(order, m, i, k) {
  const n = order.length;
  const a = order[i - 1];
  const b = order[i];
  const c = order[k];
  const d = order[(k + 1) % n]; // wraps to Base to keep the loop closed
  let oldInternal = 0;
  let newInternal = 0;
  for (let t = i; t < k; t++) {
    oldInternal += m[order[t]][order[t + 1]];
    newInternal += m[order[t + 1]][order[t]]; // reversed direction
  }
  return (m[a][c] + newInternal + m[b][d]) - (m[a][b] + oldInternal + m[c][d]);
}

// 2-opt: reverse segments between i..k (never touching Base at index 0). Correct for
// asymmetric matrices (see reverseDelta) and hard-capped so it can never spin forever.
function twoOpt(order, m) {
  const n = order.length;
  const maxPasses = 4 * n * n + 50; // safety cap; a correct 2-opt converges well within this
  let improved = true;
  let passes = 0;
  while (improved && passes++ < maxPasses) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        if (reverseDelta(order, m, i, k) < -1e-6) {
          let lo = i;
          let hi = k;
          while (lo < hi) {
            [order[lo], order[hi]] = [order[hi], order[lo]];
            lo++;
            hi--;
          }
          improved = true;
        }
      }
    }
  }
  return order;
}

// Or-opt: move single stops to a better position (cleans up what 2-opt misses). The
// remove/insert deltas use directed edges, so they are already correct on an asymmetric
// matrix; the pass count is still hard-capped as a safety net against pathological input.
function orOpt(order, m) {
  const n = order.length;
  const maxPasses = 4 * n * n + 50;
  let improved = true;
  let passes = 0;
  while (improved && passes++ < maxPasses) {
    improved = false;
    for (let i = 1; i < n; i++) {
      const prev = order[i - 1];
      const node = order[i];
      const next = order[(i + 1) % n];
      const removeGain = m[prev][node] + m[node][next] - m[prev][next];
      for (let j = 1; j < n; j++) {
        if (j === i || j === i - 1) continue;
        const p = order[j];
        const q = order[(j + 1) % n];
        if (p === node || q === node) continue;
        const insertCost = m[p][node] + m[node][q] - m[p][q];
        if (insertCost - removeGain < -1e-6) {
          const [moved] = order.splice(i, 1);
          const dest = j > i ? j : j + 1;
          order.splice(dest, 0, moved);
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return order;
}

// Solve a closed-loop TSP from node 0 over a real-distance matrix. Nearest-neighbor
// seed + 2-opt/Or-opt polish, PLUS random restarts to escape local minima (cheap
// for a courier's <=100 stops). Returns the best tour found and its true length.
export function solveMatrix(real) {
  const n = real.length;
  const polish = (o) => {
    o = twoOpt(o, real);
    o = orOpt(o, real);
    o = twoOpt(o, real); // one more pass after Or-opt
    return o;
  };
  let best = polish(nearestNeighbor(real, n));
  let bestLen = tourLength(best, real);

  // Deterministic RNG so routes are stable/reproducible for the same input.
  let seed = (0x9e3779b1 ^ (n * 2654435761)) & 0x7fffffff;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const restarts = n <= 12 ? 40 : n <= 40 ? 12 : 4;
  for (let r = 0; r < restarts; r++) {
    const rest = [];
    for (let i = 1; i < n; i++) rest.push(i);
    for (let i = rest.length - 1; i > 0; i--) { // Fisher-Yates shuffle (base stays at 0)
      const j = Math.floor(rnd() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const cand = polish([0, ...rest]);
    const len = tourLength(cand, real);
    if (len < bestLen - 1e-6) { bestLen = len; best = cand; }
  }
  return { order: best, totalMeters: bestLen };
}

// --- Parcel priority --------------------------------------------------------
// Route quality comes first: we optimize pure distance, THEN nudge. This post-pass
// pulls a parcel stop ahead of an immediately-preceding non-parcel (letter/magazine)
// stop ONLY when doing so adds at most PRIORITY_TOLERANCE to that local 3-edge
// segment. So parcels win near-ties ("mail left, parcels right" or mail only a
// little closer), but a clearly shorter mail-first leg is never sacrificed — the
// swap is rejected. Works on whatever real matrix the route used (road or straight),
// so the tie-break is measured in the same metric that is reported to the user.
const PRIORITY_TOLERANCE = 0.15; // accept <=15% local detour to serve a parcel earlier

function reorderByPriority(order, real, priority) {
  const n = order.length; // node 0 (base) sits at order[0]
  const d = (a, b) => real[a][b];
  let improved = true;
  while (improved) {
    improved = false;
    for (let p = 1; p < n - 1; p++) {
      const x = order[p];
      const y = order[p + 1];
      if (!(priority[y] && !priority[x])) continue; // only pull a parcel ahead of non-parcel
      const a = order[p - 1];
      const b = order[(p + 2) % n]; // wraps to base for the closing edge
      // Near-tie test: from the current point a, reaching the parcel y first must be
      // at most TOL farther than reaching the mail stop x first. This is the "mail a
      // little closer -> still take the parcel" case; a parcel that is clearly farther
      // fails here, so it is never dragged forward into a detour. The budget is a
      // fraction of the SHORT next-step distance, not of the whole segment.
      const budget = PRIORITY_TOLERANCE * d(a, x);
      const nextStepPenalty = d(a, y) - d(a, x);
      const loopPenalty = d(a, y) + d(x, b) - d(a, x) - d(y, b); // total added km if swapped
      if (nextStepPenalty <= budget && loopPenalty <= budget) {
        order[p] = y;
        order[p + 1] = x;
        improved = true;
      }
    }
  }
  return order;
}

// Road-network optimization with parcel priority: pull a real road-distance matrix
// from the public OSRM "table" service, then run our own priority-weighted solver.
// Closed loop from Base. Throws on error so the caller can fall back. Nulls in the
// matrix (unreachable pairs) are estimated from straight-line distance.
// base: {lat,lng}, stops: [{id,lat,lng,priority}].
export async function roadRoute(base, stops, { priority = true, timeoutMs = 6500 } = {}) {
  const usable = stops.filter((s) => s && typeof s.lat === 'number' && typeof s.lng === 'number');
  const skipped = stops.filter((s) => !(s && typeof s.lat === 'number' && typeof s.lng === 'number'));
  if (!usable.length) return { orderedIds: [], totalMeters: 0, usableCount: 0, skipped };

  const nodes = [{ lat: base.lat, lng: base.lng, id: '__base__', priority: false }, ...usable];
  const coordStr = nodes.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/table/v1/driving/${coordStr}?annotations=distance`;
  const data = await fetchJson(url, { timeoutMs });
  if (data.code !== 'Ok' || !Array.isArray(data.distances)) {
    throw new Error(data.message || 'OSRM table error');
  }
  // Sanitize: OSRM returns null for unreachable pairs — fall back to straight-line.
  const real = data.distances.map((row, i) =>
    row.map((v, j) => (typeof v === 'number' ? v : haversine(nodes[i], nodes[j]))),
  );
  let { order } = solveMatrix(real); // shortest real-road loop first
  const prio = nodes.map((nd) => (priority ? !!nd.priority : false));
  order = reorderByPriority(order, real, prio); // then nudge parcels earlier on ties
  const totalMeters = tourLength(order, real);
  const orderedIds = order.slice(1).map((idx) => nodes[idx].id);
  return { orderedIds, totalMeters, usableCount: usable.length, skipped, provider: 'osrm' };
}

// Road-network optimization via the public OSRM "trip" service (solves TSP on real
// roads, closed loop from Base). No priority weighting — kept as a fallback for
// roadRoute. Throws on error so the caller can fall back to the straight-line
// solver. base: {lat,lng}, stops: [{id,lat,lng}].
export async function roadTrip(base, stops, { timeoutMs = 3500 } = {}) {
  const usable = stops.filter((s) => s && typeof s.lat === 'number' && typeof s.lng === 'number');
  const skipped = stops.filter((s) => !(s && typeof s.lat === 'number' && typeof s.lng === 'number'));
  if (!usable.length) return { orderedIds: [], totalMeters: 0, usableCount: 0, skipped };

  const coordStr = [base, ...usable].map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/trip/v1/driving/${coordStr}?source=first&roundtrip=true&overview=false`;
  const data = await fetchJson(url, { timeoutMs });
  if (data.code !== 'Ok' || !Array.isArray(data.waypoints)) {
    throw new Error(data.message || 'OSRM error');
  }
  // waypoints keep input order; waypoint_index is the position in the optimized trip.
  const inputAtPos = new Array(data.waypoints.length);
  data.waypoints.forEach((w, i) => { inputAtPos[w.waypoint_index] = i; });
  // Position 0 is Base (source=first). Remaining positions map to stops (input i-1).
  const orderedIds = inputAtPos.filter((i) => i !== 0).map((i) => usable[i - 1].id);
  const totalMeters = (data.trips && data.trips[0] && data.trips[0].distance) || 0;
  return { orderedIds, totalMeters, usableCount: usable.length, skipped, provider: 'osrm' };
}

// base: {lat,lng}. stops: [{id, lat, lng, ...}]. Returns ordered stop ids + total meters.
export function computeRoute(base, stops) {
  const usable = stops.filter((s) => s && typeof s.lat === 'number' && typeof s.lng === 'number');
  const skipped = stops.filter((s) => !(s && typeof s.lat === 'number' && typeof s.lng === 'number'));

  if (usable.length === 0) {
    return { orderedIds: [], totalMeters: 0, usableCount: 0, skipped };
  }

  const nodes = [{ lat: base.lat, lng: base.lng, id: '__base__', priority: false }, ...usable];
  const real = buildMatrix(nodes);
  const priority = nodes.map((nd) => !!nd.priority);

  let { order } = solveMatrix(real); // shortest straight-line loop first
  order = reorderByPriority(order, real, priority); // then nudge parcels earlier on ties
  const totalMeters = tourLength(order, real);
  // Drop Base(0) from output; caller knows the loop starts & ends at Base.
  const orderedIds = order.slice(1).map((idx) => nodes[idx].id);

  return { orderedIds, totalMeters, usableCount: usable.length, skipped, provider: 'straight' };
}
