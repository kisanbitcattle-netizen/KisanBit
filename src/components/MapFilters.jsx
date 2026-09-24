// src/components/MapFilters.jsx
//
// Extracted out of FullMapModal.jsx (was an inline ~180-line FilterSheet
// component bloating that file to 1700+ lines). Same bottom-sheet /
// draft-then-Apply / localStorage-persisted-by-parent pattern as before -
// this file owns ONLY the sheet UI, FullMapModal still owns
// loadStoredFilters/saveStoredFilters/DEFAULT_FILTERS and does the actual
// filtering of cattle/field/service/pond lists.
//
// EXPANDED: category was previously just 'crops' | 'cattle', with
// Services and Ponds/Fish rendered as always-on, unfilterable map layers.
// Now all four are real, separate, single-select categories - selecting
// one hides the others, same UX FullMapModal.jsx already had for
// crops vs cattle, just extended to 4 options instead of 2. Each
// category shows only the sub-filters that make sense for it.

import React, { useEffect, useState } from 'react';
import { SERVICE_TYPES } from '../features/services/AddServiceForm';

const NAVY = 'var(--color-navy)';
const GOLD = 'var(--color-gold)';

/**
 * @typedef {Object} MapFilters
 * @property {'crops'|'cattle'|'services'|'ponds'} category
 * @property {'upcoming'|'ready'} harvestStage      - crops only
 * @property {number} radiusKm                      - all categories, 5-50
 * @property {boolean} qcVerifiedOnly                - crops only
 * @property {boolean} organicOnly                   - crops only, filters to fields with fields.is_organic
 * @property {boolean} fieldsListedOnly               - crops only, filters to fields with fields.is_public (farmer has listed the field itself - e.g. for lease/rent - independent of whether a crop is planted on it)
 * @property {boolean} breedReadyOnly                - cattle only
 * @property {boolean} likedOnly                     - crops + cattle only
 * @property {string[]} serviceTypes                 - services only, [] = all types
 * @property {boolean} servicesAvailableOnly          - services only
 * @property {boolean} pondsListedOnly                - ponds only, filters to ponds with >=1 fish listed for sale
 */

export const DEFAULT_FILTERS = {
  // FIX: was 'crops'. FullMapModal is opened from MapPreviewCard (a
  // cattle-only card) via the "Tap to open full map" flow, so a
  // farmer's very first open (no saved filter in localStorage yet)
  // landed on the Crops category by default - filteredCattleList's
  // `if (filters.category !== 'cattle') return [];` gate then hid
  // every cattle pin, the trail, and the base marker entirely, with
  // no visual indication why. Confirmed via screen recording: opening
  // the Filter sheet and manually tapping "Cattle" made everything
  // reappear instantly, with no other code change - the data/render
  // logic was correct all along, only the starting category was wrong.
  category: 'cattle',
  harvestStage: 'upcoming',
  radiusKm: 15,
  qcVerifiedOnly: false,
  organicOnly: false,
  fieldsListedOnly: false,
  breedReadyOnly: false,
  likedOnly: false,
  serviceTypes: [],
  servicesAvailableOnly: false,
  pondsListedOnly: false,
};

const CATEGORY_OPTIONS = [
  { key: 'crops', label: '🌾 Crops' },
  { key: 'cattle', label: '🐄 Cattle' },
  { key: 'services', label: '🚜 Services' },
  { key: 'ponds', label: '🐟 Ponds / Fish' },
];

