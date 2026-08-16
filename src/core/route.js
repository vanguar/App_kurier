// Route ordering: closed loop Base -> ... -> Base.
// Distance metric: haversine (straight-line). Solver: nearest-neighbor + 2-opt/Or-opt.
// Runs entirely on-device; handles up to ~100 stops instantly.

const R = 6371000; // Earth radius, meters

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

// 2-opt: reverse segments between i..k (never touching Base at index 0).
function twoOpt(order, m) {
  const n = order.length;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const a = order[i - 1];
        const b = order[i];
        const c = order[k];
        const d = order[(k + 1) % n]; // wraps to Base to keep loop closed
        const delta = m[a][c] + m[b][d] - m[a][b] - m[c][d];
        if (delta < -1e-6) {
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

// Or-opt: move single stops to a better position (cleans up what 2-opt misses).
function orOpt(order, m) {
  const n = order.length;
  let improved = true;
  while (improved) {
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

// Road-network optimization via the public OSRM "trip" service (solves TSP on real
// roads, closed loop from Base). Throws on error so the caller can fall back to
// the straight-line solver. base: {lat,lng}, stops: [{id,lat,lng}].
export async function roadTrip(base, stops) {
  const usable = stops.filter((s) => s && typeof s.lat === 'number' && typeof s.lng === 'number');
  const skipped = stops.filter((s) => !(s && typeof s.lat === 'number' && typeof s.lng === 'number'));
  if (!usable.length) return { orderedIds: [], totalMeters: 0, usableCount: 0, skipped };

  const coordStr = [base, ...usable].map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/trip/v1/driving/${coordStr}?source=first&roundtrip=true&overview=false`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok' || !Array.isArray(data.waypoints)) {
    throw new Error(data.message || 'OSRM error');
  }
  // waypoints keep input order; waypoint_index is the position in the optimized trip.
  const inputAtPos = new Array(data.waypoints.length);
  data.waypoints.forEach((w, i) => { inputAtPos[w.waypoint_index] = i; });
  // Position 0 is Base (source=first). Remaining positions map to stops (input i-1).
  const orderedIds = inputAtPos.filter((i) => i !== 0).map((i) => usable[i - 1].id);
  const totalMeters = (data.trips && data.trips[0] && data.trips[0].distance) || 0;
  return { orderedIds, totalMeters, usableCount: usable.length, skipped };
}

// base: {lat,lng}. stops: [{id, lat, lng, ...}]. Returns ordered stop ids + total meters.
export function computeRoute(base, stops) {
  const usable = stops.filter((s) => s && typeof s.lat === 'number' && typeof s.lng === 'number');
  const skipped = stops.filter((s) => !(s && typeof s.lat === 'number' && typeof s.lng === 'number'));

  if (usable.length === 0) {
    return { orderedIds: [], totalMeters: 0, usableCount: 0, skipped };
  }

  const nodes = [{ lat: base.lat, lng: base.lng, id: '__base__' }, ...usable];
  const m = buildMatrix(nodes);

  let order = nearestNeighbor(m, nodes.length);
  order = twoOpt(order, m);
  order = orOpt(order, m);
  order = twoOpt(order, m); // one more pass after Or-opt

  const totalMeters = tourLength(order, m);
  // Drop Base(0) from output; caller knows the loop starts & ends at Base.
  const orderedIds = order.slice(1).map((idx) => nodes[idx].id);

  return { orderedIds, totalMeters, usableCount: usable.length, skipped };
}
