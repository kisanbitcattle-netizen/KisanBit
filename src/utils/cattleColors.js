// src/utils/cattleColors.js
//
// Stable per-cattle color coding, shared by MapPreviewCard.jsx,
// FullMapModal.jsx, and CattleMarker.jsx - so a given animal always
// renders with the SAME color everywhere: its pin's ring color on the
// home preview card, its pin's ring color on the full map, and its
// movement-trail polyline color on the full map.
//
// Previously FullMapModal picked a trail color via
// `TRAIL_COLORS[idx % TRAIL_COLORS.length]`, where `idx` was just the
// array position from `Object.entries(trails)` - object key order isn't
// guaranteed stable across renders/filters, so the same animal could get
// a different trail color depending on what else was in view. Hashing
// the cattle's own `id` instead makes the color deterministic and
// independent of list order, filtering, or how many other animals are
// currently shown.

export const CATTLE_COLOR_PALETTE = [
  '#1976d2', // blue
  '#d32f2f', // red
  '#7b1fa2', // purple
  '#00897b', // teal
  '#f57c00', // orange
  '#c2185b', // pink
  '#388e3c', // green
  '#5d4037', // brown
  '#0097a7', // cyan
  '#afb42b', // olive
];

// Simple deterministic string hash (djb2) - same id always maps to the
// same palette index, no lookup table or extra DB column needed.
function hashId(id) {
  const str = String(id ?? '');
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(hash);
}

export function getCattleColor(id) {
  return CATTLE_COLOR_PALETTE[hashId(id) % CATTLE_COLOR_PALETTE.length];
}