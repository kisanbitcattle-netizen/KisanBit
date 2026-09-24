// src/components/CattleInfoPanel.jsx
//
// The "Get" card below the hero map. Collapsed, it's just a button.
// Tapping it expands a list of CattleCard entries - kept live via a
// Supabase realtime subscription so updates land within milliseconds
// of a new LoRa ping being written to the DB. Farmers also get an
// "+ Add" button here to register a new animal (AddCattleForm).

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../config/supabaseClient';
import { offlineCache } from '../utils/offlineCache';
import { isSellable } from '../utils/animalTaxonomy';
import CattleCard from './CattleCard';
import AddCattleForm from './AddCattleForm';
import SectionBoxHeader from '../shared/SectionBoxHeader';
import { useUser } from '../context/UserContext';

// Narrowed from select('*', ...) now that CattleCard.jsx is available to
// check against. Also drops average_rating/rating_count (don't exist as
// live columns - selecting them fails the WHOLE query, 42703, same bug
// already fixed in FullMapModal/MarketplaceModal) and live_location_geojson
// (no confirmed backing at all, and CattleCard doesn't render a live
// position anyway - this is a list card, not a map).
//
// BUG FIX: this previously selected `geofence_center_geojson`, which does
// NOT exist as a column or computed field on `cattle` - confirmed live via
// SQL editor: `42703: column "geofence_center_geojson" does not exist`.
// Unlike `fields.boundary_geojson` (a real PostgREST computed field backed
// by a Postgres function, resolvable via the column-call-syntax sugar),
// there is no equivalent function for cattle's geofence center. Because a
// nonexistent column fails the WHOLE select, this was silently breaking
// EVERY farmer-view fetch in this panel (initial load AND every realtime-
// triggered refetch, since loadAll is the realtime callback too) - only
// masked because loadAll() paints the offline cache first and the failed
// network fetch just gets console.error'd, never surfaced. Swapped to the
// real `geofence_center` column (raw WKB hex); CattleCard.jsx's
// parsePoint() already handles that shape via the shared parseWkbPoint().
// FIX: this select was missing several columns that EditCattleModal.jsx
// actually writes on every save (confirmed via its own updateData
// payload) - animal_type_custom_label, tag_deveui ("GoTag Hardware ID"
// - the reported bug: saved fine, but always came back empty on
// reopening Edit since this list never fetched it in the first place),
// show_contact_publicly, gender, is_milking, daily_milk_yield_liters,
// pregnancy_status, ai_date, expected_calving_date. Same missing-column
// bug class as the is_listed_for_sale/base_name fixes already made
// elsewhere in this file - the DB always had the right value, this
// list just never asked for it, so EditCattleModal's prefill
// (`cattle.tag_deveui` etc.) was always undefined.
// NOTE: this panel now always renders the logged-in farmer's own
// cattle, regardless of the Farmer/Buyer toggle - that toggle only
// changes what MapPreviewCard/FullMapModal show (own cattle vs
// marketplace-listed cattle across all farmers). There is no longer a
// separate buyer-facing marketplace query/column-set here; that lived
// on cattle_public_view and has been removed from this panel.
const CATTLE_PANEL_FARMER_COLUMNS =
  'id, name, animal_type, animal_type_custom_label, local_image_path, marketplace_photo_url, last_updated, is_listed_for_sale, sale_price_min, sale_price_max, collar_id, tag_deveui, live_location, geofence_center, geofence_radius_m, alert_radius_1_m, alert_radius_2_m, alert_radius_3_m, calving_count, breed, govt_inaph_id, birth_date, weight_kg, contact_phone, contact_whatsapp, show_contact_publicly, qc_certificate_url, is_archived, base_id, is_breeding_ready, gender, is_milking, daily_milk_yield_liters, pregnancy_status, ai_date, expected_calving_date, updated_at';

// Hoisted out of the effect below so handleCattleDeleted (used by the
// hard-delete path) and the cache-sync effect always agree on the same
// store name - previously 'cattlePanel' was a local const re-typed
// inside the effect only, with no shared reference other channels could
// import to purge the exact same store.
const CACHE_STORE = 'cattlePanel';

