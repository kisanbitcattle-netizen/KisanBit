// src/components/GeofenceSetupModal.jsx
//
// Lets a farmer reposition the geofence center (the public-facing
// circle buyers see) AND set three alert tiers around it:
//   Tier 1 (Free notification)  — capped at 1km max
//   Tier 2 (SMS, paid provider) — capped at 7km max
//   Tier 3 (Call, paid provider)— capped at 7km max
// Each tier must be >= the one before it, so the zones nest properly.

import { useState, useEffect } from 'react';
import { MapContainer, Circle, Marker, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import markerIconUrl from 'leaflet/dist/images/marker-icon.png';
import markerIconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png';
import { supabase } from '../../config/supabaseClient';
import OfflineTileLayer from '../../components/OfflineTileLayer';

// Vite (like most bundlers) doesn't resolve Leaflet's default marker
// icon path automatically, which otherwise silently renders as a
// broken image. This is the only place in the app still using
// react-leaflet's plain <Marker> (CattleMarker/FieldMarker elsewhere
// use their own custom icons), so the fix is scoped locally here.
const DEFAULT_MARKER_ICON = L.icon({
  iconUrl: markerIconUrl,
  iconRetinaUrl: markerIconRetinaUrl,
  shadowUrl: markerShadowUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const PUBLIC_MIN_RADIUS = 100;
const PUBLIC_MAX_RADIUS = 1000; // matches EditCattleModal's DEFAULT_RADIUS_M - user decision, see handover Aug 8 2026

const TIER1_MAX = 1000;   // free notification tier — hard cap
const TIER23_MAX = 7000;  // paid SMS/Call tiers — hard cap

function ClickToRecenter({ onPick }) {
  useMapEvents({
    click(e) {
      onPick([e.latlng.lat, e.latlng.lng]);
    },
  });
  return null;
}

// FIX for "Zones map shows a blank white board": Leaflet measures its
// container's size once, synchronously, at the moment MapContainer
// mounts - React hasn't necessarily flushed layout/painted the DOM yet
// at that point, especially for a container nested inside a scrollable,
// maxHeight-constrained flex parent like this modal's (the outer
// kb-card has maxHeight:'90vh' + overflowY:'auto'). If Leaflet's very
// first measurement is 0 or stale, it only fetches/positions tiles for
// that wrong size - which renders as blank white until something
// forces a resize (rotating the device, opening devtools, etc).
// invalidateSize() re-measures against the container's actual current
// size and redraws the tile grid accordingly. Cheap and safe to call
// even on the (common) case where nothing was actually wrong.
// FullMapModal doesn't hit this because it's a full-viewport modal, not
// nested inside a scrollable, height-constrained wrapper the way this
// bottom sheet is - so its map size is stable and correct on the very
// first paint.
function InvalidateSizeOnMount() {
  const map = useMap();
  useEffect(() => {
    // Two passes: one for the common case (layout settles almost
    // immediately), one slightly delayed as a safety net for slower
    // devices/webviews where the modal's own mount/paint takes longer.
    const immediate = setTimeout(() => map.invalidateSize(), 0);
    const delayed = setTimeout(() => map.invalidateSize(), 250);
    return () => {
      clearTimeout(immediate);
      clearTimeout(delayed);
    };
  }, [map]);
  return null;
}

export default function GeofenceSetupModal({
  cattleId,
  baseId,
  initialCenter,
  initialRadiusM,
  initialAlertRadius1 = 1000,
  initialAlertRadius2 = 2000,
  initialAlertRadius3 = 5000,
  onClose,
  onSaved,
}) {
  // Defensive fallbacks: a cattle that has never had its geofence/zones
  // touched before (e.g. opened straight from EditCattleModal's "Zones"
  // button on a freshly-created animal) can have geofence_center and/or
  // geofence_radius_m as null in the DB. Math.max(undefined, ...) is NaN,
  // which would otherwise silently break the slider AND crash the map
  // (MapContainer/Circle/Marker all need a real [lat, lng] center).
  const safeCenter = Array.isArray(initialCenter) && initialCenter.length === 2
    ? initialCenter
    : [17.385, 78.4867]; // Hyderabad fallback, same as EditCattleModal's map default
  const safeInitialRadiusM = Number.isFinite(initialRadiusM) ? initialRadiusM : PUBLIC_MAX_RADIUS;

  const [center, setCenter] = useState(safeCenter);
  const [radiusM, setRadiusM] = useState(
    Math.min(Math.max(safeInitialRadiusM, PUBLIC_MIN_RADIUS), PUBLIC_MAX_RADIUS)
  );
  const [tier1, setTier1] = useState(Math.min(initialAlertRadius1, TIER1_MAX));
  const [tier2, setTier2] = useState(Math.min(initialAlertRadius2, TIER23_MAX));
  const [tier3, setTier3] = useState(Math.min(initialAlertRadius3, TIER23_MAX));
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  // Keep tiers nested: tier2 can't go below tier1, tier3 can't go below tier2.
  const handleTier1Change = (val) => {
    const clamped = Math.min(val, TIER1_MAX);
    setTier1(clamped);
    if (tier2 < clamped) setTier2(clamped);
    if (tier3 < clamped) setTier3(clamped);
  };
  const handleTier2Change = (val) => {
    const clamped = Math.min(Math.max(val, tier1), TIER23_MAX);
    setTier2(clamped);
    if (tier3 < clamped) setTier3(clamped);
  };
  const handleTier3Change = (val) => {
    const clamped = Math.min(Math.max(val, tier2), TIER23_MAX);
    setTier3(clamped);
  };

  const handleSave = async () => {
    setSaving(true);
    setErrorMsg(null);

    // FIX ("not taking same base location"): this used to unconditionally
    // write geofence_center/geofence_radius_m on every save, with no idea
    // whether the animal was base-linked. Since the map is pre-centered on
    // the Base's current location for a base-linked animal (see
    // CattleCard.jsx's effectiveZonesCenter), that meant just adjusting an
    // alert tier and hitting Save silently froze the animal at a one-time
    // snapshot of the Base's location - permanently detaching it from the
    // Base going forward. Base-linked animals now only ever write their
    // alert tiers here; geofence_center/radius stay untouched (and stay
    // null), so downstream logic keeps deferring to the live Base location.
    const updatePayload = {
      alert_radius_1_m: Math.round(tier1),
      alert_radius_2_m: Math.round(tier2),
      alert_radius_3_m: Math.round(tier3),
    };
    if (!baseId) {
      updatePayload.geofence_center = `SRID=4326;POINT(${center[1]} ${center[0]})`;
      updatePayload.geofence_radius_m = Math.round(radiusM);
    }

    const { error } = await supabase
      .from('cattle')
      .update(updatePayload)
      .eq('id', cattleId);

    setSaving(false);

    if (error) {
      setErrorMsg(error.message);
      return;
    }
    onSaved();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(20,24,40,0.45)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'flex-end',
      }}
    >
      <div
        className="kb-card"
        style={{
          width: '100%',
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <h3 className="display-text" style={{ margin: 0, textAlign: 'center', color: 'var(--color-ink)' }}>
          Set Geofence & Alert Zones
        </h3>

        {/* NOTE on "white board": no sizing/cleanup bug found in
            OfflineTileLayer.jsx or here - this container has a fixed
            height, and InvalidateSizeOnMount + the tile layer's own
            cleanup are both correct. The blank flash is most likely
            genuine tile-fetch latency (network or first-time IndexedDB
            write), not leftover code. Giving it a neutral background so
            it reads as "loading" instead of "broken" while that resolves. */}
        <div style={{ height: 260, borderRadius: 12, overflow: 'hidden', background: 'var(--color-bg)' }}>
          <MapContainer center={center} zoom={14} style={{ height: '100%', width: '100%', background: 'var(--color-bg)' }}>
            <InvalidateSizeOnMount />
            <OfflineTileLayer maxZoom={16} keepBuffer={1} detectRetina={false} />
            {/* Base-linked animals shouldn't be recenterable here at all -
                see the baseId guard in handleSave above for why. */}
            {!baseId && <ClickToRecenter onPick={setCenter} />}
            {/* Public geofence circle — what buyers see */}
            <Circle center={center} radius={radiusM} pathOptions={{ color: '#2b3a61', fillOpacity: 0.08, weight: 2 }} />
            {/* Alert tiers — owner-only, never shown to buyers */}
            <Circle center={center} radius={tier1} pathOptions={{ color: '#2f9e64', fillOpacity: 0, weight: 2, dashArray: '4 4' }} />
            <Circle center={center} radius={tier2} pathOptions={{ color: '#dea03b', fillOpacity: 0, weight: 2, dashArray: '4 4' }} />
            <Circle center={center} radius={tier3} pathOptions={{ color: '#d64545', fillOpacity: 0, weight: 2, dashArray: '4 4' }} />
            <Marker position={center} icon={DEFAULT_MARKER_ICON} />
          </MapContainer>
        </div>

        {/* Public geofence radius - base-linked animals don't get an
            editable circle here at all, since saving would freeze them
            at a one-time snapshot of the Base's location (see handleSave). */}
        {baseId ? (
          <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: '4px 0' }}>
            🌐 This animal's public geofence follows its Cattle Base's location and radius.
            Edit the Base itself to change it. Only the alert zones below are per-animal.
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>
              <span>🌐 Public geofence (buyers see this circle)</span>
              <span>{Math.round(radiusM)} m</span>
            </div>
            <input
              type="range" min={PUBLIC_MIN_RADIUS} max={PUBLIC_MAX_RADIUS} step={50}
              value={radiusM} onChange={(e) => setRadiusM(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>
        )}

        <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', margin: '4px 0' }} />
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-ink)' }}>Alert Zones (private, owner only)</div>

        {/* Tier 1 — Free notification */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--color-ink)' }}>
            <span>🟢 Tier 1 — Free notification (max 1 km)</span>
            <span>{(tier1 / 1000).toFixed(2)} km</span>
          </div>
          <input
            type="range" min={100} max={TIER1_MAX} step={100}
            value={tier1} onChange={(e) => handleTier1Change(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>

        {/* Tier 2 — SMS (paid) */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--color-ink)' }}>
            <span>🟡 Tier 2 — SMS alert 💰 (max 7 km)</span>
            <span>{(tier2 / 1000).toFixed(2)} km</span>
          </div>
          <input
            type="range" min={tier1} max={TIER23_MAX} step={100}
            value={tier2} onChange={(e) => handleTier2Change(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>

        {/* Tier 3 — Call (paid) */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--color-ink)' }}>
            <span>🔴 Tier 3 — Call alert 💰 (max 7 km)</span>
            <span>{(tier3 / 1000).toFixed(2)} km</span>
          </div>
          <input
            type="range" min={tier2} max={TIER23_MAX} step={100}
            value={tier3} onChange={(e) => handleTier3Change(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>

        <p style={{ fontSize: 11, color: 'var(--color-muted)', textAlign: 'center', margin: 0 }}>
          SMS/Call alerts need a paid provider connected later — for now they're logged
          the same as free notifications so nothing breaks in testing.
        </p>

        {errorMsg && <p style={{ color: 'var(--color-danger)', fontSize: 13 }}>{errorMsg}</p>}

        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-card)', color: 'var(--color-ink)' }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ flex: 1, padding: 10, borderRadius: 10, background: 'var(--color-gold)', color: 'var(--color-navy)', border: 'none', fontWeight: 700 }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}