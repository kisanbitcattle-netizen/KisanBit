// src/components/CattleMarker.jsx
//
// Renders a custom Leaflet marker for a cattle: local device photo
// (if available) or a species emoji fallback, with a name tag below.
// Equivalent to the old cattle_marker.dart widget.

import { Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { renderToStaticMarkup } from 'react-dom/server';

export const ANIMAL_EMOJI = {
  cow: '🐄',
  buffalo: '🐃',
  goat: '🐐',
  sheep: '🐑',
};

function MarkerIconContent({ name, animalType, localImageUri, marketplacePhotoUrl }) {
  const photoSrc = localImageUri || marketplacePhotoUrl || null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {photoSrc ? (
        <img
          src={photoSrc}
          alt={name}
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            objectFit: 'cover',
            border: '2px solid #8d6e63',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }}
        />
      ) : (
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: '#fff',
            border: '2px solid #8d6e63',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }}
        >
          {ANIMAL_EMOJI[animalType] || '❔'}
        </div>
      )}
      <div
        style={{
          marginTop: 2,
          padding: '2px 6px',
          background: 'rgba(0,0,0,0.65)',
          color: '#fff',
          fontSize: 11,
          borderRadius: 6,
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </div>
    </div>
  );
}

/// Builds a Leaflet divIcon from the React markup above.
/// react-leaflet markers need a plain Leaflet icon, so we render
/// our JSX to a static HTML string first.
function buildCattleIcon(props) {
  const html = renderToStaticMarkup(<MarkerIconContent {...props} />);
  return L.divIcon({
    html,
    className: 'kisanbit-cattle-marker', // keep empty in CSS to avoid default styles
    iconSize: [72, 84],
    iconAnchor: [36, 60],
  });
}

export default function CattleMarker({ cattle, onClick }) {
  const {
    name,
    animalType,
    displayPosition, // [lat, lon] — either live_location (owner) or geofence_center (public)
    localImageUri,
    marketplacePhotoUrl,
    salePrice,
  } = cattle;

  if (!displayPosition) return null;

  const icon = buildCattleIcon({ name, animalType, localImageUri, marketplacePhotoUrl });

  return (
    <Marker
      position={displayPosition}
      icon={icon}
      eventHandlers={{ click: () => onClick && onClick(cattle) }}
    >
      <Popup>
        <strong>{name}</strong>
        <br />
        {animalType.toUpperCase()}
        {salePrice != null && (
          <>
            <br />
            Price: ₹{salePrice}
          </>
        )}
      </Popup>
    </Marker>
  );
}
