// src/screens/HomeScreen.jsx
//
// Optimized Home Screen with Light-weight Supabase Fetch & Shared Realtime Channel.
// Excludes heavy GeoJSON/Base64 strings to reduce egress.
// NOTE: query previously referenced tag_number/status/location_lat/location_lng/
// user_id, none of which exist on `cattle` - fixed to real columns
// (owner_id, live_location) after confirming via information_schema.
//
// UPDATED: the four grid boxes (Cattle/Crops/IoT/Ponds) previously
// expanded inline, pushing the rest of the page down and forcing a
// scroll to see/close them. Replaced with a centered modal popup
// (matching the existing "Add Crop" dialog style already used
// elsewhere in the app) - dark backdrop, floating card, bold title +
// circular X button pinned to the card's own header. This is
// scroll-position-independent: it always opens centered on screen no
// matter where the page was scrolled to, and closes from one visible
// button. See Backdrop / Modal render block and openSections below.

import { useState, useEffect } from 'react';
import { supabase } from '../config/supabaseClient'; 
import MapPreviewCard from '../components/MapPreviewCard';
import FullMapModal from '../components/FullMapModal';
import CattleInfoPanel from '../components/CattleInfoPanel';
import FieldInfoPanel from '../components/FieldInfoPanel';
import IoTDevicesPanel from '../components/IoTDevicesPanel';
import PondsPanel from '../features/ponds/PondsPanel';
import WeatherCard from '../components/WeatherCard';
import { parseWkbPoint } from '../utils/geo';

export default function HomeScreen({ isFarmerView, user }) {
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [isFieldOpen, setIsFieldOpen] = useState(false);
  const [isIoTOpen, setIsIoTOpen] = useState(false);
  const [isPondsOpen, setIsPondsOpen] = useState(false);
  
  // Shared state across children
  const [cattleData, setCattleData] = useState([]);
  const [loading, setLoading] = useState(true);

  // ADDED: Cattle Bases (owner-registered), fetched once per user - same
  // columns/query ProfileScreen.jsx already uses for its own Bases list,
  // just a second read here so MapPreviewCard's new "Select" list can
  // offer Bases alongside individual Cattle without the two screens
  // sharing state. `location` is a PostGIS geography WKB-hex column,
  // parsed client-side the same way cattle live_location/geofence_center
  // already are (see MapPreviewCard.jsx / FullMapModal.jsx).
  const [cattleBasesData, setCattleBasesData] = useState([]);

  // ADDED: single source of truth for "what the farmer picked from the
  // Select list" - { type: 'base'|'cattle', id, position, name } or null.
  // Passed down to MapPreviewCard (to recenter its mini-map) and to
  // FullMapModal (to auto center+zoom once the full map opens).
  const [selectedTarget, setSelectedTarget] = useState(null);

  // ADDED: single source of truth for "which box is open, what's its
  // title, and how to close it" - drives the modal render below. Adding
  // a 5th box later only means adding one entry here.
  const openSections = [
    { key: 'info', isOpen: isInfoOpen, title: 'Cattle', close: () => setIsInfoOpen(false) },
    { key: 'field', isOpen: isFieldOpen, title: 'Crops', close: () => setIsFieldOpen(false) },
    { key: 'iot', isOpen: isIoTOpen, title: 'IoT Devices', close: () => setIsIoTOpen(false) },
    { key: 'ponds', isOpen: isPondsOpen, title: 'Ponds', close: () => setIsPondsOpen(false) },
  ];

  const activeSection = openSections.find((s) => s.isOpen);

  // ADDED: prevent the page behind the modal from scrolling while a
  // modal is open, same as the reference "Add Crop" dialog does.
  useEffect(() => {
    if (activeSection) {
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = previousOverflow;
      };
    }
  }, [activeSection]);

  // ADDED: Escape key closes the open modal, matching standard dialog
  // behavior (and the reference screenshot's dialog pattern).
  useEffect(() => {
    if (!activeSection) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        activeSection.close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeSection]);

