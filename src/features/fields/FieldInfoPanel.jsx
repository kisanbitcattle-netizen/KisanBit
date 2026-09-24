// src/components/FieldInfoPanel.jsx
//
// Crop counterpart to CattleInfoPanel.jsx - same collapsible-card
// shell, same "+ Add" pattern, same offline-cache-first loading. Sits on
// HomeScreen right below CattleInfoPanel.
//
// REDESIGNED (Home 2x2 grid): this panel now renders CROPS as the
// primary cards (CropCard.jsx), not fields-with-crop-chips
// (FieldCard.jsx - that component still renders unchanged in
// ProfileScreen.jsx, this file just no longer uses it). Each crop card
// shows its parent field's name as a subtitle only (looked up from
// fieldsList by field_id) - no field detail, boundary, or picker is
// shown here, since the field was already chosen when the crop was
// created via AddCropForm's dropdown/lockedField. A crop's Listed
// state is a tap-to-toggle switch right on the card (handleToggleListed
// below), mirroring the Services card's Available switch, instead of
// only being editable inside the AddCropForm checkbox.
//
// ASSUMPTIONS (flagged for user confirmation next session, per the
// "don't guess on schema/business logic" rule):
// 1. Always renders the logged-in farmer's own fields/crops, regardless
//    of the Farmer/Buyer toggle - that toggle only changes what
//    MapPreviewCard/FullMapModal show (own cattle vs marketplace-listed
//    cattle). No buyer-facing browsing view exists for fields/crops
//    here, and none is planned for this panel.
// 2. NOT using CattleInfoPanel's delta-sync-by-updated_at optimization -
//    that depends on a confirmed `updated_at` column on `cattle`, but
//    whether `fields`/`crops_marketplace` reliably have the same is
//    unconfirmed. Using a simpler full-refetch-on-load pattern instead
//    (same as ProfileScreen.jsx's existing fields fetch), safer than
//    guessing a delta filter that could silently drop rows.
// 3. `fields` has no confirmed "place"/location text column beyond
//    `name` - CropCard shows just the field name as the subtitle. Flag
//    if there's a real village/place text field that should show too.
// 4. Home's top-level "+ Add Crop" button still opens AddCropForm.jsx
//    with no lockedField, so the farmer picks an existing field from
//    the dropdown - field creation/boundary/soil editing stays
//    Profile-tab-only per the existing explicit user requirement.

import { useEffect, useState } from 'react';
import { supabase } from '../../config/supabaseClient';
import { offlineCache } from '../../utils/offlineCache';
import CropCard from './CropCard';
import AddCropForm from './AddCropForm';
import SectionBoxHeader from '../../shared/SectionBoxHeader';
import { useUser } from '../../context/UserContext';

