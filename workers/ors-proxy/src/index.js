const ORS_OPTIMIZATION_URL = 'https://api.heigit.org/vroom/v0';
const ORS_DIRECTIONS_URL = 'https://api.heigit.org/openrouteservice/v2/directions/driving-car';
const MAX_BODY_BYTES = 64 * 1024;
// Directions receives Base + jobs + Base and accepts at most 50 coordinates.
const MAX_JOBS = 48;
const MAX_GROUP_CHARS = 96;

function originAllowed(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return !!origin && allowed.includes(origin);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
}

function json(status, body, origin = '') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(origin ? corsHeaders(origin) : { 'Cache-Control': 'no-store' }),
    },
  });
}

function validLocation(value) {
  return Array.isArray(value)
    && value.length === 2
    && Number.isFinite(value[0])
    && Number.isFinite(value[1])
    && value[0] >= -180 && value[0] <= 180
    && value[1] >= -90 && value[1] <= 90;
}

function haversineMeters(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function closedAirDistance(order, locations, base) {
  let total = 0;
  let previous = base;
  for (const id of order) {
    const next = locations.get(id);
    if (!next) return Infinity;
    total += haversineMeters(previous, next);
    previous = next;
  }
  return total + haversineMeters(previous, base);
}

// VROOM minimizes a CLOSED loop. For a distant town, inserting that town halfway through a
// compact base-town cluster can cost almost exactly the same as visiting it last: both tours
// have one outbound and one return leg. That mathematical tie is terrible for a courier. Keep
// each known locality contiguous when the grouped alternative is within a modest air-distance
// tolerance; Directions below then recomputes the exact road length for the chosen order.
function consolidateLocalities(order, groups, locations, base) {
  const buckets = new Map();
  const groupOrder = [];
  for (const id of order) {
    const group = groups.get(id) || `__single:${id}`;
    if (!buckets.has(group)) {
      buckets.set(group, []);
      groupOrder.push(group);
    }
    buckets.get(group).push(id);
  }
  const candidate = groupOrder.flatMap((group) => buckets.get(group));
  if (candidate.every((id, index) => id === order[index])) return order;

  const originalMeters = closedAirDistance(order, locations, base);
  const groupedMeters = closedAirDistance(candidate, locations, base);
  // Accept near-ties (or improvements), but never force town grouping through a large detour.
  return groupedMeters <= originalMeters * 1.12 + 2000 ? candidate : order;
}

function sanitizePayload(input) {
  if (!input || !Array.isArray(input.jobs) || !Array.isArray(input.vehicles)) {
    throw new Error('jobs and vehicles arrays are required');
  }
  if (!input.jobs.length || input.jobs.length > MAX_JOBS) {
    throw new Error(`jobs must contain 1-${MAX_JOBS} stops`);
  }
  if (input.vehicles.length !== 1) throw new Error('exactly one vehicle is supported');

  const ids = new Set();
  const groups = new Map();
  const jobs = input.jobs.map((job) => {
    if (!Number.isInteger(job?.id) || job.id <= 0 || ids.has(job.id)) {
      throw new Error('every job needs a unique positive integer id');
    }
    if (!validLocation(job.location)) throw new Error('invalid job location');
    ids.add(job.id);
    const clean = { id: job.id, location: job.location };
    if (Number.isInteger(job.priority) && job.priority >= 0 && job.priority <= 100) {
      clean.priority = job.priority;
    }
    if (typeof job.group === 'string') {
      const group = job.group.trim();
      if (group && group.length <= MAX_GROUP_CHARS) groups.set(job.id, group);
    }
    return clean;
  });

  const vehicle = input.vehicles[0];
  if (!validLocation(vehicle?.start) || !validLocation(vehicle?.end)) {
    throw new Error('vehicle start/end coordinates are required');
  }
  return {
    payload: {
      jobs,
      vehicles: [{
        id: 1,
        profile: 'driving-car',
        start: vehicle.start,
        end: vehicle.end,
      }],
    },
    groups,
  };
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json(200, { ok: true, service: 'kurier-ors-proxy' });
  }

  const origin = request.headers.get('Origin') || '';
  if (!originAllowed(origin, env)) return json(403, { error: 'Origin not allowed' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== 'POST' || url.pathname !== '/optimize') {
    return json(404, { error: 'Not found' }, origin);
  }
  if (!env.ORS_API_KEY) return json(503, { error: 'ORS_API_KEY is not configured' }, origin);

  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_BODY_BYTES) return json(413, { error: 'Request too large' }, origin);
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'Request too large' }, origin);

  let payload;
  let groups;
  try {
    ({ payload, groups } = sanitizePayload(JSON.parse(raw)));
  } catch (error) {
    return json(400, { error: error?.message || 'Invalid JSON payload' }, origin);
  }

  const deadline = Date.now() + 11000;
  const fetchBeforeDeadline = async (url, options) => {
    const ctrl = new AbortController();
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try { return await fetchImpl(url, { ...options, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  };
  try {
    const upstream = await fetchBeforeDeadline(ORS_OPTIMIZATION_URL, {
      method: 'POST',
      headers: {
        Authorization: env.ORS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const optimizationText = await upstream.text();
    if (!upstream.ok) {
      return new Response(optimizationText, {
        status: upstream.status,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    let optimization;
    try { optimization = JSON.parse(optimizationText); }
    catch (error) { return json(502, { error: 'Invalid ORS optimization response' }, origin); }
    const route = Array.isArray(optimization.routes) && optimization.routes[0];
    if (!route || !Array.isArray(route.steps)) {
      return json(502, { error: 'ORS optimization returned no route' }, origin);
    }

    // VROOM returns the optimized order and duration/cost, but not road distance. Ask the
    // Directions endpoint for the exact distance along that order so the UI never shows 0 km.
    const locations = new Map(payload.jobs.map((job) => [job.id, job.location]));
    const jobSteps = route.steps
      .filter((step) => step?.type === 'job' && locations.has(step.id))
    const originalOrder = jobSteps.map((step) => step.id);
    if (originalOrder.length !== payload.jobs.length || new Set(originalOrder).size !== payload.jobs.length) {
      return json(502, { error: 'ORS optimization left stops unassigned' }, origin);
    }
    const groupedOrder = consolidateLocalities(
      originalOrder,
      groups,
      locations,
      payload.vehicles[0].start,
    );
    const grouped = groupedOrder.some((id, index) => id !== originalOrder[index]);
    if (grouped) {
      const stepsById = new Map(jobSteps.map((step) => [step.id, step]));
      route.steps = [
        route.steps.find((step) => step?.type === 'start'),
        ...groupedOrder.map((id) => stepsById.get(id)),
        route.steps.find((step) => step?.type === 'end'),
      ].filter(Boolean);
    }
    const ordered = groupedOrder.map((id) => locations.get(id));
    const directions = await fetchBeforeDeadline(ORS_DIRECTIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: env.ORS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        coordinates: [payload.vehicles[0].start, ...ordered, payload.vehicles[0].end],
        instructions: false,
        geometry: false,
      }),
    });
    const directionsText = await directions.text();
    if (!directions.ok) {
      return json(502, { error: 'ORS directions unavailable after optimization' }, origin);
    }
    let directionsData;
    try { directionsData = JSON.parse(directionsText); }
    catch (error) { return json(502, { error: 'Invalid ORS directions response' }, origin); }
    const distance = directionsData?.routes?.[0]?.summary?.distance;
    if (!Number.isFinite(distance)) return json(502, { error: 'ORS directions returned no distance' }, origin);

    optimization.road_distance = distance;
    optimization.locality_grouping_applied = grouped;
    return json(200, optimization, origin);
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return json(timedOut ? 504 : 502, { error: timedOut ? 'ORS timeout' : 'ORS unavailable' }, origin);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
