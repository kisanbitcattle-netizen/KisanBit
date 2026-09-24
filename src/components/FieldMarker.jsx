// src/components/FieldMarker.jsx
//
// A pin on the map for a field/polam - shows the current crop's photo
// (or a leaf emoji fallback) at the field's centroid. Tapping it opens
// FieldDetailModal via onClick.
//
// RESTYLED to match the same teardrop pin shell CattleMarker.jsx uses
// (navy rotated square + white photo circle + colored ring), instead
// of the old plain circular ring, so Cattle/Field/Pond/Service pins
// all read as one consistent pin language on the map.
//
// Ring color still encodes crop STAGE (yellow=growing, green=ready) -
// unchanged from before. Organic status is a separate concern from
// stage, so it's a small leaf badge pinned to the top-left corner
// instead (same corner CattleMarker uses for its breeding-ready
// badge), so ring color and organic badge never fight over the same
// visual signal.

import { Marker } from 'react-leaflet';
import L from 'leaflet';
import { renderToStaticMarkup } from 'react-dom/server';

// Simple average-of-vertices centroid. Good enough for typical field
// shapes (not a true geometric centroid for oddly concave polygons,
// but fields are close enough to convex that this looks right).
export function polygonCentroid(positions) {
  if (!positions || positions.length === 0) return null;
  const [latSum, lngSum] = positions.reduce(
    ([latAcc, lngAcc], [lat, lng]) => [latAcc + lat, lngAcc + lng],
    [0, 0]
  );
  return [latSum / positions.length, lngSum / positions.length];
}

const NAVY = '#2b3a61';

// Neon glow ring: yellow while the crop is growing, green once it's
// ready for harvest. Injected once into <head> - marker HTML strings
// just reference the class names, no inline <style> repeated per pin.
let neonStylesInjected = false;
function ensureNeonMarkerStyles() {
  if (neonStylesInjected) return;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes kbNeonPulseYellow {
      0%, 100% { box-shadow: 0 0 6px 2px rgba(255,214,0,0.85), 0 0 14px 5px rgba(255,214,0,0.5); }
      50% { box-shadow: 0 0 10px 4px rgba(255,214,0,1), 0 0 22px 9px rgba(255,214,0,0.75); }
    }
    @keyframes kbNeonPulseGreen {
      0%, 100% { box-shadow: 0 0 6px 2px rgba(0,230,118,0.85), 0 0 14px 5px rgba(0,230,118,0.5); }
      50% { box-shadow: 0 0 10px 4px rgba(0,230,118,1), 0 0 22px 9px rgba(0,230,118,0.75); }
    }
    .kb-field-marker-ring {
      animation: kbNeonPulseYellow 1.6s ease-in-out infinite;
    }
    .kb-field-marker-ring.kb-ready {
      animation: kbNeonPulseGreen 1.6s ease-in-out infinite;
    }
  `;
  document.head.appendChild(style);
  neonStylesInjected = true;
}

// Organic badge - top-left corner, same spot CattleMarker.jsx reserves
// for its breeding-ready heart, so a Field pin's badge and a Cattle
// pin's badge always land in the same place across marker types.
const organicBadgeStyle = {
  position: 'absolute',
  top: -4,
  left: -4,
  fontSize: 12,
  lineHeight: 1,
  filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.5))',
};

function FieldPinContent({ photoUrl, isReady, isOrganic }) {
  const ringColor = isReady ? '#00e676' : '#ffd600';

  return (
    <div style={{ position: 'relative', width: 28, height: 28 }}>
      <div
        className={`kb-field-marker-ring${isReady ? ' kb-ready' : ''}`}
        style={{
          width: 24,
          height: 24,
          margin: '2px',
          borderRadius: '50% 50% 50% 0',
          background: NAVY,
          border: `2px solid ${ringColor}`,
          transform: 'rotate(-45deg)',
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
            border: `1.5px solid ${ringColor}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
          }}
        >
          {photoUrl ? (
            <img src={photoUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span>🌱</span>
          )}
        </div>
      </div>

      {isOrganic && (
        <span style={organicBadgeStyle} aria-label="Organic">
          🌿
        </span>
      )}
    </div>
  );
}

function buildIcon(photoUrl, isReady, isOrganic) {
  const html = renderToStaticMarkup(
    <FieldPinContent photoUrl={photoUrl} isReady={isReady} isOrganic={isOrganic} />
  );
  return L.divIcon({
    html,
    className: 'kb-field-marker',
    iconSize: [28, 28],
    iconAnchor: [14, 28],
  });
}

export default function FieldMarker({ field, onClick }) {
  const centroid = polygonCentroid(field.positions);
  if (!centroid) return null;

  ensureNeonMarkerStyles();
  const isReady = field.stage === 'ready';
  // Tolerates either casing, matching the ownerId/baseId pattern used
  // elsewhere in the codebase, until is_organic's mapping in
  // loadFields() is confirmed.
  const isOrganic = field.isOrganic ?? field.is_organic ?? false;

  return (
    <Marker
      position={centroid}
      icon={buildIcon(field.currentCropPhotoUrl, isReady, isOrganic)}
      eventHandlers={{ click: () => onClick?.(field) }}
    />
  );
}