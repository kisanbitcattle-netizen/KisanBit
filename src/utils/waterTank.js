// src/utils/waterTank.js
//
// Shared water-tank helpers used by IoTDevicesPanel (card), IoTDeviceDetailModal
// and DeviceAnalyticsModal, so the ONLINE/FULL/EMPTY rules live in one place.

export const HEARTBEAT_MS = 30 * 1000;                 // firmware sends at least every 30s
export const ONLINE_WINDOW_MS = HEARTBEAT_MS * 3;      // tolerate 2 missed heartbeats

// V1 has ONE IR sensor placed at the tank's "full" mark:
//   DETECTED (sensor_status = true)      -> water reached the sensor -> FULL
//   NOT DETECTED (sensor_status = false) -> below the mark           -> EMPTY
// (With a single point, "EMPTY" really means "not full". True level % comes
// with the VL53L ToF sensor in V2; only this mapping needs to change then.)
export function tankLevel(tank) {
  if (!tank || tank.sensor_status === null || tank.sensor_status === undefined) return 'unknown';
  return tank.sensor_status ? 'full' : 'empty';
}

export const LEVEL_LABEL = { full: 'FULL', empty: 'EMPTY', unknown: '—' };

// A device that lost Wi-Fi can't report "offline" itself, so online = fresh last_seen.
export function isTankOnline(tank, now = Date.now()) {
  if (!tank?.last_seen) return false;
  return now - new Date(tank.last_seen).getTime() < ONLINE_WINDOW_MS;
}

export function formatLastUpdate(iso) {
  if (!iso) return 'Waiting for first data';
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

export function formatDateTime(msOrIso) {
  return new Date(msOrIso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Turns state-change readings into contiguous segments over [sinceMs, endMs].
 * readings: [{ sensor_status: boolean, recorded_at: ISO }] ascending.
 * priorState: state just before sinceMs (true/false) or null if unknown.
 * Segment state: true = FULL, false = EMPTY, null = no data.
 */
export function buildTimeline(readings, priorState, sinceMs, endMs) {
  const segments = [];
  const push = (start, end, state) => {
    if (end > start) segments.push({ state, start, end });
  };
  let cursor = sinceMs;
  let state = priorState;
  for (const r of readings) {
    const t = new Date(r.recorded_at).getTime();
    if (t >= endMs) break;
    const at = Math.max(t, cursor);
    push(cursor, at, state);
    cursor = at;
    state = r.sensor_status;
  }
  push(cursor, endMs, state);
  return segments;
}

export function summarize(segments, readings, priorState) {
  let fullMs = 0;
  let emptyMs = 0;
  for (const s of segments) {
    if (s.state === true) fullMs += s.end - s.start;
    else if (s.state === false) emptyMs += s.end - s.start;
  }
  const known = fullMs + emptyMs;

  let refills = 0;   // EMPTY -> FULL
  let emptied = 0;   // FULL -> EMPTY
  let prev = priorState;
  for (const r of readings) {
    if (prev === false && r.sensor_status === true) refills += 1;
    if (prev === true && r.sensor_status === false) emptied += 1;
    prev = r.sensor_status;
  }

  return {
    fullPct: known ? Math.round((fullMs / known) * 100) : null,
    emptyPct: known ? Math.round((emptyMs / known) * 100) : null,
    refills,
    emptied,
  };
}