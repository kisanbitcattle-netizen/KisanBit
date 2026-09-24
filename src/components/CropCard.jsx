// src/components/CropCard.jsx
//
// Crop-first card for Home's Crop box (2x2 grid redesign). Companion to
// FieldCard.jsx, NOT a replacement - FieldCard.jsx still renders in
// ProfileScreen.jsx unchanged (field management stays Profile-tab-only,
// per the existing rule). This component is Home-only: the crop is the
// primary card, the parent field is just a name/subtitle line pulled
// from the field row (per explicit request - no field-picker or field
// detail shown here, since the field was already chosen when the crop
// was created via AddCropForm's dropdown/lockedField).
//
// ASSUMPTION: `fields` has no separate "place"/location text column
// that's been confirmed live (only `name` and the boundary_geojson
// computed field) - so "field name and place" is rendered as just the
// field's name for now. Flag if there's a real place/village text
// column on `fields` that should show here too.
//
// Listed toggle mirrors the Services card pattern (screenshot
// reference: a pill switch labeled Available/Listed, sitting right in
// the card header next to Edit) rather than the old plain checkbox
// inside AddCropForm - tapping it flips crops_marketplace.is_listed
// directly, no form needed for that one field.

import { useState } from 'react';

const CROP_EMOJI = {
  paddy: '🌾',
  maize: '🌽',
  chilli: '🌶️',
};

const STATUS_LABEL = {
  growing: 'Growing',
  ready_to_harvest: 'Ready to harvest',
  harvested: 'Harvested',
};

const currencyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

function cropEmoji(cropType) {
  return CROP_EMOJI[cropType?.toLowerCase()] || '🌱';
}

function formatPrice(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return currencyFormatter.format(Number(value));
}

export default function CropCard({ crop, fieldName, isOrganic: isOrganicProp, onEdit, onDelete, onToggleListed }) {
  const [deletingSelf, setDeletingSelf] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!crop) return null;

  const price = formatPrice(crop.wholesale_price ?? crop.retail_price);
  const isListed = !!crop.is_listed;
  // Organic currently lives on the FIELD row (fields.is_organic), not
  // on the crop itself - same reason fieldName is passed in as its own
  // prop rather than read off `crop` (see ASSUMPTION note at top of
  // file). `isOrganic` prop is the primary path; crop.isOrganic /
  // crop.is_organic are read too in case a crop-level column gets
  // added later instead of/alongside the field-level one.
  const isOrganic = isOrganicProp ?? crop.isOrganic ?? crop.is_organic ?? false;

  const handleToggle = async (e) => {
    e.stopPropagation();
    if (toggling || typeof onToggleListed !== 'function') return;
    setToggling(true);
    await onToggleListed(crop, !isListed);
    setToggling(false);
  };

  const handleDeleteConfirmed = async () => {
    setDeleting(true);
    await onDelete?.(crop);
    setDeleting(false);
    setDeletingSelf(false);
  };

  return (
    <div className="kb-card" style={{ overflow: 'hidden', minWidth: 220 }}>
      {/* Header strip - matches the Service card pattern: colored bar,
          round thumbnail, Listed toggle + Edit pill on the right. */}
      <div
        style={{
          background: 'var(--color-success, #2e8b57)', padding: '10px 14px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        }}
      >
        <div
          style={{
            width: 32, height: 32, borderRadius: '50%', background: '#fff', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, overflow: 'hidden',
          }}
        >
          {crop.image_url ? (
            <img src={crop.image_url} alt={crop.crop_type} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span aria-hidden="true">{cropEmoji(crop.crop_type)}</span>
          )}
        </div>

        {deletingSelf ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#fff' }}>Delete this crop?</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleDeleteConfirmed(); }}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={handleToggle}
              disabled={toggling}
              aria-label={isListed ? 'Listed - tap to unlist' : 'Not listed - tap to list'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, border: 'none', borderRadius: 20,
                padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: 'rgba(0,0,0,0.35)', color: '#fff', opacity: toggling ? 0.6 : 1,
              }}
            >
              <span
                style={{
                  width: 26, height: 15, borderRadius: 8, position: 'relative',
                  background: isListed ? 'var(--color-gold)' : 'rgba(255,255,255,0.35)',
                  transition: 'background 0.15s',
                }}
              >
                <span
                  style={{
                    position: 'absolute', top: 1.5, left: isListed ? 13 : 1.5, width: 12, height: 12,
                    borderRadius: '50%', background: '#fff', transition: 'left 0.15s',
                  }}
                />
              </span>
              {isListed ? 'Listed' : 'List'}
            </button>
            {onEdit && (
              <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(crop); }} style={headerPillStyle()}>
                Edit
              </button>
            )}
            {onDelete && (
              <button type="button" onClick={(e) => { e.stopPropagation(); setDeletingSelf(true); }} style={headerPillStyle()}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-ink)', textTransform: 'capitalize' }}>
            {crop.crop_type || 'Crop'}
          </div>
          {isOrganic && (
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
                borderRadius: 999, background: 'rgba(0,230,118,0.15)', color: '#00e676',
                fontSize: 11, fontWeight: 700, flexShrink: 0,
              }}
            >
              🌿 Organic
            </span>
          )}
        </div>
        {fieldName && (
          <div style={{ fontSize: 12, color: 'var(--color-muted)', marginTop: 2 }}>
            🌍 {fieldName}
          </div>
        )}
        <div style={{ fontSize: 13, color: 'var(--color-ink)', marginTop: 6 }}>
          {STATUS_LABEL[crop.status] || crop.status}
        </div>
        {isListed && price && (
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-success)', marginTop: 2 }}>
            {price}
          </div>
        )}
      </div>
    </div>
  );
}

function headerPillStyle() {
  return {
    border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff',
    borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
  };
}