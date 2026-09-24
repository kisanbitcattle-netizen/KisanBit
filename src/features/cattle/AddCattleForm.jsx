// src/components/AddCattleForm.jsx

import { useEffect, useRef, useState } from 'react';
import { MapContainer, Circle, Marker, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Geolocation } from '@capacitor/geolocation';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { supabase } from '../../config/supabaseClient';
import { ANIMAL_TAXONOMY, ANIMAL_TYPES, ANIMAL_GROUPS, breedsFor, producesMilk } from '../../utils/animalTaxonomy';
import { compressImageToTargetKB, uploadCompressedAsset } from '../../utils/imageUpload';
import { sanitizeText, sanitizePhone, sanitizeNumber, sanitizeEnum } from '../../utils/sanitize';
import { reverseGeocode } from '../../utils/reverseGeocode';
import OfflineTileLayer from '../map/OfflineTileLayer';

// ANIMAL_TYPES / breed lists used to be hardcoded here (cow/buffalo/goat/
// sheep/other only, one shared CATTLE_BREEDS list for all of them). Both
// now come from animalTaxonomy.js, the single source of truth covering the
// full range of animals the app supports - each with its own breed list and
// a `sellable` flag the marketplace/transfer code gates on. Not every
// category can be listed for sale (see that file's header comment) -
// AddCattleForm itself doesn't need to check `sellable` directly, since
// listing only ever happens later from CattleCard, but the type picker
// below shows a short note on non-sellable categories so a farmer isn't
// surprised when Sell doesn't appear for them.
const DEFAULT_CENTER = [17.385, 78.4867];
const DEFAULT_RADIUS_M = 1000;
// Zone constants mirrored from GeofenceSetupModal.jsx - Zones setup now
// lives directly in this form instead of a separate post-creation step,
// so these limits (and the nesting rule below) need to match exactly.
const PUBLIC_MIN_RADIUS_M = 100;
const PUBLIC_MAX_RADIUS_M = 1000;
const ALERT_TIER1_MAX_M = 1000;
const ALERT_TIER23_MAX_M = 7000;
const GENDERS = ['male', 'female'];
const PREGNANCY_STATUSES = ['pregnant', 'not_pregnant', 'dry'];
// Average gestation length by species, used to suggest an expected calving
// date once an AI date is entered. Types without a reliable default are
// left out on purpose - the form already falls back to manual entry for
// any type not listed here (see the "no gestation estimate" message below).
const GESTATION_DAYS = { cow: 283, buffalo: 310, goat: 150, sheep: 152, pig: 114, dog: 63, camel: 390, horse: 340 };

function generateUuidV4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Finds which ANIMAL_GROUPS bucket a given animal type belongs to, so the
// accordion type-picker below can auto-open the right group instead of
// starting on none of them. Falls back to the first group if the type
// somehow isn't in any bucket (shouldn't happen, but cheaper than a crash).
function groupForType(type) {
  for (const [groupName, typesInGroup] of Object.entries(ANIMAL_GROUPS)) {
    if (typesInGroup.includes(type)) return groupName;
  }
  return Object.keys(ANIMAL_GROUPS)[0];
}

function ClickToPin({ onPick }) {
  useMapEvents({
    click(e) {
      onPick([e.latlng.lat, e.latlng.lng]);
    },
  });
  return null;
}

// Imperatively recenters the already-mounted map once a GPS fix comes in -
// MapContainer's `center` prop only applies once at initial mount, so a
// later state update alone wouldn't move it. Same map.setView() pattern
// AddFieldForm.jsx's RecenterOnWalk already uses. Skips recentering once
// the farmer has tapped a pin - their explicit choice shouldn't get
// overridden by a late-arriving GPS fix.
function RecenterOnGps({ position, skip }) {
  const map = useMap();
  useEffect(() => {
    if (position && !skip) map.setView(position, map.getZoom());
  }, [position, skip, map]);
  return null;
}

let vaccineIdCounter = 0;

