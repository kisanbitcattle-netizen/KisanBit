// src/components/DeviceAnalyticsModal.jsx
//
// Analytics window for a water tank, opened from IoTDeviceDetailModal.
// V1 data = FULL/EMPTY state changes (water_tank_readings, written by the
// tank-ingest Edge Function only when the state changes):
//   - timeline bar over the chosen period
//   - % time full / empty, refills, times emptied
//   - recent changes
// When V2 (ToF, water %) and V4 (motor run-time) land, this window gets
// more sections; the modal shell and range picker stay.
//
// Known V1 limits:
// - Only the TRAILING offline gap is shown as "no data" (from last_seen).
//   Offline gaps inside the period aren't recorded, because rows are
//   written only on change.
// - Newest 2000 changes are NOT guaranteed if a sensor flaps heavily
//   (query is ascending + limit); fine for a tank that changes a few
//   times a day.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../config/supabaseClient';
import TankGauge from './TankGauge';
import { buildTimeline, summarize, formatDateTime, isTankOnline } from '../utils/waterTank';

const HOUR = 60 * 60 * 1000;
const RANGES = {
  '24h': { label: '24 hours', ms: 24 * HOUR },
  '7d': { label: '7 days', ms: 7 * 24 * HOUR },
  '30d': { label: '30 days', ms: 30 * 24 * HOUR },
};

const COLOR_FULL = 'var(--color-success)';
const COLOR_EMPTY = 'var(--color-danger)';
const COLOR_NONE = 'var(--color-border)';

const colorFor = (state) => (state === true ? COLOR_FULL : state === false ? COLOR_EMPTY : COLOR_NONE);

// Accent tint sits behind the value: an unobtrusive way to tie a stat back
// to the FULL/EMPTY colors used everywhere else in this window, without a
// full colored card.
function Stat({ label, value, accent }) {
  return (
    <div style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border)', borderTop: accent ? `3px solid ${accent}` : undefined }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-ink)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--color-muted)' }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}

