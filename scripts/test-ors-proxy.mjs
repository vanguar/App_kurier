import { handleRequest } from '../workers/ors-proxy/src/index.js';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; console.log('  ✗ FAIL:', name, detail); }
}

const origin = 'https://vanguar.github.io';
const env = { ORS_API_KEY: 'secret-test-key', ALLOWED_ORIGINS: origin };
const payload = {
  jobs: [{ id: 1, location: [13.05, 53.90], priority: 100 }],
  vehicles: [{ id: 99, profile: 'anything', start: [13.04, 53.89], end: [13.04, 53.89] }],
};
const req = (body = payload, requestOrigin = origin) => new Request('https://worker.example/optimize', {
  method: 'POST',
  headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Allowed request: secret is injected only upstream and the payload is constrained.
{
  const upstream = [];
  const response = await handleRequest(req(), env, async (url, options) => {
    upstream.push({ url, options, body: JSON.parse(options.body) });
    if (url.endsWith('/vroom/v0')) {
      return new Response(JSON.stringify({
        routes: [{ steps: [{ type: 'start' }, { type: 'job', id: 1 }, { type: 'end' }] }],
        unassigned: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ routes: [{ summary: { distance: 4321 } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  });
  ok('proxy: request accepted', response.status === 200, String(response.status));
  ok('proxy: optimization + directions called', upstream.length === 2, String(upstream.length));
  ok('proxy: current HeiGIT VROOM URL', upstream[0].url === 'https://api.heigit.org/vroom/v0', upstream[0].url);
  ok('proxy: current HeiGIT Directions URL', upstream[1].url === 'https://api.heigit.org/openrouteservice/v2/directions/driving-car', upstream[1].url);
  ok('proxy: Basic Key stays server-side', upstream.every((call) => call.options.headers.Authorization === 'secret-test-key'));
  ok('proxy: only driving-car vehicle forwarded', upstream[0].body.vehicles[0].profile === 'driving-car' && upstream[0].body.vehicles[0].id === 1, JSON.stringify(upstream[0].body.vehicles));
  ok('proxy: Directions follows Base -> optimized jobs -> Base', upstream[1].body.coordinates.length === 3 && upstream[1].body.coordinates[1][0] === 13.05, JSON.stringify(upstream[1].body.coordinates));
  const responseBody = await response.json();
  ok('proxy: exact road distance added', responseBody.road_distance === 4321, JSON.stringify(responseBody));
  ok('proxy: exact CORS origin returned', response.headers.get('Access-Control-Allow-Origin') === origin);
}

// Cross-origin callers and over-sized tours are rejected before ORS is called.
{
  let called = false;
  const denied = await handleRequest(req(payload, 'https://evil.example'), env, async () => { called = true; });
  ok('proxy: disallowed browser origin rejected', denied.status === 403 && !called, String(denied.status));

  const tooMany = { ...payload, jobs: Array.from({ length: 49 }, (_, i) => ({ id: i + 1, location: [13, 53] })) };
  const oversized = await handleRequest(req(tooMany), env, async () => { called = true; });
  ok('proxy: more than 48 jobs rejected', oversized.status === 400, String(oversized.status));
}

// The Worker must fail closed when the secret was not configured.
{
  const response = await handleRequest(req(), { ALLOWED_ORIGINS: origin }, async () => {
    throw new Error('must not reach upstream');
  });
  ok('proxy: missing secret fails closed', response.status === 503, String(response.status));
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
