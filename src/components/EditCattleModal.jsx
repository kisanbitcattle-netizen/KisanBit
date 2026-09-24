// src/components/EditCattleModal.jsx
//
// Edit ALL fields collectable on AddCattleForm (type, base link, breed,
// govt ID, collar ID, hardware tag, birth date, calving count, weight,
// gender/milking/pregnancy/AI-date, contact phone/whatsapp, QC certificate,
// photo, home-location pin), plus append new health records
// (vaccination/checkup/treatment/other) - health records are append-only
// history (cattle_health_records), not editable fields on the cattle row
// itself, per schema_addendum_cattle_history.sql. Past records are not
// fetched/edited here, only new ones appended - matches that constraint.
//
// Kept as its own component (not merged into AddCattleForm) per explicit
// call this session - deliberately duplicates some of AddCattleForm's
// patterns (photo compress+upload, map pin, vaccine multi-entry, gestation
// suggestion) rather than sharing code, so keep both in sync by hand if
// either changes.

import { useState, useEffect, useRef } from 'react';
import { MapContainer, Circle, Marker, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Geolocation } from '@capacitor/geolocation';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { supabase } from '../config/supabaseClient';
import OfflineTileLayer from './OfflineTileLayer';
import { ANIMAL_TAXONOMY, ANIMAL_TYPES, ANIMAL_GROUPS, breedsFor, producesMilk } from '../utils/animalTaxonomy';
import { compressImageToTargetKB, uploadCompressedAsset } from '../utils/imageUpload';
import { sanitizeText, sanitizePhone, sanitizeNumber, sanitizeEnum } from '../utils/sanitize';
import { parseWkbPoint } from '../utils/geo';
import { reverseGeocode } from '../utils/reverseGeocode';

const RECORD_TYPES = ['vaccination', 'checkup', 'treatment', 'other'];
const GENDERS = ['male', 'female'];
const PREGNANCY_STATUSES = ['pregnant', 'not_pregnant', 'dry'];
const DEFAULT_RADIUS_M = 1000;
// Zone constants mirrored from GeofenceSetupModal.jsx - Zones setup now
// lives directly in this form instead of a separate "Zones" button, so
// these limits (and the nesting rule below) need to match exactly.
const PUBLIC_MIN_RADIUS_M = 100;
const PUBLIC_MAX_RADIUS_M = 1000;
const ALERT_TIER1_MAX_M = 1000;
const ALERT_TIER23_MAX_M = 7000;
// Average gestation length by species, used to suggest an expected calving
// date once an AI date is entered. 'other' has no reliable default - left
// blank for manual entry. Kept identical to AddCattleForm's table.
const GESTATION_DAYS = { cow: 283, buffalo: 310, goat: 150, sheep: 152, pig: 114, dog: 63, camel: 390, horse: 340 };

const labelStyle = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-navy)',
  marginTop: 12,
  marginBottom: 4,
};

const inputStyle = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--color-border)',
  fontSize: 14,
  boxSizing: 'border-box',
};

// Parse cattle.geofence_center for prefilling the edit-mode map pin.
// Confirmed this session: geofence_center is a plain PostGIS column,
// returned by PostgREST as raw WKB hex (no GeoJSON-computed equivalent
// exists for cattle, unlike fields.boundary_geojson) - so this is always
// a WKB hex string on a real fetched row. Delegates to the shared,
// SRID-aware parseWkbPoint() (utils/geo.js) instead of re-implementing
// that decode a third time here - this file previously had its own
// non-SRID-aware copy, same bug class as the one found and fixed in
// FullMapModal.jsx/MapPreviewCard.jsx.
// (Previously also handled a GeoJSON-object/string shape defensively -
// removed as confirmed-dead code once the schema fact above was nailed
// down; re-add if a caller ever starts passing a pre-parsed GeoJSON value.)
function parseGeofenceCenter(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return parseWkbPoint(raw.trim());
  } catch {
    return null;
  }
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
// MapContainer's `center` prop only applies once at initial mount. Same
// pattern as AddCattleForm.jsx's RecenterOnGps. Skips recentering once a
// pin already exists (either the animal's existing location, or one the
// farmer just tapped) - a late-arriving GPS fix shouldn't override either.
function RecenterOnGps({ position, skip }) {
  const map = useMap();
  useEffect(() => {
    if (position && !skip) map.setView(position, map.getZoom());
  }, [position, skip, map]);
  return null;
}

