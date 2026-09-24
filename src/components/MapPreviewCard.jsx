// src/components/MapPreviewCard.jsx
//
// The unified home hero card: map snapshot + cattle count + today's
// advisory quote, all in ONE card, with a Select button right on it.
//
// Cattle data comes from HomeScreen's single shared fetch/realtime
// channel via the cattleData prop - no own fetch or realtime channel
// here. HomeScreen's realtime channel listens for cattle UPDATE events
// (live_location changes from LoRa pings) and updates cattleData state,
// which flows here as a prop - so live tracking shows on the preview
// automatically without FullMapModal needing to be open.
//
// WKB HEX PARSING: PostgREST returns PostGIS geography columns
// (live_location, geofence_center) as WKB hex strings, not GeoJSON.
// parseWkbPoint() below decodes these directly on the client so no
// DB-side generated columns or migration is needed. Works for both
// POINT (geometry type 1) and POINTZ (type 1001/0x80000001) WKB.

import { useEffect, useState, useMemo, useRef, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { MapContainer, Circle, CircleMarker, Polyline, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import CattleMarker from './CattleMarker';
import FieldMarker from './FieldMarker';
import PondMarker from '../features/ponds/PondMarker';
import { getServiceIcon } from './ServiceMarker';
import OfflineTileLayer from './OfflineTileLayer';
import { getTodaysQuote } from '../utils/dailyQuotes';
import { parseWkbPoint } from '../utils/geo';
import { generateAndShareHomeCard } from '../services/heroShareService';
// Needed here (not just HomeScreen) because the GPS history trail below
// is fetched separately from cattle_location_history, which isn't part
// of HomeScreen's existing cattleData select.
import { supabase } from '../config/supabaseClient';
import { fetchCattleTrail, buildTrailSegments, todayLocalDateString } from '../utils/cattleTrail';
import { getCattleColor } from '../utils/cattleColors';
// Progressive tier circles + zone-colored dots line (farmer view only -
// see the render block below). Same tier colors/distance math as
// GeofenceSetupModal's Tier 1/2/3 sliders and FullMapModal's dots line,
// centralized here so all three stay in sync.
import { ZONE_COLORS, haversineMeters, getCurrentZone } from '../utils/geoZones';

const DEFAULT_CENTER = [17.385, 78.4867];
const quote = getTodaysQuote();

// YYYY-MM-DD in LOCAL time for an arbitrary timestamp - same format as
// cattleTrail.js's todayLocalDateString(), so a straight string compare
// tells us whether a row's updated_at falls on today's calendar day.
// Used to gate the live-position PIN below (see isFromToday in
// cattleList) - a farmer's explicit request: a stale live_location
// reading from a previous day should show the animal at Base, not
// linger indefinitely just because it was once a valid fix.
function localDateString(dateInput) {
  const d = new Date(dateInput);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Farmer's Select dropdown only ever tracks cattle here (Cattle Base +
// individual animal) - Crops/Services/Ponds aren't something a farmer
// tracks live position for on this card, so they're not offered as tabs
// in farmer view.
const FARMER_CATEGORY_OPTIONS = [
  { key: 'cattle', label: 'Cattle' },
];

// Buyer gets all 4 categories, with emoji labels - buyer browses cattle
// listings same as Crops/Services/Ponds (just no live GPS/base grouping,
// see the isFarmerView guards elsewhere in this file).
const BUYER_CATEGORY_OPTIONS = [
  { key: 'cattle', label: '🐄 Cattle' },
  { key: 'crops', label: '🌾 Crops' },
  { key: 'services', label: '🚜 Services' },
  { key: 'ponds', label: '🐟 Ponds' },
];

// WKB hex â†’ [lat, lng] parsing for live_location / geofence_center now
// lives in src/utils/geo.js (SRID-aware, shared with FullMapModal.jsx and
// AddCattleBaseForm.jsx) - this file used to have its own fixed-offset copy
// that decoded garbage whenever the column carried an embedded SRID.

// react-leaflet's <MapContainer center={...}> only uses `center` to
// construct the underlying Leaflet map ONCE, on mount - it does NOT
// reactively pan the map when the `center` prop changes on a re-render.
// Our `center` state starts at DEFAULT_CENTER (Hyderabad) and gets
// updated asynchronously once cattle/field/GPS data resolves - without
// this, the map view stays stuck at DEFAULT_CENTER forever and any pin
// far from Hyderabad (e.g. a collar's GPS fix from elsewhere) renders
// at the correct lat/lng but is simply off-screen, invisible, with no
// way to pan to it since dragging is disabled on this preview card.
// This tiny child component uses useMap() to grab the live map
// instance and imperatively call setView() whenever `center` changes.
function RecenterMap({ center, zoom }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom ?? map.getZoom());
  }, [center, zoom, map]);
  return null;
}

// Reports the live zoom level up to MapPreviewCard so cattle pins can
// scale with it (zoom in -> bigger pin, zoom out -> smaller pin) - see
// CattleMarker.jsx's zoomToScale(). Only wired up now that the preview
// card has zoomControl enabled and a user can actually change zoom.
function ZoomTracker({ onZoomChange }) {
  const map = useMapEvents({
    zoomend: () => onZoomChange(map.getZoom()),
  });
  return null;
}

// Simple home-icon divIcon for a Cattle Base marker - shown once per
// distinct base a farmer has (see baseMarkers below), separate from the
// individual animal pins. Same lightweight emoji-divIcon pattern
// FullMapModal.jsx already uses for its water/pond markers.
const BASE_ICON = L.divIcon({
  html: '<div style="font-size:22px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));">\u{1F3E0}</div>',
  className: '',
  iconSize: [24, 24],
  iconAnchor: [12, 20],
});

