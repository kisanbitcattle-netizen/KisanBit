// src/components/PondMarker.jsx
//
// New - Ponds previously had no dedicated marker component (drawn
// inline in FullMapModal.jsx per the polygon/marker note in
// PondDetailModal.jsx's docstring). Adds one so Ponds get the same
// teardrop pin shell as Cattle/Field/Service.
//
// CHANGED: ring color used to vary per pond, picked by the dominant
// fish species currently in stock (getPondColor, in utils/pinColors.js)
// - a farmer's explicit request was for one fixed color across every
// pond instead, so this now always uses RING_COLOR ('#1e88e5' - the
// same blue FullMapModal.jsx already uses for pond boundary polygons,
// so a pond's marker and its boundary read as the same shade).
//
// Expects a `pond` shaped like FullMapModal.jsx's loadPonds() return
// value: { id, centroid, fishStock: [...], ... } (see
// PondDetailModal.jsx's docstring for the full shape).

import { Marker } from 'react-leaflet';
import L from 'leaflet';
import { renderToStaticMarkup } from 'react-dom/server';

const NAVY = '#2b3a61';
// Fixed ring color for every pond pin - matches the pond boundary
// polygon color in FullMapModal.jsx (pathOptions.color: '#1e88e5').
const RING_COLOR = '#1e88e5';

function PondPinContent() {
  return (
    <div
      style={{
        width: 24,
        height: 24,
        margin: '2px',
        borderRadius: '50% 50% 50% 0',
        background: NAVY,
        border: `2px solid ${RING_COLOR}`,
        transform: 'rotate(-45deg)',
        boxShadow: '0 2px 4px rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          transform: 'rotate(45deg)',
          width: 18,
          height: 18,
          borderRadius: '50%',
          overflow: 'hidden',
          background: '#fff',
          border: `1.5px solid ${RING_COLOR}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
        }}
      >
        🐟
      </div>
    </div>
  );
}

// Built once, not per-pond - the icon no longer depends on any per-pond
// data (ring color is fixed), so every PondMarker instance can share it.
const POND_ICON = L.divIcon({
  html: `<div style="width:28px;height:28px;">${renderToStaticMarkup(<PondPinContent />)}</div>`,
  className: '',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
});

export default function PondMarker({ pond, onClick }) {
  const { centroid } = pond;
  if (!centroid) return null;

  return (
    <Marker
      position={centroid}
      icon={POND_ICON}
      eventHandlers={{ click: () => onClick?.(pond) }}
    />
  );
}