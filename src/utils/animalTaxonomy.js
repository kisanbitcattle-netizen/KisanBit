// src/utils/animalTaxonomy.js
//
// Single source of truth for every animal category the app knows about:
// its display label, marker emoji, breed list, grouping (for the AddCattleForm
// type picker), and whether it's allowed to be listed for sale / transferred.
//
// This REPLACES the old cattleBreeds.js (one flat breed list shared by every
// animal type - meant every category showed the same cow/buffalo breeds) and
// the ANIMAL_EMOJI object that used to live in CattleMarker.jsx (now derived
// from here so there's one definition of "what emoji does a cow get", not two
// that can silently drift apart).
//
// `sellable: false` categories are wildlife/protected-species entries kept
// for record-keeping only (e.g. a working elephant, a sanctuary animal) -
// the app must NEVER show a Sell/List button for these, and any DB-level
// write of is_listed_for_sale=true for a non-sellable animal_type should be
// treated as a bug or an attempted policy bypass, not a valid state.
// India's Wildlife Protection Act, 1972 restricts or bans private sale of
// most of these species - this flag exists to keep the app on the legal
// side of that line by construction, not just by convention.

export const ANIMAL_TAXONOMY = {
  // ── Domestic & Farm Mammals (sellable) ──
  // producesMilk: true only for species this app actually tracks a dairy
  // yield for. Everything else (including sellable mammals like dog/horse/
  // camel-for-riding-stock etc.) defaults to false below - flip individual
  // entries to true if the app later wants to support their milk too
  // (e.g. camel milk is a real dairy product in some regions).
  cow:      { label: 'Cow',      emoji: '🐄', group: 'Domestic & Farm Mammals', sellable: true,  producesMilk: true,  breeds: ['Gir', 'Sahiwal', 'Red Sindhi', 'Tharparkar', 'Holstein Friesian', 'Jersey', 'Crossbred', 'Other'] },
  buffalo:  { label: 'Buffalo',  emoji: '🐃', group: 'Domestic & Farm Mammals', sellable: true,  producesMilk: true,  breeds: ['Murrah', 'Nili-Ravi', 'Surti', 'Mehsana', 'Jaffarabadi', 'Bhadawari', 'Other'] },
  goat:     { label: 'Goat',     emoji: '🐐', group: 'Domestic & Farm Mammals', sellable: true,  producesMilk: true,  breeds: ['Jamunapari', 'Boer', 'Beetal', 'Barbari', 'Black Bengal', 'Osmanabadi', 'Sirohi', 'Other'] },
  sheep:    { label: 'Sheep',    emoji: '🐑', group: 'Domestic & Farm Mammals', sellable: true,  producesMilk: true,  breeds: ['Nellore', 'Mandya', 'Marwari', 'Deccani', 'Merino', 'Other'] },
  pig:      { label: 'Pig',      emoji: '🐖', group: 'Domestic & Farm Mammals', sellable: true,  producesMilk: false, breeds: ['Large White Yorkshire', 'Landrace', 'Duroc', 'Ghungroo', 'Indigenous', 'Other'] },
  dog:      { label: 'Dog',      emoji: '🐕', group: 'Domestic & Farm Mammals', sellable: true,  producesMilk: false, breeds: ['Indian Pariah (Desi)', 'German Shepherd', 'Labrador Retriever', 'Golden Retriever', 'Rottweiler', 'Pug', 'Spitz', 'Other'] },
  camel:    { label: 'Camel',    emoji: '🐫', group: 'Domestic & Farm Mammals', sellable: true,  producesMilk: true,  breeds: ['Bikaneri', 'Jaisalmeri', 'Kutchi', 'Mewari', 'Other'] },
  horse:    { label: 'Horse',    emoji: '🐎', group: 'Domestic & Farm Mammals', sellable: true,  producesMilk: false, breeds: ['Marwari', 'Kathiawari', 'Thoroughbred', 'Zanskari', 'Spiti', 'Other'] },

  // ── Flightless Birds (sellable - poultry; none produce milk) ──
  hen:      { label: 'Hen',      emoji: '🐔', group: 'Flightless Birds', sellable: true, producesMilk: false, breeds: ['Aseel', 'Kadaknath', 'Rhode Island Red', 'Broiler', 'Leghorn', 'Gramapriya', 'Other'] },
  turkey:   { label: 'Turkey',   emoji: '🦃', group: 'Flightless Birds', sellable: true, producesMilk: false, breeds: ['Broad Breasted White', 'Beltsville Small White', 'Bourbon Red', 'Other'] },
  ostrich:  { label: 'Ostrich',  emoji: '🦤', group: 'Flightless Birds', sellable: true, producesMilk: false, breeds: ['African Black', 'Red Neck', 'Blue Neck', 'Other'] },

  // ── Flying Birds (mixed - duck/pigeon are farmed & sellable; parrot is not; none produce milk) ──
  duck:     { label: 'Duck',     emoji: '🦆', group: 'Flying Birds', sellable: true,  producesMilk: false, breeds: ['Khaki Campbell', 'Indian Runner', 'Pekin', 'Sylhetti', 'Other'] },
  pigeon:   { label: 'Pigeon',   emoji: '🕊️', group: 'Flying Birds', sellable: true,  producesMilk: false, breeds: ['Homer', 'King', 'Carneau', 'Local Fancy', 'Other'] },
  parrot:   { label: 'Parrot',   emoji: '🦜', group: 'Flying Birds', sellable: false, producesMilk: false, breeds: ['Indian Ringneck Parakeet', 'Alexandrine Parakeet', 'Vernal Hanging Parrot', 'Other'] },

  // ── Land Mammals (record-keeping only - protected wildlife) ──
  // Breed lists here are real subspecies/variants (useful for a sanctuary
  // or forest-department record, e.g. distinguishing Asiatic vs African
  // lion) rather than the earlier single 'Protected Wildlife' placeholder.
  // sellable stays false regardless - subspecies detail is for
  // identification only and doesn't change legal status.
  elephant: { label: 'Elephant', emoji: '🐘', group: 'Land Mammals', sellable: false, producesMilk: false, breeds: ['Asian Elephant', 'African Elephant', 'Other'] },
  lion:     { label: 'Lion',     emoji: '🦁', group: 'Land Mammals', sellable: false, producesMilk: false, breeds: ['Asiatic Lion', 'African Lion', 'Other'] },
  tiger:    { label: 'Tiger',    emoji: '🐅', group: 'Land Mammals', sellable: false, producesMilk: false, breeds: ['Bengal Tiger', 'Siberian Tiger', 'Sumatran Tiger', 'Indochinese Tiger', 'Other'] },
  cheetah:  { label: 'Cheetah',  emoji: '🐆', group: 'Land Mammals', sellable: false, producesMilk: false, breeds: ['Asiatic Cheetah', 'African Cheetah', 'Other'] },

  // ── Reptiles (record-keeping only - protected wildlife; not mammals, never produce milk) ──
  crocodile:{ label: 'Crocodile',emoji: '🐊', group: 'Reptiles', sellable: false, producesMilk: false, breeds: ['Mugger Crocodile', 'Saltwater Crocodile', 'Gharial', 'Other'] },
  snake:    { label: 'Snake',    emoji: '🐍', group: 'Reptiles', sellable: false, producesMilk: false, breeds: ['Indian Cobra', 'Russell\'s Viper', 'Indian Rock Python', 'Krait', 'Other'] },

  // ── Marine Mammals (record-keeping only - protected wildlife; not dairy-tracked here) ──
  dolphin:  { label: 'Dolphin',  emoji: '🐬', group: 'Marine Mammals', sellable: false, producesMilk: false, breeds: ['Ganges River Dolphin', 'Indo-Pacific Humpback Dolphin', 'Bottlenose Dolphin', 'Other'] },


  other:    { label: 'Other',    emoji: '🐾', group: 'Other', sellable: true, producesMilk: false, breeds: ['Other'] },
};

