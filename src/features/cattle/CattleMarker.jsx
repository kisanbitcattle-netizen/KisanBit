// src/components/CattleMarker.jsx

import { useMemo } from 'react';
import { Marker, Polyline } from 'react-leaflet';
import L from 'leaflet';
import { renderToStaticMarkup } from 'react-dom/server';
import { Capacitor } from '@capacitor/core';
import { ANIMAL_EMOJI } from '../../utils/animalTaxonomy';
import { ZONE_COLORS } from '../../utils/geoZones';
import { getCattleColor } from '../../utils/cattleColors';

// ANIMAL_EMOJI used to be defined here directly (cow/buffalo/goat/sheep/
// other only). It's now derived from animalTaxonomy.js, the single source
// of truth for every animal category's emoji/breeds/sellability, and
// re-exported below so existing `import { ANIMAL_EMOJI } from
// './CattleMarker'` call sites (CattleCard.jsx, AddCattleForm.jsx) keep
// working unchanged.
export { ANIMAL_EMOJI };

// Native file:// / content:// URIs from Capacitor Camera/Filesystem won't
// load directly in an <img> on iOS WKWebView (and can be unreliable on
// Android too) ” they need to be run through convertFileSrc() to get a
// webview-loadable URL. Skip conversion for anything already web-safe
// (http(s), blob, data URIs) or when not running on a native platform.
function resolveImageSrc(uri) {
  if (!uri) return null;
  if (!Capacitor.isNativePlatform()) return uri;
  if (/^(https?:|blob:|data:)/.test(uri)) return uri;
  return Capacitor.convertFileSrc(uri);
}

// Breeding-ready badge - small heart pinned to the top-left of the pin's
// circle, mirrors the count badge's top-right positioning in
// ClusterIconContent below so the two never collide on a clustered pin.
// Plain literal style object (not a shared `styles` export) since this
// file's icons get serialized via renderToStaticMarkup() into a Leaflet
// divIcon, not rendered as normal React DOM - CSS vars still resolve fine
// there, inline object literals just keep this self-contained.
const breedingBadgeStyle = {
  position: 'absolute',
  top: -4,
  left: -4,
  fontSize: 14,
  lineHeight: 1,
  filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.5))',
};

// Brand colors (same literal hex FullMapModal.jsx uses for its own NAVY/
// GOLD consts) - kept as literal hex, not CSS vars, since this markup
// gets serialized via renderToStaticMarkup() straight into a Leaflet
// divIcon's raw HTML string rather than rendered as normal React DOM;
// CSS vars would still resolve once attached to the real page (same doc,
// same :root), but literal hex keeps the marker's own appearance
// self-contained and unaffected by whatever theme is active elsewhere.
const NAVY = '#2b3a61';
const GOLD = '#dea03b';

// Teardrop map-pin shape (matches the reference red-pin design, recolored
// to the app's own navy/gold instead of red): a square with three
// rounded corners (`50% 50% 50% 0`) rotated -45deg becomes a classic
// map-pin outline, pointed tip at the bottom. The photo/emoji circle is
// a CHILD of that rotated square with its own counter-rotation
// (rotate(45deg)) so it renders upright instead of tilted - nested CSS
// transforms compose, so a +45deg child rotation inside a -45deg parent
// nets to 0deg for the child's own content.
// Pin size reduced from a 40px square to 24px (outer rotated square) -
// container/photo-circle/emoji-font all scaled down proportionally
// (ratio 24/40 = 0.6) so the pin still looks balanced at the smaller
// size, not just cropped. iconSize/iconAnchor in buildCattleIcon below
// were updated to match (container height 44 -> 28), and the zoom
// scaling formula in zoomToScale() is untouched - it multiplies
// whatever base size the pin already is.
// `ringColor` is the animal's own getCattleColor(id) - passed down from
// CattleMarker below - so the pin's border matches that same animal's
// trail dots (cattleTrail.js) and movement-trail color elsewhere. Was
// hardcoded to GOLD for every animal, which is why a pin's ring and its
// own GPS-trail dots didn't visually match up - GOLD stays only as the
// fallback for the rare case an id is missing (cluster pins, etc.).
function PinShell({ children, badge, ringColor = GOLD }) {
  return (
    <div style={{ position: 'relative', width: 28, height: 28 }}>
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
            fontSize: 10,
          }}
        >
          {children}
        </div>
      </div>
      {badge && (
        <span style={{ ...breedingBadgeStyle, top: -2, left: -2, fontSize: 10 }} aria-label="Ready to breed">
          {badge}
        </span>
      )}
    </div>
  );
}

