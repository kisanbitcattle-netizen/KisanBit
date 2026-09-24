// src/components/IoTDevicesPanel.jsx
//
// IoT/equipment tracker for HomeScreen - farmers register devices they
// own (3-phase motors, borewell pumps, sensors, etc). Same collapsible-
// card shell and offline-cache-first loading as CattleInfoPanel.jsx /
// FieldInfoPanel.jsx. Unlike the IoTShopModal.jsx "Hardware Store" tab
// (buying new devices), this is a personal inventory/tracker of
// equipment the farmer already has - separate concept, separate table
// (iot_devices, see add_iot_ponds_tables.sql).
//
// ASSUMPTIONS (flag for confirmation, table is brand new):
// 1. Always renders the logged-in farmer's own devices, regardless of
//    the Farmer/Buyer toggle - same as FieldInfoPanel, that toggle only
//    changes what MapPreviewCard/FullMapModal show. No buyer-facing
//    view exists or is planned for this panel.
// 2. Simple full-refetch-on-change pattern (no delta-sync optimization),
//    same reasoning as FieldInfoPanel: this table's realtime volume
//    per farmer is expected to be low (a handful of devices, rarely
//    added/edited), so the CattleInfoPanel-style delta-fetch
//    optimization isn't worth the complexity here.
// WATER TANK INTEGRATION (added):
// "Water Tank" is a device type here. A tank card shows live FULL / EMPTY
// and opens IoTDeviceDetailModal (status + analytics). Live data comes from
// water_tanks (linked 1:1 via water_tanks.iot_device_id), written by the
// tank-ingest Edge Function; this file only reads it. Adding a Water Tank
// saves the iot_devices row first, then opens AddWaterTankModal
// (Bluetooth + Wi-Fi setup). Motors get the same tap-for-details window in V4.
//
// 3. Add/Edit device form is inline in this file rather than a
//    separate component (unlike AddCropForm.jsx) - the form is short
//    enough (4 fields) that splitting it out seemed like unnecessary
//    indirection for a first pass; flag if a separate reusable form
//    component is actually wanted.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../config/supabaseClient';
import { offlineCache } from '../../utils/offlineCache';
import SectionBoxHeader from '../../shared/SectionBoxHeader';
import CardHeaderStrip from '../../shared/CardHeaderStrip';
import IoTDeviceDetailModal from './IoTDeviceDetailModal';
import AddWaterTankModal from './AddWaterTankModal';
import TankGauge from './TankGauge';
import { isTankOnline, tankLevel, LEVEL_LABEL } from '../../utils/waterTank';
import { TANK_SHAPES, feetInchesToCm, cmToFeetInches } from '../../utils/tankVolume';
import { useUser } from '../../context/UserContext';

const DEVICE_TYPE_OPTIONS = [
  '3-Phase Motor',
  'Borewell Pump',
  'Water Pump',
  'Water Tank',
  'Soil Sensor',
  'Weather Station',
  'Solar Panel',
  'Other',
];

// Header-avatar fallback per device type, same idea as CROP_EMOJI in
// CropCard.jsx / ANIMAL_EMOJI in animalTaxonomy.js.
const DEVICE_TYPE_EMOJI = {
  '3-Phase Motor': '⚡',
  'Borewell Pump': '🕳️',
  'Water Pump': '💧',
  'Water Tank': '🚰',
  'Soil Sensor': '🌱',
  'Weather Station': '🌦️',
  'Solar Panel': '☀️',
  Other: '🔧',
};

// Types that have live data + a detail window when tapped.
const SMART_TYPES = ['Water Tank'];

// Tank cache helpers: try/catch so an unregistered offlineCache key only
// disables caching instead of breaking the load.
const TANK_CACHE_KEY = 'waterTanksPanel';
async function cacheGetTanks() {
  try {
    return (await offlineCache.getAll(TANK_CACHE_KEY)) || [];
  } catch (e) {
    console.warn('[IoTDevicesPanel] tank cache read skipped:', e?.message);
    return [];
  }
}
function cachePutTanks(items) {
  try {
    const p = offlineCache.putAll(TANK_CACHE_KEY, items);
    if (p?.catch) p.catch((e) => console.warn('[IoTDevicesPanel] tank cache write skipped:', e?.message));
  } catch (e) {
    console.warn('[IoTDevicesPanel] tank cache write skipped:', e?.message);
  }
}
const upsertTank = (list, row) =>
  list.some((t) => t.id === row.id)
    ? list.map((t) => (t.id === row.id ? { ...t, ...row } : t))
    : [row, ...list];

