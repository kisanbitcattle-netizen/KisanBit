// src/utils/reverseGeocode.js
//
// Turns a [lat, lng] point into a readable place name (village/town level)
// using OpenStreetMap's Nominatim service - same OSM ecosystem the app's
// Leaflet map tiles already come from (see OfflineTileLayer.jsx), free,
// no API key.
//
// Deliberately best-effort and non-blocking: farmers are often out in a
// field with poor/no signal exactly when they're pinning a location, so
// a failed/slow lookup must never block saving a Cattle Base or an
// animal's own geofence point. Callers should treat a null return as
// "leave place_name blank, not an error to surface to the user."
//
// Nominatim's usage policy asks for a real identifying User-Agent/Referer
// and no more than ~1 request/sec - fine here since this only runs once
// per save, not on every render or map pan.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const REQUEST_TIMEOUT_MS = 6000;

// Picks the most village/town-appropriate label out of Nominatim's
// address breakdown, falling back to broader levels if the specific
// ones aren't present for this point (e.g. more remote areas).
function pickPlaceLabel(address) {
  if (!address) return null;
  return (
    address.village ||
    address.town ||
    address.suburb ||
    address.county ||
    address.city ||
    address.state_district ||
    address.state ||
    null
  );
}

export async function reverseGeocode(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `${NOMINATIM_URL}?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Nominatim's usage policy requires an identifying User-Agent -
        // browsers block custom User-Agent headers on fetch, so this is
        // the closest equivalent actually settable client-side. Swap in
        // a real contact/app URL if the packaged app can set a proper
        // User-Agent natively instead.
        'Accept-Language': 'en',
      },
    });
    if (!response.ok) return null;

    const data = await response.json();
    return pickPlaceLabel(data?.address) || data?.display_name?.split(',')[0] || null;
  } catch (_err) {
    // Offline, timed out, rate-limited, or malformed response - all
    // non-fatal for the caller, see file header.
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}