useEffect(() => {
    let channel;
    // ADDED (auto-refresh fallback): guards so the new interval poll
    // below can't setState after unmount, and can't stack overlapping
    // in-flight fetches on a slow field connection.
    let cancelled = false;
    let fetchInFlight = false;

    // `silent` = called by the background poll, not by mount/realtime.
    // A silent run must NOT touch `loading` (otherwise the whole Home
    // cattle section would flash its loading state every 20 seconds)
    // and must NOT spam the TEMP DEBUG logs on a timer.
    const fetchCattle = async (silent = false) => {
      // Only the background poll skips itself when something is already
      // running - a real mount/realtime-triggered fetch must never be
      // silently dropped just because a poll happened to be mid-flight.
      if (silent && fetchInFlight) return;
      fetchInFlight = true;
      if (!silent) setLoading(true);
      // TEMP DEBUG - remove once root cause confirmed.
      if (!silent) console.log('[HomeScreen] fetchCattle starting, user =', JSON.stringify(user));

      // LIGHTWEIGHT QUERY: Select ONLY lightweight columns for Home display.
      // Excludes heavy 'geofence_center_geojson', 'live_location_geojson', base64 photos, etc.
      // NOTE: is_archived is selected (not displayed) so the realtime handler
      // below can tell an incoming UPDATE apart from an archive action -
      // see comment in the 'UPDATE' branch.
      // FIX: this select previously referenced tag_number, status,
      // location_lat, location_lng, and user_id - NONE of these exist
      // on the live `cattle` table (confirmed via information_schema),
      // so this query was failing with a 42703 error on every load and
      // silently returning an empty list (caught below, just logged).
      // Corrected to real columns: owner_id (not user_id) for
      // ownership, live_location (PostGIS geography, WKB hex over
      // PostgREST) in place of separate lat/lng floats. tag_number and
      // status have no equivalent live column - dropped for now.
      // ASSUMPTION: kept live_location in the select since
      // MapPreviewCard needs *some* position field to plot a pin -
      // flag if that's wrong or if there's a different intended field.
      // Widened after checking MapPreviewCard.jsx, which is fed by this
      // same fetch via the cattleData prop and needs geofence_center,
      // geofence_radius_m, local_image_path, marketplace_photo_url,
      // sale_price_min/max, and collar_id - all real live columns,
      // just missed in the first pass of this fix.
      // UPDATED: now reads from cattle_with_effective_geofence (a view
      // over `cattle` LEFT JOINed to cattle_bases, security_invoker=on so
      // RLS still applies per-user - see cattle_effective_geofence.sql)
      // instead of `cattle` directly. geofence_center/geofence_radius_m
      // are aliased from that view's effective_geofence_center/
      // effective_geofence_radius_m columns, which COALESCE the animal's
      // own geofence with its linked Base's location/radius when the
      // animal has none of its own. Aliased back to the original field
      // names so MapPreviewCard/CattleCard need no changes downstream.
      // UPDATED: added alert_radius_1_m/2_m/3_m (the Tier 1/2/3 alert
      // zones set in GeofenceSetupModal - needed by MapPreviewCard's
      // progressive zone circles + zone-colored dots line, see
      // src/utils/geoZones.js), updated_at (farmer-view-only "last seen"
      // timestamp shown in CattleDetailModal), and place_name
      // (farmer-view-only location name shown alongside it). None of
      // these were previously selected here, so MapPreviewCard silently
      // had no zone/timestamp/place data to work with even though its
      // own mapping code expected row.alert_radius_1_m etc.
      // FIX: this query used to run unconditionally regardless of
      // isFarmerView - Buyer view got the exact same
      // cattle_with_effective_geofence + owner_id=eq.${user.id} query as
      // Farmer view, meaning the Home mini-map never actually showed the
      // marketplace (every listed animal, across farmers) - it just
      // showed THIS farmer's own priced animals. FullMapModal.jsx's own
      // loadCattle already branches on this
      // (isFarmerView ? 'cattle' : 'cattle_public_view') - mirrored that
      // split here. MapPreviewCard.jsx's cattleList mapping already
      // anticipated this ("Buyer view (cattle_public_view): only
      // geofence_center exposed, no live pin.").
      // ASSUMPTION: cattle_public_view's RLS policy itself scopes rows to
      // every farmer's LISTED (is_listed_for_sale = true) cattle, same as
      // FullMapModal's buyer-view query relies on - no owner_id filter
      // applied here on purpose. Also added an explicit
      // is_listed_for_sale filter at the query level (belt-and-suspenders
      // with MapPreviewCard's own visibleCattleList filter) so an
      // unlisted animal's stale price fields can't leak it into the
      // buyer map even before the client-side filter runs. Flag if
      // cattle_public_view's real column names differ from what's
      // selected below - this was inferred from MapPreviewCard.jsx's
      // comments, not a confirmed schema.
      let query;

      if (isFarmerView) {
        query = supabase
          .from('cattle_with_effective_geofence')
          // FIX: is_listed_for_sale was missing from this select. CattleCard.jsx
          // gates BOTH the price display (`{isListed && salePriceMin != null && ...}`)
          // AND the Sell/Unlist button label on this exact column - without it,
          // isListed is always undefined, so the price never rendered on any
          // Home cattle card and the button always read "Sell", never "Unlist",
          // regardless of the animal's real listing state. sale_price_min/max
          // were already being selected correctly - only this one column was
          // missing.
          .select('id, name, animal_type, live_location, geofence_center:effective_geofence_center, geofence_radius_m:effective_geofence_radius_m, alert_radius_1_m, alert_radius_2_m, alert_radius_3_m, base_id, local_image_path, marketplace_photo_url, sale_price_min, sale_price_max, is_listed_for_sale, collar_id, owner_id, is_archived, updated_at, place_name')
          .or('is_archived.eq.false,is_archived.is.null');

        if (user?.id) {
          query = query.eq('owner_id', user.id);
        }
      } else {
        // BUYER VIEW: cross-farmer marketplace query, no owner_id filter.
        // No live_location/alert_radius/local_image_path/collar_id here -
        // those are farmer-only (owner's exact live GPS + private geofence
        // alert config + locally-cached photo), matching the "owner-only
        // data, never selected for buyer view rows" note already in
        // MapPreviewCard.jsx.
        // FIX: cattle_public_view has no is_archived column (confirmed via
        // the 42703 "column cattle_public_view.is_archived does not exist"
        // error this select/filter was causing on every buyer-view load,
        // silently breaking the marketplace fetch). Unlike the raw
        // `cattle` table used in Farmer view, this view's own definition
        // is presumably already scoped to exclude archived animals from
        // the marketplace - dropped both the column from select() and the
        // now-invalid .or() filter. Flag if archived cattle turn out to
        // still leak into buyer view; that would mean the view's
        // definition itself needs an archived-exclusion clause, not a
        // client-side filter here.
        // FIX: place_name ALSO doesn't exist on cattle_public_view (second
        // 42703 error, same root cause as is_archived above - this view's
        // real column set was never actually confirmed against
        // information_schema, just assumed to mirror the raw `cattle`
        // table). Dropped from select(). NOTE: every column here is now
        // an assumption, not a confirmed fact - if a third 42703 shows up
        // on another column (e.g. base_id), the fix is the same. Strongly
        // recommend running the same information_schema check already
        // done for the `cattle` table (see comment ~line 106) against
        // cattle_public_view directly, once, instead of finding its real
        // columns one 42703 at a time.
        query = supabase
          .from('cattle_public_view')
          .select('id, name, animal_type, geofence_center, base_id, marketplace_photo_url, sale_price_min, sale_price_max, is_listed_for_sale')
          .eq('is_listed_for_sale', true);
      }

      let data = null;
      let error = null;
      try {
        ({ data, error } = await query);
      } catch (err) {
        // Offline / network throw - treat exactly like a query error
        // below: keep whatever is already on screen, never blank it.
        error = err;
      } finally {
        fetchInFlight = false;
      }

      if (cancelled) return;

      // TEMP DEBUG - remove once root cause confirmed.
      if (!silent) console.log('[HomeScreen] fetchCattle result: error =', error ? JSON.stringify(error) : null, 'data =', JSON.stringify(data));
      if (!error && data) {
        setCattleData(data);
      } else if (error) {
        // A failed SILENT poll must stay quiet and leave the existing
        // list alone - it's just one missed 20s tick, the next one
        // retries. Only a real (mount/realtime) fetch failure is worth
        // an error-level log.
        if (silent) {
          console.warn('[HomeScreen] background cattle refresh failed, staying on current data:', error.message || error);
        } else {
          console.error("Error fetching cattle summary:", error.message);
        }
      }
      if (!silent) setLoading(false);
    };

    const subscribeToCattle = () => {
      // Single Realtime Subscription. Set up ONCE per mount - does not
      // get called again from inside its own event handler (that used to
      // be the plan, but re-subscribing a new channel on every single
      // realtime event would stack up duplicate channel subscriptions
      // with no cleanup until unmount. fetchCattle() is what re-runs per
      // event, this subscription itself does not).
      // FIX: previously had no filter at all, so INSERT/UPDATE/DELETE on
      // ANY farmer's cattle row would land in this user's local state.
      // Scoped to user_id to match the initial fetch above.
      //
      // FIX: INSERT/UPDATE used to splice `payload.new` directly into
      // state. Realtime payloads come from the raw `cattle` table's
      // logical replication stream - real column names, RAW values - not
      // from cattle_with_effective_geofence. So payload.new.geofence_center
      // is the animal's own value only, never Base-inherited. Splicing it
      // in directly would work fine for animals with their own geofence,
      // but for a Base-linked animal with none of its own, the very next
      // realtime event (even one unrelated to location, e.g. a name edit)
      // would silently replace a correctly Base-inherited pin with null
      // until the next full remount. Re-running fetchCattle() instead
      // means every update - realtime or initial - goes through the same
      // view and gets the same fallback treatment, at the cost of a
      // network round-trip per event instead of a free local splice
      // (same tradeoff CattleInfoPanel.jsx already makes for its own
      // realtime handler).
      // FIX: this used to be a stable per-user name
      // (`cattle_home_changes_${user.id}`) with no per-mount suffix -
      // every mount of this component reused the exact same channel
      // name. In dev, React StrictMode mounts -> cleans up -> re-mounts
      // every component once intentionally. removeChannel() on cleanup
      // is async (it tears down the underlying websocket subscription),
      // so the StrictMode re-mount's supabase.channel(...) call could
      // land BEFORE that teardown finished, get back the same
      // already-subscribed channel object from supabase-js's internal
      // registry, and then crash on .subscribe() with "cannot add
      // postgres_changes callbacks ... after subscribe()" - an unhandled
      // promise rejection that left the channel broken (no realtime
      // updates) and caused connection churn that looked like an
      // infinite request loop. CattleInfoPanel.jsx/FieldInfoPanel.jsx/
      // IoTDevicesPanel.jsx/PondsPanel.jsx already avoid this by
      // appending a random suffix per mount - matched that pattern here.
      channel = supabase
        .channel(`cattle_home_changes_${user?.id ?? 'anon'}_${Math.random().toString(36).slice(2)}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'cattle', filter: `owner_id=eq.${user?.id}` },
          (payload) => {
            if (payload.eventType === 'DELETE') {
              // No fallback data needed to remove a row - id is enough,
              // and it's already present on payload.old regardless of
              // which table/view the replication stream is on.
              setCattleData((prev) => prev.filter((item) => item.id !== payload.old.id));
            } else if (payload.eventType === 'UPDATE') {
              // FIX: this used to splice ONLY live_location/updated_at
              // from payload.new into the cached row, discarding every
              // other field on the row - so editing anything in
              // EditCattleModal/AddCattleForm's post-insert photo/QC
              // update (name, breed, govt_inaph_id, weight, contact info,
              // photo/cert URL, etc.) saved correctly to the DB but the
              // in-memory cattleData here kept showing the OLD value for
              // that field. Reopening Edit right after Save re-prefilled
              // from this stale cached row, looking exactly like the edit
              // "didn't stick" even though the DB always had it right.
              // Root cause is the same one already called out in the
              // comment above (~line 118): payload.new comes straight off
              // the raw `cattle` table's replication stream, not the
              // cattle_with_effective_geofence view, so it can't be
              // spliced in directly for Base-linked geofence data either.
              // fetchCattle() re-runs everything - every edited field,
              // not just location - through that same view, same as
              // INSERT below already does, for the same reason.
              const changed = payload.new;

              if (changed?.is_archived) {
                setCattleData((prev) =>
                  prev.filter((item) => item.id !== changed.id)
                );
                return;
              }

              // OPTIMIZED: most realtime UPDATEs on this table are LoRa
              // collar location pings, one per animal every few
              // seconds/minutes. Running a full fetchCattle() (re-querying
              // cattle_with_effective_geofence for the WHOLE list) on
              // every single ping was wasted network/DB work when
              // payload.new already carries the new location. This
              // mirrors the local-patch optimization FullMapModal.jsx
              // already does for its own realtime handler.
              //
              // payload.new comes off the raw `cattle` table (see comment
              // above), so its geofence_center/geofence_radius_m are the
              // animal's OWN values only, never Base-inherited. We
              // deliberately never read or patch those two fields here -
              // only fields that map 1:1 from the raw table to our
              // view-backed select() are compared below. If none of
              // those differ, this is safely a location-only ping and we
              // patch live_location/updated_at/place_name straight into
              // the cached row, no network round-trip. If ANY of them
              // differ (a real edit - name, breed, listing, etc.), fall
              // back to fetchCattle() so the effective-geofence view
              // (and Base fallback) is re-resolved correctly, same as
              // before.
              //
              // KNOWN LIMITATION: an edit made ONLY through
              // GeofenceSetupModal - i.e. the animal's own geofence_center/
              // geofence_radius_m changes and nothing in COMPARE_FIELDS
              // changes - won't be caught by this comparison and will be
              // missed until the next fetch/remount, since we have no
              // cached raw geofence value to diff against (only the
              // resolved "effective" one). Flag if this needs closing -
              // it would mean selecting the raw, non-effective geofence
              // columns alongside the aliased ones purely to diff
              // against, never rendering them.
              let needsFullFetch = false;
              setCattleData((prev) => {
                const idx = prev.findIndex((item) => item.id === changed.id);

                // Not in cache yet - unlikely for UPDATE (vs INSERT) but
                // safest to fetch rather than risk missing this row.
                if (idx === -1) {
                  needsFullFetch = true;
                  return prev;
                }

                const existing = prev[idx];
                const COMPARE_FIELDS = [
                  'name',
                  'animal_type',
                  'base_id',
                  'local_image_path',
                  'marketplace_photo_url',
                  'sale_price_min',
                  'sale_price_max',
                  'is_listed_for_sale',
                  'collar_id',
                  'alert_radius_1_m',
                  'alert_radius_2_m',
                  'alert_radius_3_m',
                ];
                const isLocationOnly = COMPARE_FIELDS.every(
                  (field) => existing[field] === changed[field]
                );

                if (!isLocationOnly) {
                  needsFullFetch = true;
                  return prev;
                }

                const next = [...prev];
                next[idx] = {
                  ...existing,
                  live_location: changed.live_location,
                  updated_at: changed.updated_at,
                  place_name: changed.place_name,
                };
                return next;
              });

              if (needsFullFetch) {
                fetchCattle();
              }
            } else if (payload.eventType === 'INSERT') {
              // INSERT needs the effective-geofence view so Base fallback
              // data is resolved correctly.
              fetchCattle();
            }
          }
        )
        .subscribe((status, err) => {
          // DEBUG: postgres_changes fails SILENTLY with no thrown error
          // if Realtime replication isn't enabled for the `cattle` table
          // on the Supabase dashboard (Database -> Replication) - the
          // channel just sits there never firing. Same diagnostic
          // FullMapModal.jsx already logs; added here because a dead
          // channel here is exactly what made Home's map preview look
          // frozen until an app close/reopen. Look for 'SUBSCRIBED' in
          // the console after Home loads in farmer view.
          if (cancelled) return;
          if (status === 'SUBSCRIBED') {
            console.log('[HomeScreen] cattle realtime connected');
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            console.warn('[HomeScreen] cattle realtime subscription problem:', status, err);
          }
        });
    };

    const fetchAndSubscribeCattle = async () => {
      await fetchCattle();
      // FIX: this used to subscribe unconditionally. The channel above
      // is filtered by `owner_id=eq.${user.id}` - that only makes sense
      // for Farmer view's own-cattle query. Buyer view's cattle_public_view
      // query is a cross-farmer marketplace read with no single owner_id
      // to filter on, so subscribing here would either miss other
      // farmers' listing changes entirely or (if the filter were removed)
      // fire on every farmer's every cattle row, most of which aren't
      // even listed. Buyer view falls back to a plain fetch-on-mount/
      // view-change instead, same trade-off already made for
      // cattleBasesData below ("Bases change rarely... no realtime
      // channel"). TODO: revisit if live-updating marketplace listings
      // becomes a real requirement - would need its own differently-
      // filtered channel (e.g. on is_listed_for_sale rather than owner_id).
      if (isFarmerView) {
        subscribeToCattle();
      }
    };

    // TEMP DEBUG - remove once root cause confirmed.
    console.log('[HomeScreen] mount/effect run, user?.id =', user?.id, 'isFarmerView =', isFarmerView);
    if (user?.id) {
      fetchAndSubscribeCattle();
    } else {
      console.log('[HomeScreen] SKIPPING fetch - user.id is missing');
      setLoading(false);
    }

    // ADDED: 20s background refresh - the fix for "Home map preview
    // only updates if I close and reopen the app".
    //
    // MapPreviewCard has no fetch of its own by design (see its header
    // comment) - it renders whatever `cattleData` this effect puts in
    // state. Before this, that state only ever changed on mount or on a
    // realtime push, and BOTH of those have gaps:
    //   - Farmer view: the postgres_changes channel above is the only
    //     live path, so if Realtime replication is off for `cattle`, or
    //     the websocket quietly drops (app backgrounded on mobile, dead
    //     zone, network switch), no push ever lands again and the
    //     preview freezes until a full remount. That remount is exactly
    //     what closing/reopening the app was doing.
    //   - Buyer view: subscribeToCattle() is deliberately never called
    //     (see the comment in fetchAndSubscribeCattle), so there was NO
    //     refresh path at all beyond mount.
    // This mirrors FullMapModal.jsx's own buyer poll (setInterval 20000,
    // same cadence) so the two screens now agree.
    //
    // Runs in BOTH views: it's a fallback under realtime in farmer view
    // (harmless duplicate work at worst - a refetch just re-sets the
    // same rows), and the only refresh in buyer view. Skipped while the
    // tab/app is hidden so a backgrounded app isn't polling Supabase on
    // a timer; the visibilitychange handler fires one immediate catch-up
    // fetch on return, which also covers the "resumed from background,
    // websocket is stale" case directly.
    let intervalId;
    let onVisibilityChange;
    if (user?.id) {
      const pollCattle = () => {
        if (cancelled) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        fetchCattle(true);
      };
      intervalId = setInterval(pollCattle, 20000);

      onVisibilityChange = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
          pollCattle();
        }
      };
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibilityChange);
      }
    }

    // Cleanup realtime channel on unmount
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      if (onVisibilityChange && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [user?.id, isFarmerView]);

  // ADDED: fetch this farmer's Cattle Bases for the new Select list.
  // Bases change rarely (added/edited from ProfileScreen, not from
  // Home) so a plain fetch-on-mount/user-change is enough - no realtime
  // channel, matching how ProfileScreen itself treats this same table.
  useEffect(() => {
    if (!user?.id) {
      setCattleBasesData([]);
      return;
    }
    let cancelled = false;

    const fetchBases = async () => {
      const { data, error } = await supabase
        .from('cattle_bases')
        .select('id, base_name, location')
        .eq('owner_id', user.id);

      if (cancelled) return;
      if (error) {
        console.error('[HomeScreen] Error fetching cattle bases:', error.message);
        return;
      }
      setCattleBasesData(data || []);
    };

    fetchBases();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        background: 'var(--color-bg)',
      }}
    >
            <MapPreviewCard
        isFarmerView={isFarmerView}
        cattleData={cattleData}
        cattleBasesData={cattleBasesData}
        loading={loading}
        selectedTarget={selectedTarget}
        onSelectTarget={setSelectedTarget}
        onOpen={() => setIsMapOpen(true)}
      />

      {/* 2x2 Home grid - Cattle/Crop/IoT/Pond. Shown for BOTH Farmer and
          Buyer views (reverted the earlier farmer-only gate) - the
          Farmer/Buyer distinction now lives in MapPreviewCard's
          category selector instead, not in hiding these panels. Each
          panel component itself still needs to handle isFarmerView
          internally (e.g. a clean "Nothing listed for sale yet" empty
          state instead of rendering nothing) - that's a separate fix
          per panel (FieldInfoPanel.jsx etc.), not something removing
          the grid here should paper over. Each box is now just a
          compact tap target (title + count + its own quick-action
          button like "+ Add"); tapping the title/chevron opens that
          panel's content in the centered modal below instead of
          expanding inline. This is what actually fixes the "have to
          scroll to see/close the opened section" problem - the modal
          is fixed to the viewport, independent of how far this grid
          has been scrolled. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
        }}
      >
        <div style={gridSectionStyle('var(--color-navy)')}>
          <CattleInfoPanel
            isFarmerView={isFarmerView}
            cattleData={cattleData}
            loading={loading}
            isOpen={isInfoOpen}
            onToggle={() => setIsInfoOpen((v) => !v)}
          />
        </div>

        <div style={gridSectionStyle('var(--color-success, #2e8b57)')}>
          <FieldInfoPanel
            isFarmerView={isFarmerView}
            isOpen={isFieldOpen}
            onToggle={() => setIsFieldOpen((v) => !v)}
          />
        </div>

        {/* ASSUMPTION: no confirmed brand color for IoT/Pond yet (only
            navy/gold are confirmed brand colors) - using gold for IoT
            (matches the existing "+ Add Device" gold buttons already in
            IoTDevicesPanel) and a plain blue for Pond (visually distinct
            from the other three, common "water" association) - flag if
            a real Pond accent color is wanted instead. */}
        <div style={gridSectionStyle('var(--color-gold)')}>
          <IoTDevicesPanel
            isFarmerView={isFarmerView}
            isOpen={isIoTOpen}
            onToggle={() => setIsIoTOpen((v) => !v)}
          />
        </div>

        <div style={gridSectionStyle('#1976d2')}>
          <PondsPanel
            isFarmerView={isFarmerView}
            isOpen={isPondsOpen}
            onToggle={() => setIsPondsOpen((v) => !v)}
          />
        </div>
      </div>

      <WeatherCard />

      {isMapOpen && (
        <FullMapModal
          isFarmerView={isFarmerView}
          cattleData={cattleData}
          selectedTarget={selectedTarget}
          onClose={() => setIsMapOpen(false)}
        />
      )}

      {/* ADDED: centered modal popup for whichever grid box is open -
          dark backdrop + floating card, matching the app's existing
          "Add Crop" dialog style (bold title left, circular X right,
          scrollable body). Tapping the backdrop or the X closes it. */}
      {activeSection && (
        <div
          onClick={activeSection.close}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            // Was 100 - too low. Map libraries (Leaflet/Google Maps)
            // set their own internal z-index on tiles/controls/popups,
            // commonly in the 400-1000+ range, which was rendering
            // ABOVE this backdrop and letting MapPreviewCard bleed
            // through the modal instead of sitting behind it. Pushed
            // comfortably above any known map-library z-index.
            zIndex: 5000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 420,
              maxHeight: '85vh',
              overflowY: 'auto',
              position: 'relative',
              borderRadius: 16,
              background: 'var(--color-card, #fff)',
              boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
            }}
          >
            {/* Matches the existing app convention already used by every
                panel's own "+Add" popup (AddCropForm/DeviceForm/
                AddFishStockForm close buttons) - same size, position,
                and style, so this reads as consistent with the rest of
                the app instead of a one-off new pattern. */}
            <button
              type="button"
              onClick={activeSection.close}
              aria-label={`Close ${activeSection.title}`}
              style={{
                position: 'absolute',
                top: 10,
                right: 10,
                width: 28,
                height: 28,
                borderRadius: '50%',
                border: 'none',
                background: 'var(--color-border)',
                color: 'var(--color-ink)',
                fontWeight: 700,
                cursor: 'pointer',
                lineHeight: 1,
                zIndex: 1,
              }}
            >
              ✕
            </button>

            {activeSection.key === 'info' && (
              <CattleInfoPanel
                isFarmerView={isFarmerView}
                cattleData={cattleData}
                loading={loading}
                isOpen={true}
                onToggle={activeSection.close}
              />
            )}
            {activeSection.key === 'field' && (
              <FieldInfoPanel
                isFarmerView={isFarmerView}
                isOpen={true}
                onToggle={activeSection.close}
              />
            )}
            {activeSection.key === 'iot' && (
              <IoTDevicesPanel
                isFarmerView={isFarmerView}
                isOpen={true}
                onToggle={activeSection.close}
              />
            )}
            {activeSection.key === 'ponds' && (
              <PondsPanel
                isFarmerView={isFarmerView}
                isOpen={true}
                onToggle={activeSection.close}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Wraps each of the 4 Home boxes with a colored top accent, so Cattle/
// Crop/IoT/Pond read as distinct sections in their collapsed grid tile.
// No longer needs an isOpen param - opened content now renders in the
// modal above instead of expanding this tile.
function gridSectionStyle(accentColor) {
  return {
    borderRadius: 12,
    overflow: 'hidden',
    borderTop: `4px solid ${accentColor}`,
    background: 'var(--color-card)',
  };
}

function baseChipStyle(active) {
  return {
    flexShrink: 0,
    padding: '8px 14px',
    borderRadius: 20,
    border: `2px solid ${active ? 'var(--color-gold)' : 'var(--color-border)'}`,
    background: active ? 'rgba(222, 160, 59, 0.18)' : 'var(--color-card)',
    color: 'var(--color-ink)',
    fontSize: 13,
    fontWeight: 700,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  };
}