export default function AddCattleForm({ onClose, onSaved }) {
  const [name, setName] = useState('');
  const [animalType, setAnimalType] = useState('cow');
  // Accordion state for the Type picker below - showing all 7 groups
  // (Domestic & Farm Mammals, Flightless Birds, Flying Birds, Land
  // Mammals, Reptiles, Marine Mammals, Other) fully expanded at once ate
  // up a lot of vertical space. Starts expanded (a fresh Add hasn't had a
  // deliberate pick yet) with only the default type's group open; picking
  // any animal collapses the whole thing down to a one-line summary chip
  // with a "Change" link to reopen it.
  const [typeExpanded, setTypeExpanded] = useState(true);
  const [openGroup, setOpenGroup] = useState(() => groupForType('cow'));
  const [customAnimalType, setCustomAnimalType] = useState('');
  // Type picker accordion - all 7 ANIMAL_GROUPS used to render fully
  // expanded at once, making the form very tall. Now collapsed to a
  // single summary chip by default; opening it expands one group at a
  // time (whichever contains the current animalType, so re-opening lands
  // you back where you were), and picking a type collapses it again.
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState(null);
  const handleToggleTypePicker = () => {
    if (!typePickerOpen) {
      const currentGroup = Object.entries(ANIMAL_GROUPS).find(([, types]) => types.includes(animalType))?.[0] || null;
      setExpandedGroup(currentGroup);
    }
    setTypePickerOpen((v) => !v);
  };
  const [breed, setBreed] = useState('');
  const [customBreed, setCustomBreed] = useState('');
  const [govtInaphId, setGovtInaphId] = useState('');
  const [collarId, setCollarId] = useState('');
  const [tagDeveui, setTagDeveui] = useState('');
  const [manualTagEntry, setManualTagEntry] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [birthDate, setBirthDate] = useState('');
  const [calvingCount, setCalvingCount] = useState(0);
  const [weightKg, setWeightKg] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactWhatsapp, setContactWhatsapp] = useState('');
  // Same consent gate as AddServiceForm.jsx - off by default. Only
  // controls whether Call/WhatsApp buttons appear on the public cattle
  // detail card; buyers can always reach the owner through Chat either way.
  const [showContactPublicly, setShowContactPublicly] = useState(false);
  const [qcCertFile, setQcCertFile] = useState(null);
  const [qcCertPreviewUrl, setQcCertPreviewUrl] = useState(null);
  const [vaccineEntries, setVaccineEntries] = useState([]);
  const [localImageUri, setLocalImageUri] = useState(null); // preview only, never sent to the DB
  const [photoFile, setPhotoFile] = useState(null); // the actual file, compressed+uploaded on submit
  const [pinLocation, setPinLocation] = useState(null);
  // One-time GPS fix on open, so the map centers on the farmer's actual
  // location instead of always opening on the DEFAULT_CENTER fallback
  // (Hyderabad) - matches AddFieldForm.jsx's existing use of
  // @capacitor/geolocation (not plain navigator.geolocation) for
  // reliable native GPS. Map mounts at DEFAULT_CENTER immediately as
  // before; RecenterOnGps below imperatively pans it once this resolves.
  const [gpsCenter, setGpsCenter] = useState(null);
  // Zones setup, formerly its own post-creation step (GeofenceSetupModal,
  // opened later from the cattle card) - now set at creation time.
  // radiusM is the public geofence (what buyers see); tier1/2/3 are the
  // private alert zones. Same defaults and nesting rule as
  // GeofenceSetupModal: tier2 can't go below tier1, tier3 can't go below
  // tier2 - keeps the zones visually nested on the map.
  const [radiusM, setRadiusM] = useState(DEFAULT_RADIUS_M);
  const [tier1, setTier1] = useState(1000);
  const [tier2, setTier2] = useState(2000);
  const [tier3, setTier3] = useState(5000);

  const handleTier1Change = (val) => {
    const clamped = Math.min(val, ALERT_TIER1_MAX_M);
    setTier1(clamped);
    if (tier2 < clamped) setTier2(clamped);
    if (tier3 < clamped) setTier3(clamped);
  };
  const handleTier2Change = (val) => {
    const clamped = Math.min(Math.max(val, tier1), ALERT_TIER23_MAX_M);
    setTier2(clamped);
    if (tier3 < clamped) setTier3(clamped);
  };
  const handleTier3Change = (val) => {
    const clamped = Math.min(Math.max(val, tier2), ALERT_TIER23_MAX_M);
    setTier3(clamped);
  };

  useEffect(() => {
    let cancelled = false;
    Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 })
      .then((pos) => {
        if (!cancelled) setGpsCenter([pos.coords.latitude, pos.coords.longitude]);
      })
      .catch((err) => {
        // No permission / GPS off / timed out - map just stays on
        // DEFAULT_CENTER, same as before this fix.
        console.warn('[AddCattleForm] GPS fix failed, using default center:', err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [baseId, setBaseId] = useState('');
  const [bases, setBases] = useState([]);
  const [basesLoading, setBasesLoading] = useState(true);
  const [gender, setGender] = useState('');
  const [isMilking, setIsMilking] = useState(false);
  const [dailyMilkYield, setDailyMilkYield] = useState('');
  const [pregnancyStatus, setPregnancyStatus] = useState('');
  const [aiDate, setAiDate] = useState('');
  const [expectedCalvingDate, setExpectedCalvingDate] = useState('');
  const [calvingDateEdited, setCalvingDateEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const qcCertInputRef = useRef(null);
  const draftId = useState(generateUuidV4)[0];

  // Load this owner's Cattle Bases so the animal can optionally be linked
  // to one at creation time. Not linking one is valid - animal falls back
  // to its own geofence_center/geofence_radius_m, same as before Bases existed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setBasesLoading(false); return; }
      const { data, error: basesError } = await supabase
        .from('cattle_bases')
        .select('id, base_name')
        .eq('owner_id', user.id)
        .order('base_name', { ascending: true });
      if (cancelled) return;
      if (!basesError && data) setBases(data);
      setBasesLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Suggest an expected calving date from ai_date + species gestation length.
  // Only auto-fills while the user hasn't manually edited the field - once
  // they touch it directly, their value wins and we stop overwriting it.
  useEffect(() => {
    if (calvingDateEdited) return;
    if (!aiDate) { setExpectedCalvingDate(''); return; }
    const days = GESTATION_DAYS[animalType];
    if (!days) return; // 'other' or unknown type - leave for manual entry
    const d = new Date(aiDate);
    d.setDate(d.getDate() + days);
    setExpectedCalvingDate(d.toISOString().slice(0, 10));
  }, [aiDate, animalType, calvingDateEdited]);

  // Prefill contact info from the selected Cattle Base - same pattern as
  // AddCropForm.jsx pulling from its field. Uses prev || fallback so it
  // never overwrites something the farmer already typed here, and only
  // re-fires when they actually change the Base dropdown.
  useEffect(() => {
    if (!baseId) return;
    let cancelled = false;
    (async () => {
      const { data, error: baseError } = await supabase
        .from('cattle_bases')
        .select('contact_phone, contact_whatsapp')
        .eq('id', baseId)
        .single();
      if (cancelled || baseError || !data) return;
      setContactPhone((prev) => prev || data.contact_phone || '');
      setContactWhatsapp((prev) => prev || data.contact_whatsapp || '');
    })();
    return () => { cancelled = true; };
  }, [baseId]);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    const reader = new FileReader();
    reader.onload = () => setLocalImageUri(reader.result); // preview only
    reader.onerror = () => setError('Could not read that photo, try again.');
    reader.readAsDataURL(file);
  };

  const handleQcCertSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Images only now - PDF support removed. compressImageToTargetKB below
    // needs a real image to draw onto a canvas; a PDF would just fail
    // silently there, so reject it here with a clear message instead.
    if (!file.type?.startsWith('image/')) {
      setError('QC certificate must be a photo (JPG/PNG), not a PDF.');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError('QC certificate photo is too large (max 15MB before compression).');
      return;
    }
    setQcCertFile(file);
    setQcCertPreviewUrl(URL.createObjectURL(file));
  };

  const handleScanTag = async () => {
    setError(null);
    try {
      const { camera } = await BarcodeScanner.requestPermissions();
      if (camera !== 'granted' && camera !== 'limited') {
        setError('Please grant camera permission to scan the QR code.');
        return;
      }
      setScanning(true);
      const { barcodes } = await BarcodeScanner.scan();
      if (barcodes.length > 0) {
        setTagDeveui(barcodes[0].rawValue);
      }
    } catch (err) {
      setError('Scan failed - please type it manually below.');
      setManualTagEntry(true);
    } finally {
      setScanning(false);
    }
  };

  const addVaccineEntry = () => {
    vaccineIdCounter += 1;
    setVaccineEntries((prev) => [
      ...prev,
      { key: vaccineIdCounter, desc: '', notes: '', date: new Date().toISOString().slice(0, 10) },
    ]);
  };
  const updateVaccineEntry = (key, field, value) => {
    setVaccineEntries((prev) => prev.map((v) => (v.key === key ? { ...v, [field]: value } : v)));
  };
  const removeVaccineEntry = (key) => {
    setVaccineEntries((prev) => prev.filter((v) => v.key !== key));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please enter a name.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not logged in.');

      const finalBreed = breed === 'Other' ? customBreed.trim() : breed;

      // Sanitize every free-text/numeric field right at the DB boundary -
      // was previously going straight from useState to insert() with no
      // validation at all.
      const insertData = {
        id: draftId,
        owner_id: user.id,
        name: sanitizeText(name.trim()),
        animal_type: sanitizeEnum(animalType, ANIMAL_TYPES),
        animal_type_custom_label: animalType === 'other' ? sanitizeText(customAnimalType.trim()) || null : null,
        breed: sanitizeText(finalBreed) || null,
        govt_inaph_id: sanitizeText(govtInaphId.trim()) || null,
        collar_id: sanitizeText(collarId.trim()) || null,
        tag_deveui: sanitizeText(tagDeveui.trim()) || null,
        birth_date: birthDate || null,
        calving_count: sanitizeNumber(calvingCount) || 0,
        weight_kg: weightKg !== '' ? sanitizeNumber(weightKg) : null,
        contact_phone: contactPhone.trim() ? sanitizePhone(contactPhone.trim()) : null,
        contact_whatsapp: contactWhatsapp.trim() ? sanitizePhone(contactWhatsapp.trim()) : null,
        show_contact_publicly: showContactPublicly,
        base_id: baseId || null,
        gender: gender ? sanitizeEnum(gender, GENDERS) : null,
        is_milking: gender === 'female' ? isMilking : false,
        daily_milk_yield_liters: gender === 'female' && isMilking && dailyMilkYield !== ''
          ? sanitizeNumber(dailyMilkYield) : null,
        pregnancy_status: gender === 'female' && pregnancyStatus
          ? sanitizeEnum(pregnancyStatus, PREGNANCY_STATUSES) : null,
        ai_date: gender === 'female' && aiDate ? aiDate : null,
        expected_calving_date: gender === 'female' && expectedCalvingDate ? expectedCalvingDate : null,
        // local_image_path is set AFTER insert, once the photo is compressed
        // and uploaded to Storage — never store the raw base64 here.
        // Alert zones are private, per-animal, and apply regardless of
        // whether this animal is linked to a Base - matches
        // GeofenceSetupModal's own handleSave, which always writes these
        // three even for a base-linked animal.
        alert_radius_1_m: Math.round(tier1),
        alert_radius_2_m: Math.round(tier2),
        alert_radius_3_m: Math.round(tier3),
      };

      // Only individual (no-Base) animals get their own geofence_center from
      // the map pin. If a Base is linked, the animal inherits the Base's
      // location/fence instead - the pin map is hidden in that case (see the
      // Home Location section below), but pinLocation could still hold a
      // stale value if the farmer pinned before selecting a Base. Gate on
      // !baseId so that stale pin can never override the Base link.
      if (!baseId && pinLocation) {
        insertData.geofence_center = `SRID=4326;POINT(${pinLocation[1]} ${pinLocation[0]})`;
        insertData.geofence_radius_m = Math.round(radiusM);
        // Best-effort - only used as a "place" fallback for cattle NOT
        // linked to a Base (Base's own place_name wins - see
        // CattleDetailModal.jsx). null on failure is fine, this is a
        // brand-new row so there's nothing existing to accidentally wipe.
        insertData.place_name = await reverseGeocode(pinLocation[0], pinLocation[1]);
      }

      const { error: insertError } = await supabase.from('cattle').insert(insertData);
      if (insertError) throw insertError;

      if (photoFile) {
        const compressedPhoto = await compressImageToTargetKB(photoFile, 40, 640);
        if (compressedPhoto) {
          const photoUrl = await uploadCompressedAsset(compressedPhoto, 'cattle-photos', draftId);
          const { error: photoUpdateError } = await supabase
            .from('cattle')
            .update({ local_image_path: photoUrl })
            .eq('id', draftId);
          if (photoUpdateError) throw new Error(`Could not save photo link: ${photoUpdateError.message}`);
        }
      }

      if (qcCertFile) {
        // Always an image now (PDF rejected at selection time above), so
        // this always goes through compression - target 60KB, comfortably
        // under the 100KB ceiling.
        const compressedCert = await compressImageToTargetKB(qcCertFile, 60, 900);
        if (compressedCert) {
          const photoUrl = await uploadCompressedAsset(compressedCert, 'qc-certificates', `${draftId}-qc`);
          const { error: qcUpdateError } = await supabase
            .from('cattle')
            .update({ qc_certificate_url: photoUrl })
            .eq('id', draftId);
          if (qcUpdateError) throw new Error(`Could not save QC certificate link: ${qcUpdateError.message}`);
        }
      }

      const records = vaccineEntries
        .filter((v) => v.desc.trim())
        .map((v) => ({
          cattle_id: draftId,
          record_type: 'vaccination',
          description: sanitizeText(v.desc.trim()),
          notes: v.notes.trim() ? sanitizeText(v.notes.trim()) : null,
          recorded_date: v.date,
        }));
      if (records.length > 0) {
        await supabase.from('cattle_health_records').insert(records);
      }

      onSaved();
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
          <span className="display-text" style={{ fontSize: 18, color: 'var(--color-navy)' }}>Add Cattle</span>
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
              <img src={localImageUri} alt="cattle" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : ('Add Photo')}
          </button>
        </div>
        <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--color-muted)', marginTop: -8 }}>
          Photo stays on your device unless you list this animal for sale.
        </div>

        <div>
          <label style={labelStyle}>Type</label>
          {!typeExpanded ? (
            <button
              type="button"
              onClick={() => setTypeExpanded(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: 10, borderRadius: 10, border: '2px solid var(--color-gold)',
                background: 'rgba(222, 160, 59, 0.12)', textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 22 }}>{ANIMAL_TAXONOMY[animalType]?.emoji}</span>
              <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--color-ink)', textTransform: 'capitalize' }}>
                {animalType === 'other' && customAnimalType.trim() ? customAnimalType : ANIMAL_TAXONOMY[animalType]?.label}
              </span>
              <span style={{ fontSize: 12, color: 'var(--color-navy)', fontWeight: 700, textDecoration: 'underline' }}>Change</span>
            </button>
          ) : (
            Object.entries(ANIMAL_GROUPS).map(([groupName, typesInGroup]) => {
              const isOpenGroup = openGroup === groupName;
              return (
                <div key={groupName} style={{ marginBottom: 6, border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden' }}>
                  <button
                    type="button"
                    onClick={() => setOpenGroup(isOpenGroup ? null : groupName)}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                      padding: '8px 10px', border: 'none', background: isOpenGroup ? 'var(--color-bg)' : 'var(--color-card)',
                      fontSize: 11, fontWeight: 700, color: 'var(--color-muted)', textAlign: 'left',
                    }}
                  >
                    <span>{groupName}</span>
                    <span>{isOpenGroup ? '▲' : '▼'}</span>
                  </button>
                  {isOpenGroup && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: 8 }}>
                      {typesInGroup.map((type) => (
                        <button
                          type="button"
                          key={type}
                          onClick={() => {
                            setAnimalType(type);
                            // Breed lists are per animal type - a breed picked
                            // under the old type wouldn't exist in the new
                            // type's list, so clear it rather than silently
                            // save a mismatched breed string.
                            setBreed('');
                            setCustomBreed('');
                            // Collapse back to the summary chip once a pick
                            // is made, so the picker doesn't keep eating
                            // vertical space after the farmer is done with it.
                            setTypeExpanded(false);
                          }}
                          style={{
                            flex: '1 1 18%', minWidth: 60, padding: 10, borderRadius: 10,
                            border: `2px solid ${animalType === type ? 'var(--color-gold)' : 'var(--color-border)'}`,
                            background: animalType === type ? 'rgba(222, 160, 59, 0.18)' : 'var(--color-card)', fontSize: 20,
                          }}
                        >
                          {ANIMAL_TAXONOMY[type].emoji}
                          <div style={{ fontSize: 11, marginTop: 2, textTransform: 'capitalize', color: 'var(--color-ink)' }}>{ANIMAL_TAXONOMY[type].label}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
          {!ANIMAL_TAXONOMY[animalType]?.sellable && (
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
              Record-keeping only - this animal type can't be listed for sale in the marketplace.
            </div>
          )}
          {animalType === 'other' && (
            <input
              type="text"
              value={customAnimalType}
              onChange={(e) => setCustomAnimalType(e.target.value)}
              placeholder="Enter animal type"
              style={{ ...inputStyle, marginTop: 8 }}
            />
          )}
        </div>

        <div>
          <label style={labelStyle}>Cattle Base (optional)</label>
          <select value={baseId} onChange={(e) => setBaseId(e.target.value)} style={inputStyle} disabled={basesLoading}>
            <option value="">{basesLoading ? 'Loading...' : 'No base - track individually'}</option>
            {bases.map((b) => <option key={b.id} value={b.id}>{b.base_name}</option>)}
          </select>
          {!basesLoading && bases.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
              You don't have any Cattle Bases yet - this animal will use its own location below instead.
            </div>
          )}
        </div>

        <div>
          <label style={labelStyle}>Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lakshmi" style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>Breed</label>
          <select value={breed} onChange={(e) => setBreed(e.target.value)} style={inputStyle}>
            <option value="">Select breed</option>
            {breedsFor(animalType).map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          {breed === 'Other' && (
            <input
              type="text"
              value={customBreed}
              onChange={(e) => setCustomBreed(e.target.value)}
              placeholder="Enter breed name"
              style={{ ...inputStyle, marginTop: 8 }}
            />
          )}
        </div>

        <div>
          <label style={labelStyle}>Govt INAPH ID (optional)</label>
          <input type="text" value={govtInaphId} onChange={(e) => setGovtInaphId(e.target.value)} placeholder="12-digit INAPH ID" style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>Birth Date (optional)</label>
          <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} max={new Date().toISOString().split('T')[0]} style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>Calving Count</label>
          <input type="number" min="0" value={calvingCount} onChange={(e) => setCalvingCount(e.target.value)} style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>Weight (kg, optional)</label>
          <input type="number" min="0" step="0.1" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} placeholder="e.g. 350" style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>Gender (optional)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {GENDERS.map((g) => (
              <button
                type="button"
                key={g}
                onClick={() => setGender((prev) => (prev === g ? '' : g))}
                style={{
                  flex: 1, padding: 10, borderRadius: 10, textTransform: 'capitalize',
                  border: `2px solid ${gender === g ? 'var(--color-gold)' : 'var(--color-border)'}`,
                  background: gender === g ? 'rgba(222, 160, 59, 0.18)' : 'var(--color-card)', fontSize: 13, fontWeight: 600, color: 'var(--color-ink)',
                }}
              >
                {g}
              </button>
            ))}
          </div>
        </div>

        {gender === 'female' && (
          <>
            {producesMilk(animalType) && (
              <div>
                <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={isMilking} onChange={(e) => setIsMilking(e.target.checked)} style={{ width: 16, height: 16 }} />
                  Currently milking
                </label>
                {isMilking && (
                  <input
                    type="number" min="0" step="0.1"
                    value={dailyMilkYield}
                    onChange={(e) => setDailyMilkYield(e.target.value)}
                    placeholder="Daily milk yield (liters)"
                    style={{ ...inputStyle, marginTop: 8 }}
                  />
                )}
              </div>
            )}

            <div>
              <label style={labelStyle}>Pregnancy Status (optional)</label>
              <select value={pregnancyStatus} onChange={(e) => setPregnancyStatus(e.target.value)} style={inputStyle}>
                <option value="">Select status</option>
                <option value="pregnant">Pregnant</option>
                <option value="not_pregnant">Not Pregnant</option>
                <option value="dry">Dry</option>
              </select>
            </div>

            {pregnancyStatus === 'pregnant' && (
              <>
                <div>
                  <label style={labelStyle}>AI / Breeding Date (optional)</label>
                  <input
                    type="date" value={aiDate}
                    onChange={(e) => { setAiDate(e.target.value); setCalvingDateEdited(false); }}
                    max={new Date().toISOString().split('T')[0]}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>
                    Expected Calving Date {aiDate && !calvingDateEdited ? '(estimated)' : '(optional)'}
                  </label>
                  <input
                    type="date" value={expectedCalvingDate}
                    onChange={(e) => { setExpectedCalvingDate(e.target.value); setCalvingDateEdited(true); }}
                    style={inputStyle}
                  />
                  {animalType === 'other' && aiDate && (
                    <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
                      No gestation estimate for "other" animal types - please enter the date manually.
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        <label style={labelStyle}>Contact Phone &amp; WhatsApp (both optional)</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 4 }}>Phone (used for the call button)</div>
            <input type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="e.g. 9876543210" style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 4 }}>WhatsApp (blank = phone)</div>
            <input type="tel" value={contactWhatsapp} onChange={(e) => setContactWhatsapp(e.target.value)} placeholder="e.g. 9876543210" style={inputStyle} />
          </div>
        </div>
        {baseId && (
          <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
            WhatsApp prefilled from the selected Cattle Base - change it here just for this animal if needed.
          </div>
        )}

        {/* Consent gate - OFF by default. Only controls whether the Call
            Now / WhatsApp Us buttons appear on the public cattle detail
            card. Buyers can always reach the owner through Chat either
            way, and the owner can separately share their number per-buyer
            from inside a chat regardless of this setting. Same pattern as
            AddServiceForm.jsx - keep both in sync if either changes. */}
        <button
          type="button"
          onClick={() => setShowContactPublicly((prev) => !prev)}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
            background: 'none', border: '1px solid var(--color-border)', borderRadius: 10, padding: 12,
            color: 'var(--color-navy)', fontSize: 14, cursor: 'pointer', textAlign: 'left',
          }}
        >
          <span>
            {showContactPublicly ? '🌐 Call & WhatsApp buttons shown on card' : '🔒 Call & WhatsApp buttons hidden — Chat only'}
          </span>
          <span
            aria-hidden="true"
            style={{
              width: 40, height: 22, borderRadius: 11, position: 'relative', flexShrink: 0,
              background: showContactPublicly ? 'var(--color-success, #2e8b57)' : 'var(--color-border)',
              border: '1px solid var(--color-border)', transition: 'background 0.15s',
            }}
          >
            <span
              style={{
                position: 'absolute', top: 1, left: showContactPublicly ? 19 : 1,
                width: 18, height: 18, borderRadius: '50%', background: '#fff',
                transition: 'left 0.15s',
              }}
            />
          </span>
        </button>
        <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: -6 }}>
          Off by default. Buyers can always message you through Chat either way.
        </div>

        <div>
          <label style={labelStyle}>QC Certificate (optional)</label>
          {/* Hidden native input, triggered by our own themed button below -
              same pattern as the cattle photo picker above. A raw
              <input type="file"> renders its "Choose File" button using
              OS/browser chrome that mostly ignores CSS, which is why it
              looked broken in dark mode - this fixes that by never
              showing the native button at all. */}
          <input
            ref={qcCertInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleQcCertSelect}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            onClick={() => qcCertInputRef.current?.click()}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: 10, borderRadius: 10, border: '2px dashed var(--color-border)',
              background: 'var(--color-bg)', color: 'var(--color-ink)', cursor: 'pointer', textAlign: 'left',
            }}
          >
            {qcCertPreviewUrl ? (
              <img src={qcCertPreviewUrl} alt="QC certificate preview" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
            ) : (
              <span style={{ fontSize: 20 }}>📄</span>
            )}
            <span style={{ fontSize: 13, flex: 1 }}>
              {qcCertFile ? qcCertFile.name : 'Take certificate photo (camera)'}
            </span>
            {qcCertFile && (
              <span style={{ fontSize: 12, color: 'var(--color-navy)', fontWeight: 700, textDecoration: 'underline' }}>Change</span>
            )}
          </button>
        </div>

        <div>
          <label style={labelStyle}>Collar ID (your own serial number, optional)</label>
          <input
            type="text"
            value={collarId}
            onChange={(e) => setCollarId(e.target.value)}
            placeholder="e.g. A-12 (any label you like for your farm)"
            style={inputStyle}
          />
        </div>

        <div>
          <label style={labelStyle}>GoTag Hardware ID (optional)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={tagDeveui}
              onChange={(e) => setTagDeveui(e.target.value)}
              placeholder={manualTagEntry ? 'Enter DevEUI' : 'Scan QR code'}
              style={{ ...inputStyle, flex: 1 }}
              readOnly={!manualTagEntry}
            />
            <button
              type="button"
              onClick={handleScanTag}
              disabled={scanning}
              style={{ padding: '0 16px', borderRadius: 10, border: 'none', background: 'var(--color-navy)', color: '#fff', fontWeight: 700, fontSize: 13 }}
            >
              {scanning ? '...' : '📷 Scan'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setManualTagEntry((v) => !v)}
            style={{ fontSize: 11, color: 'var(--color-muted)', background: 'none', border: 'none', textDecoration: 'underline', padding: 0, marginTop: 4, textAlign: 'left' }}
          >
            {manualTagEntry ? 'Back to scan' : "If scan doesn't work, type it manually here"}
          </button>
        </div>

        <div>
          <label style={labelStyle}>Vaccine / Health Records</label>
          {vaccineEntries.map((v) => (
            <div key={v.key} className="kb-card" style={{ padding: 10, marginBottom: 8 }}>
              <input
                placeholder="e.g. FMD vaccine"
                value={v.desc}
                onChange={(e) => updateVaccineEntry(v.key, 'desc', e.target.value)}
                style={{ ...inputStyle, marginBottom: 6 }}
              />
              <input
                type="date"
                value={v.date}
                onChange={(e) => updateVaccineEntry(v.key, 'date', e.target.value)}
                style={{ ...inputStyle, marginBottom: 6 }}
              />
              <textarea
                placeholder="Notes (optional) - dose, batch number, vet name, etc."
                value={v.notes}
                onChange={(e) => updateVaccineEntry(v.key, 'notes', e.target.value)}
                rows={2}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
              <button
                type="button"
                onClick={() => removeVaccineEntry(v.key)}
                style={{ fontSize: 11, color: 'var(--color-danger)', background: 'none', border: 'none', marginTop: 4, padding: 0 }}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addVaccineEntry}
            style={{ padding: '8px 12px', borderRadius: 8, border: '2px dashed var(--color-gold)', background: 'transparent', color: 'var(--color-ink)', fontSize: 13, fontWeight: 700, width: '100%' }}
          >
            + add vaccine / health record
          </button>
        </div>

        <div>
          <label style={labelStyle}>Geofence &amp; Alert Zones</label>
          {baseId ? (
            <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 10, borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-bg)' }}>
              🌐 This animal's public geofence follows its Cattle Base's location and radius automatically - no separate pin needed here. Edit the Base itself to change it. The alert zones below still apply to this animal individually.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--color-ink)', marginBottom: 4 }}>
                🌐 Public geofence (buyers see this circle) {pinLocation ? '(pinned)' : '- tap map to pin'}
              </div>
              <div style={{ height: 180, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--color-border)' }}>
                <MapContainer center={pinLocation || gpsCenter || DEFAULT_CENTER} zoom={13} style={{ height: '100%', width: '100%', background: 'var(--color-bg)' }}>
                  <OfflineTileLayer />
                  <ClickToPin onPick={setPinLocation} />
                  <RecenterOnGps position={gpsCenter} skip={!!pinLocation} />
                  {pinLocation && (
                    <>
                      <Marker position={pinLocation} />
                      <Circle center={pinLocation} radius={radiusM} pathOptions={{ color: '#2b3a61', fillOpacity: 0.1 }} />
                    </>
                  )}
                </MapContainer>
              </div>
              {pinLocation && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--color-ink)' }}>
                    <span>Public geofence radius</span>
                    <span>{Math.round(radiusM)} m</span>
                  </div>
                  <input
                    type="range" min={PUBLIC_MIN_RADIUS_M} max={PUBLIC_MAX_RADIUS_M} step={50}
                    value={radiusM} onChange={(e) => setRadiusM(Number(e.target.value))}
                    style={{ width: '100%' }}
                  />
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
                Individually tracked animals need their own fence - pin above, or set it later from Edit.
              </div>
            </>
          )}

          <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', margin: '12px 0' }} />
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-ink)', marginBottom: 6 }}>
            Alert Zones (private, owner only)
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--color-ink)' }}>
              <span>🟢 Tier 1 — Free notification (max 1 km)</span>
              <span>{(tier1 / 1000).toFixed(2)} km</span>
            </div>
            <input
              type="range" min={100} max={ALERT_TIER1_MAX_M} step={100}
              value={tier1} onChange={(e) => handleTier1Change(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>

          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--color-ink)' }}>
              <span>🟡 Tier 2 — SMS alert 💰 (max 7 km)</span>
              <span>{(tier2 / 1000).toFixed(2)} km</span>
            </div>
            <input
              type="range" min={tier1} max={ALERT_TIER23_MAX_M} step={100}
              value={tier2} onChange={(e) => handleTier2Change(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>

          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--color-ink)' }}>
              <span>🔴 Tier 3 — Call alert 💰 (max 7 km)</span>
              <span>{(tier3 / 1000).toFixed(2)} km</span>
            </div>
            <input
              type="range" min={tier2} max={ALERT_TIER23_MAX_M} step={100}
              value={tier3} onChange={(e) => handleTier3Change(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>

          <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 6 }}>
            SMS/Call alerts need a paid provider connected later — for now they're logged the same as free notifications.
          </div>
        </div>

        {error && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>{error}</div>}

        <button
          type="submit"
          disabled={saving}
          style={{ padding: 14, borderRadius: 10, border: 'none', background: 'var(--color-gold)', color: 'var(--color-navy)', fontWeight: 700, fontSize: 15 }}
        >
          {saving ? 'Saving...' : 'Add Cattle'}
        </button>
      </form>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6 };
const inputStyle = { width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--color-border)', fontSize: 14, fontFamily: 'inherit', outline: 'none' };