// Two small number inputs (feet, inches) side by side - the unit farmers
// usually quote tank sizes in - instead of one field in an unfamiliar unit.
function FeetInchesField({ label, feet, inches, onFeet, onInches }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            value={feet}
            onChange={(e) => onFeet(e.target.value)}
            style={{ width: '100%', padding: '10px 34px 10px 12px', borderRadius: 8, border: '1px solid var(--color-border, #ccc)', boxSizing: 'border-box' }}
          />
          <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--color-muted)' }}>ft</span>
        </div>
        <div style={{ flex: 1, position: 'relative' }}>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            max="11"
            value={inches}
            onChange={(e) => onInches(e.target.value)}
            style={{ width: '100%', padding: '10px 34px 10px 12px', borderRadius: 8, border: '1px solid var(--color-border, #ccc)', boxSizing: 'border-box' }}
          />
          <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--color-muted)' }}>in</span>
        </div>
      </div>
    </div>
  );
}

function DeviceForm({ initialDevice, onSaved, onCancel }) {
  const [deviceType, setDeviceType] = useState(initialDevice?.device_type || DEVICE_TYPE_OPTIONS[0]);
  const [deviceName, setDeviceName] = useState(initialDevice?.device_name || '');
  const [brand, setBrand] = useState(initialDevice?.brand || '');
  const [installDate, setInstallDate] = useState(initialDevice?.install_date || '');
  const [notes, setNotes] = useState(initialDevice?.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Tank geometry, only asked for device_type "Water Tank". Feet/inches in
  // the UI, converted to centimeters right before saving so the database
  // (and V2's liters math) never deals with mixed units.
  const initLen = cmToFeetInches(initialDevice?.tank_length_cm);
  const initBrd = cmToFeetInches(initialDevice?.tank_breadth_cm);
  const initDia = cmToFeetInches(initialDevice?.tank_diameter_cm);
  const initHt = cmToFeetInches(initialDevice?.tank_height_cm);
  const [tankShape, setTankShape] = useState(initialDevice?.tank_shape || 'rectangular');
  const [lengthFt, setLengthFt] = useState(initLen.feet || '');
  const [lengthIn, setLengthIn] = useState(initLen.inches || '');
  const [breadthFt, setBreadthFt] = useState(initBrd.feet || '');
  const [breadthIn, setBreadthIn] = useState(initBrd.inches || '');
  const [diameterFt, setDiameterFt] = useState(initDia.feet || '');
  const [diameterIn, setDiameterIn] = useState(initDia.inches || '');
  const [heightFt, setHeightFt] = useState(initHt.feet || '');
  const [heightIn, setHeightIn] = useState(initHt.inches || '');

  const isTank = deviceType === 'Water Tank';

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!deviceName.trim()) {
      setError('Enter a name for this device.');
      return;
    }
    setSaving(true);
    setError(null);

    const { data: { user } } = await supabase.auth.getUser();
    const payload = {
      owner_id: user.id,
      device_type: deviceType,
      device_name: deviceName.trim(),
      brand: brand.trim() || null,
      install_date: installDate || null,
      notes: notes.trim() || null,
      updated_at: new Date().toISOString(),
      // Cleared whenever the type isn't (or is no longer) Water Tank, so a
      // re-typed device never carries stale tank geometry.
      tank_shape: isTank ? tankShape : null,
      tank_length_cm: isTank && tankShape === 'rectangular' ? feetInchesToCm(lengthFt, lengthIn) || null : null,
      tank_breadth_cm: isTank && tankShape === 'rectangular' ? feetInchesToCm(breadthFt, breadthIn) || null : null,
      tank_diameter_cm: isTank && tankShape === 'cylindrical' ? feetInchesToCm(diameterFt, diameterIn) || null : null,
      tank_height_cm: isTank ? feetInchesToCm(heightFt, heightIn) || null : null,
    };

    const query = initialDevice
      ? supabase.from('iot_devices').update(payload).eq('id', initialDevice.id).select().single()
      : supabase.from('iot_devices').insert(payload).select().single();

    const { data, error: saveError } = await query;
    setSaving(false);

    if (saveError) {
      setError('Could not save this device. Try again.');
      return;
    }
    onSaved(data, !initialDevice);
  };

  return (
    <form onSubmit={handleSubmit}>
      <h3 className="display-text" style={{ fontSize: 16, color: 'var(--color-ink)', marginBottom: 14 }}>
        {initialDevice ? 'Update Device' : 'Add IoT Device'}
      </h3>

      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>
        Device type
      </label>
      <select
        value={deviceType}
        onChange={(e) => setDeviceType(e.target.value)}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border, #ccc)', marginBottom: 12, boxSizing: 'border-box' }}
      >
        {DEVICE_TYPE_OPTIONS.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>

      {isTank && (
        <>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>
            Tank shape
          </label>
          <select
            value={tankShape}
            onChange={(e) => setTankShape(e.target.value)}
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border, #ccc)', marginBottom: 12, boxSizing: 'border-box' }}
          >
            {Object.entries(TANK_SHAPES).map(([key, s]) => (
              <option key={key} value={key}>{s.label}</option>
            ))}
          </select>

          {tankShape === 'rectangular' ? (
            <>
              <FeetInchesField label="Length" feet={lengthFt} inches={lengthIn} onFeet={setLengthFt} onInches={setLengthIn} />
              <FeetInchesField label="Breadth" feet={breadthFt} inches={breadthIn} onFeet={setBreadthFt} onInches={setBreadthIn} />
            </>
          ) : (
            <FeetInchesField label="Diameter" feet={diameterFt} inches={diameterIn} onFeet={setDiameterFt} onInches={setDiameterIn} />
          )}
          <FeetInchesField label="Height (full to bottom)" feet={heightFt} inches={heightIn} onFeet={setHeightFt} onInches={setHeightIn} />
          <p style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: -6, marginBottom: 12, lineHeight: 1.4 }}>
            Used to show the tank's total capacity. Optional - leave blank if you're not sure yet.
          </p>
        </>
      )}

      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>
        Name (e.g. "Borewell Motor 1")
      </label>
      <input
        type="text"
        value={deviceName}
        onChange={(e) => setDeviceName(e.target.value)}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border, #ccc)', marginBottom: 12, boxSizing: 'border-box' }}
      />

      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>
        Brand (optional)
      </label>
      <input
        type="text"
        value={brand}
        onChange={(e) => setBrand(e.target.value)}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border, #ccc)', marginBottom: 12, boxSizing: 'border-box' }}
      />

      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>
        Install date (optional)
      </label>
      <input
        type="date"
        value={installDate}
        onChange={(e) => setInstallDate(e.target.value)}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border, #ccc)', marginBottom: 12, boxSizing: 'border-box' }}
      />

      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>
        Notes (optional)
      </label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border, #ccc)', marginBottom: 14, boxSizing: 'border-box', resize: 'vertical' }}
      />

      {error && <p style={{ fontSize: 12, color: 'var(--color-danger)', marginBottom: 12 }}>{error}</p>}

      <div style={{ display: 'flex', gap: 10 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{ flex: 1, minHeight: 44, borderRadius: 8, border: '1px solid var(--color-border, #ccc)', background: 'transparent', color: 'var(--color-ink)', fontWeight: 600 }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          style={{ flex: 1.4, minHeight: 44, borderRadius: 8, border: 'none', background: 'var(--color-gold)', color: 'var(--color-ink)', fontWeight: 700, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : initialDevice ? 'Save Changes' : deviceType === 'Water Tank' ? 'Next: Connect Tank' : 'Add Device'}
        </button>
      </div>
    </form>
  );
}

// Compact tank badge for the device list: the illustrated gauge carries the
// level at a glance, a short line of text next to it carries the words
// (screen readers get the words either way via TankGauge's aria-label).
function TankStatusBadge({ tank, now }) {
  if (!tank) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <TankGauge level="unknown" online={false} size={32} />
        <div>
          <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-ink)' }}>Not connected</p>
          <p style={{ fontSize: 11, color: 'var(--color-muted)' }}>Tap to set up</p>
        </div>
      </div>
    );
  }

  const online = isTankOnline(tank, now);
  const level = tankLevel(tank);
  const hasReading = level === 'full' || level === 'empty';
  const labelColor = !hasReading ? 'var(--color-muted)' : !online ? 'var(--color-muted)' : level === 'full' ? 'var(--color-success)' : 'var(--color-danger)';
  const caption = !hasReading ? 'Waiting for first data' : online ? 'Live' : 'Offline';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <TankGauge level={level} online={online} size={32} />
      <div>
        <p style={{ fontSize: 13, fontWeight: 700, color: labelColor }}>{LEVEL_LABEL[level]}</p>
        <p style={{ fontSize: 11, color: 'var(--color-muted)' }}>{caption}</p>
      </div>
    </div>
  );
}