// Derived emoji lookup - replaces the old standalone ANIMAL_EMOJI object in
// CattleMarker.jsx. Kept as its own named export so existing `import {
// ANIMAL_EMOJI } from './CattleMarker'` call sites can be repointed here
// with a one-line import change rather than every usage site rewritten.
export const ANIMAL_EMOJI = Object.fromEntries(
  Object.entries(ANIMAL_TAXONOMY).map(([key, v]) => [key, v.emoji])
);

// All category keys, in the order they should render in the type picker.
export const ANIMAL_TYPES = Object.keys(ANIMAL_TAXONOMY);

// Category keys grouped in insertion order, for a sectioned type picker
// (group heading -> list of type keys) instead of one flat row of 20+ icons.
export const ANIMAL_GROUPS = Object.entries(ANIMAL_TAXONOMY).reduce((acc, [key, v]) => {
  if (!acc[v.group]) acc[v.group] = [];
  acc[v.group].push(key);
  return acc;
}, {});

// True if this animal type is legally/policy-allowed to be listed for sale
// and transferred. Unknown/unrecognized type keys default to NOT sellable -
// fail closed rather than open, so a typo'd or future/unhandled animal_type
// can't accidentally unlock a sell button.
export function isSellable(animalType) {
  return ANIMAL_TAXONOMY[animalType]?.sellable === true;
}

// Breed list for a given animal type. Falls back to just ['Other'] for an
// unrecognized type so the breed dropdown never renders empty/broken.
export function breedsFor(animalType) {
  return ANIMAL_TAXONOMY[animalType]?.breeds ?? ['Other'];
}

// True if this animal type is one the app tracks dairy yield for (milking
// checkbox, daily yield field). Same fail-closed pattern as isSellable() -
// an unrecognized type defaults to NOT a milk producer, so a typo'd or
// future/unhandled animal_type doesn't show milk fields by accident.
export function producesMilk(animalType) {
  return ANIMAL_TAXONOMY[animalType]?.producesMilk === true;
}