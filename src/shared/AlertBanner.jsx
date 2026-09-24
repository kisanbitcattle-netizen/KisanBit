// src/components/AlertBanner.jsx
//
// Listens to cattle_alerts in realtime (RLS already scopes this to
// the logged-in farmer's own cattle) and shows a free in-app banner
// the moment a geofence tier is breached. Tier 1 is the "real" free
// channel; tiers 2/3 (SMS/Call) are noted here too since no paid
// provider is wired up yet — the banner is honest about that instead
// of pretending an SMS/call actually went out.

import { useEffect, useState } from 'react';
import { supabase } from '../config/supabaseClient';
import { useUser } from '../context/UserContext';

const TIER_INFO = {
  1: { emoji: '🟢', label: 'Notification', color: 'var(--color-success)' },
  2: { emoji: '🟡', label: 'SMS alert (provider not connected — logged only)', color: 'var(--color-gold-dark)' },
  3: { emoji: '🔴', label: 'Call alert (provider not connected — logged only)', color: 'var(--color-danger)' },
};

const RETURN_INFO = { emoji: '✅', label: 'Returned to safe zone', color: 'var(--color-success)' };

export default function AlertBanner() {
  const [alerts, setAlerts] = useState([]);
  // Read from context instead of calling supabase.auth.getUser() here -
  // App.jsx already resolved this once. See UserContext.jsx.
  const { user } = useUser();

  // NOTE: this file already had the channel set up correctly (.on()
  // attached BEFORE .subscribe(), channel created exactly once,
  // cleanup via removeChannel). The only hardening added here is the
  // `cancelled` guard, so a realtime event or in-flight fetch can't
  // call setState after the component has unmounted (harmless in
  // production, but noisy under React 18 StrictMode's dev-only
  // double-invoke of effects).
  useEffect(() => {
    if (!user) return;

    let cancelled = false;

    const channel = supabase
      // Suffixed with a per-mount random id so a fast unmount/remount
      // (e.g. flipping the Farmer/Buyer toggle quickly, which mounts
      // and unmounts this component) can never end up with two
      // overlapping subscriptions on the exact same topic name.
      .channel(`cattle-alerts-${user.id}-${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'cattle_alerts' },
        async (payload) => {
          const alert = payload.new;
          const { data: cattle } = await supabase
            .from('cattle')
            .select('name')
            .eq('id', alert.cattle_id)
            .single();

          if (cancelled) return;

          setAlerts((prev) => [
            { ...alert, cattleName: cattle?.name || 'Your cattle', id: alert.id },
            ...prev,
          ].slice(0, 3)); // keep at most 3 stacked banners

          // Auto-dismiss after 8 seconds
          setTimeout(() => {
            setAlerts((prev) => prev.filter((a) => a.id !== alert.id));
          }, 8000);
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  if (alerts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 70,
        left: 12,
        right: 12,
        zIndex: 5000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {alerts.map((a) => {
        const isReturn = a.event_type === 'return';
        const info = isReturn ? RETURN_INFO : (TIER_INFO[a.tier] || TIER_INFO[1]);
        return (
          <div
            key={a.id}
            className="kb-card"
            style={{
              padding: '10px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              borderLeft: `4px solid ${info.color}`,
            }}
          >
            <span style={{ fontSize: 20 }}>{info.emoji}</span>
            <div style={{ fontSize: 13 }}>
              {isReturn ? (
                <>
                  <strong>{a.cattleName}</strong> is back in the safe zone ({(a.distance_m / 1000).toFixed(2)} km from home)
                </>
              ) : (
                <>
                  <strong>{a.cattleName}</strong> is {(a.distance_m / 1000).toFixed(2)} km from home —{' '}
                  {info.label}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}