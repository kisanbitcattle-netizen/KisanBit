// src/components/CattleDetailModal.jsx
//
// EXPANDED: tapping a cattle marker/card now shows the full profile —
// breed, age (computed from birth date), calving count, geofence
// radius, for-sale status, and recent health records — not just
// photo/price/rating. The only things intentionally left out are
// internal database identifiers (raw id, collar_id, tag_deveui/LoRa
// DevEUI) since those are plumbing, not information a farmer or buyer
// needs to see.
//
// PRIVACY: direct Call/WhatsApp buttons are gone - replaced by a
// "Chat with Seller" button that opens ChatModal (listingType='cattle').
// The seller shares their own number from inside the chat when they
// choose to; buyers never see it up front anymore. Not shown at all
// to the listing's own owner (there's no "chat with yourself").
//
// FIXED: the Chat button used to render as soon as the component
// mounted (isOwner defaulted to false before the async
// supabase.auth.getUser() call resolved), so on the owner's OWN
// listing it would flash visible for a moment before disappearing -
// and tapping it during that window hit the server-side "You cannot
// start a chat on your own listing" rejection. Added ownerCheckDone
// so the button waits for the ownership check to actually finish
// before rendering at all, instead of rendering-then-hiding.
//
// GPS HISTORY: farmer-view-only "History" section lets a farmer pick a
// past date (or leave it on the rolling-last-24-hours default) and see
// how many location fixes exist for it. There is deliberately NO map
// drawn inside this modal - a map this small is hard to zoom/pan
// usefully. Instead "Locate on Map" hands the cattle id + picked date +
// last known point up to the parent via onViewTrailOnMap, so the
// already-zoomable FullMapModal/MapPreviewCard can jump straight to it -
// this is also the "animal went missing, just show me its last fix"
// path, and needs no date picked at all to work.

import { useEffect, useState } from 'react';
import { supabase } from '../config/supabaseClient';
import { ANIMAL_EMOJI } from './CattleMarker';
import { shareCattleCard } from '../utils/shareCard';
import { fetchCattleTrail, todayLocalDateString } from '../utils/cattleTrail';
import { parseWkbPoint } from '../utils/geo';
import ChatModal from '../features/messaging/ChatModal';


// ADDED: last-ping LoRa signal strength -> a farmer-readable label.
// Same thresholds as CattleCard.jsx's signalStrengthLabel (kept as a
// small duplicated helper here rather than a shared import, matching
// this file's existing pattern of its own local ageFromBirthDate rather
// than importing CattleCard's copy) - untuned LoRa ballparks, flag if
// field data suggests different thresholds.
function signalStrengthLabel(rssi) {
  if (rssi == null) return null;
  if (rssi >= -85) return { text: 'Strong', bars: '📶' };
  if (rssi >= -105) return { text: 'OK', bars: '📶' };
  return { text: 'Weak', bars: '📶' };
}

// Computes a human-readable age string from a birth_date (YYYY-MM-DD).
function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let months = (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
  if (now.getDate() < birth.getDate()) months -= 1;
  if (months < 0) return null;
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'}`;
}

function RecentHealth({ cattleId }) {
  const [records, setRecords] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data } = await supabase
        .from('cattle_health_records')
        .select('id, record_type, description, recorded_date')
        .eq('cattle_id', cattleId)
        .order('recorded_date', { ascending: false })
        .limit(3);
      if (!cancelled) setRecords(data || []);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [cattleId]);

  if (records.length === 0) return null;

  return (
    <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, marginTop: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-navy)', marginBottom: 6 }}>Recent Health Records</div>
      {records.map((r) => (
        <div key={r.id} style={{ fontSize: 12, padding: '4px 0' }}>
          <strong style={{ textTransform: 'capitalize' }}>{r.record_type}</strong>
          {r.description ? `: ${r.description}` : ''}
          <span style={{ color: 'var(--color-muted)', marginLeft: 6 }}>
            ({new Date(r.recorded_date).toLocaleDateString('en-IN')})
          </span>
        </div>
      ))}
    </div>
  );
}

function Stars({ value, onRate, size = 20 }) {
  const [hovered, setHovered] = useState(null);
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          onClick={() => onRate && onRate(n)}
          onMouseEnter={() => onRate && setHovered(n)}
          onMouseLeave={() => onRate && setHovered(null)}
          style={{
            fontSize: size,
            cursor: onRate ? 'pointer' : 'default',
            color: n <= (hovered ?? value ?? 0) ? 'var(--color-gold)' : '#ddd',
          }}
        >
          ★
        </span>
      ))}
    </div>
  );
}

