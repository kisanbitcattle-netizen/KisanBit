// src/utils/aquaSpeciesTaxonomy.js
//
// Single source of truth for every aquaculture species the app knows
// about: its display label, emoji, and grouping (for AddFishStockForm's
// species picker) - same role animalTaxonomy.js plays for AddCattleForm's
// animal type picker, deliberately mirrored in shape so both pickers can
// share the same grouped-button UI pattern.
//
// Unlike ANIMAL_TAXONOMY, there's no separate "type -> breed" split here.
// A pond stocks a SPECIES directly (Rohu, Vannamei Shrimp, Mud Crab...) -
// there's no intermediate category the farmer picks before narrowing to a
// specific breed the way cow -> Gir/Sahiwal/... works. So each entry here
// maps directly to the single `fish_species` text column on
// pond_fish_stock (same column the old free-text input wrote to) - this
// is a nicer picker for that same column, not a new column.
//
// 'other' lets the farmer type a species not in this list - AddFishStockForm
// shows a text input when 'other' is selected, and stores whatever they
// type as the final fish_species value, exactly like AddCattleForm's
// breed "Other" flow.

export const AQUA_SPECIES_TAXONOMY = {
  // ── Freshwater Fish ──
  rohu:        { label: 'Rohu',              emoji: '🐟', group: 'Freshwater Fish' },
  catla:       { label: 'Catla',              emoji: '🐟', group: 'Freshwater Fish' },
  mrigal:      { label: 'Mrigal',             emoji: '🐟', group: 'Freshwater Fish' },
  commonCarp:  { label: 'Common Carp',        emoji: '🐟', group: 'Freshwater Fish' },
  grassCarp:   { label: 'Grass Carp',         emoji: '🐟', group: 'Freshwater Fish' },
  silverCarp:  { label: 'Silver Carp',        emoji: '🐟', group: 'Freshwater Fish' },
  tilapia:     { label: 'Tilapia',            emoji: '🐟', group: 'Freshwater Fish' },
  pangasius:   { label: 'Pangasius (Basa)',   emoji: '🐟', group: 'Freshwater Fish' },
  murrel:      { label: 'Murrel (Snakehead)', emoji: '🐟', group: 'Freshwater Fish' },
  magur:       { label: 'Magur (Walking Catfish)', emoji: '🐟', group: 'Freshwater Fish' },
  singhi:      { label: 'Singhi (Stinging Catfish)', emoji: '🐟', group: 'Freshwater Fish' },
  koi:         { label: 'Koi Carp (Ornamental)', emoji: '🐠', group: 'Freshwater Fish' },

  // ── Marine & Brackish Fish ──
  seabass:     { label: 'Seabass (Bhetki)',   emoji: '🐟', group: 'Marine & Brackish Fish' },
  pomfret:     { label: 'Pomfret',            emoji: '🐟', group: 'Marine & Brackish Fish' },
  mullet:      { label: 'Mullet',             emoji: '🐟', group: 'Marine & Brackish Fish' },
  milkfish:    { label: 'Milkfish',           emoji: '🐟', group: 'Marine & Brackish Fish' },

  // ── Prawns & Shrimp ──
  vannameiShrimp:   { label: 'Vannamei (Pacific White Shrimp)', emoji: '🦐', group: 'Prawns & Shrimp' },
  tigerShrimp:      { label: 'Black Tiger Shrimp',              emoji: '🦐', group: 'Prawns & Shrimp' },
  giantRiverPrawn:  { label: 'Giant River Prawn (Scampi)',      emoji: '🦐', group: 'Prawns & Shrimp' },
  freshwaterPrawn:  { label: 'Freshwater Prawn',                emoji: '🦐', group: 'Prawns & Shrimp' },

  // ── Crabs ──
  mudCrab:          { label: 'Mud Crab',        emoji: '🦀', group: 'Crabs' },
  blueSwimmerCrab:  { label: 'Blue Swimmer Crab', emoji: '🦀', group: 'Crabs' },

  // ── Molluscs ──
  pearlOyster: { label: 'Pearl Oyster', emoji: '🦪', group: 'Molluscs' },
  mussel:      { label: 'Mussel',       emoji: '🦪', group: 'Molluscs' },

  other:       { label: 'Other', emoji: '🐾', group: 'Other' },
};

// Derived emoji lookup, mirrors ANIMAL_EMOJI's role for the map marker /
// card fallback icon when a fish stock entry has no photo.
export const AQUA_SPECIES_EMOJI = Object.fromEntries(
  Object.entries(AQUA_SPECIES_TAXONOMY).map(([key, v]) => [key, v.emoji])
);

// All species keys, in the order they should render in the picker.
export const AQUA_SPECIES_TYPES = Object.keys(AQUA_SPECIES_TAXONOMY);

// Species keys grouped in insertion order, for a sectioned picker (group
// heading -> list of species keys) instead of one flat row of 20+ options -
// same role ANIMAL_GROUPS plays for AddCattleForm's type picker.
export const AQUA_SPECIES_GROUPS = Object.entries(AQUA_SPECIES_TAXONOMY).reduce((acc, [key, v]) => {
  if (!acc[v.group]) acc[v.group] = [];
  acc[v.group].push(key);
  return acc;
}, {});

// Reverse lookup: given a stored fish_species text value (e.g. an
// existing row's "Rohu"), find the matching taxonomy key so
// AddFishStockForm can pre-select the right picker button when editing.
// Returns 'other' (with the raw text kept for the custom input) if the
// stored value doesn't match any known label - covers rows saved before
// this picker existed, when the field was free text.
export function speciesKeyForLabel(label) {
  if (!label) return '';
  const match = Object.entries(AQUA_SPECIES_TAXONOMY).find(
    ([key, v]) => key !== 'other' && v.label.toLowerCase() === label.trim().toLowerCase()
  );
  return match ? match[0] : 'other';
}