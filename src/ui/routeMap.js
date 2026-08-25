// Leaflet-based route map. Loaded on demand (dynamic import from app.js) so Leaflet and its
// CSS never weigh on first paint or the offline-first path — the map is an optional view.
//
// Design choices for old Android WebViews and GDPR:
// - Leaflet 1.9.x runs fine on the project's chrome80 build target.
// - Numbered markers are custom L.divIcon (pure HTML/CSS), NOT the default PNG markers — this
//   sidesteps the well-known Vite/PWA broken-marker-image path problem entirely.
// - Tiles come from OpenStreetMap (no API key). They are fetched over the network, so the map
//   is not usable fully offline and the © OpenStreetMap attribution is mandatory (kept below).
// - Pinch-to-zoom is Leaflet's built-in touchZoom (on by default); we only make it explicit.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

function numberedIcon(label, extraClass) {
  return L.divIcon({
    className: 'map-pin-wrap',
    html: `<span class="map-pin ${extraClass || ''}">${label}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14],
  });
}

// container: a DOM node already in the document. base: {lat,lng} | null.
// Returns { update(stops, fit), invalidate(), destroy() }.
export function createRouteMap(container, base) {
  const map = L.map(container, {
    zoomControl: true,
    attributionControl: true,
    touchZoom: true,        // pinch-to-zoom with two fingers
    tap: true,
  });
  map.setView(base ? [base.lat, base.lng] : [53.89, 13.04], 12);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    // Full licence attribution required by the OSM Tile Usage Policy (link + "contributors").
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(map);

  const layer = L.layerGroup().addTo(map);

  function draw(stops, fit) {
    layer.clearLayers();
    const loop = [];

    if (base) {
      loop.push([base.lat, base.lng]);
      L.marker([base.lat, base.lng], { icon: numberedIcon('🏁', 'base'), keyboard: false }).addTo(layer);
    }

    (stops || []).forEach((p, i) => {
      if (!p || !p.coords) return;
      const ll = [p.coords.lat, p.coords.lng];
      loop.push(ll);
      const label = (p.address && (p.address.display || p.address.raw)) || '';
      // Build the popup as a DOM node and set the address via textContent — an address can come
      // from OCR/manual input, so never interpolate it into an HTML string (injection risk).
      const popup = document.createElement('div');
      popup.className = 'map-popup';
      popup.textContent = `${i + 1}. ${label}`;
      L.marker(ll, { icon: numberedIcon(String(i + 1)), keyboard: false })
        .addTo(layer)
        .bindPopup(popup);
    });

    if (base && loop.length > 1) loop.push([base.lat, base.lng]); // close the loop back to base

    // Thin line "symbolising" the route order (straight segments, not road geometry).
    if (loop.length > 1) {
      L.polyline(loop, { color: '#2f5bd6', weight: 2, opacity: 0.9 }).addTo(layer);
    }

    // Fit only when asked (first open). Manual reorders redraw without resetting the view,
    // so the courier keeps their current pan/zoom.
    if (fit && loop.length) {
      try { map.fitBounds(L.latLngBounds(loop).pad(0.15)); } catch (e) { /* single point / bad bounds */ }
    }
  }

  return {
    update(stops, fit) { draw(stops, !!fit); },
    invalidate() { map.invalidateSize(); },
    destroy() { try { map.remove(); } catch (e) { /* already gone */ } },
  };
}
