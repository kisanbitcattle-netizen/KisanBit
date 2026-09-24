// src/components/AddServiceForm.jsx
//
// Add OR Edit a Service — an agri-services listing (drone spraying,
// tractor/harvester/equipment rent, farm labor, etc) pinned to a GPS
// point so buyers can find it on the map, same way Cattle Bases and
// Ponds are Profile-listed entities. Deliberately mirrors
// AddCattleBaseForm.jsx's structure (GPS pin, photo compress/upload,
// contact fields, edit-mode prefill) so this stays consistent with the
// rest of the app instead of introducing a fourth slightly-different
// pattern.
//
// NOTE ON SCHEMA: this assumes a new `services` table with columns
// matching the `fields` object built in handleSubmit below. If the
// real migration uses different column names, this file only needs
// the fields object + the two supabase.from('services') calls updated
// — the GPS/photo/compression logic itself doesn't depend on the names.
//
// EDIT MODE: pass `initialService` (a row from the `services` table)
// to pre-fill the form and switch Save into an UPDATE instead of an
// INSERT.

import { useRef, useState, useEffect } from 'react';
import { MapContainer, Marker, useMapEvents, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Geolocation } from '@capacitor/geolocation';
import { supabase } from '../../config/supabaseClient';
import { sanitizeText, sanitizeNumber, sanitizePhone } from '../../utils/sanitize';
import { parseWkbPoint } from '../../utils/geo';
import { reverseGeocode } from '../../utils/reverseGeocode';
import OfflineTileLayer from '../../components/OfflineTileLayer';

const DEFAULT_CENTER = [17.385, 78.4867];

// Service types confirmed with the user - shown as a dropdown, plus
// SERVICE_TYPE_EMOJI exported so ServiceMarker.jsx / ServiceDetailModal.jsx
// can reuse the exact same labels/icons instead of redefining them.
//
// Expanded beyond the original agri-only 6 (drone/tractor/harvester/
// equipment/labor/other) to cover general rural/village service
// providers too - electrician, plumber, mason, carpenter, welder,
// borewell drilling, veterinary, transport, painter, driver - since a
// farmer/village user just as often needs to find these as agri
// equipment, and there was no home for them before. 'other' stays last
// as the catch-all.
export const SERVICE_TYPES = [
  { key: 'drone', label: 'Drone Service', emoji: '🚁' },
  { key: 'tractor', label: 'Tractor Rent', emoji: '🚜' },
  { key: 'harvester', label: 'Harvester Rent', emoji: '🌾' },
  { key: 'equipment', label: 'Agri Equipment Rent', emoji: '🛠️' },
  { key: 'spraying', label: 'Pesticide / Fertilizer Spraying', emoji: '🧪' },
  { key: 'borewell', label: 'Borewell Drilling', emoji: '🕳️' },
  { key: 'veterinary', label: 'Veterinary Services', emoji: '🐮' },
  { key: 'labor', label: 'Human Resources / Labor', emoji: '👷' },
  { key: 'electrician', label: 'Electrician', emoji: '💡' },
  { key: 'plumber', label: 'Plumber', emoji: '🔧' },
  { key: 'mason', label: 'Mason / Construction', emoji: '🧱' },
  { key: 'carpenter', label: 'Carpenter', emoji: '🪚' },
  { key: 'welder', label: 'Welder / Fabrication', emoji: '🔩' },
  { key: 'painter', label: 'Painter', emoji: '🎨' },
  { key: 'transport', label: 'Transport / Logistics', emoji: '🚛' },
  { key: 'driver', label: 'Driver (Hire)', emoji: '🚗' },
  { key: 'other', label: 'Other', emoji: '🧰' },
];

const PRICE_UNITS = [
  { key: 'hour', label: 'per Hour' },
  { key: 'day', label: 'per Day' },
  { key: 'acre', label: 'per Acre' },
];

