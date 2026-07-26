// src/components/CattleInfoPanel.jsx
//
// The "Get" card below the hero map. Collapsed, it's just a button.
// Tapping it expands a list of all cattle with their latest info
// (name, type, last update time, approx status) — kept live via a
// Supabase realtime subscription so updates land within milliseconds
// of a new LoRa ping being written to the DB.

import { useEffect, useState } from 'react';
import { supabase } from '../config/supabaseClient';

function timeAgo(isoString) {
  if (!isoString) return 'no data yet';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

export default function CattleInfoPanel({ isFarmerView, isOpen, onToggle }) {
  const [cattleList, setCattleList] = useState([]);

  useEffect(() => {
    let channel;

    async function load() {
      const table = isFarmerView ? 'cattle' : 'cattle_public_view';
      const { data, error } = await supabase.from(table).select('*');
      if (error) return;
      setCattleList(data);
    }

    load();

    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      channel = supabase
        .channel(`cattle-info-${user.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'cattle', filter: `owner_id=eq.${user.id}` },
          load
        )
        .subscribe();
    })();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [isFarmerView]);

  return (
    <div
      style={{
        borderRadius: 16,
        background: '#fff',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          padding: 16,
          border: 'none',
          background: '#fff',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 16,
          fontWeight: 'bold',
        }}
      >
        <span>📋 Get Cattle Info ({cattleList.length})</span>
        <span>{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div style={{ borderTop: '1px solid #eee' }}>
          {cattleList.length === 0 && (
            <p style={{ padding: 16, color: '#888' }}>No cattle registered yet.</p>
          )}
          {cattleList.map((c) => (
            <div
              key={c.id}
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid #f0f0f0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontWeight: 'bold' }}>{c.name}</div>
                <div style={{ fontSize: 13, color: '#666' }}>
                  {c.animal_type} · updated {timeAgo(c.last_updated)}
                </div>
              </div>
              {c.is_listed_for_sale && (
                <span
                  style={{
                    fontSize: 12,
                    padding: '4px 8px',
                    borderRadius: 12,
                    background: '#e8f5e9',
                    color: '#2e7d32',
                  }}
                >
                  Listed ₹{c.sale_price}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
