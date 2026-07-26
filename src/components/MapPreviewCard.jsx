// src/components/MapPreviewCard.jsx
//
// The "hero" card on the home screen: a compact, non-interactive map
// snapshot showing where the farmer's cattle currently are. Tapping
// anywhere on the card opens the full-screen map (FullMapModal).

import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Circle } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { supabase } from '../config/supabaseClient';
import CattleMarker from './CattleMarker';

const DEFAULT_CENTER = [17.385, 78.4867];

function parsePoint(geoJsonPoint) {
  if (!geoJsonPoint || !geoJsonPoint.coordinates) return null;
  const [lon, lat] = geoJsonPoint.coordinates;
  return [lat, lon];
}

export default function MapPreviewCard({ isFarmerView, onOpen }) {
  const [cattleList, setCattleList] = useState([]);
  const [center, setCenter] = useState(DEFAULT_CENTER);

  useEffect(() => {
    let channel;

    async function load() {
      const table = isFarmerView ? 'cattle' : 'cattle_public_view';
      const { data, error } = await supabase.from(table).select('*');
      if (error) return;

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
          displayPosition: isFarmerView && liveLocation ? liveLocation : geofenceCenter,
        };
      });

      setCattleList(mapped);
      if (mapped[0]?.displayPosition) setCenter(mapped[0].displayPosition);
    }

    load();

    // Realtime — keep the preview fresh within milliseconds of a new ping.
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      channel = supabase
        .channel(`cattle-preview-${user.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'cattle', filter: `owner_id=eq.${user.id}` },
          load
        )
        .subscribe();
    })();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [isFarmerView]);

  return (
    <div
      onClick={onOpen}
      style={{
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        position: 'relative',
        height: 220,
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      <MapContainer
        center={center}
        zoom={13}
        zoomControl={false}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        attributionControl={false}
        style={{ height: '100%', width: '100%', pointerEvents: 'none' }}
      >
        <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {cattleList
          .filter((c) => c.geofenceCenter)
          .map((c) => (
            <Circle
              key={`pgeo-${c.id}`}
              center={c.geofenceCenter}
              radius={c.geofenceRadiusM}
              pathOptions={{ color: '#2e7d32', fillOpacity: 0.12, weight: 2 }}
            />
          ))}
        {cattleList.map((c) => (
          <CattleMarker key={c.id} cattle={c} />
        ))}
      </MapContainer>

      {/* Overlay gradient + label so it reads as a tappable "hero" card */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(to top, rgba(0,0,0,0.55), transparent 40%)',
          display: 'flex',
          alignItems: 'flex-end',
          padding: 14,
        }}
      >
        <div style={{ color: '#fff' }}>
          <div style={{ fontSize: 16, fontWeight: 'bold' }}>
            🐄 Your Cattle Map
          </div>
          <div style={{ fontSize: 12, opacity: 0.9 }}>
            {cattleList.length} animals tracked · Tap to open full map
          </div>
        </div>
      </div>
    </div>
  );
}