export default function DeviceAnalyticsModal({ device, tank, onClose }) {
  const [range, setRange] = useState('24h');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null); // { readings, priorState, sinceMs, endMs }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      if (!navigator.onLine) {
        setError('Analytics needs an internet connection.');
        setLoading(false);
        return;
      }

      const endMs = Date.now();
      const sinceMs = endMs - RANGES[range].ms;
      const sinceIso = new Date(sinceMs).toISOString();

      const [inRange, prior] = await Promise.all([
        supabase
          .from('water_tank_readings')
          .select('sensor_status, recorded_at')
          .eq('tank_id', tank.id)
          .gte('recorded_at', sinceIso)
          .order('recorded_at', { ascending: true })
          .limit(2000),
        // State just before the window, so the first segment isn't "no data".
        supabase
          .from('water_tank_readings')
          .select('sensor_status, recorded_at')
          .eq('tank_id', tank.id)
          .lt('recorded_at', sinceIso)
          .order('recorded_at', { ascending: false })
          .limit(1),
      ]);

      if (cancelled) return;
      const failure = inRange.error || prior.error;
      if (failure) {
        console.error('[DeviceAnalyticsModal] fetch failed:', failure.message, failure.details, failure.hint, failure.code);
        setError('Could not load analytics. Try again.');
        setLoading(false);
        return;
      }

      setData({
        readings: inRange.data || [],
        priorState: prior.data?.[0]?.sensor_status ?? null,
        sinceMs,
        endMs,
      });
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [tank.id, range]);

  const view = useMemo(() => {
    if (!data) return null;
    const { readings, priorState, sinceMs, endMs } = data;
    // If the device went offline, stop the last state at last_seen instead of stretching it to "now".
    const lastSeenMs = tank.last_seen ? new Date(tank.last_seen).getTime() : sinceMs;
    const trailingEnd = isTankOnline(tank, endMs) ? endMs : Math.max(sinceMs, Math.min(endMs, lastSeenMs));
    const segments = buildTimeline(readings, priorState, sinceMs, trailingEnd);
    return {
      segments,
      total: endMs - sinceMs,
      sinceMs,
      endMs,
      stats: summarize(segments, readings, priorState),
      recent: [...readings].reverse().slice(0, 8),
      empty: readings.length === 0 && priorState === null,
    };
  }, [data, tank]);

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 16 }}
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

        <h3 className="display-text" style={{ fontSize: 16, color: 'var(--color-ink)', marginBottom: 2, paddingRight: 36 }}>
          Analytics
        </h3>
        <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 14 }}>{device.device_name}</p>

        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {Object.entries(RANGES).map(([key, r]) => (
            <button
              key={key}
              type="button"
              onClick={() => setRange(key)}
              aria-pressed={range === key}
              style={{
                flex: 1, minHeight: 36, borderRadius: 8, fontSize: 13, fontWeight: 600,
                border: range === key ? 'none' : '1px solid var(--color-border, #ccc)',
                background: range === key ? 'var(--color-gold)' : 'transparent',
                color: 'var(--color-ink)',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>

        {loading && <p style={{ fontSize: 13, color: 'var(--color-muted)', padding: '12px 0' }}>Loading…</p>}
        {error && <p style={{ fontSize: 13, color: 'var(--color-danger)', padding: '12px 0' }}>{error}</p>}

        {!loading && !error && view && view.empty && (
          <p style={{ fontSize: 13, color: 'var(--color-muted)', lineHeight: 1.5, padding: '12px 0' }}>
            No readings yet. Data appears here once the tank sends its first FULL or EMPTY reading.
          </p>
        )}

        {!loading && !error && view && !view.empty && (
          <>
            <div style={{ display: 'flex', height: 24, borderRadius: 6, overflow: 'hidden', background: COLOR_NONE, marginBottom: 6 }}>
              {view.segments.map((s, i) => (
                <div
                  key={i}
                  title={`${s.state === true ? 'FULL' : s.state === false ? 'EMPTY' : 'No data'}: ${formatDateTime(s.start)} to ${formatDateTime(s.end)}`}
                  style={{ width: `${((s.end - s.start) / view.total) * 100}%`, background: colorFor(s.state) }}
                />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--color-muted)', marginBottom: 8 }}>
              <span>{formatDateTime(view.sinceMs)}</span>
              <span>Now</span>
            </div>
            <div style={{ display: 'flex', gap: 14, marginBottom: 16 }}>
              <LegendDot color={COLOR_FULL} label="Full" />
              <LegendDot color={COLOR_EMPTY} label="Empty" />
              <LegendDot color={COLOR_NONE} label="No data" />
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <Stat label="Time full" value={view.stats.fullPct === null ? '—' : `${view.stats.fullPct}%`} accent={COLOR_FULL} />
              <Stat label="Time empty" value={view.stats.emptyPct === null ? '—' : `${view.stats.emptyPct}%`} accent={COLOR_EMPTY} />
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <Stat label="Refills" value={view.stats.refills} />
              <Stat label="Times emptied" value={view.stats.emptied} />
            </div>

            {view.recent.length > 0 && (
              <>
                <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6 }}>Recent changes</p>
                <div style={{ border: '1px solid var(--color-border)', borderRadius: 8 }}>
                  {view.recent.map((r, i) => (
                    <div
                      key={r.recorded_at + i}
                      style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', fontSize: 13, borderBottom: i === view.recent.length - 1 ? 'none' : '1px solid var(--color-border)' }}
                    >
                      <span style={{ fontWeight: 700, color: r.sensor_status ? COLOR_FULL : COLOR_EMPTY }}>
                        {r.sensor_status ? 'Became FULL' : 'Became EMPTY'}
                      </span>
                      <span style={{ color: 'var(--color-muted)' }}>{formatDateTime(r.recorded_at)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}