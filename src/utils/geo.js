// src/utils/geo.js
//
// Shared WKB (Well-Known Binary) point parser for PostGIS geography/geometry
// columns, which PostgREST returns as raw hex strings rather than GeoJSON
// unless the select is explicitly cast.
//
// SRID-AWARE: this is the fix for a real bug found in FullMapModal.jsx and
// MapPreviewCard.jsx, which each had their own independently-written but
// identically-wrong parseWkbPoint() that assumed coordinate bytes always
// start at a fixed offset (5 for X, 13 for Y), with no SRID header.
// PostGIS geography columns typically DO carry an embedded 4-byte SRID,
// flagged by the 0x20000000 bit in the type word - when present, it shifts
// the real X/Y bytes to offset 9/17. Reading at the naive fixed offset in
// that case decodes garbage (verified against a real cattle_bases.location
// sample, SRID 4326: old fixed-offset decode gave lon ~ -1.45e+250; this
// SRID-aware version gives the correct Hyderabad coords, [17.38, 78.49]).
//
// Also correctly handles PointZ (Z flag 0x80000000 in the type word) -
// X/Y always come before Z regardless, so no extra handling is needed
// beyond reading X/Y at the (SRID-adjusted) offset and ignoring any
// trailing Z bytes.
//
// WKB layout (PostGIS always writes little-endian for network output):
//   1 byte   — byte order (01 = little-endian)
//   4 bytes  — geometry type word (bit 0x20000000 = SRID present,
//              bit 0x80000000 = Z present)
//   4 bytes  — SRID (ONLY if the SRID flag bit is set)
//   8 bytes  — X (longitude), IEEE-754 double
//   8 bytes  — Y (latitude), IEEE-754 double
//   8 bytes  — Z (ONLY if the Z flag bit is set) — ignored, we don't need it

export function parseWkbPoint(hex) {
  if (!hex || typeof hex !== 'string') return null;
  // Minimum valid length with no SRID/Z: 1 + 4 + 8 + 8 = 21 bytes = 42 hex chars.
  if (hex.length < 42) return null;

  try {
    const byteMatches = hex.match(/.{1,2}/g);
    if (!byteMatches) return null;

    const buf = new Uint8Array(byteMatches.map((b) => parseInt(b, 16)));
    const view = new DataView(buf.buffer);

    const littleEndian = buf[0] === 1;
    const typeWord = view.getUint32(1, littleEndian);
    const hasSrid = (typeWord & 0x20000000) !== 0;

    // X starts right after byte-order + type word (5 bytes in), plus 4
    // more bytes if an SRID is embedded ahead of the coordinates.
    const xOffset = hasSrid ? 9 : 5;
    const yOffset = xOffset + 8;

    if (buf.length < yOffset + 8) return null;

    const lon = view.getFloat64(xOffset, littleEndian); // X = longitude
    const lat = view.getFloat64(yOffset, littleEndian); // Y = latitude

    if (!isFinite(lat) || !isFinite(lon)) return null;
    // Sanity bound - real lat/lng can never exceed these. Catches any
    // remaining offset mistake early instead of silently placing a pin
    // in the middle of the ocean.
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    return [lat, lon]; // react-leaflet wants [lat, lng]
  } catch {
    return null;
  }
}