function OwnershipHistory({ cattleId }) {
  const [history, setHistory] = useState([]);

  // NOTE: dependency array was already correct ([cattleId], so this
  // only re-runs when the cattle actually changes - no loop risk).
  // Narrowed the select to the 4 columns actually rendered below and
  // added a `cancelled` guard for unmount safety.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data } = await supabase
        .from('cattle_ownership_history')
        .select('id, owner_name, from_date, to_date')
        .eq('cattle_id', cattleId)
        .order('from_date', { ascending: true });
      if (!cancelled) setHistory(data || []);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [cattleId]);

  if (history.length === 0) return null;

  const ordinal = (idx) => {
    if (idx === 0) return '1st';
    if (idx === 1) return '2nd';
    if (idx === 2) return '3rd';
    return `${idx + 1}th`;
  };

  return (
    <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, marginTop: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-navy)', marginBottom: 6 }}>Ownership History</div>
      {history.map((h, idx) => (
        <div key={h.id} style={{ fontSize: 12, padding: '4px 0' }}>
          <strong>{ordinal(idx)} owner:</strong> {h.owner_name}
          <span style={{ color: 'var(--color-muted)', marginLeft: 6 }}>
            ({new Date(h.from_date).toLocaleDateString('en-IN')} – {h.to_date ? new Date(h.to_date).toLocaleDateString('en-IN') : 'Present'})
          </span>
        </div>
      ))}
    </div>
  );
}

