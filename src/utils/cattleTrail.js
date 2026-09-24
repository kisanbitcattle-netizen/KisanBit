// src/utils/cattleTrail.js
//
// Historical GPS trail for a single animal, built from
// cattle_location_history (auto-populated by the
// trg_record_cattle_location_history trigger every time cattle.live_location
// is UPDATEd - see schema). Shared by MapPreviewCard.jsx and FullMapModal.jsx
// so both draw the exact same trail the exact same way.
//
// Two pieces, deliberately colored differently:
//   - `points`  -> the dots. Always the animal's OWN color
//     (getCattleColor(id) from cattleColors.js) - color never changes
//     per point, so a dot always answers "which animal is this".
//   - `segments` -> the connecting line between consecutive dots, split
//     at the exact tier-boundary crossing whenever a leg's two ends
//     fall in different alert zones. Each piece is colored via
//     ZONE_COLORS[zone] - so the LINE answers "how far out was this
//     leg of the trip", independent of the dots' color.
//
// Zone math reuses the exact same haversineMeters + getCurrentZone
// helpers MapPreviewCard/FullMapModal already use for the live tier
// circles, so a "yellow" segment here means the same distance band as
// a yellow circle elsewhere - no separate threshold logic to drift out
// of sync.

import { parseWkbPoint } from './geo';
import { haversineMeters, getCurrentZone } from './geoZones';

// Safety cap only - not the primary way we bound how much history comes
// back anymore (see mode/date below). At the 15-minute telemetry cadence,
// even a full calendar day is ~96 points, so this just guards against a
// runaway query if cadence ever changes, rather than defining "today".
const SAFETY_LIMIT = 500;

// BUG FIX: this used to default to "last 50 points" with no time
// scoping at all. When the collar misses readings (weak signal, dead
// battery), the SAME 50-point window can silently stretch across 2-3
// real days - so a trail rendered "today" could actually be splicing
// together yesterday evening's last fix and this morning's first fix
// into one continuous line, with no way to tell from the UI that a
// day-long gap sits in the middle of it. Two explicit modes now:
//   - mode: 'rolling24h' (default) - always exactly "the last 24 hours
//     from right now", regardless of what points happen to exist. Chosen
//     over a calendar-day boundary (today 00:00-23:59) because a
//     calendar day looks broken at 1am (only 1 hour of "today" so far);
//     a rolling window always shows a full day's worth.
//   - date: 'YYYY-MM-DD' - History picker's explicit past/specific-day
//     view. Scoped to exactly that day's 00:00:00-23:59:59 in the
//     caller's local time, nothing from adjacent days leaks in.
//
// ASSUMPTION: adjust this if your Supabase client import path differs -
// this file takes the client as a parameter instead of importing it
// directly, so it works with whatever you already use elsewhere
// (e.g. `import { supabase } from '../lib/supabaseClient'`).
export async function fetchCattleTrail(supabase, cattleId, { mode = 'rolling24h', date = null, limit = SAFETY_LIMIT } = {}) {
  if (!supabase || !cattleId) return [];

  let query = supabase
    .from('cattle_location_history')
    .select('location, recorded_at')
    .eq('cattle_id', cattleId);

  if (date) {
    // Specific calendar day, local time - matches what the History
    // date-picker's <input type="date"> value actually means to the
    // person picking it, not UTC-day boundaries.
    const startOfDay = new Date(`${date}T00:00:00`);
    const endOfDay = new Date(`${date}T23:59:59.999`);
    query = query.gte('recorded_at', startOfDay.toISOString()).lte('recorded_at', endOfDay.toISOString());
  } else {
    // mode === 'rolling24h' (the only other supported mode right now)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    query = query.gte('recorded_at', since.toISOString());
  }

  const { data, error } = await query
    .order('recorded_at', { ascending: true })
    .limit(limit);

  if (error || !data) {
    console.error('[cattleTrail] fetch failed:', error);
    return [];
  }

  return data
    .map((row) => ({
      position: parseWkbPoint(row.location),
      recordedAt: row.recorded_at,
    }))
    // GPS "no fix" guard: the LoRa gateway ingestion script writes
    // live_location = POINT(0,0) when its packet says Fix Status: 0 /
    // GPS State: NO FIX (see MapPreviewCard.jsx's cattleList useMemo for
    // the same guard on live_location). (0,0) - "Null Island" - is never
    // a real farm location. Without this filter, a no-fix reading in
    // the history table makes the trail jump out to (0,0) and back,
    // dragging the whole trail's bounding box (and any "Fit All") along
    // with it and putting a phantom stop thousands of km away.
    .filter(
      (p) =>
        p.position != null &&
        (Math.abs(p.position[0]) > 0.0001 || Math.abs(p.position[1]) > 0.0001)
    );
}

// Local (not UTC) YYYY-MM-DD for "today" - matches what an
// <input type="date"> gives back, so callers can compare directly
// (e.g. to decide whether the live-location pin should still show
// alongside a History view, or only the past day's trail).
export function todayLocalDateString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Straight-line lat/lng interpolation at fraction t (0..1) - not
// great-circle, but the segments here are short (15-minute GPS hops),
// so the error is negligible for what's ultimately a visual cue.
function lerpPoint(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Turns ordered history points into zone-colored polyline segments.
// Splits a leg at every tier boundary it crosses, so one straight hop
// between two real GPS fixes can render as e.g. green for the first
// third and yellow for the rest, instead of one color for the whole hop.
export function buildTrailSegments(points, geofenceCenter, tier1M, tier2M, tier3M) {
  if (!geofenceCenter || !Array.isArray(points) || points.length < 2) return [];

  const withDistance = points.map((p) => ({
    ...p,
    distanceM: haversineMeters(geofenceCenter, p.position),
  }));

  const segments = [];

  for (let i = 0; i < withDistance.length - 1; i++) {
    const start = withDistance[i];
    const end = withDistance[i + 1];
    if (start.distanceM == null || end.distanceM == null) continue;

    const goingOut = end.distanceM >= start.distanceM;
    const lo = Math.min(start.distanceM, end.distanceM);
    const hi = Math.max(start.distanceM, end.distanceM);

    // Every tier boundary strictly inside this leg's distance range,
    // in the order the animal actually crosses them - handles both
    // moving away from base and coming back toward it.
    const crossings = [tier1M, tier2M, tier3M]
      .filter((b) => Number.isFinite(b) && b > lo && b < hi)
      .sort((a, b) => (goingOut ? a - b : b - a));

    // Walk start -> [crossing point(s)] -> end, one sub-segment between
    // each stop. Each sub-segment's zone is read at its MIDPOINT
    // distance, not an endpoint - an endpoint can sit exactly on a
    // boundary, which is ambiguous about which side's color it means.
    let legFromPoint = start.position;
    let legFromDist = start.distanceM;

    crossings.forEach((boundaryM) => {
      const t = (boundaryM - start.distanceM) / (end.distanceM - start.distanceM);
      const crossingPoint = lerpPoint(start.position, end.position, t);
      const midDist = (legFromDist + boundaryM) / 2;
      segments.push({
        from: legFromPoint,
        to: crossingPoint,
        zone: getCurrentZone(midDist, tier1M, tier2M, tier3M),
      });
      legFromPoint = crossingPoint;
      legFromDist = boundaryM;
    });

    const midDist = (legFromDist + end.distanceM) / 2;
    segments.push({
      from: legFromPoint,
      to: end.position,
      zone: getCurrentZone(midDist, tier1M, tier2M, tier3M),
    });
  }

  return segments;
}