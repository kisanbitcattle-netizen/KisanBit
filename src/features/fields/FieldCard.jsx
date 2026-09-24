// src/components/FieldCard.jsx
//
// A farmer's field card - shown in Profile and Home's Field panel.
// Header strip (green bar, round thumbnail, dark pill buttons, inline
// non-modal delete-confirm) matches the Cattle Base box exactly - that
// part is unchanged from the last redesign.
//
// SIMPLIFIED (field-for-rent redesign): the header's old "✏️ Boundary"
// button (opened boundary re-draw directly from the card) is gone -
// replaced by a Listed/List toggle switch, same visual pattern as
// CropCard's per-crop Listed toggle, so a farmer can list the FIELD
// ITSELF for rent right from this card. Boundary editing is still
// possible, just not from here - it lives inside AddFieldForm (Edit
// mode, via the "Update Field" button), same place name/photo/soil
// edits already happen.
//
// Crop display is now a single plain-text count line ("N crops") no
// matter which screen renders the card - a field card is about the
// FIELD (for rent), not a crop management surface. The old two-mode
// system (Profile: plain summary vs Home: tappable chips that expand
// into a full status/dates/price/Update/Delete box) is removed
// entirely; per-crop management lives in CropCard.jsx (FieldInfoPanel)
// now, not here. onEditCrop/onDeleteCrop are no longer read by this
// component - drop them from parents once the FieldCard callsite is
// updated, they're unused props now.
//
// NEW PROP `onToggleListed(field, nextListed)` - parent owns the
// actual `fields.is_public` write (mirrors FieldInfoPanel's
// handleToggleListed for crops_marketplace.is_listed), this component
// just calls it and shows a brief pending state. Toggle only renders
// when the parent wires this prop, same optional-feature pattern as
// isEditable/isDeletable/etc. If ProfileScreen.jsx doesn't wire it yet,
// add something like:
//   const handleToggleFieldListed = async (field, nextListed) => {
//     await supabase.from('fields').update({ is_public: nextListed }).eq('id', field.id);
//     setFieldsList((prev) => prev.map((f) => (f.id === field.id ? { ...f, is_public: nextListed } : f)));
//   };
// and pass onToggleListed={handleToggleFieldListed} to <FieldCard />.

import { memo, useRef, useState } from 'react';
import { supabase } from '../../config/supabaseClient';
import { compressImageElement, loadImageFromDataUrl } from '../../utils/imageCompression';

const CROP_EMOJI = {
  paddy: '🌾',
  maize: '🌽',
  chilli: '🌶️',
};

function cropEmoji(cropType) {
  return CROP_EMOJI[cropType?.toLowerCase()] || '🌱';
}

// Dark semi-transparent pill button - copied verbatim from the Cattle
// Base header buttons (ProfileScreen.jsx) so both sections match.
function headerPillStyle() {
  return {
    border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff',
    borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
  };
}

