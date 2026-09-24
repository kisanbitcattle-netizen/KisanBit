// src/components/AddPondForm.jsx
//
// Add OR Edit a Pond — mirrors AddFieldForm.jsx's boundary-drawing
// mechanism exactly (same two modes: tap-to-pin, or GPS Corner Points
// via @capacitor/geolocation one-shot high-accuracy fixes; same
// polygon area math), just relabeled Field -> Pond. Deliberately
// leaves out several AddFieldForm sections that don't apply here:
//   - Soil N-P-K/pH/type: not a pond concept.
//
// Water Source: mirrors AddFieldForm's "type + GPS-recorded point"
// Water Source button (recording where the pond's feed source is -
// borewell, canal inlet, etc) plus a short free-text note (e.g.
// "borewell-fed", "canal", "rain-fed") for the farmer's own reference.
//
// UPDATED: pond now carries its own contact_phone/contact_whatsapp,
// social links (youtube_url/instagram_url/facebook_url), and a photo
// (mirrors AddFieldForm's field-level contact fields).
//
// Fish stock is now handled entirely by PondsPanel.jsx's FishForm on
// Home (same split as Field/Crop: field editing is Profile-tab-only
// via this file, crop/stock editing is Home-tab-only via a separate
// panel+form). This file no longer touches pond_fish_stock at all -
// it previously had a Fish Stock carousel inline, which was removed
// since it duplicated (and had drifted out of sync with) PondsPanel's
// FishForm. ponds.is_public is DB-trigger-driven off
// pond_fish_stock.is_listed_for_sale (see pond_fish_stock schema) -
// shown here as a read-only status badge, not a farmer-facing toggle.
//
// Save path also differs from AddFieldForm: fields uses
// create_field/update_field RPCs because `fields.boundary` is a real
// PostGIS column with server-side logic behind those RPCs. `ponds`
// has no such RPCs (brand-new table, no PostGIS boundary column - see
// alter_ponds_add_boundary.sql), so this saves via a plain
// supabase.from('ponds').insert/update() with boundary_geojson as a
// plain jsonb column instead - which means, unlike Field, contact_phone/
// contact_whatsapp/image_url/social links can all go straight into
// that one payload instead of needing a second update call.

import { useState, useCallback, useMemo, useEffect, useRef, Component } from 'react';
import { MapContainer, Polygon, Marker, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Geolocation } from '@capacitor/geolocation';
import { supabase } from '../../config/supabaseClient';
import { useLinkedSocialLinks } from '../../utils/socialLinks';
import OfflineTileLayer from '../map/OfflineTileLayer';

const DEFAULT_CENTER = [17.385, 78.4867];
const EARTH_RADIUS_M = 6371000;
const SQ_M_PER_ACRE = 4046.8564224;
const MIN_ACCURACY_M = 10;

