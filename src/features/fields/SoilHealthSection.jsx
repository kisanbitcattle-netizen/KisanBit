// src/components/SoilHealthSection.jsx
//
// FIXED: this file was missing its React/supabase imports and had no
// export statement at all, so nothing could import or render it.
// Also wired sanitizeNumber() in (matches the pattern already applied
// to AddCattleForm.jsx) so out-of-range pH (should be 0-14) or garbage
// input can't reach the DB even if someone bypasses the HTML min/max.
//
// NOTE (corrected): soil_n/soil_p/soil_k/soil_ph/soil_tested_on DO
// exist live on the `fields` table (confirmed via information_schema
// this session — soil_n/p/k/ph are numeric, soil_tested_on is date).
// The update() call below is safe to use as-is. This comment
// previously claimed the columns were missing/unmigrated — that was
// stale/incorrect and has been corrected.
//
// OPEN QUESTION (not yet resolved): AddFieldForm.jsx has its own
// independent soil N/P/K/pH inputs and save logic (both an
// update_field() RPC path for edits, and a direct .from('fields')
// .update() path for new fields — the same pattern used here) and
// does NOT import or render this component. It's unconfirmed whether
// this component (SoilHealthSection) is actually mounted anywhere in
// the app, or whether it's dead code superseded by AddFieldForm's
// inline version. Needs confirming before further work here.
//
// NOTE 2: className="soil-health-section" / "npk-grid" have no
// matching rules in App.css yet — this will render unstyled (browser
// default form layout) until those classes are added. Not fixed here
// since I don't have a design direction for them — flagging instead
// of inventing styles.

import { useState } from 'react';
import { supabase } from '../../config/supabaseClient';
import { sanitizeNumber } from '../../utils/sanitize';

export default function SoilHealthSection({ field, onSave }) {
  const [soil, setSoil] = useState({
    soil_n: field?.soil_n ?? '',
    soil_p: field?.soil_p ?? '',
    soil_k: field?.soil_k ?? '',
    soil_ph: field?.soil_ph ?? '',
  });

  const handleChange = (key, value) => {
    setSoil(prev => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    const { error } = await supabase
      .from('fields')
      .update({
        soil_n: soil.soil_n !== '' ? sanitizeNumber(soil.soil_n, { min: 0, max: 1000 }) : null,
        soil_p: soil.soil_p !== '' ? sanitizeNumber(soil.soil_p, { min: 0, max: 1000 }) : null,
        soil_k: soil.soil_k !== '' ? sanitizeNumber(soil.soil_k, { min: 0, max: 1000 }) : null,
        soil_ph: soil.soil_ph !== '' ? sanitizeNumber(soil.soil_ph, { min: 0, max: 14 }) : null,
        soil_tested_on: new Date().toISOString().split('T')[0],
      })
      .eq('id', field.id);

    if (error) {
      console.error('[SoilHealthSection] update failed:', error.message, error.details, error.hint, error.code);
      return;
    }
    onSave?.();
  };

  return (
    <div className="soil-health-section">
      <h4>Soil Health (N-P-K & pH)</h4>
      <div className="npk-grid">
        <label>
          Nitrogen (N)
          <input type="number" step="0.1" value={soil.soil_n}
            onChange={e => handleChange('soil_n', e.target.value)} placeholder="kg/ha" />
        </label>
        <label>
          Phosphorus (P)
          <input type="number" step="0.1" value={soil.soil_p}
            onChange={e => handleChange('soil_p', e.target.value)} placeholder="kg/ha" />
        </label>
        <label>
          Potassium (K)
          <input type="number" step="0.1" value={soil.soil_k}
            onChange={e => handleChange('soil_k', e.target.value)} placeholder="kg/ha" />
        </label>
        <label>
          Soil pH
          <input type="number" step="0.1" min="0" max="14" value={soil.soil_ph}
            onChange={e => handleChange('soil_ph', e.target.value)} placeholder="0-14" />
        </label>
      </div>
      <button onClick={handleSubmit}>Save Soil Data</button>
    </div>
  );
}