function FieldCard({
  field, crops, onClick, onDeleted, onEdit, onAddCrop,
  onToggleListed, isLiked, onToggleLike, onPhotoUpdated,
}) {
  const [deletingSelf, setDeletingSelf] = useState(false); // header inline "Delete this field?" confirm
  const [deleting, setDeleting] = useState(false);
  const [togglingListed, setTogglingListed] = useState(false);
  const [liking, setLiking] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState(null);
  const photoFileInputRef = useRef(null);

  if (!field) return null;

  const cropList = crops || [];
  const currentCrops = cropList.filter((c) => c.status !== 'harvested');
  const primaryEmoji = currentCrops.length > 0 ? cropEmoji(currentCrops[0].crop_type) : '🌍';
  // ASSUMPTION: `fields.photo_url` is a new column (not previously
  // selected/used anywhere) - added so a field can have its own photo
  // instead of always borrowing whichever crop happens to be first.
  // Falls back to that old borrowed-crop-image behavior when a field
  // has no photo of its own yet, so existing fields with only crop
  // photos still show something instead of going blank.
  const primaryImage = field.photo_url || (currentCrops.length > 0 ? currentCrops[0].image_url : null);
  const isPhotoEditable = typeof onPhotoUpdated === 'function';

  const isInteractive = typeof onClick === 'function';
  const isEditable = typeof onEdit === 'function';
  const isCropAddable = typeof onAddCrop === 'function';
  // Delete only renders where a parent explicitly wired onDeleted -
  // ProfileScreen does (field deletion belongs there); Home's
  // FieldInfoPanel deliberately does not, per user request.
  const isDeletable = typeof onDeleted === 'function';
  const isLikeable = typeof onToggleLike === 'function';
  // Listed toggle only renders where a parent wires onToggleListed -
  // see the NEW PROP note at the top of this file.
  const isListable = typeof onToggleListed === 'function';

  const handleKeyDown = (e) => {
    if (!isInteractive) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(e);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    await supabase.from('fields').delete().eq('id', field.id);
    setDeleting(false);
    setDeletingSelf(false);
    onDeleted?.(field.id);
  };

  const handleEditClick = (e) => {
    e.stopPropagation();
    onEdit?.(field);
  };

  const handleAddCropClick = (e) => {
    e.stopPropagation();
    onAddCrop?.(field);
  };

  const handleLikeClick = async (e) => {
    e.stopPropagation();
    if (liking) return;
    setLiking(true);
    await onToggleLike(field);
    setLiking(false);
  };

  // Mirrors CropCard's Listed toggle: parent does the actual write
  // (fields.is_public) and hands back an updated field, this component
  // just guards against double-taps while that round-trip is in flight.
  const handleToggleListedClick = async (e) => {
    e.stopPropagation();
    if (togglingListed) return;
    setTogglingListed(true);
    await onToggleListed(field, !field.is_public);
    setTogglingListed(false);
  };

  const handlePhotoSelected = async (file) => {
    if (!file) return;
    setUploadingPhoto(true);
    setPhotoError(null);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const img = await loadImageFromDataUrl(dataUrl);
      const blob = await compressImageElement(img, { targetKB: 40, maxDimension: 480 });
      if (!blob) throw new Error('Compression produced no output');

      const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
      // ASSUMPTION: bucket name 'field-photos' and column 'photo_url' on
      // `fields` - matches the naming convention already used for
      // cattle_bases.photo_url / the 'cattle-base-photos' bucket.
      const path = `${field.id}/photo.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('field-photos')
        .upload(path, blob, { upsert: true, contentType: blob.type });
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage.from('field-photos').getPublicUrl(path);
      const bustedUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`;

      const { error: updateError } = await supabase
        .from('fields')
        .update({ photo_url: bustedUrl })
        .eq('id', field.id);
      if (updateError) throw updateError;

      onPhotoUpdated?.(field.id, bustedUrl);
    } catch (err) {
      console.error('[FieldCard] photo upload failed:', err.message);
      setPhotoError('Photo update avvaledu, malli try cheyandi.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  return (
    <div
      className="kb-card"
      onClick={isInteractive ? onClick : undefined}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={isInteractive ? `${field.name} field details` : undefined}
      style={{ overflow: 'hidden', padding: 0, cursor: isInteractive ? 'pointer' : 'default' }}
    >
      {/* Header strip - green bar + round thumbnail + dark pill buttons */}
      <div
        style={{
          background: 'var(--color-success, #2e8b57)', padding: '10px 14px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        }}
      >
        <div style={{ position: 'relative', width: 32, height: 32, flexShrink: 0 }}>
          <div
            style={{
              width: '100%', height: '100%', borderRadius: '50%', background: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, overflow: 'hidden',
            }}
          >
            {isPhotoEditable ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); photoFileInputRef.current?.click(); }}
                style={{
                  all: 'unset', cursor: 'pointer', display: 'flex', width: '100%', height: '100%',
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                {primaryImage ? (
                  <img
                    src={primaryImage}
                    alt={currentCrops[0]?.crop_type || 'field'}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <span aria-hidden="true">{primaryEmoji}</span>
                )}
              </button>
            ) : primaryImage ? (
              <img
                src={primaryImage}
                alt={currentCrops[0]?.crop_type || 'field'}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <span aria-hidden="true">{primaryEmoji}</span>
            )}
          </div>

          {isPhotoEditable && (
            <>
              <div
                style={{
                  position: 'absolute', bottom: -3, right: -3, width: 15, height: 15, borderRadius: '50%',
                  background: 'var(--color-navy)', border: '2px solid var(--color-gold)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8,
                  pointerEvents: 'none',
                }}
              >
                {uploadingPhoto ? '\u2026' : '\ud83d\udcf7'}
              </div>
              <input
                ref={photoFileInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  handlePhotoSelected(file);
                }}
                style={{ display: 'none' }}
                onClick={(e) => e.stopPropagation()}
              />
            </>
          )}
        </div>

        {deletingSelf ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#fff' }}>Delete this field?</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleDelete(); }}
              disabled={deleting}
              style={headerPillStyle()}
            >
              {deleting ? '...' : 'Yes'}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setDeletingSelf(false); }}
              disabled={deleting}
              style={headerPillStyle()}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {isLikeable && (
              <button
                onClick={handleLikeClick}
                aria-label={isLiked ? 'Unlike' : 'Like'}
                style={{ background: 'none', border: 'none', fontSize: 16, padding: 0, lineHeight: 1 }}
              >
                {isLiked ? '❤️' : '🤍'}
              </button>
            )}
            {isEditable && (
              <button type="button" onClick={handleEditClick} style={headerPillStyle()}>Update Field</button>
            )}
            {isListable && (
              <button
                type="button"
                onClick={handleToggleListedClick}
                disabled={togglingListed}
                aria-pressed={!!field.is_public}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  border: 'none', borderRadius: 14, padding: '4px 10px 4px 4px',
                  background: field.is_public ? 'var(--color-gold)' : 'rgba(0,0,0,0.55)',
                  color: field.is_public ? 'var(--color-navy)' : '#fff',
                  fontWeight: 700, fontSize: 12, cursor: 'pointer',
                  opacity: togglingListed ? 0.7 : 1,
                }}
              >
                <span
                  style={{
                    width: 26, height: 16, borderRadius: 8, flexShrink: 0, position: 'relative',
                    background: field.is_public ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.3)',
                  }}
                >
                  <span
                    style={{
                      position: 'absolute', top: 2, left: field.is_public ? 12 : 2,
                      width: 12, height: 12, borderRadius: '50%', background: '#fff',
                      transition: 'left 0.15s',
                    }}
                  />
                </span>
                {field.is_public ? 'Listed' : 'List'}
              </button>
            )}
            {isCropAddable && (
              <button type="button" onClick={handleAddCropClick} style={headerPillStyle()}>+ Add Crop</button>
            )}
            {isDeletable && (
              <button type="button" onClick={(e) => { e.stopPropagation(); setDeletingSelf(true); }} style={headerPillStyle()}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {/* Body - name as the bold title line, thin divider, then crops */}
      <div style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <span
            style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={field.name}
          >
            {field.name}
          </span>
          {/* Static badge removed - the header's Listed/List toggle above
              (when a parent wires onToggleListed) already shows and
              controls this same is_public state, so showing it twice
              would be redundant. Parents that don't wire the toggle
              (e.g. a read-only buyer view) can still show their own
              "Listed" indicator elsewhere if needed. */}
        </div>
        <div style={{ borderTop: '1px solid var(--color-border)', margin: '8px 0' }} />
        {photoError && (
          <div style={{ fontSize: 11, color: 'var(--color-danger)', marginBottom: 8 }}>{photoError}</div>
        )}

        {/* Field is just a field for rent now - no crop-level detail,
            update, or delete affordances on this card. Just how many
            crops are currently on it. Per-crop management lives in
            CropCard.jsx (FieldInfoPanel), not here. */}
        <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
          {currentCrops.length === 0
            ? 'No crops growing'
            : `${currentCrops.length} crop${currentCrops.length > 1 ? 's' : ''} growing`}
        </div>
      </div>
    </div>
  );
}

export default memo(FieldCard);