// src/screens/MapScreen.jsx
//
// Tab 1 — Smart Map View. Equivalent to the old map_screen.dart.
// Farmers see their own cattle (private table, RLS-scoped) with
// live location; buyers see the public view (geofence only, never
// live_location).

import { useEffect, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Circle } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { supabase } from '../config/supabaseClient';
import CattleMarker from '../components/CattleMarker';
import GeofenceSetupModal from '../components/GeofenceSetupModal';

const DEFAULT_CENTER = [17.385, 78.4867]; // Hyderabad fallback

function parsePoint(geoJsonPoint) {
  if (!geoJsonPoint || !geoJsonPoint.coordinates) return null;
  const [lon, lat] = geoJsonPoint.coordinates;
  return [lat, lon];
}

export default function MapScreen({ isFarmerView }) {
  const [cattleList, setCattleList] = useState([]);
  const [selectedCattle, setSelectedCattle] = useState(null);
  const [geofenceTarget, setGeofenceTarget] = useState(null); // cattle id being edited

  const loadCattle = useCallback(async () => {
    const table = isFarmerView ? 'cattle' : 'cattle_public_view';
    const { data, error } = await supabase.from(table).select('*');
    if (error) {
      console.error('Failed to load cattle:', error.message);
      return;
    }

    const mapped = data.map((row) => {
      const liveLocation = parsePoint(row.live_location);
      const geofenceCenter = parsePoint(row.geofence_center);
      return {
        id: row.id,
        name: row.name,
        animalType: row.animal_type,
        localImageUri: isFarmerView ? row.local_image_path : null,
        marketplacePhotoUrl: row.marketplace_photo_url,
        salePrice: row.sale_price,
        geofenceCenter,
        geofenceRadiusM: row.geofence_radius_m || 1000,
        // Farmer sees exact live location; public view never has live_location at all.
        displayPosition: isFarmerView && liveLocation ? liveLocation : geofenceCenter,
      };
    });

    setCattleList(mapped);
  }, [isFarmerView]);

  useEffect(() => {
    loadCattle();
  }, [loadCattle]);

  // Realtime updates — only relevant for the farmer's own cattle.
  useEffect(() => {
    if (!isFarmerView) return;

    let channel;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      channel = supabase
        .channel(`cattle-live-${user.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'cattle', filter: `owner_id=eq.${user.id}` },
          () => loadCattle()
        )
        .subscribe();
    })();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [isFarmerView, loadCattle]);

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={14}
        style={{ height: '100%', width: '100%' }}
      >
        {/* Free & open-source OSM tiles — no Google Maps API cost */}
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; OpenStreetMap contributors'
        />

        {cattleList
          .filter((c) => c.geofenceCenter)
          .map((c) => (
            <Circle
              key={`geofence-${c.id}`}
              center={c.geofenceCenter}
              radius={c.geofenceRadiusM}
              pathOptions={{ color: '#2e7d32', fillOpacity: 0.12, weight: 2 }}
            />
          ))}

        {cattleList.map((c) => (
          <CattleMarker key={c.id} cattle={c} onClick={setSelectedCattle} />
        ))}
      </MapContainer>

      {isFarmerView && (
        <button
          onClick={() => setGeofenceTarget(selectedCattle?.id || cattleList[0]?.id)}
          style={{
            position: 'absolute',
            bottom: 20,
            right: 20,
            zIndex: 1000,
            padding: '10px 16px',
            background: '#2e7d32',
            color: '#fff',
            border: 'none',
            borderRadius: 24,
            boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
          }}
        >
          Set Geofence
        </button>
      )}

      {geofenceTarget && (
        <GeofenceSetupModal
          cattleId={geofenceTarget}
          initialCenter={
            cattleList.find((c) => c.id === geofenceTarget)?.geofenceCenter || DEFAULT_CENTER
          }
          initialRadiusM={
            cattleList.find((c) => c.id === geofenceTarget)?.geofenceRadiusM || 1000
          }
          onClose={() => setGeofenceTarget(null)}
          onSaved={() => {
            setGeofenceTarget(null);
            loadCattle();
          }}
        />
      )}
    </div>
  );
}