// Common India-market models per service type, offered as datalist
// suggestions (not a rigid dropdown) so autocomplete helps without
// blocking a model that isn't in this list - real-world brand/model
// combos are far too varied to hardcode exhaustively.
const MODEL_SUGGESTIONS = {
  drone: ['DJI Agras T30', 'DJI Agras T40', 'DJI Agras T20P', 'XAG P100', 'IoTechWorld Agribot'],
  tractor: [
    'Mahindra 265 DI', 'Mahindra Arjun 605', 'Swaraj 744 FE', 'John Deere 5310',
    'Sonalika DI 750 III', 'Massey Ferguson 241', 'Eicher 380',
  ],
  harvester: ['Mahindra Arjun Novo', 'John Deere W70', 'Preet 987', 'Kartar 4000'],
  equipment: ['Rotavator', 'Cultivator', 'Seed Drill', 'Sprayer Pump', 'Power Tiller'],
};

function generateUuidV4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Same aggressive compress-toward-target-KB pipeline already used for
// Cattle Base photos (AddCattleBaseForm.jsx), field crop photos
// (AddFieldForm.jsx), and the profile avatar (ProfileScreen.jsx).
async function compressImageToTargetKB(file, targetKB = 40, maxDimension = 480) {
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

function ClickToPin({ onPick }) {
  useMapEvents({
    click(e) {
      onPick([e.latlng.lat, e.latlng.lng]);
    },
  });
  return null;
}

// Same GPS-recenter-once-on-mount behavior as AddCattleBaseForm.jsx -
// only moves the map VIEW, never auto-sets the pin. Uses
// @capacitor/geolocation (not plain navigator.geolocation), which is the
// only reliable option inside the Capacitor WebView on Android.
function GeolocateOnMount({ skip }) {
  const map = useMap();
  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 })
      .then((pos) => {
        if (!cancelled) map.setView([pos.coords.latitude, pos.coords.longitude], 15);
      })
      .catch((err) => {
        console.warn('[AddServiceForm] GPS fix failed, using default center:', err.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip]);
  return null;
}

// Same best-effort location parser as AddCattleBaseForm.jsx - handles
// GeoJSON, (E)WKT text, and raw WKB hex (the shape PostgREST actually
// returns by default for a geography column).
function parseLocationToLatLng(loc) {
  if (!loc) return null;
  if (typeof loc === 'object' && loc.type === 'Point' && Array.isArray(loc.coordinates)) {
    const [lng, lat] = loc.coordinates;
    return [lat, lng];
  }
  if (typeof loc === 'string') {
    const match = loc.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/i);
    if (match) {
      const lng = parseFloat(match[1]);
      const lat = parseFloat(match[2]);
      if (!Number.isNaN(lng) && !Number.isNaN(lat)) return [lat, lng];
    }
    if (/^[0-9a-fA-F]+$/.test(loc)) {
      const parsed = parseWkbPoint(loc);
      if (parsed) return parsed;
    }
  }
  return null;
}

