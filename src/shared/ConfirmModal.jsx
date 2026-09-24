// src/components/ConfirmModal.jsx
//
// Generic confirmation dialog. For `danger` severity (e.g. hard delete),
// requires typing the exact confirmText before the confirm button
// enables - a stronger guard than a plain Yes/No for irreversible actions.

import { useState } from 'react';

export default function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  severity = 'normal', // 'normal' | 'danger'
  requireTypedConfirmation = null, // e.g. cattle name - only used when severity is 'danger'
  onConfirm,
  onCancel,
}) {
  const [typed, setTyped] = useState('');
  const isLocked = severity === 'danger' && requireTypedConfirmation && typed !== requireTypedConfirmation;

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 5000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={onCancel}
    >
      <div className="kb-card" onClick={(e) => e.stopPropagation()} style={{ padding: 20, maxWidth: 340, width: '100%' }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: severity === 'danger' ? 'var(--color-danger)' : 'var(--color-navy)' }}>
          {title}
        </div>
        <p style={{ fontSize: 13, color: 'var(--color-muted)', marginTop: 8 }}>{message}</p>

        {severity === 'danger' && requireTypedConfirmation && (
          <>
            <p style={{ fontSize: 12, marginTop: 10 }}>
              Please type <strong>{requireTypedConfirmation}</strong> to confirm:
            </p>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--color-border)', marginTop: 4, background: 'var(--color-card)', color: 'var(--color-ink)' }}
            />
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            onClick={onConfirm}
            disabled={isLocked}
            style={{
              flex: 1, padding: '10px 0', borderRadius: 8, border: 'none',
              background: severity === 'danger' ? 'var(--color-danger)' : 'var(--color-navy)',
              color: '#fff', fontWeight: 700, opacity: isLocked ? 0.5 : 1,
            }}
          >
            {confirmLabel}
          </button>
          <button onClick={onCancel} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-card)', color: 'var(--color-ink)' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}