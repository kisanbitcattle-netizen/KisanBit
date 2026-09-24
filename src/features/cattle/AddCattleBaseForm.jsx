// src/components/AddCattleBaseForm.jsx

import { useRef, useState, useEffect } from 'react';
import { MapContainer, Circle, Marker, useMapEvents, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Geolocation } from '@capacitor/geolocation';
import { supabase } from '../../config/supabaseClient';
import { sanitizeText, sanitizeNumber, sanitizePhone } from '../../utils/sanitize';
import { parseWkbPoint } from '../../utils/geo';
import { reverseGeocode } from '../../utils/reverseGeocode';
import OfflineTileLayer from '../map/OfflineTileLayer';

const DEFAULT_CENTER = [17.385, 78.4867];
const DEFAULT_GEOFENCE_RADIUS_M = 500;
const DEFAULT_PUBLIC_FUZZ_M = 200;

function generateUuidV4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Same aggressive compress-toward-target-KB pipeline already used for
// field crop photos (AddFieldForm.jsx) and the profile avatar
// (ProfileScreen.jsx) - keeps a Base's photo consistent with those in
// size/behavior on slow rural connections instead of introducing a
// third, differently-tuned copy of this logic.
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

// FIX: pans the map to `target` only when it changes - used by the new
// "Use My Current Location" button below, kept deliberately separate
// from GeolocateOnMount. GeolocateOnMount only auto-centers ONCE and
// only when there's no pin yet (skip={!!pinLocation}) - so in edit mode,
// where a Base already has a (possibly wrong) saved pin, the map opens
// centered on THAT old pin and never recenters to the farmer's real
// position. Root cause of "I tapped the correct spot twice and it's
// still ~1km off": the farmer was confined to nudging around the old
// wrong center on a rural OSM tile with few landmarks to visually judge
// distance by, never actually seeing/reaching their true GPS position
// on the map. This component lets the button snap the view there
// on demand, at any time, in both add and edit mode.
function RecenterOnDemand({ target }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.setView(target, 16);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return null;
}

// Recenters the map on the device's actual GPS position, once, ONLY when
// there's no pin yet (new Base, or an existing Base whose saved location
// couldn't be parsed - see locationUnreadable below). Previously this map
// always opened on the hardcoded DEFAULT_CENTER (Hyderabad) regardless of
// where the farmer actually was - confirmed by user: physically in
// Tiruvuru, map opened on Hyderabad. This only moves the VIEW; it
// deliberately does NOT auto-set pinLocation - the farmer still has to
// tap to confirm the Base's actual spot, same as before.
// NOTE: MapContainer's `center` prop only applies at initial mount in
// react-leaflet, so recentering an already-mounted map after an async
// geolocation callback requires calling the map instance directly via
// useMap(), not just changing a prop.
//
// SWITCHED to @capacitor/geolocation instead of plain
// navigator.geolocation - the latter is unreliable inside a Capacitor
// WebView on Android (often silently fails or never resolves), which is
// the actual reason this was still opening on Hyderabad on-device even
// though the logic here was otherwise correct. Every other GPS-consuming
// form in this app (AddFieldForm.jsx, AddCattleForm.jsx) already uses
// @capacitor/geolocation for this exact reason.
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
        // Permission denied / unavailable / timed out - just stay on
        // DEFAULT_CENTER, not fatal.
        console.warn('[AddCattleBaseForm] GPS fix failed, using default center:', err.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip]);
  return null;
}

// Best-effort parse of whatever shape `location` comes back as from
// Supabase into a [lat, lng] pair, so the map can show the pin the Base
// already has when opening in edit mode. Handles all three shapes that
// show up depending on how the select is written:
//   - GeoJSON:      { type: 'Point', coordinates: [lng, lat] }
//   - (E)WKT text:  'SRID=4326;POINT(lng lat)' or 'POINT(lng lat)'
//   - raw WKB hex:  what PostgREST actually returns by default when the
//     column isn't cast to geojson/text in the select (this is the shape
//     `location` comes back as in practice here) - decoded via the shared
//     SRID-aware parser in src/utils/geo.js. This is what was silently
//     breaking Edit for every existing Base ("Couldn't load this Base's
//     saved location").
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