export default function CattleInfoPanel({ isOpen, onToggle }) {
 const [cattleList, setCattleList] = useState([]);
 const [isAddOpen, setIsAddOpen] = useState(false);
 const [actionError, setActionError] = useState(null);
 // Search + filter - lets a farmer managing a large herd find one
 // animal fast. This panel always shows the farmer's own cattle now
 // (see note above), so these controls are always available.
 const [searchQuery, setSearchQuery] = useState('');
 const [breedReadyFilter, setBreedReadyFilter] = useState(false);
 const [listedFilter, setListedFilter] = useState(false);
 // base_id is on the cattle row, but its human-readable name isn't -
 // fetched once per mount below and used only for text search (not
 // rendered anywhere; CattleCard already shows whatever base info it
 // shows on its own).
 const [baseNameById, setBaseNameById] = useState({});
 // Lets onChanged (passed to CattleCard below) trigger an immediate
 // manual refetch after a save, as a safety net alongside the realtime
 // payload-merge fix above - realtime can lag or briefly disconnect,
 // and CattleCard was previously given no onChanged at all, so a save
 // from EditCattleModal/GeofenceSetupModal had no way to ask this panel
 // to refresh other than waiting on realtime.
 const refreshRef = useRef(() => {});
 // Read from context instead of calling supabase.auth.getUser() here -
 // App.jsx already resolved this once. See UserContext.jsx.
 const { user } = useUser();

 // Cache-first + background delta sync (stale-while-revalidate), same
 // pattern as FullMapModal.jsx / documented in offlineCache.js. Renders
 // whatever's cached instantly (including offline/on app open, so this
 // panel stops hitting the DB on every mount), then quietly asks for
 // only rows changed since the last successful sync and merges those in.
 //
 // is_archived is fetched but deliberately NOT filtered server-side on
 // the delta query - filtering server-side would mean a cattle that
 // just got archived stops matching the delta's is_archived=false
 // filter, so the stale un-archived cached copy would never get
 // corrected. Fetching it and filtering client-side (after merge) means
 // the delta still picks up that row (its updated_at changed), the
 // cached copy gets refreshed with is_archived=true, and the display
 // filter then correctly drops it.
 useEffect(() => {
 let channel;
 let cancelled = false;
 const syncKey = 'cattleInfoPanel_lastSync';
 // Single cache store now that this panel only ever renders the
 // farmer's own cattle - no separate buyer/marketplace query writes
 // into it anymore, so the earlier per-view-mode split (cattlePanelFarmer
 // vs cattlePanelBuyer) is no longer needed.
 const cacheStore = CACHE_STORE;

 async function loadAll(userId) {
 const cached = await offlineCache.getAll(cacheStore);
 if (cancelled) return;
 if (cached.length) {
 setCattleList(cached.filter((c) => !c.is_archived));
 }

 if (!navigator.onLine) return; // stay on cache; no doomed network call
 const table = 'cattle';
 const selectFields = CATTLE_PANEL_FARMER_COLUMNS;
 const lastSync = await offlineCache.getMeta(syncKey);
 let query = supabase.from(table).select(selectFields);
 // CRITICAL: scope to the logged-in owner only. Without this, the
 // public_select_listed_cattle RLS policy (any authenticated user can
 // SELECT any is_listed_for_sale=true row) leaks OTHER farmers' listed
 // cattle into this user's own "My Cattle" list - Postgres RLS ORs all
 // matching permissive policies together, so cattle_owner_full_access
 // alone doesn't shut this out.
 if (userId) query = query.eq('owner_id', userId);
 // BUG FIX: confirmed live - several cattle rows have updated_at = NULL
 // (e.g. inserted before a DEFAULT now()/trigger existed on that
 // column). `gte('updated_at', lastSync)` alone means those rows NEVER
 // match once lastSync is set (Postgres NULL >= x is never true), so
 // they silently drop out of every delta fetch after the first sync and
 // never re-enter the cache - ProfileScreen didn't show this bug
 // because it always does a plain unfiltered owner_id fetch, no delta
 // sync. `.or()` here also pulls in any still-NULL rows on every sync
 // so a bad row can't get permanently stranded again; the real fix is
 // backfilling/defaulting updated_at at the DB level, this is belt-and-
 // suspenders so the UI degrades gracefully if that ever regresses.
 if (lastSync) query = query.or(`updated_at.gte.${lastSync},updated_at.is.null`);
 const { data, error } = await query;
 if (cancelled) return;
 if (error) {
 // Previously swallowed silently - a failed fetch looked identical
 // to "0 cattle" in the UI. Logging the real Postgres/PostgREST
 // error (message/details/hint/code) so failures are visible
 // instead of masquerading as an empty list.
 console.error('[CattleInfoPanel] cattle fetch failed:', error.message, error.details, error.hint, error.code);
 return; // keep showing whatever the cache already rendered above
 }

 const merged = lastSync ? offlineCache.mergeById(cached, data) : data;
 offlineCache.putAll(cacheStore, merged);
 offlineCache.setMeta(syncKey, new Date().toISOString());
 setCattleList(merged.filter((c) => !c.is_archived));
 }

 // Reads `user` straight from context (see useUser() above) instead of
 // awaiting supabase.auth.getUser() here - App.jsx already resolved it
 // once. No more async IIFE needed for that step.
 refreshRef.current = () => loadAll(user?.id);
 loadAll(user?.id);

 // Base names - used for both search AND display (CattleCard's meta
 // line now shows "Base: <name>" for any animal linked to a base, see
 // the baseName prop passed below). BUG FIX: this previously selected
 // `place_name`, which is not a real column on cattle_bases - the
 // confirmed live schema has `base_name` (see HomeScreen.jsx's own
 // bases fetch, which already used the correct column). Because the
 // wrong column was selected, this map was either empty or silently
 // undefined for every animal, which is the root cause of the base
 // location never showing up on a cattle card.
 if (user?.id) {
 supabase
 .from('cattle_bases')
 .select('id, base_name')
 .eq('owner_id', user.id)
 .then(({ data, error }) => {
 if (cancelled) return;
 if (error) {
 console.error('[CattleInfoPanel] cattle_bases fetch failed (search):', error.message, error.details, error.hint, error.code);
 return;
 }
 setBaseNameById(Object.fromEntries((data || []).map((b) => [b.id, b.base_name])));
 });
 }

 if (user) {
 channel = supabase
 // Per-mount suffix - see AlertBanner.jsx for why.
 .channel(`cattle-info-${user.id}-${Math.random().toString(36).slice(2)}`)
 .on(
 'postgres_changes',
 { event: '*', schema: 'public', table: 'cattle', filter: `owner_id=eq.${user.id}` },
 (payload) => {
 // Merge the row Postgres just sent us directly, regardless of
 // whether this write bumped updated_at - loadAll()'s delta query
 // below filters on `updated_at.gte.lastSync`, which silently
 // drops any UPDATE that didn't touch updated_at (no DB trigger
 // covers every write path - see the NULL-updated_at BUG FIX note
 // above, same underlying gap). This was the real cause behind
 // Cattle Base not sticking, geofence/alert radii appearing to
 // reset, and breed-ready not reflecting after a save from
 // EditCattleModal/GeofenceSetupModal: the write succeeded,
 // realtime fired, but the delta-fetch that followed excluded the
 // very row that had just changed, so the cached/stale copy kept
 // rendering. Applying payload.new here (present on both INSERT
 // and UPDATE) bypasses that filter entirely for the row we
 // already know changed.
 if (payload.eventType === 'DELETE') {
 const deletedId = payload.old?.id;
 setCattleList((prev) => prev.filter((c) => c.id !== deletedId));
 // BUG FIX: offlineCache never had this row purged from it - only
 // React state was updated above. offlineCache.js's own remove()
 // function (already written, just never called from here) exists
 // exactly for this: mergeById() can only ADD/UPDATE rows from a
 // delta fetch, it can never learn a row disappeared, since a
 // deleted row simply isn't returned by any future query. Without
 // this call, the very next loadAll() below reads offlineCache.getAll()
 // BEFORE the network delta lands, sees the still-present deleted
 // row, and overwrites the correct state we just set above -
 // making the delete appear to silently "undo" itself immediately.
 // And since the delta-merge below can never remove it either, the
 // ghost row stays in IndexedDB forever - reappearing on every future
 // app open (e.g. "next day"), regardless of the DB being clean.
 offlineCache.remove(cacheStore, deletedId);
 // Hard-delete is unambiguous and already fully handled above (state
 // + cache) - no need to fall through to loadAll(); doing so would
 // re-read the cache we just cleaned this row from purely as a race
 // (harmless now, but pointless), so skip it for this event type.
 return;
 } else if (payload.new) {
 setCattleList((prev) => {
 const exists = prev.some((c) => c.id === payload.new.id);
 const nextList = exists
 ? prev.map((c) => (c.id === payload.new.id ? { ...c, ...payload.new } : c))
 : [...prev, payload.new];
 return nextList.filter((c) => !c.is_archived);
 });
 offlineCache.putAll(cacheStore, [payload.new]);
 }
 // Still run the normal delta sync too - catches anything the
 // realtime payload alone wouldn't (e.g. rows changed while this
 // client was briefly disconnected from the realtime channel).
 loadAll(user.id);
 }
 )
 .subscribe();
 }

 return () => {
 cancelled = true;
 if (channel) supabase.removeChannel(channel);
 };
 }, [user?.id]);

 // Called directly by CattleCard right after its own hard-delete
 // Supabase call succeeds - NOT chained off the realtime DELETE
 // subscription above, because that event only fires when a row
 // actually changes in Postgres. A delete on a row that's already
 // gone (e.g. this exact card was still showing a stale cached copy
 // of an animal deleted in an earlier session) matches zero rows,
 // reports no error, and changes nothing server-side - so Postgres
 // never emits a DELETE event, and a cache purge living only inside
 // that realtime handler would never run for this row. Purging here,
 // straight from the action the user just took, works regardless of
 // whether the row was already gone.
 const handleCattleDeleted = (id) => {
 setCattleList((prev) => prev.filter((c) => c.id !== id));
 offlineCache.remove(CACHE_STORE, id);
 };

 const handleToggleListing = async (cattle, priceRange) => {
 setActionError(null);
 // Defensive check - CattleCard.jsx already hides the Sell/Unlist button
 // for non-sellable animal types (see animalTaxonomy.js), so this
 // shouldn't normally be reachable. Kept here too as a second layer in
 // case of a stale UI render or a future caller, since a wrongly-listed
 // protected-species row would need a DB-level fix, not just a UI one.
 // Unlisting is always allowed regardless of sellable, so an already
 // wrongly-listed row can still be corrected.
 if (!cattle.is_listed_for_sale && !isSellable(cattle.animal_type)) {
 setActionError('This animal type cannot be listed for sale.');
 return;
 }

 // FIX: unlisting (and re-listing) used to only flip is_listed_for_sale
 // in the DB and then wait for the realtime subscription to trigger
 // loadAll(), which does a DELTA fetch filtered by
 // `updated_at.gte.<lastSync>`. If the `cattle` table has no trigger
 // bumping updated_at on plain UPDATEs (only on INSERT, via a
 // DEFAULT now()), this update's row would never carry a fresh enough
 // updated_at to pass that filter before the next sync window - so the
 // merge kept the stale cached copy and the farmer's own list kept
 // showing the animal as listed even though the flag was already false
 // in the DB. Two changes here:
 // 1. Explicitly set updated_at in the patch so the delta-sync filter
 // (and any other updated_at-based logic) sees this change even if
 // no DB trigger exists.
 // 2. Apply the same patch to local state + the offline cache
 // immediately after a successful update, instead of waiting on the
 // realtime round-trip at all. This is what actually makes the
 // change visible right away regardless of the sync-window timing.
 const nowIso = new Date().toISOString();
 const patch = cattle.is_listed_for_sale
 ? { is_listed_for_sale: false, updated_at: nowIso }
 : { is_listed_for_sale: true, sale_price_min: priceRange.min, sale_price_max: priceRange.max, updated_at: nowIso };

 const { error } = await supabase.from('cattle').update(patch).eq('id', cattle.id);

 if (error) {
 // Was previously swallowed entirely - a failed unlist/list looked
 // identical to a successful one (SellPriceModal/CattleCard have no
 // local optimistic state of their own, they leaned on the realtime
 // subscription round-trip to reflect the change). Same silent-
 // failure class already fixed in CattleCard's archive/delete.
 // Surfaced via the actionError banner below (same inline-error-
 // state pattern as EditCattleModal/SellPriceModal/
 // GeofenceSetupModal) instead of window.alert.
 const label = cattle.is_listed_for_sale ? 'Unlist avvaledu' : 'List cheyadam avvaledu';
 console.error(`[CattleInfoPanel] ${label}:`, error.message, error.details, error.hint, error.code);
 setActionError(`${label}: ${error.message}`);
 return;
 }

 // Optimistic local update - don't wait on realtime/delta-cache sync.
 setCattleList((prev) => prev.map((c) => (c.id === cattle.id ? { ...c, ...patch } : c)));
 offlineCache.putAll('cattlePanel', [{ ...cattle, ...patch }]);
 };

 const visibleCattleList = cattleList.filter((c) => {
 if (breedReadyFilter && !c.is_breeding_ready) return false;
 if (listedFilter && !c.is_listed_for_sale) return false;
 if (searchQuery.trim()) {
 const baseName = (c.base_id && baseNameById[c.base_id]) || '';
 const haystack = `${c.name || ''} ${c.breed || ''} ${c.animal_type || ''} ${baseName}`.toLowerCase();
 if (!haystack.includes(searchQuery.trim().toLowerCase())) return false;
 }
 return true;
 });

 return (
 <div className="kb-card" style={{ overflow: 'hidden', flexShrink: 0 }}>
 <SectionBoxHeader
 icon="🐄"
 title="Cattle"
 count={cattleList.length}
 isOpen={isOpen}
 onToggle={onToggle}
 onAdd={() => setIsAddOpen(true)}
 addLabel="+ Add"
 />

 {actionError && (
 <div
 style={{
 margin: '0 12px 12px',
 padding: '8px 12px',
 borderRadius: 8,
 border: '1px solid var(--color-danger)',
 background: 'var(--color-card)',
 color: 'var(--color-danger)',
 fontSize: 13,
 display: 'flex',
 justifyContent: 'space-between',
 alignItems: 'center',
 gap: 8,
 }}
 >
 <span>{actionError}</span>
 <button
 onClick={() => setActionError(null)}
 style={{ background: 'none', border: 'none', color: 'var(--color-danger)', fontWeight: 700, fontSize: 15, cursor: 'pointer', lineHeight: 1 }}
 aria-label="Dismiss"
 >
 ×
 </button>
 </div>
 )}

 {isOpen && (
 <div style={{ borderTop: '1px solid var(--color-border)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
 {cattleList.length > 0 && (
 <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
 <input
 type="text"
 value={searchQuery}
 onChange={(e) => setSearchQuery(e.target.value)}
 placeholder="Search by name, breed, type, or base..."
 style={{
 padding: '8px 12px',
 borderRadius: 8,
 border: '1px solid var(--color-border)',
 background: 'var(--color-bg)',
 color: 'var(--color-ink)',
 fontSize: 13,
 }}
 />
 <div style={{ display: 'flex', gap: 6 }}>
 <button
 type="button"
 onClick={() => setBreedReadyFilter((v) => !v)}
 style={{
 padding: '5px 10px',
 borderRadius: 14,
 fontSize: 12,
 fontWeight: 600,
 border: `1px solid ${breedReadyFilter ? '#c2185b' : 'var(--color-border)'}`,
 background: breedReadyFilter ? '#c2185b' : 'transparent',
 color: breedReadyFilter ? '#fff' : 'var(--color-ink)',
 }}
 >
 💗 Breed Ready
 </button>
 <button
 type="button"
 onClick={() => setListedFilter((v) => !v)}
 style={{
 padding: '5px 10px',
 borderRadius: 14,
 fontSize: 12,
 fontWeight: 600,
 border: `1px solid ${listedFilter ? 'var(--color-success)' : 'var(--color-border)'}`,
 background: listedFilter ? 'var(--color-success)' : 'transparent',
 color: listedFilter ? '#fff' : 'var(--color-ink)',
 }}
 >
 💰 Listed for Sale
 </button>
 </div>
 </div>
 )}

 {cattleList.length === 0 && (
 <p style={{ padding: 6, color: 'var(--color-muted)' }}>No cattle registered yet.</p>
 )}
 {cattleList.length > 0 && visibleCattleList.length === 0 && (
 <p style={{ padding: 6, color: 'var(--color-muted)' }}>No cattle match your search/filters.</p>
 )}
 {visibleCattleList.map((c) => (
 <CattleCard
 key={c.id}
 cattle={c}
 isFarmerView={true}
 onToggleListing={handleToggleListing}
 onChanged={() => refreshRef.current()}
 onDeleted={handleCattleDeleted}
 baseName={(c.base_id && baseNameById[c.base_id]) || null}
 />
 ))}
 </div>
 )}

 {isAddOpen && (
 <AddCattleForm
 onClose={() => setIsAddOpen(false)}
 onSaved={() => setIsAddOpen(false)} // realtime subscription above refreshes the list automatically
 />
 )}
 </div>
 );
}