export default function AddServiceForm({ onClose, onSaved, initialService = null }) {
  const isEditing = !!initialService;

  const [serviceType, setServiceType] = useState(initialService?.service_type || 'drone');
  const [serviceName, setServiceName] = useState(initialService?.service_name || '');
  const [equipmentModel, setEquipmentModel] = useState(initialService?.equipment_model || '');
  const [description, setDescription] = useState(initialService?.description || '');
  const [priceAmount, setPriceAmount] = useState(initialService?.price_amount ?? '');
  const [priceUnit, setPriceUnit] = useState(initialService?.price_unit || 'day');
  const [contactPhone, setContactPhone] = useState(initialService?.contact_phone || '');
  const [contactWhatsapp, setContactWhatsapp] = useState(initialService?.contact_whatsapp || '');
  const [youtubeUrl, setYoutubeUrl] = useState(initialService?.youtube_url || '');
  const [instagramUrl, setInstagramUrl] = useState(initialService?.instagram_url || '');
  const [facebookUrl, setFacebookUrl] = useState(initialService?.facebook_url || '');
  const [showContactPublicly, setShowContactPublicly] = useState(initialService?.show_contact_publicly ?? false);
  const [isAvailable, setIsAvailable] = useState(initialService?.is_available ?? true);
  const [pinLocation, setPinLocation] = useState(() => parseLocationToLatLng(initialService?.location));

  // ASSUMPTION: services has a photo_url column, matching the existing
  // cattle_bases.photo_url / crops_marketplace.image_url naming pattern.
  const [photoUrl, setPhotoUrl] = useState(initialService?.photo_url || '');
  const [photoBlob, setPhotoBlob] = useState(null);
  const [photoError, setPhotoError] = useState(null);
  const [compressingPhoto, setCompressingPhoto] = useState(false);
  const photoFileInputRef = useRef(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const draftId = useState(generateUuidV4)[0];
  const locationUnreadable = isEditing && !!initialService?.location && !pinLocation;

  const handlePhotoSelect = async (file) => {
    if (!file) return;
    setPhotoError(null);
    setCompressingPhoto(true);
    try {
      const compressedBlob = await compressImageToTargetKB(file, 40, 480);
      if (!compressedBlob) {
        setPhotoError('Could not process that photo, please try another.');
        return;
      }
      setPhotoBlob(compressedBlob);
      setPhotoUrl(URL.createObjectURL(compressedBlob));
    } catch (err) {
      setPhotoError('Photo compression failed: ' + err.message);
    } finally {
      setCompressingPhoto(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!serviceName.trim()) {
      setError('Please enter a name for this Service.');
      return;
    }
    if (!pinLocation) {
      setError("Please tap the map to set this Service's location.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not logged in.');

      const serviceId = isEditing ? initialService.id : draftId;
      const placeName = await reverseGeocode(pinLocation[0], pinLocation[1]);

      let uploadedPhotoUrl = isEditing ? (initialService?.photo_url || null) : null;
      if (photoBlob) {
        const ext = photoBlob.type === 'image/webp' ? 'webp' : 'jpg';
        const path = `${serviceId}/photo-${Date.now()}.${ext}`;
        const { error: photoUploadError } = await supabase.storage
          .from('service-photos')
          .upload(path, photoBlob, { upsert: true, contentType: photoBlob.type });
        if (photoUploadError) throw photoUploadError;
        const { data: publicUrlData } = supabase.storage.from('service-photos').getPublicUrl(path);
        uploadedPhotoUrl = publicUrlData?.publicUrl || null;
      }

      const fields = {
        service_type: serviceType,
        service_name: sanitizeText(serviceName.trim()),
        equipment_model: equipmentModel.trim() ? sanitizeText(equipmentModel.trim()) : null,
        description: description.trim() ? sanitizeText(description.trim()) : null,
        price_amount: priceAmount === '' ? null : sanitizeNumber(priceAmount),
        price_unit: priceUnit,
        location: `SRID=4326;POINT(${pinLocation[1]} ${pinLocation[0]})`,
        place_name: placeName || (isEditing ? initialService?.place_name : null) || null,
        contact_phone: contactPhone.trim() ? sanitizePhone(contactPhone.trim()) : null,
        contact_whatsapp: contactWhatsapp.trim() ? sanitizePhone(contactWhatsapp.trim()) : null,
        youtube_url: youtubeUrl.trim() ? sanitizeText(youtubeUrl.trim()) : null,
        instagram_url: instagramUrl.trim() ? sanitizeText(instagramUrl.trim()) : null,
        facebook_url: facebookUrl.trim() ? sanitizeText(facebookUrl.trim()) : null,
        show_contact_publicly: showContactPublicly,
        is_available: isAvailable,
        photo_url: uploadedPhotoUrl,
      };

      if (isEditing) {
        const { error: updateError } = await supabase
          .from('services')
          .update(fields)
          .eq('id', serviceId);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabase
          .from('services')
          .insert({ id: serviceId, owner_id: user.id, ...fields });
        if (insertError) throw insertError;
      }

      // Pass the full row back so ProfileScreen's services cache stays
      // in sync with what's actually in the DB - same pattern as
      // AddCattleBaseForm's onSaved.
      onSaved({ id: serviceId, owner_id: user.id, ...fields });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="kb-card"
        style={{
          width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto',
          padding: 16, position: 'relative', display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: '50%',
            border: 'none', background: 'var(--color-border)', color: 'var(--color-ink)', fontWeight: 700,
            cursor: 'pointer', lineHeight: 1, zIndex: 1,
          }}
        >
          ✕
        </button>

        <div>
          <span className="display-text" style={{ fontSize: 18, color: 'var(--color-navy)' }}>
            {isEditing ? 'Edit Service' : 'Add Service'}
          </span>
        </div>

        {/* 1. Name */}
        <div>
          <label style={labelStyle}>Service Name</label>
          <input type="text" value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="e.g. DJI Agras Drone Spraying" style={inputStyle} />
        </div>

        {/* 2. Photo */}
        <div>
          <label style={labelStyle}>Service Photo (optional)</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
              <div
                style={{
                  width: '100%', height: '100%', borderRadius: 10, overflow: 'hidden',
                  background: 'var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <button
                  type="button"
                  onClick={() => photoFileInputRef.current?.click()}
                  style={{
                    all: 'unset', cursor: 'pointer', display: 'flex', width: '100%', height: '100%',
                    alignItems: 'center', justifyContent: 'center', fontSize: 22,
                  }}
                >
                  {photoUrl ? (
                    <img src={photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    SERVICE_TYPES.find((t) => t.key === serviceType)?.emoji || '🧰'
                  )}
                </button>
              </div>
              <div
                style={{
                  position: 'absolute', bottom: -4, right: -4, width: 20, height: 20, borderRadius: '50%',
                  background: 'var(--color-navy)', border: '2px solid var(--color-gold)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10,
                  pointerEvents: 'none',
                }}
              >
                {compressingPhoto ? '\u2026' : '\ud83d\udcf7'}
              </div>
              <input
                ref={photoFileInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  handlePhotoSelect(file);
                }}
                style={{ display: 'none' }}
              />
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', flex: 1 }}>
              Tap to add a photo (equipment, drone, vehicle). Shown to farmers browsing the map.
            </div>
          </div>
          {photoError && <div style={{ color: 'var(--color-danger)', fontSize: 12, marginTop: 4 }}>{photoError}</div>}
        </div>

        {/* 3. Basic details */}
        <div>
          <label style={labelStyle}>Service Type</label>
          <select value={serviceType} onChange={(e) => setServiceType(e.target.value)} style={inputStyle}>
            {SERVICE_TYPES.map((t) => (
              <option key={t.key} value={t.key}>{t.emoji} {t.label}</option>
            ))}
          </select>
        </div>

        {/* Model - only shown for equipment-style types (drone/tractor/
            harvester/generic equipment). A generic trade like plumber or
            electrician has no "model" concept, so this stays hidden for
            everything outside MODEL_SUGGESTIONS. Datalist, not a locked
            dropdown - suggests common models but accepts anything typed. */}
        {MODEL_SUGGESTIONS[serviceType] && (
          <div>
            <label style={labelStyle}>Model (optional)</label>
            <input
              type="text"
              list={`model-suggestions-${serviceType}`}
              value={equipmentModel}
              onChange={(e) => setEquipmentModel(e.target.value)}
              placeholder="e.g. DJI Agras T30"
              style={inputStyle}
            />
            <datalist id={`model-suggestions-${serviceType}`}>
              {MODEL_SUGGESTIONS[serviceType].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
        )}

        <div>
          <label style={labelStyle}>Description (optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this service covers, coverage area, equipment details, etc."
            rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 2 }}>
            <label style={labelStyle}>Price</label>
            <input type="number" min="0" value={priceAmount} onChange={(e) => setPriceAmount(e.target.value)} placeholder="e.g. 500" style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Unit</label>
            <select value={priceUnit} onChange={(e) => setPriceUnit(e.target.value)} style={inputStyle}>
              {PRICE_UNITS.map((u) => (
                <option key={u.key} value={u.key}>{u.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Contact Phone</label>
            <input type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="e.g. 9876543210" style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>WhatsApp (optional)</label>
            <input type="tel" value={contactWhatsapp} onChange={(e) => setContactWhatsapp(e.target.value)} placeholder="e.g. 9876543210" style={inputStyle} />
          </div>
        </div>

        {/* Consent gate - OFF by default. Only controls whether the Call
            Now / WhatsApp Us buttons appear on the public detail card.
            Social links are always shown when Available (verification,
            not private contact info) - unaffected by this toggle.
            Buyers can always reach the owner through Chat either way,
            and the owner can separately share their number per-buyer
            from inside a chat regardless of this setting. */}
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

        <button
          type="button"
          onClick={() => setIsAvailable((prev) => !prev)}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
            background: 'none', border: '1px solid var(--color-border)', borderRadius: 10, padding: 12,
            color: 'var(--color-navy)', fontSize: 14, cursor: 'pointer',
          }}
        >
          <span>{isAvailable ? '🟢 Available for booking' : '🔴 Not available right now'}</span>
          <span
            aria-hidden="true"
            style={{
              width: 40, height: 22, borderRadius: 11, position: 'relative',
              background: isAvailable ? 'var(--color-success, #2e8b57)' : 'var(--color-border)',
              border: '1px solid var(--color-border)', transition: 'background 0.15s', flexShrink: 0,
            }}
          >
            <span
              style={{
                position: 'absolute', top: 1, left: isAvailable ? 19 : 1,
                width: 18, height: 18, borderRadius: '50%', background: '#fff',
                transition: 'left 0.15s',
              }}
            />
          </span>
        </button>

        {/* 4. Map - single GPS pin, same GeolocateOnMount/ClickToPin
            logic as Add Cattle Base. No boundary drawing here - a
            service is a point on the map, not an area. */}
        <div>
          <label style={labelStyle}>Location {pinLocation ? '(pinned)' : '(tap map to pin)'}</label>
          {locationUnreadable && (
            <div style={{ fontSize: 11, color: 'var(--color-danger)', marginBottom: 6 }}>
              Couldn't load this Service's saved location - tap the map to set it again.
            </div>
          )}
          <div style={{ height: 300, minHeight: 300, flexShrink: 0, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--color-border)' }}>
            <MapContainer center={pinLocation || DEFAULT_CENTER} zoom={13} style={{ height: '100%', width: '100%', background: 'var(--color-bg)' }}>
              <OfflineTileLayer />
              <GeolocateOnMount skip={!!pinLocation} />
              <ClickToPin onPick={setPinLocation} />
              {pinLocation && <Marker position={pinLocation} />}
            </MapContainer>
          </div>
        </div>

        {/* 7. Social links */}
        <div>
          <label style={labelStyle}>YouTube Link (optional)</label>
          <input type="url" value={youtubeUrl} onChange={(e) => setYoutubeUrl(e.target.value)} placeholder="https://youtube.com/..." style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>Instagram Link (optional)</label>
          <input type="url" value={instagramUrl} onChange={(e) => setInstagramUrl(e.target.value)} placeholder="https://instagram.com/..." style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>Facebook Link (optional)</label>
          <input type="url" value={facebookUrl} onChange={(e) => setFacebookUrl(e.target.value)} placeholder="https://facebook.com/..." style={inputStyle} />
        </div>

        {error && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>{error}</div>}

        <button
          type="submit"
          disabled={saving}
          style={{ padding: 14, borderRadius: 10, border: 'none', background: 'var(--color-gold)', color: 'var(--color-navy)', fontWeight: 700, fontSize: 15 }}
        >
          {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Service'}
        </button>
      </form>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6 };
const inputStyle = { width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--color-border)', fontSize: 14, fontFamily: 'inherit', outline: 'none', background: 'var(--color-card)', color: 'var(--color-ink)' };