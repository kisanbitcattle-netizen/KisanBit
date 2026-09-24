// src/components/ChatModal.jsx
//
// Privacy-focused in-app chat between a buyer and a listing's owner -
// works for a cattle listing, a crop listing, or a field owner
// directly. Replaces direct phone/WhatsApp buttons wherever it's
// used - those only appear here, inside the chat, and only after the
// seller/owner explicitly chooses to share.
//
// Requires the conversations/messages tables + get_or_create_conversation/
// share_phone_number RPCs from chat_schema.sql, and Realtime enabled on
// both tables.
//
// FIXED: this modal used to ALWAYS call get_or_create_conversation on
// mount, no matter who opened it. That RPC always treats auth.uid()
// as the buyer and computes the listing's real owner as the seller -
// so when the seller opened an already-existing conversation from
// MessagesInbox.jsx (passing listingType/listingId, same as the
// buyer-initiated flow), the RPC saw buyer===seller and rejected with
// "You cannot start a chat on your own listing," even though the
// conversation already existed and they were legitimately in it.
// This never showed up from CattleDetailModal/FieldDetailModal
// because those hide the Chat button entirely for the owner - but
// the inbox has no such gate (nor does it need one, since the
// conversation is already real).
//
// Fix: added an optional `conversationId` prop. When passed (the
// inbox path), the modal fetches that exact row directly - RLS
// (conversations_select_participant) already allows either buyer or
// seller to read it - instead of going through the buyer-only RPC.
// listingType/listingId are now optional and only required for the
// original "start or resume a chat as a buyer" flow.
//
// Props:
//   conversationId - id of an existing conversation to open directly
//                     (used by MessagesInbox.jsx). When provided,
//                     listingType/listingId are not required.
//   listingType - 'cattle' | 'crop' | 'field' | 'service' | 'fish'
//                 (required if conversationId is not given)
//   listingId   - id of that cattle / crops_marketplace / fields /
//                 services / pond_fish_stock row (required if
//                 conversationId is not given)
//   sellerPhone - the seller/owner's phone number, e.g. from the
//                 listing the calling screen already has on hand.
//                 ChatModal never fetches or guesses this itself -
//                 the schema here deliberately has no phone column,
//                 so the number is only ever shown once the caller
//                 passes it in AND the seller has shared.
//   onClose     - close handler (required to render a close button)

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../config/supabaseClient';

function formatTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ChatModal({ conversationId, listingType, listingId, sellerPhone, onClose }) {
  const [currentUserId, setCurrentUserId] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageText, setMessageText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState(null);

  const messagesEndRef = useRef(null);
  const channelRef = useRef(null);

  // Load (or create) the conversation, its message history, and open
  // the realtime subscriptions. Everything tears down on unmount / if
  // the listing or conversation changes (e.g. modal reused for a
  // different listing).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        if (!cancelled) { setError('Please log in to chat.'); setLoading(false); }
        return;
      }
      if (cancelled) return;
      setCurrentUserId(user.id);

      let conv;
      if (conversationId) {
        // Opening an already-known conversation directly (inbox path) -
        // works for either the buyer or the seller, no ownership
        // assumption made. RLS enforces that only an actual
        // participant can read it.
        const { data, error: fetchError } = await supabase
          .from('conversations')
          .select('*')
          .eq('id', conversationId)
          .single();
        if (cancelled) return;
        if (fetchError) {
          setError(fetchError.message || 'Could not open chat.');
          setLoading(false);
          return;
        }
        conv = data;
      } else {
        // Starting or resuming a chat as the buyer on a listing.
        const { data, error: convError } = await supabase
          .rpc('get_or_create_conversation', { p_listing_type: listingType, p_listing_id: listingId })
          .single();
        if (cancelled) return;
        if (convError) {
          setError(convError.message || 'Could not open chat.');
          setLoading(false);
          return;
        }
        conv = data;
      }

      setConversation(conv);

      const { data: history, error: historyError } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: true });
      if (cancelled) return;
      if (!historyError && history) setMessages(history);
      setLoading(false);

      // Realtime: new messages arrive instantly, and if the seller
      // shares their number from another tab/device the buyer's view
      // picks it up without a refresh (conversations UPDATE event).
      const channel = supabase
        .channel(`conversation-${conv.id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conv.id}` },
          (payload) => {
            setMessages((prev) => (
              prev.some((m) => m.id === payload.new.id) ? prev : [...prev, payload.new]
            ));
          }
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'conversations', filter: `id=eq.${conv.id}` },
          (payload) => setConversation(payload.new)
        )
        .subscribe();

      channelRef.current = channel;
    })();

    return () => {
      cancelled = true;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [conversationId, listingType, listingId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const isSeller = !!conversation && currentUserId === conversation.seller_id;

  const handleSend = async (e) => {
    e.preventDefault();
    const text = messageText.trim();
    if (!text || !conversation || sending) return;

    setSending(true);
    setError(null);
    // Optimistic append so the sender's own message feels instant;
    // the realtime INSERT event is de-duped by id in the handler above
    // once it echoes back.
    const optimisticId = `optimistic-${Date.now()}`;
    const optimisticMessage = {
      id: optimisticId,
      conversation_id: conversation.id,
      sender_id: currentUserId,
      text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMessage]);
    setMessageText('');

    const { data: saved, error: sendError } = await supabase
      .from('messages')
      .insert({ conversation_id: conversation.id, sender_id: currentUserId, text })
      .select()
      .single();

    if (sendError) {
      setError('Message failed to send: ' + sendError.message);
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    } else if (saved) {
      setMessages((prev) => prev.map((m) => (m.id === optimisticId ? saved : m)));
    }
    setSending(false);
  };

  const handleShareNumber = async () => {
    if (!conversation || sharing) return;
    if (!window.confirm('Make your phone number visible to this buyer in this chat?')) return;
    setSharing(true);
    setError(null);
    const { data, error: shareError } = await supabase
      .rpc('share_phone_number', { p_conversation_id: conversation.id })
      .single();
    if (shareError) {
      setError(shareError.message || 'Could not share number.');
    } else if (data) {
      setConversation(data);
    }
    setSharing(false);
  };

  const handleUnshareNumber = async () => {
    if (!conversation || sharing) return;
    setSharing(true);
    setError(null);
    const { data, error: unshareError } = await supabase
      .rpc('unshare_phone_number', { p_conversation_id: conversation.id })
      .single();
    if (unshareError) {
      setError(unshareError.message || 'Could not remove shared number.');
    } else if (data) {
      setConversation(data);
    }
    setSharing(false);
  };

  const resolvedListingType = listingType || conversation?.listing_type;

  const title = isSeller
    ? 'Chat with buyer'
    : resolvedListingType === 'field'
      ? 'Chat with farmer'
      : resolvedListingType === 'service'
        ? 'Chat with provider'
        : resolvedListingType === 'fish'
          ? 'Chat with seller'
          : 'Chat with seller';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 5000,
      }}
      onClick={onClose}
    >
      <div
        className="kb-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 480, maxHeight: '85vh', borderRadius: '16px 16px 0 0',
          padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--color-border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-navy)' }}>{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            style={{ background: 'none', border: 'none', fontSize: 20, lineHeight: 1, cursor: 'pointer', color: 'var(--color-muted)' }}
          >
            ×
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-muted)', fontSize: 13 }}>
            Loading chat...
          </div>
        ) : error && !conversation ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-danger)', fontSize: 13 }}>
            {error}
          </div>
        ) : (
          <>
            <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {messages.length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--color-muted)', fontSize: 13, marginTop: 24 }}>
                  No messages yet - say hello.
                </div>
              )}
              {messages.map((m) => {
                const isMine = m.sender_id === currentUserId;
                return (
                  <div
                    key={m.id}
                    style={{
                      alignSelf: isMine ? 'flex-end' : 'flex-start', maxWidth: '78%',
                      background: isMine ? 'var(--color-navy)' : 'var(--color-bg)',
                      color: isMine ? '#fff' : 'var(--color-ink)',
                      borderRadius: 12, padding: '8px 12px',
                    }}
                  >
                    <div style={{ fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
                    <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2, textAlign: 'right' }}>
                      {formatTime(m.created_at)}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Seller-only reveal control, or buyer-facing Call/WhatsApp
                once shared. Neither renders until the seller acts. */}
            <div style={{ padding: '0 16px' }}>
              {isSeller && !conversation?.is_number_shared && (
                <button
                  type="button"
                  onClick={handleShareNumber}
                  disabled={sharing}
                  style={{
                    width: '100%', padding: '10px 0', marginBottom: 8, borderRadius: 8,
                    border: '2px solid var(--color-gold)', background: 'transparent',
                    color: 'var(--color-navy)', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                  }}
                >
                  {sharing ? 'Sharing...' : '+ Share Phone Number'}
                </button>
              )}

              {isSeller && conversation?.is_number_shared && (
                <div
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    marginBottom: 8, padding: '8px 12px', borderRadius: 8,
                    background: 'var(--color-bg)',
                  }}
                >
                  <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>✓ Number shared with this buyer</span>
                  <button
                    type="button"
                    onClick={handleUnshareNumber}
                    disabled={sharing}
                    aria-label="Stop sharing number"
                    style={{
                      border: 'none', background: 'transparent', fontSize: 16, lineHeight: 1,
                      cursor: 'pointer', color: 'var(--color-danger)', padding: 0,
                      opacity: sharing ? 0.5 : 1,
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}

              {!isSeller && conversation?.is_number_shared && sellerPhone && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <a
                    href={`tel:${sellerPhone}`}
                    style={{
                      flex: 1, textAlign: 'center', padding: '10px 0', borderRadius: 8, border: 'none',
                      background: 'var(--color-success)', color: '#fff', fontWeight: 700, fontSize: 13,
                      textDecoration: 'none',
                    }}
                  >
                    📞 Call
                  </a>
                  <a
                    href={`https://wa.me/${sellerPhone.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      flex: 1, textAlign: 'center', padding: '10px 0', borderRadius: 8, border: 'none',
                      background: '#25D366', color: '#fff', fontWeight: 700, fontSize: 13,
                      textDecoration: 'none',
                    }}
                  >
                    WhatsApp
                  </a>
                </div>
              )}
            </div>

            {error && (
              <div style={{ padding: '0 16px 8px', color: 'var(--color-danger)', fontSize: 12 }}>{error}</div>
            )}

            <form
              onSubmit={handleSend}
              style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--color-border)' }}
            >
              <input
                type="text"
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder="Type a message"
                style={{
                  flex: 1, padding: '10px 12px', borderRadius: 20, border: '1px solid var(--color-border)',
                  fontSize: 14, fontFamily: 'inherit', outline: 'none',
                }}
              />
              <button
                type="submit"
                disabled={!messageText.trim() || sending}
                style={{
                  padding: '0 18px', borderRadius: 20, border: 'none', background: 'var(--color-navy)',
                  color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                  opacity: !messageText.trim() || sending ? 0.6 : 1,
                }}
              >
                Send
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}