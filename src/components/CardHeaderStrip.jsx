// src/components/CardHeaderStrip.jsx
//
// Shared colored header strip for HomeScreen item cards (Cattle/Crop/
// Pond-fish/...). Extracted from CropCard.jsx's header block, which is
// the confirmed visual reference for card-level UI: circular avatar on
// the left, List-toggle + Edit + Delete pills on the right, on a
// section-colored background strip. CropCard.jsx itself is UNCHANGED -
// this file only lets other cards adopt the same look without
// duplicating its inline styles.
//
// Two delete modes, so callers keep whatever confirm flow they already
// have instead of being forced into one shape:
//   - 'confirm': shows CropCard's own inline "Delete this X? Yes/Cancel"
//     right in the header (use for cards that had no confirm step yet).
//   - 'trigger': the Delete pill just calls onClick - the host component
//     manages what happens next (e.g. CattleCard's existing
//     Archive-vs-Delete-Permanently choice, which stays exactly as-is).
//
// Nothing here touches Supabase/queries/business logic - purely
// presentational, driven by props the host already computes.

import { useState } from 'react';

export default function CardHeaderStrip({
  color,
  avatarSrc,
  avatarAlt,
  avatarFallback,
  toggle, // optional: { isListed, label, busy, onClick }
  onEdit, // optional: () => void - omit to hide the Edit pill
  del,    // optional: { mode: 'confirm', itemLabel, busy, onConfirm } | { mode: 'trigger', onClick }
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div
      style={{
        background: color,
        padding: '10px 14px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <div
        style={{
          width: 32, height: 32, borderRadius: '50%', background: '#fff', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, overflow: 'hidden',
        }}
      >
        {avatarSrc ? (
          <img src={avatarSrc} alt={avatarAlt} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span aria-hidden="true">{avatarFallback}</span>
        )}
      </div>

      {del?.mode === 'confirm' && confirmingDelete ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#fff' }}>Delete this {del.itemLabel}?</span>
          <button
            type="button"
            onClick={async (e) => { e.stopPropagation(); await del.onConfirm(); setConfirmingDelete(false); }}
            disabled={del.busy}
            style={pillStyle()}
          >
            {del.busy ? '...' : 'Yes'}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setConfirmingDelete(false); }}
            disabled={del.busy}
            style={pillStyle()}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {toggle && (
            <button
              type="button"
              onClick={toggle.onClick}
              disabled={toggle.busy}
              aria-label={toggle.isListed ? 'Listed - tap to unlist' : 'Not listed - tap to list'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, border: 'none', borderRadius: 20,
                padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: 'rgba(0,0,0,0.35)', color: '#fff', opacity: toggle.busy ? 0.6 : 1,
              }}
            >
              <span
                style={{
                  width: 26, height: 15, borderRadius: 8, position: 'relative',
                  background: toggle.isListed ? 'var(--color-gold)' : 'rgba(255,255,255,0.35)',
                  transition: 'background 0.15s',
                }}
              >
                <span
                  style={{
                    position: 'absolute', top: 1.5, left: toggle.isListed ? 13 : 1.5, width: 12, height: 12,
                    borderRadius: '50%', background: '#fff', transition: 'left 0.15s',
                  }}
                />
              </span>
              {toggle.label || (toggle.isListed ? 'Listed' : 'List')}
            </button>
          )}
          {onEdit && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(); }} style={pillStyle()}>
              Edit
            </button>
          )}
          {del?.mode === 'confirm' && (
            <button type="button" onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }} style={pillStyle()}>
              Delete
            </button>
          )}
          {del?.mode === 'trigger' && (
            <button type="button" onClick={(e) => { e.stopPropagation(); del.onClick(); }} style={pillStyle()}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function pillStyle() {
  return {
    border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff',
    borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
  };
}