// src/components/FullMapModal.jsx
//
// Opens when the hero MapPreviewCard is tapped. Shows the full,
// interactive map PLUS today's movement trail (polyline built from
// cattle_location_history), field boundaries/geofence circles
// (read-only - these are SET in AddCattleForm/AddFieldForm, never
// drawn here), a Share button, and now: a search + voice-search
// header, a debounced pan/zoom pin refresh, and a filter bottom sheet
// whose settings persist in localStorage.
//
// Data ownership rule: geofence/boundary/pin DATA always comes from
// Supabase (source of truth). localStorage is used ONLY to remember
// the user's last-picked filter settings across app sessions - never
// to store cattle/field/geofence data itself.

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { offlineCache } from '../utils/offlineCache';
import {
  MapContainer,
  Marker,
  Popup,
  Polyline,
  Polygon,
  Circle,
  CircleMarker,
  ZoomControl,
  useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { supabase } from '../config/supabaseClient';
import CattleMarker, { CattleClusterMarker, ANIMAL_EMOJI } from './CattleMarker';
import CattleDetailModal from './CattleDetailModal';
import FieldMarker from '../features/fields/FieldMarker';
import PondMarker from '../features/ponds/PondMarker';
import FieldDetailModal from '../features/fields/FieldDetailModal';
import OfflineTileLayer from './OfflineTileLayer';
import { parseWkbPoint } from '../utils/geo';
// Zone-colored base→animal dots line (replaces the old static public
// geofence Circle in this file - see the render block near the bottom).
// Same tier colors/distance math MapPreviewCard.jsx and
// GeofenceSetupModal use, centralized so all three stay in sync.
import { ZONE_COLORS, haversineMeters, getCurrentZone } from '../utils/geoZones';
import { getCattleColor } from '../utils/cattleColors';
// Historical GPS trail (segments + dots), shared with MapPreviewCard.jsx
// so both draw the exact same trail the exact same way - see
// utils/cattleTrail.js for the tier-boundary-split segment logic.
import { fetchCattleTrail, buildTrailSegments, todayLocalDateString } from '../utils/cattleTrail';
import { getServiceIcon } from '../features/services/ServiceMarker';
import ServiceDetailModal from '../features/services/ServiceDetailModal';
import PondDetailModal from '../features/ponds/PondDetailModal';
import FilterSheet, { DEFAULT_FILTERS } from './MapFilters';

/**
 * @typedef {Object} FarmerPin
 * @property {string} id
 * @property {'cattle'|'field'} type
 * @property {string} name
 * @property {[number, number]|null} position  [lat, lng]
 */
// MapFilters type moved to MapFilters.jsx alongside the FilterSheet
// component and DEFAULT_FILTERS that actually define its shape.

const DEFAULT_CENTER = [17.385, 78.4867];
const NAVY = 'var(--color-navy)';
const GOLD = 'var(--color-gold)';

// Simple emoji divIcon for water sources - no dedicated WaterMarker
// component exists yet (unlike CattleMarker/FieldMarker), and this
// sidesteps the same broken-default-marker-icon issue GeofenceSetupModal.jsx
// already had to work around for Leaflet's built-in <Marker> icon under Vite.
const WATER_ICON = L.divIcon({
  html: '<div style="font-size:22px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45));">\u{1F4A7}</div>',
  className: '',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

// NOTE: POND_ICON (a bare 🐟 divIcon, same pattern as WATER_ICON) used to
// be used here - replaced below with the shared <PondMarker> component so
// Pond pins get the same navy teardrop-pin shell Cattle/Field/Service
// already use, instead of a raw floating emoji with no pin shape at all.
// ADDED: Cattle Base marker - same emoji-divIcon pattern as WATER_ICON/
// POND_ICON above, and the SAME icon/anchor MapPreviewCard.jsx already
// uses for its own base markers, so a Base reads identically on both
// screens. Was previously missing here entirely - an animal falling
// back to its Base's location (no live GPS, no geofence of its own -
// see loadCattle's usesBaseFallback) had nothing on this map to show
// THAT'S where it's coming from, so it just looked like a stray pin
// sitting oddly close to whichever other animal happened to be near
// home in real life, with no way to confirm it's actually anchored to
// the Base and not just coincidentally near that other animal.
const BASE_ICON = L.divIcon({
  html: '<div style="font-size:22px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));">\u{1F3E0}</div>',
  className: '',
  iconSize: [24, 24],
  iconAnchor: [12, 20],
});

const FILTERS_STORAGE_KEY = 'kisanbit_map_filters_v1';
const PAN_DEBOUNCE_MS = 800; // debounced bounds-fetch on map move/zoom - stops hammering the DB while panning

const VOICE_LANGS = [
  { code: 'te-IN', label: '\u0C24\u0C46\u0C32\u0C41\u0C17\u0C41' },
  { code: 'en-IN', label: 'EN' },
  { code: 'hi-IN', label: '\u0939\u093F\u0928\u094D\u0926\u0940' },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// YYYY-MM-DD in LOCAL time for an arbitrary timestamp - same format as
// cattleTrail.js's todayLocalDateString(), so a straight string compare
// tells us whether a row's updated_at falls on today's calendar day.
// Used to gate the live-position PIN below (see isFromToday in
// loadCattle) - a farmer's explicit request: a stale live_location
// reading from a previous day should show the animal at Base, not
// linger indefinitely just because it was once a valid fix.
function localDateString(dateInput) {
  const d = new Date(dateInput);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Re-applies the "a live_location reading only counts if it's from
// TODAY" rule to cattle rows that are being restored from offlineCache
// or merged via offlineCache.mergeById - i.e. NOT freshly re-mapped by
// loadCattle() this time. This is necessary because delta-sync only
// re-fetches rows whose updated_at actually CHANGED since the last
// sync (see loadCattle's `sinceIso` filter) - an animal whose collar
// hasn't reported anything since yesterday never appears in a delta
// fetch at all, so its cached liveLocation/displayPosition (computed
// back when today WAS "today") would otherwise sit there stale
// forever across a midnight rollover, with nothing to ever re-gate it.
// Cheap (pure JS, no network) and idempotent - re-running it on an
// already-correct row (liveLocation already null, or genuinely from
// today) is a no-op, so it's safe to call on every cache-first render
// and every merge, not just once.
function applyTodayGate(cattle) {
  const today = todayLocalDateString();
  return cattle.map((c) => {
    if (!c.liveLocation) return c; // already Base/no live position - nothing to re-check
    const isFromToday = c.updatedAt ? localDateString(c.updatedAt) === today : false;
    if (isFromToday) return c;
    return { ...c, liveLocation: null, displayPosition: c.geofenceCenter };
  });
}

function parsePoint(geoJsonPoint) {
  if (!geoJsonPoint || !geoJsonPoint.coordinates) return null;
  const [lon, lat] = geoJsonPoint.coordinates;
  return [lat, lon];
}

// geofence_center / live_location are PostGIS geography columns and come
// back from PostgREST as raw WKB hex, not GeoJSON — there's no confirmed
// _geojson computed-column equivalent for either on the live schema, so
// both are parsed client-side via the shared, SRID-aware parseWkbPoint()
// from src/utils/geo.js (see that file for the SRID-offset bug this
// replaces - the local copy that used to live here always assumed no
// embedded SRID and decoded garbage whenever one was present).

// Polygon GeoJSON is [ [ [lng,lat], [lng,lat], ... ] ] (outer ring first,
// closing point repeats the first point). react-leaflet's <Polygon>
// wants [[lat,lng], ...] and doesn't need the closing point repeated.
function parsePolygon(geoJsonPolygon) {
  if (!geoJsonPolygon || !geoJsonPolygon.coordinates) return null;
  const ring = geoJsonPolygon.coordinates[0];
  if (!ring || ring.length < 3) return null;
  return ring.map(([lng, lat]) => [lat, lng]);
}

// Field pin stage: 'ready' once the crop's harvest_date has arrived,
// 'upcoming' otherwise. This is only ever CALLED (see loadFields below)
// at the moment a crop's qc_certificate_url actually changes - not on
// every load/poll - per business decision, so a field doesn't visually
// flip stage just because someone reopened the map after midnight.
function stageFromHarvestDate(harvestDate) {
  if (!harvestDate) return 'upcoming';
  const harvest = new Date(harvestDate);
  if (Number.isNaN(harvest.getTime())) return 'upcoming';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  harvest.setHours(0, 0, 0, 0);
  return harvest <= today ? 'ready' : 'upcoming';
}

function polygonCentroid(positions) {
  if (!positions || positions.length === 0) return null;
  const [latSum, lngSum] = positions.reduce(
    ([la, lo], [lat, lng]) => [la + lat, lo + lng],
    [0, 0]
  );
  return [latSum / positions.length, lngSum / positions.length];
}

function haversineKm(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371;
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Threshold for handleViewportSettled below: a pan/zoom only triggers a
// fresh cattle delta-sync if it moved the viewport by more than this
// fraction of the PREVIOUS viewport's diagonal (in km). A few-meter
// nudge (map jitter, a stray finger drag) stays under this and skips
// the sync entirely - a zoom-level change always counts as significant
// regardless of this fraction, since the visible bounding box's area
// changes a lot on any zoom step.
const VIEWPORT_CHANGE_THRESHOLD = 0.12; // 12% - middle of the requested 10-15% range

function boundsDiagonalKm(bounds) {
  if (!bounds) return 0;
  return haversineKm([bounds.north, bounds.west], [bounds.south, bounds.east]);
}

// `prev`/`next` are the same shape MapMoveWatcher's onSettled passes:
// { north, south, east, west, center, zoom }. `prev` is null the very
// first time this ever runs (nothing synced yet), which always counts
// as significant so the first real pan still syncs.
function viewportChangedSignificantly(prev, next) {
  if (!prev) return true;
  if (prev.zoom !== next.zoom) return true;
  const diagonalKm = boundsDiagonalKm(prev);
  if (diagonalKm === 0) return true;
  const movedKm = haversineKm(prev.center, next.center);
  return movedKm / diagonalKm > VIEWPORT_CHANGE_THRESHOLD;
}

function loadStoredFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_FILTERS, ...parsed };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveStoredFilters(filters) {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // localStorage can be unavailable (private mode / quota) - filters
    // just won't persist across sessions, non-fatal.
  }
}

// ---------------------------------------------------------------------------
// MapMoveWatcher - lives INSIDE <MapContainer>, debounces moveend/zoomend
// ---------------------------------------------------------------------------

function MapMoveWatcher({ onSettled, mapRef, onZoomChange }) {
  const timerRef = useRef(null);

  const map = useMapEvents({
    moveend() {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const b = map.getBounds();
        const c = map.getCenter();
        onSettled({
          north: b.getNorth(),
          south: b.getSouth(),
          east: b.getEast(),
          west: b.getWest(),
          center: [c.lat, c.lng],
          zoom: map.getZoom(),
        });
      }, PAN_DEBOUNCE_MS);
    },
    // Deliberately separate from the debounced moveend/onSettled above -
    // onSettled triggers a full delta-sync re-fetch (PAN_DEBOUNCE_MS =
    // 800ms lag, intentional there), but pin size should feel instant as
    // the user pinches/taps zoom, not wait 800ms and pop into the right
    // size after the fact. zoomend fires once the zoom gesture/animation
    // finishes, same as moveend does for pans.
    zoomend() {
      if (onZoomChange) onZoomChange(map.getZoom());
    },
  });

  // Expose the live Leaflet map instance to the parent (for the "Fit All"
  // button's fitBounds() call) without adding a second map-ready mechanism -
  // useMapEvents already gives us the instance, we just stash it in a ref
  // the parent owns. mapRef is a plain useRef, so this doesn't trigger
  // re-renders.
  useEffect(() => {
    if (mapRef) mapRef.current = map;
  }, [map, mapRef]);

  useEffect(() => () => timerRef.current && clearTimeout(timerRef.current), []);
  return null;
}

// ---------------------------------------------------------------------------
// SearchHeader - search input + voice search (native Web Speech API)
// ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // SearchHeader - search input + voice search
  // ---------------------------------------------------------------------

const SearchHeader = React.memo(function SearchHeader({
  query,
  onQueryChange,
  onOpenFilters,
  onClose,
}) {
  const [lang, setLang] = useState('te-IN');
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [voiceError, setVoiceError] = useState('');
  const recognitionRef = useRef(null);

  useEffect(() => {
    const SpeechRecognitionCtor =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      setVoiceSupported(false);
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript || '';
      if (transcript) onQueryChange(transcript);
      setListening(false);
    };
    recognition.onerror = (event) => {
      setListening(false);
      // 'no-speech' / 'aborted' are routine (user stayed silent, or
      // cancelled) - don't show a scary error for those.
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setVoiceError('Voice search is not working,try again.');
      }
    };
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    return () => {
      try {
        recognition.abort();
      } catch {
        /* no-op */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (recognitionRef.current) recognitionRef.current.lang = lang;
  }, [lang]);

  const handleMicClick = useCallback(() => {
    if (!voiceSupported || !recognitionRef.current) {
      setVoiceError('Ee device/browser lo voice search support avvadu.');
      return;
    }
    setVoiceError('');
    try {
      setListening(true);
      recognitionRef.current.start();
    } catch {
      // start() throws if already running - just ignore.
      setListening(false);
    }
  }, [voiceSupported]);

  return (
    <div style={styles.searchHeader}>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close map"
        style={styles.iconButton}
      >
        {"\u2715"}
      </button>

      <button
  type="button"
  onClick={onOpenFilters}
  aria-label="Filters"
  title="Filters"
  style={styles.iconButton}
>
  {'\u2699\uFE0F'}
</button>

      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search location..."
        style={styles.searchInput}
      />

      <select
        value={lang}
        onChange={(e) => setLang(e.target.value)}
        aria-label="Voice language"
        style={styles.langSelect}
        disabled={!voiceSupported}
      >
        {VOICE_LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={handleMicClick}
        disabled={listening || !voiceSupported}
        aria-label="Voice search"
        title={voiceSupported ? 'Voice search' : 'Voice search not supported'}
        style={{
          ...styles.iconButton,
          background: listening ? GOLD : 'var(--color-card)',
          opacity: voiceSupported ? 1 : 0.4,
        }}
      >
        {listening ? 'Listening...' : 'Voice'}
      </button>

      {voiceError && <div style={styles.voiceErrorToast}>{voiceError}</div>}
    </div>
  );
});

// Opens when a cluster marker (2+ animals sharing one Cattle Base
// position, see markerCattleList below) is tapped. Rather than a plain
// list, this is a horizontal swipeable strip of each animal's own
// avatar (photo if it has one, else its species emoji) + name, so a
// buyer can tell at a glance "one dog, one cat, one buffalo" instead of
// reading text rows. Tapping a circle opens that animal's full
// CattleDetailModal via onPick.
const ClusterPickerSheet = React.memo(function ClusterPickerSheet({ cluster, onClose, onPick }) {
  const animals = cluster?.animals || [];

  return (
    <div style={styles.sheetBackdrop} onClick={onClose}>
      <div style={styles.clusterSheet} onClick={(e) => e.stopPropagation()}>
        <div style={styles.sheetHandle} />
        <div style={styles.clusterSheetTitle}>
          {animals.length} animals here - swipe to pick one
        </div>
        <div style={styles.clusterStrip}>
          {animals.map((a) => (
            <button
              key={a.id}
              type="button"
              style={styles.clusterStripItem}
              onClick={() => onPick(a)}
            >
              <div style={{ position: 'relative' }}>
                {a.marketplacePhotoUrl ? (
                  <img
                    src={a.marketplacePhotoUrl}
                    alt={a.name}
                    style={styles.clusterStripPhoto}
                  />
                ) : (
                  <div style={styles.clusterStripEmoji}>
                    {ANIMAL_EMOJI[a.animalType] || 'animal'}
                  </div>
                )}
                {a.breedingReady && (
                  <span style={styles.breedingBadge} aria-label="Ready to breed">
                    {String.fromCodePoint(0x1F497)}
                  </span>
                )}
              </div>
              <span style={styles.clusterStripLabel}>{a.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
export default function FullMapModal({ isFarmerView, onClose, selectedTarget }) {
  const [cattleList, setCattleList] = useState([]);
  // Mirrors cattleList so loadCattle() can look up each animal's last
  // known good live position synchronously (state itself can't be read
  // synchronously outside a functional updater). See loadCattle's
  // `previousCattleById` param below for why this exists.
  const cattleListRef = useRef([]);
  useEffect(() => {
    cattleListRef.current = cattleList;
  }, [cattleList]);
  const [fieldList, setFieldList] = useState([]);
  const [waterSources, setWaterSources] = useState([]);
  // Services are meant to be discovered by every farmer/buyer, not just
  // the owner - unlike waterSources/cattleList (owner-scoped in farmer
  // view), this is always the full public list regardless of
  // isFarmerView. See loadServices below.
  const [servicesList, setServicesList] = useState([]);
  const [pondsList, setPondsList] = useState([]);
  // Historical GPS trail per animal, fetched from cattle_location_history
  // via the shared cattleTrail.js helpers (same as MapPreviewCard.jsx) -
  // replaces the old one-off loadTrails()/trails state that lived in this
  // file, which fetched via a raw parsePoint() call (wrong for a WKB
  // geography column - see fetchCattleTrail's own comments) and had no
  // Null Island guard, no tier-segment coloring, and no flash.
  const [trailsByCattleId, setTrailsByCattleId] = useState({});
  // Single-animal, date-scoped trail requested from CattleDetailModal's
  // "🎯 Locate on Map" button (handleViewTrailOnMap below). Deliberately
  // separate from trailsByCattleId above (the always-on rolling-recent
  // trail for every animal, refreshed every 60s) since this one can be
  // pinned to an arbitrary PAST date and only ever concerns one animal -
  // { cattleId, date, points } | null. `date` is null for the rolling-24h
  // case (mirrors CattleDetailModal's own historyDate semantics), kept
  // here so the dismiss badge below can show "Today" vs the actual date.
  const [viewedTrail, setViewedTrail] = useState(null);
  const [center, setCenter] = useState(DEFAULT_CENTER);
  const [selectedCattle, setSelectedCattle] = useState(null);
  const [selectedField, setSelectedField] = useState(null);
  const [selectedService, setSelectedService] = useState(null);
  const [selectedPond, setSelectedPond] = useState(null);
  // --- new: search / voice / filters / debounced pan ---
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState(loadStoredFilters);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [viewportCenter, setViewportCenter] = useState(DEFAULT_CENTER);
  // Live zoom level, kept in sync via MapMoveWatcher's zoomend handler -
  // drives cattle pin/cluster size scaling (see CattleMarker's `zoom`
  // prop). Starts at 14 to match the MapContainer's initial zoom={14}.
  const [zoomLevel, setZoomLevel] = useState(14);

  // Live map zoom used by the cattle clustering renderer.
  // Lower zoom = aggressive clustering.
  // Higher zoom = clusters progressively split.
  const [mapZoom, setMapZoom] = useState(14);

  const [likedFieldIds, setLikedFieldIds] = useState(new Set());
  const [likedCattleIds, setLikedCattleIds] = useState(new Set());
  const [likedServiceIds, setLikedServiceIds] = useState(new Set());

  // Live Leaflet map instance, populated by MapMoveWatcher via useMapEvents.
  // Used only by handleFitAll() below - never read during render, so a
  // plain ref (not state) is correct here.
  const mapRef = useRef(null);

  // Tracks whether center/viewportCenter has ever been set from REAL pin
  // data (a cattle position or field centroid) as opposed to the hardcoded
  // DEFAULT_CENTER fallback. Read by the geolocation-fallback effect below
  // so it never yanks the map away from a center the user's own data
  // already legitimately established - it's purely a last-resort for the
  // "zero cattle, zero fields yet" case. A ref (not state) because it's
  // only ever read inside an async callback, not during render.
  const hasRealCenterRef = useRef(false);

  // FIX: react-leaflet's <MapContainer center={...}> only uses `center`
  // to construct the underlying Leaflet map ONCE, on mount - changing
  // the `center` state on a later render does NOT pan an already-
  // mounted map. The geolocation-fallback effect further down already
  // worked around this correctly (setCenter() + a direct
  // mapRef.current.setView() call, see its comment) - but the three
  // cattle/field-pin-based recenters inside loadAll() below (cache-first
  // load, first-ever sync, and delta-sync new-pin) only ever called
  // setCenter()/setViewportCenter(), so the map itself silently stayed
  // parked at DEFAULT_CENTER (or wherever it last was) even once real
  // pin data resolved. This shared helper applies both the state update
  // (so center/viewportCenter stay correct for anything that reads them)
  // AND the imperative setView() the live map instance actually needs.
  // mapRef.current may not be populated yet the very first time this
  // runs (MapMoveWatcher sets it slightly after mount) - guarded, same
  // as the geolocation effect already does.
  const recenterMapTo = (pos) => {
    setCenter(pos);
    setViewportCenter(pos);
    hasRealCenterRef.current = true;
    // Keep whatever zoom the map is already at (matches MapContainer's
    // own initial zoom={14} the first time this fires) rather than
    // forcing a fixed zoom level on every recenter.
    if (mapRef.current) mapRef.current.setView(pos, mapRef.current.getZoom());
  };

  // ADDED: auto center+zoom onto whatever the farmer picked from
  // MapPreviewCard's Select list (Cattle Base or individual animal)
  // when this modal opens. Guarded by appliedTargetRef so it only
  // fires ONCE per distinct selection (object identity), not on every
  // subsequent cattleList delta-sync refresh while the modal stays
  // open - flyTo-ing repeatedly on every realtime ping would keep
  // yanking the view back and fighting the farmer's own pan/zoom.
  const appliedTargetRef = useRef(null);
  useEffect(() => {
    if (!selectedTarget?.position) return;
    if (appliedTargetRef.current === selectedTarget) return;
    appliedTargetRef.current = selectedTarget;

    const targetZoom = 17;
    if (mapRef.current) {
      mapRef.current.flyTo(selectedTarget.position, targetZoom, { animate: true, duration: 0.6 });
    } else {
      // Map instance not ready yet (rare - MapMoveWatcher usually
      // populates mapRef before this data-driven effect fires) -
      // same imperative fallback the geolocation effect already uses.
      recenterMapTo(selectedTarget.position);
    }
  }, [selectedTarget]);

  // ADDED: if the picked target is an individual animal (not a Base),
  // also auto-open its CattleDetailModal once this modal's own
  // cattleList fetch has resolved and the animal is actually in it -
  // mirrors what tapping that animal's pin directly does. Separate
  // ref/effect from the pan-the-map one above since cattleList often
  // isn't loaded yet at the moment selectedTarget first arrives.
  const openedTargetCattleRef = useRef(null);
  useEffect(() => {
    if (selectedTarget?.type !== 'cattle') return;
    if (openedTargetCattleRef.current === selectedTarget) return;
    const match = cattleList.find((c) => c.id === selectedTarget.id);
    if (match) {
      openedTargetCattleRef.current = selectedTarget;
      setSelectedCattle(match);
    }
  }, [selectedTarget, cattleList]);

  // field_id -> { qcCertificateUrl, stage }. Lets loadFields() tell
  // "the QC cert on this field's crop just changed" apart from "we're
  // just re-fetching the same crop again" - stage only recomputes on
  // the former, per business decision (see stageFromHarvestDate).
  const cropStageRef = useRef({});

  // -------------------------------------------------------------------
  // Data loading - geofence circles / field boundaries / pin positions
  // ALWAYS come from Supabase. Nothing about cattle/field/geofence data
  // is ever read from or written to localStorage.
  // -------------------------------------------------------------------

  // average_rating/rating_count DO NOT EXIST as live columns (confirmed) -
  // selecting them fails the ENTIRE query (Postgres 42703), which is why
  // no cattle pins were rendering at all before this fix. Ratings live
  // exclusively in the separate cattle_ratings table (CattleDetailModal).
  //
  // live_location_geojson has NO confirmed backing (no column, no
  // function) - dropped in favor of the raw live_location geography
  // column, decoded client-side via parseWkbPoint() below (same pattern
  // already working in MapPreviewCard.jsx).
  // owner_id added to both lists below - it was missing entirely, so
  // CattleDetailModal never received it and could never tell who the
  // listing's real owner was (isOwner was permanently false for
  // everyone, on every cattle card - the "Chat with Seller" button
  // stayed visible even on your own listings and rejected on tap).
  // is_breeding_ready: was farmer-only. Now also public (breed-ready
  // cattle should be pinned for other farmers/buyers even when not
  // listed for sale) - added to CATTLE_BUYER_COLUMNS below.
  // ASSUMPTION: column name follows the existing is_listed_for_sale/
  // is_archived convention - flag if the real migration used something
  // else, this is a one-line fix in the mapper below.
  //
  // NOTE: selecting this column here is necessary but NOT sufficient -
  // `cattle_public_view` and/or its RLS policy currently only expose
  // rows where is_listed_for_sale = true (see public_select_listed_
  // cattle policy referenced above). Until that view/policy is updated
  // on the DB side to also allow is_breeding_ready = true rows through,
  // a breed-ready-but-unlisted animal still won't reach this query at
  // all, regardless of this column list. See the SQL note delivered
  // alongside this fix - needs to be verified against the real view
  // definition and run against the DB before this actually takes effect.
  const CATTLE_FARMER_COLUMNS =
    'id, owner_id, name, animal_type, local_image_path, marketplace_photo_url, sale_price_min, sale_price_max, collar_id, breed, govt_inaph_id, birth_date, weight_kg, calving_count, contact_phone, contact_whatsapp, qc_certificate_url, is_listed_for_sale, is_breeding_ready, geofence_radius_m, geofence_center_geojson, alert_radius_1_m, alert_radius_2_m, alert_radius_3_m, live_location, base_id, updated_at, place_name';
  // FIX: is_listed_for_sale was missing from this select entirely, so
  // every buyer-view row mapped isListedForSale to undefined below (see
  // ~line 783) regardless of the animal's real listing state.
  const CATTLE_BUYER_COLUMNS =
    'id, owner_id, name, animal_type, marketplace_photo_url, sale_price_min, sale_price_max, breed, birth_date, weight_kg, calving_count, contact_phone, contact_whatsapp, qc_certificate_url, is_breeding_ready, is_listed_for_sale, geofence_radius_m, geofence_center, base_id, updated_at';


  const loadCattle = useCallback(async (sinceIso, userId, previousCattleById = {}) => {
    // SECURITY: never allow an unscoped farmer cattle query.
    if (isFarmerView && !userId) {
      console.warn('[FullMapModal] Farmer cattle fetch blocked: no authenticated user');
      return [];
    }

    const table = isFarmerView ? 'cattle' : 'cattle_public_view';
    // Narrowed from select('*') - was pulling every column on `cattle`
    // (including large/unused ones like health notes) on every poll.
    const selectFields = isFarmerView ? CATTLE_FARMER_COLUMNS : CATTLE_BUYER_COLUMNS;
    let query = supabase.from(table).select(selectFields);
    // CRITICAL: scope farmer view to the logged-in owner only. Without
    // this, the public_select_listed_cattle RLS policy (any authenticated
    // user can SELECT any is_listed_for_sale=true row) leaks OTHER
    // farmers' listed cattle onto this farmer's own map - Postgres RLS
    // ORs all matching permissive policies together, so
    // cattle_owner_full_access alone doesn't shut this out.
    if (isFarmerView && userId) query = query.eq('owner_id', userId);
    // FIX: buyer view was relying entirely on cattle_public_view/its RLS
    // policy to only return is_listed_for_sale = true rows. Same class of
    // bug as HomeScreen.jsx's buyer query - if the view or policy is ever
    // looser than that (e.g. once is_breeding_ready rows are let through
    // per the NOTE above), unlisted animals leak onto this map too. Filter
    // explicitly here as well, same as HomeScreen.jsx.
    if (!isFarmerView) query = query.eq('is_listed_for_sale', true);
    if (sinceIso) query = query.gte('updated_at', sinceIso);
    const { data, error } = await query;
    if (error || !data) {
      if (error) console.error('[FullMapModal] cattle fetch failed:', error.message, error.details, error.hint, error.code);
      return [];
    }

    // Base-location fallback: for any cattle with neither a live GPS fix
    // nor a geofence set, fall back to its assigned base's location so it
    // still shows up on the map instead of vanishing entirely. One batch
    // query for every distinct base_id referenced by this page of cattle,
    // not one query per cattle. For buyer view this relies on the
    // "bases_public_select_for_listed_cattle" RLS policy - a base is only
    // readable here if it belongs to a cattle that's actually listed.
    const baseIds = [...new Set(data.map((row) => row.base_id).filter(Boolean))];
    let baseLocationById = {};
    let baseRadiusById = {};
    if (baseIds.length) {
      const { data: baseRows, error: baseError } = await supabase
        .from('cattle_bases')
        .select('id, location, geofence_radius_m')
        .in('id', baseIds);
      if (baseError) {
        console.error('[FullMapModal] cattle_bases fetch failed:', baseError.message, baseError.details, baseError.hint, baseError.code);
      } else if (baseRows) {
        baseLocationById = Object.fromEntries(
          baseRows.map((b) => [b.id, parseWkbPoint(b.location)])
        );
        // NEW: was only fetching location before, so a base-linked animal
        // with no geofence of its own got a pin (via displayPosition's
        // baseLocation fallback below) but never a Circle - the Circle
        // render below only ever looked at the animal's OWN geofenceCenter,
        // and geofenceRadiusM had no base fallback at all (just a flat 1000
        // default). Fetching the base's own geofence_radius_m here closes
        // that gap.
        baseRadiusById = Object.fromEntries(
          baseRows.map((b) => [b.id, b.geofence_radius_m])
        );
      }
    }

    const mapped = data.map((row) => {
      // GPS "no fix" guard: the LoRa gateway ingestion script currently
      // writes live_location = POINT(0,0) even when its packet says
      // Fix Status: 0 / GPS State: NO FIX (confirmed live in the gateway
      // log - it overwrites the previous, valid live_location with
      // (0,0) instead of skipping the field). (0,0) - "Null Island", a
      // point in the Gulf of Guinea - is never a real farm location.
      // FIX: on an invalid reading, this used to fall straight through
      // to geofence/base location - which looks like "the animal is
      // back home" even when it's actually out grazing somewhere and
      // just lost its fix under tree cover, in a dip in the terrain,
      // etc. That's actively misleading, worse than just not updating
      // the pin. Now it falls back to THIS animal's own last known good
      // live position (from the previous render/cache) if one exists,
      // and only falls through to geofence/base if it never had a fix
      // at all. NOTE: this only smooths over the symptom on whatever
      // device is currently open - the real fix still belongs in the
      // gateway script (skip live_location entirely on NO FIX packets).
      const rawLiveLocation = isFarmerView ? parseWkbPoint(row.live_location) : null;
      const isValidFix =
        rawLiveLocation && (Math.abs(rawLiveLocation[0]) > 0.0001 || Math.abs(rawLiveLocation[1]) > 0.0001);
      // CHANGED: per farmer's explicit request, a live_location reading
      // is only ever used if it's from TODAY's calendar day - if the
      // most recent update on this row happened on a previous day, the
      // pin now falls back to Base (effectiveGeofenceCenter below)
      // instead of showing yesterday's (or older) position indefinitely.
      // Wanting the actual last-known spot from before today is what
      // the History picker (CattleDetailModal) is for now - not the pin.
      const isFromToday = row.updated_at ? localDateString(row.updated_at) === todayLocalDateString() : false;
      const lastKnownGoodLocation = isFromToday ? (previousCattleById[row.id]?.liveLocation || null) : null;
      const liveLocation = isFromToday ? (isValidFix ? rawLiveLocation : lastKnownGoodLocation) : null;
      // Farmer view: geofence_center_geojson is the confirmed-live helper
      // FUNCTION (returns real GeoJSON) - parsePoint() is correct here.
      // Buyer view: geofence_center is the RAW PostGIS geography column,
      // which PostgREST returns as WKB hex, not GeoJSON - this was
      // wrongly run through parsePoint() (expects .coordinates), which
      // silently returned null every time, so buyers never saw geofence
      // circles at all. Fixed to use parseWkbPoint(), same as
      // MapPreviewCard.jsx's already-working buyer-view handling.
      const geofenceCenter = isFarmerView
        ? parsePoint(row.geofence_center_geojson)
        : parseWkbPoint(row.geofence_center);
      const baseLocation = row.base_id ? baseLocationById[row.base_id] || null : null;
      const baseRadius = row.base_id ? baseRadiusById[row.base_id] || null : null;
      // Effective geofence: animal's own center/radius if it has one,
      // otherwise inherited from its linked Base - read-time fallback only
      // (same COALESCE-at-read-time principle as the cattle_with_effective_
      // geofence DB view used elsewhere; not duplicated here as-is because
      // this file's farmer/buyer split already reads from two different
      // tables/views, cattle vs cattle_public_view, so a single DB view
      // over `cattle` wouldn't cover the buyer branch anyway).
      const effectiveGeofenceCenter = geofenceCenter || baseLocation;
      const effectiveGeofenceRadiusM = geofenceCenter
        ? (row.geofence_radius_m || 1000)
        : (baseRadius || 1000);
      // Distance from base/geofence-center to the animal's live GPS fix,
      // and which alert tier (1/2/3) that distance currently falls in -
      // drives the zone-colored dots line rendered below (replaces the
      // old static public-geofence Circle for farmer view). Buyer view
      // never has liveLocation, so this is always null for them.
      const distanceFromBaseM = isFarmerView
        ? haversineMeters(effectiveGeofenceCenter, liveLocation)
        : null;
      const currentZone = isFarmerView
        ? getCurrentZone(distanceFromBaseM, row.alert_radius_1_m, row.alert_radius_2_m, row.alert_radius_3_m)
        : null;
      return {
        id: row.id,
        ownerId: row.owner_id,
        name: row.name,
        animalType: row.animal_type,
        localImageUri: isFarmerView ? row.local_image_path : null,
        marketplacePhotoUrl: row.marketplace_photo_url,
        salePriceMin: row.sale_price_min,
        salePriceMax: row.sale_price_max,
        collarId: row.collar_id,
        breed: row.breed,
        govtInaphId: row.govt_inaph_id,
        birthDate: row.birth_date,
        weightKg: row.weight_kg,
        calvingCount: row.calving_count,
        contactPhone: row.contact_phone,
        contactWhatsapp: row.contact_whatsapp,
        qcCertificateUrl: row.qc_certificate_url,
        isListedForSale: row.is_listed_for_sale,
        // BUG FIX: row.base_id was already being fetched above (used
        // internally for the baseLocationById/baseRadiusById lookup a few
        // lines up) but was never included in this returned object. Any
        // caller reading cattle.baseId - EditCattleModal via CattleCard,
        // when opened from the full map screen - saw undefined every
        // time, so a previously-picked Base never stuck on reopen; it
        // always looked unset ("No base") regardless of what was saved.
        baseId: row.base_id,
        baseLocation,
        // now selected for buyer-view rows too (see CATTLE_BUYER_COLUMNS
        // above) - CattleMarker already render the
        // badge whenever this is truthy, so no marker-side change needed.
        breedingReady: row.is_breeding_ready,
        // read-only: geofence was set in AddCattleForm (or inherited from
        // a linked Base - see effectiveGeofenceCenter/Radius above), we
        // only display it. Used directly by the Circle render below, so a
        // base-linked animal with no geofence of its own now draws a
        // circle at the Base's location/radius instead of no circle at all.
        geofenceCenter: effectiveGeofenceCenter,
        geofenceRadiusM: effectiveGeofenceRadiusM,
        // Whether this animal's position is genuinely just "inherited
        // from its Base" (no live GPS, no geofence of its own) - used by
        // markerCattleList's clustering below so an animal with a real
        // live position never gets swallowed into its Base's cluster
        // just because it shares a baseId with another animal that IS
        // relying on base fallback. See FIX comment there for the bug
        // this was causing (Chunni's live pin vanishing into a cluster
        // with Baccha, who has no fix, whenever they both loaded).
        usesBaseFallback: !liveLocation && !geofenceCenter && Boolean(baseLocation),
        // Alert tiers are owner-only/private (never selected on the buyer
        // branch above), so these are undefined for buyer-view rows -
        // CattleCard's Zones button is farmer-only anyway, so that's fine.
        alertRadius1M: row.alert_radius_1_m,
        alertRadius2M: row.alert_radius_2_m,
        alertRadius3M: row.alert_radius_3_m,
        // Farmers: live GPS first (real-time tracking is theirs only -
        // never shown to buyers), then geofence, then base location.
        // Buyers: geofence first, then base location - live position is
        // never sent to/used for buyer view at all, by design.
        displayPosition: isFarmerView && liveLocation
          ? liveLocation
          : effectiveGeofenceCenter,
        // Kept separately from displayPosition (which buyer view also
        // uses) so the dots-line render below has an explicit "is there
        // an actual live GPS fix" check instead of reading displayPosition
        // and hoping it's the live one and not the geofence fallback.
        liveLocation: isFarmerView ? liveLocation : null,
        distanceFromBaseM,
        currentZone,
        // Farmer-view-only in CattleDetailModal (last-seen timestamp +
        // location name) - not selected at all in CATTLE_BUYER_COLUMNS
        // above, so these are naturally undefined for buyer rows.
        updatedAt: row.updated_at,
        placeName: row.place_name,
      };
    });

    // NOTE: de-overlap/jitter for same-position pins (e.g. multiple
    // animals sharing one Cattle Base's location) is deliberately NOT
    // done here. This function's output gets persisted verbatim to
    // offlineCache (see loadAll below) and cache-first render restores
    // it directly - baking a jitter in here would only apply to rows
    // that pass through a fresh fetch, while cache-first renders (the
    // very first paint, every load) would keep showing old, un-jittered
    // cached copies, since delta-sync doesn't re-fetch unchanged rows.
    // De-overlap is done at render time instead, from the canonical
    // position, in markerCattleList below - see that comment for why.
    return mapped;
  }, [isFarmerView]);

  const loadFields = useCallback(async (sinceIso, userId) => {
    // SECURITY: never allow an unscoped farmer field query.
    if (isFarmerView && !userId) {
      console.warn('[FullMapModal] Farmer fields fetch blocked: no authenticated user');
      return [];
    }

    // Farmer sees their own boundaries; buyer view sees only fields
    // marked public (is_public synced true whenever a crop on that
    // field is listed - see sync_field_public_flag trigger).
    // owner_id added to the select below - it was missing entirely, so
    // FieldDetailModal's field.owner_id fallback was always undefined
    // (same bug pattern already found/fixed for cattle's owner_id gap).
    // is_public added to the select below - it was already used in the
    // buyer-view .eq('is_public', true) filter a few lines down, but never
    // actually selected, so a farmer viewing their OWN fields had no way to
    // tell which of them were currently public/listed (e.g. for lease/rent)
    // - the new "Listed Only" filter toggle needs this on the row.
    let fieldsQuery = supabase.from('fields').select('id, owner_id, name, boundary_geojson, updated_at, soil_n, soil_p, soil_k, soil_ph, is_organic, is_public');
    // CRITICAL: same leak class as loadCattle above - fields_public_select
    // (is_public = true, no owner check) means an unscoped farmer-view
    // query pulls in every other farmer's public fields too. Scope
    // explicitly instead of relying on RLS alone.
    if (isFarmerView && userId) fieldsQuery = fieldsQuery.eq('owner_id', userId);
    if (!isFarmerView) fieldsQuery = fieldsQuery.eq('is_public', true);
    if (sinceIso) fieldsQuery = fieldsQuery.gte('updated_at', sinceIso);
    const { data: fieldRows, error } = await fieldsQuery;
    if (error || !fieldRows) return [];

    const fieldIds = fieldRows.map((f) => f.id);
    let cropInfoByField = {};
    if (fieldIds.length > 0) {
      // photo_url is dead/legacy (null on real rows) - image_url is the
      // live Storage URL column, same bug pattern already fixed in
      // MapPreviewCard.jsx.
      const { data: cropRows } = await supabase
        .from('crops_marketplace')
        .select('field_id, image_url, status, qc_certificate_url, harvest_date')
        .in('field_id', fieldIds)
        .neq('status', 'harvested');

      (cropRows || []).forEach((c) => {
        const existing = cropInfoByField[c.field_id] || {
          photoUrl: null,
          qcVerified: false,
          stage: 'upcoming',
        };

        // Only recompute the harvest_date-based stage when this crop's
        // QC-cert value has actually changed since we last saw it
        // (including the very first time we see it). Otherwise carry
        // forward whatever stage we already settled on, so re-fetches
        // (delta sync, pan/zoom refresh) don't silently flip a field's
        // stage on their own.
        // NOTE (known limitation): this only fires when this crop row
        // is actually part of the current fetch. Delta syncs scope
        // fieldIds by the FIELD row's own updated_at, not the crop
        // row's - so a QC-cert update that doesn't also touch the
        // parent field row may not surface here until the next full
        // reload. Flagging rather than silently assuming full coverage.
        const prevTracked = cropStageRef.current[c.field_id];
        const qcChanged = !prevTracked || prevTracked.qcCertificateUrl !== c.qc_certificate_url;
        const stage = qcChanged ? stageFromHarvestDate(c.harvest_date) : prevTracked.stage;
        cropStageRef.current[c.field_id] = { qcCertificateUrl: c.qc_certificate_url, stage };

        cropInfoByField[c.field_id] = {
          photoUrl: existing.photoUrl || c.image_url,
          qcVerified: existing.qcVerified || !!c.qc_certificate_url,
          stage,
        };
      });
    }

    return fieldRows
      .map((f) => {
        const positions = parsePolygon(f.boundary_geojson);
        const cropInfo = cropInfoByField[f.id] || {
          photoUrl: null,
          qcVerified: false,
          stage: 'upcoming',
        };
        return {
          id: f.id,
          owner_id: f.owner_id,
          name: f.name,
          positions,
          centroid: polygonCentroid(positions),
          currentCropPhotoUrl: cropInfo.photoUrl,
          qcVerified: cropInfo.qcVerified,
          stage: cropInfo.stage,
          // FIX: is_organic was selected nowhere in this query and never
          // mapped here, so every field object's organic status was
          // always undefined - the "Organic Only" filter toggle below
          // had nothing real to check against (see filteredFieldList
          // fix), and FieldMarker.jsx's own organic leaf badge silently
          // never showed either, for the same reason (its
          // `field.isOrganic ?? field.is_organic ?? false` fallback
          // always landed on false). Mapped to isOrganic (camelCase),
          // matching every other field on this object.
          isOrganic: f.is_organic,
          // Field-level "listed" flag (e.g. farmer put the field up for
          // lease/rent) - independent of is_organic and independent of
          // whether any crop is currently planted on it. Mapped to
          // isListed (camelCase) matching isOrganic's naming above.
          isListed: f.is_public,
          soil_n: f.soil_n,
          soil_p: f.soil_p,
          soil_k: f.soil_k,
          soil_ph: f.soil_ph,
        };
      })
      .filter((f) => f.positions);
  }, [isFarmerView]);

  // Water sources were never fetched or rendered anywhere in this file -
  // confirmed by inspection, not a regression. Farmer view sees their own
  // (owner_id-scoped, matching the pattern every other farmer query here
  // uses); buyer/public view only sees ones explicitly marked public,
  // mirroring fields' is_public gate. Kept as a plain fetch (not folded
  // into offlineCache/delta-sync like cattle/fields above) since this is a
  // much lower-churn dataset - simplest correct fix for "not shown at all".
  const loadWaterSources = useCallback(async (userId) => {
    let query = supabase
      .from('water_sources')
      .select('id, field_id, owner_id, location, depth_m, is_public_water_point');
    if (isFarmerView && userId) {
      query = query.eq('owner_id', userId);
    } else {
      query = query.eq('is_public_water_point', true);
    }
    const { data, error } = await query;
    if (error || !data) {
      if (error) console.error('[FullMapModal] water_sources fetch failed:', error.message, error.details, error.hint, error.code);
      return [];
    }
    return data
      .map((w) => ({
        id: w.id,
        fieldId: w.field_id,
        depthM: w.depth_m,
        isPublic: w.is_public_water_point,
        position: parseWkbPoint(w.location),
      }))
      .filter((w) => w.position);
  }, [isFarmerView]);

  // Services: unlike every other loader in this file, this is NOT split
  // by isFarmerView/owner_id - a farmer offering a service still needs
  // to see everyone ELSE's services too (they're a potential buyer of
  // services just as much as any other user), and a buyer needs to see
  // all of them regardless of their own farmer/buyer toggle. So this is
  // always the full table, same shape either way.
  const loadServices = useCallback(async () => {
    const { data, error } = await supabase
      .from('services')
      .select('id, owner_id, service_type, service_name, equipment_model, description, price_amount, price_unit, location, place_name, contact_phone, contact_whatsapp, youtube_url, instagram_url, facebook_url, show_contact_publicly, photo_url, is_available, users(full_name)');
    if (error || !data) {
      if (error) console.error('[FullMapModal] services fetch failed:', error.message, error.details, error.hint, error.code);
      return [];
    }
    return data
      .map((row) => ({
        id: row.id,
        ownerId: row.owner_id,
        ownerName: row.users?.full_name || null,
        serviceType: row.service_type,
        serviceName: row.service_name,
        equipmentModel: row.equipment_model,
        description: row.description,
        priceAmount: row.price_amount,
        priceUnit: row.price_unit,
        placeName: row.place_name,
        contactPhone: row.contact_phone,
        contactWhatsapp: row.contact_whatsapp,
        youtubeUrl: row.youtube_url,
        instagramUrl: row.instagram_url,
        facebookUrl: row.facebook_url,
        showContactPublicly: row.show_contact_publicly,
        photoUrl: row.photo_url,
        isAvailable: row.is_available,
        position: parseWkbPoint(row.location),
      }))
      .filter((s) => s.position);
  }, []);

  // Ponds: same public-visibility relationship as Fields/Crops -
  // farmer view sees their own ponds; buyer/public view sees only
  // ponds flagged is_public (synced true whenever any fish stock in
  // that pond is listed - see fix_pond_fish_visibility.sql's
  // sync_pond_public_flag trigger, same shape as fields' existing
  // sync_field_public_flag). Fish stock is fetched per-pond and
  // attached, same pattern loadFields uses for crops_marketplace -
  // a buyer only gets listed rows back at all (RLS
  // pond_fish_stock_public_select_listed), a farmer sees their own
  // full inventory.
  const loadPonds = useCallback(async (userId) => {
    let pondsQuery = supabase
      .from('ponds')
      .select('id, owner_id, pond_name, boundary_geojson, water_source, notes');
    if (isFarmerView && userId) {
      pondsQuery = pondsQuery.eq('owner_id', userId);
    } else {
      pondsQuery = pondsQuery.eq('is_public', true);
    }
    const { data: pondRows, error } = await pondsQuery;
    if (error || !pondRows) {
      if (error) console.error('[FullMapModal] ponds fetch failed:', error.message, error.details, error.hint, error.code);
      return [];
    }

    const pondIds = pondRows.map((p) => p.id);
    let fishByPond = {};
    if (pondIds.length > 0) {
      let fishQuery = supabase
        .from('pond_fish_stock')
        .select('id, pond_id, fish_species, quantity, average_weight_kg, is_listed_for_sale, price_per_kg')
        .in('pond_id', pondIds);
      if (!isFarmerView) fishQuery = fishQuery.eq('is_listed_for_sale', true);
      const { data: fishRows } = await fishQuery;
      (fishRows || []).forEach((f) => {
        if (!fishByPond[f.pond_id]) fishByPond[f.pond_id] = [];
        fishByPond[f.pond_id].push(f);
      });
    }

    return pondRows
      .map((p) => {
        const positions = parsePolygon(p.boundary_geojson);
        return {
          id: p.id,
          ownerId: p.owner_id,
          pondName: p.pond_name,
          waterSource: p.water_source,
          notes: p.notes,
          positions,
          centroid: polygonCentroid(positions),
          fishStock: fishByPond[p.id] || [],
        };
      })
      .filter((p) => p.positions);
  }, [isFarmerView]);

  const loadLikes = useCallback(async () => {
    // Cache-first so liked hearts still show offline.
    const cached = await offlineCache.getAll('likes');
    if (cached.length) {
      setLikedFieldIds(new Set(cached.filter((l) => l.item_type === 'field').map((l) => l.item_id)));
      setLikedCattleIds(new Set(cached.filter((l) => l.item_type === 'cattle').map((l) => l.item_id)));
      setLikedServiceIds(new Set(cached.filter((l) => l.item_type === 'service').map((l) => l.item_id)));
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from('likes').select('item_type, item_id').eq('user_id', user.id);
    if (!data) return;
    setLikedFieldIds(new Set(data.filter((l) => l.item_type === 'field').map((l) => l.item_id)));
    setLikedCattleIds(new Set(data.filter((l) => l.item_type === 'cattle').map((l) => l.item_id)));
    setLikedServiceIds(new Set(data.filter((l) => l.item_type === 'service').map((l) => l.item_id)));
    // likes are keyed (user_id, item_type, item_id) with no single id column -
    // give each cached row a synthetic id so offlineCache (keyPath 'id') works.
    offlineCache.putAll('likes', data.map((l) => ({ ...l, id: `${l.item_type}:${l.item_id}` })));
  }, []);

  const toggleLike = useCallback(async (itemType, itemId) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const idSet = itemType === 'field' ? likedFieldIds : itemType === 'service' ? likedServiceIds : likedCattleIds;
    const setter = itemType === 'field' ? setLikedFieldIds : itemType === 'service' ? setLikedServiceIds : setLikedCattleIds;
    const alreadyLiked = idSet.has(itemId);

    if (alreadyLiked) {
      await supabase.from('likes').delete()
        .eq('user_id', user.id).eq('item_type', itemType).eq('item_id', itemId);
      setter((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
    } else {
      await supabase.from('likes').upsert(
        { user_id: user.id, item_type: itemType, item_id: itemId },
        { onConflict: 'user_id,item_type,item_id' }
      );
      setter((prev) => new Set(prev).add(itemId));
      offlineCache.putAll('likes', [{ id: `${itemType}:${itemId}`, item_type: itemType, item_id: itemId }]);
    }
  }, [likedFieldIds, likedCattleIds, likedServiceIds]);

  const handleToggleFieldLike = useCallback((field) => toggleLike('field', field.id), [toggleLike]);
  const handleToggleCattleLike = useCallback((cattle) => toggleLike('cattle', cattle.id), [toggleLike]);
  const handleToggleServiceLike = useCallback((service) => toggleLike('service', service.id), [toggleLike]);


  // Tracks which view mode the last COMPLETED loadAll ran under, so a
  // real Farmer<->Buyer toggle can be told apart from a normal re-render.
  // Delta sync (below) can only see rows a query still returns - it has
  // no way to tell "this row no longer matches the current view's filter"
  // (e.g. a cattle just unlisted, so cattle_public_view stops returning
  // it for buyers) apart from a row that simply was never fetched. A
  // toggle forces a full (non-delta) resync instead, so whatever the
  // server says right now fully replaces what's rendered for this view -
  // a just-unlisted animal's stale pin can't survive a view switch on
  // this device. NOTE: this only fixes staleness on THIS device. A
  // different buyer's device that already cached the pin before it was
  // unlisted has no way to find out via delta sync either - same
  // structural gap offlineCache.js's remove() comment already flags for
  // hard deletes, not addressed here.
  const prevViewModeRef = useRef(isFarmerView);

  useEffect(() => {
    let cancelled = false;
    const syncKey = `lastSync_${isFarmerView ? 'farmer' : 'buyer'}`;
    const viewJustToggled = prevViewModeRef.current !== isFarmerView;
    prevViewModeRef.current = isFarmerView;

    async function loadAll() {
      // SECURITY: authenticate BEFORE rendering cached map data.
      // This prevents another farmer's cached cattle from appearing
      // while the Supabase session is still being hydrated.
      const { data: { user } } = await supabase.auth.getUser();

      if (cancelled) return;

      if (isFarmerView && !user) {
        console.warn('[FullMapModal] Farmer map blocked: no authenticated user');
        setCattleList([]);
        setFieldList([]);
        return;
      }

      // 1. Cache-first, but farmer cache is explicitly owner-scoped.
      const [cachedCattleRaw, cachedFieldsRaw] = await Promise.all([
        offlineCache.getAll('cattle'),
        offlineCache.getAll('fields'),
      ]);

      // FIX: cachedCattleRaw rows are loadCattle()'s MAPPED output
      // (camelCase `ownerId`, set at `ownerId: row.owner_id` in
      // loadCattle) - not raw DB rows. Filtering on `row.owner_id` here
      // was always false (that key never existed on the cached shape),
      // so cachedCattle was ALWAYS [] for farmer view. Consequence: once
      // lastSync existed (i.e. every reopen after the very first sync),
      // `offlineCache.mergeById(cachedCattle, deltaCattle)` had nothing
      // to carry forward from - only animals present in THIS delta (a
      // fresh GPS fix / any field update since lastSync) survived into
      // cattleList; any animal that hadn't sent a new update vanished
      // entirely instead of staying at its last known position. Fixed to
      // match the actual cached key.
      // FIX: cache-first render for buyer view had NO filter at all -
      // cachedCattleRaw comes from a single shared offlineCache 'cattle'
      // store used by BOTH farmer and buyer branches. If this device was
      // ever used in farmer view, that farmer's own (possibly unlisted,
      // full-column) cattle rows sit in this same cache. Buyer view must
      // filter them out here too, same as the live query's
      // is_listed_for_sale filter, or an unlisted animal flashes/persists
      // on the buyer map during cache-first render before the background
      // delta sync (if it even succeeds) corrects it.
      // FIX: applyTodayGate() was defined (see its comment above) but
      // never actually CALLED anywhere - cache-first render used the
      // raw cached rows as-is. A cached row's liveLocation/displayPosition
      // was correctly gated at the moment it was WRITTEN to cache (back
      // when "today" meant that day), but nothing re-checked it on
      // read. An animal with no fresh ping since a previous day's
      // gating never reappears in a delta fetch (its updated_at hasn't
      // moved), so mergeById has nothing to correct it with and the
      // stale pre-midnight position renders forever. Re-applying the
      // gate here (cheap, pure JS, idempotent per its own comment) is
      // the actual fix.
      const cachedCattle = applyTodayGate(
        isFarmerView
          ? cachedCattleRaw.filter((row) => row.ownerId === user.id)
          : cachedCattleRaw.filter((row) => row.isListedForSale)
      );

      const cachedFields = isFarmerView
        ? cachedFieldsRaw.filter((row) => row.owner_id === user.id)
        : cachedFieldsRaw;
      if (cancelled) return;
      if (cachedCattle.length) setCattleList(cachedCattle);
      if (cachedFields.length) setFieldList(cachedFields);
      // GUARD: only snap the viewport on the very first real center this
      // modal session ever establishes. Without this guard, EVERY
      // cache-first render (every reopen, every isFarmerView toggle, every
      // background sync completing) was unconditionally recentering to
      // cachedCattle[0] - an arbitrary cattle, not necessarily the one the
      // farmer is currently looking at. Because filteredCattleList hides
      // any pin farther than filters.radiusKm from viewportCenter, that
      // unguarded recenter would silently push an already-visible,
      // correctly-positioned cattle pin outside the radius and make it
      // vanish - even though its GPS data was still fresh and correct.
      // hasRealCenterRef is the same flag the geolocation-fallback effect
      // below already respects; it just wasn't being checked here too.
      if (
        !hasRealCenterRef.current &&
        (cachedCattle[0]?.displayPosition || cachedFields[0]?.centroid)
      ) {
        const cachedCenter = cachedCattle[0]?.displayPosition || cachedFields[0]?.centroid;
        recenterMapTo(cachedCenter);
      }

      // 2. Background delta sync - only rows changed since the last
      // successful sync. If this fails (no network), the cache we
      // already rendered above just stays as-is - no error shown.
      // viewJustToggled forces this to be a full resync (see
      // prevViewModeRef comment above) instead of a delta merge.
      try {
        const lastSync = viewJustToggled ? null : await offlineCache.getMeta(syncKey);
        // FIX: buyer's cattle query is always fully server-filtered by
        // is_listed_for_sale=true, so a delta-since-lastSync fetch can
        // silently miss an unlist (row's updated_at changed, but it now
        // fails the filter, so it's just absent from the delta) -
        // mergeById only adds/updates, so it has no way to know that
        // absence means "remove this", and the stale listed=true cached
        // row survives forever. Buyer cattle sync is therefore always a
        // full fetch + full replace, never delta+merge. Fields aren't
        // gated by a mutable boolean the same way, so fields keep the
        // existing delta+merge behavior for both views.
        const cattleLastSync = isFarmerView ? lastSync : null;
        const previousCattleById = Object.fromEntries(cachedCattle.map((c) => [c.id, c]));
        const [deltaCattle, deltaFields] = await Promise.all([
          loadCattle(cattleLastSync || undefined, user?.id, previousCattleById),
          loadFields(lastSync || undefined, user?.id),
        ]);
        if (cancelled) return;

        // FIX (same gap as cachedCattle above): deltaCattle rows are
        // already correctly gated by loadCattle() itself, but any row
        // carried forward unchanged from cachedCattle via mergeById is
        // not re-checked - re-apply the gate to the merged result too,
        // so a midnight rollover self-heals on the very next sync
        // instead of needing a fresh ping from that specific animal.
        const mergedCattle = applyTodayGate(
          cattleLastSync ? offlineCache.mergeById(cachedCattle, deltaCattle) : deltaCattle
        );
        const mergedFields = lastSync ? offlineCache.mergeById(cachedFields, deltaFields) : deltaFields;

        setCattleList(mergedCattle);
        setFieldList(mergedFields);
        offlineCache.putAll('cattle', mergedCattle);
        offlineCache.putAll('fields', mergedFields);
        offlineCache.setMeta(syncKey, new Date().toISOString());

        if (!lastSync) {
          const realCenter = mergedCattle[0]?.displayPosition || mergedFields[0]?.centroid;
          if (realCenter) {
            // Real pin data - recenter the actual map, not just state.
            recenterMapTo(realCenter);
          } else {
            // No real pins yet - just seed the state with DEFAULT_CENTER
            // (map is already there on initial mount) without marking
            // hasRealCenterRef, so the geolocation fallback below still
            // gets a chance to recenter once it resolves.
            setCenter(DEFAULT_CENTER);
            setViewportCenter(DEFAULT_CENTER);
          }
        } else {
          // Not the first-ever sync, but the delta may still contain rows
          // that are genuinely new (a Base/Field added since the account
          // was last used) rather than just updates to rows we already
          // had cached. Recenter to the first such new pin - this is the
          // actual fix for "map shows empty / stuck on Hyderabad": before
          // this, center/viewportCenter only ever moved on the very first
          // sync an account ever did, so new data added later in a
          // different district rendered correctly but stayed off-screen.
          const cachedCattleIds = new Set(cachedCattle.map((c) => c.id));
          const cachedFieldIds = new Set(cachedFields.map((f) => f.id));
          const newCattle = deltaCattle.find(
            (c) => !cachedCattleIds.has(c.id) && c.displayPosition
          );
          const newField = deltaFields.find(
            (f) => !cachedFieldIds.has(f.id) && f.centroid
          );
          const newPin = newCattle?.displayPosition || newField?.centroid;
          if (newPin) {
            recenterMapTo(newPin);
          }
        }

        loadLikes();

        loadWaterSources(user?.id).then((rows) => {
          if (!cancelled) setWaterSources(rows);
        });

        loadServices().then((rows) => {
          if (!cancelled) setServicesList(rows);
        });

        loadPonds(user?.id).then((rows) => {
          if (!cancelled) setPondsList(rows);
        });
      } catch (err) {
        console.warn('[KisanBit] background sync failed, staying on cached data:', err);
      }
    }

    loadAll();
    return () => {
      cancelled = true;
    };
  }, [loadCattle, loadFields, loadWaterSources, loadServices, loadPonds, loadLikes, isFarmerView]);

  // Historical GPS trail per animal, fetched via the shared
  // fetchCattleTrail() helper (utils/cattleTrail.js) - the exact same
  // function MapPreviewCard.jsx uses, so both draw the identical trail.
  // Deliberately keyed off the STABLE list of cattle ids (not the full
  // cattleList, which changes on every live GPS delta-sync/pan-refresh
  // above) - refetching trail history on every ping would be wasteful
  // and pointless, since history only grows once every ~15 minutes
  // (collar telemetry cadence). Runs on mount and every 60s, farmer
  // view only (buyers have no live tracking, same guard the old
  // loadTrails() had).
  //
  // CHANGED: scoped to today's CALENDAR day (date: todayLocalDateString())
  // instead of the rolling-24h default - per farmer's explicit request,
  // this default/always-on trail should visibly reset at midnight, not
  // keep showing yesterday evening's dots into this afternoon just
  // because they're still within a rolling 24h window. todayLocalDateString()
  // is re-evaluated on every loadTrails() call (this effect + its own
  // 60s interval below), so the moment midnight passes, the very next
  // tick picks up the new date and the trail empties out until today's
  // first real fix arrives - no extra reset logic needed. The History
  // picker inside CattleDetailModal is unaffected - it already passes
  // its own explicit historyDate through the same `date` param.
  const cattleIdsKey = isFarmerView ? cattleList.map((c) => c.id).join(',') : '';

  useEffect(() => {
    if (!isFarmerView || !cattleIdsKey) return;
    const ids = cattleIdsKey.split(',').filter(Boolean);
    let cancelled = false;

    const loadTrails = async () => {
      const entries = await Promise.all(
        ids.map(async (id) => [id, await fetchCattleTrail(supabase, id, { date: todayLocalDateString() })])
      );
      if (!cancelled) {
        setTrailsByCattleId(Object.fromEntries(entries));
      }
    };

    loadTrails();
    const intervalId = setInterval(loadTrails, 60000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [isFarmerView, cattleIdsKey]);

  // Device-GPS fallback: previously center/viewportCenter only ever came
  // from cattle/field pin data, defaulting straight to the hardcoded
  // DEFAULT_CENTER (Hyderabad) for any farmer with zero cattle/field
  // locations yet - confirmed by user, same gap as MapPreviewCard.jsx had.
  // Asks the device for its real position once on mount as a last resort,
  // and only applies it if loadAll above hasn't already established a
  // real pin-based center by the time it resolves (checked via
  // hasRealCenterRef, not state, to avoid a stale-closure race). Uses the
  // live map instance (mapRef, populated by MapMoveWatcher) via setView()
  // rather than the center/viewportCenter state, since MapContainer's
  // `center` prop only applies at initial mount in react-leaflet - just
  // updating that state wouldn't move an already-rendered map.
  useEffect(() => {
    if (!navigator.geolocation) return;
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled || hasRealCenterRef.current) return;
        const gpsCenter = [pos.coords.latitude, pos.coords.longitude];
        recenterMapTo(gpsCenter);
      },
      () => {
        // Permission denied / unavailable / timed out - stay on whatever
        // loadAll already rendered (real pin center or DEFAULT_CENTER).
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Tracks the last viewport that actually triggered a cattle delta-sync
  // (not just the last viewport reported by MapMoveWatcher) - compared
  // against the incoming one via viewportChangedSignificantly() so a
  // tiny nudge doesn't fire a fresh sync. A ref, not state: it's only
  // ever read/written inside this callback, never during render.
  const lastSyncedViewportRef = useRef(null);

  // Debounced pan/zoom refresh - lighter than the initial load (skips
  // trails/photos, just re-syncs cattle pin positions). Bounding-box
  // filtering happens client-side for now; at scale this select() should
  // be swapped for a PostGIS RPC (e.g. get_pins_in_bounds(...)) so we're
  // not pulling every row on every pan.
  //
  // `fields` is deliberately NOT re-synced here anymore. Field
  // boundaries/geofences change far less often than cattle GPS (only on
  // an explicit Add/Edit Field save), so re-fetching them on every pan
  // was pure waste - a preflight+fetch pair the map almost never actually
  // needed. Fields now only sync on initial mount / farmer<->buyer toggle
  // (loadAll below) and on an explicit field-saved event (see the
  // 'kisanbit:field-saved' listener further down).
  const handleViewportSettled = useCallback(
    async (info) => {
      setViewportCenter(info.center);

      // Keep clustering synchronized with the actual Leaflet zoom.
      if (Number.isFinite(info.zoom)) {
        setMapZoom(info.zoom);
      }

      // Skip the cattle delta-sync entirely if this pan/zoom didn't move
      // the viewport enough to matter (see viewportChangedSignificantly
      // above) - avoids firing a preflight+fetch pair for a few-meter
      // nudge. setViewportCenter/setMapZoom above still run regardless,
      // so filtering/clustering stay visually responsive either way.
      if (!viewportChangedSignificantly(lastSyncedViewportRef.current, info)) {
        return;
      }
      lastSyncedViewportRef.current = info;

      const syncKey = `lastSync_${isFarmerView ? 'farmer' : 'buyer'}`;
      try {
        const { data: { user } } = await supabase.auth.getUser();

        if (isFarmerView && !user) {
          console.warn('[FullMapModal] Farmer viewport sync blocked: no authenticated user');
          return;
        }

        const lastSync = await offlineCache.getMeta(syncKey);
        // FIX: same buyer-unlist-never-removed bug as loadAll above -
        // buyer's is_listed_for_sale=true filter means a delta fetch can
        // miss an unlist entirely, and mergeById can't remove what it
        // never saw. Buyer pan/zoom sync is always full fetch + replace.
        const cattleLastSync = isFarmerView ? lastSync : null;
        const previousCattleById = Object.fromEntries(cattleListRef.current.map((c) => [c.id, c]));
        const deltaCattle = await loadCattle(cattleLastSync || undefined, user?.id, previousCattleById);
        setCattleList((prev) => {
          // FIX: same today-gate gap as loadAll's cachedCattle/mergedCattle
          // above - `prev` here can hold cattle carried forward unchanged
          // since before midnight, so re-apply the gate after merging.
          const merged = applyTodayGate(
            cattleLastSync ? offlineCache.mergeById(prev, deltaCattle) : deltaCattle
          );
          offlineCache.putAll('cattle', merged);
          return merged;
        });
        offlineCache.setMeta(syncKey, new Date().toISOString());
      } catch (err) {
        // Offline / request failed - keep showing what's already on screen.
        console.warn('[KisanBit] viewport sync failed, staying on cached data:', err);
      }
    },
    [loadCattle, isFarmerView]
  );

  // Fields are otherwise only re-fetched on initial mount / farmer<->buyer
  // toggle (loadAll below), not on pan/zoom (see handleViewportSettled's
  // comment above). This listens for a 'kisanbit:field-saved' custom
  // event so a field Add/Edit made WHILE this map modal is already open
  // still shows up, instead of requiring a full close/reopen or a
  // farmer<->buyer toggle to pick it up.
  //
  // NOTE: this only wires the LISTENING side. The matching
  // `window.dispatchEvent(new CustomEvent('kisanbit:field-saved'))` still
  // needs to be added wherever a field Add/Edit actually succeeds (likely
  // AddFieldForm.jsx) - not added here since that file wasn't part of
  // this fix and shouldn't be blind-edited.
  useEffect(() => {
    async function handleFieldSaved() {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (isFarmerView && !user) return;
        const syncKey = `lastSync_${isFarmerView ? 'farmer' : 'buyer'}`;
        const lastSync = await offlineCache.getMeta(syncKey);
        const deltaFields = await loadFields(lastSync || undefined, user?.id);
        setFieldList((prev) => {
          const merged = lastSync ? offlineCache.mergeById(prev, deltaFields) : deltaFields;
          offlineCache.putAll('fields', merged);
          return merged;
        });
        offlineCache.setMeta(syncKey, new Date().toISOString());
      } catch (err) {
        console.warn('[KisanBit] field-saved resync failed:', err);
      }
    }
    window.addEventListener('kisanbit:field-saved', handleFieldSaved);
    return () => window.removeEventListener('kisanbit:field-saved', handleFieldSaved);
  }, [loadFields, isFarmerView]);

  // -------------------------------------------------------------------
  // Live GPS push - farmer view only, via Supabase Realtime.
  //
  // FARMER-VIEW ONLY, DELIBERATELY: postgres_changes pushes the FULL row
  // (every column) to any client whose RLS lets it see that row at all -
  // it has no way to restrict the payload to the same column subset
  // CATTLE_BUYER_COLUMNS enforces on a normal select(). live_location is
  // explicitly never sent to buyers by design (see loadCattle's
  // displayPosition comment - buyers only ever get geofence/base
  // fallback, never the real-time fix). A buyer's RLS already lets them
  // see their own listed-cattle rows (public_select_listed_cattle
  // policy), so subscribing them here would leak live_location straight
  // past that restriction. Buyer view keeps getting cattle refreshes the
  // existing way (pan/zoom past the 12% threshold, or a fresh mount) -
  // that's fine for buyers since a listed animal's geofence/base
  // location barely changes anyway.
  //
  // Only patches the fields a GPS ping can actually change (liveLocation,
  // displayPosition, distanceFromBaseM, currentZone, updatedAt,
  // placeName) - mirrors the same NO-FIX / Null-Island guard and
  // zone-distance math loadCattle uses, just applied to one incoming row
  // instead of a full re-fetch. A row not already in cattleList (brand
  // new cattle) is left alone here - it needs loadCattle's full mapping
  // (base-location fallback, baseId lookup, etc.), which the next pan or
  // remount will pick up; no INSERT handling here on purpose.
  useEffect(() => {
    if (!isFarmerView) return;
    let channel;
    let cancelled = false;

    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled || !user) return;

      // FIX: same bug/fix as HomeScreen.jsx's realtime channel - this was
      // a stable per-user name (`cattle-live-${user.id}`) with no
      // per-mount suffix. React StrictMode mounts -> cleans up ->
      // re-mounts every component once in dev; removeChannel() on
      // cleanup tears down the websocket subscription asynchronously, so
      // the re-mount's supabase.channel(...) call could land before that
      // finished, get back the same already-subscribed channel object
      // from supabase-js's internal registry, and crash on .subscribe()
      // with "cannot add postgres_changes callbacks ... after
      // subscribe()" - silently breaking live GPS push until the modal
      // was closed and reopened (a fresh mount, which is exactly why
      // "close and reopen the map" looked like it fixed it). Appended a
      // random suffix per mount, matching HomeScreen.jsx and
      // CattleInfoPanel.jsx/FieldInfoPanel.jsx/IoTDevicesPanel.jsx/
      // PondsPanel.jsx, which already do this correctly.
      channel = supabase
        .channel(`cattle-live-${user.id}-${Math.random().toString(36).slice(2)}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'cattle', filter: `owner_id=eq.${user.id}` },
          (payload) => {
            const row = payload.new;
            if (!row) return;

            setCattleList((prev) => {
              const idx = prev.findIndex((c) => c.id === row.id);
              if (idx === -1) return prev;

              const existing = prev[idx];
              const rawLiveLocation = parseWkbPoint(row.live_location);
              const isValidFix =
                rawLiveLocation && (Math.abs(rawLiveLocation[0]) > 0.0001 || Math.abs(rawLiveLocation[1]) > 0.0001);
              // Same calendar-day gating as loadCattle above - this push
              // itself is always "now" (today), but the NO-FIX fallback
              // below (existing.liveLocation) could still be holding a
              // value from before midnight if this modal's been open
              // across the day boundary with no pan/zoom to re-trigger
              // loadCattle. Only trust it if it was ALSO from today.
              const isFromToday = row.updated_at ? localDateString(row.updated_at) === todayLocalDateString() : false;
              const existingIsFromToday = existing.updatedAt
                ? localDateString(existing.updatedAt) === todayLocalDateString()
                : false;
              const liveLocation = isFromToday
                ? (isValidFix ? rawLiveLocation : (existingIsFromToday ? existing.liveLocation : null))
                : null;
              const distanceFromBaseM = haversineMeters(existing.geofenceCenter, liveLocation);
              const currentZone = getCurrentZone(
                distanceFromBaseM,
                row.alert_radius_1_m,
                row.alert_radius_2_m,
                row.alert_radius_3_m
              );

              const updated = {
                ...existing,
                liveLocation,
                displayPosition: liveLocation || existing.geofenceCenter || existing.displayPosition,
                distanceFromBaseM,
                currentZone,
                updatedAt: row.updated_at,
                placeName: row.place_name,
              };

              const next = [...prev];
              next[idx] = updated;
              offlineCache.putAll('cattle', [updated]);
              return next;
            });
          }
        )
        .subscribe((status, err) => {
          // DEBUG: postgres_changes fails SILENTLY with no thrown error if
          // Realtime replication isn't enabled for the `cattle` table on
          // the Supabase dashboard (Database -> Replication) - the
          // channel just sits there never firing, no console noise at
          // all otherwise. This makes that failure visible: look for
          // 'SUBSCRIBED' in the console after opening the farmer map; if
          // it instead logs 'CHANNEL_ERROR', 'TIMED_OUT', or 'CLOSED',
          // that confirms it's a Supabase-side config issue, not this code.
          if (status === 'SUBSCRIBED') {
            console.log('[FullMapModal] cattle realtime connected');
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            console.warn('[FullMapModal] cattle realtime subscription problem:', status, err);
          }
        });
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [isFarmerView]);

  // -------------------------------------------------------------------
  // Buyer-view cattle poll - NOT realtime, on purpose.
  //
  // Buyers deliberately never get a postgres_changes subscription on
  // `cattle` (see the big comment above this effect) - live_location
  // would land in their browser even if unused, which is the exact leak
  // the is_listed_for_sale filter is meant to prevent. So an unlist that
  // happens while a buyer's map is already open and NOT being panned/
  // zoomed past the 12% threshold (see viewportChangedSignificantly)
  // never triggers handleViewportSettled's delta-sync, and the pin just
  // sits there until the modal is closed/reopened.
  //
  // This polls the SAME safe path handleViewportSettled already uses
  // (loadCattle against cattle_public_view, is_listed_for_sale=true
  // filter baked into the query) on a short interval while the buyer's
  // full map is open, so a listing change shows up live without ever
  // subscribing to the raw `cattle` table. Farmer view doesn't need this
  // - it already gets true realtime above.
  useEffect(() => {
    if (isFarmerView) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const syncKey = 'lastSync_buyer';
        // FIX: this poll's entire purpose (per the comment above) is to
        // catch an unlist happening while the buyer's map is open - but
        // delta+mergeById can never remove a row it never received, so a
        // delta-since-lastSync fetch made this poll a no-op for exactly
        // the case it exists for. Always full fetch + full replace here,
        // never delta+merge (same fix as loadAll/handleViewportSettled).
        const previousCattleById = Object.fromEntries(
          cattleListRef.current.map((c) => [c.id, c])
        );
        const deltaCattle = await loadCattle(undefined, undefined, previousCattleById);
        if (cancelled) return;
        setCattleList((prev) => {
          offlineCache.putAll('cattle', deltaCattle);
          return deltaCattle;
        });
        offlineCache.setMeta(syncKey, new Date().toISOString());
      } catch (err) {
        // Offline / request failed - keep showing what's already on
        // screen, same fallback handleViewportSettled uses.
        console.warn('[KisanBit] buyer cattle poll failed, staying on cached data:', err);
      }
    };

    const intervalId = setInterval(poll, 20000); // 20s - listing status rarely needs to be faster than this
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [isFarmerView, loadCattle]);

  // -------------------------------------------------------------------
  // Filters + search - applied client-side to already-fetched pins.
  // -------------------------------------------------------------------

  const handleApplyFilters = useCallback((next) => {
    setFilters(next);
    saveStoredFilters(next); // persist filter CHOICES only, never pin data
  }, []);

  const filteredCattleList = useMemo(() => {
    if (filters.category !== 'cattle') return [];
    return cattleList.filter((c) => {
      if (!c.displayPosition) return false;
      if (haversineKm(viewportCenter, c.displayPosition) > filters.radiusKm) return false;
      if (filters.likedOnly && !likedCattleIds.has(c.id)) return false;
      if (filters.breedReadyOnly && !c.breedingReady) return false;
      if (searchQuery && !c.name?.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [cattleList, filters.category, filters.radiusKm, filters.likedOnly, filters.breedReadyOnly, likedCattleIds, viewportCenter, searchQuery]);

  // ============================================================
  // ZOOM-AWARE CATTLE CLUSTERING
  // ============================================================
  //
  // Goal:
  //   zoomed out  -> nearby cattle appear as one numbered cluster
  //   zooming in  -> clusters progressively split
  //   maximum zoom -> even cattle at exactly the same Base coordinate
  //                  become individually tappable pins
  //
  // We intentionally do NOT modify the canonical cattle position.
  // Only the marker render position is changed.
  //
  // This works for BOTH farmer and buyer views because it operates on
  // filteredCattleList after all existing visibility/filter rules.

  // ============================================================
  // CATTLE BASE GROUPING
  // ============================================================
  //
  // CattleClusterMarker is NOT a database entity.
  // `baseId` comes from the cattle row. When 2+ cattle share the
  // same Cattle Base AND neither has its own live GPS/geofence
  // (i.e. both are genuinely just sitting at their Base's inherited
  // location), they are rendered as one cluster marker.
  //
  // Cattle without a base, OR cattle that share a base but have their
  // OWN live GPS or geofence, always stay individual CattleMarker pins.
  //
  // FIX: this used to group ANY 2+ cattle sharing a baseId, full stop -
  // so an animal with a perfectly good, real-time live GPS fix (e.g.
  // Chunni) got swallowed into a cluster pin at the Base's location the
  // moment a second animal sharing that base loaded into cattleList
  // (e.g. Baccha, who has no fix and is genuinely using base fallback).
  // That made Chunni's actual live pin flicker in and out of existence
  // depending on delta-sync timing - it rendered as its own pin only in
  // the split second before Baccha's row had loaded, then vanished into
  // an unlabeled cluster once both were present. Grouping now only
  // applies to animals that are THEMSELVES using base fallback
  // (usesBaseFallback, set in loadCattle above) - an animal with its own
  // position is never forced into a sibling's cluster.
  //
  // DISABLED (user request): grouping animals sharing a base-fallback
  // position into one numbered "N animals" cluster badge. Every cattle
  // now always renders as its own individual pin - when 2+ land on
  // (nearly) the same spot, the existing jitteredPins ring de-overlap
  // below (line ~1935, already built for exactly this - Base pin vs
  // cattle pin overlap) spreads them apart into separate, individually
  // tappable pins instead, matching the look the user wants (each
  // animal its own labeled pin, never a "2" badge you have to tap
  // through a picker sheet for).
  // ClusterPickerSheet/CattleClusterMarker and the isCluster branch
  // further down are now unreachable (no isCluster items are ever
  // produced) - left in place rather than removed, in case clustering
  // is wanted back later; they're inert either way.
  const markerCattleList = useMemo(() => {
    return filteredCattleList.filter((c) => c.displayPosition);
  }, [filteredCattleList]);

  // ADDED: one 🏠 per distinct Cattle Base actually referenced by the
  // farmer's cattle, same derivation MapPreviewCard.jsx uses (baseId +
  // baseLocation are already on each cattleList row - see loadCattle
  // above) - not filtered by search/category so the Base itself always
  // stays visible as a fixed reference point, even when its animals get
  // filtered out of view.
  // FIX: base pin used to ignore filters.category entirely ("not
  // filtered by search/category" per the original note above) - so the
  // 🏠 stayed on screen even when the user switched to Crops/Services/
  // Ponds, which reads as a stray cattle-related pin on an unrelated
  // category. Base is cattle-specific, so it now only renders when the
  // Cattle category is actually selected, same gate filteredCattleList
  // already uses.
  const baseMarkers = useMemo(() => {
    if (filters.category !== 'cattle') return [];
    const seen = new Map();
    cattleList.forEach((c) => {
      if (c.baseId && c.baseLocation && !seen.has(c.baseId)) {
        seen.set(c.baseId, c.baseLocation);
      }
    });
    return Array.from(seen.entries()).map(([baseId, position]) => ({ baseId, position }));
  }, [cattleList, filters.category]);

  // ADDED: de-overlap Base pins + Cattle/cluster pins that land on
  // (nearly) the same spot - same threshold/ring pattern MapPreviewCard.jsx
  // already uses for its own cattle-only jitter, extended here to also
  // include the new Base markers. An animal on base-fallback (no live
  // GPS, no geofence of its own - loadCattle's usesBaseFallback) renders
  // at EXACTLY its Base's coordinates, so its pin and the 🏠 Base pin
  // would otherwise stack pixel-for-pixel - and if another animal's real
  // live position happens to be close to home too, all three end up
  // fighting for the same spot with only the last-rendered one visible/
  // tappable. Spreads each overlapping group into a small ring instead.
  const jitteredPins = useMemo(() => {
    const OVERLAP_THRESHOLD_DEG = 0.0004; // ~40m at this latitude
    const RING_RADIUS_DEG = 0.0003;

    const items = [
      ...baseMarkers.map((b) => ({ kind: 'base', data: b, pos: b.position })),
      ...markerCattleList.map((c) => ({ kind: 'cattle', data: c, pos: c.displayPosition })),
    ].filter((item) => item.pos);

    const groups = [];
    items.forEach((item) => {
      const group = groups.find(
        (g) =>
          Math.abs(g.anchor[0] - item.pos[0]) < OVERLAP_THRESHOLD_DEG &&
          Math.abs(g.anchor[1] - item.pos[1]) < OVERLAP_THRESHOLD_DEG
      );
      if (group) {
        group.members.push(item);
      } else {
        groups.push({ anchor: item.pos, members: [item] });
      }
    });

    const result = [];
    groups.forEach((g) => {
      if (g.members.length === 1) {
        result.push({ ...g.members[0], renderPosition: g.members[0].pos });
        return;
      }
      g.members.forEach((item, i) => {
        const angle = (2 * Math.PI * i) / g.members.length;
        result.push({
          ...item,
          renderPosition: [
            g.anchor[0] + RING_RADIUS_DEG * Math.cos(angle),
            g.anchor[1] + RING_RADIUS_DEG * Math.sin(angle),
          ],
        });
      });
    });

    return result;
  }, [baseMarkers, markerCattleList]);

  const filteredFieldList = useMemo(() => {
    if (filters.category !== 'crops') return [];
    return fieldList.filter((f) => {
      if (!f.centroid) return false;
      if (haversineKm(viewportCenter, f.centroid) > filters.radiusKm) return false;
      if (filters.qcVerifiedOnly && !f.qcVerified) return false;
      // FIX: this check was missing entirely - "Organic Only" was a
      // real, working toggle in MapFilters.jsx's UI (draft.organicOnly
      // set/applied correctly) but filteredFieldList never looked at
      // filters.organicOnly at all, so every crop kept showing
      // regardless of the toggle. Combined with the loadFields() fix
      // above (is_organic wasn't even selected/mapped before), organic
      // filtering was broken end-to-end - this is the half that
      // actually applies it.
      if (filters.organicOnly && !f.isOrganic) return false;
      // Separate from organicOnly above - checks the field's own is_public
      // flag (listed for lease/rent etc.), not anything about a crop.
      if (filters.fieldsListedOnly && !f.isListed) return false;
      if (filters.harvestStage && f.stage !== filters.harvestStage) return false;
      if (filters.likedOnly && !likedFieldIds.has(f.id)) return false;
      if (searchQuery && !f.name?.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [fieldList, filters, likedFieldIds, viewportCenter, searchQuery]);

  // Services - was an always-on, unfiltered layer before. Now scoped the
  // same way crops/cattle are: category gate, radius, search-by-name, plus
  // serviceTypes (empty array = show every type) and an availability toggle.
  const filteredServicesList = useMemo(() => {
    if (filters.category !== 'services') return [];
    return servicesList.filter((s) => {
      if (!s.position) return false;
      if (haversineKm(viewportCenter, s.position) > filters.radiusKm) return false;
      if (filters.serviceTypes.length > 0 && !filters.serviceTypes.includes(s.serviceType)) {
        return false;
      }
      if (filters.servicesAvailableOnly && !s.isAvailable) return false;
      if (searchQuery && !s.serviceName?.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [servicesList, filters.category, filters.radiusKm, filters.serviceTypes, filters.servicesAvailableOnly, viewportCenter, searchQuery]);

  // Ponds/Fish - same treatment. pondsListedOnly keeps only ponds that
  // currently have at least one fish_stock row flagged is_listed_for_sale
  // (mirrors the is_public sync trigger's own definition of "listed").
  const filteredPondsList = useMemo(() => {
    if (filters.category !== 'ponds') return [];
    return pondsList.filter((p) => {
      if (!p.centroid) return false;
      if (haversineKm(viewportCenter, p.centroid) > filters.radiusKm) return false;
      if (filters.pondsListedOnly && !p.fishStock?.some((f) => f.is_listed_for_sale)) {
        return false;
      }
      if (searchQuery && !p.pondName?.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [pondsList, filters.category, filters.radiusKm, filters.pondsListedOnly, viewportCenter, searchQuery]);

  // Manual "show me everything" - independent of the auto-recenter fix
  // above, for whenever the user wants to see all currently-visible pins
  // regardless of how they got there. Uses whatever's actually rendered
  // (post-filter/search/radius), not the full unfiltered lists, so it
  // matches what's on screen. Leaflet's fitBounds() accepts a plain array
  // of [lat,lng] pairs, no need to construct an L.latLngBounds ourselves.
  const handleFitAll = useCallback(() => {
    if (!mapRef.current) return;
    const cattlePositions = filteredCattleList
      .map((c) => c.displayPosition)
      .filter(Boolean);
    // Field positions are full polygon rings, not just a centroid - using
    // every vertex gives a tighter/more accurate bounds than centroid-only.
    const fieldPositions = filteredFieldList.flatMap((f) => f.positions || []);
    const allPositions = [...cattlePositions, ...fieldPositions];
    if (allPositions.length === 0) return;
    mapRef.current.fitBounds(allPositions, { padding: [40, 40] });
  }, [filteredCattleList, filteredFieldList]);

  // Receiving end of CattleDetailModal's "🎯 Locate on Map" hand-off.
  // The modal already scoped fetching to one cattleId + one date (or
  // rolling-24h when no date was picked) using the exact same
  // fetchCattleTrail() helper - we just repeat that same scoped call
  // here (same signature: fetchCattleTrail(supabase, id, {date} |
  // {mode:'rolling24h'})) so THIS map's trail matches what the farmer
  // was just looking at in the modal, then flyTo the last known point
  // so it reads as "locate" rather than just a silent state update.
  // `date` is null for the rolling-24h case, kept alongside the points
  // so the dismiss badge below can label what's being shown.
  const handleViewTrailOnMap = useCallback(async ({ cattleId, date, lastPoint, lastPointRecordedAt }) => {
    const points = await fetchCattleTrail(
      supabase,
      cattleId,
      date ? { date } : { mode: 'rolling24h' }
    );
    setViewedTrail({ cattleId, date, points, lastPointRecordedAt });

    const targetZoom = 17;
    if (lastPoint && mapRef.current) {
      mapRef.current.flyTo(lastPoint, targetZoom, { animate: true, duration: 0.6 });
    } else if (lastPoint) {
      // mapRef.current not populated yet (rare) - same imperative
      // fallback the selectedTarget/geolocation effects already use.
      recenterMapTo(lastPoint);
    }
  }, []);

  // The single cattle row a history request is scoped to, looked up from
  // the full cattleList (not filteredCattleList) - same reasoning as the
  // viewedTrail render block already used: a farmer's active search/
  // filter shouldn't hide the animal they explicitly asked to see.
  // Used below to isolate the map down to just this one animal (+ its
  // own Base) while a history request is active, instead of showing it
  // tangled up with every other animal's everyday live pin/trail.
  const viewedCattle = useMemo(() => {
    if (!viewedTrail) return null;
    return cattleList.find((x) => x.id === viewedTrail.cattleId) || null;
  }, [viewedTrail, cattleList]);

  // While a history request (viewedTrail) is active, the map should show
  // ONLY that one animal - no other cattle pins, no other cattle's
  // everyday trails, no unrelated Bases - so the gold/zone-colored
  // historical trail below reads cleanly instead of getting lost among
  // every other animal's live marker and rolling trail. isolatedPins
  // keeps just that animal's own marker + its own Base marker (the
  // trail's synthetic starting point, so the base pin gives it context);
  // everything else falls back to the normal jitteredPins list.
  // FIX: the isolated cattle pin used to keep rendering at its normal
  // live/current renderPosition (item.renderPosition, from
  // jitteredPins/displayPosition) even while looking at a PAST day's
  // history - so the pin and the gold-turned-zone-colored trail's last
  // dot could be in two different places, reading as if the animal was
  // "at" its live spot despite the trail showing a different day. While
  // viewedTrail is active the cattle pin's renderPosition is now
  // overridden to the historical trail's own last point (falling back to
  // the animal's geofenceCenter/Base if that day had zero fixes), so the
  // pin always sits exactly where the viewed trail actually ends.
  const isolatedPins = useMemo(() => {
    if (!viewedTrail) return jitteredPins;
    const lastHistoricalPoint = viewedTrail.points.length > 0
      ? viewedTrail.points[viewedTrail.points.length - 1].position
      : (viewedCattle?.geofenceCenter ?? null);
    return jitteredPins
      .filter((item) =>
        item.kind === 'base'
          ? item.data.baseId === viewedCattle?.baseId
          : item.data.id === viewedTrail.cattleId
      )
      .map((item) =>
        item.kind === 'base' || !lastHistoricalPoint
          ? item
          : { ...item, renderPosition: lastHistoricalPoint }
      );
  }, [viewedTrail, viewedCattle, jitteredPins]);

  // Same isolation applied to the zone-tier/geofence circles below - only
  // the requested animal's own rings should draw while a history request
  // is active.
  const circleCattleList = viewedTrail
    ? (viewedCattle ? [viewedCattle] : [])
    : filteredCattleList;

  return (
    <div style={styles.overlay}>

      {/* Powers the red-zone trail flash applied via the kb-trail-flash
          className on Polyline pathOptions below - same CSS-only opacity
          animation MapPreviewCard.jsx uses, targeting Leaflet's own SVG
          <path> element (no JS interval/state toggle involved). */}
      <style>{`
        .kb-trail-flash {
          animation: kbTrailFlash 1s ease-in-out infinite;
        }
        @keyframes kbTrailFlash {
          0%, 100% { opacity: 0.9; }
          50% { opacity: 0.15; }
        }
      `}</style>

      <SearchHeader
        query={searchQuery}
        onQueryChange={setSearchQuery}
        onOpenFilters={() => setFilterSheetOpen(true)}
        onClose={onClose}
      />

      <MapContainer
        center={center}
        zoom={14}
        zoomControl={false}
        preferCanvas={true}
        style={{ height: '100%', width: '100%', background: 'var(--color-bg)' }}
      >
        {/* Was a plain react-leaflet <TileLayer> here - no caching at
            all, every pan/zoom/refresh re-downloaded tiles fresh from
            OSM. OfflineTileLayer was already imported above but never
            actually rendered anywhere in this file (dead import) - now
            wired in, with save-tiles-to-IndexedDB logic added to it
            this session (see OfflineTileLayer.jsx). Same maxZoom/
            keepBuffer/detectRetina values preserved. */}
        <OfflineTileLayer
          maxZoom={20}
          maxNativeZoom={16}
          keepBuffer={1}
          detectRetina={false}
        />
        <ZoomControl position="bottomright" />
        <MapMoveWatcher
          onSettled={handleViewportSettled}
          mapRef={mapRef}
          onZoomChange={setZoomLevel}
        />

        {/* Field boundaries - read-only, drawn once in AddFieldForm */}
        {filteredFieldList.map((f) => (
          <Polygon
            key={`field-${f.id}`}
            positions={f.positions}
            pathOptions={{
              color: f.qcVerified ? '#2e7d32' : GOLD,
              weight: 2,
              fillOpacity: 0.15,
            }}
          />
        ))}

        {/* Field markers - tap opens FieldDetailModal */}
        {filteredFieldList.map((f) => (
          <FieldMarker key={`fm-${f.id}`} field={f} onClick={setSelectedField} />
        ))}

        {/* Pond boundaries - read-only, drawn in AddPondForm. Now gated on
            the Ponds/Fish filter category (radius + Listed-for-Sale-Only
            applied via filteredPondsList), same as crops/cattle instead of
            always being on regardless of the selected category. */}
        {filteredPondsList.map((p) => (
          <Polygon
            key={`pond-${p.id}`}
            positions={p.positions}
            pathOptions={{ color: '#1e88e5', weight: 2, fillOpacity: 0.2 }}
          />
        ))}

        {/* Pond markers - tap opens PondDetailModal. CHANGED: was a plain
            <Marker icon={POND_ICON}> (bare 🐟 emoji, no pin shell) - now
            uses the shared PondMarker component so ponds get the same
            navy teardrop-pin shell Cattle/Field/Service already use.
            `p` already has the exact { centroid, fishStock } shape
            PondMarker expects (see loadPonds above). */}
        {filteredPondsList.map((p) => (
          <PondMarker key={`pond-marker-${p.id}`} pond={p} onClick={() => setSelectedPond(p)} />
        ))}

        {/* Water sources - read-only, registered from AddWaterSourceForm
            elsewhere. No filter/search scoping applied (unlike cattle/
            fields above) since this is a simple always-on layer for now. */}
        {waterSources.map((w) => (
          <Marker key={`water-${w.id}`} position={w.position} icon={WATER_ICON}>
            <Popup>
              <div style={{ fontSize: 13 }}>
                <strong>Water Source</strong>
                {w.depthM != null && <div>Depth: {w.depthM} m</div>}
                {!isFarmerView && <div style={{ color: 'var(--color-muted)' }}>Public water point</div>}
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Progressive zone-tier circles - ported from MapPreviewCard.jsx,
            which already had this and FullMapModal never did. Farmer
            view: only as many rings as the animal has actually reached
            (Tier1 alone while still inside Tier1, +Tier2 once it crosses
            out, +Tier3 once it crosses that too) - colors match
            GeofenceSetupModal's Tier 1/2/3 sliders via ZONE_COLORS, same
            as MapPreviewCard so an animal's zone status reads identically
            on both screens. Buyer view: unchanged single public geofence
            circle, no tiers, no live tracking. Scoped to filteredCattleList
            so a ring disappears when its animal is filtered/searched out,
            same as the pin/trail. */}
        {isFarmerView
          ? circleCattleList
              .filter((c) => c.geofenceCenter && c.currentZone)
              .flatMap((c) => {
                const rings = [];
                if (c.currentZone >= 1 && Number.isFinite(c.alertRadius1M)) {
                  rings.push(
                    <Circle
                      key={`pz1-${c.id}`}
                      center={c.geofenceCenter}
                      radius={c.alertRadius1M}
                      pathOptions={{ color: ZONE_COLORS[1], fillOpacity: 0, weight: 2, dashArray: '4 4' }}
                    />
                  );
                }
                if (c.currentZone >= 2 && Number.isFinite(c.alertRadius2M)) {
                  rings.push(
                    <Circle
                      key={`pz2-${c.id}`}
                      center={c.geofenceCenter}
                      radius={c.alertRadius2M}
                      pathOptions={{ color: ZONE_COLORS[2], fillOpacity: 0, weight: 2, dashArray: '4 4' }}
                    />
                  );
                }
                if (c.currentZone >= 3 && Number.isFinite(c.alertRadius3M)) {
                  rings.push(
                    <Circle
                      key={`pz3-${c.id}`}
                      center={c.geofenceCenter}
                      radius={c.alertRadius3M}
                      pathOptions={{ color: ZONE_COLORS[3], fillOpacity: 0, weight: 2, dashArray: '4 4' }}
                    />
                  );
                }
                return rings;
              })
          : circleCattleList
              .filter((c) => c.geofenceCenter)
              .map((c) => (
                <Circle
                  key={`pgeo-${c.id}`}
                  center={c.geofenceCenter}
                  radius={c.geofenceRadiusM}
                  pathOptions={{ color: '#2b3a61', fillOpacity: 0.08, weight: 2 }}
                />
              ))}

        {/* Historical GPS trail, farmer view only (buyers have no live
            tracking). Same two-layer approach as MapPreviewCard.jsx:
              - segments: base -> dot1 -> dot2 -> ... -> latest fix,
                colored by which alert tier that leg falls in (split at
                the exact boundary crossing when a leg spans two tiers).
                The base position is prepended as a synthetic leading
                point below so the base->dot1 leg gets the same
                tier-colored treatment as every other leg, instead of
                only connecting dot-to-dot.
              - dots: one per recorded GPS fix, always in the ANIMAL's
                own color (getCattleColor) so a dot never changes color
                based on distance - only the connecting line does.
            When the animal is currently in tier 3 (red), the entire
            trail (all segments) flashes via the kb-trail-flash CSS
            animation defined in the <style> block above, as an urgent
            visual cue. Scoped to filteredCattleList (not the full
            cattleList) so a trail disappears when its animal is
            filtered/searched out, same as the pin itself. */}
        {isFarmerView && !viewedTrail &&
          filteredCattleList
            .filter((c) => c.geofenceCenter)
            .flatMap((c) => {
              const trail = trailsByCattleId[c.id] || [];
              // Prepend the base/geofence position as a synthetic first
              // "point" so buildTrailSegments treats base -> first dot
              // as its own tier-colored leg, not just dot-to-dot.
              const pointsWithBase = [{ position: c.geofenceCenter }, ...trail];
              const segments = buildTrailSegments(
                pointsWithBase,
                c.geofenceCenter,
                c.alertRadius1M,
                c.alertRadius2M,
                c.alertRadius3M
              );
              const isRedZone = c.currentZone === 3;

              return segments.map((seg, i) => (
                <Polyline
                  key={`trail-seg-${c.id}-${i}`}
                  positions={[seg.from, seg.to]}
                  pathOptions={{
                    color: seg.zone ? ZONE_COLORS[seg.zone] : '#888',
                    weight: 3,
                    opacity: 0.9,
                    dashArray: '2 8',
                    className: isRedZone ? 'kb-trail-flash' : undefined,
                  }}
                />
              ));
            })}

        {isFarmerView && !viewedTrail &&
          filteredCattleList
            .filter((c) => c.geofenceCenter)
            .flatMap((c) => {
              const trail = trailsByCattleId[c.id] || [];
              const dotColor = getCattleColor(c.id);
              return trail.map((p, i) => (
                <CircleMarker
                  key={`trail-dot-${c.id}-${i}`}
                  center={p.position}
                  radius={3}
                  pathOptions={{ color: dotColor, fillColor: dotColor, fillOpacity: 1, weight: 1 }}
                />
              ));
            })}

        {/* Date-scoped single-animal trail from CattleDetailModal's
            "🎯 Locate on Map" hand-off (handleViewTrailOnMap above).
            Looked up from the full cattleList (not filteredCattleList) so
            it still renders even if the farmer's current search/filter
            would otherwise hide this animal's pin - they explicitly asked
            to see this, a filter shouldn't silently hide it.
            FIX: this used to render in flat GOLD alongside the regular
            everyday trail block above, which was still separately
            drawing THIS SAME animal's live rolling trail (plus every
            other animal's pins/trails/rings) underneath it - so a
            requested history view looked tangled up with the live map
            instead of being its own clean view. Now the everyday trail
            block is skipped entirely while viewedTrail is active (see
            "!viewedTrail" guards above) and every other animal's pin/
            circle is filtered out via isolatedPins/circleCattleList, so
            this is the ONLY trail and this is the ONLY animal shown.
            Styled identically to the everyday trail (zone-tier colored
            segments, per-animal dot color) instead of flat gold, so a
            requested history trail reads exactly like the live trail
            look the farmer already knows - just isolated to one animal/
            date. Same base-prepend + buildTrailSegments pattern as the
            regular trail block. */}
        {viewedTrail && viewedCattle && viewedCattle.geofenceCenter && (() => {
          const c = viewedCattle;
          const pointsWithBase = [{ position: c.geofenceCenter }, ...viewedTrail.points];
          const segments = buildTrailSegments(
            pointsWithBase,
            c.geofenceCenter,
            c.alertRadius1M,
            c.alertRadius2M,
            c.alertRadius3M
          );
          const dotColor = getCattleColor(c.id);
          return (
            <React.Fragment key={`viewed-trail-${viewedTrail.cattleId}-${viewedTrail.date || 'rolling24h'}`}>
              {segments.map((seg, i) => (
                <Polyline
                  key={`viewed-trail-seg-${i}`}
                  positions={[seg.from, seg.to]}
                  pathOptions={{
                    color: seg.zone ? ZONE_COLORS[seg.zone] : '#888',
                    weight: 3,
                    opacity: 0.9,
                    dashArray: '2 8',
                  }}
                />
              ))}
              {viewedTrail.points.map((p, i) => (
                <CircleMarker
                  key={`viewed-trail-dot-${i}`}
                  center={p.position}
                  radius={3}
                  pathOptions={{ color: dotColor, fillColor: dotColor, fillOpacity: 1, weight: 1 }}
                />
              ))}
            </React.Fragment>
          );
        })()}

        {/* Cattle Base markers + Cattle/cluster markers, rendered from
            jitteredPins (see above) so any that land on the same spot
            get nudged apart into a small ring instead of silently
            stacking - each keeps its own renderPosition, its
            underlying data (b.position / c.displayPosition) is
            untouched everywhere else (Circles, trail lines, distance
            calcs, CattleDetailModal, etc).
            Uses isolatedPins instead of jitteredPins directly so that
            while a history request (viewedTrail) is active, only the
            requested animal's own pin + its own Base pin render - every
            other animal/base is hidden, matching the isolated circles/
            trail above. isolatedPins === jitteredPins whenever no
            history request is active, so normal browsing is unaffected. */}
        {isolatedPins.map((item) => {
          if (item.kind === 'base') {
            return <Marker key={`base-${item.data.baseId}`} position={item.renderPosition} icon={BASE_ICON} />;
          }
          const c = item.data;
          return c.isCluster ? (
            <CattleClusterMarker
              key={c.id}
              cluster={{ ...c, displayPosition: item.renderPosition }}
              zoom={zoomLevel}
              onClick={(cluster) => {
                if (!mapRef?.current || !cluster?.displayPosition) return;

                const map = mapRef.current;
                const currentZoom = map.getZoom();

                // Zoom in enough to separate nearby cattle.
                // Maximum Leaflet zoom is respected.
                const nextZoom = Math.min(currentZoom + 3, 19);

                map.flyTo(
                  cluster.displayPosition,
                  nextZoom,
                  {
                    animate: true,
                    duration: 0.45,
                  }
                );
              }}
            />
          ) : (
            <CattleMarker
              key={c.id}
              cattle={{ ...c, displayPosition: item.renderPosition }}
              onClick={setSelectedCattle}
              isFarmerView={isFarmerView}
              showZoneLine={false}
              zoom={zoomLevel}
            />
          );
        })}

        {/* Service markers - now gated on the Services filter category
            (radius + service type + Available Only + search applied via
            filteredServicesList), same as crops/cattle/ponds instead of
            always being on regardless of the selected category. Tap opens
            ServiceDetailModal with the "Chat to Book" flow. */}
        {filteredServicesList.map((s) => (
          <Marker
            key={`service-${s.id}`}
            position={s.position}
            icon={getServiceIcon(s.serviceType)}
            eventHandlers={{ click: () => setSelectedService(s) }}
          />
        ))}
      </MapContainer>

      <button
        type="button"
        onClick={handleFitAll}
        style={styles.fitAllButton}
        aria-label="Fit all pins on screen"
      >
        Fit All
      </button>

      {/* Lets the farmer tell "I'm looking at a requested historical
          trail, not the everyday live one" and clear it back to normal -
          otherwise the gold trail from handleViewTrailOnMap above would
          just sit there indefinitely with no way to dismiss it. */}
      {viewedTrail && (
        <button
          type="button"
          onClick={() => setViewedTrail(null)}
          style={styles.viewedTrailBadge}
        >
          {viewedTrail.date ? `Trail: ${viewedTrail.date}` : 'Trail: Last 24h'} ✕
        </button>
      )}

      <FilterSheet
        isOpen={filterSheetOpen}
        filters={filters}
        onApply={handleApplyFilters}
        onClose={() => setFilterSheetOpen(false)}
      />

      {selectedCattle && (
        <CattleDetailModal
          cattle={selectedCattle}
          onClose={() => setSelectedCattle(null)}
          isLiked={likedCattleIds.has(selectedCattle.id)}
          onToggleLike={handleToggleCattleLike}
          isFarmerView={isFarmerView}
          hideBreedingToggle
          onViewTrailOnMap={handleViewTrailOnMap}
        />
      )}

      {selectedField && (
        <FieldDetailModal
          field={selectedField}
          onClose={() => setSelectedField(null)}
          isLiked={likedFieldIds.has(selectedField.id)}
          onToggleLike={handleToggleFieldLike}
        />
      )}

      {selectedService && (
        <ServiceDetailModal
          service={selectedService}
          onClose={() => setSelectedService(null)}
          isLiked={likedServiceIds.has(selectedService.id)}
          onToggleLike={handleToggleServiceLike}
        />
      )}

      {selectedPond && (
        <PondDetailModal
          pond={selectedPond}
          onClose={() => setSelectedPond(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

const styles = {
  overlay: { position: 'fixed', inset: 0, zIndex: 3000, background: 'var(--color-bg)' },
  fitAllButton: {
    position: 'absolute',
    left: 12,
    bottom: 24,
    zIndex: 3100,
    padding: '10px 16px',
    borderRadius: 20,
    border: '1px solid var(--color-border)',
    background: 'var(--color-card)',
    color: 'var(--color-ink)',
    fontSize: 13,
    fontWeight: 600,
    boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
  },
  // Dismiss badge for the active viewedTrail (Locate on Map hand-off) -
  // right side, same row as fitAllButton, gold border to match the
  // trail's own on-map color so the two are visually associated.
  viewedTrailBadge: {
    position: 'absolute',
    right: 12,
    bottom: 24,
    zIndex: 3100,
    padding: '10px 16px',
    borderRadius: 20,
    border: `1px solid ${GOLD}`,
    background: 'var(--color-card)',
    color: 'var(--color-ink)',
    fontSize: 13,
    fontWeight: 600,
    boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
  },
  searchHeader: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    zIndex: 3200,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 10px',
    borderRadius: 26,
    background: 'var(--color-card)',
    boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    border: 'none',
    background: 'var(--color-card)',
    color: 'var(--color-ink)',
    fontSize: 17,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  searchInput: {
    flex: 1,
    height: 38,
    borderRadius: 19,
    border: 'none',
    background: 'var(--color-bg)',
    color: 'var(--color-ink)',
    padding: '0 14px',
    fontSize: 14,
    minWidth: 0,
  },
  langSelect: {
    height: 38,
    width: 48,
    borderRadius: 19,
    border: 'none',
    background: 'var(--color-bg)',
    color: NAVY,
    fontSize: 12,
    flexShrink: 0,
    textAlign: 'center',
  },
  voiceErrorToast: {
    position: 'absolute',
    top: 74,
    right: 12,
    left: 12,
    background: '#c62828',
    color: '#fff',
    padding: '6px 12px',
    borderRadius: 8,
    fontSize: 12,
    zIndex: 3300,
  },
  sheetBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 4000,
    background: 'rgba(0,0,0,0.35)',
    display: 'flex',
    alignItems: 'flex-end',
  },
  sheet: {
    width: '100%',
    background: 'var(--color-card)',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: '10px 20px 24px',
    maxHeight: '80vh',
    overflowY: 'auto',
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    background: 'var(--color-border)',
    margin: '4px auto 12px',
  },
  clusterSheet: {
    width: '100%',
    background: 'var(--color-card)',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: '10px 0 20px',
    maxHeight: '50vh',
  },
  clusterSheetTitle: {
    margin: '0 20px 14px',
    color: 'var(--color-ink)',
    fontSize: 14,
    fontWeight: 600,
  },
  clusterStrip: {
    display: 'flex',
    gap: 14,
    overflowX: 'auto',
    scrollSnapType: 'x proximity',
    padding: '2px 20px 8px',
    WebkitOverflowScrolling: 'touch',
  },
  clusterStripItem: {
    flex: '0 0 auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    width: 76,
    border: 'none',
    background: 'transparent',
    scrollSnapAlign: 'center',
    padding: 0,
  },
  clusterStripPhoto: {
    width: 64,
    height: 64,
    borderRadius: '50%',
    objectFit: 'cover',
    border: `2px solid ${GOLD}`,
  },
  clusterStripEmoji: {
    width: 64,
    height: 64,
    borderRadius: '50%',
    background: 'var(--color-bg)',
    border: `2px solid ${GOLD}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 30,
  },
  clusterStripLabel: {
    fontSize: 12,
    color: 'var(--color-ink)',
    textAlign: 'center',
    maxWidth: 76,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // Small "ready to breed" indicator - reused as-is by CattleMarker.jsx's
  // pin badge (kept as a literal style object over there too, since that
  // file has no import path back to this one's `styles` object).
  breedingBadge: {
    position: 'absolute',
    top: -4,
    left: -4,
    fontSize: 14,
    lineHeight: 1,
    filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.5))',
  },
};