let vaccineIdCounter = 0;

// Finds which ANIMAL_GROUPS bucket a given animal type belongs to, so the
// accordion type-picker below can auto-open the right group instead of
// starting on none of them. Falls back to the first group if the type
// somehow isn't in any bucket. Kept identical to AddCattleForm's copy.
function groupForType(type) {
  for (const [groupName, typesInGroup] of Object.entries(ANIMAL_GROUPS)) {
    if (typesInGroup.includes(type)) return groupName;
  }
  return Object.keys(ANIMAL_GROUPS)[0];
}

export default function EditCattleModal({ cattle, onSaved, onCancel }) {
  const [name, setName] = useState('');
  const [animalType, setAnimalType] = useState('cow');
  // Accordion state for the Type picker below - same idea as
  // AddCattleForm's, but starts collapsed here since Edit always opens on
  // a real existing animal, not a blank default. The cattle-sync effect
  // below resets both whenever a different animal is loaded into this
  // modal.
  const [typeExpanded, setTypeExpanded] = useState(false);
  const [openGroup, setOpenGroup] = useState(() => groupForType('cow'));
  const [customAnimalType, setCustomAnimalType] = useState('');
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
  // Same consent gate as AddServiceForm.jsx/AddCattleForm.jsx - off by
  // default. Only controls whether Call/WhatsApp buttons appear on the
  // public cattle detail card; buyers can always reach the owner through
  // Chat either way.
  const [showContactPublicly, setShowContactPublicly] = useState(false);

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

  const [photoFile, setPhotoFile] = useState(null);
  const [localImageUri, setLocalImageUri] = useState(null); // preview of a NEWLY picked photo only
  const [existingPhotoUrl, setExistingPhotoUrl] = useState(null); // current saved photo, shown until replaced
  const photoInputRef = useRef(null);

  const [qcCertFile, setQcCertFile] = useState(null);
  const [qcCertPreviewUrl, setQcCertPreviewUrl] = useState(null);
  const [existingQcCertUrl, setExistingQcCertUrl] = useState(null);
  const qcFileInputRef = useRef(null);

  const [pinLocation, setPinLocation] = useState(null);
  // Zones setup (public geofence radius + 3 private alert tiers) now lives
  // directly in this form instead of a separate "Zones" button
  // (GeofenceSetupModal). radiusM below is an explicit, always-visible
  // slider, so it's now the single source of truth for geofence_radius_m
  // on every save - the old "only touch radius on a genuinely new pin"
  // guard doesn't apply anymore, since the farmer can now see and adjust
  // the current radius every time they open Edit, not just once.
  // pinTouched is kept, but narrowed to a single job: avoid firing an
  // unnecessary reverse-geocode call when the pin itself wasn't re-clicked
  // this session (see handleSave).
  const [pinTouched, setPinTouched] = useState(false);
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

  // One-time GPS fix on open, matching AddCattleForm.jsx - only actually
  // matters for an animal with no existing pin, since RecenterOnGps skips
  // once a pin already exists. Harmless to fetch unconditionally either way.
  const [gpsCenter, setGpsCenter] = useState(null);
  useEffect(() => {
    let cancelled = false;
    Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 })
      .then((pos) => {
        if (!cancelled) setGpsCenter([pos.coords.latitude, pos.coords.longitude]);
      })
      .catch((err) => {
        console.warn('[EditCattleModal] GPS fix failed, using default center:', err.message);
      });
    return () => { cancelled = true; };
  }, []);

  const [vaccineEntries, setVaccineEntries] = useState([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Load this owner's Cattle Bases, same as AddCattleForm - lets an
  // existing animal be (re)linked to a Base, or unlinked back to its own
  // geofence_center by selecting "No base".
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

  // Sync state when cattle prop changes
  useEffect(() => {
    if (!cattle) return;

    setName(cattle.name || '');
    setAnimalType(cattle.animal_type || 'cow');
    setCustomAnimalType(cattle.animal_type_custom_label || '');
    // Collapsed summary chip on load, opened on the loaded animal's own
    // group - a farmer editing an existing animal shouldn't have to wade
    // through all 7 groups again just to see what's already selected.
    setTypeExpanded(false);
    setOpenGroup(groupForType(cattle.animal_type || 'cow'));

    const isKnownBreed = cattle.breed && breedsFor(cattle.animal_type || 'cow').includes(cattle.breed);
    setBreed(isKnownBreed ? cattle.breed : (cattle.breed ? 'Other' : ''));
    setCustomBreed(cattle.breed && !isKnownBreed ? cattle.breed : '');

    setGovtInaphId(cattle.govt_inaph_id || '');
    setCollarId(cattle.collar_id || '');
    setTagDeveui(cattle.tag_deveui || '');
    setManualTagEntry(false);
    setBirthDate(cattle.birth_date || '');
    setCalvingCount(cattle.calving_count ?? 0);
    setWeightKg(cattle.weight_kg ?? '');
    setContactPhone(cattle.contact_phone || '');
    setContactWhatsapp(cattle.contact_whatsapp || '');
    setShowContactPublicly((cattle.show_contact_publicly ?? cattle.showContactPublicly) || false);

    setBaseId(cattle.base_id ?? cattle.baseId ?? '');
    setGender(cattle.gender || '');
    setIsMilking(!!cattle.is_milking);
    setDailyMilkYield(cattle.daily_milk_yield_liters ?? '');
    setPregnancyStatus(cattle.pregnancy_status || '');
    setAiDate(cattle.ai_date || '');
    setExpectedCalvingDate(cattle.expected_calving_date || '');
    // If a calving date already exists, treat it as user-set so the
    // gestation-suggestion effect below doesn't immediately overwrite it
    // on load. Only future edits to ai_date should re-trigger a suggestion.
    setCalvingDateEdited(!!cattle.expected_calving_date);

    setExistingPhotoUrl(cattle.local_image_path || cattle.marketplace_photo_url || null);
    setPhotoFile(null);
    setLocalImageUri((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    if (photoInputRef.current) photoInputRef.current.value = '';

    setExistingQcCertUrl(cattle.qc_certificate_url || null);
    setQcCertFile(null);
    setQcCertPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    if (qcFileInputRef.current) qcFileInputRef.current.value = '';

    const initialPin = parseGeofenceCenter(cattle.geofence_center);
    setPinLocation(initialPin);
    setPinTouched(false);

    // Zone sliders - tolerate either snake_case (raw DB row) or camelCase
    // (a caller that already mapped it), same pattern CattleCard.jsx uses
    // for every other field on this object.
    const initialRadius = cattle.geofence_radius_m ?? cattle.geofenceRadiusM;
    setRadiusM(
      Math.min(Math.max(initialRadius || DEFAULT_RADIUS_M, PUBLIC_MIN_RADIUS_M), PUBLIC_MAX_RADIUS_M)
    );
    const initialTier1 = cattle.alert_radius_1_m ?? cattle.alertRadius1M;
    const initialTier2 = cattle.alert_radius_2_m ?? cattle.alertRadius2M;
    const initialTier3 = cattle.alert_radius_3_m ?? cattle.alertRadius3M;
    setTier1(Math.min(initialTier1 || 1000, ALERT_TIER1_MAX_M));
    setTier2(Math.min(initialTier2 || 2000, ALERT_TIER23_MAX_M));
    setTier3(Math.min(initialTier3 || 5000, ALERT_TIER23_MAX_M));

    setVaccineEntries([]);
    setError(null);
  }, [cattle]);

  // Cleanup object URLs on unmount or change to prevent memory leaks
  useEffect(() => {
    return () => {
      if (qcCertPreviewUrl) URL.revokeObjectURL(qcCertPreviewUrl);
    };
  }, [qcCertPreviewUrl]);
  useEffect(() => {
    return () => {
      if (localImageUri) URL.revokeObjectURL(localImageUri);
    };
  }, [localImageUri]);

  // Suggest an expected calving date from ai_date + species gestation
  // length, same behavior as AddCattleForm - only while the user hasn't
  // manually edited the field.
  useEffect(() => {
    if (calvingDateEdited) return;
    if (!aiDate) { setExpectedCalvingDate(''); return; }
    const days = GESTATION_DAYS[animalType];
    if (!days) return;
    const d = new Date(aiDate);
    d.setDate(d.getDate() + days);
    setExpectedCalvingDate(d.toISOString().slice(0, 10));
  }, [aiDate, animalType, calvingDateEdited]);

  const handlePhotoSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    const reader = new FileReader();
    reader.onload = () => setLocalImageUri(reader.result);
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

    if (qcCertPreviewUrl) URL.revokeObjectURL(qcCertPreviewUrl);

    setQcCertFile(file);
    setQcCertPreviewUrl(URL.createObjectURL(file));
    setError(null);
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
      // TEMP debug aid - log the real error so we know if this is a
      // permission denial, a missing ML Kit module, or something else,
      // instead of only ever showing the generic fallback. Remove once
      // the GoTag scan issue is confirmed fixed.
      console.error('BarcodeScanner failed:', err);
      setError('Scan failed - please type it manually below.');
      setManualTagEntry(true);
    } finally {
      setScanning(false);
    }
  };

  // FIX: picking a Base didn't clear the individual pinLocation that got
  // pre-filled from the animal's old geofence_center on load (line ~203
  // above). handleSave then had no baseId guard, so it kept writing that
  // stale point into geofence_center on every save right alongside the
  // new base_id - and geofence_center always wins over base_id downstream,
  // so the animal silently never actually followed the Base. Clearing
  // pinLocation here, plus the baseId guard in handleSave below, are both
  // needed - either alone isn't enough.
  useEffect(() => {
    if (baseId) setPinLocation(null);
  }, [baseId]);

  const addVaccineEntry = () => {
    vaccineIdCounter += 1;
    setVaccineEntries((prev) => [
      ...prev,
      {
        key: vaccineIdCounter,
        type: 'vaccination',
        desc: '',
        notes: '',
        date: new Date().toISOString().slice(0, 10),
      },
    ]);
  };
  const updateVaccineEntry = (key, field, value) => {
    setVaccineEntries((prev) => prev.map((v) => (v.key === key ? { ...v, [field]: value } : v)));
  };
  const removeVaccineEntry = (key) => {
    setVaccineEntries((prev) => prev.filter((v) => v.key !== key));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Name pettandi.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const finalBreed = breed === 'Other' ? customBreed.trim() : breed;

      const updateData = {
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
      };

      // Alert zones are private, per-animal, and apply regardless of
      // whether this animal is linked to a Base - matches
      // GeofenceSetupModal's own handleSave, which always wrote these
      // three even for a base-linked animal. Always written now that
      // Zones setup lives directly in this form.
      updateData.alert_radius_1_m = Math.round(tier1);
      updateData.alert_radius_2_m = Math.round(tier2);
      updateData.alert_radius_3_m = Math.round(tier3);

      // base_id must win cleanly. If a base is linked, explicitly null out
      // geofence_center/geofence_radius_m so no stale individual point can
      // override the base downstream (see pinLocation-clearing effect
      // above for why pinLocation could still be stale otherwise).
      if (baseId) {
        updateData.geofence_center = null;
        updateData.geofence_radius_m = null;
      } else if (pinLocation) {
        // radiusM is now an explicit, always-visible slider (not an
        // implicit default), so it's the single source of truth for
        // geofence_radius_m on every save - unlike the old guarded
        // behavior, there's no longer a separate "Zones" screen whose
        // tuning this could accidentally stomp.
        updateData.geofence_center = `SRID=4326;POINT(${pinLocation[1]} ${pinLocation[0]})`;
        updateData.geofence_radius_m = Math.round(radiusM);
        // Only re-run reverse geocode if the pin was actually re-clicked
        // this session - avoids an unnecessary API call (and a pointless
        // place_name overwrite) on saves that don't touch the map at all.
        if (pinTouched) {
          updateData.place_name = await reverseGeocode(pinLocation[0], pinLocation[1]);
        }
      } else {
        // No base and no pin at all - this animal genuinely has no
        // individual location on record.
        updateData.geofence_center = null;
        updateData.geofence_radius_m = null;
      }

      if (photoFile) {
        const compressedPhoto = await compressImageToTargetKB(photoFile, 40, 640);
        if (compressedPhoto) {
          updateData.local_image_path = await uploadCompressedAsset(compressedPhoto, 'cattle-photos', cattle.id);
        }
      }

      if (qcCertFile) {
        // Always an image now (PDF rejected at selection time above), so
        // this always goes through compression - target 60KB, comfortably
        // under the 100KB ceiling.
        const compressedCert = await compressImageToTargetKB(qcCertFile, 60, 900);
        if (compressedCert) {
          updateData.qc_certificate_url = await uploadCompressedAsset(compressedCert, 'qc-certificates', `${cattle.id}-qc`);
        }
      }

      // FIX: this update previously never set updated_at. CattleInfoPanel's
      // list cache is stale-while-revalidate, refetching only rows whose
      // updated_at is newer than the last sync (see its loadAll comment) -
      // if the cattle table has no trigger auto-bumping updated_at on a
      // plain UPDATE, a save from here could complete fine in the DB but
      // never qualify for the next delta fetch. The visible symptom:
      // govt_inaph_id (and any other field) saves correctly, but reopening
      // Edit on the same animal still shows the OLD (often blank)
      // cattle prop from the stale cached list - so retyping the same ID
      // and saving again hits govt_inaph_id's uniqueness check as a
      // "duplicate" of the row's own already-saved value. Same root cause
      // and same fix CattleInfoPanel.jsx's handleToggleListing already
      // applies to its own patch.
      updateData.updated_at = new Date().toISOString();

      const { error: updateError } = await supabase
        .from('cattle')
        .update(updateData)
        .eq('id', cattle.id);

      if (updateError) throw updateError;

      const records = vaccineEntries
        .filter((v) => v.desc.trim())
        .map((v) => ({
          cattle_id: cattle.id,
          record_type: sanitizeEnum(v.type, RECORD_TYPES),
          description: sanitizeText(v.desc.trim()),
          notes: v.notes.trim() ? sanitizeText(v.notes.trim()) : null,
          recorded_date: v.date,
        }));
      if (records.length > 0) {
        const { error: recordError } = await supabase.from('cattle_health_records').insert(records);
        if (recordError) throw recordError;
      }

      onSaved?.();
    } catch (err) {
      setError(err.message || 'Save avvaledu.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 5000,
        background: 'rgba(0,0,0,0.5)',
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
        style={{
          padding: 20,
          maxWidth: 380,
          width: '100%',
          maxHeight: '85vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-navy)' }}>Edit Cattle</div>

        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
          <input ref={photoInputRef} type="file" accept="image/*" capture="environment" onChange={handlePhotoSelect} style={{ display: 'none' }} />
          <button
            type="button"
            onClick={() => photoInputRef.current?.click()}
            style={{
              width: 96, height: 96, borderRadius: 20, border: '2px dashed var(--color-border)',
              background: 'var(--color-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: (localImageUri || existingPhotoUrl) ? 0 : 13, overflow: 'hidden', color: 'var(--color-muted)',
            }}
          >
            {localImageUri ? (
              <img src={localImageUri} alt="cattle" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : existingPhotoUrl ? (
              <img src={existingPhotoUrl} alt="cattle" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : ('Add Photo')}
          </button>
        </div>
        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
          Tap to {existingPhotoUrl || localImageUri ? 'replace' : 'add'} photo
        </div>

        <label style={labelStyle}>Type</label>
        {!typeExpanded ? (
          <button
            type="button"
            onClick={() => setTypeExpanded(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: 8, borderRadius: 8, border: '2px solid var(--color-gold)',
              background: 'rgba(222, 160, 59, 0.12)', textAlign: 'left', cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: 20 }}>{ANIMAL_TAXONOMY[animalType]?.emoji}</span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--color-ink)', textTransform: 'capitalize' }}>
              {animalType === 'other' && customAnimalType.trim() ? customAnimalType : (ANIMAL_TAXONOMY[animalType]?.label || animalType)}
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-navy)', fontWeight: 700, textDecoration: 'underline' }}>Change</span>
          </button>
        ) : (
          Object.entries(ANIMAL_GROUPS).map(([groupName, typesInGroup]) => {
            const isOpenGroup = openGroup === groupName;
            return (
              <div key={groupName} style={{ marginBottom: 6, border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden' }}>
                <button
                  type="button"
                  onClick={() => setOpenGroup(isOpenGroup ? null : groupName)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                    padding: '6px 8px', border: 'none', background: isOpenGroup ? 'var(--color-bg)' : 'var(--color-card)',
                    fontSize: 10, fontWeight: 700, color: 'var(--color-muted)', textAlign: 'left', cursor: 'pointer',
                  }}
                >
                  <span>{groupName}</span>
                  <span>{isOpenGroup ? '▲' : '▼'}</span>
                </button>
                {isOpenGroup && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: 6 }}>
                    {typesInGroup.map((type) => (
                      <button
                        type="button"
                        key={type}
                        onClick={() => {
                          setAnimalType(type);
                          // Breed lists are per animal type - a breed picked
                          // under the old type wouldn't exist in the new
                          // type's list, so clear it rather than silently
                          // save a mismatched breed string. Matches
                          // AddCattleForm's same guard on creation.
                          setBreed('');
                          setCustomBreed('');
                          // Collapse back to the summary chip once a pick
                          // is made, so the picker doesn't keep eating
                          // vertical space after the farmer is done with it.
                          setTypeExpanded(false);
                        }}
                        style={{
                          flex: '1 1 18%',
                          minWidth: 56,
                          padding: 8,
                          borderRadius: 8,
                          border: `2px solid ${animalType === type ? 'var(--color-gold)' : 'var(--color-border)'}`,
                          background: animalType === type ? 'rgba(222, 160, 59, 0.18)' : 'var(--color-card)',
                          fontSize: 18,
                          cursor: 'pointer',
                        }}
                      >
                        {ANIMAL_TAXONOMY[type]?.emoji}
                        <div style={{ fontSize: 10, marginTop: 2, textTransform: 'capitalize', color: 'var(--color-ink)' }}>
                          {ANIMAL_TAXONOMY[type]?.label || type}
                        </div>
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
            value={customAnimalType}
            onChange={(e) => setCustomAnimalType(e.target.value)}
            placeholder="Janthu peru type cheyandi"
            style={{ ...inputStyle, marginTop: 6 }}
          />
        )}

        <label style={labelStyle}>Cattle Base (optional)</label>
        <select value={baseId} onChange={(e) => setBaseId(e.target.value)} style={inputStyle} disabled={basesLoading}>
          <option value="">{basesLoading ? 'Loading...' : 'No base - track individually'}</option>
          {bases.map((b) => <option key={b.id} value={b.id}>{b.base_name}</option>)}
        </select>
        {!basesLoading && bases.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
            You don't have any Cattle Bases yet - this animal will keep using its own location below.
          </div>
        )}

        <label style={labelStyle}>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />

        <label style={labelStyle}>Breed</label>
        <select value={breed} onChange={(e) => setBreed(e.target.value)} style={inputStyle}>
          <option value="">Select breed</option>
          {breedsFor(animalType).map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>

        {breed === 'Other' && (
          <input
            value={customBreed}
            onChange={(e) => setCustomBreed(e.target.value)}
            placeholder="Breed peru type cheyandi"
            style={{ ...inputStyle, marginTop: 6 }}
          />
        )}

        <label style={labelStyle}>Govt INAPH ID</label>
        <input
          value={govtInaphId}
          onChange={(e) => setGovtInaphId(e.target.value)}
          placeholder="12-digit INAPH ID"
          style={inputStyle}
        />

        <label style={labelStyle}>Birth Date</label>
        <input
          type="date"
          value={birthDate}
          onChange={(e) => setBirthDate(e.target.value)}
          max={new Date().toISOString().split('T')[0]}
          style={inputStyle}
        />

        <label style={labelStyle}>Calving Count</label>
        <input
          type="number"
          min="0"
          value={calvingCount}
          onChange={(e) => setCalvingCount(e.target.value)}
          style={inputStyle}
        />

        <label style={labelStyle}>Weight (kg)</label>
        <input
          type="number"
          min="0"
          step="0.1"
          value={weightKg}
          onChange={(e) => setWeightKg(e.target.value)}
          placeholder="e.g. 350"
          style={inputStyle}
        />

        <label style={labelStyle}>Gender (optional)</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {GENDERS.map((g) => (
            <button
              type="button"
              key={g}
              onClick={() => setGender((prev) => (prev === g ? '' : g))}
              style={{
                flex: 1, padding: 10, borderRadius: 8, textTransform: 'capitalize',
                border: `2px solid ${gender === g ? 'var(--color-gold)' : 'var(--color-border)'}`,
                background: gender === g ? 'rgba(222, 160, 59, 0.18)' : 'var(--color-card)',
                fontSize: 13, fontWeight: 600, color: 'var(--color-ink)', cursor: 'pointer',
              }}
            >
              {g}
            </button>
          ))}
        </div>

        {gender === 'female' && (
          <>
            {producesMilk(animalType) && (
              <>
                <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={isMilking} onChange={(e) => setIsMilking(e.target.checked)} style={{ width: 16, height: 16 }} />
                  Currently milking
                </label>
                {isMilking && (
                  <input
                    type="number" min="0" step="0.1"
                    value={dailyMilkYield}
                    onChange={(e) => setDailyMilkYield(e.target.value)}
                    placeholder="Daily milk yield (liters)"
                    style={{ ...inputStyle, marginTop: 6 }}
                  />
                )}
              </>
            )}

            <label style={labelStyle}>Pregnancy Status (optional)</label>
            <select value={pregnancyStatus} onChange={(e) => setPregnancyStatus(e.target.value)} style={inputStyle}>
              <option value="">Select status</option>
              <option value="pregnant">Pregnant</option>
              <option value="not_pregnant">Not Pregnant</option>
              <option value="dry">Dry</option>
            </select>

            {pregnancyStatus === 'pregnant' && (
              <>
                <label style={labelStyle}>AI / Breeding Date (optional)</label>
                <input
                  type="date" value={aiDate}
                  onChange={(e) => { setAiDate(e.target.value); setCalvingDateEdited(false); }}
                  max={new Date().toISOString().split('T')[0]}
                  style={inputStyle}
                />

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
              </>
            )}
          </>
        )}

        <label style={labelStyle}>Collar ID (mee own serial number)</label>
        <input
          value={collarId}
          onChange={(e) => setCollarId(e.target.value)}
          placeholder="e.g. A-12"
          style={inputStyle}
        />

        <label style={labelStyle}>GoTag Hardware ID</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
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
            style={{ padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--color-navy)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
          >
            {scanning ? '...' : '📷 Scan'}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setManualTagEntry((v) => !v)}
          style={{ fontSize: 11, color: 'var(--color-muted)', background: 'none', border: 'none', textDecoration: 'underline', padding: 0, marginTop: 4, cursor: 'pointer' }}
        >
          {manualTagEntry ? 'Back to scan' : "If scan doesn't work, type it manually here"}
        </button>

        <label style={labelStyle}>Contact Phone &amp; WhatsApp</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 4 }}>Phone</div>
            <input
              type="tel"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="e.g. 9876543210"
              style={inputStyle}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 4 }}>WhatsApp (blank = phone)</div>
            <input
              type="tel"
              value={contactWhatsapp}
              onChange={(e) => setContactWhatsapp(e.target.value)}
              placeholder="e.g. 9876543210"
              style={inputStyle}
            />
          </div>
        </div>

        {/* Consent gate - OFF by default. Only controls whether the Call
            Now / WhatsApp Us buttons appear on the public cattle detail
            card. Buyers can always reach the owner through Chat either
            way. Same pattern as AddServiceForm.jsx/AddCattleForm.jsx -
            keep all three in sync if any changes. */}
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

        <label style={labelStyle}>QC Certificate</label>
        {existingQcCertUrl && !qcCertFile && (
          <a
            href={existingQcCertUrl}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 12, color: 'var(--color-success)', display: 'inline-block', marginBottom: 6 }}
          >
            ✓ Current certificate (view) — choose a new photo below to replace it
          </a>
        )}
        {/* Hidden native input, triggered by our own themed button below -
            same pattern as the cattle photo picker. The previous
            ::file-selector-button CSS approach only follows dark mode on
            engines that support that pseudo-element - Capacitor's Android
            WebView is inconsistent about it, which is why the button
            still looked broken there even with the override in place.
            This sidesteps native chrome entirely instead of fighting it. */}
        <input
          ref={qcFileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleQcCertSelect}
          style={{ display: 'none' }}
        />
        <button
          type="button"
          onClick={() => qcFileInputRef.current?.click()}
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
            {qcCertFile ? qcCertFile.name : existingQcCertUrl ? 'Retake certificate photo' : 'Take certificate photo (camera)'}
          </span>
          {(qcCertFile || existingQcCertUrl) && (
            <span style={{ fontSize: 12, color: 'var(--color-navy)', fontWeight: 700, textDecoration: 'underline' }}>Change</span>
          )}
        </button>

        <label style={labelStyle}>Geofence &amp; Alert Zones</label>
        {baseId ? (
          <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: '10px 0' }}>
            🌐 This animal's public geofence follows its Cattle Base's location and radius. Unlink the base above to set an individual location. The alert zones below still apply to this animal individually.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--color-ink)', margin: '4px 0' }}>
              🌐 Public geofence (buyers see this circle) {pinLocation ? '(pinned)' : '- tap map to pin, optional'}
            </div>
            <div style={{ height: 180, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--color-border)', background: 'var(--color-bg)' }}>
              <MapContainer center={pinLocation || gpsCenter || [17.385, 78.4867]} zoom={13} style={{ height: '100%', width: '100%', background: 'var(--color-bg)' }}>
                <OfflineTileLayer maxZoom={16} keepBuffer={1} detectRetina={false} />
                <ClickToPin onPick={(pos) => { setPinLocation(pos); setPinTouched(true); }} />
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

        <label style={labelStyle}>Vaccine / Health Records</label>
        {vaccineEntries.map((v) => (
          <div key={v.key} className="kb-card" style={{ padding: 10, marginBottom: 8 }}>
            <select
              value={v.type}
              onChange={(e) => updateVaccineEntry(v.key, 'type', e.target.value)}
              style={{ ...inputStyle, marginBottom: 6 }}
            >
              {RECORD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <input
              placeholder="e.g. FMD vaccine given"
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
              style={{ fontSize: 11, color: 'var(--color-danger)', background: 'none', border: 'none', marginTop: 4, padding: 0, cursor: 'pointer' }}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addVaccineEntry}
          style={{ padding: '8px 12px', borderRadius: 8, border: '2px dashed var(--color-gold)', background: 'transparent', color: 'var(--color-ink)', fontSize: 13, fontWeight: 700, width: '100%', cursor: 'pointer' }}
        >
          + add vaccine / health record
        </button>

        {error && (
          <div style={{ color: 'var(--color-danger)', fontSize: 13, marginTop: 10 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              flex: 1,
              padding: '10px 0',
              borderRadius: 8,
              border: 'none',
              background: 'var(--color-navy)',
              color: '#fff',
              fontWeight: 700,
              cursor: 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={onCancel}
            disabled={saving}
            style={{
              padding: '10px 16px',
              borderRadius: 8,
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg)',
              color: 'var(--color-ink)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}