const FilterSheet = React.memo(function FilterSheet({ isOpen, filters, onApply, onClose }) {
  const [draft, setDraft] = useState(filters);

  useEffect(() => {
    if (isOpen) setDraft(filters);
  }, [isOpen, filters]);

  if (!isOpen) return null;

  const handleApply = () => {
    onApply(draft);
    onClose();
  };

  const toggleServiceType = (key) => {
    setDraft((d) => {
      const has = d.serviceTypes.includes(key);
      return {
        ...d,
        serviceTypes: has
          ? d.serviceTypes.filter((k) => k !== key)
          : [...d.serviceTypes, key],
      };
    });
  };

  return (
    <div style={styles.sheetBackdrop} onClick={onClose}>
      <div style={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={styles.sheetHandle} />
        <h3 style={styles.sheetTitle}>Filters</h3>

        <div style={styles.sheetLabel}>Category</div>
        <div style={styles.categoryGrid}>
          {CATEGORY_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setDraft((d) => ({ ...d, category: opt.key }))}
              style={{
                ...styles.segmentButton,
                ...(draft.category === opt.key ? styles.segmentButtonActive : {}),
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* ---- Crops-only sub-filters ---- */}
        {draft.category === 'crops' && (
          <>
            <div style={styles.sheetLabel}>Harvest Stage</div>
            <div style={styles.segmentRow}>
              {[
                { key: 'upcoming', label: '🟡 Upcoming' },
                { key: 'ready', label: '🟢 Ready to Sell' },
              ].map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, harvestStage: opt.key }))}
                  style={{
                    ...styles.segmentButton,
                    ...(draft.harvestStage === opt.key ? styles.segmentButtonActive : {}),
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <ToggleRow
              label="🟢 QC Verified Only"
              checked={draft.qcVerifiedOnly}
              onColor="#2e7d32"
              onChange={(v) => setDraft((d) => ({ ...d, qcVerifiedOnly: v }))}
            />
            <ToggleRow
              label="🌿 Organic Only"
              checked={draft.organicOnly}
              onColor="#00e676"
              onChange={(v) => setDraft((d) => ({ ...d, organicOnly: v }))}
            />
            {/* ADDED: separate from Organic Only - this checks fields.is_public
                (the field itself is listed, e.g. for lease/rent), not anything
                about a crop growing on it. A field can be public without being
                organic and vice versa, so these are two independent toggles. */}
            <ToggleRow
              label="📋 Listed Only"
              checked={draft.fieldsListedOnly}
              onColor="#1565c0"
              onChange={(v) => setDraft((d) => ({ ...d, fieldsListedOnly: v }))}
            />
            <ToggleRow
              label="❤️ Liked Only"
              checked={draft.likedOnly}
              onColor="#c62828"
              onChange={(v) => setDraft((d) => ({ ...d, likedOnly: v }))}
            />
          </>
        )}

        {/* ---- Cattle-only sub-filters ---- */}
        {draft.category === 'cattle' && (
          <>
            <ToggleRow
              label="💗 Breed Ready Only"
              checked={draft.breedReadyOnly}
              onColor="#c2185b"
              onChange={(v) => setDraft((d) => ({ ...d, breedReadyOnly: v }))}
            />
            <ToggleRow
              label="❤️ Liked Only"
              checked={draft.likedOnly}
              onColor="#c62828"
              onChange={(v) => setDraft((d) => ({ ...d, likedOnly: v }))}
            />
          </>
        )}

        {/* ---- Services-only sub-filters ---- */}
        {draft.category === 'services' && (
          <>
            <div style={styles.sheetLabel}>Service Type</div>
            <div style={styles.checkboxGrid}>
              {SERVICE_TYPES.map((t) => {
                const active = draft.serviceTypes.includes(t.key);
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => toggleServiceType(t.key)}
                    style={{
                      ...styles.chip,
                      ...(active ? styles.chipActive : {}),
                    }}
                  >
                    {t.emoji} {t.label}
                  </button>
                );
              })}
            </div>
            <div style={styles.helperText}>
              {draft.serviceTypes.length === 0
                ? 'No type selected = show all types'
                : `${draft.serviceTypes.length} type(s) selected`}
            </div>

            <ToggleRow
              label="🟢 Available Only"
              checked={draft.servicesAvailableOnly}
              onColor="#2e7d32"
              onChange={(v) => setDraft((d) => ({ ...d, servicesAvailableOnly: v }))}
            />
          </>
        )}

        {/* ---- Ponds-only sub-filters ---- */}
        {draft.category === 'ponds' && (
          <ToggleRow
            label="🐟 Fish Listed for Sale Only"
            checked={draft.pondsListedOnly}
            onColor="#1e88e5"
            onChange={(v) => setDraft((d) => ({ ...d, pondsListedOnly: v }))}
          />
        )}

        {/* ---- Radius - applies to every category ---- */}
        <div style={styles.sheetLabel}>
          Radius: <strong>{draft.radiusKm} km</strong>
        </div>
        <input
          type="range"
          min={5}
          max={50}
          step={1}
          value={draft.radiusKm}
          onChange={(e) => setDraft((d) => ({ ...d, radiusKm: Number(e.target.value) }))}
          style={styles.slider}
        />
        <div style={styles.sliderScaleRow}>
          <span>5km</span>
          <span>50km</span>
        </div>

        <button type="button" onClick={handleApply} style={styles.applyButton}>
          Apply Filters
        </button>
      </div>
    </div>
  );
});

