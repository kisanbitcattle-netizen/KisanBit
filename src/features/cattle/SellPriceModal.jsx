// src/components/SellPriceModal.jsx
//
// Small prompt shown when a farmer taps "Sell" on a CattleCard —
// asks for a min/max asking price range before actually listing the
// animal on the marketplace.
//
// UPDATED: accepts initialMin/initialMax so a farmer re-listing an
// animal that was previously listed (and unlisted) sees their old
// price range pre-filled instead of blank fields, and can edit from
// there. First-time listings still open blank since sale_price_min/
// max are null until something has been listed at least once.

import { useState } from 'react';

export default function SellPriceModal({ cattleName, initialMin = '', initialMax = '', onCancel, onConfirm }) {
  const [minPrice, setMinPrice] = useState(initialMin != null ? String(initialMin) : '');
  const [maxPrice, setMaxPrice] = useState(initialMax != null ? String(initialMax) : '');
  const [error, setError] = useState(null);

  const handleConfirm = () => {
    const min = Number(minPrice);
    const max = Number(maxPrice);

    if (!minPrice || !maxPrice || Number.isNaN(min) || Number.isNaN(max)) {
      setError('Please enter both a minimum and maximum price.');
      return;
    }
    if (min <= 0 || max <= 0) {
      setError('Price must be greater than zero.');
      return;
    }
    if (min > max) {
      setError('Minimum price cannot be higher than maximum price.');
      return;
    }

    onConfirm({ min, max });
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 4500,
        background: 'rgba(20,24,40,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={onCancel}
    >
      <div
        className="kb-card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 340, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div className="display-text" style={{ fontSize: 16, color: 'var(--color-navy)' }}>
          List {cattleName} for sale
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-muted)', marginTop: -8 }}>
          Set your asking price range — buyers will see this as a range they can negotiate within.
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Min (Rs)</label>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
              placeholder="e.g. 30000"
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Max (Rs)</label>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              placeholder="e.g. 40000"
              style={inputStyle}
            />
          </div>
        </div>

        {error && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onCancel}
            style={{ flex: 1, minHeight: 48, padding: 10, borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-card)', color: 'var(--color-ink)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            style={{ flex: 1, minHeight: 48, padding: 10, borderRadius: 10, border: 'none', background: 'var(--color-gold)', color: 'var(--color-navy)', fontWeight: 700 }}
          >
            List for Sale
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-muted)',
  marginBottom: 4,
};

const inputStyle = {
  width: '100%',
  padding: 10,
  borderRadius: 8,
  border: '1px solid var(--color-border)',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
};