// src/components/FullMapModal.jsx
//
// Opens when the hero MapPreviewCard is tapped. Shows the full,
// interactive map PLUS today's movement trail (polyline built from
// cattle_location_history) and a Share button that generates a
// branded image card for WhatsApp — with the trail baked into it.

import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Circle, Polyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { supabase } from '../config/supabaseClient';
import CattleMarker from './CattleMarker';
import { generateAndShareMapCard } from '../services/shareCardService';

const DEFAULT_CENTER = [17.385, 78.4867];
const TRAIL_COLORS = ['#1976d2', '#d32f2f', '#7b1fa2', '#00897b', '#f57c00'];

function parsePoint(geoJsonPoint) {
  if (!geoJsonPoint || !geoJsonPoint.coordinates) return null;
  const [lon, lat] = geoJsonPoint.coordinates;
  return [lat, lon];
}

export default function FullMapModal({ isFarmerView, onClose }) {
  const [cattleList, setCattleList] = useState([]);
  const [trails, setTrails] = useState({}); // { cattleId: [[lat,lon], ...] }
  const [center, setCenter] = useState(DEFAULT_CENTER);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
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

      // Trails are private (owner-only, per RLS) — only fetch for farmer view.
      if (isFarmerView) {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const trailMap = {};
        for (const c of mapped) {
          const { data: history } = await supabase
            .from('cattle_location_history')
            .select('location, recorded_at')
            .eq('cattle_id', c.id)
            .gte('recorded_at', startOfToday.toISOString())
            .order('recorded_at', { ascending: true });

          if (history && history.length > 0) {
            trailMap[c.id] = history
              .map((h) => parsePoint(h.location))
              .filter(Boolean);
          }
        }
        setTrails(trailMap);
      }
    }

    load();
  }, [isFarmerView]);

  const handleShare = async () => {
    setSharing(true);
    try {
      await generateAndShareMapCard({ cattleList, trails, center });
    } catch (err) {
      console.error('Share failed:', err);
      alert('Share failed: ' + err.message);
    } finally {
      setSharing(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: '#fff' }}>
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 3100,
          display: 'flex',
          justifyContent: 'space-between',
          padding: 12,
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.5), transparent)',
        }}
      >
        <button
          onClick={onClose}
          style={{ padding: '8px 14px', borderRadius: 20, border: 'none' }}
        >
          ✕ Close
        </button>
        <button
          onClick={handleShare}
          disabled={sharing}
          style={{
            padding: '8px 14px',
            borderRadius: 20,
            border: 'none',
            background: '#2e7d32',
            color: '#fff',
          }}
        >
          {sharing ? 'Preparing…' : '📤 Share'}
        </button>
      </div>

      <MapContainer center={center} zoom={14} style={{ height: '100%', width: '100%' }}>
        <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />

        {cattleList
          .filter((c) => c.geofenceCenter)
          .map((c) => (
            <Circle
              key={`geo-${c.id}`}
              center={c.geofenceCenter}
              radius={c.geofenceRadiusM}
              pathOptions={{ color: '#2e7d32', fillOpacity: 0.1, weight: 2 }}
            />
          ))}

        {/* Today's movement trail per animal */}
        {Object.entries(trails).map(([cattleId, points], idx) =>
          points.length > 1 ? (
            <Polyline
              key={`trail-${cattleId}`}
              positions={points}
              pathOptions={{
                color: TRAIL_COLORS[idx % TRAIL_COLORS.length],
                weight: 3,
                opacity: 0.8,
                dashArray: '6 4',
              }}
            />
          ) : null
        )}

        {cattleList.map((c) => (
          <CattleMarker key={c.id} cattle={c} />
        ))}
      </MapContainer>
    </div>
  );
}
