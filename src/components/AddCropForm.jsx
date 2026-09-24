// src/components/AddCropForm.jsx
//
// Crop-only form - add OR edit a single crops_marketplace row. Never
// touches field name/boundary/soil in any way, per the user's explicit
// requirement that those stay Profile-tab-only.
//
// Three ways this gets used:
//  1. Home's top-level "+ Add Crop" - no props - shows the field
//     dropdown (compulsory, unlike Cattle Base's optional one).
//  2. Home's per-field "+ Add Crop" (FieldCard header) - pass
//     `lockedField={{ id, name }}` - field is already known, so the
//     dropdown/fetch is skipped entirely and the field name shows as
//     static text instead.
//  3. Home's per-crop "Update" (FieldCard's expanded chip) - pass
//     `editingCrop={cropRow}` (and `lockedField` for the name/id, since
//     a crop's field never changes) - form prefills from the row and
//     Save does an UPDATE instead of an INSERT. Adds a status selector
//     since moving growing -> ready_to_harvest -> harvested is the
//     main thing editing a crop is for.
//
// Insert/update shape/local helpers (compressImageToTargetKB,
// uploadCropAsset, 'crop-images'/'qc-certificates' buckets) copied
// verbatim from AddFieldForm.jsx's own local versions (not the shared
// utils/imageUpload ones AddCattleForm uses) to keep identical behavior
// with the crop rows AddFieldForm already creates today.

import { useEffect, useState } from 'react';
import { supabase } from '../config/supabaseClient';

// --- copied verbatim from AddFieldForm.jsx ---
async function compressImageToTargetKB(file, targetKB = 10, maxDimension = 480) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });

  let width = img.width;
  let height = img.height;
  if (width > maxDimension || height > maxDimension) {
    const scale = maxDimension / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const targetBytes = targetKB * 1024;
  let quality = 0.7;
  let blob = null;

  for (let attempt = 0; attempt < 8; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    // eslint-disable-next-line no-await-in-loop
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size <= targetBytes) break;

    if (quality > 0.25) {
      quality -= 0.15;
    } else {
      width = Math.round(width * 0.8);
      height = Math.round(height * 0.8);
    }
  }

  return blob;
}

