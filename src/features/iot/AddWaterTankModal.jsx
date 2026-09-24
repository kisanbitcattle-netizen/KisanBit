// src/components/AddWaterTankModal.jsx
//
// Connects a physical tank board to an EXISTING iot_devices row (type
// "Water Tank"), opened from IoTDevicesPanel right after "+ Add Device", or
// from the detail window's "Connect tank" button:
//   Scan devices -> Connect (+ pairing PIN) -> pick Wi-Fi -> type password
//   -> device joins Wi-Fi -> Success.
//
// Data path: register_water_tank(device_id, iot_device_id) RPC (server issues
// a per-device token, same server-trusted RPC pattern as create_iot_order in
// IoTShopModal) ->
// token + Wi-Fi credentials go to the ESP32 over the paired BLE link
// (see utils/tankBle.js). No Wi-Fi password is ever stored by the app.
//
// NOTE: if the user backs out after the RPC but before the device joins Wi-Fi,
// the water_tanks row stays (last_seen = null) and the card shows
// "Waiting for first data". Kept on purpose: if Bluetooth drops mid-join the
// device may still have connected. The inventory item can be re-paired any
// time from its detail window.

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../config/supabaseClient';
import { connectToTank, isTankBleSupported } from '../../utils/tankBle';

const GOLD = 'var(--color-gold)';
const NAVY = 'var(--color-navy)';

const WIFI_ERRORS = {
  auth_failed: 'Wrong Wi-Fi password. Check it and try again.',
  ssid_not_found: 'The device could not find that network. Move it closer to the router.',
  timeout: 'The device could not join the network in time. Try again.',
  missing_fields: 'Some setup data was missing. Try again.',
};

function friendlyError(e) {
  if (WIFI_ERRORS[e?.code]) return WIFI_ERRORS[e.code];
  switch (e?.code) {
    case 'unsupported':
      return 'Bluetooth setup is not available in this browser. Use Chrome on Android.';
    case 'pairing_failed':
      return 'Pairing failed. When your phone asks, enter the 6-digit PIN printed on the device.';
    case 'scan_timeout':
      return 'No Wi-Fi networks found. Move the device closer to your router and rescan.';
    case 'provision_timeout':
      return 'The device did not answer in time. Try again.';
    case 'write_failed':
    case 'connect_failed':
      return 'Could not talk to the device over Bluetooth. Try again.';
    default:
      break;
  }
  if (typeof e?.message === 'string' && e.message.includes('already registered')) {
    return 'This tank is already registered to another account.';
  }
  return 'Something went wrong. Try again.';
}

function signalLabel(rssi) {
  if (rssi > -60) return 'Strong';
  if (rssi > -75) return 'Good';
  return 'Weak';
}

