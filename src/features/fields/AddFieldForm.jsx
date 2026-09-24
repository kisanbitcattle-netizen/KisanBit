// src/components/AddFieldForm.jsx
//
// Add OR Edit a field — two ways to draw the boundary:
//   1. Tap-to-pin: tap corners on the map manually.
//   2. GPS Corner Points: farmer stands at each corner and presses
//      "Record Corner Point", which takes ONE high-accuracy fix via
//      getCurrentPosition({ enableHighAccuracy: true, timeout: 10000,
//      maximumAge: 0 }). Uses @capacitor/geolocation (NOT plain
//      navigator.geolocation) for reliable native GPS access + proper
//      Android permission handling inside the WebView - only
//      accuracy<=10m fixes kept. This replaces the old continuous
//      watchPosition() "walk" tracking, which kept the GPS radio on
//      for the whole walk and drained battery fast.
// Crop entries are NOT managed here anymore - see the "CROPS MOVED
// OUT" note on the component below. Tiles are cached offline via
// OfflineTileLayer (leaflet.offline/IndexedDB) so the map still works
// in areas with no signal, same as every other map in this app.
//
// Field-level content, top to bottom: name -> photo -> basic details
// (contact) -> boundary map (+ its own mode/undo/clear/finish controls,
// kept together since they only make sense next to the map) -> water
// source -> soil health -> social links -> save/cancel.
//
// EDIT MODE: pass `initialField` (a row from the `fields` table) to
// pre-fill the form and switch Save into an UPDATE instead of an INSERT.

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
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

// Iteratively compresses an image file down toward a target size (KB)
// by reducing JPEG quality first, then shrinking dimensions if quality
// alone isn't enough. Mirrors the aggressive-compression pattern already
// used for cattle photos (100KB target), but tuned for a ~10KB target.
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

