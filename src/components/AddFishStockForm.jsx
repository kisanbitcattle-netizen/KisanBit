// src/components/AddFishStockForm.jsx
//
// Standalone "Add Fish Stock" form, split out of PondDetailModal.jsx the
// same way AddCattleForm.jsx is split out of CattleDetailModal.jsx - a
// farmer with several aqua ponds needs one focused add-flow they can
// launch from any pond, not a form buried inside a read-only detail
// card. Mirrors AddCattleForm.jsx's shape closely on purpose: bottom-
// sheet kb-card, circular photo picker, labelStyle/inputStyle pairs,
// gold submit button, same error-display convention - and now also a
// grouped species picker mirroring AddCattleForm's ANIMAL_GROUPS type
// picker (see utils/aquaSpeciesTaxonomy.js).
//
// Writes one row to `pond_fish_stock` (species/quantity/weight/dates/
// water-quality fields/listing price/photo - see schema notes in the
// project handover). A pond MUST already exist to attach stock to - if
// the owner has none yet, the form says so instead of letting them
// submit with no pond_id.
//
// ASSUMPTIONS / OPEN ITEMS (flag before shipping):
// 1. Reuses utils/imageUpload.js's compressImageToTargetKB/
//    uploadCompressedAsset and utils/sanitize.js's sanitizeText/
//    sanitizeNumber/sanitizeEnum exactly as AddCattleForm.jsx does -
//    not re-verified here since neither utils file was in this
//    conversation, but AddCattleForm.jsx's own working imports confirm
//    the signatures.
// 2. Uploads fish photos to the existing `pond-fish-photos` Storage
//    bucket, folder-prefixed as `${user.id}/${draftId}` (same
//    convention 'cattle-photos'/'qc-certificates' already use in
//    AddCattleForm.jsx). Bucket name confirmed against the project's
//    actual bucket list (pond-fish-photos, service-photos,
//    qc-certificates, crop-images, cattle-photos, avatars) - the
//    original `fish-photos` guess didn't exist.
// 3. The handover flags PondsPanel.jsx's own uploadFishPhoto() as
//    possibly using a flat filename instead of a folder-prefixed path
//    (storage RLS risk, not yet tested). This new form deliberately
//    uses the folder-prefixed convention from the start rather than
//    copying that possible bug. As of the PondsPanel.jsx rewrite this
//    is now the ONLY add/edit path for pond_fish_stock - the old inline
//    FishForm was removed, so there's no second code path left to
//    reconcile.
// 4. water_type and sunlight_exposure are offered as fixed pickers
//    (Freshwater/Brackish/Saline and Full sun/Partial shade/Full shade)
//    since no enum/check-constraint was confirmed for either column in
//    the schema notes - flag if the real constraint differs.
// 5. Per-fish contact fields (contact_phone/contact_whatsapp) were
//    REMOVED from this form on request - a fish stock entry lives in a
//    pond, and PondDetailModal.jsx's chat button already falls back to
//    the pond's own contact_phone/contact_whatsapp for every fish in it
//    (`f.contact_whatsapp || f.contact_phone || chatSellerPhone`), so a
//    per-batch override isn't needed. The `contact_phone`/
//    `contact_whatsapp` columns on pond_fish_stock still exist and old
//    rows may still have values in them (PondDetailModal's fallback
//    chain still checks them first for backward compatibility) - this
//    form just no longer writes to them.
// 6. Open question from the handover, still unresolved: should
//    water-quality fields (water_type/ph/temperature_c/
//    dissolved_oxygen_mg_l) live on the POND record instead of
//    per-fish-stock batch? This form keeps them per-batch since that's
//    where the schema currently has the columns.
// 7. Species picker (utils/aquaSpeciesTaxonomy.js) is a NEW UI layer on
//    top of the existing single `fish_species` text column - same
//    "picker writes a plain string" relationship AddCattleForm's breed
//    picker has with the `breed` column. No new DB column assumed or
//    required.

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../config/supabaseClient';
import { compressImageToTargetKB, uploadCompressedAsset } from '../utils/imageUpload';
import { sanitizeText, sanitizeNumber, sanitizeEnum } from '../utils/sanitize';
import { AQUA_SPECIES_TAXONOMY, AQUA_SPECIES_GROUPS, speciesKeyForLabel } from '../utils/aquaSpeciesTaxonomy';

const WATER_TYPES = ['Freshwater', 'Brackish', 'Saline'];
const SUNLIGHT_OPTIONS = ['Full sun', 'Partial shade', 'Full shade'];