function DeviceCard({ device, tank, now, onEdit, onDelete, onOpen }) {
  const isSmart = SMART_TYPES.includes(device.device_type);
  return (
    <div className="kb-card" style={{ overflow: 'hidden' }}>
      <CardHeaderStrip
        color="var(--color-gold)"
        avatarFallback={DEVICE_TYPE_EMOJI[device.device_type] || '🔧'}
        onEdit={() => onEdit(device)}
        del={{ mode: 'confirm', itemLabel: 'device', onConfirm: () => onDelete(device) }}
      />
      <div
        role={isSmart ? 'button' : undefined}
        tabIndex={isSmart ? 0 : undefined}
        onClick={isSmart ? () => onOpen(device) : undefined}
        onKeyDown={isSmart ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(device); } } : undefined}
        style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, cursor: isSmart ? 'pointer' : 'default' }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-ink)', marginBottom: 2 }}>{device.device_name}</p>
          <p style={{ fontSize: 12, color: 'var(--color-muted)' }}>
            {device.device_type}{device.brand ? ` · ${device.brand}` : ''}
          </p>
          {device.install_date && (
            <p style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 2 }}>
              Installed {device.install_date}
            </p>
          )}
          {device.device_type === 'Water Tank' && <TankStatusBadge tank={tank} now={now} />}
        </div>
        {isSmart && <span aria-hidden="true" style={{ fontSize: 22, color: 'var(--color-muted)', lineHeight: 1 }}>›</span>}
      </div>
    </div>
  );
}