export default function MapPreviewCard({
  isFarmerView,
  cattleData,
  cattleBasesData = [],
  // TODO: HomeScreen.jsx doesn't fetch these yet - only cattle/cattle
  // bases are fetched there today. To light up the Crops/Services/Ponds
  // categories below with real pins, HomeScreen needs its own
  // fetch-on-mount effects for these three (mirroring the existing
  // fetchCattle/fetchBases pattern), passed down as these props.
  // Shape expected here: fieldsData rows need { id, positions, name,
  // is_organic } (FieldMarker centroids from `positions`), servicesData
  // rows need { id, service_type, position: [lat,lng], name },
  // pondsData rows need { id, centroid: [lat,lng], fishStock, pondName }
  // - matching what FieldMarker/ServiceMarker/PondMarker already expect
  // elsewhere. Confirm exact column names against FullMapModal.jsx's
  // own loadFields/loadServices/loadPonds once that file's available -
  // defaulted to [] here so this renders an empty (not broken) category
  // until then, same "empty, not garbage" principle as the HomeScreen
  // buyer-view grid fix.
  fieldsData = [],
  servicesData = [],
  pondsData = [],
  loading,
  selectedTarget,
  onSelectTarget,
  onOpen,
  onShare,
}) {
  const [center, setCenter] = useState(DEFAULT_CENTER);
  const [hasRealCenter, setHasRealCenter] = useState(false);
  // Which pin type this preview map currently shows - single-select,
  // same idea as MapFilters.jsx's category filter on the full map, so
  // this small preview doesn't stack Cattle+Field+Service+Pond pins on
  // top of each other and look cluttered/broken at a glance.
  const [category, setCategory] = useState('cattle');
  // ADDED: guards against the outer preview-map div's onClick={onOpen}
  // (below, wrapping the whole MapContainer) double-firing when a
  // CattleMarker pin is tapped. CattleMarker's icon renders as real DOM
  // inside the Leaflet pane, so a tap fires its own onClick (correctly
  // sets a specific animal target + calls onOpen) AND then bubbles as a
  // native click up to this wrapping div, calling onOpen() a SECOND
  // time with no target - this was the actual cause of "opens the
  // wrong/front pin, feels slow" (two open calls racing per tap, the
  // second one target-less). Marker onClick sets this true right before
  // calling onOpen; the wrapper's onClick checks it and skips its own
  // call once, then resets it.
  const suppressNextOpenRef = useRef(false);
  // Current map zoom, kept in sync via <ZoomTracker> below - drives
  // cattle pin size scaling (see CattleMarker's `zoom` prop). Starts at
  // 13 to match the MapContainer's initial zoom={13}.
  const [zoomLevel, setZoomLevel] = useState(13);
  const [sharing, setSharing] = useState(false);

  const handleShare = async (e) => {
    e?.stopPropagation();

    if (sharing) return;

    try {
      setSharing(true);

      // FIX: this used to redeclare a local `cattleList` straight from the
      // raw `cattleData` prop, shadowing the component's own `cattleList`
      // above (the useMemo that WKB-parses live_location/geofence_center
      // and resolves displayPosition). Raw cattleData rows have no
      // displayPosition at all - generateAndShareHomeCard's per-animal
      // `if (!c.displayPosition) return` then skipped every single
      // animal, so the card's count was right but the map area came out
      // with zero dots (the "empty/blank canvas" symptom). Using the
      // already-computed cattleList fixes that without changing which
      // animals are included.
      await generateAndShareHomeCard({
        cattleList,
        quote: quote,
      });
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error('[MapPreviewCard] Share failed:', err);
      }
    } finally {
      setSharing(false);
    }
  };
  // REMOVED: selectedCattle local state - pin taps now route straight
  // into FullMapModal (see CattleMarker onClick below) instead of
  // opening this card's own CattleDetailModal.
  // REPLACED: `selectionMode` (tap-a-pin-on-the-mini-map) with a proper
  // Select list - the farmer asked to pick a Cattle Base or an
  // individual animal from a list instead of having to find/tap its pin
  // on this small preview map. `pickerOpen` drives that bottom-sheet
  // list (see the Select button and sheet render below).
  const [pickerOpen, setPickerOpen] = useState(false);
  // ADDED: the Select button's own screen position, captured on open via
  // getBoundingClientRect(). Needed because the dropdown menu itself is
  // rendered through a portal (see render block below) - `.kb-card`
  // (this whole component's outer wrapper) has `overflow: 'hidden'` so
  // the map's corners stay rounded, which was silently CLIPPING the
  // dropdown to invisible even though it rendered fine in the DOM. A
  // portal escapes that ancestor entirely, so it needs the button's
  // real screen coordinates instead of a CSS-relative anchor.
  const selectButtonRef = useRef(null);
  const [dropdownAnchor, setDropdownAnchor] = useState(null);

  // Historical GPS trail per animal, fetched separately from
  // cattle_location_history (see fetchTrails effect below) - keyed by
  // cattle id so a re-fetch for one animal doesn't touch another's
  // already-loaded trail. Buyer view never fetches these (no live
  // tracking for buyers - see isFarmerView guard below).
  const [trailsByCattleId, setTrailsByCattleId] = useState({});

  // Single-animal, date-scoped trail requested from CattleDetailModal's
  // "🎯 Locate on Map" button (handleViewTrailOnMap below) - same idea
  // as FullMapModal.jsx's own viewedTrail state, kept separate from
  // trailsByCattleId above (the always-on rolling-recent trail for every
  // animal) since this one can be pinned to an arbitrary PAST date and
  // only ever concerns one animal. { cattleId, date, points } | null.
  const [viewedTrail, setViewedTrail] = useState(null);
  // Explicit zoom to apply on the NEXT RecenterMap pan only (see
  // handleViewTrailOnMap) - null means "leave zoom as the user/card
  // already has it", same as RecenterMap's own `zoom ?? map.getZoom()`
  // fallback. Kept separate from `center` so a normal selectedTarget
  // pan (below) doesn't also force a zoom level change.
  const [recenterZoom, setRecenterZoom] = useState(null);

  // Sticky "last known good" live position per cattle id, kept across
  // renders (and across cattleData prop updates) purely in memory here.
  // FIX: an invalid (Null Island) reading used to fall straight through
  // to geofence/base location, which looks like "the animal is back
  // home" even when it's actually out grazing and just lost its GPS fix
  // (tree cover, terrain, etc). That's misleading - now it falls back to
  // this animal's own last valid fix first, and only to geofence/base if
  // it has genuinely never had one. Same idea as FullMapModal.jsx's
  // loadCattle previousCattleById, just ref-based here since this
  // component doesn't have a separate cache/delta-sync layer.
  const lastGoodLocationByIdRef = useRef({});

  // Derive the display shape this component needs from the raw rows
  // HomeScreen fetched. WKB parser handles the raw PostGIS hex columns
  // live_location and geofence_center that PostgREST returns.
  const cattleList = useMemo(() => {
    return (cattleData || []).map((row) => {
      // Farmer view: show live GPS pin if available, fall back to geofence center.
      // Buyer view (cattle_public_view): only geofence_center exposed, no live pin.
      // GPS "no fix" guard: the LoRa gateway ingestion script currently
      // writes live_location = POINT(0,0) even when its packet says
      // Fix Status: 0 / GPS State: NO FIX, overwriting the previous
      // valid live_location instead of skipping the field. (0,0) -
      // "Null Island" - is never a real farm location, so treat it as
      // no live fix.
      const rawLiveLocation = isFarmerView ? parseWkbPoint(row.live_location) : null;
      const isValidFix =
        rawLiveLocation && (Math.abs(rawLiveLocation[0]) > 0.0001 || Math.abs(rawLiveLocation[1]) > 0.0001);
      // CHANGED: per farmer's explicit request, a live_location reading
      // is only ever used if it's from TODAY's calendar day - if this
      // row's last update happened on a previous day, the pin now falls
      // back to Base (geofenceCenter below) instead of staying sticky at
      // yesterday's (or older) position indefinitely. The sticky
      // lastGoodLocationByIdRef below is likewise only trusted/updated
      // for same-day readings now, and cleared once a day boundary is
      // crossed so it can't leak a stale position into a later same-day
      // NO-FIX reading. Wanting the actual last-known spot from before
      // today is what the History picker (CattleDetailModal) is for -
      // not this pin.
      const isFromToday = row.updated_at ? localDateString(row.updated_at) === todayLocalDateString() : false;
      if (isValidFix && isFromToday) {
        lastGoodLocationByIdRef.current[row.id] = rawLiveLocation;
      } else if (!isFromToday) {
        delete lastGoodLocationByIdRef.current[row.id];
      }
      const liveLocation = isFromToday
        ? (isValidFix ? rawLiveLocation : (lastGoodLocationByIdRef.current[row.id] || null))
        : null;
      // NOTE: was `parseWkbPoint(isFarmerView ? row.geofence_center : row.geofence_center)`
      // - identical on both branches, simplified. geofence_center doubles as
      // the "base" reference point for the tier zones below (matches
      // FullMapModal's effectiveGeofenceCenter - a base-linked animal's
      // geofence_center is already backfilled from its Cattle Base there).
      const geofenceCenter = parseWkbPoint(row.geofence_center);

      // Alert tiers (Tier 1 free / Tier 2 SMS / Tier 3 Call - set in
      // GeofenceSetupModal) - owner-only data, never selected for buyer
      // view rows, so these are undefined there and every zone calc below
      // correctly falls through to null for buyers.
      // REQUIRES: HomeScreen's farmer-view select must include
      // alert_radius_1_m, alert_radius_2_m, alert_radius_3_m alongside
      // live_location - if cattleData doesn't carry them yet, zones/dots
      // just won't appear (getCurrentZone returns null), nothing breaks.
      const alertRadius1M = row.alert_radius_1_m;
      const alertRadius2M = row.alert_radius_2_m;
      const alertRadius3M = row.alert_radius_3_m;
      const distanceFromBaseM = isFarmerView ? haversineMeters(geofenceCenter, liveLocation) : null;
      const currentZone = isFarmerView
        ? getCurrentZone(distanceFromBaseM, alertRadius1M, alertRadius2M, alertRadius3M)
        : null;

      return {
        id: row.id,
        // CRITICAL FIX: this object never carried ownerId/owner_id at all.
        // CattleDetailModal.jsx computes `isOwner` as
        // `cattle.ownerId ?? cattle.owner_id` compared against the logged
        // -in user - with it always undefined here, isOwner was ALWAYS
        // false for every animal opened from this preview card, even a
        // farmer's own cattle. That's why the popup showed the buyer-style
        // card (GeoFence/Status/"Chat with Seller"/Ownership History)
        // instead of the farmer-style one (Age/Calvings/Weight/breeding
        // toggle) - confirmed by comparing this same animal's popup opened
        // from FullMapModal (whose own mapper always included ownerId).
        ownerId: row.owner_id,
        name: row.name,
        animalType: row.animal_type,
        localImageUri: isFarmerView ? row.local_image_path : null,
        marketplacePhotoUrl: row.marketplace_photo_url,
        salePriceMin: row.sale_price_min,
        salePriceMax: row.sale_price_max,
        // FIX: this field was never mapped, even though HomeScreen.jsx's
        // select already includes is_listed_for_sale (it feeds
        // CattleCard.jsx's own price-display/Sell-Unlist button gate).
        // Without it here, visibleCattleList below had no reliable way
        // to tell "listed" from "was listed once, price fields never
        // cleared" - see the filter fix a few lines down.
        isListedForSale: row.is_listed_for_sale,
        collarId: row.collar_id,
        // ADDED (same turn as ownerId fix): these were never carried
        // through either, even though HomeScreen.jsx's select was just
        // widened to include them - CattleDetailModal.jsx reads all of
        // these (age from birthDate, calvingCount, weightKg, govtInaphId,
        // contact fields, breedingReady, lastRssi/lastSnr for the new
        // signal-strength row), matching FullMapModal.jsx's own mapper
        // field-for-field so the popup looks identical from either screen.
        breed: row.breed,
        govtInaphId: row.govt_inaph_id,
        birthDate: row.birth_date,
        weightKg: row.weight_kg,
        calvingCount: row.calving_count,
        contactPhone: row.contact_phone,
        contactWhatsapp: row.contact_whatsapp,
        qcCertificateUrl: row.qc_certificate_url,
        breedingReady: row.is_breeding_ready,
        lastRssi: row.last_rssi,
        lastSnr: row.last_snr,
        // average_rating / rating_count not yet live â€” undefined until
        // migration_proposed_extend_schema_RECONCILED.sql is applied.
        averageRating: row.average_rating,
        ratingCount: row.rating_count,
        baseId: row.base_id,
        geofenceCenter,
        geofenceRadiusM: row.geofence_radius_m || 1000,
        liveLocation,
        alertRadius1M,
        alertRadius2M,
        alertRadius3M,
        distanceFromBaseM,
        currentZone,
        // Farmer-view-only fields shown in CattleDetailModal (last-seen
        // timestamp + location name) - harmless to carry through for
        // buyer rows too since CattleDetailModal itself gates their
        // display on isFarmerView, not on whether these happen to be set.
        updatedAt: row.updated_at,
        placeName: row.place_name,
        displayPosition: isFarmerView && liveLocation ? liveLocation : geofenceCenter,
      };
    });
  }, [cattleData, isFarmerView]);

  // Fetch each animal's historical trail from cattle_location_history.
  // Deliberately keyed off the STABLE list of cattle ids (not the full
  // cattleList, which changes on every live GPS ping via HomeScreen's
  // realtime channel) - refetching trail history on every ping would be
  // wasteful and pointless. Full load runs on mount and whenever the
  // cattle id set itself changes (an animal added/removed) - keeping
  // each animal's trail fresh after that is the push effect below, not
  // a timer here.
  const cattleIdsKey = isFarmerView ? cattleList.map((c) => c.id).join(',') : '';

  useEffect(() => {
    if (!isFarmerView || !cattleIdsKey) return;
    const ids = cattleIdsKey.split(',').filter(Boolean);
    let cancelled = false;

    const loadTrails = async () => {
      const entries = await Promise.all(
        // CHANGED: date: todayLocalDateString() instead of the rolling-24h
        // default - per farmer's explicit request, this always-on trail
        // should visibly reset at midnight rather than still showing
        // yesterday evening's dots into today just because they're within
        // a rolling 24h window. Re-evaluated fresh on every loadTrails()
        // call, so the next fetch after midnight automatically empties
        // out until today's first real fix lands - no extra reset logic
        // needed. History picker (CattleDetailModal) is unaffected, it
        // already passes its own explicit historyDate through this same
        // `date` param.
        ids.map(async (id) => [id, await fetchCattleTrail(supabase, id, { date: todayLocalDateString() })])
      );
      if (!cancelled) {
        setTrailsByCattleId(Object.fromEntries(entries));
      }
    };

    loadTrails();
    return () => {
      cancelled = true;
    };
  }, [isFarmerView, cattleIdsKey]);

  // OPTIMIZED: this used to be `setInterval(loadTrails, 60000)` - a full
  // Promise.all re-fetch of EVERY animal's trail every 60 seconds,
  // whether or not any collar had actually reported a new point.
  // Collar ping cadence isn't fixed/synchronized either (deliberately
  // jittered, and testing right now has two collars set to different
  // 2min/3min cadences with their own jitter on top) - a fixed poll
  // interval can't line up with that even if tuned, and any interval
  // short enough to feel "live" ends up re-fetching N animals' worth of
  // history on a timer, mostly for nothing.
  //
  // Replaced with a push: subscribe once to INSERT events on
  // cattle_location_history, and when a row lands, re-fetch ONLY that
  // one animal's trail (existing fetchCattleTrail(), unchanged) - not
  // the whole herd. This fires exactly when new data actually exists,
  // regardless of which collar it came from or how its cadence/jitter
  // is configured.
  //
  // ASSUMPTION: the inserted row's cattle-reference column is named
  // `cattle_id` (matching the `id` fetchCattleTrail(supabase, id) is
  // already called with elsewhere in this file) - flag if
  // cattle_location_history actually uses a different column name.
  // ASSUMPTION: RLS on cattle_location_history already scopes which
  // rows this client's postgres_changes subscription receives to this
  // farmer's own cattle (same assumption the `cattle` table's own
  // realtime channels in this codebase rely on) - the `ids.has(...)`
  // check below is a defensive client-side narrowing on top of that,
  // not the only thing standing between this farmer and another
  // farmer's rows.
  useEffect(() => {
    if (!isFarmerView || !cattleIdsKey) return;
    const ids = new Set(cattleIdsKey.split(',').filter(Boolean));
    let channel;
    let cancelled = false;

    channel = supabase
      .channel(`cattle_trail_push_${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'cattle_location_history' },
        async (payload) => {
          const cattleId = payload.new?.cattle_id;
          if (!cattleId || !ids.has(cattleId)) return;

          // Same calendar-day scoping as the initial load above (date:
          // todayLocalDateString()) - a push right after midnight for
          // yesterday's very last straggler event shouldn't repopulate
          // today's supposedly-empty trail with a point from yesterday.
          const trail = await fetchCattleTrail(supabase, cattleId, { date: todayLocalDateString() });
          if (cancelled) return;
          setTrailsByCattleId((prev) => ({ ...prev, [cattleId]: trail }));
        }
      )
      .subscribe((status, err) => {
        // `cancelled` is flipped to true synchronously inside the cleanup
        // function below, BEFORE supabase.removeChannel() is called. So if
        // this callback fires with CLOSED after that, it's this effect's
        // own intentional teardown (unmount / dep change) closing the
        // channel - not a real dropped connection - and shouldn't be
        // logged as a "problem".
        if (cancelled) return;
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn('[MapPreviewCard] trail realtime subscription problem:', status, err);
        }
      });

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [isFarmerView, cattleIdsKey]);

  // One ðŸ  marker per distinct Cattle Base - not per animal. Animals with
  // no base_id (individually tracked, no base registered - see Q&A: "konni
  // sarlu cattle register cheytharu cattle base lekunda") simply don't
  // contribute a base marker; their own pin still shows normally via
  // cattleList above. Position comes from geofenceCenter, which for a
  // base-linked animal is already backfilled from cattle_bases.location
  // by the cattle_with_effective_geofence view HomeScreen reads from.
  const baseMarkers = useMemo(() => {
    const seen = new Map();
    cattleList.forEach((c) => {
      if (c.baseId && c.geofenceCenter && !seen.has(c.baseId)) {
        seen.set(c.baseId, c.geofenceCenter);
      }
    });
    return Array.from(seen.entries()).map(([baseId, position]) => ({ baseId, position }));
  }, [cattleList]);

  // ADDED: the Select list's Bases section - parsed straight from
  // cattleBasesData (HomeScreen's fetch of the farmer's registered
  // cattle_bases rows), not from baseMarkers above. baseMarkers only
  // ever contains a base if at least one animal is currently linked to
  // it (derived from cattleList); a base the farmer registered but
  // hasn't assigned any animal to yet would silently be unselectable
  // otherwise. `location` is the same WKB-hex geography column pattern
  // as live_location/geofence_center - parsed with the shared helper.
  const baseOptions = useMemo(() => {
    return (cattleBasesData || [])
      .map((b) => ({
        type: 'base',
        id: b.id,
        name: b.base_name,
        position: parseWkbPoint(b.location),
      }))
      .filter((b) => b.position);
  }, [cattleBasesData]);

  // Farmer-only: this Select-dropdown list only ever applies to farmer
  // view now (buyer's Cattle tab shows no list at all - see the render
  // block below, just map pins via visibleCattleList). Animals with NO
  // base assigned show individually here - a base-linked animal (e.g.
  // Baccha/Chunni under base "Tt") already has its own entry via
  // baseOptions above; listing it a second time here as a loose
  // individual would just duplicate it (selecting its Base is the only
  // way to reach it - see visibleCattleList below).
  const cattleOptions = useMemo(() => {
    return cattleList
      .filter((c) => c.displayPosition && !c.baseId)
      .map((c) => ({ type: 'cattle', id: c.id, name: c.name, position: c.displayPosition }));
  }, [cattleList]);

  // ADDED: when the farmer picks a Cattle Base from the Select list, the
  // map/pins below should narrow down to just that base's animals -
  // not stay showing every animal the farmer owns. Picking an individual
  // animal (or nothing) leaves the full list showing, since there's
  // nothing to narrow down to in that case - the individual is just
  // centered on via the selectedTarget effect above.
  // Buyer-only: pressing "Cattle" shows no list (see render block below)
  // - every animal actually LISTED FOR SALE (sale price set) just shows
  // straight away as a pin here. Without this filter, a buyer's map was
  // showing the owner's own private roster (e.g. Baccha/Chunni) purely
  // because they happened to be in the same cattleData rows, which isn't
  // what a buyer should ever see.
  const visibleCattleList = useMemo(() => {
    if (selectedTarget?.type === 'base') {
      return cattleList.filter((c) => c.baseId === selectedTarget.id);
    }
    if (!isFarmerView) {
      // FIX: this used to check salePriceMin/salePriceMax != null, which
      // stays true forever once an animal has ever been listed -
      // CattleInfoPanel.jsx's handleToggleListing only flips
      // is_listed_for_sale to false on unlist, it never clears the price
      // fields in the DB. So an unlisted animal kept showing on the
      // buyer map purely because its old price was still sitting there.
      // is_listed_for_sale is the actual source of truth for "currently
      // for sale" - check that instead.
      return cattleList.filter((c) => c.isListedForSale === true);
    }
    return cattleList;
  }, [cattleList, selectedTarget, isFarmerView]);

  // Field/Service/Pond options for the Select dropdown + map pins,
  // built the same lightweight way baseOptions/cattleOptions already
  // are - filtered to entries that actually have a plottable position.
  const fieldOptions = useMemo(() => {
    return (fieldsData || [])
      .map((f) => ({ type: 'field', id: f.id, name: f.name, row: f }))
      .filter((f) => f.row.positions?.length || f.row.centroid);
  }, [fieldsData]);

  const serviceOptions = useMemo(() => {
    return (servicesData || [])
      .map((s) => ({ type: 'service', id: s.id, name: s.name, position: s.position, serviceType: s.service_type ?? s.serviceType }))
      .filter((s) => s.position);
  }, [servicesData]);

  const pondOptions = useMemo(() => {
    return (pondsData || [])
      .map((p) => ({ type: 'pond', id: p.id, name: p.pondName, position: p.centroid }))
      .filter((p) => p.position);
  }, [pondsData]);

  const hasRealCenterRef = useRef(false);

  useEffect(() => {
    // GUARD: don't yank the map back to the first animal on every
    // cattleList refresh (a realtime GPS ping updates cattleList
    // constantly) once the farmer has explicitly picked a Base/Cattle
    // from the new Select list below - that selection should stick
    // until they pick something else or clear it.
    if (selectedTarget) return;
    if (cattleList[0]?.displayPosition) {
      setCenter(cattleList[0].displayPosition);
      setHasRealCenter(true);
      hasRealCenterRef.current = true;
    }
  }, [cattleList, selectedTarget]);

  // ADDED: recenter the mini-map on whatever the farmer picked from the
  // Select list. Deliberately only calls setCenter (kept at whatever
  // zoom the map is currently at, via RecenterMap's map.setView(center,
  // map.getZoom()) below) - the farmer asked for zoom buttons/pinch to
  // stay untouched by this, only the pan position should change.
  useEffect(() => {
    if (selectedTarget?.position) {
      setCenter(selectedTarget.position);
      setHasRealCenter(true);
      hasRealCenterRef.current = true;
    }
  }, [selectedTarget]);

  // Device-GPS fallback: previously this card ONLY ever centered on an
  // existing cattle pin or field centroid, defaulting straight to the
  // hardcoded Hyderabad DEFAULT_CENTER for any farmer who doesn't have
  // cattle/field location data yet - regardless of where they actually
  // are (confirmed by user: physically in Tiruvuru, map opened on
  // Hyderabad). This asks the device for its real position ONCE on
  // mount as a last-resort fallback, and only applies it if neither of
  // the pin-based effects above/below has already found a real center
  // by the time it resolves (checked via a ref, not state, so this
  // doesn't race a stale closure against those effects). If the user
  // already has cattle/field data, this fallback never overrides it.
  useEffect(() => {
    if (!navigator.geolocation) return;
    // MICRO-OPT: skip the actual device GPS request entirely if a real
    // center already exists by the time this effect runs (e.g. cattle
    // data was already in cattleData on first render, or a Base/field
    // centered the map first) - this used to still fire
    // getCurrentPosition() every mount and only check hasRealCenterRef
    // inside the callback, so a farmer with cattle already showing on
    // the map still triggered a real device GPS/location-permission
    // request for no visible benefit. Checking the ref BEFORE calling
    // getCurrentPosition (not just before applying its result) avoids
    // that pointless hardware/permission hit whenever it's not needed.
    if (hasRealCenterRef.current) return;
    const watchId = navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (hasRealCenterRef.current) return; // pin-based center already won
        const gpsCenter = [pos.coords.latitude, pos.coords.longitude];
        setCenter(gpsCenter);
        setHasRealCenter(true);
        hasRealCenterRef.current = true;
      },
      () => {
        // Permission denied / unavailable / timed out - silently keep
        // whatever's already showing (pin-based center or the Hyderabad
        // default). Not fatal, no need to surface an error for this.
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 }
    );
    return () => {
      // getCurrentPosition has no cancel; guard is just for clarity that
      // watchId here is a request id, not a subscription to clean up.
      void watchId;
    };
  }, []);

  // De-overlap markers that land on (nearly) the same spot - e.g. two
  // animals whose live GPS fixes happen to be a few meters apart. Without
  // this, Leaflet just stacks the marker divs on top of each other and
  // only the last-rendered one is visible/tappable, silently hiding the
  // other animal(s) even though their data is completely correct.
  //
  // Deliberately NOT a grouped "N animals" cluster pin (that's what
  // FullMapModal.jsx's Base-based CattleClusterMarker does) - farmer
  // asked for each animal to stay its own small, separately-tappable
  // pin, just nudged apart so they don't hide each other. This does NOT
  // touch cattle.displayPosition itself anywhere else (zone lines,
  // distance calcs, CattleDetailModal, etc.) - it only produces an
  // offset RENDER position used for the <Marker> below.
  const jitteredCattleList = useMemo(() => {
    const OVERLAP_THRESHOLD_DEG = 0.0004; // ~40m at this latitude
    const groups = [];
    const withPos = visibleCattleList.filter((c) => c.displayPosition);

    withPos.forEach((c) => {
      const group = groups.find(
        (g) =>
          Math.abs(g.anchor[0] - c.displayPosition[0]) < OVERLAP_THRESHOLD_DEG &&
          Math.abs(g.anchor[1] - c.displayPosition[1]) < OVERLAP_THRESHOLD_DEG
      );
      if (group) {
        group.members.push(c);
      } else {
        groups.push({ anchor: c.displayPosition, members: [c] });
      }
    });

    const result = [];
    groups.forEach((g) => {
      if (g.members.length === 1) {
        result.push(g.members[0]);
        return;
      }
      // Spread overlapping members evenly around a small ring centered
      // on the anchor position, instead of stacking them exactly - each
      // stays its own individual, separately-tappable pin.
      const ringRadiusDeg = 0.0003;
      g.members.forEach((c, i) => {
        const angle = (2 * Math.PI * i) / g.members.length;
        result.push({
          ...c,
          displayPosition: [
            g.anchor[0] + ringRadiusDeg * Math.cos(angle),
            g.anchor[1] + ringRadiusDeg * Math.sin(angle),
          ],
        });
      });
    });

    return result;
  }, [visibleCattleList]);

  // Receiving end of CattleDetailModal's "🎯 Locate on Map" hand-off,
  // same idea as FullMapModal.jsx's own handleViewTrailOnMap - repeats
  // the exact same scoped fetchCattleTrail() call the modal already made
  // (fetchCattleTrail(supabase, id, {date} | {mode:'rolling24h'})) so
  // this card's trail matches what the farmer was just looking at, then
  // pans (and zooms in) to the last known point via `center`/`recenterZoom`
  // state - RecenterMap (mounted inside <MapContainer> below) picks up
  // both and calls the underlying map.setView() imperatively, since this
  // card has no mapRef/flyTo of its own (dragging is disabled here, so
  // there was never a need for one before now).
  const handleViewTrailOnMap = async ({ cattleId, date, lastPoint, lastPointRecordedAt }) => {
    const points = await fetchCattleTrail(
      supabase,
      cattleId,
      date ? { date } : { mode: 'rolling24h' }
    );
    setViewedTrail({ cattleId, date, points, lastPointRecordedAt });
    if (lastPoint) {
      setCenter(lastPoint);
      setRecenterZoom(16);
      // One-shot: RecenterMap applies this zoom on the pan triggered by
      // the setCenter() above, then we clear it so a LATER, unrelated
      // center change (e.g. picking a different animal from the Select
      // list, or a live-position update) doesn't keep forcing zoom 16 -
      // this zoom-in is specifically for THIS Locate action.
      setTimeout(() => setRecenterZoom(null), 0);
    }
  };

  return (
    <div className="kb-card" style={{ overflow: 'hidden', flexShrink: 0 }}>
      {/* Powers the red-zone trail flash applied via the kb-trail-flash
          className on Polyline pathOptions above - targets Leaflet's own
          SVG <path> element, so this is plain CSS opacity animation, not
          a JS interval/state toggle. Scoped by class name only (no
          :root-level pollution risk) so it's safe to render once per
          card instance even if multiple preview cards exist on a page. */}
      <style>{`
        .kb-trail-flash {
          animation: kbTrailFlash 1s ease-in-out infinite;
        }
        @keyframes kbTrailFlash {
          0%, 100% { opacity: 0.9; }
          50% { opacity: 0.15; }
        }
      `}</style>
      <div
        onClick={() => {
          if (suppressNextOpenRef.current) {
            suppressNextOpenRef.current = false;
            return;
          }
          onOpen && onOpen();
        }}
        style={{ height: 190, cursor: 'pointer', position: 'relative' }}
      >
        <MapContainer
          center={center}
          zoom={13}
          // FIX: zoomControl was off, so there was no way to zoom out
          // and see a cattle pin sitting outside the current view -
          // the preview card was locked to whatever zoom/center it
          // first picked. Turning this on adds Leaflet's own +/- zoom
          // buttons; dragging stays off so the card's "tap anywhere to
          // open full map" behavior is unaffected (Leaflet's zoom
          // control already stops its own click from bubbling up to
          // the card's onClick, so tapping +/- zooms instead of
          // opening the modal).
          zoomControl={true}
          dragging={false}
          scrollWheelZoom={false}
          doubleClickZoom={false}
          touchZoom={false}
          attributionControl={false}
          style={{ height: '100%', width: '100%', pointerEvents: 'auto', background: 'var(--color-bg)' }}
        >
          {/* Was a plain react-leaflet <TileLayer> pinned to the light OSM
              url - never switched tiles in dark mode (unlike
              FullMapModal.jsx / AddFieldForm.jsx, which already use
              OfflineTileLayer's dark/light MutationObserver switching),
              and had no offline tile caching either. Swapped to match. */}
          <OfflineTileLayer
            maxZoom={19}
            maxNativeZoom={15}
            keepBuffer={1}
            detectRetina={false}
          />

          <RecenterMap center={center} zoom={recenterZoom} />
          <ZoomTracker onZoomChange={setZoomLevel} />

          {/* Cattle Base markers - one ðŸ  per distinct base (see
              baseMarkers above), shown for both views since the base
              location itself is what buyers see too (geofenceCenter is
              already the public-facing point). This card tracks cattle +
              cattle bases only - fields/ponds/other place markers were
              removed per design (this is a cattle-tracking card, not the
              general map). */}
          {category === 'cattle' && baseMarkers.map((b) => (
            <Marker key={`base-${b.baseId}`} position={b.position} icon={BASE_ICON} />
          ))}

          {category === 'cattle' && (isFarmerView ? (
            // Farmer view: progressive tier circles - only as many rings
            // as the animal has actually reached (Tier1 alone while it's
            // still inside Tier1, +Tier2 once it crosses out, +Tier3 once
            // it crosses that too), instead of always showing the full
            // public-geofence circle. Colors match GeofenceSetupModal's
            // Tier 1/2/3 sliders via ZONE_COLORS.
            visibleCattleList
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
          ) : (
            // Buyer view: unchanged - the single public geofence circle,
            // no tiers, no live tracking (see displayPosition above).
            visibleCattleList
              .filter((c) => c.geofenceCenter)
              .map((c) => (
                <Circle
                  key={`pgeo-${c.id}`}
                  center={c.geofenceCenter}
                  radius={c.geofenceRadiusM}
                  pathOptions={{ color: '#2b3a61', fillOpacity: 0.08, weight: 2 }}
                />
              ))
          ))}

          {/* Historical GPS trail, farmer view only (buyers have no live
              tracking). Two layers, colored independently:
                - segments: the connecting line, colored by which alert
                  tier that leg of the trip falls in (split at the exact
                  boundary crossing when a leg spans two tiers) - see
                  buildTrailSegments() in utils/cattleTrail.js.
                - dots: one per recorded GPS fix, always in the ANIMAL's
                  own color (getCattleColor) so a dot never changes
                  color based on distance - only the connecting line does.
              When the animal is currently in tier 3 (red), the entire
              trail (all segments) flashes via the kb-trail-flash CSS
              animation defined in the <style> block below, as an
              urgent visual cue. */}
          {category === 'cattle' && isFarmerView &&
            visibleCattleList
              .filter((c) => c.geofenceCenter)
              .flatMap((c) => {
                const trail = trailsByCattleId[c.id] || [];
                // Prepend the base/geofence position as a synthetic
                // first "point" so buildTrailSegments treats
                // base -> first dot as its own tier-colored leg, not
                // just dot-to-dot (matches FullMapModal.jsx).
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

          {category === 'cattle' && isFarmerView &&
            visibleCattleList
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
              Looked up from the full cattleList (not visibleCattleList)
              so it still renders even if `category` isn't currently
              'cattle' - the farmer explicitly asked to see this. Styled
              in gold/thicker than the regular rolling trail above, same
              visual language as FullMapModal.jsx's own viewedTrail
              layer, so it reads the same on both screens. */}
          {viewedTrail && (() => {
            const c = cattleList.find((x) => x.id === viewedTrail.cattleId);
            if (!c || !c.geofenceCenter) return null;
            const pointsWithBase = [{ position: c.geofenceCenter }, ...viewedTrail.points];
            const segments = buildTrailSegments(
              pointsWithBase,
              c.geofenceCenter,
              c.alertRadius1M,
              c.alertRadius2M,
              c.alertRadius3M
            );
            return (
              <Fragment key={`viewed-trail-${viewedTrail.cattleId}-${viewedTrail.date || 'rolling24h'}`}>
                {segments.map((seg, i) => (
                  <Polyline
                    key={`viewed-trail-seg-${i}`}
                    positions={[seg.from, seg.to]}
                    pathOptions={{ color: 'var(--color-gold)', weight: 5, opacity: 0.9 }}
                  />
                ))}
                {viewedTrail.points.map((p, i) => (
                  <CircleMarker
                    key={`viewed-trail-dot-${i}`}
                    center={p.position}
                    radius={4}
                    pathOptions={{ color: 'var(--color-gold)', fillColor: 'var(--color-gold)', fillOpacity: 1, weight: 1 }}
                  />
                ))}
              </Fragment>
            );
          })()}

          {category === 'cattle' && jitteredCattleList.map((c) => (
            <CattleMarker
              key={c.id}
              cattle={c}
              // CHANGED: pin tap used to open this card's OWN
              // CattleDetailModal via local selectedCattle state - but
              // this preview is fed by HomeScreen.jsx's narrower select
              // (no breed/weight_kg/calving_count/last_rssi/last_snr), so
              // that card was always missing fields FullMapModal's own
              // card already shows correctly. Now reuses the exact same
              // onSelectTarget+onOpen path the Cattle picker list below
              // already uses (see cattleOptions), so tapping a pin jumps
              // straight into FullMapModal - flyTo's this animal AND
              // auto-opens its CattleDetailModal there, with full data.
              onClick={(animal) => {
                suppressNextOpenRef.current = true;
                onSelectTarget && onSelectTarget({
                  type: 'cattle',
                  id: animal.id,
                  name: animal.name,
                  position: animal.displayPosition,
                });
                onOpen && onOpen();
              }}
              isFarmerView={isFarmerView}
              zoom={zoomLevel}
              showZoneLine={false}
            />
          ))}

          {/* Crops/Services/Ponds pins - one category visible at a
              time (see `category` state above), same shared marker
              components (FieldMarker/PondMarker/getServiceIcon) already
              used on FullMapModal, so a pin here looks identical to its
              full-map counterpart. Data currently comes from
              fieldsData/servicesData/pondsData props, which default to
              [] until HomeScreen.jsx adds fetches for them - see the
              TODO above the props list. */}
          {category === 'crops' &&
            (fieldsData || []).map((f) => (
              <FieldMarker key={f.id} field={f} onClick={() => {}} />
            ))}

          {category === 'services' &&
            serviceOptions.map((s) => (
              <Marker key={s.id} position={s.position} icon={getServiceIcon(s.serviceType)} />
            ))}

          {category === 'ponds' &&
            (pondsData || []).map((p) => (
              <PondMarker key={p.id} pond={p} onClick={() => {}} />
            ))}
        </MapContainer>

        {/* Lets the farmer tell "this gold trail is a requested
            historical one, not the everyday live trail" and clear it -
            same idea as FullMapModal.jsx's own viewedTrailBadge.
            stopPropagation so tapping it doesn't also fire the card's
            own onClick={onOpen} (which opens FullMapModal). */}
        {viewedTrail && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setViewedTrail(null);
            }}
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              zIndex: 10,
              padding: '6px 10px',
              borderRadius: 14,
              border: '1px solid var(--color-gold)',
              background: 'rgba(20,24,40,0.75)',
              color: '#fff',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {viewedTrail.date ? `Trail: ${viewedTrail.date}` : 'Trail: Last 24h'} ✕
          </button>
        )}

        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: 'linear-gradient(to top, rgba(20,24,40,0.55), transparent 55%)',
            display: 'flex',
            alignItems: 'flex-end',
            padding: 14,
          }}
        >
          <div style={{ color: '#fff' }}>
            <div className="display-text" style={{ fontSize: 16 }}>
              {loading ? '...' : categoryCountLabel(category, {
                cattle: visibleCattleList.length,
                crops: fieldOptions.length,
                services: serviceOptions.length,
                ponds: pondOptions.length,
              })}
            </div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>Tap to open full map</div>
          </div>
        </div>
      </div>

      <div style={{ padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-navy)' }}>
            {quote.te}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>
            {quote.en}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>

          {/* SELECT BUTTON - opens a small dropdown menu anchored to
              this exact button (Flutter DropdownButton style). The menu
              itself is portaled to document.body (see below) so the
              card's own overflow:hidden can't clip it. */}
          <div style={{ flexShrink: 0 }}>
            <button
              ref={selectButtonRef}
              onClick={(e) => {
                e.stopPropagation();
                if (!pickerOpen && selectButtonRef.current) {
                  setDropdownAnchor(selectButtonRef.current.getBoundingClientRect());
                }
                setPickerOpen((v) => !v);
              }}
              style={{
                flexShrink: 0,
                padding: '8px 14px',
                borderRadius: 10,
                border: 'none',
                background: 'var(--color-gold)',
                color: 'var(--color-navy)',
                fontWeight: 700,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >Select</button>

            {pickerOpen && dropdownAnchor && createPortal(
              <>
                {/* Invisible full-screen catcher, just for outside-tap-
                    to-close - not a visible dark backdrop like a bottom
                    sheet, since this is meant to read as a small dropdown
                    menu, not a modal. */}
                <div
                  onClick={() => setPickerOpen(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'transparent' }}
                />
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'fixed',
                    top: dropdownAnchor.bottom + 6,
                    left: Math.max(8, dropdownAnchor.right - 220),
                    zIndex: 10000,
                    minWidth: 170,
                    maxWidth: 220,
                    maxHeight: 320,
                    overflowY: 'auto',
                    background: 'var(--color-card)',
                    borderRadius: 10,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                    padding: '6px 0',
                  }}
                >
                  {/* Category tabs - switching here both filters the
                      pins drawn on the mini-map above AND the list of
                      items shown below, so "Select" always lists
                      exactly what's currently visible on the map.
                      Farmer only ever gets the Cattle tab (Base +
                      individual animal, no Crops/Services/Ponds here);
                      Buyer gets all 4, browsing cattle listings the same
                      way as the other three. */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '2px 10px 8px' }}>
                    {(isFarmerView ? FARMER_CATEGORY_OPTIONS : BUYER_CATEGORY_OPTIONS).map((opt) => (
                      <button
                        key={opt.key}
                        onClick={() => setCategory(opt.key)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '6px 10px',
                          borderRadius: 8,
                          border: '1px solid var(--color-border)',
                          background: category === opt.key ? 'var(--color-navy)' : 'transparent',
                          color: category === opt.key ? '#fff' : 'var(--color-ink)',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {/* Cattle Bases + this farmer's own animal roster -
                      farmer-only. A Base is something a farmer registers
                      to group their own animals under, and this list is
                      "my own animals", not a marketplace browse list -
                      neither concept applies to a Buyer, so this section
                      is skipped entirely in buyer view. Animals with no
                      base assigned still show under "Cattle" below (see
                      cattleOptions), so the farmer can select/track
                      those too. Buyer gets no list under the Cattle tab
                      at all - every listed-for-sale animal already shows
                      as a pin on the map preview itself (visibleCattleList
                      above), there's nothing to pick from a list for. */}
                  {isFarmerView && category === 'cattle' && baseOptions.length === 0 && cattleOptions.length === 0 && (
                    <div style={{ padding: '8px 14px', color: 'var(--color-muted)', fontSize: 12 }}>
                      Nothing to select yet.
                    </div>
                  )}

                  {isFarmerView && category === 'cattle' && baseOptions.length > 0 && (
                    <>
                      <div style={dropdownGroupLabelStyle}>Cattle Bases</div>
                      {baseOptions.map((b) => (
                        <button
                          key={`base-opt-${b.id}`}
                          onClick={() => {
                            onSelectTarget && onSelectTarget(b);
                            setPickerOpen(false);
                          }}
                          style={dropdownRowStyle}
                        >
                          <span style={{ fontSize: 15 }}>{'\u{1F3E0}'}</span>
                          <span style={{ fontSize: 13, color: 'var(--color-ink)' }}>{b.name}</span>
                        </button>
                      ))}
                    </>
                  )}

                  {isFarmerView && category === 'cattle' && cattleOptions.length > 0 && (
                    <>
                      <div style={{ ...dropdownGroupLabelStyle, marginTop: baseOptions.length > 0 ? 6 : 0 }}>Cattle</div>
                      {cattleOptions.map((c) => (
                        <button
                          key={`cattle-opt-${c.id}`}
                          onClick={() => {
                            onSelectTarget && onSelectTarget(c);
                            setPickerOpen(false);
                          }}
                          style={dropdownRowStyle}
                        >
                          <span style={{ fontSize: 13, color: 'var(--color-ink)' }}>{c.name}</span>
                        </button>
                      ))}
                    </>
                  )}

                  {category === 'crops' && (
                    fieldOptions.length === 0 ? (
                      <div style={{ padding: '8px 14px', color: 'var(--color-muted)', fontSize: 12 }}>
                        No fields nearby yet.
                      </div>
                    ) : (
                      fieldOptions.map((f) => (
                        <button
                          key={`field-opt-${f.id}`}
                          onClick={() => {
                            onSelectTarget && onSelectTarget(f);
                            setPickerOpen(false);
                          }}
                          style={dropdownRowStyle}
                        >
                          <span style={{ fontSize: 15 }}>🌾</span>
                          <span style={{ fontSize: 13, color: 'var(--color-ink)' }}>{f.name}</span>
                        </button>
                      ))
                    )
                  )}

                  {category === 'services' && (
                    serviceOptions.length === 0 ? (
                      <div style={{ padding: '8px 14px', color: 'var(--color-muted)', fontSize: 12 }}>
                        No services nearby yet.
                      </div>
                    ) : (
                      serviceOptions.map((s) => (
                        <button
                          key={`service-opt-${s.id}`}
                          onClick={() => {
                            onSelectTarget && onSelectTarget(s);
                            setPickerOpen(false);
                          }}
                          style={dropdownRowStyle}
                        >
                          <span style={{ fontSize: 15 }}>🚜</span>
                          <span style={{ fontSize: 13, color: 'var(--color-ink)' }}>{s.name}</span>
                        </button>
                      ))
                    )
                  )}

                  {category === 'ponds' && (
                    pondOptions.length === 0 ? (
                      <div style={{ padding: '8px 14px', color: 'var(--color-muted)', fontSize: 12 }}>
                        No ponds nearby yet.
                      </div>
                    ) : (
                      pondOptions.map((p) => (
                        <button
                          key={`pond-opt-${p.id}`}
                          onClick={() => {
                            onSelectTarget && onSelectTarget(p);
                            setPickerOpen(false);
                          }}
                          style={dropdownRowStyle}
                        >
                          <span style={{ fontSize: 15 }}>🐟</span>
                          <span style={{ fontSize: 13, color: 'var(--color-ink)' }}>{p.name}</span>
                        </button>
                      ))
                    )
                  )}
                </div>
              </>,
              document.body
            )}
          </div>

          {/* SHARE ICON ONLY */}
          <button
            onClick={handleShare}
            disabled={sharing}
            aria-label="Share"
            title="Share"
            style={{
              flexShrink: 0,
              width: 38,
              height: 38,
              padding: 0,
              borderRadius: 10,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-navy)',
              fontSize: 20,
              fontWeight: 700,
              cursor: sharing ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: sharing ? 0.5 : 1,
            }}
          >
            {sharing ? '\u2026' : '\u{1F4E4}'}
          </button>

        </div>
      </div>

      {/* REMOVED: local CattleDetailModal - see CattleMarker onClick
          above. Its "🎯 Locate on Map" date-scoped trail hand-off
          (handleViewTrailOnMap) is now unreachable from here too - that
          picker only lived inside this removed modal - but the always-on
          live GPS trail dots + zone circles rendered above (independent
          of any selected/opened cattle) are untouched. */}
    </div>
  );
}

function categoryCountLabel(category, counts) {
  switch (category) {
    case 'crops': return `${counts.crops} fields nearby`;
    case 'services': return `${counts.services} services nearby`;
    case 'ponds': return `${counts.ponds} ponds nearby`;
    case 'cattle':
    default: return `${counts.cattle} animals tracked`;
  }
}

const dropdownRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '7px 14px',
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const dropdownGroupLabelStyle = {
  margin: '2px 14px 2px',
  color: 'var(--color-muted)',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
};