export default function AddCattleBaseForm({ onClose, onSaved, initialBase = null }) {
  const isEditing = !!initialBase;

  const [baseName, setBaseName] = useState(initialBase?.base_name || '');
  const [contactPhone, setContactPhone] = useState(initialBase?.contact_phone || '');
  const [contactWhatsapp, setContactWhatsapp] = useState(initialBase?.contact_whatsapp || '');
  const [pinLocation, setPinLocation] = useState(() => parseLocationToLatLng(initialBase?.location));
  const [geofenceRadiusM, setGeofenceRadiusM] = useState(initialBase?.geofence_radius_m ?? DEFAULT_GEOFENCE_RADIUS_M);
  const [publicFuzzM, setPublicFuzzM] = useState(initialBase?.public_location_fuzz_m ?? DEFAULT_PUBLIC_FUZZ_M);
  const [youtubeUrl, setYoutubeUrl] = useState(initialBase?.youtube_url || '');
  const [instagramUrl, setInstagramUrl] = useState(initialBase?.instagram_url || '');
  const [facebookUrl, setFacebookUrl] = useState(initialBase?.facebook_url || '');
  // cattle_bases had no photo column - added via:
  //   ALTER TABLE cattle_bases ADD COLUMN photo_url text;
  // Uploads go to the existing 'cattle-photos' bucket (no dedicated
  // 'cattle-base-photos' bucket exists).
  const [photoUrl, setPhotoUrl] = useState(initialBase?.photo_url || '');
  const [photoBlob, setPhotoBlob] = useState(null); // set only when a NEW photo is picked; existing photoUrl is kept otherwise
  const [photoError, setPhotoError] = useState(null);
  const [compressingPhoto, setCompressingPhoto] = useState(false);
  const photoFileInputRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Only used for the add-mode insert - editing keeps the existing row's id.
  const draftId = useState(generateUuidV4)[0];
  // Editing an existing Base whose `location` couldn't be parsed (see
  // parseLocationToLatLng above) - the pin renders unset until the farmer
  // taps the map again, so flag that instead of silently looking pinned
  // when it isn't.
  const locationUnreadable = isEditing && !!initialBase?.location && !pinLocation;
  // FIX: new "Use My Current Location" button state - see
  // RecenterOnDemand's comment above for why this is needed in
  // addition to GeolocateOnMount.
  const [locatingMe, setLocatingMe] = useState(false);
  const [locateError, setLocateError] = useState('');
  const [locateTrigger, setLocateTrigger] = useState(null);

  const handleUseMyLocation = async () => {
    setLocatingMe(true);
    setLocateError('');
    try {
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
      const coords = [pos.coords.latitude, pos.coords.longitude];
      setPinLocation(coords);
      setLocateTrigger(coords);
    } catch (err) {
      setLocateError("Couldn't get your location - check location permission/GPS and try again.");
    } finally {
      setLocatingMe(false);
    }
  };

  // Same pattern as AddFieldForm.jsx's handleCropImageSelect - compress
  // client-side immediately on selection so the preview and the eventual
  // upload use the exact same (already-small) blob, rather than
  // uploading the original multi-MB photo and compressing server-side.
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
    if (!baseName.trim()) {
      setError('Please enter a name for this Base.');
      return;
    }
    if (!pinLocation) {
      setError('Please tap the map to set this Base\'s location.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not logged in.');

      const baseId = isEditing ? initialBase.id : draftId;
      // Best-effort - reverseGeocode() returns null on any failure
      // (offline, timeout, rate-limited). On edit, don't let a failed
      // lookup wipe out a place_name that was already saved
      // successfully before (e.g. re-saving other fields while offline)
      // - only overwrite it when the lookup actually succeeds.
      const placeName = await reverseGeocode(pinLocation[0], pinLocation[1]);

      // Upload a NEW photo if one was picked this session; otherwise
      // keep whatever photo_url the Base already had (editing without
      // touching the photo shouldn't wipe it out).
      let uploadedPhotoUrl = isEditing ? (initialBase?.photo_url || null) : null;
      if (photoBlob) {
        const ext = photoBlob.type === 'image/webp' ? 'webp' : 'jpg';
        const path = `${baseId}/photo-${Date.now()}.${ext}`;
        const { error: photoUploadError } = await supabase.storage
          .from('cattle-photos')
          .upload(path, photoBlob, { upsert: true, contentType: photoBlob.type });
        if (photoUploadError) throw photoUploadError;
        const { data: publicUrlData } = supabase.storage.from('cattle-photos').getPublicUrl(path);
        uploadedPhotoUrl = publicUrlData?.publicUrl || null;
      }

      const fields = {
        base_name: sanitizeText(baseName.trim()),
        location: `SRID=4326;POINT(${pinLocation[1]} ${pinLocation[0]})`,
        place_name: placeName || (isEditing ? initialBase?.place_name : null) || null,
        geofence_radius_m: sanitizeNumber(geofenceRadiusM) || DEFAULT_GEOFENCE_RADIUS_M,
        public_location_fuzz_m: sanitizeNumber(publicFuzzM) || 0,
        youtube_url: youtubeUrl.trim() ? sanitizeText(youtubeUrl.trim()) : null,
        instagram_url: instagramUrl.trim() ? sanitizeText(instagramUrl.trim()) : null,
        facebook_url: facebookUrl.trim() ? sanitizeText(facebookUrl.trim()) : null,
        contact_phone: contactPhone.trim() ? sanitizePhone(contactPhone.trim()) : null,
        contact_whatsapp: contactWhatsapp.trim() ? sanitizePhone(contactWhatsapp.trim()) : null,
        photo_url: uploadedPhotoUrl,
      };

      if (isEditing) {
        const { error: updateError } = await supabase
          .from('cattle_bases')
          .update(fields)
          .eq('id', baseId);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await supabase
          .from('cattle_bases')
          .insert({ id: baseId, owner_id: user.id, ...fields });
        if (insertError) throw insertError;
      }

      // Pass the full row back (not just id/base_name) so ProfileScreen's
      // cattleBases cache stays in sync with what's actually in the DB -
      // reopening Edit right after saving should show what was just typed,
      // not blank fields from a stale partial object.
      onSaved({ id: baseId, ...fields });
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
            {isEditing ? 'Edit Cattle Base' : 'Add Cattle Base'}
          </span>
        </div>

        <div>
          <label style={labelStyle}>Base Name</label>
          <input type="text" value={baseName} onChange={(e) => setBaseName(e.target.value)} placeholder="e.g. Main Shed" style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>Base Photo (optional)</label>
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
                    '🏠'
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
                  e.target.value = ''; // allow re-selecting the same file next time
                  handlePhotoSelect(file);
                }}
                style={{ display: 'none' }}
              />
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', flex: 1 }}>
              Tap to add a photo of this Base (shed, farmhouse, etc). Shown to buyers alongside your cattle.
            </div>
          </div>
          {photoError && <div style={{ color: 'var(--color-danger)', fontSize: 12, marginTop: 4 }}>{photoError}</div>}
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
        <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: -6 }}>
          Used to prefill contact info when you add cattle to this Base - you can still change it per animal.
        </div>

        <div>
          <label style={labelStyle}>Location {pinLocation ? '(pinned)' : '(tap map to pin)'}</label>
          {locationUnreadable && (
            <div style={{ fontSize: 11, color: 'var(--color-danger)', marginBottom: 6 }}>
              Couldn't load this Base's saved location - tap the map to set it again.
            </div>
          )}
          <button
            type="button"
            onClick={handleUseMyLocation}
            disabled={locatingMe}
            style={{
              padding: '10px 12px', borderRadius: 10, border: '1px solid var(--color-border)',
              background: 'var(--color-card)', color: 'var(--color-navy)', fontWeight: 600, fontSize: 13,
              marginBottom: 8, cursor: locatingMe ? 'default' : 'pointer',
            }}
          >
            {locatingMe ? 'Getting your location…' : '📍 Use My Current Location'}
          </button>
          {locateError && <div style={{ fontSize: 11, color: 'var(--color-danger)', marginBottom: 6 }}>{locateError}</div>}
          <div style={{ height: 300, minHeight: 300, flexShrink: 0, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--color-border)' }}>
            <MapContainer center={pinLocation || DEFAULT_CENTER} zoom={13} style={{ height: '100%', width: '100%', background: 'var(--color-bg)' }}>
              <OfflineTileLayer />
              <GeolocateOnMount skip={!!pinLocation} />
              <RecenterOnDemand target={locateTrigger} />
              <ClickToPin onPick={setPinLocation} />
              {pinLocation && (
                <>
                  <Marker position={pinLocation} />
                  <Circle center={pinLocation} radius={Number(geofenceRadiusM) || DEFAULT_GEOFENCE_RADIUS_M} pathOptions={{ color: '#2b3a61', fillOpacity: 0.1 }} />
                </>
              )}
            </MapContainer>
          </div>
        </div>

        <div>
          <label style={labelStyle}>Geofence Radius (meters)</label>
          <input
            type="number" min="0"
            value={geofenceRadiusM}
            onChange={(e) => setGeofenceRadiusM(e.target.value)}
            style={inputStyle}
          />
          <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
            Alert boundary around this Base's exact location.
          </div>
        </div>

        <div>
          <label style={labelStyle}>Public Location Fuzz (meters)</label>
          <input
            type="number" min="0"
            value={publicFuzzM}
            onChange={(e) => setPublicFuzzM(e.target.value)}
            style={inputStyle}
          />
          <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
            You still see this Base's exact location everywhere in the app. When shown to buyers or the
            public, the pin is randomly offset by up to this distance so strangers can't pinpoint exactly
            where your animals are. Set to 0 to show the exact location publicly.
          </div>
        </div>

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
          {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Cattle Base'}
        </button>
      </form>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6 };
const inputStyle = { width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--color-border)', fontSize: 14, fontFamily: 'inherit', outline: 'none', background: 'var(--color-card)', color: 'var(--color-ink)' };