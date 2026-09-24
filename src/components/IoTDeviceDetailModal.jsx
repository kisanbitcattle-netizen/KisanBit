// src/components/IoTDeviceDetailModal.jsx
//
// Detail window opened by tapping a smart device card in IoTDevicesPanel.
// Today only "Water Tank" is smart. Layout is per device type, so motors
// get their own body later (ON/OFF, timer, Auto) without touching the
// panel list:
//   Water Tank : FULL / EMPTY + live status + "View analytics"
//   Motor (V4) : ON/OFF, timer, Auto mode + run-time analytics
//
// Live data comes from the `tank` prop (water_tanks row linked via
// iot_device_id), which IoTDevicesPanel keeps fresh through realtime.

import { useState } from 'react';
import DeviceAnalyticsModal from './DeviceAnalyticsModal';
import TankGauge from './TankGauge';
import { isTankOnline, tankLevel, LEVEL_LABEL, formatLastUpdate } from '../utils/waterTank';
import { tankCapacityLiters, formatLiters } from '../utils/tankVolume';

const GOLD = 'var(--color-gold)';
const NAVY = 'var(--color-navy)';

function StatusRow({ label, value, tone }) {
  const color =
    tone === 'good' ? 'var(--color-success)'
      : tone === 'bad' ? 'var(--color-danger)'
        : 'var(--color-muted)';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '5px 0', borderBottom: '1px solid var(--color-border)' }}>
      <span style={{ color: 'var(--color-muted)' }}>{label}</span>
      <span style={{ fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

function WaterTankBody({ device, tank, now, onConnectTank, onOpenAnalytics }) {
  if (!tank) {
    const capacity = tankCapacityLiters(device);
    return (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4px 0 18px' }}>
          <TankGauge level="unknown" online={false} size={100} />
          {capacity !== null && (
            <div style={{ fontSize: 12, color: 'var(--color-ink)', marginTop: 10, padding: '4px 10px', borderRadius: 20, border: '1px solid var(--color-border)' }}>
              Holds ~{formatLiters(capacity)} when full
            </div>
          )}
          <p style={{ fontSize: 13, color: 'var(--color-muted)', lineHeight: 1.5, marginTop: 10, textAlign: 'center' }}>
            This tank isn't connected yet. Power on the tank device, then connect it over Bluetooth and set up its Wi-Fi.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onConnectTank(device)}
          style={{ width: '100%', minHeight: 44, borderRadius: 8, border: 'none', background: GOLD, color: NAVY, fontWeight: 700 }}
        >
          Connect tank
        </button>
      </>
    );
  }

  const online = isTankOnline(tank, now);
  const level = tankLevel(tank);
  const hasReading = level === 'full' || level === 'empty';
  const levelColor = !hasReading ? 'var(--color-muted)' : !online ? 'var(--color-muted)' : level === 'full' ? 'var(--color-success)' : 'var(--color-danger)';
  const subtitle = online
    ? 'Live now'
    : tank.last_seen
      ? 'Offline. Showing the last reading.'
      : 'Waiting for first data';
  // From tank geometry alone (no sensor needed). Current level in liters
  // needs a distance reading, which arrives with the V2 ToF sensor.
  const capacity = tankCapacityLiters(device);

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4px 0 18px' }}>
        <TankGauge level={level} online={online} size={100} />
        <div style={{ fontSize: 22, fontWeight: 800, color: levelColor, lineHeight: 1.1, marginTop: 8 }}>{LEVEL_LABEL[level]}</div>
        <div style={{ fontSize: 12, color: 'var(--color-muted)', marginTop: 2 }}>{subtitle}</div>
        {capacity !== null && (
          <div style={{ fontSize: 12, color: 'var(--color-ink)', marginTop: 8, padding: '4px 10px', borderRadius: 20, border: '1px solid var(--color-border)' }}>
            Holds ~{formatLiters(capacity)} when full
          </div>
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        <StatusRow label="Sensor" value={online ? 'ONLINE' : 'OFFLINE'} tone={online ? 'good' : 'bad'} />
        <StatusRow label="Wi-Fi" value={online && tank.wifi_connected ? 'CONNECTED' : 'DISCONNECTED'} tone={online && tank.wifi_connected ? 'good' : 'bad'} />
        <StatusRow label="Cloud" value={online ? 'ONLINE' : 'OFFLINE'} tone={online ? 'good' : 'bad'} />
        <StatusRow label="Last update" value={formatLastUpdate(tank.last_seen)} tone="muted" />
      </div>

      <button
        type="button"
        onClick={onOpenAnalytics}
        style={{ width: '100%', minHeight: 44, borderRadius: 8, border: 'none', background: GOLD, color: NAVY, fontWeight: 700 }}
      >
        View analytics
      </button>
    </>
  );
}

export default function IoTDeviceDetailModal({ device, tank, now, emoji, onClose, onConnectTank }) {
  const [showAnalytics, setShowAnalytics] = useState(false);
  const isTank = device.device_type === 'Water Tank';

  return (
    <>
      <div
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
      >
        <div className="kb-card" style={{ padding: 16, maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto', position: 'relative' }}>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'var(--color-border)', color: 'var(--color-ink)', fontWeight: 700, cursor: 'pointer', lineHeight: 1 }}
          >
            ✕
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, paddingRight: 36 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, border: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>
              {emoji}
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 className="display-text" style={{ fontSize: 16, color: 'var(--color-ink)', margin: 0 }}>{device.device_name}</h3>
              <p style={{ fontSize: 12, color: 'var(--color-muted)', margin: 0 }}>
                {device.device_type}{device.brand ? `, ${device.brand}` : ''}
              </p>
            </div>
          </div>

          {isTank && (
            <WaterTankBody
              device={device}
              tank={tank}
              now={now}
              onConnectTank={onConnectTank}
              onOpenAnalytics={() => setShowAnalytics(true)}
            />
          )}

          {(device.install_date || device.notes) && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
              {device.install_date && (
                <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 4 }}>Installed {device.install_date}</p>
              )}
              {device.notes && (
                <p style={{ fontSize: 12, color: 'var(--color-muted)', lineHeight: 1.5 }}>{device.notes}</p>
              )}
            </div>
          )}
        </div>
      </div>

      {showAnalytics && tank && (
        <DeviceAnalyticsModal device={device} tank={tank} onClose={() => setShowAnalytics(false)} />
      )}
    </>
  );
}