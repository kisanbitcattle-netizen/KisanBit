// src/utils/offlineAuth.js
//
// Offline login fallback for low-connectivity use (farmers in fields
// with no signal shouldn't get force-logged-out on app restart).
//
// IMPORTANT — read before wiring this in:
// This is a CONVENIENCE gate, not a real authentication boundary. It
// only decides whether to let someone back into the UI, with
// last-known cached data, when Supabase is unreachable. It issues no
// Supabase session/JWT of its own, and grants no elevated access —
// every actual read/write still goes through Supabase's RLS-enforced
// policies the moment connectivity returns. Treat a "pass" from this
// module as "show them their own cached screen," never as "they are
// authenticated with the server."
//
// Security notes on the local storage itself:
//  - The plaintext password is never stored, and never leaves this
//    module's closures.
//  - A single unsalted SHA-256 pass (the originally-planned approach)
//    is NOT sufficient on its own — it's fast to brute-force offline
//    if the device/localStorage is ever compromised (rooted phone,
//    shared family device, another app with storage access). This
//    uses PBKDF2 (Web Crypto, SHA-256, 100,000 iterations) with a
//    random per-credential salt instead, which is meaningfully slower
//    to attack than a bare hash.
//  - The credential is cleared on explicit sign-out (see
//    clearOfflineCredential), so a lost/stolen/shared device can't be
//    used to "log in offline" after the real owner has actually
//    signed out.
//  - This still isn't bulletproof - anyone with real device access
//    while a session is cached can eventually brute-force a weak
//    password given enough time. It's meant to raise the bar for
//    casual access, not to be a hardened vault. If a farmer's phone
//    security matters more than convenience for your use case, this
//    tradeoff is worth revisiting.

const STORAGE_KEY = 'kb_offline_credential';
const PBKDF2_ITERATIONS = 100000;

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes.buffer;
}

async function deriveHash(password, saltHex) {
  const enc = new TextEncoder();
  const salt = hexToBuffer(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bufferToHex(derivedBits);
}

// Constant-time-ish string comparison - avoids a trivial early-exit
// timing difference between a correct and incorrect guess. Not
// cryptographically bulletproof in JS (nothing in a JIT'd language
// truly is), but cheap insurance over a plain `===`.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/// Call this right after a SUCCESSFUL online login (e.g. from
/// authService.signIn, once Supabase confirms the password was
/// correct), so the next offline app-open has something to check
/// against. No-ops if there's no password to hash (e.g. a magic-link
/// or OAuth session has nothing local to store).
export async function storeOfflineCredential({ id, email, password }) {
  if (!password) return;
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bufferToHex(saltBytes.buffer);
  const hash = await deriveHash(password, saltHex);

  localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, email, saltHex, hash }));
}

/// Call this when Supabase is unreachable but a login/session check is
/// needed. Returns { id, email } on a match, or null on a mismatch or
/// if nothing is cached yet (e.g. this device has never had a
/// successful online login).
export async function verifyOfflineCredential(email, password) {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!stored?.email || stored.email !== email) return null;

  const hash = await deriveHash(password, stored.saltHex);
  if (!safeEqual(hash, stored.hash)) return null;

  return { id: stored.id, email: stored.email };
}

/// Call this on explicit sign-out - see the security note above for why.
export function clearOfflineCredential() {
  localStorage.removeItem(STORAGE_KEY);
}

/// True if there's a cached credential to check against at all. Useful
/// for deciding whether to show an "offline login" prompt vs. a flat
/// "you're offline, and this device has never logged in before -
/// connect to the internet at least once" message.
export function hasOfflineCredential() {
  return !!localStorage.getItem(STORAGE_KEY);
}