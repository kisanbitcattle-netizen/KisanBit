// src/screens/AuthScreen.jsx
//
// Login / Signup screen shown before the main app. Signup includes
// role selection (Farmer / User / Vet-Doctor / Cattle Medical) — this
// is what drives role-based access throughout the rest of the app
// (RLS on the backend already enforces it; this just captures the
// choice at account creation). Admin / Super Admin are NOT selectable
// here by design — those are assigned by an existing admin, not
// self-serve at signup.

import { useState } from 'react';
import { signUp, signIn } from '../services/authService';
import { supabase } from '../config/supabaseClient';

const OTHER_ROLES = [
  { value: 'buyer', label: '🛒 buyer' },
  
];

export default function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [role, setRole] = useState('farmer');
  const [showOtherRoles, setShowOtherRoles] = useState(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [infoMsg, setInfoMsg] = useState(null);

  // Forgot password
  const [showForgot, setShowForgot] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setInfoMsg(null);
    setLoading(true);

    try {
      if (mode === 'signup') {
        const result = await signUp({ email, password, fullName, phone, role });
        if (result.pendingConfirmation) {
          setInfoMsg('Check your email to confirm your account, then log in.');
          setMode('login');
        } else {
          onAuthed();
        }
      } else {
        await signIn({ email, password });
        onAuthed();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setError(null);
    setInfoMsg(null);

    if (!email) {
      setError('Enter your email above first, then tap "Forgot password?" again.');
      return;
    }

    setResetLoading(true);
    try {
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(email);
      if (resetErr) throw resetErr;
      setInfoMsg('Password reset link sent — check your email.');
      setShowForgot(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setResetLoading(false);
    }
  };

  const selectFarmer = () => {
    setRole('farmer');
    setShowOtherRoles(false);
  };

  const toggleOtherRoles = () => {
    setShowOtherRoles((prev) => !prev);
    if (role === 'farmer') {
      setRole('user'); // default when switching into the "other roles" group
    }
  };

  const isOtherRoleActive = role !== 'farmer';
  const activeOtherLabel = OTHER_ROLES.find((r) => r.value === role)?.label ?? '📋 Other';

  return (
    <div
      style={{
        height: '100vh',
        width: '100vw',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-bg)',
        padding: 20,
      }}
    >
      <img
        src="/assets/branding/kisanbit-logo.png"
        alt="KisanBit"
        style={{ width: 72, height: 72, borderRadius: 18, marginBottom: 12 }}
      />
      <div className="display-text" style={{ fontSize: 24, color: 'var(--color-navy)', marginBottom: 4 }}>
        KisanBit
      </div>
      <div style={{ fontSize: 13, color: 'var(--color-muted)', marginBottom: 24 }}>
        Smart Cattle & Crop Tracking
      </div>

      <form
        onSubmit={handleSubmit}
        className="kb-card"
        style={{ width: '100%', maxWidth: 360, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {/* Login / Signup switch */}
        <div style={{ display: 'flex', background: 'var(--color-bg)', borderRadius: 10, padding: 3 }}>
          <button
            type="button"
            onClick={() => setMode('login')}
            style={{
              flex: 1, padding: 8, border: 'none', borderRadius: 8,
              background: mode === 'login' ? 'var(--color-navy)' : 'transparent',
              color: mode === 'login' ? '#fff' : 'var(--color-muted)',
              fontWeight: 700, fontSize: 13,
            }}
          >
            Log In
          </button>
          <button
            type="button"
            onClick={() => setMode('signup')}
            style={{
              flex: 1, padding: 8, border: 'none', borderRadius: 8,
              background: mode === 'signup' ? 'var(--color-navy)' : 'transparent',
              color: mode === 'signup' ? '#fff' : 'var(--color-muted)',
              fontWeight: 700, fontSize: 13,
            }}
          >
            Sign Up
          </button>
        </div>

        {mode === 'signup' && (
          <>
            {/* Role selection — Farmer, or "Other" which expands to User / Vet-Doctor / Cattle Medical.
                Admin & Super Admin are intentionally NOT offered here (backend-assigned only). */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={selectFarmer}
                style={{
                  flex: 1,
                  padding: 10,
                  borderRadius: 10,
                  border: `2px solid ${role === 'farmer' ? 'var(--color-gold)' : 'var(--color-border)'}`,
                  background: 'var(--color-card)',
                  fontWeight: 700,
                  fontSize: 13,
                  color: 'var(--color-ink)',
                }}
              >
                👨‍🌾 Farmer
              </button>
              <button
                type="button"
                onClick={toggleOtherRoles}
                aria-expanded={showOtherRoles}
                style={{
                  flex: 1,
                  padding: 10,
                  borderRadius: 10,
                  border: `2px solid ${isOtherRoleActive ? 'var(--color-gold)' : 'var(--color-border)'}`,
                  background: 'var(--color-card)',
                  fontWeight: 700,
                  fontSize: 13,
                  color: 'var(--color-ink)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                }}
              >
                {isOtherRoleActive ? activeOtherLabel : '📋 Other'}
                <span style={{ fontSize: 10, transform: showOtherRoles ? 'rotate(180deg)' : 'none' }}>▼</span>
              </button>
            </div>

            {showOtherRoles && (
              <div
                className="kb-card"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  padding: 8,
                  border: '1px solid var(--color-border)',
                  borderRadius: 10,
                }}
              >
                {OTHER_ROLES.map((r) => (
                  <button
                    type="button"
                    key={r.value}
                    onClick={() => setRole(r.value)}
                    style={{
                      textAlign: 'left',
                      padding: 10,
                      borderRadius: 8,
                      border: `2px solid ${role === r.value ? 'var(--color-gold)' : 'var(--color-border)'}`,
                      background: 'var(--color-bg)',
                      fontWeight: 600,
                      fontSize: 13,
                      color: 'var(--color-ink)',
                    }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            )}

            <input
              type="text"
              placeholder="Full name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              style={inputStyle}
            />
            <input
              type="tel"
              placeholder="Phone number"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              style={inputStyle}
            />
          </>
        )}

        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
          style={inputStyle}
        />

        {mode === 'login' && !showForgot && (
          <button
            type="button"
            onClick={() => setShowForgot(true)}
            style={{
              alignSelf: 'flex-end',
              background: 'none',
              border: 'none',
              color: 'var(--color-navy)',
              fontSize: 12,
              fontWeight: 600,
              padding: 0,
              cursor: 'pointer',
            }}
          >
            Forgot password?
          </button>
        )}

        {mode === 'login' && showForgot && (
          <div
            className="kb-card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 10,
              border: '1px solid var(--color-border)',
              borderRadius: 10,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>
              We'll email a reset link to the address entered above.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={handleForgotPassword}
                disabled={resetLoading}
                style={{
                  flex: 1,
                  padding: 10,
                  borderRadius: 8,
                  border: 'none',
                  background: 'var(--color-navy)',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 13,
                }}
              >
                {resetLoading ? 'Sending…' : 'Send reset link'}
              </button>
              <button
                type="button"
                onClick={() => setShowForgot(false)}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-card)',
                  color: 'var(--color-ink)',
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>{error}</div>}
        {infoMsg && <div style={{ color: 'var(--color-success)', fontSize: 13 }}>{infoMsg}</div>}

        <button
          type="submit"
          disabled={loading}
          style={{
            padding: 12,
            borderRadius: 10,
            border: 'none',
            background: 'var(--color-gold)',
            color: 'var(--color-navy)',
            fontWeight: 700,
            fontSize: 15,
          }}
        >
          {loading ? 'Please wait…' : mode === 'signup' ? 'Create Account' : 'Log In'}
        </button>
      </form>
    </div>
  );
}

const inputStyle = {
  padding: 12,
  borderRadius: 10,
  border: '1px solid var(--color-border)',
  background: 'var(--color-card)',
  color: 'var(--color-ink)',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
};