// Shared on/off pill toggle - was inlined 3x with copy-pasted JSX in the
// old FilterSheet, now parameterized once and reused for every boolean
// sub-filter across all four categories.
function ToggleRow({ label, checked, onColor, onChange }) {
  return (
    <div style={styles.toggleRow}>
      <span style={styles.sheetLabel}>{label}</span>
      <label style={styles.toggleSwitch}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          style={styles.toggleInput}
        />
        <span
          style={{
            ...styles.toggleTrack,
            background: checked ? onColor : 'var(--color-border)',
          }}
        >
          <span
            style={{
              ...styles.toggleThumb,
              transform: checked ? 'translateX(20px)' : 'translateX(0px)',
            }}
          />
        </span>
      </label>
    </div>
  );
}

export default FilterSheet;

// ---------------------------------------------------------------------------
// styles - self-contained, doesn't depend on FullMapModal's styles object.
// sheetBackdrop/sheetHandle intentionally duplicated (FullMapModal's
// ClusterPickerSheet also uses its own copy of these two) rather than
// sharing an import, keeping this file droppable into any modal context.
// ---------------------------------------------------------------------------

const styles = {
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
  sheetTitle: { margin: '0 0 14px', color: 'var(--color-ink)' },
  sheetLabel: { fontSize: 13, color: 'var(--color-muted)', margin: '14px 0 8px', fontWeight: 600 },
  segmentRow: { display: 'flex', gap: 8 },
  // 2x2 grid for the 4 category buttons - a single segmentRow would
  // squeeze 4 labels ("Crops"/"Cattle"/"Services"/"Ponds / Fish") too
  // tight on a phone width.
  categoryGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 8,
  },
  segmentButton: {
    flex: 1,
    padding: '10px 8px',
    borderRadius: 10,
    border: '1px solid var(--color-border)',
    background: 'var(--color-bg)',
    color: 'var(--color-ink)',
    fontSize: 13,
  },
  segmentButtonActive: {
    background: NAVY,
    color: '#fff',
    border: `1px solid ${NAVY}`,
  },
  // Service type checkboxes - shown as wrapping chips rather than a
  // vertical checkbox list, same visual language as segmentButton but
  // multi-select (toggle on tap) instead of single-select.
  checkboxGrid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    padding: '8px 12px',
    borderRadius: 16,
    border: '1px solid var(--color-border)',
    background: 'var(--color-bg)',
    color: 'var(--color-ink)',
    fontSize: 12,
  },
  chipActive: {
    background: NAVY,
    color: '#fff',
    border: `1px solid ${NAVY}`,
  },
  helperText: {
    fontSize: 11,
    color: 'var(--color-muted)',
    marginTop: 6,
  },
  slider: { width: '100%' },
  sliderScaleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 11,
    color: 'var(--color-muted)',
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  toggleSwitch: { position: 'relative', width: 44, height: 24, display: 'inline-block' },
  toggleInput: { opacity: 0, width: 0, height: 0 },
  toggleTrack: {
    position: 'absolute',
    inset: 0,
    borderRadius: 12,
    transition: 'background 0.15s',
  },
  toggleThumb: {
    position: 'absolute',
    top: 2,
    left: 2,
    width: 20,
    height: 20,
    borderRadius: '50%',
    background: 'var(--color-card)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
    transition: 'transform 0.15s',
  },
  applyButton: {
    width: '100%',
    marginTop: 20,
    padding: '14px',
    borderRadius: 12,
    border: 'none',
    background: GOLD,
    color: NAVY,
    fontWeight: 700,
    fontSize: 15,
  },
};