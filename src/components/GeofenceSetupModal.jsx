// src/components/GeofenceSetupModal.jsx
//
// Lets a farmer reposition and resize (1km-10km) the geofence circle
// for a cattle. Saves geofence_center + geofence_radius_m to Supabase.
// This circle is the ONLY location data ever exposed to buyers.

import { useState } from 'react';
import { MapContainer, TileLayer, Circle, Marker, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { supabase } from '../config/supabaseClient';

const MIN_RADIUS = 1000;
const MAX_RADIUS = 10000;

function ClickToRecenter({ onPick }) {
  useMapEvents({
    click(e) {
      onPick([e.latlng.lat, e.latlng.lng]);
    },
  });
  return null;
}

export default function GeofenceSetupModal({
  cattleId,
  initialCenter,
  initialRadiusM,
  onClose,
  onSaved,
}) {
  const [center, setCenter] = useState(initialCenter);
  const [radiusM, setRadiusM] = useState(
    Math.min(Math.max(initialRadiusM, MIN_RADIUS), MAX_RADIUS)
  );
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const handleSave = async () => {
    setSaving(true);
    setErrorMsg(null);

    const { error } = await supabase
      .from('cattle')
      .update({
        geofence_center: `SRID=4326;POINT(${center[1]} ${center[0]})`,
        geofence_radius_m: Math.round(radiusM),
      })
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
        background: 'rgba(0,0,0,0.4)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'flex-end',
      }}
    >
      <div
        style={{
          background: '#fff',
          width: '100%',
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          maxHeight: '85vh',
        }}
      >
        <h3 style={{ margin: 0, textAlign: 'center' }}>Set Geofence Boundary</h3>

        <div style={{ height: 300, borderRadius: 8, overflow: 'hidden' }}>
          <MapContainer center={center} zoom={14} style={{ height: '100%', width: '100%' }}>
            <TileLayer
              url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; OpenStreetMap contributors'
            />
            <ClickToRecenter onPick={setCenter} />
            <Circle
              center={center}
              radius={radiusM}
              pathOptions={{ color: '#2e7d32', fillOpacity: 0.15, weight: 2 }}
            />
            <Marker position={center} />
          </MapContainer>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Radius</span>
            <span>{(radiusM / 1000).toFixed(1)} km</span>
          </div>
          <input
            type="range"
            min={MIN_RADIUS}
            max={MAX_RADIUS}
            step={1000}
            value={radiusM}
            onChange={(e) => setRadiusM(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <p style={{ fontSize: 12, color: '#666', textAlign: 'center' }}>
            Tap the map to reposition the center. Buyers will only ever see this
            circle — never your animal's exact live location.
          </p>
        </div>

        {errorMsg && <p style={{ color: 'red', fontSize: 13 }}>{errorMsg}</p>}

        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 10 }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              flex: 1,
              padding: 10,
              background: '#2e7d32',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
            }}
          >
            {saving ? 'Saving…' : 'Save Geofence'}
          </button>
        </div>
      </div>
    </div>
  );
}
