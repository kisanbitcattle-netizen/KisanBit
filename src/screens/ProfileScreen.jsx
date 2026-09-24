// src/screens/ProfileScreen.jsx
//
// Tab 4 — User Profile & Asset Management.
// Shows the farmer's registered fields/lands, their cattle's LoRa
// collar IDs, active devices, and current subscription plan.
// Upgraded with LocalStorage caching & Play Store compliant Delete Account flow.

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../config/supabaseClient';
import { getCurrentProfile, signOut } from '../services/authService';
import { toUserMessage } from '../utils/errorHandling';
import { compressImageElement, loadImageFromDataUrl } from '../utils/imageCompression';
import FieldCard from '../features/fields/FieldCard';
import AddFieldForm from '../features/fields/AddFieldForm';
import AddCattleBaseForm from '../components/AddCattleBaseForm';
import AddPondForm from '../features/ponds/AddPondForm';
import AddServiceForm from '../features/services/AddServiceForm';
import MessagesInbox from '../features/messaging/MessagesInbox';

function SectionCard({ title, icon, children }) {
  return (
    <div className="kb-card" style={{ padding: 16 }}>
      <div className="display-text" style={{ fontSize: 16, color: 'var(--color-navy)', marginBottom: 10 }}>
        {icon} {title}
      </div>
      {children}
    </div>
  );
}

// Fixed width for a card inside a horizontal swipe strip - matches
// FullMapModal's ClusterPickerSheet pattern (swipeable row of cards)
// already used elsewhere in the app, so this reads as a familiar
// interaction rather than a new one.
const STRIP_CARD_WIDTH = 240;

// Shared "View All (N)" pill - opens the ListModal below with every
// item in a normal vertical list, for whenever swiping the horizontal
// strip isn't the easiest way to browse/manage everything.
function ViewAllToggle({ total, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        minHeight: 40, padding: '8px 0', borderRadius: 10, border: '1px solid var(--color-border)',
        background: 'transparent', color: 'var(--color-navy)', fontWeight: 600, fontSize: 13, cursor: 'pointer',
      }}
    >
      View All ({total}) ▾
    </button>
  );
}