export default function IoTDevicesPanel({ isOpen, onToggle }) {
  const [devices, setDevices] = useState([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState(null);
  const [actionError, setActionError] = useState(null);
  // Water tank live data + navigation state
  const [tanks, setTanks] = useState([]);
  const [tanksHydrated, setTanksHydrated] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [detailId, setDetailId] = useState(null);       // iot_devices.id whose detail window is open
  const [pairingDevice, setPairingDevice] = useState(null); // iot_devices row being connected over BLE
  // Read from context instead of calling supabase.auth.getUser() here -
  // App.jsx already resolved this once. See UserContext.jsx.
  const { user } = useUser();

  useEffect(() => {
    let channel;
    let cancelled = false;

    async function loadAll(userId) {
      const cached = await offlineCache.getAll('iotDevicesPanel');
      if (cancelled) return;
      if (cached.length) setDevices(cached);

      if (!navigator.onLine) return;

      let query = supabase.from('iot_devices').select('*').order('created_at', { ascending: false });
      if (userId) query = query.eq('owner_id', userId);

      const { data, error } = await query;
      if (cancelled) return;

      if (error) {
        console.error('[IoTDevicesPanel] fetch failed:', error.message, error.details, error.hint, error.code);
        return;
      }

      const finalDevices = data || [];
      offlineCache.putAll('iotDevicesPanel', finalDevices);
      setDevices(finalDevices);
    }

    // Reads `user` straight from context instead of awaiting
    // supabase.auth.getUser() here - App.jsx already resolved it once.
    loadAll(user?.id);

    if (user) {
      channel = supabase
        .channel(`iot-devices-${user.id}-${Math.random().toString(36).slice(2)}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'iot_devices', filter: `owner_id=eq.${user.id}` },
          () => loadAll(user.id)
        )
        .subscribe();
    }

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [user?.id]);

  // ---- Water tank live data (read-only here; written by the Edge Function) ----
  const fetchTanks = useCallback(async () => {
    if (!user?.id || !navigator.onLine) return;
    const { data, error } = await supabase
      .from('water_tanks')
      .select('*')
      .eq('owner_id', user.id);
    if (error) {
      console.error('[IoTDevicesPanel] tank fetch failed:', error.message, error.details, error.hint, error.code);
      return;
    }
    setTanks(data || []);
    setTanksHydrated(true);
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;
    let channel;

    (async () => {
      const cached = await cacheGetTanks();
      if (!cancelled && cached.length) setTanks(cached);
      if (!cancelled) fetchTanks();
    })();

    // A tank reports every ~30s, so merge the payload instead of refetching
    // per event (unlike the iot_devices channel above). DELETE events aren't
    // delivered on filtered channels; local deletes update state directly.
    if (user) {
      channel = supabase
        .channel(`water-tanks-${user.id}-${Math.random().toString(36).slice(2)}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'water_tanks', filter: `owner_id=eq.${user.id}` },
          (payload) => {
            if (payload.eventType === 'DELETE') {
              setTanks((prev) => prev.filter((t) => t.id !== payload.old?.id));
            } else if (payload.new) {
              setTanks((prev) => upsertTank(prev, payload.new));
            }
          }
        )
        .subscribe();
    }

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [user?.id, fetchTanks]);

  // Persist only after a real fetch so an empty initial state never wipes the cache.
  useEffect(() => {
    if (tanksHydrated) cachePutTanks(tanks);
  }, [tanks, tanksHydrated]);

  // Re-evaluate ONLINE/OFFLINE even when no new data arrives.
  useEffect(() => {
    if (!isOpen && !detailId) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, [isOpen, detailId]);

  const tankByDevice = useMemo(() => {
    const map = new Map();
    tanks.forEach((t) => { if (t.iot_device_id) map.set(t.iot_device_id, t); });
    return map;
  }, [tanks]);

  const detailDevice = detailId ? devices.find((d) => d.id === detailId) : null;

  const handleSaved = (savedDevice, isNew) => {
    const isEditing = devices.some((d) => d.id === savedDevice.id);
    const updated = isEditing
      ? devices.map((d) => (d.id === savedDevice.id ? savedDevice : d))
      : [savedDevice, ...devices];
    setDevices(updated);
    offlineCache.putAll('iotDevicesPanel', updated);
    setIsFormOpen(false);
    setEditingDevice(null);
    // New Water Tank: the inventory row is saved, now pair the physical board.
    if (isNew && savedDevice.device_type === 'Water Tank') setPairingDevice(savedDevice);
  };

  const handleEdit = (device) => {
    setEditingDevice(device);
    setIsFormOpen(true);
  };

  const handleDelete = async (device) => {
    setActionError(null);
    const { error } = await supabase.from('iot_devices').delete().eq('id', device.id);
    if (error) {
      setActionError('Could not remove this device. Try again.');
      return;
    }
    const updated = devices.filter((d) => d.id !== device.id);
    setDevices(updated);
    offlineCache.putAll('iotDevicesPanel', updated);
    // The linked water_tanks row is removed server-side (ON DELETE CASCADE).
    setTanks((prev) => prev.filter((t) => t.iot_device_id !== device.id));
  };

  return (
    <div className="kb-card" style={{ overflow: 'hidden', flexShrink: 0 }}>
      <SectionBoxHeader
        icon="🔧"
        title="IoT Devices"
        count={devices.length}
        isOpen={isOpen}
        onToggle={onToggle}
        onAdd={isFormOpen ? undefined : () => { setEditingDevice(null); setIsFormOpen(true); }}
        addLabel="+ Add Device"
      />

      {actionError && (
        <div style={{ margin: '0 12px 12px', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--color-danger)', background: 'var(--color-card)', color: 'var(--color-danger)', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} style={{ background: 'none', border: 'none', color: 'var(--color-danger)', fontWeight: 700, fontSize: 15, cursor: 'pointer', lineHeight: 1 }} aria-label="Dismiss">×</button>
        </div>
      )}

      {isOpen && (
        <div style={{ borderTop: '1px solid var(--color-border)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {devices.length === 0 && (
            <p style={{ padding: 6, color: 'var(--color-muted)' }}>No IoT devices registered yet.</p>
          )}
          {devices.map((d) => (
            <DeviceCard
              key={d.id}
              device={d}
              tank={tankByDevice.get(d.id) || null}
              now={now}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onOpen={(dev) => setDetailId(dev.id)}
            />
          ))}
        </div>
      )}

      {isFormOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) { setIsFormOpen(false); setEditingDevice(null); } }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
        >
          <div className="kb-card" style={{ padding: 16, maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto', position: 'relative' }}>
            <button
              type="button"
              onClick={() => { setIsFormOpen(false); setEditingDevice(null); }}
              aria-label="Close"
              style={{ position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'var(--color-border)', color: 'var(--color-ink)', fontWeight: 700, cursor: 'pointer', lineHeight: 1 }}
            >
              ✕
            </button>
            <DeviceForm
              initialDevice={editingDevice}
              onSaved={handleSaved}
              onCancel={() => { setIsFormOpen(false); setEditingDevice(null); }}
            />
          </div>
        </div>
      )}

      {detailDevice && (
        <IoTDeviceDetailModal
          device={detailDevice}
          tank={tankByDevice.get(detailDevice.id) || null}
          now={now}
          emoji={DEVICE_TYPE_EMOJI[detailDevice.device_type] || '🔧'}
          onClose={() => setDetailId(null)}
          onConnectTank={(dev) => { setDetailId(null); setPairingDevice(dev); }}
        />
      )}

      {pairingDevice && (
        <AddWaterTankModal
          iotDevice={pairingDevice}
          onClose={() => setPairingDevice(null)}
          onAdded={fetchTanks}
        />
      )}
    </div>
  );
}