// Same aggressive compress-to-target-KB pipeline used across the app
// (AddFieldForm's crop photos, AddCattleBaseForm, AddServiceForm) -
// ~40KB target for entity photos (pond photo).
async function compressImageToTargetKB(file, targetKB = 40, maxDimension = 640) {
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

async function uploadPondAsset(fileOrBlob, bucket, fileNamePrefix) {
  if (!fileOrBlob) return null;
  const ext = (fileOrBlob.type && fileOrBlob.type.split('/')[1]) || 'jpg';
  const path = `${fileNamePrefix}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, fileOrBlob, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl || null;
}

function calculatePolygonAreaAcres(points) {
  if (points.length < 3) return 0;
  const avgLat = (points.reduce((sum, p) => sum + p[0], 0) / points.length) * (Math.PI / 180);
  const cosLat = Math.cos(avgLat);
  const projected = points.map(([lat, lng]) => ({
    x: (lng * Math.PI) / 180 * EARTH_RADIUS_M * cosLat,
    y: (lat * Math.PI) / 180 * EARTH_RADIUS_M,
  }));
  let area = 0;
  for (let i = 0; i < projected.length; i++) {
    const p1 = projected[i];
    const p2 = projected[(i + 1) % projected.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(area) / 2 / SQ_M_PER_ACRE;
}

// Same tolerant parser as AddFieldForm.jsx's geojsonToPoints, minus
// the WKB-hex-string branch — boundary_geojson here is always a plain
// jsonb column (never PostGIS geography), so Supabase always returns
// it already parsed as a real object, never a hex string.
function geojsonToPoints(boundary_geojson) {
  try {
    let value = boundary_geojson;
    if (typeof value === 'string') value = JSON.parse(value);

    const ring = value?.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 3) return [];

    const pts = ring.map(([lng, lat]) => [lat, lng]);
    if (pts.length > 3) {
      const [firstLat, firstLng] = pts[0];
      const [lastLat, lastLng] = pts[pts.length - 1];
      if (firstLat === lastLat && firstLng === lastLng) pts.pop();
    }
    return pts;
  } catch (err) {
    console.warn('[AddPondForm] Failed to parse boundary_geojson:', err, boundary_geojson);
    return [];
  }
}

function ClickToPin({ onPointAdd, enabled }) {
  useMapEvents({
    click(e) {
      if (!enabled) return;
      onPointAdd([e.latlng.lat, e.latlng.lng]);
    },
  });
  return null;
}

function RecenterOnWalk({ position, active }) {
  const map = useMap();
  useEffect(() => {
    if (active && position) map.setView(position, map.getZoom());
  }, [position, active, map]);
  return null;
}

function RecenterOnGps({ position, skip }) {
  const map = useMap();
  useEffect(() => {
    if (position && !skip) map.setView(position, map.getZoom());
  }, [position, skip, map]);
  return null;
}

const inputBoxStyle = { width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--color-border, #ddd)', fontSize: 13, fontFamily: 'inherit' };
// Labeled full-width block style, matching AddCattleForm.jsx's
// labelStyle/inputStyle - used for the social link fields below so those
// fields look identical across Cattle/Field/Pond.
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6 };
const inputStyle = { width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--color-border)', fontSize: 14, fontFamily: 'inherit', outline: 'none' };

// Same themed style as AddFieldForm.jsx - plain unstyled buttons keep
// a white browser-default background but inherit this app's dark-mode
// text color (white), which makes the label invisible in dark mode.
const secondaryButtonStyle = {
  minHeight: 44, padding: '8px 14px', borderRadius: 8,
  border: '1px solid var(--color-border)', background: 'var(--color-card)',
  color: 'var(--color-ink)', fontWeight: 600, fontSize: 13, cursor: 'pointer',
};

// This form's map lives inside a modal (position: fixed, opens on top
// of the page). Leaflet measures its container once at creation time,
// and a modal that hasn't finished its layout/animation yet can hand
// the map a 0px (or stale) size at that moment - the map then stays
// blank/grey, most noticeably in edit mode where the boundary should
// already be drawn. Nudging Leaflet to re-measure shortly after mount
// fixes this.
function InvalidateSizeOnMount() {
  const map = useMap();
  useEffect(() => {
    const id = setTimeout(() => map.invalidateSize(), 150);
    return () => clearTimeout(id);
  }, [map]);
  return null;
}

// TEMPORARY DEBUG AID - not a permanent app pattern. The map block was
// reported as silently vanishing on a real OnePlus device with no visible
// error and no DevTools access to check the console. Function-component
// try/catch cannot catch errors thrown by CHILD components during render
// (only class components can, via getDerivedStateFromError/
// componentDidCatch) - so this class wraps just the map area and shows
// the raw error message + stack directly on-screen if MapContainer (or
// anything inside it) throws during mount. If the map still vanishes
// with NO red box appearing here, that rules out a render-time JS crash
// entirely and points to something else (WebView paint/compositing,
// CSS, etc). Safe to remove once the underlying bug is found.
class MapErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[AddPondForm MapErrorBoundary] map crashed:', error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 12, borderRadius: 10, background: '#fff0f0', border: '2px solid red', color: '#900', fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          MAP CRASHED:{'\n'}{String(this.state.error?.message || this.state.error)}
          {'\n\n'}{this.state.error?.stack || ''}
        </div>
      );
    }
    return this.props.children;
  }
}

export default function AddPondForm({ initialPond, onClose, onSaved }) {
  const isEditMode = !!initialPond;
  const pondPhotoInputRef = useRef(null);

  const [pondName, setPondName] = useState(initialPond?.pond_name || '');

  // Water source - same "type + GPS-recorded point" pattern as
  // AddFieldForm's Water Source button, instead of the plain free-text
  // field this used to be. Keeps a short free-text note too (e.g.
  // "borewell", "canal feed") for the farmer's own reference alongside
  // the recorded point.
  const [waterSource, setWaterSource] = useState(initialPond?.water_source || '');
  const [waterSourceType, setWaterSourceType] = useState(initialPond?.water_source_type || '');
  const [waterSourceLat, setWaterSourceLat] = useState(initialPond?.water_source_lat ?? null);
  const [waterSourceLng, setWaterSourceLng] = useState(initialPond?.water_source_lng ?? null);
  const [isRecordingWaterSource, setIsRecordingWaterSource] = useState(false);
  const [waterSourceError, setWaterSourceError] = useState(null);

  const [notes, setNotes] = useState(initialPond?.notes || '');
  const [contactPhone, setContactPhone] = useState(initialPond?.contact_phone || '');
  const [contactWhatsapp, setContactWhatsapp] = useState(initialPond?.contact_whatsapp || '');
  const [youtubeUrl, setYoutubeUrl] = useState(initialPond?.youtube_url || '');
  const [instagramUrl, setInstagramUrl] = useState(initialPond?.instagram_url || '');
  const [facebookUrl, setFacebookUrl] = useState(initialPond?.facebook_url || '');
  const [photoUrl, setPhotoUrl] = useState(initialPond?.image_url || '');
  const [photoBlob, setPhotoBlob] = useState(null);
  // Read-only: ponds.is_public is DB-trigger-driven off
  // pond_fish_stock.is_listed_for_sale, not something this form sets directly.
  const isPublic = !!initialPond?.is_public;

  const [mode, setMode] = useState('tap');
  const [points, setPoints] = useState(() =>
    isEditMode ? geojsonToPoints(initialPond.boundary_geojson) : []
  );
  const [drawing, setDrawing] = useState(!isEditMode || points.length === 0);
  const [areaOverride, setAreaOverride] = useState(isEditMode ? initialPond.area_acres : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [gpsCenter, setGpsCenter] = useState(null);
  useEffect(() => {
    if (isEditMode) return;
    let cancelled = false;
    Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 })
      .then((pos) => {
        if (!cancelled) setGpsCenter([pos.coords.latitude, pos.coords.longitude]);
      })
      .catch((err) => {
        console.warn('[AddPondForm] GPS fix failed, using default center:', err.message);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [isRecordingPoint, setIsRecordingPoint] = useState(false);
  const [walkPosition, setWalkPosition] = useState(null);
  const [lastAccuracy, setLastAccuracy] = useState(null);
  const [rejectedCount, setRejectedCount] = useState(0);

  const boundaryLoadFailed = isEditMode && !!initialPond?.boundary_geojson && points.length === 0;

  const computedArea = useMemo(() => calculatePolygonAreaAcres(points), [points]);
  const displayArea = areaOverride ?? computedArea;

  const handlePointAdd = useCallback((pt) => {
    setPoints((prev) => [...prev, pt]);
  }, []);

  const handleUndo = () => setPoints((prev) => prev.slice(0, -1));
  const handleClear = () => {
    setPoints([]);
    setAreaOverride(null);
    setDrawing(true);
    setRejectedCount(0);
  };
  const handleFinishDrawing = () => {
    if (points.length < 3) {
      setError('Mark at least 3 boundary points.');
      return;
    }
    setError(null);
    setDrawing(false);
  };

  const recordCorner = async () => {
    setError(null);
    try {
      const perm = await Geolocation.requestPermissions();
      if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
        setError('Allow location access - phone Settings > Apps > KisanBit > check permissions.');
        return;
      }
    } catch (err) {
      setError('Permission request failed: ' + err.message);
      return;
    }

    setDrawing(true);
    setIsRecordingPoint(true);
    try {
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      });
      const { latitude, longitude, accuracy } = position.coords;
      setLastAccuracy(accuracy);
      setWalkPosition([latitude, longitude]);

      if (accuracy > MIN_ACCURACY_M) {
        setRejectedCount((prev) => prev + 1);
        setError(`GPS accuracy too low (±${Math.round(accuracy)}m, need ≤${MIN_ACCURACY_M}m). Move to open sky and try again.`);
        return;
      }
      setPoints((prev) => [...prev, [latitude, longitude]]);
    } catch (err) {
      if (err?.code === 3 || /timeout/i.test(err?.message || '')) {
        setError('Could not get a GPS fix in time (are you indoors?). Step into the open and try again.');
      } else if (err?.code === 1) {
        setError('Location permission denied. Enable it in phone Settings.');
      } else {
        setError('GPS error: ' + (err?.message || 'unknown'));
      }
    } finally {
      setIsRecordingPoint(false);
    }
  };

  const handleModeSwitch = (newMode) => {
    setMode(newMode);
    setPoints([]);
    setAreaOverride(null);
    setDrawing(true);
    setRejectedCount(0);
  };

  // Same one-shot high-accuracy GPS pattern as AddFieldForm's Water
  // Source button - records where the pond's feed source is (borewell,
  // canal inlet, etc), separately from the pond boundary itself.
  const recordWaterSourcePoint = async () => {
    setWaterSourceError(null);
    try {
      const perm = await Geolocation.requestPermissions();
      if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
        setWaterSourceError('Allow location access - phone Settings > Apps > KisanBit > check permissions.');
        return;
      }
    } catch (err) {
      setWaterSourceError('Permission request failed: ' + err.message);
      return;
    }

    setIsRecordingWaterSource(true);
    try {
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      });
      const { latitude, longitude, accuracy } = position.coords;
      if (accuracy > MIN_ACCURACY_M) {
        setWaterSourceError(`GPS accuracy too low (±${Math.round(accuracy)}m, need ≤${MIN_ACCURACY_M}m). Move to open sky and try again.`);
        return;
      }
      setWaterSourceLat(latitude);
      setWaterSourceLng(longitude);
    } catch (err) {
      setWaterSourceError('Could not get GPS fix: ' + err.message);
    } finally {
      setIsRecordingWaterSource(false);
    }
  };

  const handlePondPhotoSelect = async (file) => {
    if (!file) return;
    try {
      const compressedBlob = await compressImageToTargetKB(file, 40);
      if (!compressedBlob) {
        setError('Could not process that photo, please try another.');
        return;
      }
      setPhotoBlob(compressedBlob);
      setPhotoUrl(URL.createObjectURL(compressedBlob));
    } catch (err) {
      setError('Photo compression failed: ' + err.message);
    }
  };

  // If the owner types one social link, auto-fill the other two empty
  // ones with the same URL; typing a distinct link into any field
  // "claims" it so it's never auto-overwritten again. Same behaviour as
  // AddCattleForm.jsx and AddFieldForm.jsx - see utils/socialLinks.js.
  const { onYoutubeChange, onInstagramChange, onFacebookChange } = useLinkedSocialLinks({
    youtubeUrl, setYoutubeUrl, instagramUrl, setInstagramUrl, facebookUrl, setFacebookUrl,
  });

  const handleSave = async () => {
    if (!pondName.trim()) {
      setError('Enter a pond name.');
      return;
    }
    if (points.length < 3) {
      setError('Set the pond boundary first.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const ring = points.map(([lat, lng]) => [lng, lat]);
      ring.push(ring[0]);
      const boundary_geojson = { type: 'Polygon', coordinates: [ring] };
      const area_acres = Number(displayArea.toFixed(2));

      const { data: { user } } = await supabase.auth.getUser();

      const pondPhotoUrl = photoBlob
        ? await uploadPondAsset(photoBlob, 'service-photos', `pond-${user.id}-${Date.now()}`)
        : (photoUrl || null);

      const payload = {
        owner_id: user.id,
        pond_name: pondName.trim(),
        boundary_geojson,
        area_acres,
        water_source: waterSource.trim() || null,
        water_source_type: waterSourceType || null,
        water_source_lat: waterSourceLat,
        water_source_lng: waterSourceLng,
        notes: notes.trim() || null,
        contact_phone: contactPhone.trim() || null,
        contact_whatsapp: contactWhatsapp.trim() || null,
        image_url: pondPhotoUrl,
        youtube_url: youtubeUrl.trim() || null,
        instagram_url: instagramUrl.trim() || null,
        facebook_url: facebookUrl.trim() || null,
        updated_at: new Date().toISOString(),
      };

      const query = isEditMode
        ? supabase.from('ponds').update(payload).eq('id', initialPond.id).select().single()
        : supabase.from('ponds').insert(payload).select().single();

      const { data: savedPond, error: saveError } = await query;
      if (saveError) throw saveError;

      onSaved(savedPond);
    } catch (err) {
      setError('Could not save this pond: ' + (err?.message || 'unknown error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
      }}
    >
      <div
        className="kb-card"
        style={{ padding: 16, maxWidth: 520, width: '100%', maxHeight: '90vh', overflowY: 'auto', position: 'relative', display: 'flex', flexDirection: 'column', gap: 10 }}
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

        <h3 className="display-text" style={{ fontSize: 16, color: 'var(--color-ink)', marginBottom: 4 }}>
          {isEditMode ? 'Edit Pond' : 'Add Pond'}
        </h3>

        {isEditMode && (
          <div
            style={{
              alignSelf: 'flex-start', padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700,
              background: isPublic ? 'rgba(46, 160, 67, 0.15)' : 'var(--color-border)',
              color: isPublic ? 'var(--color-success)' : 'var(--color-muted)',
            }}
          >
            {isPublic ? '🌐 Visible to buyers' : '🔒 Private'}
          </div>
        )}
        {isEditMode && (
          <p style={{ fontSize: 11, color: 'var(--color-muted)', margin: 0 }}>
            This pond shows up for buyers automatically once you list any fish stock for sale below - no separate toggle needed.
          </p>
        )}

        {boundaryLoadFailed && (
          <div style={{ padding: 10, borderRadius: 8, background: '#fff4e5', border: '1px solid var(--color-gold)', color: 'var(--color-ink)', fontSize: 13 }}>
            ⚠️ This pond has a saved boundary, but it couldn't be loaded onto the map. You'll need to redraw the boundary below before saving, or Cancel to leave the old one untouched.
          </div>
        )}

        {/* 1. Name */}
        <input
          type="text"
          placeholder="Pond name (e.g. Back pond)"
          value={pondName}
          onChange={(e) => setPondName(e.target.value)}
          style={inputBoxStyle}
        />

        {/* 2. Photo - same always-visible camera-badge pattern used
            across the app (Cattle Base, Field, Service). */}
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
                onClick={() => pondPhotoInputRef.current?.click()}
                style={{ all: 'unset', cursor: 'pointer', display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}
              >
                {photoUrl ? (
                  <img src={photoUrl} alt={pondName || 'pond'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  '🐟'
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
              📷
            </div>
            <input
              ref={pondPhotoInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                handlePondPhotoSelect(file);
              }}
              style={{ display: 'none' }}
            />
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-muted)', flex: 1 }}>
            Tap to add or change this pond's photo.
          </div>
        </div>

        {/* 3. Basic details - side-by-side, same compact layout as
            AddFieldForm's Contact phone / WhatsApp row. */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Contact Phone </label>
            <input type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="e.g. 9876543210" style={inputBoxStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>WhatsApp (optional)</label>
            <input type="tel" value={contactWhatsapp} onChange={(e) => setContactWhatsapp(e.target.value)} placeholder="e.g. 9876543210" style={inputBoxStyle} />
          </div>
        </div>

        {/* 4. Map - boundary drawing (tap or GPS-walk corners), same as
            Add Field, plus its own mode/undo/clear/finish controls kept
            right below it since they only make sense next to the map.
            Tiles are cached offline (OfflineTileLayer / IndexedDB) so
            this still works with no signal. */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => handleModeSwitch('tap')} style={{ flex: 1, padding: 10, borderRadius: 8, border: `2px solid ${mode === 'tap' ? 'var(--color-gold)' : 'var(--color-border)'}`, background: mode === 'tap' ? 'rgba(222, 160, 59, 0.18)' : 'var(--color-card)', color: 'var(--color-ink)', fontWeight: 700, fontSize: 13 }}>
            Tap on Map
          </button>
          <button type="button" onClick={() => handleModeSwitch('walk')} style={{ flex: 1, padding: 10, borderRadius: 8, border: `2px solid ${mode === 'walk' ? 'var(--color-gold)' : 'var(--color-border)'}`, background: mode === 'walk' ? 'rgba(222, 160, 59, 0.18)' : 'var(--color-card)', color: 'var(--color-ink)', fontWeight: 700, fontSize: 13 }}>
            GPS Corner Points
          </button>
        </div>

        <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
          {mode === 'tap' && drawing && `Touch map to add boundary points (${points.length} points marked).`}
          {mode === 'walk' && drawing && (
            <>
              {points.length} corner{points.length === 1 ? '' : 's'} recorded.
              {lastAccuracy != null && ` Last accuracy: ${Math.round(lastAccuracy)}m.`}
              {rejectedCount > 0 && ` (${rejectedCount} low-accuracy attempt${rejectedCount === 1 ? '' : 's'} rejected.)`}
              {points.length === 0 && ' Stand at each corner of the pond and press "Record Corner Point".'}
            </>
          )}
          {!drawing && `Boundary set. Area: ${displayArea.toFixed(2)} acres`}
        </div>

        <MapErrorBoundary>
          <div style={{ height: 300, minHeight: 300, flexShrink: 0, borderRadius: 10, overflow: 'hidden' }}>
            <MapContainer
              center={walkPosition || (points[0] || gpsCenter || DEFAULT_CENTER)}
              zoom={17}
              preferCanvas={true}
              style={{ height: '100%', width: '100%', background: 'var(--color-bg)' }}
            >
              <OfflineTileLayer maxZoom={16} keepBuffer={1} detectRetina={false} />
              <InvalidateSizeOnMount />
              <ClickToPin onPointAdd={handlePointAdd} enabled={mode === 'tap' && drawing} />
              <RecenterOnWalk position={walkPosition} active={mode === 'walk'} />
              <RecenterOnGps position={gpsCenter} skip={points.length > 0} />
              {points.map((pt, i) => <Marker key={i} position={pt} />)}
              {points.length >= 2 && (
                <Polygon positions={points} pathOptions={{ color: '#DEA03B', fillOpacity: 0.25 }} />
              )}
            </MapContainer>
          </div>
        </MapErrorBoundary>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {mode === 'tap' && drawing && (
            <>
              <button type="button" onClick={handleUndo} disabled={points.length === 0} style={secondaryButtonStyle}>Undo last point</button>
              <button type="button" onClick={handleClear} disabled={points.length === 0} style={secondaryButtonStyle}>Clear</button>
              <button type="button" onClick={handleFinishDrawing} disabled={points.length < 3} style={{ ...secondaryButtonStyle, fontWeight: 700 }}>Finish boundary ✓</button>
            </>
          )}

          {mode === 'walk' && drawing && (
            <>
              <button
                type="button"
                onClick={recordCorner}
                disabled={isRecordingPoint}
                style={{ flex: '1 1 100%', minHeight: 44, padding: '10px 0', borderRadius: 8, border: 'none', background: 'var(--color-success)', color: '#fff', fontWeight: 700 }}
              >
                {isRecordingPoint ? 'Getting GPS fix…' : '📍 Record Corner Point'}
              </button>
              <button type="button" onClick={handleUndo} disabled={points.length === 0} style={secondaryButtonStyle}>Undo last point</button>
              <button type="button" onClick={handleClear} disabled={points.length === 0} style={secondaryButtonStyle}>Clear</button>
              <button type="button" onClick={handleFinishDrawing} disabled={points.length < 3} style={{ ...secondaryButtonStyle, fontWeight: 700 }}>Finish boundary ✓</button>
            </>
          )}

          {!drawing && (
            <>
              <button type="button" onClick={() => setDrawing(true)} style={secondaryButtonStyle}>Re-draw boundary</button>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                Area (acres):
                <input type="number" step="0.01" min="0" value={displayArea.toFixed(2)} onChange={(e) => setAreaOverride(Number(e.target.value))} style={{ width: 70, padding: '4px 6px', borderRadius: 6, border: '1px solid #ddd' }} />
              </label>
            </>
          )}
        </div>

        {/* 5. Water source - same type + GPS-recorded-point button as
            Add Field's Water Source, plus a short free-text note. */}
        <div className="kb-card" style={{ padding: 10, marginBottom: 8 }}>
          <label style={{ fontWeight: 700, fontSize: 14, display: 'block', marginBottom: 8 }}>
            💧 Water Source
          </label>

          <select value={waterSourceType} onChange={(e) => setWaterSourceType(e.target.value)} style={{ ...inputBoxStyle, width: '100%', marginBottom: 8 }}>
            <option value="">Water type (optional)</option>
            <option value="fresh">Fresh water</option>
            <option value="salt">Salt water / brackish</option>
          </select>

          <input
            type="text"
            placeholder="Water source note (optional) — borewell, canal, rain-fed…"
            value={waterSource}
            onChange={(e) => setWaterSource(e.target.value)}
            style={{ ...inputBoxStyle, marginBottom: 8 }}
          />

          <button
            type="button"
            onClick={recordWaterSourcePoint}
            disabled={isRecordingWaterSource}
            style={{ width: '100%', minHeight: 44, padding: '8px 0', borderRadius: 8, border: 'none', background: 'var(--color-success)', color: '#fff', fontWeight: 700, fontSize: 13 }}
          >
            {isRecordingWaterSource ? 'Getting GPS fix…' : (waterSourceLat != null ? '📍 Point recorded - tap to re-record' : '📍 Record Water Source Point')}
          </button>

          {waterSourceError && (
            <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 6 }}>{waterSourceError}</div>
          )}
        </div>

        

        {/* 7. Social links */}
        <div>
          <label style={labelStyle}>YouTube Channel (optional)</label>
          <input type="url" value={youtubeUrl} onChange={(e) => onYoutubeChange(e.target.value)} placeholder="e.g. https://youtube.com/@yourpond" style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>Instagram Page (optional)</label>
          <input type="url" value={instagramUrl} onChange={(e) => onInstagramChange(e.target.value)} placeholder="e.g. https://instagram.com/yourpond" style={inputStyle} />
        </div>

        <div>
          <label style={labelStyle}>Facebook Page (optional)</label>
          <input type="url" value={facebookUrl} onChange={(e) => onFacebookChange(e.target.value)} placeholder="e.g. https://facebook.com/yourpond" style={inputStyle} />
          {(youtubeUrl.trim() || instagramUrl.trim() || facebookUrl.trim()) && (
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
              Fill in just one - we'll copy it to the other blank fields automatically. Type a different link in any field to keep it distinct.
            </div>
          )}
        </div>

        {error && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={handleSave} disabled={saving || drawing || !pondName.trim()} style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', background: 'var(--color-navy)', color: '#fff', fontWeight: 700, opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving...' : isEditMode ? 'Save Changes' : 'Save Pond'}
          </button>
          <button type="button" onClick={onClose} disabled={saving} style={secondaryButtonStyle}>Cancel</button>
        </div>
      </div>
    </div>
  );
}