// Small pill of text under the pin: last-seen timestamp + place name,
// no label/heading per design (just the two values, dot-separated).
// Farmer-view only (see isFarmerView prop on CattleMarker below) -
// buyer-view rows never carry updatedAt/placeName in the first place
// (not selected for cattle_public_view - see FullMapModal's
// CATTLE_BUYER_COLUMNS), so this renders nothing for buyers either way.
function formatLastSeenShort(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function SubLabel({ lastSeen, placeName }) {
  const text = [lastSeen, placeName].filter(Boolean).join(' · ');
  if (!text) return null;
  return (
    <div
      style={{
        marginTop: 2,
        padding: '1px 4px',
        background: 'rgba(0,0,0,0.6)',
        color: '#fff',
        fontSize: 8,
        borderRadius: 5,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
}

function MarkerIconContent({ cattleId, name, animalType, localImageUri, marketplacePhotoUrl, breedingReady, lastSeen, placeName }) {
  const photoSrc = resolveImageSrc(localImageUri) || marketplacePhotoUrl || null;
  const ringColor = getCattleColor(cattleId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <PinShell badge={breedingReady ? '❤️’❤️' : null} ringColor={ringColor}>
        {photoSrc ? (
          <img src={photoSrc} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span>{ANIMAL_EMOJI[animalType] || '”'}</span>
        )}
      </PinShell>
      <div
        style={{
          marginTop: 2,
          padding: '1px 4px',
          background: 'rgba(0,0,0,0.65)',
          color: '#fff',
          fontSize: 9,
          borderRadius: 6,
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </div>
      <SubLabel lastSeen={lastSeen} placeName={placeName} />
    </div>
  );
}

// Optional zoom-based scale: at BASELINE_ZOOM the pin renders at its
// normal (1x) size; zooming in grows it, zooming out shrinks it,
// clamped to a sane range so it never disappears or gets huge. Purely
// visual - the scale is applied via a CSS transform wrapper anchored
// at the pin's tip (matching iconAnchor below), so Leaflet still
// places that exact pixel at the animal's true geo-coordinate
// regardless of scale; iconSize/iconAnchor themselves are unchanged,
// keeping this a non-breaking addition for any caller that doesn't
// pass a zoom (scale defaults to 1, identical to the old fixed size).
const BASELINE_ZOOM = 13;
function zoomToScale(zoom) {
  if (zoom == null) return 1;
  // Tuned down from an earlier, more aggressive version (1.15^n,
  // clamped 0.5-2x) that grew pins large enough at higher zoom to
  // cover up nearby cattle pins on MapPreviewCard - gentler growth
  // rate (1.07^n) and a narrower clamp (0.65-1.4x) keep the size
  // change noticeable without pins overlapping/hiding neighbors.
  const raw = Math.pow(1.07, zoom - BASELINE_ZOOM);
  return Math.min(1.4, Math.max(0.65, raw));
}

function buildCattleIcon(props, scale = 1) {
  const html = renderToStaticMarkup(<MarkerIconContent {...props} />);
  const hasSubLabel = !!(props.lastSeen || props.placeName);
  // transform-origin matches iconAnchor [36, 28] below - the pin's tip -
  // so the tip stays pinned to the marker's coordinate as it scales,
  // instead of the whole icon growing/shrinking around its center.
  const html2 = `<div style="transform: scale(${scale}); transform-origin: 36px 28px;">${html}</div>`;
  return L.divIcon({
    html: html2,
    className: 'kisanbit-cattle-marker',
    // Taller than before to fit the optional last-seen/place-name pill;
    // iconAnchor's Y stays anchored at the pin's tip (28 tall pin/photo
    // block now that PinShell shrank from 44->28, plus name pill and
    // optional sub-label), not the icon's midpoint, so the pin still
    // points at the animal's true coordinate the same way the old
    // circular marker did. Heights below reduced by the same 16px the
    // pin itself shrank by (44-28), text pill sizes unchanged so labels
    // stay readable.
    iconSize: [72, hasSubLabel ? 84 : 68],
    iconAnchor: [36, 28],
  });
}

// Cluster badge - used by FullMapModal when 2+ animals share the exact
// same displayPosition (e.g. all linked to one Cattle Base with no
// individual live GPS/geofence). Rather than jittering pins apart with a
// lat/lng offset (which looks fine at one zoom level but overlaps again
// or scatters too far at another), this collapses the group into one
// tappable marker showing a count badge. FullMapModal opens a swipeable
// picker strip on tap so the buyer/farmer can see each animal (photo +
// species) before choosing one to open its full CattleDetailModal.
function ClusterIconContent({ count, speciesEmojis, extraSpecies, anyBreedingReady }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ position: 'relative' }}>
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
            gap: 1,
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            overflow: 'hidden',
          }}
        >
          {speciesEmojis.map((emoji, i) => (
            <span
              key={i}
              style={{ fontSize: speciesEmojis.length > 1 ? 15 : 22, lineHeight: 1 }}
            >
              {emoji}
            </span>
          ))}
          {extraSpecies > 0 && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#5d4037' }}>
              +{extraSpecies}
            </span>
          )}
        </div>
        {/* Doesn't say which animal in the group - just "at least one
            here is ready". ClusterPickerSheet's own per-avatar badges
            (added in FullMapModal.jsx) tell you which one once tapped. */}
        {anyBreedingReady && (
          <span style={breedingBadgeStyle} aria-label="At least one animal ready to breed">
            ❤️
          </span>
        )}
        <div
          style={{
            position: 'absolute',
            top: -4,
            right: -4,
            minWidth: 20,
            height: 20,
            padding: '0 4px',
            borderRadius: 10,
            background: '#c62828',
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px solid #fff',
            boxSizing: 'border-box',
          }}
        >
          {count}
        </div>
      </div>
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
        {count} animals
      </div>
    </div>
  );
}

