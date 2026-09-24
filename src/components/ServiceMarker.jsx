// src/components/ServiceMarker.jsx
//
// One divIcon per service type, keyed the same as SERVICE_TYPES in
// AddServiceForm.jsx.
//
// RESTYLED to match the same teardrop pin shell CattleMarker.jsx and
// the updated FieldMarker.jsx use (navy rotated square + white circle
// + colored ring) instead of the old bare emoji, so all four marker
// types read as one consistent pin language on the map. Ring color is
// derived per service type via getServiceColor() (utils/pinColors.js)
// so each category gets its own stable color without a hand-maintained
// table - same species-color idea CattleMarker uses per animal.

import L from 'leaflet';
import { renderToStaticMarkup } from 'react-dom/server';
import { SERVICE_TYPES } from './AddServiceForm';
import { getServiceColor } from '../utils/pinColors';

export const SERVICE_TYPE_EMOJI = Object.fromEntries(
  SERVICE_TYPES.map((t) => [t.key, t.emoji])
);

const NAVY = '#2b3a61';
const iconCache = {};

function ServicePinContent({ emoji, ringColor }) {
  return (
    <div
      style={{
        width: 24,
        height: 24,
        margin: '2px',
        borderRadius: '50% 50% 50% 0',
        background: NAVY,
        border: `2px solid ${ringColor}`,
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
          border: `1.5px solid ${ringColor}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
        }}
      >
        {emoji}
      </div>
    </div>
  );
}

export function getServiceIcon(serviceType) {
  if (iconCache[serviceType]) return iconCache[serviceType];
  const emoji = SERVICE_TYPE_EMOJI[serviceType] || '🧰';
  const ringColor = getServiceColor(serviceType);
  const html = renderToStaticMarkup(<ServicePinContent emoji={emoji} ringColor={ringColor} />);
  const icon = L.divIcon({
    html: `<div style="width:28px;height:28px;">${html}</div>`,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 28],
  });
  iconCache[serviceType] = icon;
  return icon;
}