async function uploadCropAsset(fileOrBlob, bucket, fileNamePrefix) {
  if (!fileOrBlob) return null;
  const ext = (fileOrBlob.type && fileOrBlob.type.split('/')[1]) || 'jpg';
  const path = `${fileNamePrefix}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, fileOrBlob, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl || null;
}
// --- end copied section ---

const STATUS_OPTIONS = [
  { value: 'growing', label: 'Growing' },
  { value: 'ready_to_harvest', label: 'Ready to harvest' },
  { value: 'harvested', label: 'Harvested' },
];

export default function AddCropForm({ onSaved, onCancel, lockedField, editingCrop }) {
  const isEditMode = !!editingCrop;

  const [fieldId, setFieldId] = useState(lockedField?.id || '');
  const [fields, setFields] = useState([]);
  const [fieldsLoading, setFieldsLoading] = useState(!lockedField);

  const [status, setStatus] = useState(editingCrop?.status || 'growing');
  const [isListed, setIsListed] = useState(editingCrop?.is_listed || false);
  const [cropType, setCropType] = useState(editingCrop?.crop_type || '');
  const [sowingDate, setSowingDate] = useState(editingCrop?.sowing_date || '');
  const [harvestDate, setHarvestDate] = useState(editingCrop?.harvest_date || '');
  const [expectedYieldKg, setExpectedYieldKg] = useState(editingCrop?.expected_yield_kg ?? '');
  const [wholesalePrice, setWholesalePrice] = useState(editingCrop?.wholesale_price ?? '');
  const [retailPrice, setRetailPrice] = useState(editingCrop?.retail_price ?? '');
  const [fertilizerLog, setFertilizerLog] = useState(editingCrop?.fertilizer_log || '');
  const [contactPhone, setContactPhone] = useState(editingCrop?.contact_phone || '');
  const [contactWhatsapp, setContactWhatsapp] = useState(editingCrop?.contact_whatsapp || '');
  const [imageBlob, setImageBlob] = useState(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState(editingCrop?.image_url || '');
  const [qcCertFile, setQcCertFile] = useState(null);
  const [qcCertPreviewUrl, setQcCertPreviewUrl] = useState(editingCrop?.qc_certificate_url || '');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Only fetch the owner's fields when nothing was already handed to
  // us - the compulsory dropdown case (Home's top-level "+ Add Crop").
  useEffect(() => {
    if (lockedField) return;
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setFieldsLoading(false); return; }
      const { data, error: fieldsError } = await supabase
        .from('fields')
        .select('id, name')
        .eq('owner_id', user.id)
        .order('name', { ascending: true });
      if (cancelled) return;
      if (!fieldsError && data) setFields(data);
      setFieldsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [lockedField]);

  // Prefill contact info from the field's own number for a NEW crop -
  // editingCrop's saved values (set as initial state above) always win,
  // so this only runs for fresh crops. Uses prev || fallback so it never
  // overwrites something the farmer already typed into this form.
  useEffect(() => {
    if (isEditMode) return;
    if (!fieldId) return;
    let cancelled = false;
    (async () => {
      const { data, error: fieldError } = await supabase
        .from('fields')
        .select('contact_phone, contact_whatsapp')
        .eq('id', fieldId)
        .single();
      if (cancelled || fieldError || !data) return;
      setContactPhone((prev) => prev || data.contact_phone || '');
      setContactWhatsapp((prev) => prev || data.contact_whatsapp || '');
    })();
    return () => { cancelled = true; };
  }, [fieldId, isEditMode]);

  const handleImageSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImageToTargetKB(file, 10);
      if (!compressed) {
        setError('Could not process that photo, please try another.');
        return;
      }
      setImageBlob(compressed);
      setImagePreviewUrl(URL.createObjectURL(compressed));
    } catch (err) {
      setError('Photo compression failed: ' + err.message);
    }
  };

  const handleQcCertSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Camera-photo only - no raw file/PDF upload. A file's stated MIME
    // type / extension isn't trustworthy (e.g. an executable renamed to
    // look like a .pdf), and forcing every certificate through the
    // camera + image-compression pipeline avoids that class of upload
    // entirely rather than trying to sniff/validate file content.
    if (!file.type.startsWith('image/')) {
      setError('Please take a photo of the certificate - other file types are not accepted.');
      return;
    }
    try {
      const compressed = await compressImageToTargetKB(file, 10);
      if (!compressed) {
        setError('Could not process that certificate photo, please try another.');
        return;
      }
      setQcCertFile(compressed);
      setQcCertPreviewUrl(URL.createObjectURL(compressed));
    } catch (err) {
      setError('Certificate photo compression failed: ' + err.message);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!fieldId) {
      setError('Please select a field - a crop must belong to one.');
      return;
    }
    if (!cropType.trim()) {
      setError('Please enter the crop type.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not logged in.');

      const imageUrl = imageBlob
        ? await uploadCropAsset(imageBlob, 'crop-images', `${fieldId}-${Date.now()}`)
        : (isEditMode ? editingCrop.image_url : null);
      const qcCertUrl = qcCertFile
        ? await uploadCropAsset(qcCertFile, 'qc-certificates', `${fieldId}-${Date.now()}-qc`)
        : (isEditMode ? editingCrop.qc_certificate_url : null);

      const rowData = {
        field_id: fieldId,
        owner_id: user.id,
        crop_type: cropType.trim(),
        status,
        is_listed: isListed,
        sowing_date: sowingDate || null,
        harvest_date: harvestDate || null,
        expected_yield_kg: expectedYieldKg !== '' ? Number(expectedYieldKg) : null,
        wholesale_price: wholesalePrice !== '' ? Number(wholesalePrice) : null,
        retail_price: retailPrice !== '' ? Number(retailPrice) : null,
        fertilizer_log: fertilizerLog.trim() || null,
        image_url: imageUrl,
        contact_phone: contactPhone.trim() || null,
        contact_whatsapp: contactWhatsapp.trim() || null,
        qc_certificate_url: qcCertUrl,
      };

      let savedCrop;
      if (isEditMode) {
        const { data, error: updateError } = await supabase
          .from('crops_marketplace')
          .update(rowData)
          .eq('id', editingCrop.id)
          .select()
          .single();
        if (updateError) throw updateError;
        savedCrop = data;
      } else {
        const { data, error: insertError } = await supabase
          .from('crops_marketplace')
          .insert(rowData)
          .select()
          .single();
        if (insertError) throw insertError;
        savedCrop = data;
      }

      onSaved?.(savedCrop);
    } catch (err) {
      setError(err.message || 'Crop save failed, please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-navy)' }}>
        {isEditMode ? 'Update Crop' : 'Add Crop'}
      </div>

      <div>
        <label style={labelStyle}>Field</label>
        {lockedField ? (
          <div style={{ ...inputStyle, background: 'var(--color-bg)', color: 'var(--color-ink)' }}>
            {lockedField.name}
          </div>
        ) : (
          <>
            <select
              value={fieldId}
              onChange={(e) => setFieldId(e.target.value)}
              style={inputStyle}
              disabled={fieldsLoading}
            >
              <option value="">{fieldsLoading ? 'Loading...' : 'Select a field'}</option>
              {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            {!fieldsLoading && fields.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--color-danger)', marginTop: 4 }}>
                You don't have any fields yet - add one from the Profile tab first, then come back here to add a crop.
              </div>
            )}
          </>
        )}
      </div>

      {isEditMode && (
        <div>
          <label style={labelStyle}>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
            {STATUS_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </div>
      )}

      <div>
        <label style={labelStyle}>Crop type</label>
        <input
          type="text"
          value={cropType}
          onChange={(e) => setCropType(e.target.value)}
          placeholder="e.g. chilli"
          style={inputStyle}
        />
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ width: 56, height: 56, borderRadius: 8, overflow: 'hidden', flexShrink: 0, background: 'var(--color-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {imagePreviewUrl ? (
            <img src={imagePreviewUrl} alt="crop" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: 22 }}>🌱</span>
          )}
        </div>
        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-navy)' }}>
          {imagePreviewUrl ? 'Change photo' : 'Add crop photo (optional)'}
          <input type="file" accept="image/*" capture="environment" onChange={handleImageSelect} style={{ display: 'none' }} />
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Sowing date</label>
          <input type="date" value={sowingDate} onChange={(e) => setSowingDate(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Expected harvest</label>
          <input type="date" value={harvestDate} onChange={(e) => setHarvestDate(e.target.value)} style={inputStyle} />
        </div>
      </div>

      <div>
        <label style={labelStyle}>Expected yield (kg, optional)</label>
        <input type="number" min="0" value={expectedYieldKg} onChange={(e) => setExpectedYieldKg(e.target.value)} style={inputStyle} />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Wholesale price (optional)</label>
          <input type="number" min="0" value={wholesalePrice} onChange={(e) => setWholesalePrice(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Retail price (optional)</label>
          <input type="number" min="0" value={retailPrice} onChange={(e) => setRetailPrice(e.target.value)} style={inputStyle} />
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={isListed}
          onChange={(e) => setIsListed(e.target.checked)}
          style={{ width: 18, height: 18 }}
        />
        <span style={{ fontSize: 14, color: 'var(--color-ink)' }}>
          List this crop on the marketplace (buyers can see and message you about it)
        </span>
      </label>

      <div>
        <label style={labelStyle}>Fertilizer log (optional)</label>
        <textarea value={fertilizerLog} onChange={(e) => setFertilizerLog(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      </div>

      <div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Contact phone (optional)</label>
            <input type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="e.g. 9876543210" style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>WhatsApp (optional)</label>
            <input type="tel" value={contactWhatsapp} onChange={(e) => setContactWhatsapp(e.target.value)} placeholder="e.g. 9876543210" style={inputStyle} />
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
          Prefilled from your field's number - change it here just for this crop if needed.
        </div>
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-navy)', display: 'block' }}>
          {qcCertPreviewUrl ? '✓ QC certificate attached - retake' : '📷 Take QC certificate photo (optional)'}
          <input type="file" accept="image/*" capture="environment" onChange={handleQcCertSelect} style={{ display: 'none' }} />
        </label>
        {qcCertPreviewUrl && (
          <img src={qcCertPreviewUrl} alt="QC certificate preview" style={{ marginTop: 8, maxWidth: 120, borderRadius: 8, border: '1px solid var(--color-border)' }} />
        )}
      </div>

      {error && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          type="submit"
          disabled={saving || (!lockedField && (fieldsLoading || fields.length === 0))}
          style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', background: 'var(--color-navy)', color: '#fff', fontWeight: 700, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Saving...' : isEditMode ? 'Save Changes' : 'Save Crop'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={saving} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-card)', color: 'var(--color-ink)', fontWeight: 600 }}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6 };
const inputStyle = { width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--color-border)', fontSize: 14, fontFamily: 'inherit', outline: 'none' };