// Uploads the field's own photo (and, previously, crop photos/QC
// certificates - that part of this app now lives entirely outside this
// form, see the "Crops moved out" note near the top of the component).
async function uploadFieldAsset(fileOrBlob, bucket, fileNamePrefix) {
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

// Converts a stored GeoJSON Polygon (rings of [lng, lat], closed) back
// into the [lat, lng] point list this form works with internally.
// Tolerant of a couple of shapes we might realistically get back from
// Supabase: a parsed object (ideal), a JSON string (if the column/query
// didn't auto-parse it), or something else entirely (e.g. a raw PostGIS
// WKB hex string) — in which case we bail with a console warning rather
// than failing silently, since a silent [] here is exactly what produces
// the confusing "Set boundary first" error on Save for an edit that
// already has a boundary.
function geojsonToPoints(boundary_geojson) {
  try {
    let value = boundary_geojson;

    if (typeof value === 'string') {
      // Looks like raw PostGIS WKB/EWKB hex (starts with a hex header,
      // no JSON braces) rather than a GeoJSON string — can't parse this
      // client-side; the query needs to ask Postgres for GeoJSON instead
      // (e.g. `select('*, boundary_geojson_text:boundary_geojson::json')`
      // or a view/RPC that wraps the column in ST_AsGeoJSON()).
      if (!value.trim().startsWith('{')) {
        console.warn(
          '[AddFieldForm] boundary_geojson looks like a raw geometry string, not GeoJSON:',
          value.slice(0, 40) + '…'
        );
        return [];
      }
      value = JSON.parse(value);
    }

    const ring = value?.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 3) {
      console.warn('[AddFieldForm] Could not find a usable coordinate ring in boundary_geojson:', boundary_geojson);
      return [];
    }
    const pts = ring.map(([lng, lat]) => [lat, lng]);
    // drop the closing point if it duplicates the first
    if (pts.length > 3) {
      const [firstLat, firstLng] = pts[0];
      const [lastLat, lastLng] = pts[pts.length - 1];
      if (firstLat === lastLat && firstLng === lastLng) pts.pop();
    }
    return pts;
  } catch (err) {
    console.warn('[AddFieldForm] Failed to parse boundary_geojson:', err, boundary_geojson);
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

// Imperatively recenters the map on the farmer's real GPS position once a
// fix comes in, instead of the map opening at DEFAULT_CENTER (Hyderabad)
// every time. MapContainer's `center` prop only applies once at initial
// mount, so this can't just be a state update - same pattern as
// RecenterOnWalk above. Skips once the farmer has actually placed a
// boundary point - their own points shouldn't get shoved off-screen by a
// late-arriving GPS fix.
function RecenterOnGps({ position, skip }) {
  const map = useMap();
  useEffect(() => {
    if (position && !skip) map.setView(position, map.getZoom());
  }, [position, skip, map]);
  return null;
}

const inputBoxStyle = { width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--color-border, #ddd)', fontSize: 13, fontFamily: 'inherit' };

// Plain unstyled <button>s pick up the browser's default white
// background but inherit this app's dark-mode text color (white),
// which makes their label invisible (white-on-white) in dark mode.
// Every "secondary" button (Undo/Clear/Re-draw/Cancel) uses this
// explicit themed style instead so it stays visible in both modes.
const secondaryButtonStyle = {
  minHeight: 44, padding: '8px 14px', borderRadius: 8,
  border: '1px solid var(--color-border)', background: 'var(--color-card)',
  color: 'var(--color-ink)', fontWeight: 600, fontSize: 13, cursor: 'pointer',
};

// Leaflet measures its container's size once, at the moment the map is
// created. If the map mounts while its parent is still 0px tall (e.g.
// a modal that hasn't finished laying out yet, or a tab/section that's
// briefly hidden), Leaflet freezes at that size and the tiles render
// blank/grey until something forces a recalculation. This nudges it
// once, shortly after mount.
function InvalidateSizeOnMount() {
  const map = useMap();
  useEffect(() => {
    const id = setTimeout(() => map.invalidateSize(), 150);
    return () => clearTimeout(id);
  }, [map]);
  return null;
}

// CROPS MOVED OUT: this form used to also manage the field's crop
// listings inline (a "+ Add Crop" shortcut opening a carousel of crop
// cards, with photo/QC-certificate upload, right inside Add/Edit
// Field). Per product decision, crops are now added and edited only
// from the "+ Add Crop" button on the Home screen - this form is
// field-only again (name, photo, contact, boundary, water source,
// soil health, social links). If Home's Add Crop flow needs the
// field's id/name/contact to prefill, pass the saved field row
// (returned via onSaved below) into that flow instead of round-
// tripping through here.
export default function AddFieldForm({ onSaved, onCancel, initialField, focusSection }) {
  const isEditMode = !!initialField;
  const boundarySectionRef = useRef(null);

  // When a parent opens this form specifically to redraw the boundary
  // (e.g. the "Edit Boundary" button), scroll the map/draw-controls
  // section into view as soon as it mounts.
  useEffect(() => {
    if (focusSection === 'boundary' && boundarySectionRef.current) {
      boundarySectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Only run once on mount for this instance of the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [name, setName] = useState(initialField?.name || '');
  const [mode, setMode] = useState('tap');
  const [points, setPoints] = useState(() =>
    isEditMode ? geojsonToPoints(initialField.boundary_geojson) : []
  );
  const [drawing, setDrawing] = useState(!isEditMode);
  const [areaOverride, setAreaOverride] = useState(isEditMode ? initialField.area_acres : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // One-time GPS fix on open, only useful for a brand-new field (edit
  // mode already has real boundary points to center on) - centers the
  // map on the farmer's actual location instead of always opening on
  // DEFAULT_CENTER (Hyderabad). See RecenterOnGps above.
  const [gpsCenter, setGpsCenter] = useState(null);
  useEffect(() => {
    if (isEditMode) return; // has real points already, no need to chase GPS
    let cancelled = false;
    Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 })
      .then((pos) => {
        if (!cancelled) setGpsCenter([pos.coords.latitude, pos.coords.longitude]);
      })
      .catch((err) => {
        console.warn('[AddFieldForm] GPS fix failed, using default center:', err.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [contactPhone, setContactPhone] = useState(initialField?.contact_phone || '');
  const [contactWhatsapp, setContactWhatsapp] = useState(initialField?.contact_whatsapp || '');

  // Field photo - same always-visible camera-badge pattern and
  // compress-to-target-KB pipeline as AddCattleBaseForm/AddPondForm/
  // AddServiceForm, so a field's photo behaves identically to every
  // other entity's photo in the app.
  // ASSUMPTION: `fields` has no photo column yet - using `photo_url` to
  // match the naming used elsewhere (cattle_bases.photo_url,
  // ponds.image_url, crops_marketplace.image_url). If the real column
  // is named differently, only the `photo_url` references below and
  // the bucket name in handleSave need to change.
  const photoFileInputRef = useRef(null);
  const [photoUrl, setPhotoUrl] = useState(initialField?.photo_url || '');
  const [photoBlob, setPhotoBlob] = useState(null);
  const [photoError, setPhotoError] = useState(null);
  const [compressingPhoto, setCompressingPhoto] = useState(false);

  // Social links - same linked-fields behaviour (fill one, auto-copy to
  // the other blanks) as Cattle Base/Pond/Service, via useLinkedSocialLinks.
  const [youtubeUrl, setYoutubeUrl] = useState(initialField?.youtube_url || '');
  const [instagramUrl, setInstagramUrl] = useState(initialField?.instagram_url || '');
  const [facebookUrl, setFacebookUrl] = useState(initialField?.facebook_url || '');

  const [soilN, setSoilN] = useState(initialField?.soil_n ?? '');
  const [soilP, setSoilP] = useState(initialField?.soil_p ?? '');
  const [soilK, setSoilK] = useState(initialField?.soil_k ?? '');
  const [soilPh, setSoilPh] = useState(initialField?.soil_ph ?? '');
  const [soilType, setSoilType] = useState(initialField?.soil_type || '');

  // Organic vs non-organic farming toggle - a lease-relevant land
  // attribute (separate from crops_marketplace.is_organic, which is
  // per-crop-listing; this is about how the FIELD ITSELF has been
  // farmed, useful to a prospective lessee regardless of what's
  // currently planted). ASSUMPTION: `fields` has no is_organic column
  // yet - same assumption pattern as photo_url above; only the
  // is_organic references here and in handleSave need to change if the
  // real column is named differently.
  const [isOrganic, setIsOrganic] = useState(initialField?.is_organic ?? false);

  const [waterSourceType, setWaterSourceType] = useState(initialField?.water_source_type || '');
  const [waterSourceLat, setWaterSourceLat] = useState(initialField?.water_source_lat ?? null);
  const [waterSourceLng, setWaterSourceLng] = useState(initialField?.water_source_lng ?? null);
  const [waterSourceShared, setWaterSourceShared] = useState(initialField?.water_source_shared || false);
  const [isRecordingWaterSource, setIsRecordingWaterSource] = useState(false);
  const [waterSourceError, setWaterSourceError] = useState(null);

  const [isRecordingPoint, setIsRecordingPoint] = useState(false); // true while a single getCurrentPosition() call is in flight
  const [walkPosition, setWalkPosition] = useState(null);
  const [lastAccuracy, setLastAccuracy] = useState(null);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [lastRawFix, setLastRawFix] = useState(null); // debug: shows EVERY fix, even rejected ones

  // If we're editing a field that HAD a boundary saved, but geojsonToPoints
  // came back empty, flag it clearly instead of letting the person discover
  // it only when Save throws "Set boundary first."
  const boundaryLoadFailed = isEditMode && !!initialField?.boundary_geojson && points.length === 0;

  const computedArea = useMemo(() => calculatePolygonAreaAcres(points), [points]);
  const displayArea = areaOverride ?? computedArea;

  const handlePointAdd = useCallback((pt) => {
    setPoints((prev) => [...prev, pt]);
  }, []);

  const handleUndo = () => {
    setPoints((prev) => {
      const next = prev.slice(0, -1);
      try {
        localStorage.setItem('kisanbit_walk_draft', JSON.stringify(next));
      } catch (_) {}
      return next;
    });
  };
  const handleClear = () => {
    setPoints([]);
    setAreaOverride(null);
    setDrawing(true);
    setRejectedCount(0);
    clearWalkDraft();
  };
  const handleFinishDrawing = () => {
    if (points.length < 3) {
      setError('mark/walk at least 3 points.');
      return;
    }
    setError(null);
    setDrawing(false);
  };

  // Manual "Record Corner Point" mechanism — replaces the old
  // continuous watchPosition() walk-tracking, which kept the GPS radio
  // hot for the whole walk and was a major battery/heat drain. Now the
  // farmer stands at each corner and presses a button; we take exactly
  // one high-accuracy fix per press via getCurrentPosition. Pass
  // maximumAge: 0 so Capacitor never hands back a cached/stale fix from
  // before the farmer walked to this corner.
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
      setLastRawFix({ lat: latitude, lng: longitude, accuracy, time: new Date().toLocaleTimeString() });

      if (accuracy > MIN_ACCURACY_M) {
        setRejectedCount((prev) => prev + 1);
        setError(`GPS accuracy too low (±${Math.round(accuracy)}m, need ≤${MIN_ACCURACY_M}m). Move to open sky and try again.`);
        return;
      }

      setPoints((prev) => {
        const next = [...prev, [latitude, longitude]];
        try {
          localStorage.setItem('kisanbit_walk_draft', JSON.stringify(next));
        } catch (_) {}
        return next;
      });
    } catch (err) {
      // Capacitor Geolocation surfaces a TIMEOUT-type error when no fix
      // arrives in time (very common indoors/under a shed roof) —
      // give the farmer a clear, actionable message instead of a raw
      // stack trace.
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

  const clearWalkDraft = () => {
    try {
      localStorage.removeItem('kisanbit_walk_draft');
    } catch (_) {}
  };

  useEffect(() => {
    if (mode !== 'walk' || isEditMode) return;
    try {
      const saved = localStorage.getItem('kisanbit_walk_draft');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) setPoints(parsed);
      }
    } catch (_) {}
  }, [mode, isEditMode]);

  const handleModeSwitch = (newMode) => {
    setMode(newMode);
    setPoints([]);
    setAreaOverride(null);
    setDrawing(true);
    setRejectedCount(0);
    setLastRawFix(null);
  };

  // Same one-shot high-accuracy GPS pattern as recordCorner above, but for
  // the water source. Deliberately never touches `points`/the map polygon -
  // this location is never drawn anywhere, including in this form itself,
  // per the requirement that the exact point is never shown, only used
  // (with consent) to feed an aggregated flow layer elsewhere.
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

  // Field photo picker - same compress-on-select pattern as Cattle
  // Base/Pond/Service photos.
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

  const { onYoutubeChange, onInstagramChange, onFacebookChange } = useLinkedSocialLinks({
    youtubeUrl, setYoutubeUrl, instagramUrl, setInstagramUrl, facebookUrl, setFacebookUrl,
  });

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Enter field name.');
      return;
    }
    if (points.length < 3) {
      setError('Set boundary first.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const ring = points.map(([lat, lng]) => [lng, lat]);
      ring.push(ring[0]);
      const boundary_geojson = { type: 'Polygon', coordinates: [ring] };
      const area_acres = Number(displayArea.toFixed(2));

      let savedField;

      // Upload a NEW photo if one was picked this session; otherwise
      // keep whatever photo_url the field already had.
      const uploadedPhotoUrl = photoBlob
        ? await uploadFieldAsset(photoBlob, 'field-photos', `${isEditMode ? initialField.id : 'new'}-photo-${Date.now()}`)
        : (isEditMode ? (initialField?.photo_url || null) : null);

      if (isEditMode) {
        const { data, error: updateError } = await supabase
          .rpc('update_field', {
            p_field_id: initialField.id,
            p_name: name.trim(),
            p_boundary_geojson: boundary_geojson,
            p_area_acres: area_acres,
            p_soil_n: soilN !== '' ? Number(soilN) : null,
            p_soil_p: soilP !== '' ? Number(soilP) : null,
            p_soil_k: soilK !== '' ? Number(soilK) : null,
            p_soil_ph: soilPh !== '' ? Number(soilPh) : null,
          });
        if (updateError) throw updateError;
        savedField = data;

        // update_field RPC doesn't take contact/photo/social fields or
        // soil_type - separate direct update, always run (not gated on
        // truthy) so clearing a value back to blank actually saves as null.
        const { data: contactUpdated } = await supabase
          .from('fields')
          .update({
            contact_phone: contactPhone.trim() || null,
            contact_whatsapp: contactWhatsapp.trim() || null,
            photo_url: uploadedPhotoUrl,
            youtube_url: youtubeUrl.trim() || null,
            instagram_url: instagramUrl.trim() || null,
            facebook_url: facebookUrl.trim() || null,
            soil_type: soilType || null,
            water_source_type: waterSourceType || null,
            water_source_lat: waterSourceLat,
            water_source_lng: waterSourceLng,
            water_source_shared: waterSourceShared,
            is_organic: isOrganic,
          })
          .eq('id', savedField.id)
          .select()
          .single();
        if (contactUpdated) savedField = contactUpdated;

        // Re-fetch this field with the boundary_geojson computed column so
        // whatever gets cached/passed up is always in the usable GeoJSON
        // shape — the raw RPC return's `boundary` is still just geography
        // hex, same as a plain select('*') would give us.
        const { data: cleanField } = await supabase
          .from('fields')
          .select('*, boundary_geojson')
          .eq('id', savedField.id)
          .single();
        if (cleanField) savedField = cleanField;

        onSaved?.(savedField);
        // Lets FullMapModal (if already open) resync fields without a
        // full pan/zoom or view-toggle - see its 'kisanbit:field-saved'
        // listener. Fields are no longer re-fetched on every pan there,
        // so this is now the only way an in-progress map session hears
        // about an edit made through this form.
        window.dispatchEvent(new CustomEvent('kisanbit:field-saved'));
      } else {
        const { data, error: rpcError } = await supabase.rpc('create_field', {
          p_name: name.trim(),
          p_boundary_geojson: boundary_geojson,
          p_area_acres: area_acres,
        });
        if (rpcError) throw rpcError;
        savedField = data;

        const hasExtraDetails = soilN !== '' || soilP !== '' || soilK !== '' || soilPh !== '' || soilType !== ''
          || waterSourceType !== '' || waterSourceLat != null
          || contactPhone.trim() || contactWhatsapp.trim() || uploadedPhotoUrl
          || youtubeUrl.trim() || instagramUrl.trim() || facebookUrl.trim()
          || isOrganic;

        if (hasExtraDetails) {
          const { data: detailsUpdated } = await supabase
            .from('fields')
            .update({
              soil_n: soilN !== '' ? Number(soilN) : null,
              soil_p: soilP !== '' ? Number(soilP) : null,
              soil_k: soilK !== '' ? Number(soilK) : null,
              soil_ph: soilPh !== '' ? Number(soilPh) : null,
              soil_type: soilType || null,
              soil_tested_on: new Date().toISOString().split('T')[0],
              water_source_type: waterSourceType || null,
              water_source_lat: waterSourceLat,
              water_source_lng: waterSourceLng,
              water_source_shared: waterSourceShared,
              contact_phone: contactPhone.trim() || null,
              contact_whatsapp: contactWhatsapp.trim() || null,
              photo_url: uploadedPhotoUrl,
              youtube_url: youtubeUrl.trim() || null,
              instagram_url: instagramUrl.trim() || null,
              facebook_url: facebookUrl.trim() || null,
              is_organic: isOrganic,
            })
            .eq('id', savedField.id)
            .select()
            .single();
          if (detailsUpdated) savedField = detailsUpdated;
        }

        try {
          localStorage.removeItem('kisanbit_walk_draft');
        } catch (_) {}

        const { data: cleanField } = await supabase
          .from('fields')
          .select('*, boundary_geojson')
          .eq('id', savedField.id)
          .single();
        if (cleanField) savedField = cleanField;

        onSaved?.(savedField);
        window.dispatchEvent(new CustomEvent('kisanbit:field-saved'));
      }
    } catch (err) {
      setError(err.message || 'Field save failed, please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
      }}
    >
      <div
        className="kb-card"
        style={{ padding: 16, maxWidth: 520, width: '100%', maxHeight: '90vh', overflowY: 'auto', position: 'relative', display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            style={{
              position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: '50%',
              border: 'none', background: 'var(--color-border)', color: 'var(--color-ink)', fontWeight: 700,
              cursor: 'pointer', lineHeight: 1, zIndex: 1,
            }}
          >
            ✕
          </button>
        )}

      <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-navy)' }}>
        {isEditMode ? 'Edit Field' : 'Add Field'}
      </div>

      {boundaryLoadFailed && (
        <div style={{
          padding: 10, borderRadius: 8, background: '#fff4e5', border: '1px solid var(--color-gold)',
          color: 'var(--color-ink)', fontSize: 13,
        }}>
          ⚠️ This field has a saved boundary, but it couldn't be loaded onto the map (check the browser console for details — likely a data-format mismatch from the database). You'll need to redraw the boundary below before saving, or Cancel to leave the old one untouched.
        </div>
      )}

      {/* 1. Name */}
      <input
        type="text"
        placeholder="Field name (e.g. Paddy field - back)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border, #ddd)', fontSize: 14 }}
      />

      {/* 2. Photo - same always-visible camera-badge pattern as Cattle
          Base/Pond/Service. */}
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6, display: 'block' }}>
          Field Photo (optional)
        </label>
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
                  '🌾'
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
            Tap to add a photo of this field.
          </div>
        </div>
        {photoError && <div style={{ color: 'var(--color-danger)', fontSize: 12, marginTop: 4 }}>{photoError}</div>}
      </div>

      {/* 3. Basic details */}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6, display: 'block' }}>
            Contact Phone 
          </label>
          <input
            type="tel"
            placeholder="e.g. 9876543210"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border, #ddd)', fontSize: 14, width: '100%' }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6, display: 'block' }}>
            WhatsApp (optional)
          </label>
          <input
            type="tel"
            placeholder="e.g. 9876543210"
            value={contactWhatsapp}
            onChange={(e) => setContactWhatsapp(e.target.value)}
            style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border, #ddd)', fontSize: 14, width: '100%' }}
          />
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: -6 }}>
        Shown to buyers alongside this field's crops.
      </div>

      {/* 4. Map (boundary + its own mode/draw controls) */}
      <div ref={boundarySectionRef} style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => handleModeSwitch('tap')} style={{ flex: 1, padding: 10, borderRadius: 8, border: `2px solid ${mode === 'tap' ? 'var(--color-gold)' : 'var(--color-border)'}`, background: mode === 'tap' ? 'rgba(222, 160, 59, 0.18)' : 'var(--color-card)', color: 'var(--color-ink)', fontWeight: 700, fontSize: 13 }}>
          Tap on Map
        </button>
        <button type="button" onClick={() => handleModeSwitch('walk')} style={{ flex: 1, padding: 10, borderRadius: 8, border: `2px solid ${mode === 'walk' ? 'var(--color-gold)' : 'var(--color-border)'}`, background: mode === 'walk' ? 'rgba(222, 160, 59, 0.18)' : 'var(--color-card)', color: 'var(--color-ink)', fontWeight: 700, fontSize: 13 }}>
          GPS Corner Points
        </button>
      </div>

      <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
        {mode === 'tap' && drawing && `touch map and add boundary points (${points.length} points marked).`}
        {mode === 'walk' && drawing && (
          <>
            {points.length} corner{points.length === 1 ? '' : 's'} recorded.
            {lastAccuracy != null && ` Last accuracy: ${Math.round(lastAccuracy)}m.`}
            {rejectedCount > 0 && ` (${rejectedCount} low-accuracy attempt${rejectedCount === 1 ? '' : 's'} rejected.)`}
            {points.length === 0 && ' Stand at each corner of the field and press "Record Corner Point".'}
          </>
        )}
        {!drawing && `Boundary set. Area: ${displayArea.toFixed(2)} acres`}
      </div>

      {/* DEBUG ROW - shows the raw last GPS fix, even rejected ones, so
          you can visually confirm the phone IS sending coordinates. */}
      {mode === 'walk' && lastRawFix && (
        <div style={{ fontSize: 11, fontFamily: 'monospace', background: 'var(--color-surface-variant, #f5f5f5)', padding: 8, borderRadius: 6, color: 'var(--color-on-surface-variant, #555)' }}>
          Last fix [{lastRawFix.time}]: lat {lastRawFix.lat.toFixed(6)}, lng {lastRawFix.lng.toFixed(6)}, accuracy {Math.round(lastRawFix.accuracy)}m
        </div>
      )}

      <div style={{ height: 300, minHeight: 300, flexShrink: 0, borderRadius: 10, overflow: 'hidden' }}>
        <MapContainer
          center={walkPosition || (points[0] || gpsCenter || DEFAULT_CENTER)}
          zoom={17}
          preferCanvas={true}
          style={{ height: '100%', width: '100%', background: 'var(--color-bg)' }}
        >
          {/* Was a plain react-leaflet <TileLayer> - no caching, every
              zoom/pan re-downloaded tiles fresh from OSM. Swapped for
              OfflineTileLayer (same fix applied to FullMapModal.jsx this
              session) - now caches tiles to IndexedDB via leaflet.offline,
              so revisiting the same area (next zoom, next time this form
              opens) reads from cache instead of network. */}
          <OfflineTileLayer
            maxZoom={16}
            keepBuffer={1}
            detectRetina={false}
          />
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

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {mode === 'tap' && drawing && (
          <>
            <button type="button" onClick={handleUndo} disabled={points.length === 0} style={{ ...secondaryButtonStyle, minHeight: 48 }}>Undo last point</button>
            <button type="button" onClick={handleClear} disabled={points.length === 0} style={{ ...secondaryButtonStyle, minHeight: 48 }}>Clear</button>
            <button type="button" onClick={handleFinishDrawing} disabled={points.length < 3} style={{ ...secondaryButtonStyle, minHeight: 48, fontWeight: 700 }}>Finish boundary ✓</button>
          </>
        )}

        {mode === 'walk' && drawing && (
          <>
            <button
              type="button"
              onClick={recordCorner}
              disabled={isRecordingPoint}
              style={{ flex: '1 1 100%', minHeight: 48, padding: '10px 0', borderRadius: 8, border: 'none', background: 'var(--color-success)', color: '#fff', fontWeight: 700 }}
            >
              {isRecordingPoint ? 'Getting GPS fix…' : '📍 Record Corner Point'}
            </button>
            <button type="button" onClick={handleUndo} disabled={points.length === 0} style={{ ...secondaryButtonStyle, minHeight: 48 }}>Undo last point</button>
            <button type="button" onClick={handleClear} disabled={points.length === 0} style={{ ...secondaryButtonStyle, minHeight: 48 }}>Clear</button>
            <button type="button" onClick={handleFinishDrawing} disabled={points.length < 3} style={{ ...secondaryButtonStyle, minHeight: 48, fontWeight: 700 }}>Finish boundary ✓</button>
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

      {/* 5. Water source - always visible (not gated on `drawing`), same
          as AddPondForm's Water Source section, so this button doesn't
          appear to be "missing" while the farmer is still drawing the
          boundary above. */}
      <div className="kb-card" style={{ padding: 10, marginBottom: 8 }}>
        <label style={{ fontWeight: 700, fontSize: 14, display: 'block', marginBottom: 8 }}>
          💧 Water Source
        </label>

        <select value={waterSourceType} onChange={(e) => setWaterSourceType(e.target.value)} style={{ ...inputBoxStyle, width: '100%', marginBottom: 8 }}>
          <option value="">Water source type (optional)</option>
          <option value="wet">Wet (year-round)</option>
          <option value="dry">Dry (seasonal)</option>
        </select>

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

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={waterSourceShared}
            onChange={(e) => setWaterSourceShared(e.target.checked)}
            style={{ width: 18, height: 18, marginTop: 1, flexShrink: 0 }}
          />
          <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
            Share anonymously to help show groundwater flow to other farmers nearby - your exact point is never shown to anyone, only used as part of an area-wide pattern.
          </span>
        </label>
      </div>

      {/* 6. List: soil details */}
      {!drawing && (
        <div className="kb-card" style={{ padding: 10, marginBottom: 8 }}>
          <label style={{ fontWeight: 700, fontSize: 14, display: 'block', marginBottom: 8 }}>
            🌱 Soil Health (N-P-K &amp; pH)
          </label>

          {/* Organic vs non-organic - a lease-relevant attribute of the
              land itself (how it's been farmed), not tied to any one
              crop listing. Same segmented-button visual pattern as the
              tap/walk boundary-mode toggle above, for consistency. */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6, display: 'block' }}>
              Farming type (useful for lease listings)
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setIsOrganic(true)}
                style={{ flex: 1, padding: 10, borderRadius: 8, border: `2px solid ${isOrganic ? 'var(--color-gold)' : 'var(--color-border)'}`, background: isOrganic ? 'rgba(222, 160, 59, 0.18)' : 'var(--color-card)', color: 'var(--color-ink)', fontWeight: 700, fontSize: 13 }}
              >
                🌿 Organic
              </button>
              <button
                type="button"
                onClick={() => setIsOrganic(false)}
                style={{ flex: 1, padding: 10, borderRadius: 8, border: `2px solid ${!isOrganic ? 'var(--color-gold)' : 'var(--color-border)'}`, background: !isOrganic ? 'rgba(222, 160, 59, 0.18)' : 'var(--color-card)', color: 'var(--color-ink)', fontWeight: 700, fontSize: 13 }}
              >
                Non-organic
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
            <input type="number" step="0.1" placeholder="Nitrogen (N)" value={soilN} onChange={(e) => setSoilN(e.target.value)} style={{ ...inputBoxStyle, flex: 1, minWidth: 90 }} />
            <input type="number" step="0.1" placeholder="Phosphorus (P)" value={soilP} onChange={(e) => setSoilP(e.target.value)} style={{ ...inputBoxStyle, flex: 1, minWidth: 90 }} />
            <input type="number" step="0.1" placeholder="Potassium (K)" value={soilK} onChange={(e) => setSoilK(e.target.value)} style={{ ...inputBoxStyle, flex: 1, minWidth: 90 }} />
            <input type="number" step="0.1" min="0" max="14" placeholder="Soil pH (0-14)" value={soilPh} onChange={(e) => setSoilPh(e.target.value)} style={{ ...inputBoxStyle, flex: 1, minWidth: 90 }} />
          </div>
          <select value={soilType} onChange={(e) => setSoilType(e.target.value)} style={{ ...inputBoxStyle, width: '100%' }}>
            <option value="">Soil type (optional)</option>
            <option value="alluvial">Alluvial</option>
            <option value="black">Black (regur / cotton soil)</option>
            <option value="red">Red</option>
            <option value="red_yellow">Red &amp; yellow</option>
            <option value="laterite">Laterite</option>
            <option value="arid_desert">Arid / desert</option>
            <option value="saline">Saline</option>
            <option value="alkaline">Alkaline</option>
            <option value="peaty_marshy">Peaty / marshy</option>
            <option value="forest_mountain">Forest / mountain</option>
            <option value="sandy">Sandy</option>
            <option value="clay">Clay</option>
            <option value="loamy">Loamy</option>
            <option value="silty">Silty</option>
            <option value="other">Other</option>
          </select>
        </div>
      )}

      {/* 7. Social links */}
      <div className="kb-card" style={{ padding: 10, marginBottom: 8 }}>
        <label style={{ fontWeight: 700, fontSize: 14, display: 'block', marginBottom: 8 }}>
          Social Links
        </label>
        <div style={{ marginBottom: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6, display: 'block' }}>
            YouTube Link (optional)
          </label>
          <input type="url" value={youtubeUrl} onChange={(e) => onYoutubeChange(e.target.value)} placeholder="https://youtube.com/..." style={inputBoxStyle} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6, display: 'block' }}>
            Instagram Link (optional)
          </label>
          <input type="url" value={instagramUrl} onChange={(e) => onInstagramChange(e.target.value)} placeholder="https://instagram.com/..." style={inputBoxStyle} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6, display: 'block' }}>
            Facebook Link (optional)
          </label>
          <input type="url" value={facebookUrl} onChange={(e) => onFacebookChange(e.target.value)} placeholder="https://facebook.com/..." style={inputBoxStyle} />
          {(youtubeUrl.trim() || instagramUrl.trim() || facebookUrl.trim()) && (
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
              Fill in just one - we will copy it to the other blank fields automatically. Type a different link in any field to keep it distinct.
            </div>
          )}
        </div>
      </div>


      {error && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button type="button" onClick={handleSave} disabled={saving || drawing || !name.trim()} style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', background: 'var(--color-navy)', color: '#fff', fontWeight: 700, opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving...' : isEditMode ? 'Save Changes' : 'Save Field'}
        </button>
        {onCancel && <button type="button" onClick={onCancel} disabled={saving} style={secondaryButtonStyle}>Cancel</button>}
      </div>
      </div>
    </div>
  );
}