// Full-screen scrollable overlay used by every section's "View All" -
// same overlay/kb-card/close-button shell as the Add/Edit popups
// further down this file, just holding a vertical list instead of a form.
function ListModal({ title, icon, onClose, children }) {
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
      }}
    >
      <div
        className="kb-card"
        style={{
          padding: 16, maxWidth: 480, width: '100%', maxHeight: '90vh',
          overflowY: 'auto', position: 'relative',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: '50%',
            border: 'none', background: 'var(--color-border)', color: 'var(--color-ink)', fontWeight: 700,
            cursor: 'pointer', lineHeight: 1,
          }}
        >
          ✕
        </button>
        <div className="display-text" style={{ fontSize: 16, color: 'var(--color-navy)', marginBottom: 12, paddingRight: 30 }}>
          {icon} {title}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export default function ProfileScreen({ onAvatarChange }) {
  const [profile, setProfile] = useState(null);
  const [fields, setFields] = useState([]);
  const [crops, setCrops] = useState([]);
  const [cattle, setCattle] = useState([]);
  const [cattleBases, setCattleBases] = useState([]);
  const [showAddBaseForm, setShowAddBaseForm] = useState(false);
  const [loading, setLoading] = useState(true);

  // Cattle Base inline delete/edit — the confirm row and per-row buttons in
  // the Cattle Bases SectionCard use these. They were referenced in JSX
  // with no state/handler behind them (undefined-variable crash on render).
  // editingBase holds the Cattle Base currently being edited (or null) -
  // AddCattleBaseForm now supports edit mode via its initialBase prop, so
  // this renders a real popup (see the Edit Cattle Base Popup below).
  const [deletingBaseId, setDeletingBaseId] = useState(null);
  const [deletingBase, setDeletingBase] = useState(false);
  const [baseDeleteError, setBaseDeleteError] = useState(null);
  const [editingBase, setEditingBase] = useState(null);
  // Cattle Bases: main section shows a horizontal swipe strip of ALL
  // bases (no cap needed - a row doesn't grow page height); this only
  // controls whether the "View All" vertical-list modal is open.
  const [showAllBases, setShowAllBases] = useState(false);

  // Ponds — same structural role as Cattle Bases: simple entity, no
  // boundary/map, Profile-tab-only for create/edit/delete. Fish stock
  // (the Pond's "children", like a Base's cattle) stays HomeScreen-only
  // via PondsPanel.jsx.
  const [ponds, setPonds] = useState([]);
  const [showAddPondForm, setShowAddPondForm] = useState(false);
  const [editingPond, setEditingPond] = useState(null);
  const [deletingPondId, setDeletingPondId] = useState(null);
  const [deletingPond, setDeletingPond] = useState(false);
  const [pondDeleteError, setPondDeleteError] = useState(null);
  // Ponds: same horizontal-strip-plus-"View All"-modal role as Cattle
  // Bases above.
  const [showAllPonds, setShowAllPonds] = useState(false);

  // Services — same structural role as Cattle Bases/Ponds: simple
  // GPS-pinned entity, Profile-tab-only for create/edit/delete. Unlike
  // Cattle Bases/Ponds, a Service is meant to be *found*, so it's
  // rendered as a pin on FullMapModal for every farmer/buyer, not just
  // the owner's own map view.
  const [services, setServices] = useState([]);
  const [showAddServiceForm, setShowAddServiceForm] = useState(false);
  const [editingService, setEditingService] = useState(null);
  const [deletingServiceId, setDeletingServiceId] = useState(null);
  const [deletingService, setDeletingService] = useState(false);
  const [serviceDeleteError, setServiceDeleteError] = useState(null);
  // Quick Available/Unavailable flip straight from the card header - user
  // asked for this so they don't have to open the full Edit popup just to
  // flip one field. togglingServiceId gates the button on that one card
  // (disabled + "...") while its own request is in flight.
  const [togglingServiceId, setTogglingServiceId] = useState(null);
  // Tracked as {id, message} rather than a bare string - togglingServiceId
  // itself is cleared in the handler's `finally` (button re-enables right
  // away), so a plain error string with no id would have no reliable card
  // to attach to by the time it renders.
  const [serviceToggleError, setServiceToggleError] = useState(null);
  // Services: same horizontal-strip-plus-"View All"-modal role as Cattle
  // Bases/Ponds. The Available/Unavailable toggle + Edit/Delete stay on
  // every card in both the strip and the modal (user toggles services often).
  const [showAllServices, setShowAllServices] = useState(false);

  // "Add Field" is still an inline form under the list, toggled by the
  // + Add Field button: null (hidden) | 'add'.
  const [fieldFormMode, setFieldFormMode] = useState(null);
  // Fields: same horizontal-strip-plus-"View All"-modal role as the
  // other sections below.
  const [showAllFields, setShowAllFields] = useState(false);

  // Editing an EXISTING field is handled entirely separately, as a popup.
  // editingField holds the single field object currently being edited (or
  // null when no popup is open) — this lives outside the fields.map() loop
  // on purpose, so only ever one edit popup can exist regardless of how
  // many fields are in the list.
  const [editingField, setEditingField] = useState(null);
  // Which part of the (shared) AddFieldForm to scroll to when the popup
  // opens: 'details' (default, top of form) or 'boundary' (map section)
  // or 'crops' (crop carousel - see editFocusCropId below).
  const [editFocus, setEditFocus] = useState('details');
  // When editFocus === 'crops' AND this is set, the popup opens directly
  // into editing that SPECIFIC existing crop (FieldCard's new per-crop
  // "Update" button) instead of creating a new blank one. Null for the
  // existing "+ Add Crop" pill's behavior (new crop).
  const [editFocusCropId, setEditFocusCropId] = useState(null);

  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState(null);
  const [showUpgradeComingSoon, setShowUpgradeComingSoon] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState(null);
  const avatarFileInputRef = useRef(null);

  // Avatar upload: compress to a HARD 10KB cap (user's explicit
  // requirement - fast DB pulls for a list of many farmers/cattle
  // owners), well under imageCompression.js's own 80KB default, using
  // its existing targetKB param rather than touching that shared file.
  // 160px is plenty for a circular profile thumbnail this small, and
  // gives the compressor more room to hit 10KB without over-crushing
  // quality compared to a bigger source dimension.
  const handleAvatarFileSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file next time
    if (!file) return;

    setUploadingAvatar(true);
    setAvatarError(null);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const img = await loadImageFromDataUrl(dataUrl);
      const blob = await compressImageElement(img, { targetKB: 10, maxDimension: 160 });
      if (!blob) throw new Error('Compression produced no output');

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not signed in');

      // Path MUST start with the user's own auth id as the first
      // folder segment - the storage.objects RLS policies on the
      // avatars bucket check (storage.foldername(name))[1] = auth.uid().
      const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
      const path = `${user.id}/avatar.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, blob, { upsert: true, contentType: blob.type });
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage.from('avatars').getPublicUrl(path);
      // Cache-bust: upsert replaces the file at the same path, so
      // without this the browser/CDN may keep showing the old cached
      // image at that same URL.
      const bustedUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`;

      const { error: updateError } = await supabase
        .from('users')
        .update({ avatar_url: bustedUrl })
        .eq('id', user.id);
      if (updateError) throw updateError;

      setProfile((prev) => (prev ? { ...prev, avatar_url: bustedUrl } : prev));
      onAvatarChange?.(bustedUrl);
    } catch (err) {
      console.error('[ProfileScreen] avatar upload failed:', err.message);
      setAvatarError('Photo update avvaledu, malli try cheyandi.');
    } finally {
      setUploadingAvatar(false);
    }
  };

  // Dark mode toggle. Self-contained here for now: reads/writes
  // localStorage directly and applies data-theme to the document root,
  // matching the [data-theme='dark'] selector App.css is already built
  // around. LIMITATION: since this only runs once ProfileScreen mounts,
  // a fresh app launch briefly shows the default (light) theme even if
  // the user previously chose dark, until they visit this tab. Moving
  // the initial application to App.jsx (before first paint) would fix
  // that - not done here since App.jsx hasn't been reviewed this pass.
  const [isDarkMode, setIsDarkMode] = useState(
    () => localStorage.getItem('kisanbit_theme') === 'dark'
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
    localStorage.setItem('kisanbit_theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  // NOTE: dependency array was already correct ([], runs once on mount)
  // - no infinite-loop risk here.
  //
  // REAL BUG FIXED HERE: the old logic painted from localStorage and
  // then `return`-ed, permanently, the first time all 4 cache keys
  // existed. That means once this device had cached data, Profile
  // NEVER hit Supabase again - it just kept re-showing whatever counts
  // were true the first time the cache was written, even after fields/
  // cattle were added or removed elsewhere (Map/CattleInfoPanel don't
  // have this problem because they read live or delta-sync). This is
  // why Profile said "0 cattle" while Map correctly showed 3.
  //
  // Fix: stale-while-revalidate. Cache still paints instantly (so the
  // screen still feels fast), but a real fetch always follows and
  // overwrites both state and cache with current numbers.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      // 1. LOCAL STORAGE CACHE FIRST - paints instantly, may be stale.
      const cachedProfile = localStorage.getItem('kisanbit_user_profile');
      const cachedFields = localStorage.getItem('kisanbit_user_fields');
      const cachedCrops = localStorage.getItem('kisanbit_user_crops');
      const cachedCattle = localStorage.getItem('kisanbit_user_cattle');
      const cachedBases = localStorage.getItem('kisanbit_user_cattle_bases');
      const cachedPonds = localStorage.getItem('kisanbit_user_ponds');
      const cachedServices = localStorage.getItem('kisanbit_user_services');

      if (cachedProfile && cachedFields && cachedCrops && cachedCattle) {
        if (cancelled) return;
        setProfile(JSON.parse(cachedProfile));
        setFields(JSON.parse(cachedFields));
        setCrops(JSON.parse(cachedCrops));
        setCattle(JSON.parse(cachedCattle));
        setCattleBases(cachedBases ? JSON.parse(cachedBases) : []);
        setPonds(cachedPonds ? JSON.parse(cachedPonds) : []);
        setServices(cachedServices ? JSON.parse(cachedServices) : []);
        setLoading(false);
        // NOTE: no `return` here anymore - fall through to the real
        // fetch below so the cache gets revalidated, not trusted forever.
      }

      // 2. ALWAYS FETCH FROM SUPABASE - refreshes/creates the cache.
      // Skipped entirely while offline (matches the guard added to
      // CattleInfoPanel.jsx/authService.js) - the cache already painted
      // above, so there's nothing to gain from waiting out a network
      // call that can't succeed, and getCurrentProfile() would return
      // null anyway.
      if (!navigator.onLine) {
        if (!cachedProfile) setLoading(false);
        return;
      }

      const userRow = await getCurrentProfile();
      if (!userRow || cancelled) {
        if (!cancelled && !cachedProfile) setLoading(false);
        return;
      }

      const [{ data: fieldRows }, { data: cropRows }, { data: cattleRows }, { data: baseRows }, { data: pondRows }, { data: serviceRows }] = await Promise.all([
        // `boundary_geojson` is a PostgREST COMPUTED field (a Postgres
        // function, likely wrapping ST_AsGeoJSON(boundary)) - it is NOT a
        // real column, so it does not exist in information_schema.columns
        // and is NOT included by '*'. A prior session's claim that
        // `select('*, boundary_geojson')` was invalid and broke this whole
        // query was re-verified this session and does NOT hold up: Network
        // tab evidence shows a live 200 OK fetch elsewhere in the app
        // (offlineCache.js) explicitly selecting boundary_geojson by name.
        // Re-adding it here: without it, AddFieldForm's edit-mode boundary
        // parser (geojsonToPoints(initialField.boundary_geojson)) always
        // received undefined, so editing any existing field with a saved
        // boundary incorrectly hit "Set boundary first" on Save even though
        // the boundary genuinely exists in Postgres (in the real `boundary`
        // PostGIS column). '*' still covers every real column; this adds
        // back only the one computed field AddFieldForm actually needs.
        supabase.from('fields').select('*, boundary_geojson').eq('owner_id', userRow.id),
        // Was narrowed to only what FieldCard.jsx reads (id, field_id,
        // crop_type, status, harvest_date, market_price, is_listed,
        // delivery_type) - but this same `crops` state is also filtered
        // and passed as AddFieldForm's initialCrops when editing a field
        // (see `crops.filter(...)` below), and AddFieldForm's edit-mode
        // prefill reads several columns this narrowed select didn't
        // fetch (sowing_date, expected_yield_kg, wholesale_price,
        // retail_price, fertilizer_log, image_url, contact_phone,
        // contact_whatsapp, qc_certificate_url) - those came back
        // undefined and rendered as blank fields on reopen-to-edit even
        // though the data was saved correctly. Widened to include them.
        supabase.from('crops_marketplace').select('id, field_id, crop_type, status, harvest_date, sowing_date, expected_yield_kg, market_price, wholesale_price, retail_price, fertilizer_log, image_url, contact_phone, contact_whatsapp, qc_certificate_url, is_listed, delivery_type').eq('owner_id', userRow.id),
        // FIXED: was `select('id, name, animal_type, collar_id, device_alias,
        // battery_pct')` - device_alias/battery_pct do not exist on `cattle`
        // (confirmed via information_schema this session) - broke this
        // entire query, so cattle.length, "Active Devices", and "LoRa Collar
        // IDs" were all silently working off zero rows.
        supabase.from('cattle').select('id, name, animal_type, collar_id, tag_deveui, base_id').eq('owner_id', userRow.id),
        // Cattle Bases list for the Profile screen. Widened from just
        // (id, base_name) to every column AddCattleBaseForm's edit mode
        // prefills from - the narrower select worked fine for display but
        // left Edit with nothing to populate the form with.
        supabase.from('cattle_bases').select('id, base_name, location, geofence_radius_m, public_location_fuzz_m, youtube_url, instagram_url, facebook_url').eq('owner_id', userRow.id),
        // Ponds list for the Profile screen — same simple shape as
        // Cattle Bases above, no boundary/map columns to widen for.
        supabase.from('ponds').select('*').eq('owner_id', userRow.id),
        // Services list for the Profile screen — owner sees ALL of their
        // own services here regardless of is_available, same as every
        // other owner-scoped list on this screen (public visibility on
        // the map is a separate, unscoped query in FullMapModal).
        supabase.from('services').select('*').eq('owner_id', userRow.id),
      ]);

      if (cancelled) return;

      const updatedFields = fieldRows || [];
      const updatedCrops = cropRows || [];
      const updatedCattle = cattleRows || [];
      const updatedBases = baseRows || [];
      const updatedPonds = pondRows || [];
      const updatedServices = serviceRows || [];

      // Save to LocalStorage (overwrites whatever was cached before).
      localStorage.setItem('kisanbit_user_profile', JSON.stringify(userRow));
      localStorage.setItem('kisanbit_user_fields', JSON.stringify(updatedFields));
      localStorage.setItem('kisanbit_user_crops', JSON.stringify(updatedCrops));
      localStorage.setItem('kisanbit_user_cattle', JSON.stringify(updatedCattle));
      localStorage.setItem('kisanbit_user_cattle_bases', JSON.stringify(updatedBases));
      localStorage.setItem('kisanbit_user_ponds', JSON.stringify(updatedPonds));
      localStorage.setItem('kisanbit_user_services', JSON.stringify(updatedServices));

      setProfile(userRow);
      setFields(updatedFields);
      setCrops(updatedCrops);
      setCattle(updatedCattle);
      setCattleBases(updatedBases);
      setPonds(updatedPonds);
      setServices(updatedServices);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Update Cache Helper
  const updateFieldsCache = (newFields, newCrops) => {
    setFields(newFields);
    localStorage.setItem('kisanbit_user_fields', JSON.stringify(newFields));
    if (newCrops) {
      setCrops(newCrops);
      localStorage.setItem('kisanbit_user_crops', JSON.stringify(newCrops));
    }
  };

  // Called by AddFieldForm on success, in BOTH add and edit mode.
  // savedField: the fields row that was inserted/updated.
  // savedCrops: the final crops_marketplace rows for that field.
  const handleFieldSaved = (savedField, savedCrops) => {
    const isEditing = fields.some((f) => f.id === savedField.id);

    const updatedFields = isEditing
      ? fields.map((f) => (f.id === savedField.id ? savedField : f))
      : [...fields, savedField];

    const otherCrops = crops.filter((c) => c.field_id !== savedField.id);
    const updatedCrops = [...otherCrops, ...(savedCrops || [])];

    updateFieldsCache(updatedFields, updatedCrops);
    setFieldFormMode(null);
    setEditingField(null); // closes the edit popup, if that's what was open
  };

  const handleFieldDeleted = (fieldId) => {
    const updatedFields = fields.filter((f) => f.id !== fieldId);
    const updatedCrops = crops.filter((c) => c.field_id !== fieldId);
    updateFieldsCache(updatedFields, updatedCrops);
  };

  // "Edit" — open the popup focused on the form's details (name, crops, soil).
  const handleEditField = (field) => {
    setEditFocus('details');
    setEditingField(field);
  };

  const closeEditPopup = () => {
    setEditingField(null);
    setEditFocusCropId(null);
  };

  // FieldCard's Listed/List toggle — field-for-rent redesign. FieldCard
  // no longer has a "✏️ Boundary" button (boundary re-draw still lives
  // inside AddFieldForm's Edit mode, via "Update Field" -> "Re-draw
  // boundary") or per-crop chip/Update/Delete affordances (that's
  // FieldInfoPanel/CropCard territory now, not this screen) - those old
  // handlers (handleEditBoundary/handleEditCrop/handleCropDeleted) are
  // gone along with the buttons that called them. This is the only new
  // handler FieldCard needs: flip fields.is_public and sync local state,
  // same optimistic-update pattern as handleToggleServiceAvailability
  // below for services.
  const handleToggleFieldListed = async (field, nextListed) => {
    const { error } = await supabase
      .from('fields')
      .update({ is_public: nextListed })
      .eq('id', field.id);
    if (error) {
      console.error('[ProfileScreen] failed to toggle field listing:', error.message);
      return;
    }
    const updatedFields = fields.map((f) => (f.id === field.id ? { ...f, is_public: nextListed } : f));
    updateFieldsCache(updatedFields);
  };

  // Called by AddCattleBaseForm on success, in BOTH add and edit mode -
  // same isEditing-by-id-lookup pattern as handleFieldSaved above, so a
  // saved edit replaces the existing row in cattleBases instead of adding
  // a duplicate.
  const handleBaseSaved = (savedBase) => {
    const isEditingBase = cattleBases.some((b) => b.id === savedBase.id);
    const updatedBases = isEditingBase
      ? cattleBases.map((b) => (b.id === savedBase.id ? savedBase : b))
      : [...cattleBases, savedBase];
    setCattleBases(updatedBases);
    localStorage.setItem('kisanbit_user_cattle_bases', JSON.stringify(updatedBases));
    setShowAddBaseForm(false);
    setEditingBase(null);
  };

  // Delete a Cattle Base. NOTE: whether cattle.base_id is FK'd with
  // ON DELETE SET NULL / CASCADE / RESTRICT is unconfirmed (Phase 2 status
  // is still "STATUS UNCONFIRMED" per the handover) - if it's RESTRICT and
  // this Base still has cattle pointing at it, the delete will fail and
  // that failure surfaces via baseDeleteError below rather than silently
  // losing data. Not adding a client-side "reassign/orphan cattle first"
  // step until that FK behavior is actually verified.
  const handleDeleteBase = async (baseId) => {
    setDeletingBase(true);
    setBaseDeleteError(null);
    try {
      const { error } = await supabase.from('cattle_bases').delete().eq('id', baseId);
      if (error) throw error;

      const updatedBases = cattleBases.filter((b) => b.id !== baseId);
      setCattleBases(updatedBases);
      localStorage.setItem('kisanbit_user_cattle_bases', JSON.stringify(updatedBases));
      setDeletingBaseId(null);
    } catch (err) {
      setBaseDeleteError(toUserMessage(err));
    } finally {
      setDeletingBase(false);
    }
  };

  // Called by AddPondForm on success, in BOTH add and edit mode - same
  // isEditing-by-id-lookup pattern as handleBaseSaved above.
  const handlePondSaved = (savedPond) => {
    const isEditingPond = ponds.some((p) => p.id === savedPond.id);
    const updatedPonds = isEditingPond
      ? ponds.map((p) => (p.id === savedPond.id ? savedPond : p))
      : [...ponds, savedPond];
    setPonds(updatedPonds);
    localStorage.setItem('kisanbit_user_ponds', JSON.stringify(updatedPonds));
    setShowAddPondForm(false);
    setEditingPond(null);
  };

  // Delete a Pond. pond_fish_stock.pond_id has ON DELETE CASCADE (see
  // add_iot_ponds_tables.sql), so deleting a Pond here also removes its
  // fish stock rows at the DB level - no separate confirmation step for
  // the fish beyond this one.
  const handleDeletePond = async (pondId) => {
    setDeletingPond(true);
    setPondDeleteError(null);
    try {
      const { error } = await supabase.from('ponds').delete().eq('id', pondId);
      if (error) throw error;

      const updatedPonds = ponds.filter((p) => p.id !== pondId);
      setPonds(updatedPonds);
      localStorage.setItem('kisanbit_user_ponds', JSON.stringify(updatedPonds));
      setDeletingPondId(null);
    } catch (err) {
      setPondDeleteError(toUserMessage(err));
    } finally {
      setDeletingPond(false);
    }
  };

  // Called by AddServiceForm on success, in BOTH add and edit mode -
  // same isEditing-by-id-lookup pattern as handleBaseSaved/handlePondSaved.
  const handleServiceSaved = (savedService) => {
    const isEditingService = services.some((s) => s.id === savedService.id);
    const updatedServices = isEditingService
      ? services.map((s) => (s.id === savedService.id ? savedService : s))
      : [...services, savedService];
    setServices(updatedServices);
    localStorage.setItem('kisanbit_user_services', JSON.stringify(updatedServices));
    setShowAddServiceForm(false);
    setEditingService(null);
  };

  // Flip is_available directly from the card header, no popup. Same
  // update-in-place pattern as handleServiceSaved (local state + the
  // kisanbit_user_services cache both updated so the card and any other
  // screen reading that cache key stay in sync).
  const handleToggleServiceAvailability = async (service) => {
    const nextValue = !service.is_available;
    setTogglingServiceId(service.id);
    setServiceToggleError(null);
    try {
      const { error } = await supabase
        .from('services')
        .update({ is_available: nextValue })
        .eq('id', service.id);
      if (error) throw error;

      const updatedServices = services.map((s) =>
        s.id === service.id ? { ...s, is_available: nextValue } : s
      );
      setServices(updatedServices);
      localStorage.setItem('kisanbit_user_services', JSON.stringify(updatedServices));
    } catch (err) {
      setServiceToggleError({ id: service.id, message: toUserMessage(err) });
    } finally {
      setTogglingServiceId(null);
    }
  };

  // Delete a Service - same pattern as handleDeleteBase/handleDeletePond.
  const handleDeleteService = async (serviceId) => {
    setDeletingService(true);
    setServiceDeleteError(null);
    try {
      const { error } = await supabase.from('services').delete().eq('id', serviceId);
      if (error) throw error;

      const updatedServices = services.filter((s) => s.id !== serviceId);
      setServices(updatedServices);
      localStorage.setItem('kisanbit_user_services', JSON.stringify(updatedServices));
      setDeletingServiceId(null);
    } catch (err) {
      setServiceDeleteError(toUserMessage(err));
    } finally {
      setDeletingService(false);
    }
  };

  // FIXED: this used to call supabase.auth.signOut() directly, which
  // skips authService.signOut()'s clearOfflineCredential() call. That
  // meant logging out from this screen left the salted offline-login
  // credential intact on the device — exactly the "lost/stolen device
  // can offline-login after logout" scenario that mechanism exists to
  // prevent, just reachable from this one entry point. Now goes
  // through the shared signOut() wrapper so both paths clear it.
  const handleLogOut = async () => {
    localStorage.removeItem('kisanbit_user_profile');
    localStorage.removeItem('kisanbit_user_fields');
    localStorage.removeItem('kisanbit_user_crops');
    localStorage.removeItem('kisanbit_user_cattle');
    await signOut();
    window.location.reload();
  };

  // FIXED: now calls the delete-account Edge Function (service-role,
  // deletes the actual auth.users row) instead of only deleting the
  // public.users profile row client-side. Deleting auth.users cascades
  // through public.users -> cattle/fields/crops_marketplace via the
  // existing "on delete cascade" foreign keys in schema_complete.sql,
  // so no separate cleanup queries are needed here - one call handles
  // the full Play Store "complete data removal" requirement.
  const handleDeleteAccount = async () => {
    setDeletingAccount(true);
    setDeleteAccountError(null);
    try {
      const { error } = await supabase.functions.invoke('delete-account');
      if (error) throw error;
      await handleLogOut();
    } catch (err) {
      // Was a hardcoded generic alert() - now surfaces the real
      // failure reason (via toUserMessage, so raw Postgres errors
      // still aren't shown directly) as inline modal text instead of
      // a blocking native dialog.
      setDeleteAccountError(toUserMessage(err));
      setDeletingAccount(false);
    }
  };

  if (loading) {
    // Lightweight skeleton echoing the real layout below (identity
    // header + a couple of section cards) instead of a bare "Loading…"
    // string - was previously just centered text.
    const pulse = { background: 'var(--color-border)', borderRadius: 8, opacity: 0.6 };
    return (
      <div style={{ height: '100%', overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 14, background: 'var(--color-bg)' }}>
        <div className="kb-card" style={{ padding: 20, display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 56, height: 56, borderRadius: '50%', ...pulse }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ width: '60%', height: 16, ...pulse }} />
            <div style={{ width: '40%', height: 12, ...pulse }} />
          </div>
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="kb-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ width: '35%', height: 14, ...pulse }} />
            <div style={{ width: '90%', height: 12, ...pulse }} />
            <div style={{ width: '70%', height: 12, ...pulse }} />
          </div>
        ))}
      </div>
    );
  }

 if (!profile) {
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <p style={{ textAlign: 'center', color: 'var(--color-ink)' }}>
          Please log in to view your profile.
        </p>
      </div>
    );
  }

  const isPremium = profile.subscription === 'premium';

  // Renders one Cattle Base card. Factored out (instead of writing the
  // JSX twice) since it's used both in the horizontal strip and, again,
  // inside the "View All" modal below.
  const renderBaseCard = (b) => {
    const animalCount = cattle.filter((c) => c.base_id === b.id).length;
    return (
      <div key={b.id} className="kb-card" style={{ overflow: 'hidden', padding: 0 }}>
        <div
          style={{
            background: 'var(--color-success, #2e8b57)', padding: '10px 14px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}
        >
          <div
            style={{
              width: 32, height: 32, borderRadius: '50%', background: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
              flexShrink: 0,
            }}
          >
            🏠
          </div>

          {deletingBaseId === b.id ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#fff' }}>Delete this Base?</span>
              <button
                type="button"
                onClick={() => handleDeleteBase(b.id)}
                disabled={deletingBase}
                style={{ border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
              >
                {deletingBase ? '...' : 'Yes'}
              </button>
              <button
                type="button"
                onClick={() => setDeletingBaseId(null)}
                disabled={deletingBase}
                style={{ border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setEditingBase(b)}
                style={{ border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setDeletingBaseId(b.id)}
                style={{ border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
              >
                Delete
              </button>
            </div>
          )}
        </div>

        <div style={{ padding: '12px 14px' }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-ink)' }}>
            {b.base_name}
          </div>
          <div style={{ borderTop: '1px solid var(--color-border)', margin: '8px 0' }} />
          <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
            🐄 {animalCount} animal{animalCount === 1 ? '' : 's'}
          </div>
          {baseDeleteError && deletingBaseId === b.id && (
            <div style={{ fontSize: 11, color: 'var(--color-danger)', marginTop: 6 }}>{baseDeleteError}</div>
          )}
        </div>
      </div>
    );
  };

  // Renders one Pond card - same factoring reason as renderBaseCard above.
  const renderPondCard = (p) => (
    <div key={p.id} className="kb-card" style={{ overflow: 'hidden', padding: 0 }}>
      <div
        style={{
          background: 'var(--color-success, #2e8b57)', padding: '10px 14px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}
      >
        <div
          style={{
            width: 32, height: 32, borderRadius: '50%', background: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
            flexShrink: 0,
          }}
        >
          🐟
        </div>

        {deletingPondId === p.id ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#fff' }}>Delete this Pond?</span>
            <button
              type="button"
              onClick={() => handleDeletePond(p.id)}
              disabled={deletingPond}
              style={{ border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
            >
              {deletingPond ? '...' : 'Yes'}
            </button>
            <button
              type="button"
              onClick={() => setDeletingPondId(null)}
              disabled={deletingPond}
              style={{ border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => setEditingPond(p)}
              style={{ border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setDeletingPondId(p.id)}
              style={{ border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
            >
              Delete
            </button>
          </div>
        )}
      </div>

      <div style={{ padding: '12px 14px' }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-ink)' }}>
          {p.pond_name}
        </div>
        <div style={{ borderTop: '1px solid var(--color-border)', margin: '8px 0' }} />
        <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
          {p.area_acres != null ? `${p.area_acres} acres` : 'Size not set'}
          {p.water_source ? ` · ${p.water_source}` : ''}
        </div>
        {pondDeleteError && deletingPondId === p.id && (
          <div style={{ fontSize: 11, color: 'var(--color-danger)', marginTop: 6 }}>{pondDeleteError}</div>
        )}
      </div>
    </div>
  );

  // Renders one Service card - same factoring reason as renderBaseCard/
  // renderPondCard above.
  const renderServiceCard = (s) => (
    <div key={s.id} className="kb-card" style={{ overflow: 'hidden', padding: 0 }}>
      <div
        style={{
          background: 'var(--color-success, #2e8b57)', padding: '10px 14px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}
      >
        <div
          style={{
            width: 32, height: 32, borderRadius: '50%', background: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
            flexShrink: 0,
          }}
        >
          🛠️
        </div>

        {deletingServiceId === s.id ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#fff' }}>Delete this Service?</span>
            <button
              type="button"
              onClick={() => handleDeleteService(s.id)}
              disabled={deletingService}
              style={{ border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
            >
              {deletingService ? '...' : 'Yes'}
            </button>
            <button
              type="button"
              onClick={() => setDeletingServiceId(null)}
              disabled={deletingService}
              style={{ border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => handleToggleServiceAvailability(s)}
              disabled={togglingServiceId === s.id}
              aria-label={s.is_available ? 'Mark unavailable' : 'Mark available'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, border: 'none',
                background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6,
                padding: '6px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                opacity: togglingServiceId === s.id ? 0.6 : 1,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 28, height: 16, borderRadius: 8, position: 'relative', flexShrink: 0,
                  background: s.is_available ? 'var(--color-gold)' : 'rgba(255,255,255,0.35)',
                  border: '1px solid rgba(255,255,255,0.6)', transition: 'background 0.15s',
                }}
              >
                <span
                  style={{
                    position: 'absolute', top: 1, left: s.is_available ? 13 : 1,
                    width: 12, height: 12, borderRadius: '50%', background: '#fff', transition: 'left 0.15s',
                  }}
                />
              </span>
              {togglingServiceId === s.id ? '...' : (s.is_available ? 'Available' : 'Unavailable')}
            </button>
            <button
              type="button"
              onClick={() => setEditingService(s)}
              style={{ border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setDeletingServiceId(s.id)}
              style={{ border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
            >
              Delete
            </button>
          </div>
        )}
      </div>

      <div style={{ padding: '12px 14px' }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-ink)' }}>
          {s.service_name}
        </div>
        <div style={{ borderTop: '1px solid var(--color-border)', margin: '8px 0' }} />
        <div style={{ fontSize: 13, color: 'var(--color-muted)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ textTransform: 'capitalize' }}>{s.service_type}</span>
          {s.price_amount != null && <span>₹{s.price_amount} / {s.price_unit}</span>}
          <span style={{ color: s.is_available ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {s.is_available ? '🟢 Available' : '🔴 Unavailable'}
          </span>
        </div>
        {serviceDeleteError && deletingServiceId === s.id && (
          <div style={{ fontSize: 11, color: 'var(--color-danger)', marginTop: 6 }}>{serviceDeleteError}</div>
        )}
        {serviceToggleError && serviceToggleError.id === s.id && (
          <div style={{ fontSize: 11, color: 'var(--color-danger)', marginTop: 6 }}>{serviceToggleError.message}</div>
        )}
      </div>
    </div>
  );

  return (
    <div
      style={{
        height: '100%', overflowY: 'auto', padding: 12,
        display: 'flex', flexDirection: 'column', gap: 14, background: 'var(--color-bg)',
      }}
    >
      {/* Identity Header */}
      <div className="kb-card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 16 }}>
        {/* BUG FIX: the camera badge below is deliberately positioned
            partly outside this circle (bottom: -2, right: -2) so it reads
            as a corner badge. That only works if THIS wrapper doesn't
            clip its children - but it previously had overflow:'hidden'
            directly on it (needed to keep the avatar photo/emoji circular),
            which clipped the badge off almost entirely, hiding it. Moved
            overflow:'hidden' + borderRadius onto a new inner wrapper that
            contains only the photo/button, so the badge (a sibling of that
            inner wrapper, not a child of it) is no longer clipped. */}
        <div style={{ position: 'relative', width: 72, height: 72 }}>
          <div style={{ width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', background: 'var(--color-border)' }}>
            <button
              type="button"
              onClick={() => avatarFileInputRef.current?.click()}
              style={{
                all: 'unset', cursor: 'pointer', display: 'flex', width: '100%', height: '100%',
                alignItems: 'center', justifyContent: 'center', background: 'transparent', color: 'inherit',
              }}
            >
              {profile.avatar_url ? (
                <img
                  src={profile.avatar_url}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                '👨‍🌾'
              )}
            </button>
          </div>

          {/* Small camera badge - visually indicates the circle is tappable to change photo */}
          <div
            style={{
              position: 'absolute', bottom: -2, right: -2, width: 20, height: 20, borderRadius: '50%',
              background: 'var(--color-navy)', border: '2px solid var(--color-gold)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10,
              pointerEvents: 'none',
            }}
          >
            {uploadingAvatar ? '…' : '📷'}
          </div>

          <input
            ref={avatarFileInputRef}
            type="file"
            accept="image/*"
            onChange={handleAvatarFileSelected}
            style={{ display: 'none' }}
          />
        </div>

        <div style={{ flex: 1 }}>
          <div className="display-text" style={{ fontSize: 18 }}>{profile.full_name}</div>
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            {profile.phone} · {cattle.length} cattle registered
          </div>
          {profile.village && (
            <div style={{ fontSize: 12, color: 'var(--color-gold)', marginTop: 2 }}>
              📍 Village: {profile.village}
            </div>
          )}
          {avatarError && (
            <div style={{ fontSize: 11, color: '#ffb4a8', marginTop: 4 }}>{avatarError}</div>
          )}
        </div>
      </div>

      {/* Messages */}
      <SectionCard title="Messages" icon="💬">
        <MessagesInbox />
      </SectionCard>

      {/* Subscription Status */}
      {/* Upgrade currently shows a "Coming Soon" message rather than a
          real payment flow - Razorpay isn't wired in yet (firm not
          registered yet per user). subscription column already stores
          'free' | 'premium' (confirmed live via information_schema on
          public.users) - this UI just reads/displays it, doesn't
          change it, since there's no real upgrade path yet.
          COMPACTED per user feedback - the original two-full-bullet-list
          version took up the whole screen. Now a single small box. */}
      <SectionCard title="Subscription Plan" icon="⭐">
        {isPremium ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, color: 'var(--color-success)', fontSize: 14 }}>
              Premium — SMS/Call alerts active
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--color-ink)', fontSize: 14 }}>Free Plan</div>
              <div style={{ fontSize: 12, color: 'var(--color-muted)', marginTop: 2 }}>
                Premium adds SMS + call alerts · ₹450/yr
              </div>
            </div>
            <button
              onClick={() => setShowUpgradeComingSoon(true)}
              style={{
                flexShrink: 0, padding: '8px 16px', borderRadius: 20, border: 'none',
                background: 'var(--color-gold)', color: 'var(--color-ink)', fontWeight: 700,
                fontSize: 13, cursor: 'pointer',
              }}
            >
              Upgrade
            </button>
          </div>
        )}
      </SectionCard>

      {/* Upgrade "Coming Soon" popup */}
      {showUpgradeComingSoon && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setShowUpgradeComingSoon(false); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
          }}
        >
          <div className="kb-card" style={{ padding: 24, maxWidth: 320, width: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🚀</div>
            <h3 style={{ margin: '0 0 8px 0', color: 'var(--color-navy)' }}>Coming Soon</h3>
            <p style={{ fontSize: 13, color: 'var(--color-muted)', marginBottom: 18 }}>
              Online payment for Premium isn't ready yet. We'll notify you here as soon as it's available.
            </p>
            <button
              onClick={() => setShowUpgradeComingSoon(false)}
              style={{
                width: '100%', minHeight: 44, padding: 10, borderRadius: 8, border: 'none',
                background: 'var(--color-navy)', color: '#fff', fontWeight: 700, cursor: 'pointer',
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Registered Lands — horizontal swipe strip (fixed-width cards,
          single row) instead of a vertical stack, so this section's
          height stays constant no matter how many fields exist. "View
          All" opens the same cards again but in a normal vertical list,
          inside a modal, for whenever swiping isn't the easiest way to
          browse/manage them all. */}
      <SectionCard title={`Registered Lands (${fields.length})`} icon="🌾">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {fields.length === 0 ? (
            <p style={{ color: 'var(--color-muted)', margin: 0 }}>No fields registered yet.</p>
          ) : (
            <div style={{ display: 'flex', overflowX: 'auto', gap: 10, paddingBottom: 4, WebkitOverflowScrolling: 'touch' }}>
              {fields.map((f) => (
                <div key={f.id} style={{ flexShrink: 0, width: STRIP_CARD_WIDTH, position: 'relative' }}>
                  <FieldCard
                    field={f}
                    crops={crops.filter((c) => c.field_id === f.id)}
                    onDeleted={handleFieldDeleted}
                    onEdit={handleEditField}
                    onToggleListed={handleToggleFieldListed}
                  />
                </div>
              ))}
            </div>
          )}

          {fields.length > 1 && (
            <ViewAllToggle total={fields.length} onOpen={() => setShowAllFields(true)} />
          )}

          {!fieldFormMode && (
            <button
              onClick={() => setFieldFormMode('add')}
              style={{
                minHeight: 48, padding: '10px 0', borderRadius: 10, border: '2px dashed var(--color-gold)',
                background: 'transparent', color: 'var(--color-navy)', fontWeight: 700, cursor: 'pointer',
              }}
            >
              + Add Field
            </button>
          )}
        </div>
      </SectionCard>

      {/* Cattle Bases — same card shell, header strip, and "+ Add" button
          pattern as Registered Lands above, so the two sections read as
          one consistent list style instead of two different UIs.
          NOTE: a leftover duplicate block used to sit right after this
          SectionCard that re-rendered a second, unstyled copy of both the
          Add Field and Add Cattle Base forms (outside the real modal
          overlay further down this file) — that's what was producing two
          conflicting popups per action. Removed; both "+ Add" buttons
          here now go through the single modal instance defined near the
          bottom of the file. */}
      <SectionCard title={`Cattle Bases (${cattleBases.length})`} icon="🏠">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {cattleBases.length === 0 ? (
            <p style={{ color: 'var(--color-muted)', margin: 0 }}>No Cattle Bases yet.</p>
          ) : (
            <div style={{ display: 'flex', overflowX: 'auto', gap: 10, paddingBottom: 4, WebkitOverflowScrolling: 'touch' }}>
              {cattleBases.map((b) => (
                <div key={b.id} style={{ flexShrink: 0, width: STRIP_CARD_WIDTH }}>
                  {renderBaseCard(b)}
                </div>
              ))}
            </div>
          )}

          {cattleBases.length > 1 && (
            <ViewAllToggle total={cattleBases.length} onOpen={() => setShowAllBases(true)} />
          )}

          {!showAddBaseForm && (
            <button
              onClick={() => setShowAddBaseForm(true)}
              style={{
                minHeight: 48, padding: '10px 0', borderRadius: 10, border: '2px dashed var(--color-gold)',
                background: 'transparent', color: 'var(--color-navy)', fontWeight: 700, cursor: 'pointer',
              }}
            >
              + Add Cattle Base
            </button>
          )}
        </div>
      </SectionCard>

      {/* Ponds — same card shell/header-strip/"+ Add" pattern as Cattle
          Bases above. Fish stock (per-pond) is added on HomeScreen via
          PondsPanel.jsx, not here - this section only owns the Pond
          itself (name/size/water source), same split as
          Field (Profile) / Crop (HomeScreen). */}
      <SectionCard title={`Ponds (${ponds.length})`} icon="🐟">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ponds.length === 0 ? (
            <p style={{ color: 'var(--color-muted)', margin: 0 }}>No Ponds yet.</p>
          ) : (
            <div style={{ display: 'flex', overflowX: 'auto', gap: 10, paddingBottom: 4, WebkitOverflowScrolling: 'touch' }}>
              {ponds.map((p) => (
                <div key={p.id} style={{ flexShrink: 0, width: STRIP_CARD_WIDTH }}>
                  {renderPondCard(p)}
                </div>
              ))}
            </div>
          )}

          {ponds.length > 1 && (
            <ViewAllToggle total={ponds.length} onOpen={() => setShowAllPonds(true)} />
          )}

          {!showAddPondForm && (
            <button
              onClick={() => setShowAddPondForm(true)}
              style={{
                minHeight: 48, padding: '10px 0', borderRadius: 10, border: '2px dashed var(--color-gold)',
                background: 'transparent', color: 'var(--color-navy)', fontWeight: 700, cursor: 'pointer',
              }}
            >
              + Add Pond
            </button>
          )}
        </div>
      </SectionCard>

      {/* Services — same card shell/header-strip/"+ Add" pattern as
          Cattle Bases/Ponds above. Unlike those, a Service is meant to
          be discovered by other farmers/buyers - each one is pinned on
          the full map (FullMapModal) with a "Chat to Book" button, same
          as a Cattle listing. */}
      <SectionCard title={`Services (${services.length})`} icon="🛠️">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {services.length === 0 ? (
            <p style={{ color: 'var(--color-muted)', margin: 0 }}>No Services listed yet.</p>
          ) : (
            <div style={{ display: 'flex', overflowX: 'auto', gap: 10, paddingBottom: 4, WebkitOverflowScrolling: 'touch' }}>
              {services.map((s) => (
                <div key={s.id} style={{ flexShrink: 0, width: STRIP_CARD_WIDTH }}>
                  {renderServiceCard(s)}
                </div>
              ))}
            </div>
          )}

          {services.length > 1 && (
            <ViewAllToggle total={services.length} onOpen={() => setShowAllServices(true)} />
          )}

          {!showAddServiceForm && (
            <button
              onClick={() => setShowAddServiceForm(true)}
              style={{
                minHeight: 48, padding: '10px 0', borderRadius: 10, border: '2px dashed var(--color-gold)',
                background: 'transparent', color: 'var(--color-navy)', fontWeight: 700, cursor: 'pointer',
              }}
            >
              + Add Service
            </button>
          )}
        </div>
      </SectionCard>

      {/* Active Devices */}
      {/* FIXED: was keyed on cattle.device_alias / cattle.battery_pct, both
          confirmed NOT to exist on the live `cattle` table this session -
          this section (and the query feeding it) was silently broken,
          always showing "No devices paired yet" regardless of real data.
          Repurposed to the real tag_deveui column (the GoTag Hardware ID
          set in AddCattleForm's scan step) since there's no battery-level
          data source yet - that would need its own schema/hardware work,
          out of scope here. */}
      <SectionCard title={`Active Devices (${cattle.filter((c) => c.tag_deveui).length})`} icon="📡">
        {cattle.filter((c) => c.tag_deveui).length === 0 ? (
          <p style={{ color: 'var(--color-muted)', margin: 0 }}>No devices paired yet.</p>
        ) : (
          cattle.filter((c) => c.tag_deveui).map((c) => (
            <div
              key={c.id}
              style={{
                padding: '10px 0', borderBottom: '1px solid var(--color-border)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
            >
              <span>{c.name}</span>
              <span style={{ fontFamily: 'monospace', color: 'var(--color-navy)', fontSize: 13 }}>{c.tag_deveui}</span>
            </div>
          ))
        )}
      </SectionCard>

      {/* LoRa Collar IDs */}
      <SectionCard title="LoRa Collar IDs" icon="📡">
        {cattle.filter((c) => c.collar_id).length === 0 ? (
          <p style={{ color: 'var(--color-muted)', margin: 0 }}>No collars linked yet.</p>
        ) : (
          cattle.filter((c) => c.collar_id).map((c) => (
            <div
              key={c.id}
              style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between' }}
            >
              <span>{c.name} ({c.animal_type})</span>
              <span style={{ fontFamily: 'monospace', color: 'var(--color-navy)' }}>{c.collar_id}</span>
            </div>
          ))
        )}
      </SectionCard>

      {/* Legal & Account Settings */}
      <SectionCard title="Account Settings" icon="⚙️">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button
            type="button"
            onClick={() => setIsDarkMode((prev) => !prev)}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
              background: 'none', border: 'none', padding: 0, color: 'var(--color-navy)', fontSize: 14, cursor: 'pointer',
            }}
          >
            <span>{isDarkMode ? '🌙 Dark Mode' : '☀️ Light Mode'}</span>
            <span
              aria-hidden="true"
              style={{
                width: 40, height: 22, borderRadius: 11, position: 'relative',
                background: isDarkMode ? 'var(--color-navy)' : 'var(--color-border)',
                border: '1px solid var(--color-border)', transition: 'background 0.15s',
              }}
            >
              <span
                style={{
                  position: 'absolute', top: 1, left: isDarkMode ? 19 : 1,
                  width: 18, height: 18, borderRadius: '50%', background: 'var(--color-gold)',
                  transition: 'left 0.15s',
                }}
              />
            </span>
          </button>

          <a
            href="/privacy-policy"
            style={{ display: 'flex', justifyContent: 'space-between', textDecoration: 'none', color: 'var(--color-navy)', fontSize: 14 }}
          >
            <span>📜 Privacy Policy</span>
            <span>›</span>
          </a>
          <a
            href="mailto:kisanbitcattle@gmail.com"
            style={{ display: 'flex', justifyContent: 'space-between', textDecoration: 'none', color: 'var(--color-navy)', fontSize: 14 }}
          >
            <span>📞 Help Line / Support</span>
            <span>›</span>
          </a>
        </div>
      </SectionCard>

      {/* Social Media Links — placeholders per user request, REPLACE_ME
          URLs below once they send the actual channel/page links. */}
      <SectionCard title="Connect With Us" icon="🔗">
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <a
            href="http://www.youtube.com/@Kisanbit"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="YouTube"
            style={{
              width: 48, height: 48, borderRadius: '50%', background: '#FF0000',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
              textDecoration: 'none',
            }}
          >
            ▶️
          </a>
          <a
            href="https://instagram.com/REPLACE_ME"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Instagram"
            style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
              textDecoration: 'none',
            }}
          >
            📸
          </a>
          <a
            href="https://facebook.com/REPLACE_ME"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Facebook"
            style={{
              width: 48, height: 48, borderRadius: '50%', background: '#1877F2',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
              textDecoration: 'none',
            }}
          >
            f
          </a>
        </div>
      </SectionCard>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, marginBottom: 20 }}>
        <button
          onClick={handleLogOut}
          style={{
            minHeight: 48, padding: 12, borderRadius: 12, border: '2px solid var(--color-danger)',
            background: 'transparent', color: 'var(--color-danger)', fontWeight: 700, cursor: 'pointer',
          }}
        >
          Log Out
        </button>

        <button
          onClick={() => setShowDeleteAccountModal(true)}
          style={{
            background: 'none', border: 'none', color: 'var(--color-danger)',
            fontSize: 12, textDecoration: 'underline', cursor: 'pointer', padding: 4,
          }}
        >
          Delete Account (Warning: Permanent Action)
        </button>
      </div>

      {/* Registered Lands — "View All" modal: same FieldCard list as the
          horizontal strip above, just stacked vertically for easy
          one-at-a-time browsing/management. */}
      {showAllFields && (
        <ListModal title={`Registered Lands (${fields.length})`} icon="🌾" onClose={() => setShowAllFields(false)}>
          {fields.map((f) => (
            <div key={f.id} style={{ position: 'relative' }}>
              <FieldCard
                field={f}
                crops={crops.filter((c) => c.field_id === f.id)}
                onDeleted={handleFieldDeleted}
                onEdit={handleEditField}
                onToggleListed={handleToggleFieldListed}
              />
            </div>
          ))}
        </ListModal>
      )}

      {/* Add Field Popup — same pattern as the Edit Field popup below,
          for consistency (previously this rendered inline in the page
          scroll instead of popping up, unlike Edit). */}
      {fieldFormMode === 'add' && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setFieldFormMode(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
          }}
        >
          <div
            className="kb-card"
            style={{
              padding: 16, maxWidth: 480, width: '100%', maxHeight: '90vh',
              overflowY: 'auto', position: 'relative',
            }}
          >
            <button
              type="button"
              onClick={() => setFieldFormMode(null)}
              aria-label="Close"
              style={{
                position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: '50%',
                border: 'none', background: 'var(--color-border)', color: 'var(--color-ink)', fontWeight: 700,
                cursor: 'pointer', lineHeight: 1,
              }}
            >
              ✕
            </button>

            <AddFieldForm onSaved={handleFieldSaved} onCancel={() => setFieldFormMode(null)} />
          </div>
        </div>
      )}

      {/* Cattle Bases — "View All" modal: same cards as the horizontal
          strip above, stacked vertically. */}
      {showAllBases && (
        <ListModal title={`Cattle Bases (${cattleBases.length})`} icon="🏠" onClose={() => setShowAllBases(false)}>
          {cattleBases.map((b) => renderBaseCard(b))}
        </ListModal>
      )}

      {/* Add Cattle Base Popup */}
      {showAddBaseForm && (
        <AddCattleBaseForm
          onClose={() => setShowAddBaseForm(false)}
          onSaved={handleBaseSaved}
        />
      )}

      {/* Edit Cattle Base Popup — tapping "Edit" on a Base card sets
          editingBase but nothing rendered off it (AddCattleBaseForm had no
          edit-mode support). Now that it does, this mirrors the Add Cattle
          Base popup above, just pre-filled via initialBase. */}
      {editingBase && (
        <AddCattleBaseForm
          initialBase={editingBase}
          onClose={() => setEditingBase(null)}
          onSaved={handleBaseSaved}
        />
      )}

      {/* Ponds — "View All" modal: same cards as the horizontal strip above. */}
      {showAllPonds && (
        <ListModal title={`Ponds (${ponds.length})`} icon="🐟" onClose={() => setShowAllPonds(false)}>
          {ponds.map((p) => renderPondCard(p))}
        </ListModal>
      )}

      {/* Add Pond Popup */}
      {showAddPondForm && (
        <AddPondForm
          onClose={() => setShowAddPondForm(false)}
          onSaved={handlePondSaved}
        />
      )}

      {/* Edit Pond Popup — mirrors the Edit Cattle Base popup above. */}
      {editingPond && (
        <AddPondForm
          initialPond={editingPond}
          onClose={() => setEditingPond(null)}
          onSaved={handlePondSaved}
        />
      )}

      {/* Services — "View All" modal: same cards as the horizontal strip
          above, including the Available/Unavailable toggle on every card. */}
      {showAllServices && (
        <ListModal title={`Services (${services.length})`} icon="🛠️" onClose={() => setShowAllServices(false)}>
          {services.map((s) => renderServiceCard(s))}
        </ListModal>
      )}

      {/* Add Service Popup */}
      {showAddServiceForm && (
        <AddServiceForm
          onClose={() => setShowAddServiceForm(false)}
          onSaved={handleServiceSaved}
        />
      )}

      {/* Edit Service Popup — mirrors the Edit Pond/Cattle Base popups above. */}
      {editingService && (
        <AddServiceForm
          initialService={editingService}
          onClose={() => setEditingService(null)}
          onSaved={handleServiceSaved}
        />
      )}

      {/* Edit Field Popup — single shared instance, rendered once, OUTSIDE
          the fields.map() loop above. editingField holds at most one field
          object, so at most one popup (and one <AddFieldForm>) can ever be
          mounted at a time, no matter how many fields are in the list. */}
      {editingField && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeEditPopup(); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
          }}
        >
          <div
            className="kb-card"
            style={{
              padding: 16, maxWidth: 480, width: '100%', maxHeight: '90vh',
              overflowY: 'auto', position: 'relative',
            }}
          >
            <button
              type="button"
              onClick={closeEditPopup}
              aria-label="Close"
              style={{
                position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: '50%',
                border: 'none', background: 'var(--color-border)', color: 'var(--color-ink)', fontWeight: 700,
                cursor: 'pointer', lineHeight: 1,
              }}
            >
              ✕
            </button>

            {/* key={editingField.id} forces a fresh AddFieldForm instance
                whenever the target field (or focus target) changes, so its
                internal state doesn't leak between fields/re-opens. */}
            <AddFieldForm
              key={`${editingField.id}-${editFocus}-${editFocusCropId || 'new'}`}
              initialField={editingField}
              initialCrops={crops.filter((c) => c.field_id === editingField.id)}
              onSaved={handleFieldSaved}
              onCancel={closeEditPopup}
              focusSection={editFocus}
              focusCropId={editFocusCropId}
            />
          </div>
        </div>
      )}

      {/* Delete Account Secondary Modal */}
      {showDeleteAccountModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
        }}>
          <div className="kb-card" style={{ padding: 20, maxWidth: 360, width: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>⚠️</div>
            <h3 style={{ margin: '0 0 8px 0', color: 'var(--color-navy)' }}>Delete Account?</h3>
            <p style={{ fontSize: 13, color: 'var(--color-muted)', marginBottom: 20 }}>
              Your fields, livestock, and profile data will be permanently deleted. This action cannot be undone.
            </p>
            {deleteAccountError && (
              <p style={{ fontSize: 13, color: 'var(--color-danger)', marginBottom: 14 }}>{deleteAccountError}</p>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => { setShowDeleteAccountModal(false); setDeleteAccountError(null); }}
                disabled={deletingAccount}
                style={{ flex: 1, minHeight: 48, padding: 10, borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-bg)', fontWeight: 700 }}
              >
                No, Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deletingAccount}
                style={{ flex: 1, minHeight: 48, padding: 10, borderRadius: 8, border: 'none', background: 'var(--color-danger)', color: '#fff', fontWeight: 700, opacity: deletingAccount ? 0.6 : 1 }}
              >
                {deletingAccount ? 'Deleting...' : 'Yes, Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}