export default function AddWaterTankModal({ iotDevice, onClose, onAdded }) {
  const [step, setStep] = useState('start'); // 'start' | 'connecting' | 'wifi' | 'sending' | 'done'
  const [error, setError] = useState(null);
  const [deviceId, setDeviceId] = useState(null);
  const [networks, setNetworks] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState(null); // { ssid, rssi, secure }
  const [password, setPassword] = useState('');

  const sessionRef = useRef(null);
  const stepRef = useRef('start');
  const closedRef = useRef(false);

  const goTo = (next) => {
    stepRef.current = next;
    setStep(next);
  };

  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      sessionRef.current?.disconnect();
    };
  }, []);

  const handleDisconnected = () => {
    if (closedRef.current || stepRef.current === 'done') return;
    sessionRef.current = null;
    setError(
      stepRef.current === 'sending'
        ? 'Bluetooth disconnected while the device was joining Wi-Fi. If it connected, the tank will appear in your list shortly.'
        : 'Bluetooth connection lost. Start again.'
    );
    goTo('start');
  };

  const loadNetworks = async (session) => {
    setScanning(true);
    setError(null);
    try {
      const list = await session.scanWifi();
      setNetworks(list);
      if (list.length === 0) setError('No 2.4 GHz Wi-Fi networks found. The device supports 2.4 GHz only.');
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setScanning(false);
    }
  };

  const handleScanDevices = async () => {
    setError(null);
    goTo('connecting');
    try {
      const session = await connectToTank({ onDisconnect: handleDisconnected });
      sessionRef.current = session;
      setDeviceId(session.deviceId);
      goTo('wifi');
      await loadNetworks(session);
    } catch (e) {
      if (e?.code !== 'cancelled') setError(friendlyError(e));
      goTo('start');
    }
  };

  const handleConnect = async () => {
    const session = sessionRef.current;
    if (!session) {
      setError('Bluetooth connection lost. Start again.');
      goTo('start');
      return;
    }
    if (!selected) {
      setError('Select a Wi-Fi network.');
      return;
    }
    if (selected.secure && !password) {
      setError('Enter the Wi-Fi password.');
      return;
    }

    setError(null);
    goTo('sending');
    try {
      // Idempotent on the server: re-running (e.g. after a wrong password)
      // just re-links and issues a fresh token.
      const { data, error: rpcError } = await supabase.rpc('register_water_tank', {
        p_device_id: session.deviceId,
        p_iot_device_id: iotDevice.id,
      });
      if (rpcError) {
        console.error('[AddWaterTankModal] register failed:', rpcError.message, rpcError.details, rpcError.hint, rpcError.code);
        throw rpcError;
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.out_device_token) throw new Error('No device token returned.');

      await session.provision({ ssid: selected.ssid, password, token: row.out_device_token });

      setPassword('');
      goTo('done');
      onAdded?.();
      session.disconnect();
    } catch (e) {
      if (closedRef.current || stepRef.current === 'start') return; // already handled by disconnect handler
      setError(friendlyError(e));
      goTo('wifi');
    }
  };

  const handleClose = () => {
    if (step === 'sending') return; // don't abandon mid-provisioning
    onClose();
  };

  const title =
    step === 'done' ? 'Tank Connected' : step === 'wifi' || step === 'sending' ? 'Wi-Fi Setup' : 'Connect Tank';

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
    >
      <div className="kb-card" style={{ padding: 16, maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto', position: 'relative' }}>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close"
          disabled={step === 'sending'}
          style={{ position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'var(--color-border)', color: 'var(--color-ink)', fontWeight: 700, cursor: 'pointer', lineHeight: 1, opacity: step === 'sending' ? 0.4 : 1 }}
        >
          ✕
        </button>

        <h3 className="display-text" style={{ fontSize: 16, color: 'var(--color-ink)', marginBottom: 14, paddingRight: 36 }}>
          {title}
        </h3>

        {step === 'start' && (
          <>
            <p style={{ fontSize: 13, color: 'var(--color-muted)', marginBottom: 14, lineHeight: 1.5 }}>
              Connecting <strong>{iotDevice.device_name}</strong>. Power on the tank device and keep it within a few metres of your phone. Your phone will list nearby devices named TANK-XXXX.
            </p>
            {!isTankBleSupported() && (
              <p style={{ fontSize: 13, color: 'var(--color-danger)', marginBottom: 14 }}>
                Bluetooth setup is not available in this browser. Use Chrome on Android.
              </p>
            )}
            {error && <p style={{ fontSize: 13, color: 'var(--color-danger)', marginBottom: 12 }}>{error}</p>}
            <button
              type="button"
              onClick={handleScanDevices}
              disabled={!isTankBleSupported()}
              style={{ width: '100%', minHeight: 44, borderRadius: 8, border: 'none', background: GOLD, color: NAVY, fontWeight: 700, opacity: isTankBleSupported() ? 1 : 0.5 }}
            >
              Scan for devices
            </button>
          </>
        )}

        {step === 'connecting' && (
          <p style={{ fontSize: 13, color: 'var(--color-muted)', lineHeight: 1.5, padding: '8px 0 16px' }}>
            Connecting to the tank. If your phone asks for a pairing PIN, enter the 6-digit PIN printed on the device.
          </p>
        )}

        {step === 'wifi' && (
          <>
            <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
              Connected to <span style={{ fontFamily: 'monospace', color: 'var(--color-ink)' }}>{deviceId}</span>
            </p>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>Wi-Fi network</label>
              <button
                type="button"
                onClick={() => sessionRef.current && loadNetworks(sessionRef.current)}
                disabled={scanning}
                style={{ border: 'none', background: 'transparent', color: 'var(--color-ink)', fontWeight: 600, fontSize: 12, textDecoration: 'underline', opacity: scanning ? 0.5 : 1 }}
              >
                {scanning ? 'Scanning…' : 'Rescan'}
              </button>
            </div>

            <div style={{ border: '1px solid var(--color-border, #ccc)', borderRadius: 8, maxHeight: 200, overflowY: 'auto', marginBottom: 12 }}>
              {networks.length === 0 && (
                <p style={{ padding: 12, fontSize: 13, color: 'var(--color-muted)' }}>
                  {scanning ? 'Looking for networks…' : 'No networks yet.'}
                </p>
              )}
              {networks.map((n) => {
                const isSel = selected?.ssid === n.ssid;
                return (
                  <button
                    key={n.ssid}
                    type="button"
                    onClick={() => { setSelected(n); setPassword(''); setError(null); }}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                      padding: '10px 12px', border: 'none', borderBottom: '1px solid var(--color-border, #ccc)',
                      background: isSel ? 'var(--color-bg)' : 'transparent', color: 'var(--color-ink)',
                      fontSize: 14, fontWeight: isSel ? 700 : 500, textAlign: 'left',
                      outline: isSel ? `2px solid ${GOLD}` : 'none', outlineOffset: -2,
                    }}
                  >
                    <span>{n.secure ? '🔒 ' : ''}{n.ssid}</span>
                    <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>{signalLabel(n.rssi)}</span>
                  </button>
                );
              })}
            </div>

            {selected?.secure && (
              <>
                <label style={labelStyle}>Password for {selected.ssid}</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                  style={{ ...inputStyle, marginBottom: 12 }}
                />
              </>
            )}

            {error && <p style={{ fontSize: 13, color: 'var(--color-danger)', marginBottom: 12 }}>{error}</p>}

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                onClick={handleClose}
                style={{ flex: 1, minHeight: 44, borderRadius: 8, border: '1px solid var(--color-border, #ccc)', background: 'transparent', color: 'var(--color-ink)', fontWeight: 600 }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConnect}
                style={{ flex: 1.4, minHeight: 44, borderRadius: 8, border: 'none', background: GOLD, color: NAVY, fontWeight: 700 }}
              >
                Connect tank
              </button>
            </div>
          </>
        )}

        {step === 'sending' && (
          <p style={{ fontSize: 13, color: 'var(--color-muted)', lineHeight: 1.5, padding: '8px 0 16px' }}>
            Sending Wi-Fi details. The device is joining {selected?.ssid}. This can take up to 30 seconds. Keep this screen open.
          </p>
        )}

        {step === 'done' && (
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', padding: '8px 0' }}>
            <div style={{ fontSize: 36 }}>✅</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: NAVY }}>{iotDevice.device_name} is connected</div>
            <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
              The first reading appears on your dashboard within a few seconds.
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{ marginTop: 6, minHeight: 44, padding: '10px 24px', borderRadius: 8, border: 'none', background: GOLD, color: NAVY, fontWeight: 700 }}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const labelStyle = {
  display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6,
};

const inputStyle = {
  width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border, #ccc)',
  fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box',
};