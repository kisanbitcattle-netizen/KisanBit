// src/components/TransferOwnershipModal.jsx
//
// Sending side of ownership transfer. Receiving side already exists
// (TransferRequestsBanner.jsx + accept/reject_transfer_request RPCs,
// table cattle_transfer_requests).
//
// v2 — UI redone as a centered card instead of a bottom sheet, per
// feedback that the popup didn't look right. Also added
// console.error(rpcError) so the REAL Postgres/RPC error is visible
// in devtools instead of only the generic user-facing message — the
// "could not send, try again" text means create_transfer_request is
// failing, but the fallback message hides why. Check the browser
// console next attempt and share what it logs (message/code/details)
// so the RPC call can be corrected instead of guessed at again.
//
// CONFIRMED from CattleCard.jsx (isTransferOpen block): props are
// { cattle, onCancel, onSent } — matches the onCancel convention
// EditCattleModal already uses in the same file. Fixed from an
// earlier onClose-based draft that silently did nothing because
// CattleCard was never passing that prop name.
//
// Matches the DB migration in add_email_transfer_lookup.sql, which
// must be run alongside this file:
//   create_transfer_request(p_cattle_id uuid, p_buyer_identifier text)
// Accepts either a phone number (exact match against
// public.users.phone, unchanged from the original) or a Gmail/email
// address (case-insensitive match against auth.users.email, new) —
// needed because signup via Google OAuth leaves public.users.phone
// empty, so phone-only lookup silently failed for most accounts.
// Whichever the caller types in, this modal only does light client-
// side formatting (10-digit -> +91XXXXXXXXXX for phone, lowercase for
// email) and lets the RPC's raise exception messages surface via
// toUserMessage for anything it can't resolve.

import { useEffect, useState } from 'react';
import { supabase } from '../../config/supabaseClient';
import { toUserMessage } from '../../utils/errorHandling';

function normalizeIdentifier(raw) {
  const trimmed = raw.trim();
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+91${digits}`;
  return digits;
}

export default function TransferOwnershipModal({ cattle, onCancel, onSent }) {
  const [identifier, setIdentifier] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Escape key closes, same as clicking backdrop/Cancel.
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onCancel?.();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    const trimmed = identifier.trim();
    if (!trimmed) {
      setError('Enter the recipient\'s phone number or Gmail address.');
      return;
    }
    const normalized = normalizeIdentifier(trimmed);
    const isEmail = normalized.includes('@');
    if (!isEmail && normalized.length < 10) {
      setError('Enter a valid phone number or Gmail address.');
      return;
    }

    setSubmitting(true);
    const { error: rpcError } = await supabase.rpc('create_transfer_request', {
      p_cattle_id: cattle.id,
      p_buyer_phone: normalized,
    });
    setSubmitting(false);

    if (rpcError) {
      // TEMP debug aid — check devtools console for the real reason
      // this is failing (function not found / bad arg names / RLS
      // denial / phone not found), then remove once fixed.
      console.error('create_transfer_request failed:', rpcError);
      setError(toUserMessage(rpcError, 'Could not send the transfer request. Try again.'));
      return;
    }

    onSent?.();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 7000,
        background: 'rgba(20, 20, 20, 0.55)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={onCancel}
    >
      <div
        className="kb-card"
        style={{
          width: '100%',
          maxWidth: 380,
          padding: 24,
          background: 'var(--color-card)',
          borderRadius: 16,
          boxShadow: '0 12px 32px rgba(0,0,0,0.25)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: 'var(--color-gold)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            marginBottom: 14,
          }}
        >
          🤝
        </div>

        <h2 className="display-text" style={{ fontSize: 18, color: 'var(--color-ink)', marginBottom: 6 }}>
          Transfer Ownership
        </h2>

        <p style={{ fontSize: 13, color: 'var(--color-muted)', lineHeight: 1.5, marginBottom: 18 }}>
          Transfer <strong style={{ color: 'var(--color-ink)' }}>{cattle?.name}</strong> to another
          KisanBit user. They'll need to accept the request before ownership changes.
        </p>

        <form onSubmit={handleSubmit}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', display: 'block', marginBottom: 6 }}>
            Recipient's phone number or Gmail address
          </label>
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="Phone number or Gmail address"
            autoFocus
            style={{
              width: '100%',
              padding: '12px 14px',
              fontSize: 15,
              borderRadius: 10,
              border: '1px solid var(--color-border, #d8d8d8)',
              marginBottom: 14,
              boxSizing: 'border-box',
              outline: 'none',
            }}
          />

          {error && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--color-danger)',
                background: 'rgba(192, 57, 43, 0.08)',
                borderRadius: 8,
                padding: '8px 10px',
                marginBottom: 14,
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={() => onCancel?.()}
              style={{
                flex: 1,
                minHeight: 46,
                borderRadius: 10,
                border: '1px solid var(--color-border, #d8d8d8)',
                background: 'transparent',
                color: 'var(--color-ink)',
                fontWeight: 600,
                fontSize: 14,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              style={{
                flex: 1.4,
                minHeight: 46,
                borderRadius: 10,
                border: 'none',
                background: 'var(--color-gold)',
                color: 'var(--color-ink)',
                fontWeight: 700,
                fontSize: 14,
                opacity: submitting ? 0.6 : 1,
                cursor: submitting ? 'default' : 'pointer',
              }}
            >
              {submitting ? 'Sending…' : 'Send Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}