export default function CattleDetailModal({ cattle, onClose, isLiked, onToggleLike, hideBreedingToggle = false, isFarmerView = false, onViewTrailOnMap }) {
  const {
    id,
    name,
    animalType,
    localImageUri,
    marketplacePhotoUrl,
    salePriceMin,
    salePriceMax,
    averageRating,
    ratingCount,
    breed,
    calvingCount,
    geofenceRadiusM,
    isListedForSale,
  } = cattle;

  const age = ageFromBirthDate(cattle.birthDate ?? cattle.birth_date);

  // Farmer-view-only: last-seen timestamp + a "Go" link straight into
  // Google Maps for whatever position this animal's pin is actually
  // showing right now (live GPS fix if there is one, else its
  // geofence/base fallback - same displayPosition FullMapModal/
  // MapPreviewCard already compute; never shown to buyers, who have no
  // live position anyway - see loadCattle in FullMapModal).
  // The animal's single most recent GPS fix ever recorded, independent of
  // the "only counts if it's from today" gate the live pin uses - fetched
  // unconditionally (not gated behind History being opened) so the "Go"
  // button always has it ready. Declared here, before mapPosition below,
  // because mapPosition reads it immediately on first render.
  const [lastKnownPosition, setLastKnownPosition] = useState(null);

  const lastSeenAt = cattle.updatedAt ?? cattle.updated_at;
  // FIX: this used to be `cattle.displayPosition ?? cattle.liveLocation ??
  // cattle.geofenceCenter` - but displayPosition is computed by the PARENT
  // (FullMapModal/MapPreviewCard) and already falls back to the Base
  // location whenever there's no live fix FROM TODAY (see loadCattle's
  // isFromToday gate there) - so "Go" would silently open directions to
  // Base any time the collar hadn't reported today, even if the animal
  // has a perfectly good fix from yesterday sitting in
  // cattle_location_history. lastKnownPosition (below) is fetched
  // straight from that history table, independent of the today-only gate,
  // so "Go" now means "take me to wherever it actually was last seen",
  // matching what the last-seen timestamp next to this button says.
  const mapPosition = lastKnownPosition ?? cattle.liveLocation ?? cattle.displayPosition ?? cattle.geofenceCenter;
  const googleMapsUrl = mapPosition
    ? `https://www.google.com/maps/dir/?api=1&destination=${mapPosition[0]},${mapPosition[1]}`
    : null;

  function formatLastSeen(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // Government cattle ID (INAPH) — the parent screen's cattle object may
  // hand this to us in either casing depending on where it was fetched.
  const govtId = cattle.govtInaphId ?? cattle.govt_inaph_id;
  const cattleContactPhone = cattle.contactPhone ?? cattle.contact_phone;
  const cattleContactWhatsapp = cattle.contactWhatsapp ?? cattle.contact_whatsapp;
  const ownerId = cattle.ownerId ?? cattle.owner_id;
  // ADDED: farmer-only collar signal telemetry, same tolerate-either-
  // casing pattern as govtId/ownerId above.
  const lastRssi = cattle.lastRssi ?? cattle.last_rssi;
  const lastSnr = cattle.lastSnr ?? cattle.last_snr;
  const signal = signalStrengthLabel(lastRssi);
  const baseId = cattle.baseId ?? cattle.base_id;
  // Cattle's own place_name (set at Add-Cattle time from its own pinned
  // point) is the fallback when there's no linked Base - see
  // placeName resolution below, which prefers the Base's place_name
  // once/if that fetch resolves.
  const ownPlaceName = cattle.placeName ?? cattle.place_name;

  const [myRating, setMyRating] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [liveAverage, setLiveAverage] = useState(averageRating);
  const [liveCount, setLiveCount] = useState(ratingCount);
  const [ownerContact, setOwnerContact] = useState(null); // { phone } from users table
  const [sharing, setSharing] = useState(false);
  const [liking, setLiking] = useState(false);
  const [currentUserId, setCurrentUserId] = useState(null);
  // True once the async ownership check below has actually resolved.
  // The owner-gated Chat button waits on this instead of just on
  // isOwner, so it never renders-then-hides on the owner's own listing
  // (see FIXED note at top of file).
  const [ownerCheckDone, setOwnerCheckDone] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // Resolved "place" for the share card: the linked Base's place_name
  // wins once that fetch resolves; starts at the cattle's own point so
  // there's still something to show immediately / if there's no Base.
  const [placeName, setPlaceName] = useState(ownPlaceName || null);
  // Mirrors FullMapModal's mapping (breedingReady) / a raw DB row
  // (is_breeding_ready) - same tolerate-either-casing pattern as
  // ownerId/baseId above. Kept in local state (not read fresh from
  // `cattle` on every render) so the toggle below reflects the write
  // immediately without waiting on the parent to refetch and re-pass
  // props.
  const [isBreedingReady, setIsBreedingReady] = useState(
    !!(cattle.breedingReady ?? cattle.is_breeding_ready)
  );
  const [breedingBusy, setBreedingBusy] = useState(false);

  // History (GPS trail) - farmer-view-only, same gating as the
  // last-seen/Go row below. Collapsed by default (no trail fetch at
  // all until the farmer actually asks for it) so opening this modal
  // never costs an extra query for animals nobody checks history on.
  const [showHistory, setShowHistory] = useState(false);
  // null = rolling last-24-hours (the default "today" view - see
  // cattleTrail.js for why this is a rolling window, not a calendar
  // day). Any 'YYYY-MM-DD' string = History picker's explicit day.
  const [historyDate, setHistoryDate] = useState(null);
  const [trailPoints, setTrailPoints] = useState([]);
  const [trailLoading, setTrailLoading] = useState(false);

  const isLikeable = typeof onToggleLike === 'function';
  const isOwner = !!currentUserId && !!ownerId && currentUserId === ownerId;
  // Number shared inside the chat, once the seller taps "+ Share Phone
  // Number" - passed straight through to ChatModal, which only shows
  // Call/WhatsApp once is_number_shared is true on the conversation.
  const chatSellerPhone = cattleContactWhatsapp || cattleContactPhone || ownerContact?.phone || null;

  const handleLikeClick = async () => {
    if (liking || !isLikeable) return;
    setLiking(true);
    await onToggleLike(cattle);
    setLiking(false);
  };

  const photoSrc = localImageUri || marketplacePhotoUrl;

  // FIX: this used to be four separate useEffects, each with its own
  // supabase.auth.getUser() and/or fetch, keyed off different pieces of
  // `cattle` (ownerId, baseId, id) - which meant switching cattle fast
  // (e.g. tapping through markers on the map) could fire overlapping,
  // out-of-order fetches for the previous AND next animal, and the
  // owner-check's own auth.getUser() call was duplicated again inside
  // loadMyRating below it. Consolidated into one effect, keyed on the
  // single value that actually identifies "which animal is this modal
  // showing" (cattle?.id), so it can never fire twice for the same
  // cattle and always fully re-runs (and cancels the in-flight one)
  // when the cattle changes. The three data fetches that don't depend
  // on each other (owner contact, base place, my rating) run in
  // parallel via Promise.all instead of as separate effects; the
  // owner-check's auth.getUser() call runs once up front and its result
  // is reused for the rating fetch too, instead of asking twice.
  useEffect(() => {
    let isMounted = true;

    async function loadAll() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!isMounted) return;
      setCurrentUserId(user?.id ?? null);
      setOwnerCheckDone(true);

      const [ownerContactResult, basePlaceResult, ratingResult] = await Promise.all([
        // Contact info isn't on the cattle row itself - it belongs to
        // the owner's profile. Always fetched when there's an ownerId
        // (the share card needs the owner's full_name regardless of
        // whether the cattle row already has its own contact_phone).
        ownerId
          ? supabase.from('users').select('phone, full_name').eq('id', ownerId).maybeSingle()
          : Promise.resolve({ data: null }),
        // Base's place_name wins over the cattle's own pinned point
        // (Base is the more deliberate/curated location). Only fetched
        // when there IS a base_id; otherwise placeName just stays at
        // its ownPlaceName initial value from useState above.
        baseId
          ? supabase.from('cattle_bases').select('place_name').eq('id', baseId).maybeSingle()
          : Promise.resolve({ data: null }),
        user
          ? supabase.from('cattle_ratings').select('rating').eq('cattle_id', id).eq('rater_id', user.id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      if (!isMounted) return;
      if (ownerContactResult.data) setOwnerContact(ownerContactResult.data);
      if (basePlaceResult.data?.place_name) setPlaceName(basePlaceResult.data.place_name);
      if (ratingResult.data) setMyRating(ratingResult.data.rating);
    }

    loadAll();

    return () => {
      isMounted = false;
    };
  }, [cattle?.id]);

  // Fetches only when History is actually open - not on every modal
  // open - and re-fetches whenever the picked date changes. Cancelled
  // guard mirrors the pattern already used by the owner/base/rating
  // effect above, for the same reason: switching cattle or toggling
  // History quickly shouldn't let a slow, stale fetch land after a
  // newer one already resolved.
  // Fetches only when History is actually open - not on every modal
  // open - and re-fetches whenever the picked date changes. Cancelled
  // guard mirrors the pattern already used by the owner/base/rating
  // effect above, for the same reason: switching cattle or toggling
  // History quickly shouldn't let a slow, stale fetch land after a
  // newer one already resolved. Only the points themselves are kept
  // here - this modal no longer draws the trail itself (see
  // "Locate on Map" below), it just needs the last point's coordinates
  // to hand off to whichever full map is showing.
  useEffect(() => {
    if (!showHistory || !id) return;
    let cancelled = false;
    setTrailLoading(true);
    (async () => {
      const points = await fetchCattleTrail(
        supabase,
        id,
        historyDate ? { date: historyDate } : { mode: 'rolling24h' }
      );
      if (cancelled) return;
      setTrailPoints(points);
      setTrailLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [showHistory, historyDate, id]);

  // Cheap, single-row fetch (not gated behind showHistory like the trail
  // above) - just the latest recorded_at fix for this animal, so "Go"
  // works correctly the moment the modal opens, without the farmer having
  // to tap "History" first.
  useEffect(() => {
    if (!isFarmerView || !id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('cattle_location_history')
        .select('location')
        .eq('cattle_id', id)
        .order('recorded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled && data?.location) {
        setLastKnownPosition(parseWkbPoint(data.location));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isFarmerView, id]);

  const handleShare = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      await shareCattleCard({ ...cattle, ownerName: ownerContact?.full_name, ownerVillage: placeName });
    } catch (err) {
      alert('Could not create share card: ' + err.message);
    } finally {
      setSharing(false);
    }
  };

  const handleRate = async (rating) => {
    setSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        alert('Please log in to rate.');
        return;
      }

      await supabase
        .from('cattle_ratings')
        .upsert({ cattle_id: id, rater_id: user.id, rating }, { onConflict: 'cattle_id,rater_id' });

      setMyRating(rating);

      const { data } = await supabase
        .from('cattle_ratings')
        .select('rating')
        .eq('cattle_id', id);
      if (data && data.length > 0) {
        const avg = data.reduce((sum, r) => sum + r.rating, 0) / data.length;
        setLiveAverage(Math.round(avg * 10) / 10);
        setLiveCount(data.length);
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Owner-only: writes is_breeding_ready on the cattle row directly (no
  // parent onSaved/onChanged callback exists on this modal's props, unlike
  // EditCattleModal/CattleCard's flow - so this updates local state after
  // a successful write rather than relying on the parent to refetch and
  // re-pass an updated cattle prop).
  const handleToggleBreedingReady = async () => {
    if (breedingBusy || !isOwner) return;
    setBreedingBusy(true);
    const next = !isBreedingReady;
    const { error } = await supabase
      .from('cattle')
      .update({ is_breeding_ready: next })
      .eq('id', id);
    setBreedingBusy(false);
    if (error) {
      alert('Could not update breeding status: ' + error.message);
      return;
    }
    setIsBreedingReady(next);
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 4500, background: 'rgba(20,24,40,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={onClose}
    >
      {/* Fixed 9:16 card shell, matching ServiceDetailModal.jsx: a
          flexShrink:0 hero strip up top, everything else in a scrollable
          flex:1 body below it - so the card is a consistent shape no
          matter how much profile/health/history content a given animal
          has. */}
      <div
        className="kb-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 360, aspectRatio: '9 / 16', maxHeight: '85vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div
          style={{
            flexShrink: 0,
            height: 84,
            background: photoSrc ? `url(${photoSrc}) center/cover` : 'var(--color-bg)',
            display: photoSrc ? 'block' : 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 36,
          }}
        >
          {!photoSrc && (ANIMAL_EMOJI[animalType] || '?')}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="display-text" style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-navy)' }}>{name}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {isLikeable && (
                <button
                  onClick={handleLikeClick}
                  disabled={liking}
                  aria-label={isLiked ? 'Unlike' : 'Like'}
                  style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer' }}
                >
                  {isLiked ? '❤️' : '🤍'}
                </button>
              )}
              <button
                onClick={handleShare}
                disabled={sharing}
                aria-label="Share"
                style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer' }}
              >
                {sharing ? '…' : '📤'}
              </button>
              <button
                onClick={onClose}
                aria-label="Close"
                style={{ border: 'none', background: 'transparent', fontSize: 18, color: 'var(--color-ink)', cursor: 'pointer' }}
              >
                x
              </button>
            </div>
          </div>

          <div style={{ fontSize: 13, color: 'var(--color-muted)', textTransform: 'capitalize' }}>
            {animalType}{breed ? ` · ${breed}` : ''}
          </div>

          {/* Farmer-view-only: last seen + location name, no labels/
              headings per design (just the two lines), plus a Go button
              that hands off to Google Maps for live turn-by-turn
              directions (free - Google doesn't charge for navigation,
              only the person's own mobile data applies). Buyers never
              see this block: no live position, and base-location-only
              is the intended buyer experience (see FullMapModal/
              MapPreviewCard's isFarmerView gating on liveLocation). */}
          {isFarmerView && (formatLastSeen(lastSeenAt) || placeName || googleMapsUrl) && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11, color: 'var(--color-muted)' }}>
              <span>
                {formatLastSeen(lastSeenAt)}
                {formatLastSeen(lastSeenAt) && placeName ? ' · ' : ''}
                {placeName}
              </span>
              {googleMapsUrl && (
                <a
                  href={googleMapsUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    flexShrink: 0, fontSize: 11, fontWeight: 700, color: '#fff',
                    background: 'var(--color-navy)', padding: '4px 10px', borderRadius: 6,
                    textDecoration: 'none',
                  }}
                >
                  📍 Go
                </a>
              )}
            </div>
          )}

          {/* GPS History - farmer-view-only, same reasoning as the
              last-seen/Go block above (buyers never see live/historical
              position). Collapsed behind a button so opening this modal
              never fetches trail data unless the farmer actually asks. */}
          {isFarmerView && (
            <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                style={{
                  border: '1px solid var(--color-navy)', background: 'transparent',
                  color: 'var(--color-navy)', fontWeight: 700, fontSize: 12,
                  padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                }}
              >
                🕒 {showHistory ? 'Hide History' : 'History'}
              </button>

              {showHistory && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="date"
                      // Empty value = rolling-24h ("Today") mode - see
                      // historyDate state comment above.
                      value={historyDate ?? ''}
                      max={todayLocalDateString()}
                      onChange={(e) => setHistoryDate(e.target.value || null)}
                      style={{
                        flex: 1, fontSize: 12, padding: '5px 8px',
                        borderRadius: 6, border: '1px solid var(--color-border)',
                      }}
                    />
                    {historyDate && (
                      <button
                        type="button"
                        onClick={() => setHistoryDate(null)}
                        style={{
                          fontSize: 11, fontWeight: 700, color: 'var(--color-navy)',
                          background: 'transparent', border: 'none', cursor: 'pointer',
                        }}
                      >
                        Today
                      </button>
                    )}
                  </div>

                  {trailLoading && (
                    <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>Loading…</div>
                  )}

                  {!trailLoading && trailPoints.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>
                      No location history for {historyDate ? 'this day' : 'the last 24 hours'}.
                    </div>
                  )}

                  {/* No inline map here on purpose - a small embedded map
                      is awkward to zoom/pan inside a modal this size.
                      Instead this hands off to whichever full map is
                      already the app's real zoomable map: onViewTrailOnMap
                      carries the cattle id, the picked date (or null for
                      rolling-24h/"today"), and the trail's last known
                      point, so the receiving map can jump straight to it -
                      including the "animal is missing, just show me the
                      last fix" case, which needs no date picked at all. */}
                  {!trailLoading && trailPoints.length > 0 && onViewTrailOnMap && (
                    <button
                      type="button"
                      onClick={() => {
                        const lastPoint = trailPoints[trailPoints.length - 1];
                        onViewTrailOnMap({
                          cattleId: id,
                          date: historyDate,
                          lastPoint: lastPoint.position,
                          lastPointRecordedAt: lastPoint.recordedAt,
                        });
                        onClose?.();
                      }}
                      style={{
                        padding: '8px 0', borderRadius: 8, border: 'none',
                        background: 'var(--color-navy)', color: '#fff',
                        fontWeight: 700, fontSize: 12, cursor: 'pointer',
                      }}
                    >
                      🎯 Locate on Map
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Structured detail rows - icon + label + value, matching
              ServiceDetailModal's pattern rather than the old 2-column
              grid, so all four modals now read the same way. Deliberately
              NOT shown: raw id, collar_id, tag_deveui (LoRa DevEUI) —
              internal plumbing, not farmer/buyer-facing info. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}>
            {age && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>🎂</span>
                <span style={{ color: 'var(--color-muted)' }}>Age</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}>{age}</span>
              </div>
            )}
            {calvingCount != null && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>🐄</span>
                <span style={{ color: 'var(--color-muted)' }}>Calvings</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}>{calvingCount}</span>
              </div>
            )}
            {isFarmerView && signal && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>{signal.bars}</span>
                <span style={{ color: 'var(--color-muted)' }}>Signal</span>
                <span
                  style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}
                  title={lastSnr != null ? `RSSI ${lastRssi} dBm, SNR ${lastSnr} dB` : `RSSI ${lastRssi} dBm`}
                >
                  {signal.text}
                </span>
              </div>
            )}
            {geofenceRadiusM != null && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>📍</span>
                <span style={{ color: 'var(--color-muted)' }}>GeoFence</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}>{geofenceRadiusM}m</span>
              </div>
            )}
            {(cattle.weightKg ?? cattle.weight_kg) != null && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>⚖️</span>
                <span style={{ color: 'var(--color-muted)' }}>Weight</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}>{cattle.weightKg ?? cattle.weight_kg} kg</span>
              </div>
            )}
            {govtId && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>🪪</span>
                <span style={{ color: 'var(--color-muted)' }}>INAPH ID</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)', fontFamily: 'monospace' }}>{govtId}</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ width: 20, textAlign: 'center' }}>●</span>
              <span style={{ color: 'var(--color-muted)' }}>Status</span>
              <span style={{ marginLeft: 'auto', fontWeight: 700, color: isListedForSale ? 'var(--color-success)' : 'var(--color-navy)' }}>
                {isListedForSale ? 'Listed for sale' : 'Not listed'}
              </span>
            </div>
            {isBreedingReady && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>💗</span>
                <span style={{ color: 'var(--color-muted)' }}>Breeding</span>
                <span style={{ marginLeft: 'auto', fontWeight: 700, color: 'var(--color-navy)' }}>Ready to breed</span>
              </div>
            )}
          </div>

          {(cattle.qcCertificateUrl ?? cattle.qc_certificate_url) && (
            <a
              href={cattle.qcCertificateUrl ?? cattle.qc_certificate_url}
              target="_blank"
              rel="noreferrer"
              style={{ alignSelf: 'flex-start', fontSize: 11, fontWeight: 700, color: 'var(--color-success)', background: 'var(--color-bg)', border: '1px solid var(--color-success)', padding: '3px 8px', borderRadius: 6, textDecoration: 'none' }}
            >
              ✓ QC Certified
            </a>
          )}

          {isListedForSale && salePriceMin != null && (
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-success)' }}>
              For sale: Rs{salePriceMin} - {salePriceMax}
            </div>
          )}

          {/* UPDATED: direct Call/WhatsApp buttons are back, but ONLY when
              the farmer opted into "Share My Number" (show_contact_publicly)
              on AddCattleForm - cattle_public_view now returns real
              contact_phone/contact_whatsapp when that's on and NULL when
              it's off, so this is the same plain presence-check
              CattleCard.jsx already uses, no separate boolean needed here.
              Shown alongside Chat below, not instead of it - some buyers
              may still prefer to message first. Never shown to the
              listing's own owner. */}
          {!isOwner && ownerCheckDone && (cattleContactPhone || cattleContactWhatsapp) && (
            <div style={{ display: 'flex', gap: 8 }}>
              {cattleContactPhone && (
                <a
                  href={`tel:${cattleContactPhone}`}
                  style={{
                    flex: 1, textAlign: 'center', padding: '10px 0', borderRadius: 8,
                    border: '1px solid var(--color-navy)', color: 'var(--color-navy)',
                    fontWeight: 700, fontSize: 13, textDecoration: 'none',
                  }}
                >
                  📞 Call
                </a>
              )}
              <a
                href={`https://wa.me/${(cattleContactWhatsapp || cattleContactPhone || '').replace(/\D/g, '')}`}
                target="_blank"
                rel="noreferrer"
                style={{
                  flex: 1, textAlign: 'center', padding: '10px 0', borderRadius: 8,
                  border: 'none', background: '#25D366', color: '#fff',
                  fontWeight: 700, fontSize: 13, textDecoration: 'none',
                }}
              >
                💬 WhatsApp
              </a>
            </div>
          )}

          {/* Chat option stays regardless of the toggle above - buyers can
              still message first even when the number is already public. */}
          {!isOwner && ownerCheckDone && (
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              style={{
                padding: '10px 0', borderRadius: 8, border: 'none', background: 'var(--color-navy)',
                color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer',
              }}
            >
              💬 Chat with Seller
            </button>
          )}

          {/* Owner-only, mirrors the Chat button's ownerCheckDone gating
              just above so this doesn't flash-then-hide on a buyer's
              screen either. */}
          {isOwner && ownerCheckDone && !hideBreedingToggle && (
            <button
              type="button"
              onClick={handleToggleBreedingReady}
              disabled={breedingBusy}
              style={{
                padding: '10px 0', borderRadius: 8,
                border: `1px solid ${isBreedingReady ? 'var(--color-danger)' : 'var(--color-navy)'}`,
                background: 'transparent',
                color: isBreedingReady ? 'var(--color-danger)' : 'var(--color-navy)',
                fontWeight: 700, fontSize: 13, cursor: 'pointer',
                opacity: breedingBusy ? 0.6 : 1,
              }}
            >
              {breedingBusy ? '...' : isBreedingReady ? '💗 Unmark Ready to Breed' : '💗 Mark Ready to Breed'}
            </button>
          )}

          <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, marginTop: 4 }}>
            <div style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 4 }}>
              {liveAverage != null ? `${liveAverage} average (${liveCount} rating${liveCount === 1 ? '' : 's'})` : 'No ratings yet'}
            </div>
            <Stars value={liveAverage} size={18} />

            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-muted)' }}>
              {myRating ? 'Your rating:' : 'Rate this animal:'}
            </div>
            <Stars value={myRating} onRate={submitting ? undefined : handleRate} size={26} />
          </div>

          <RecentHealth cattleId={id} />
          <OwnershipHistory cattleId={id} />
        </div>
      </div>

      {chatOpen && (
        <div onClick={(e) => e.stopPropagation()}>
          <ChatModal
            listingType="cattle"
            listingId={id}
            sellerPhone={chatSellerPhone}
            onClose={() => setChatOpen(false)}
          />
        </div>
      )}
    </div>
  );
}