function generateUuidV4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// pondId: optional - pass this when launching the form from a specific
// pond's own screen (skips the pond picker). Omit it to show a picker
// across all of the owner's ponds - the common case for a farmer running
// several aqua ponds who wants one shared "Add Fish Stock" entry point.
export default function AddFishStockForm({ pondId = null, editingFish = null, onClose, onSaved }) {
  const [selectedPondId, setSelectedPondId] = useState(pondId || editingFish?.pond_id || '');
  const [ponds, setPonds] = useState([]);
  const [pondsLoading, setPondsLoading] = useState(!pondId);

  // Species picker state: speciesKey is the selected AQUA_SPECIES_TAXONOMY
  // key ('other' shows the custom text input below it). When editing,
  // reverse-map the stored fish_species string back to a key via
  // speciesKeyForLabel so the right button is pre-selected; customSpecies
  // is prefilled with the raw text too so it's not lost if that reverse
  // lookup lands on 'other' (e.g. rows saved before this picker existed).
  const [speciesKey, setSpeciesKey] = useState(() => speciesKeyForLabel(editingFish?.fish_species));
  const [customSpecies, setCustomSpecies] = useState(() =>
    speciesKeyForLabel(editingFish?.fish_species) === 'other' ? (editingFish?.fish_species || '') : ''
  );
  const [quantity, setQuantity] = useState(editingFish?.quantity ?? '');
  const [averageWeightKg, setAverageWeightKg] = useState(editingFish?.average_weight_kg ?? '');
  const [stockedDate, setStockedDate] = useState(editingFish?.stocked_date || new Date().toISOString().slice(0, 10));
  const [expectedHarvestDate, setExpectedHarvestDate] = useState(editingFish?.expected_harvest_date || '');

  const [waterType, setWaterType] = useState(editingFish?.water_type || '');
  const [ph, setPh] = useState(editingFish?.ph ?? '');
  const [temperatureC, setTemperatureC] = useState(editingFish?.temperature_c ?? '');
  const [dissolvedOxygen, setDissolvedOxygen] = useState(editingFish?.dissolved_oxygen_mg_l ?? '');
  const [sunlightExposure, setSunlightExposure] = useState(editingFish?.sunlight_exposure || '');

  const [isListedForSale, setIsListedForSale] = useState(editingFish?.is_listed_for_sale ?? false);
  const [pricePerKg, setPricePerKg] = useState(editingFish?.price_per_kg ?? '');
  const [notes, setNotes] = useState(editingFish?.notes || '');

  // Existing photo shows as the preview immediately when editing; a
  // newly-picked file (photoFile) always takes over from there, same
  // "existing photoUrl kept unless a new one is picked" rule
  // AddCattleBaseForm.jsx uses.
  const [localImageUri, setLocalImageUri] = useState(editingFish?.image_url || null);
  const [photoFile, setPhotoFile] = useState(null); // actual file, compressed+uploaded on submit
  const fileInputRef = useRef(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Editing reuses the existing row's id (so a re-uploaded photo lands
  // under the same Storage folder as the original); adding generates a
  // fresh one.
  const draftId = useState(() => editingFish?.id || generateUuidV4())[0];

  // Load this owner's ponds for the picker - same fetch-on-open pattern
  // AddCattleForm.jsx uses for cattle_bases. Skipped entirely when a
  // pondId prop was already supplied (form launched from within a
  // specific pond).
  useEffect(() => {
    if (pondId) return;
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setPondsLoading(false); return; }
      const { data, error: pondsError } = await supabase
        .from('ponds')
        .select('id, pond_name')
        .eq('owner_id', user.id)
        .order('pond_name', { ascending: true });
      if (cancelled) return;
      if (!pondsError && data) setPonds(data);
      setPondsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [pondId]);

  // Prefill contact fields from the selected pond's own contact info,
  // same prev || fallback pattern AddCattleForm.jsx uses for Cattle
  // Bases - never overwrites something the farmer already typed here.
  // REMOVED: this form no longer has per-batch contact fields (see
  // ASSUMPTION 5 above) - the pond's own contact info is used directly
  // by PondDetailModal.jsx's chat flow, no prefill needed here.

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    const reader = new FileReader();
    reader.onload = () => setLocalImageUri(reader.result); // preview only
    reader.onerror = () => setError('Could not read that photo, try again.');
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedPondId) {
      setError('Please choose a pond first.');
      return;
    }
    const finalSpecies = speciesKey === 'other' ? customSpecies.trim() : (AQUA_SPECIES_TAXONOMY[speciesKey]?.label || '');
    if (!speciesKey || !finalSpecies) {
      setError('Please select the fish species.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not logged in.');

      const fields = {
        pond_id: selectedPondId,
        owner_id: user.id,
        fish_species: sanitizeText(finalSpecies),
        quantity: quantity !== '' ? sanitizeNumber(quantity) : null,
        average_weight_kg: averageWeightKg !== '' ? sanitizeNumber(averageWeightKg) : null,
        stocked_date: stockedDate || null,
        expected_harvest_date: expectedHarvestDate || null,
        water_type: waterType ? sanitizeEnum(waterType, WATER_TYPES) : null,
        ph: ph !== '' ? sanitizeNumber(ph) : null,
        temperature_c: temperatureC !== '' ? sanitizeNumber(temperatureC) : null,
        dissolved_oxygen_mg_l: dissolvedOxygen !== '' ? sanitizeNumber(dissolvedOxygen) : null,
        sunlight_exposure: sunlightExposure ? sanitizeEnum(sunlightExposure, SUNLIGHT_OPTIONS) : null,
        is_listed_for_sale: isListedForSale,
        price_per_kg: isListedForSale && pricePerKg !== '' ? sanitizeNumber(pricePerKg) : null,
        notes: notes.trim() ? sanitizeText(notes.trim()) : null,
        // image_url set AFTER save, once the photo is compressed and
        // uploaded to Storage - never store the raw base64 here.
      };

      let savedRow;
      if (editingFish) {
        const { data, error: updateError } = await supabase
          .from('pond_fish_stock')
          .update(fields)
          .eq('id', draftId)
          .select()
          .single();
        if (updateError) throw updateError;
        savedRow = data;
      } else {
        const { data, error: insertError } = await supabase
          .from('pond_fish_stock')
          .insert({ id: draftId, ...fields })
          .select()
          .single();
        if (insertError) throw insertError;
        savedRow = data;
      }

      if (photoFile) {
        const compressedPhoto = await compressImageToTargetKB(photoFile, 40, 640);
        if (compressedPhoto) {
          const photoUrl = await uploadCompressedAsset(compressedPhoto, 'pond-fish-photos', `${user.id}/${draftId}`);
          const { data: photoData, error: photoUpdateError } = await supabase
            .from('pond_fish_stock')
            .update({ image_url: photoUrl })
            .eq('id', draftId)
            .select()
            .single();
          if (photoUpdateError) throw new Error(`Could not save photo link: ${photoUpdateError.message}`);
          savedRow = photoData;
        }
      }

      onSaved(savedRow);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(20,24,40,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="kb-card"
        style={{ maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="display-text" style={{ fontSize: 18, color: 'var(--color-navy)' }}>{editingFish ? 'Update Fish Stock' : 'Add Fish Stock'}</span>
          <button type="button" onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 18, color: 'var(--color-ink)' }}>x</button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={handleFileChange} style={{ display: 'none' }} />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{
              width: 96, height: 96, borderRadius: 20, border: '2px dashed var(--color-border)',
              background: 'var(--color-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: localImageUri ? 0 : 13, overflow: 'hidden', color: 'var(--color-muted)',
            }}
          >
            {localImageUri ? (
              <img src={localImageUri} alt="fish stock" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : ('Add Photo')}
          </button>
        </div>

        {/* Pond picker - only shown when the form wasn't opened from a
            specific pond already (see pondId prop doc above). A farmer
            running several aqua ponds needs to pick which one this
            batch belongs to. */}
        {!pondId && (
          <div>
            <label style={labelStyle}>Pond</label>
            {pondsLoading ? (
              <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>Loading your ponds…</div>
            ) : ponds.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-danger)', padding: 10, borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-bg)' }}>
                You don't have any ponds yet - add a pond first, then come back to add fish stock to it.
              </div>
            ) : (
              <select value={selectedPondId} onChange={(e) => setSelectedPondId(e.target.value)} style={inputStyle}>
                <option value="">Choose a pond…</option>
                {ponds.map((p) => (
                  <option key={p.id} value={p.id}>{p.pond_name}</option>
                ))}
              </select>
            )}
          </div>
        )}

        <div>
          <label style={labelStyle}>Fish / Aqua Species</label>
          {Object.entries(AQUA_SPECIES_GROUPS).map(([groupName, keys]) => (
            <div key={groupName} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-muted)', marginBottom: 6 }}>{groupName}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {keys.map((key) => {
                  const entry = AQUA_SPECIES_TAXONOMY[key];
                  const selected = speciesKey === key;
                  return (
                    <button
                      type="button"
                      key={key}
                      onClick={() => setSpeciesKey(key)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 20,
                        fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        border: `1px solid ${selected ? 'var(--color-navy)' : 'var(--color-border)'}`,
                        background: selected ? 'var(--color-navy)' : 'transparent',
                        color: selected ? '#fff' : 'var(--color-ink)',
                      }}
                    >
                      <span style={{ fontSize: 14 }}>{entry.emoji}</span>
                      {entry.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {speciesKey === 'other' && (
            <input
              type="text"
              value={customSpecies}
              onChange={(e) => setCustomSpecies(e.target.value)}
              placeholder="Type the species name"
              style={{ ...inputStyle, marginTop: 4 }}
            />
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Quantity</label>
            <input type="number" min="0" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="e.g. 500" style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Avg. Weight (kg)</label>
            <input type="number" min="0" step="0.01" value={averageWeightKg} onChange={(e) => setAverageWeightKg(e.target.value)} placeholder="e.g. 0.8" style={inputStyle} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Stocked Date</label>
            <input type="date" value={stockedDate} onChange={(e) => setStockedDate(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Expected Harvest (optional)</label>
            <input type="date" value={expectedHarvestDate} onChange={(e) => setExpectedHarvestDate(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div>
          <label style={labelStyle}>Water Quality (optional)</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {WATER_TYPES.map((wt) => (
              <button
                type="button"
                key={wt}
                onClick={() => setWaterType(wt)}
                style={{
                  padding: '6px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  border: `1px solid ${waterType === wt ? 'var(--color-navy)' : 'var(--color-border)'}`,
                  background: waterType === wt ? 'var(--color-navy)' : 'transparent',
                  color: waterType === wt ? '#fff' : 'var(--color-ink)',
                }}
              >
                {wt}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={{ ...labelStyle, fontWeight: 400, fontSize: 11 }}>pH</label>
              <input type="number" min="0" max="14" step="0.1" value={ph} onChange={(e) => setPh(e.target.value)} placeholder="7.0" style={inputStyle} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ ...labelStyle, fontWeight: 400, fontSize: 11 }}>Temp (°C)</label>
              <input type="number" step="0.1" value={temperatureC} onChange={(e) => setTemperatureC(e.target.value)} placeholder="28" style={inputStyle} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ ...labelStyle, fontWeight: 400, fontSize: 11 }}>DO (mg/L)</label>
              <input type="number" step="0.1" value={dissolvedOxygen} onChange={(e) => setDissolvedOxygen(e.target.value)} placeholder="5.5" style={inputStyle} />
            </div>
          </div>
        </div>

        <div>
          <label style={labelStyle}>Sunlight Exposure (optional)</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {SUNLIGHT_OPTIONS.map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => setSunlightExposure(s)}
                style={{
                  padding: '6px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  border: `1px solid ${sunlightExposure === s ? 'var(--color-navy)' : 'var(--color-border)'}`,
                  background: sunlightExposure === s ? 'var(--color-navy)' : 'transparent',
                  color: sunlightExposure === s ? '#fff' : 'var(--color-ink)',
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--color-ink)', cursor: 'pointer' }}>
            <input type="checkbox" checked={isListedForSale} onChange={(e) => setIsListedForSale(e.target.checked)} />
            List this stock for sale
          </label>
        </div>

        {isListedForSale && (
          <div>
            <label style={labelStyle}>Price per kg (₹)</label>
            <input type="number" min="0" step="0.01" value={pricePerKg} onChange={(e) => setPricePerKg(e.target.value)} placeholder="e.g. 180" style={inputStyle} />
          </div>
        )}

        <div>
          <label style={labelStyle}>Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Feed schedule, batch notes, anything else worth remembering"
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </div>

        {error && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>{error}</div>}

        <button
          type="submit"
          disabled={saving || (!pondId && ponds.length === 0)}
          style={{ padding: 14, borderRadius: 10, border: 'none', background: 'var(--color-gold)', color: 'var(--color-navy)', fontWeight: 700, fontSize: 15 }}
        >
          {saving ? 'Saving...' : editingFish ? 'Save Changes' : 'Add Fish Stock'}
        </button>
      </form>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6 };
const inputStyle = { width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--color-border)', fontSize: 14, fontFamily: 'inherit', outline: 'none' };