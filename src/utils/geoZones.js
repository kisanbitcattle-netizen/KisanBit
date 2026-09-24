// src/utils/geoZones.js
//
// Shared helpers for the 3-tier alert-zone visualization (Tier 1 free
// notification / Tier 2 SMS / Tier 3 Call - set by the farmer in
// GeofenceSetupModal, stored as alert_radius_1_m / alert_radius_2_m /
// alert_radius_3_m on the cattle row). Used by:
//   - MapPreviewCard.jsx: progressive tier circles (only as many rings
//     as the animal has actually reached) + a zone-colored dots line.
//   - FullMapModal.jsx: zone-colored dots line only (no circles there).
// Centralized here so both places use the same distance math and the
// same tier colors instead of drifting apart.

// Same three colors GeofenceSetupModal already uses for its Tier 1/2/3
// sliders and circles - reused here so a "green line" in the preview
// card means the same thing as the green circle in the zones editor.
export const ZONE_COLORS = {
  1: '#2f9e64', // Tier 1 - free notification
  2: '#dea03b', // Tier 2 - SMS (paid)
  3: '#d64545', // Tier 3 - Call (paid)
};

// Haversine distance in METERS. FullMapModal.jsx has its own local
// haversineKm() (returns km, used for radius-filter comparisons against
// filters.radiusKm) - this is a separate meters version since
// alert_radius_1/2/3_m are stored in meters and mixing the two units up
// is an easy way to silently mis-place every zone boundary.
export function haversineMeters(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Which tier (1/2/3) an animal currently sits in, given its distance in
// meters from the base/geofence-center and its own three tier radii.
// Returns null when there isn't enough data to say anything (no
// distance yet, or the animal has no tiers configured at all).
//
// Tiers nest (tier1 <= tier2 <= tier3 - enforced by GeofenceSetupModal's
// slider clamping), so the first tier the distance still fits inside
// wins. A distance beyond every configured tier still reports the
// highest configured tier (reads as the most severe color available)
// rather than "no zone" - an animal further than the farmer's Call-alert
// radius should look at least as alarming as one just inside it, not
// less.
export function getCurrentZone(distanceM, tier1M, tier2M, tier3M) {
  if (distanceM == null || !Number.isFinite(distanceM)) return null;

  const t1 = Number.isFinite(tier1M) ? tier1M : null;
  const t2 = Number.isFinite(tier2M) ? tier2M : null;
  const t3 = Number.isFinite(tier3M) ? tier3M : null;
  if (t1 == null && t2 == null && t3 == null) return null;

  if (t1 != null && distanceM <= t1) return 1;
  if (t2 != null && distanceM <= t2) return 2;
  if (t3 != null) return 3; // inside tier3, or beyond every tier - both read "red"
  if (t2 != null) return 2; // no tier3 set, animal is beyond tier2
  return 1; // only tier1 was ever set, animal is beyond it
}