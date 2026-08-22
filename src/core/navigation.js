// Pure navigation policy. A complete postal address is the primary destination because
// third-party map apps can resolve it against their own, often newer, address databases.
// Automatic OSM coordinates are only route-order hints; exact lat/lng is used when the
// courier saved the entrance on site or when a stop genuinely has no postal address.

export function pointHasPostalAddress(point) {
  const address = point?.address || {};
  return !!(
    String(address.street || '').trim()
    && String(address.houseNumber || '').trim()
  );
}

export function pointNavOptions(point) {
  return { addressOnly: pointHasPostalAddress(point) && !point?.coordinateManual };
}

const NAV_URLS = {
  google: ({ lat, lng }, label, options) => options.addressOnly
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(label || '')}&travelmode=driving`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
  waze: ({ lat, lng }, label, options) => options.addressOnly
    ? `https://waze.com/ul?q=${encodeURIComponent(label || '')}&navigate=yes`
    : `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`,
  geo: ({ lat, lng }, label, options) => options.addressOnly
    ? `geo:0,0?q=${encodeURIComponent(label || '')}`
    : `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(label || '')})`,
  apple: ({ lat, lng }, label, options) => options.addressOnly
    ? `https://maps.apple.com/?daddr=${encodeURIComponent(label || '')}&dirflg=d`
    : `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`,
};

export function navigationUrl(navigatorKey, coords, label, options = {}) {
  const build = NAV_URLS[navigatorKey];
  if (!build) throw new Error(`Unknown navigator: ${navigatorKey}`);
  return build(coords || { lat: 0, lng: 0 }, label, options);
}
