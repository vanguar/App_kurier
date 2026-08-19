// Spatial disambiguation for the courier-device screen.
//
// The device list is ordered by route section (the "81-13" codes group nearby stops), so
// consecutive stops are geographically close. When one stop is ambiguous — the same street
// name exists in several villages (e.g. "Dorfstraße 48" in 28 places) — we pick the
// candidate closest to its already-resolved LIST NEIGHBOURS instead of asking the courier.
//
// Using list adjacency captures the section grouping implicitly (same-section stops are
// contiguous), so we don't need to parse the code itself.

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// stops: ordered [{ coords:{lat,lng}|null, candidates:[{lat,lng,...}] }].
// Returns, per stop, { chosenIndex, distanceKm } when a confident pick exists, else null.
// A pick is confident when the nearest candidate is within `maxKm` of the neighbour anchor
// AND clearly closer than the runner-up (<= ratio * second). Otherwise we stay unsure and
// leave the stop for a manual choice (a wrong auto-green is worse than a prompt).
export function autoResolveByNeighbors(stops, { maxKm = 15, ratio = 0.6, neighbors = 3 } = {}) {
  const resolved = stops
    .map((s, i) => (s && s.coords && typeof s.coords.lat === 'number' ? { i, c: s.coords } : null))
    .filter(Boolean);

  return stops.map((s, i) => {
    if (!s || s.coords || !(s.candidates && s.candidates.length)) return null;
    const near = resolved
      .slice()
      .sort((a, b) => Math.abs(a.i - i) - Math.abs(b.i - i))
      .slice(0, neighbors);
    if (!near.length) return null;

    const anchor = { lat: avg(near.map((n) => n.c.lat)), lng: avg(near.map((n) => n.c.lng)) };
    const scored = s.candidates
      .map((c, idx) => ({ idx, d: haversineKm(anchor, c) }))
      .sort((a, b) => a.d - b.d);
    const best = scored[0];
    const second = scored[1];
    const confident = best && best.d <= maxKm && (!second || best.d <= ratio * second.d);
    return confident ? { chosenIndex: best.idx, distanceKm: best.d } : null;
  });
}
