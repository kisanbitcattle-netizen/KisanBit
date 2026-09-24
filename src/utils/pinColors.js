// src/utils/pinColors.js
//
// Shared ring-color helpers for the teardrop pin design used across
// FieldMarker/PondMarker/ServiceMarker. Mirrors the pattern
// utils/cattleColors.js already uses for cattle (id -> deterministic
// color from a fixed palette), just keyed by a string label instead
// of a row id - so a given fish species or service type always
// renders the same ring color everywhere (map pins, legends, etc.)
// without needing a hand-maintained color table.

const PALETTE = [
  '#2f9e8f', '#e07a5f', '#3d5a80', '#e9c46a', '#8ab17d',
  '#c1666b', '#4c956c', '#d68c45', '#5c80bc', '#b56576',
];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Deterministic color for any label string - same species/service
// type always resolves to the same ring color.
export function colorForLabel(label) {
  if (!label) return PALETTE[0];
  return PALETTE[hashString(label) % PALETTE.length];
}

// Pond ring color: derived from the dominant (first-listed) fish
// species currently in stock, so the pin hints at what's inside
// without opening it. Falls back to a neutral water-blue when the
// pond has no fish stock recorded yet.
export function getPondColor(fishStock = []) {
  const firstSpecies = fishStock[0]?.fish_species;
  return firstSpecies ? colorForLabel(firstSpecies) : '#3d5a80';
}

// Service ring color: derived from the service type/category, keyed
// the same as SERVICE_TYPES in AddServiceForm.jsx.
export function getServiceColor(serviceType) {
  return colorForLabel(serviceType);
}