// src/components/TransferRequestsBanner.jsx
//
// Shows pending ownership-transfer requests addressed to the current
// user (via the notifications table), with Accept/Reject buttons.
// Mount this globally in App.jsx, same as AlertBanner.
//
// FIX (root cause of the infinite-loop / egress spike / "cannot add
// postgres_changes callbacks for realtime after subscribe()" error):
// the old version's `load()` function was used BOTH as the initial
// fetch AND as the realtime event callback, and it created + subscribed
// a brand-new channel every single time it ran. So every DB change
// fired load() -> which created another channel -> subscribed -> which
// itself fired load() on every future change -> which created yet
// another channel... an exponentially growing stack of live
// subscriptions, each one hammering Supabase with fresh selects. That's
// what blew up your egress and threw the "cannot add postgres_changes
// callbacks after subscribe()" error (the client refuses to re-add
// listeners to a channel/topic that's already subscribed).
//
// Fix: `load()` now ONLY fetches data. The channel is created and
// subscribed exactly once, inside the effect, and its callback simply
// calls load() again (no channel creation inside the callback).

import { useEffect, useState } from 'react';
import { supabase } from '../config/supabaseClient';
import { toUserMessage } from '../utils/errorHandling';
import { useUser } from '../context/UserContext';

export default function TransferRequestsBanner() {
  const [requests, setRequests] = useState([]);
  // Read from context instead of calling supabase.auth.getUser() here -
  // App.jsx already resolved this once. See UserContext.jsx.
  const { user } = useUser();

  useEffect(() => {
    if (!user) return;

    let channel;
    let cancelled = false;

    // Fetch-only. Never creates or subscribes to a channel.
    async function load() {
      const { data } = await supabase
        .from('cattle_transfer_requests')
        .select('id, cattle_id, from_owner_id, status, cattle:cattle_id (name)')
        .eq('to_owner_id', user.id)
        .eq('status', 'pending');

      if (!cancelled) setRequests(data || []);
    }

    async function init() {
      // Initial fetch.
      await load();
      if (cancelled) return;

      // Subscribe exactly ONCE. The callback only re-fetches; it never
      // touches the channel again.
      channel = supabase
        // Per-mount suffix - see AlertBanner.jsx for why.
        .channel(`transfer-requests-${user.id}-${Math.random().toString(36).slice(2)}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'cattle_transfer_requests', filter: `to_owner_id=eq.${user.id}` },
          () => load()
        )
        .subscribe();
    }

    init();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [user?.id]);

  const [actionError, setActionError] = useState(null);

  const handleAccept = async (id) => {
    setActionError(null);
    const { error } = await supabase.rpc('accept_transfer_request', { p_request_id: id });
    if (error) {
      // Previously ignored - a failed RPC (network blip, RLS denial,
      // already-actioned request) silently vanished the card from the
      // list below anyway, making the farmer think it worked when it
      // didn't. Now it stays in the list and shows a message.
      setActionError(toUserMessage(error, 'Could not accept the transfer. Try again.'));
      return;
    }
    setRequests((prev) => prev.filter((r) => r.id !== id));
  };

  const handleReject = async (id) => {
    setActionError(null);
    const { error } = await supabase.rpc('reject_transfer_request', { p_request_id: id });
    if (error) {
      setActionError(toUserMessage(error, 'Could not reject the transfer. Try again.'));
      return;
    }
    setRequests((prev) => prev.filter((r) => r.id !== id));
  };

  if (requests.length === 0 && !actionError) return null;

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 6000, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {actionError && (
        <div className="kb-card" style={{ padding: 10, fontSize: 12, color: 'var(--color-danger)', background: 'var(--color-card)' }}>
          {actionError}
        </div>
      )}
      {requests.map((r) => (
        <div key={r.id} className="kb-card" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--color-gold)' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {r.cattle?.name} ni meeku transfer cheyalani request vachindi.
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => handleAccept(r.id)} style={{ padding: '6px 10px', minHeight: 44, minWidth: 44, borderRadius: 8, border: 'none', background: 'var(--color-success)', color: '#fff', fontWeight: 700 }}>Accept</button>
            <button onClick={() => handleReject(r.id)} style={{ padding: '6px 10px', minHeight: 44, minWidth: 44, borderRadius: 8, border: 'none', background: 'var(--color-danger)', color: '#fff', fontWeight: 700 }}>Reject</button>
          </div>
        </div>
      ))}
    </div>
  );
}