function buildClusterIcon(props, scale = 1) {
  const html = renderToStaticMarkup(<ClusterIconContent {...props} />);
  // transform-origin matches iconAnchor [36, 60] below.
  const html2 = `<div style="transform: scale(${scale}); transform-origin: 36px 60px;">${html}</div>`;
  return L.divIcon({
    html: html2,
    className: 'kisanbit-cattle-cluster-marker',
    iconSize: [72, 84],
    iconAnchor: [36, 60],
  });
}

// `cluster` shape: { displayPosition, animals: [cattleRow, ...] }
//
// Bubble shows up to 3 DISTINCT species emojis (deduped from
// animalType, which is already in memory - no fetch needed) plus a
// "+N" if more species than that are present, so a buyer can tell
// "one camel, one dog, one buffalo" at a glance without tapping.
// Deliberately emoji-only, not photos: baking real cattle photos into
// every visible cluster's divIcon would fire an <img> request per
// animal per cluster on every pan/zoom (Leaflet re-inserts marker HTML
// into the DOM as markers enter view) - real photos stay lazy, shown
// only inside ClusterPickerSheet after the buyer actually taps.
export function CattleClusterMarker({ cluster, onClick, zoom = null }) {
  const { displayPosition, animals } = cluster;

  const speciesEmojis = useMemo(() => {
    const seen = [];
    for (const a of animals) {
      const emoji = ANIMAL_EMOJI[a.animalType] || '”';
      if (!seen.includes(emoji)) seen.push(emoji);
      if (seen.length === 3) break;
    }
    return seen;
  }, [animals]);

  const extraSpecies = useMemo(() => {
    const distinctCount = new Set(animals.map((a) => a.animalType)).size;
    return Math.max(0, distinctCount - speciesEmojis.length);
  }, [animals, speciesEmojis]);

  const anyBreedingReady = useMemo(
    () => animals.some((a) => a.breedingReady),
    [animals]
  );

  const icon = useMemo(
    () => buildClusterIcon({ count: animals.length, speciesEmojis, extraSpecies, anyBreedingReady }, zoomToScale(zoom)),
    [animals.length, speciesEmojis, extraSpecies, anyBreedingReady, zoom]
  );

  if (!displayPosition) return null;

  return (
    <Marker
      position={displayPosition}
      icon={icon}
      eventHandlers={{ click: () => onClick && onClick(cluster) }}
    />
  );
}