export default function FieldInfoPanel({ isOpen, onToggle }) {
  const [fieldsList, setFieldsList] = useState([]);
  const [cropsList, setCropsList] = useState([]);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [actionError, setActionError] = useState(null);

  // Add-a-crop-to-an-existing-field popup - single shared instance, same
  // pattern as ProfileScreen.jsx's editingField. Edit/Boundary/Delete on
  // the field itself are Profile-tab-only; this panel only ever touches
  // crops_marketplace rows.
  const [addCropField, setAddCropField] = useState(null);
  // Null = the popup is creating a NEW crop (per-card "+ Add Crop" pill,
  // or the section's top-level "+ Add Crop"). Set = FieldCard's
  // per-crop "Update" button on a specific existing crop - passed to
  // AddCropForm as editingCrop.
  const [editCropId, setEditCropId] = useState(null);
  // Read from context instead of calling supabase.auth.getUser() here -
  // App.jsx already resolved this once. See UserContext.jsx.
  const { user } = useUser();

  useEffect(() => {
    let channel;
    let cancelled = false;

    async function loadAll(userId) {
      const cachedFields = await offlineCache.getAll('fieldsPanel');
      const cachedCrops = await offlineCache.getAll('cropsMarketplacePanel');
      if (cancelled) return;
      if (cachedFields.length) setFieldsList(cachedFields);
      if (cachedCrops.length) setCropsList(cachedCrops);

      if (!navigator.onLine) return; // stay on cache; no doomed network call

      let fieldsQuery = supabase.from('fields').select('*, boundary_geojson');
      let cropsQuery = supabase.from('crops_marketplace').select('*');
      // CRITICAL: scope both to the logged-in owner. Without this,
      // fields_public_select (is_public = true, no owner check) leaks
      // OTHER farmers' public fields/crops into this farmer's own Field
      // panel - same leak class already found and fixed in
      // CattleInfoPanel.jsx via public_select_listed_cattle. Postgres
      // RLS ORs all matching permissive policies together, so
      // fields_owner_full_access alone doesn't shut this out.
      if (userId) {
        fieldsQuery = fieldsQuery.eq('owner_id', userId);
        cropsQuery = cropsQuery.eq('owner_id', userId);
      }

      const [{ data: fieldRows, error: fieldError }, { data: cropRows, error: cropError }] = await Promise.all([
        fieldsQuery,
        cropsQuery,
      ]);
      if (cancelled) return;

      if (fieldError) {
        console.error('[FieldInfoPanel] fields fetch failed:', fieldError.message, fieldError.details, fieldError.hint, fieldError.code);
        return; // keep showing whatever the cache already rendered above
      }
      if (cropError) {
        console.error('[FieldInfoPanel] crops fetch failed:', cropError.message, cropError.details, cropError.hint, cropError.code);
      }

      const finalFields = fieldRows || [];
      const finalCrops = cropRows || [];
      offlineCache.putAll('fieldsPanel', finalFields);
      offlineCache.putAll('cropsMarketplacePanel', finalCrops);
      setFieldsList(finalFields);
      setCropsList(finalCrops);
    }

    // Reads `user` straight from context instead of awaiting
    // supabase.auth.getUser() here - App.jsx already resolved it once.
    loadAll(user?.id);

    if (user) {
      channel = supabase
        .channel(`field-info-${user.id}-${Math.random().toString(36).slice(2)}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'fields', filter: `owner_id=eq.${user.id}` },
          () => loadAll(user.id)
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'crops_marketplace', filter: `owner_id=eq.${user.id}` },
          () => loadAll(user.id)
        )
        .subscribe();
    }

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [user?.id]);

  // Per-card "+ Add Crop" pill AND per-crop "Update" button both land
  // here now (both go through AddCropForm, see ASSUMPTION 4 above).
  // AddCropForm's onSaved always hands back a single crop row, whether
  // it was an INSERT (new) or UPDATE (edit) - tell them apart by
  // whether that id is already in cropsList.
  const handleAddCropFormSaved = (savedCrop) => {
    const isEditing = cropsList.some((c) => c.id === savedCrop.id);
    const updatedCrops = isEditing
      ? cropsList.map((c) => (c.id === savedCrop.id ? savedCrop : c))
      : [...cropsList, savedCrop];

    setCropsList(updatedCrops);
    offlineCache.putAll('cropsMarketplacePanel', updatedCrops);
    setAddCropField(null);
    setEditCropId(null);
  };

  // CropCard's "Edit" button - only hands back the crop (crop-first
  // card has no field context of its own), so the parent field is
  // looked up here from fieldsList via the crop's field_id.
  const handleEditCrop = (crop) => {
    const field = fieldsList.find((f) => f.id === crop.field_id) || null;
    setEditCropId(crop.id);
    setAddCropField(field);
  };

  // CropCard's "Delete" button - unlike the old FieldCard chip (which
  // did its own DB delete before calling back), CropCard just asks the
  // parent to delete, so the actual supabase call lives here now.
  const handleDeleteCrop = async (crop) => {
    setActionError(null);
    const { error } = await supabase.from('crops_marketplace').delete().eq('id', crop.id);
    if (error) {
      setActionError('Could not delete this crop. Try again.');
      return;
    }
    const updatedCrops = cropsList.filter((c) => c.id !== crop.id);
    setCropsList(updatedCrops);
    offlineCache.putAll('cropsMarketplacePanel', updatedCrops);
  };

  // CropCard's Listed toggle - mirrors CattleInfoPanel's
  // handleToggleListing pattern: optimistic local update right after a
  // successful write, don't wait on realtime/delta sync round-trip.
  const handleToggleListed = async (crop, nextListed) => {
    setActionError(null);
    const { error } = await supabase
      .from('crops_marketplace')
      .update({ is_listed: nextListed })
      .eq('id', crop.id);
    if (error) {
      setActionError('Could not update listing status. Try again.');
      return;
    }
    const updatedCrops = cropsList.map((c) => (c.id === crop.id ? { ...c, is_listed: nextListed } : c));
    setCropsList(updatedCrops);
    offlineCache.putAll('cropsMarketplacePanel', updatedCrops);
  };

  // For the top-level "+ Add" -> AddCropForm.jsx flow only (always a
  // fresh crop on an existing field, never editingCrop) - so this can
  // just append instead of the insert-or-update check
  // handleAddCropFormSaved above needs.
  const handleCropSaved = (savedCrop) => {
    const updatedCrops = [...cropsList, savedCrop];
    setCropsList(updatedCrops);
    offlineCache.putAll('cropsMarketplacePanel', updatedCrops);
    setIsAddOpen(false);
  };

  return (
    <div className="kb-card" style={{ overflow: 'hidden', flexShrink: 0 }}>
      <SectionBoxHeader
        icon="🌾"
        title="Crops"
        count={cropsList.filter((c) => c.status !== 'harvested').length}
        isOpen={isOpen}
        onToggle={onToggle}
        onAdd={isAddOpen ? undefined : () => setIsAddOpen(true)}
        addLabel="+ Add Crop"
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
          {fieldsList.length === 0 && (
            <p style={{ padding: 6, color: 'var(--color-muted)' }}>
              No fields registered yet - add one from your Profile tab first, then come back here to add a crop.
            </p>
          )}
          {fieldsList.length > 0 && cropsList.filter((c) => c.status !== 'harvested').length === 0 && (
            <p style={{ padding: 6, color: 'var(--color-muted)' }}>No crops added yet.</p>
          )}
          {cropsList
            .filter((c) => c.status !== 'harvested')
            .map((c) => (
              <CropCard
                key={c.id}
                crop={c}
                fieldName={fieldsList.find((f) => f.id === c.field_id)?.name}
                onEdit={handleEditCrop}
                onDelete={handleDeleteCrop}
                onToggleListed={handleToggleListed}
              />
            ))}
        </div>
      )}

      {isAddOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setIsAddOpen(false); }}
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
              onClick={() => setIsAddOpen(false)}
              aria-label="Close"
              style={{
                position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: '50%',
                border: 'none', background: 'var(--color-border)', color: 'var(--color-ink)', fontWeight: 700,
                cursor: 'pointer', lineHeight: 1,
              }}
            >
              ✕
            </button>
            <AddCropForm onSaved={handleCropSaved} onCancel={() => setIsAddOpen(false)} />
          </div>
        </div>
      )}

      {addCropField && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setAddCropField(null); }}
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
              onClick={() => { setAddCropField(null); setEditCropId(null); }}
              aria-label="Close"
              style={{
                position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: '50%',
                border: 'none', background: 'var(--color-border)', color: 'var(--color-ink)', fontWeight: 700,
                cursor: 'pointer', lineHeight: 1,
              }}
            >
              ✕
            </button>
            <AddCropForm
              key={`${addCropField.id}-${editCropId || 'new'}`}
              lockedField={{ id: addCropField.id, name: addCropField.name }}
              editingCrop={editCropId ? cropsList.find((c) => c.id === editCropId) : undefined}
              onSaved={handleAddCropFormSaved}
              onCancel={() => { setAddCropField(null); setEditCropId(null); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}