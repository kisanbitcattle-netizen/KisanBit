// src/components/MessagesInbox.jsx
//
// Profile tab "Messages" section - lists every conversation the
// current user is a participant in (as buyer or seller, across
// cattle/crop/field listings), newest first, via the my_conversations()
// RPC from chat_schema.sql. Tapping a row opens the same ChatModal
// used everywhere else in the app.
//
// Self-contained (owns its own fetch/loading/modal state) so
// ProfileScreen.jsx - already large - only needs one import + one
// <MessagesInbox /> line to get an inbox.

import { useEffect, useState } from 'react';
import { supabase } from '../config/supabaseClient';
import ChatModal from './ChatModal';
import ConfirmModal from './ConfirmModal';

const LISTING_LABEL = { cattle: 'Cattle', crop: 'Crop', field: 'Field' };

// Fixed width for a card inside the horizontal swipe strip below - same
// value and same pattern ProfileScreen.jsx uses for its Fields/Cattle
// Bases/Ponds/Services sections, so Messages now matches them instead
// of being the odd one out with its own scroll-growth.
const STRIP_CARD_WIDTH = 240;

function timeAgo(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString('en-IN');
}

// Full-screen scrollable overlay for "View All" - same overlay/kb-card/
// close-button shell as ProfileScreen.jsx's ListModal, so the two
// sections feel identical even though they live in different files.
function ListModal({ title, onClose, children }) {
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
        style={{
          padding: 16, maxWidth: 480, width: '100%', maxHeight: '90vh',
          overflowY: 'auto', position: 'relative',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: 10, right: 10, width: 28, height: 28, borderRadius: '50%',
            border: 'none', background: 'var(--color-border)', color: 'var(--color-ink)', fontWeight: 700,
            cursor: 'pointer', lineHeight: 1,
          }}
        >
          ✕
        </button>
        <div className="display-text" style={{ fontSize: 16, color: 'var(--color-navy)', marginBottom: 12, paddingRight: 30 }}>
          💬 {title}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export default function MessagesInbox() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openChat, setOpenChat] = useState(null); // { listingType, listingId, sellerPhone } | null

  // Per-row "..." action menu (Delete for me / Delete for everyone /
  // Cancel). menuFor holds the row whose menu is open. confirmDeleteAll
  // holds the row pending the extra danger-confirmation step before a
  // hard delete - "delete for me" fires immediately from the menu since
  // it only ever affects the caller's own view.
  const [menuFor, setMenuFor] = useState(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  // Rows: shown as a horizontal swipe strip (all of them, newest first
  // since my_conversations() already orders that way) by default. This
  // flag controls whether the "View All" vertical-list modal is open -
  // same modal-open role as ProfileScreen.jsx's showAllX state vars.
  const [showAll, setShowAll] = useState(false);

  const handleDeleteForMe = async (row) => {
    setMenuFor(null);
    setDeletingId(row.id);
    setDeleteError(null);
    const { error: rpcError } = await supabase.rpc('delete_conversation_for_me', {
      p_conversation_id: row.id,
    });
    setDeletingId(null);
    if (rpcError) {
      console.error('[MessagesInbox] delete_conversation_for_me failed:', rpcError.message, rpcError.details, rpcError.hint, rpcError.code);
      setDeleteError(`Delete avvaledu: ${rpcError.message}`);
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    if (openChat?.id === row.id) setOpenChat(null);
  };

  const handleDeleteForEveryone = async (row) => {
    setDeletingId(row.id);
    setDeleteError(null);
    const { error: rpcError } = await supabase.rpc('delete_conversation_for_everyone', {
      p_conversation_id: row.id,
    });
    setDeletingId(null);
    if (rpcError) {
      console.error('[MessagesInbox] delete_conversation_for_everyone failed:', rpcError.message, rpcError.details, rpcError.hint, rpcError.code);
      setDeleteError(`Delete avvaledu: ${rpcError.message}`);
      setConfirmDeleteAll(null);
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    if (openChat?.id === row.id) setOpenChat(null);
    setConfirmDeleteAll(null);
  };

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        if (!cancelled) setLoading(false);
        return;
      }
      if (cancelled) return;

      const { data: conversations, error: convError } = await supabase.rpc('my_conversations');
      if (cancelled) return;
      if (convError) {
        setError(convError.message || 'Could not load messages.');
        setLoading(false);
        return;
      }
      if (!conversations || conversations.length === 0) {
        setRows([]);
        setLoading(false);
        return;
      }

      // Batch by listing_type so each table is hit once, not once per
      // conversation row.
      const idsByType = { cattle: [], crop: [], field: [] };
      const counterpartIds = new Set();
      conversations.forEach((c) => {
        idsByType[c.listing_type]?.push(c.listing_id);
        counterpartIds.add(c.buyer_id === user.id ? c.seller_id : c.buyer_id);
      });

      const [
        { data: cattleRows },
        { data: cropRows },
        { data: fieldRows },
        { data: fieldSummaryRows },
        { data: userRows },
      ] = await Promise.all([
        idsByType.cattle.length
          ? supabase.from('cattle').select('id, name, contact_phone, contact_whatsapp').in('id', idsByType.cattle)
          : Promise.resolve({ data: [] }),
        idsByType.crop.length
          ? supabase.from('crops_marketplace').select('id, crop_type, contact_phone, contact_whatsapp').in('id', idsByType.crop)
          : Promise.resolve({ data: [] }),
        idsByType.field.length
          ? supabase.from('fields').select('id, name').in('id', idsByType.field)
          : Promise.resolve({ data: [] }),
        // field_owner_summary is where owner phone/whatsapp actually
        // live (fields itself has no contact columns) - same source
        // FieldDetailModal.jsx already uses for its owner-level chat.
        idsByType.field.length
          ? supabase.from('field_owner_summary').select('field_id, owner_phone, owner_whatsapp').in('field_id', idsByType.field)
          : Promise.resolve({ data: [] }),
        counterpartIds.size
          ? supabase.from('users').select('id, full_name, phone').in('id', Array.from(counterpartIds))
          : Promise.resolve({ data: [] }),
      ]);
      if (cancelled) return;

      const cattleById = Object.fromEntries((cattleRows || []).map((r) => [r.id, r]));
      const cropById = Object.fromEntries((cropRows || []).map((r) => [r.id, r]));
      const fieldById = Object.fromEntries((fieldRows || []).map((r) => [r.id, r]));
      const fieldSummaryById = Object.fromEntries((fieldSummaryRows || []).map((r) => [r.field_id, r]));
      const userById = Object.fromEntries((userRows || []).map((r) => [r.id, r]));

      const enriched = conversations.map((c) => {
        const isSeller = c.seller_id === user.id;
        const counterpart = userById[isSeller ? c.buyer_id : c.seller_id];

        let listingLabel = LISTING_LABEL[c.listing_type] || c.listing_type;
        let sellerPhone = null;

        if (c.listing_type === 'cattle') {
          const listing = cattleById[c.listing_id];
          if (listing?.name) listingLabel = listing.name;
          sellerPhone = listing?.contact_whatsapp || listing?.contact_phone || counterpart?.phone || null;
        } else if (c.listing_type === 'crop') {
          const listing = cropById[c.listing_id];
          if (listing?.crop_type) listingLabel = listing.crop_type;
          sellerPhone = listing?.contact_whatsapp || listing?.contact_phone || counterpart?.phone || null;
        } else if (c.listing_type === 'field') {
          const listing = fieldById[c.listing_id];
          if (listing?.name) listingLabel = listing.name;
          const summary = fieldSummaryById[c.listing_id];
          sellerPhone = summary?.owner_whatsapp || summary?.owner_phone || counterpart?.phone || null;
        }

        return {
          id: c.id,
          listingType: c.listing_type,
          listingId: c.listing_id,
          isNumberShared: c.is_number_shared,
          updatedAt: c.updated_at,
          counterpartName: counterpart?.full_name || (isSeller ? 'Buyer' : 'Seller'),
          listingLabel,
          sellerPhone,
        };
      });

      setRows(enriched);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>Loading messages…</div>;
  }
  if (error) {
    return <div style={{ fontSize: 13, color: 'var(--color-danger)' }}>{error}</div>;
  }
  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
        No conversations yet - chats you start or receive on cattle, crop, or field listings show up here.
      </div>
    );
  }

  // Shared row content (avatar/name/subtitle/time + "..." menu) - used
  // both by the horizontal strip cards and the vertical "View All" modal
  // rows below, so the two never drift out of sync with each other.
  // showBorder=true gives the original thin-list-row look (for the
  // modal); false is used inside a kb-card in the strip, which already
  // has its own edge.
  const renderRowInner = (r, { showBorder }) => (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        borderBottom: showBorder ? '1px solid var(--color-border)' : 'none',
        opacity: deletingId === r.id ? 0.5 : 1,
      }}>
        <button
          type="button"
          onClick={() => setOpenChat(r)}
          disabled={deletingId === r.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, textAlign: 'left',
            padding: '10px 4px', border: 'none', background: 'transparent', cursor: 'pointer',
          }}
        >
          <div style={{
            width: 36, height: 36, borderRadius: '50%', background: 'var(--color-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0,
          }}>
            💬
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-navy)' }}>
              {r.counterpartName}
            </div>
            <div style={{
              fontSize: 12, color: 'var(--color-muted)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {LISTING_LABEL[r.listingType]} · {r.listingLabel}
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-muted)', flexShrink: 0 }}>
            {timeAgo(r.updatedAt)}
          </div>
        </button>

        <button
          type="button"
          aria-label="Conversation options"
          disabled={deletingId === r.id}
          onClick={(e) => {
            e.stopPropagation();
            setMenuFor((prev) => (prev === r.id ? null : r.id));
          }}
          style={{
            flexShrink: 0, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 'none', background: 'transparent', color: 'var(--color-muted)', fontSize: 18,
            cursor: 'pointer', borderRadius: 6,
          }}
        >
          ⋮
        </button>
      </div>

      {menuFor === r.id && (
        <>
          <div
            onClick={() => setMenuFor(null)}
            style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'transparent' }}
          />
          <div style={{
            position: 'absolute', right: 4, top: '100%', zIndex: 50, minWidth: 180,
            background: 'var(--color-card)', border: '1px solid var(--color-border)',
            borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', overflow: 'hidden',
          }}>
            <button
              type="button"
              onClick={() => handleDeleteForMe(r)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px',
                border: 'none', borderBottom: '1px solid var(--color-border)', background: 'var(--color-card)',
                color: 'var(--color-ink)', fontSize: 13, cursor: 'pointer',
              }}
            >
              Delete for me
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmDeleteAll(r);
                setMenuFor(null);
              }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px',
                border: 'none', borderBottom: '1px solid var(--color-border)', background: 'var(--color-card)',
                color: 'var(--color-danger)', fontSize: 13, cursor: 'pointer',
              }}
            >
              Delete for everyone
            </button>
            <button
              type="button"
              onClick={() => setMenuFor(null)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px',
                border: 'none', background: 'var(--color-card)', color: 'var(--color-muted)',
                fontSize: 13, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </>
  );

  // One card in the horizontal strip - fixed width, wrapped in the same
  // kb-card shell as the app's other cards.
  const renderStripCard = (r) => (
    <div key={r.id} className="kb-card" style={{ flexShrink: 0, width: STRIP_CARD_WIDTH, position: 'relative', padding: '4px 8px' }}>
      {renderRowInner(r, { showBorder: false })}
    </div>
  );

  // One row in the "View All" modal - the original thin-list-row look.
  const renderListRow = (r) => (
    <div key={r.id} style={{ position: 'relative' }}>
      {renderRowInner(r, { showBorder: true })}
    </div>
  );

  return (
    <>
      {deleteError && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '8px 10px', marginBottom: 8, borderRadius: 8,
          background: 'var(--color-card)', border: '1px solid var(--color-danger)',
          fontSize: 12, color: 'var(--color-danger)',
        }}>
          <span>{deleteError}</span>
          <button
            type="button"
            onClick={() => setDeleteError(null)}
            style={{ background: 'none', border: 'none', color: 'var(--color-danger)', fontWeight: 700, cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 0 }}
          >
            ×
          </button>
        </div>
      )}

      <div style={{ display: 'flex', overflowX: 'auto', gap: 10, paddingBottom: 4, WebkitOverflowScrolling: 'touch' }}>
        {rows.map((r) => renderStripCard(r))}
      </div>

      {rows.length > 1 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          style={{
            width: '100%', minHeight: 40, marginTop: 10, padding: '8px 0', borderRadius: 10,
            border: '1px solid var(--color-border)', background: 'transparent',
            color: 'var(--color-navy)', fontWeight: 600, fontSize: 13, cursor: 'pointer',
          }}
        >
          View All ({rows.length}) ▾
        </button>
      )}

      {showAll && (
        <ListModal title={`Messages (${rows.length})`} onClose={() => setShowAll(false)}>
          {rows.map((r) => renderListRow(r))}
        </ListModal>
      )}

      {openChat && (
        <div onClick={(e) => e.stopPropagation()}>
          <ChatModal
            conversationId={openChat.id}
            sellerPhone={openChat.sellerPhone}
            onClose={() => setOpenChat(null)}
          />
        </div>
      )}

      {confirmDeleteAll && (
        <ConfirmModal
          title="Delete for everyone?"
          message={`Delete this conversation with ${confirmDeleteAll.counterpartName} for everyone? This can't be undone - it removes the chat on both sides.`}
          confirmLabel={deletingId === confirmDeleteAll.id ? 'Deleting…' : 'Delete for everyone'}
          severity="danger"
          onConfirm={() => {
            if (deletingId) return;
            handleDeleteForEveryone(confirmDeleteAll);
          }}
          onCancel={() => setConfirmDeleteAll(null)}
        />
      )}
    </>
  );
}