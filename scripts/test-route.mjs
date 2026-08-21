// Deterministic tests for the TSP solver on ASYMMETRIC matrices — the shape an OSRM road
// table has (A→B ≠ B→A). Before the fix, 2-opt used a symmetric delta and could spin forever
// AFTER a successful fetch (so the AbortController timeout did NOT help). These assert it now
// (a) always terminates quickly and (b) never returns a tour longer than the naive order.
// Run: node scripts/test-route.mjs
import { orsOptimize, solveMatrix } from '../src/core/route.js';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ FAIL:', name, detail); }
}

function tourLength(order, m) {
  let t = 0;
  for (let i = 0; i < order.length - 1; i++) t += m[order[i]][order[i + 1]];
  t += m[order[order.length - 1]][order[0]];
  return t;
}
// Deterministic asymmetric matrix: m[i][j] independent of m[j][i].
function asym(n, seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) m[i][j] = Math.round(10 + rnd() * 100);
  return m;
}

// --- 1) 5-node asymmetric matrices: terminate + never worse than the naive tour ----
{
  let worse = 0;
  let mismatch = 0;
  const t0 = Date.now();
  for (let seed = 1; seed <= 500; seed++) {
    const m = asym(5, seed);
    const naive = tourLength([0, 1, 2, 3, 4], m);
    const { order, totalMeters } = solveMatrix(m);
    if (Math.abs(tourLength(order, m) - totalMeters) > 1e-6) mismatch++; // reported length must be real
    if (tourLength(order, m) > naive + 1e-6) worse++;                    // must never worsen the tour
  }
  const ms = Date.now() - t0;
  ok('asymmetric 5-node: 500 solves terminate fast', ms < 5000, `${ms} ms`);
  ok('asymmetric 5-node: never worse than naive order', worse === 0, `${worse} worse`);
  ok('asymmetric 5-node: reported length == real length', mismatch === 0, `${mismatch} mismatched`);
}

// --- 2) larger asymmetric matrices still finish quickly (no runaway loop) ----------
{
  const t0 = Date.now();
  for (const n of [12, 25, 40]) {
    const r = solveMatrix(asym(n, n * 7 + 1));
    ok(`asymmetric ${n}-node solved`, Array.isArray(r.order) && r.order.length === n && isFinite(r.totalMeters));
  }
  ok('asymmetric 12/25/40-node under 3 s total', Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
}

// --- 3) a hand-built asymmetric case that broke the old symmetric delta -------------
{
  // Strongly directional costs: cheap "forward" ring, expensive "backward" edges. The correct
  // solver must not reverse a segment expecting the old cost to hold.
  const INF = 1000;
  const m = [
    [0, 1, INF, INF, 1],
    [INF, 0, 1, INF, INF],
    [INF, INF, 0, 1, INF],
    [1, INF, INF, 0, 1],
    [1, INF, INF, INF, 0],
  ];
  const { order, totalMeters } = solveMatrix(m);
  ok('directional 5-node: terminates', Array.isArray(order) && order.length === 5);
  ok('directional 5-node: reported == real', Math.abs(tourLength(order, m) - totalMeters) < 1e-6, `${totalMeters} vs ${tourLength(order, m)}`);
}

// --- 4) ORS/VROOM proxy request + response mapping ----------------------------------
{
  let seen = null;
  const fetchImpl = async (url, options) => {
    seen = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      road_distance: 4321,
      routes: [{
        steps: [
          { type: 'start' },
          { type: 'job', id: 2 },
          { type: 'job', id: 1 },
          { type: 'end' },
        ],
      }],
      unassigned: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await orsOptimize(
    { lat: 53.89, lng: 13.04 },
    [
      { id: 'stop-a', lat: 53.90, lng: 13.05, priority: false, group: '17109|demmin' },
      { id: 'stop-b', lat: 53.91, lng: 13.06, priority: true, group: '18465|tribsees' },
    ],
    { endpoint: 'https://proxy.example/optimize', fetchImpl },
  );
  ok('ORS: proxy URL used', seen.url === 'https://proxy.example/optimize', seen.url);
  ok('ORS: POST JSON without API key header', seen.options.method === 'POST' && !seen.options.headers.Authorization, JSON.stringify(seen.options.headers));
  ok('ORS: coordinates are [lng,lat]', seen.body.jobs[0].location[0] === 13.05 && seen.body.jobs[0].location[1] === 53.90, JSON.stringify(seen.body.jobs[0].location));
  ok('ORS: parcel priority forwarded', seen.body.jobs[1].priority === 100, JSON.stringify(seen.body.jobs[1]));
  ok('ORS: locality group forwarded to our proxy', seen.body.jobs[0].group === '17109|demmin', JSON.stringify(seen.body.jobs[0]));
  ok('ORS: optimized job ids map back to point ids', JSON.stringify(result.orderedIds) === JSON.stringify(['stop-b', 'stop-a']), JSON.stringify(result.orderedIds));
  ok('ORS: proxy road distance/provider returned', result.totalMeters === 4321 && result.provider === 'ors', JSON.stringify(result));
}

// --- 5) ORS failure is bounded and rejects incomplete routes -------------------------
{
  let incompleteRejected = false;
  try {
    await orsOptimize(
      { lat: 1, lng: 2 },
      [{ id: 'a', lat: 3, lng: 4 }, { id: 'b', lat: 5, lng: 6 }],
      {
        endpoint: 'https://proxy.example/optimize',
        fetchImpl: async () => new Response(JSON.stringify({
          routes: [{ distance: 1, steps: [{ type: 'job', id: 1 }] }],
          unassigned: [{ id: 2 }],
        }), { status: 200 }),
      },
    );
  } catch (error) { incompleteRejected = true; }
  ok('ORS: incomplete route rejected for fallback', incompleteRejected);

  const t0 = Date.now();
  let timedOut = false;
  try {
    await orsOptimize(
      { lat: 1, lng: 2 },
      [{ id: 'a', lat: 3, lng: 4 }],
      {
        endpoint: 'https://proxy.example/optimize',
        timeoutMs: 20,
        fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      },
    );
  } catch (error) { timedOut = error?.name === 'AbortError'; }
  ok('ORS: timeout aborts request', timedOut && Date.now() - t0 < 500, `${Date.now() - t0} ms`);
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