export default function CattleMarker({ cattle, onClick, isFarmerView = false, showMarker = true, showZoneLine = true, zoom = null, opacity = 1 }) {
  const {
    id,
    name,
    animalType,
    displayPosition,
    localImageUri,
    marketplacePhotoUrl,
    breedingReady,
    updatedAt,
    placeName,
    geofenceCenter,
    liveLocation,
    currentZone,
  } = cattle;

  // Farmer-view only, per design (buyers never see last-seen/place text
  // under a pin - matches CattleDetailModal's same gating). Buyer-view
  // rows also just don't carry updatedAt/placeName at all (see
  // CATTLE_BUYER_COLUMNS in FullMapModal.jsx), so this is a belt-and-
  // braces double-gate, not the only thing stopping buyers from seeing it.
  const lastSeen = isFarmerView ? formatLastSeenShort(updatedAt) : null;
  const shownPlaceName = isFarmerView ? placeName : null;

  // Only rebuild the divIcon (renderToStaticMarkup + L.divIcon) when the
  // things that actually affect its appearance change. Without this, any
  // parent re-render ” e.g. a realtime GPS position update touching
  // `cattle` ” rebuilds the icon even though the photo/name/type didn't
  // change. breedingReady added to both the props passed in and the dep
  // list so toggling it (once the mark-ready button exists) actually
  // repaints the pin instead of waiting for some unrelated field to change.
  // lastSeen/shownPlaceName added so the pin's sub-label pill updates
  // when a fresh GPS ping bumps updated_at, without needing every other
  // field to also change. `id` added so the pin ring recolors correctly
  // if this Marker instance ever gets reused for a different animal.
  const icon = useMemo(
    () =>
      buildCattleIcon(
        { cattleId: id, name, animalType, localImageUri, marketplacePhotoUrl, breedingReady, lastSeen, placeName: shownPlaceName },
        zoomToScale(zoom)
      ),
    [id, name, animalType, localImageUri, marketplacePhotoUrl, breedingReady, lastSeen, shownPlaceName, zoom]
  );

  if (!displayPosition && !(isFarmerView && geofenceCenter && liveLocation && currentZone)) {
    return null;
  }

  return (
    <>
      {isFarmerView &&
        showZoneLine &&
        geofenceCenter &&
        liveLocation &&
        currentZone && (
          <Polyline
            positions={[geofenceCenter, liveLocation]}
            pathOptions={{
              color: ZONE_COLORS[currentZone],
              weight: 3,
              opacity: 0.9,
              dashArray: '2 8',
            }}
          />
        )}

      {showMarker && displayPosition && (
        <Marker
          position={displayPosition}
          icon={icon}
          opacity={opacity}
          eventHandlers={{ click: () => onClick && onClick(cattle) }}
        />
      )}
    </>
  );
}