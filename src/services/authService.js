// src/services/authService.js
//
// Wraps Supabase Auth for sign up / sign in / sign out.
//
// IMPORTANT: when "Confirm email" is ON in Supabase, signUp() returns
// a `user` object but NO active session until the email link is
// clicked. Inserting into public.users at that point fails RLS
// (auth.uid() is null without a session — id != auth.uid()).
//
// Fix: stash the entered profile fields (name/phone/role) locally,
// keyed by email. After the user confirms their email and logs in
// for the first time (an active session now exists), ensureUserProfile()
// creates the public.users row using the stashed data.

import { supabase } from '../config/supabaseClient';
import { storeOfflineCredential, verifyOfflineCredential, clearOfflineCredential } from '../utils/offlineAuth';
import { offlineCache } from '../utils/offlineCache';

const PENDING_PROFILE_KEY = 'kisanbit_pending_profile';
// Meta key (in offlineCache's 'meta' store) tracking which user id the
// currently-cached cattle/fields/etc actually belong to. signOut()
// already clears the whole cache on explicit logout, but nothing
// previously cleared it on LOGIN - a device that goes from Account A
// to Account B without an explicit "Log out" in between (app force-
// quit, browser closed, session just expired and a different account
// logs in fresh) would otherwise cache-first-render A's leftover rows
// under B's session. This key lets signIn() detect that mismatch and
// clear proactively, without discarding a returning user's own cache
// (the common, offline-friendly case this file is built around).
const LAST_CACHE_USER_KEY = 'lastCacheUserId';

// Heuristic for "this failed because there's no connection," not "this
// failed because the credentials/DB rejected it." Supabase's client
// (built on fetch) throws a TypeError with a message mentioning
// "fetch" when the network itself is unreachable; navigator.onLine is
// checked too as a fast-path, though it isn't fully reliable on its
// own (a device can report "online" while still having no real route
// to Supabase). I don't have errorHandling.js's current contents to
// know if something equivalent already lives there - if it does,
// this should be replaced with that shared version instead of a
// second copy living here. Worth sending me that file to check.
function isNetworkError(err) {
  if (!navigator.onLine) return true;
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  return (err.name === 'TypeError' && msg.includes('fetch')) || msg.includes('network');
}

function stashPendingProfile(email, profile) {
  const all = JSON.parse(localStorage.getItem(PENDING_PROFILE_KEY) || '{}');
  all[email] = profile;
  localStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify(all));
}

function popPendingProfile(email) {
  const all = JSON.parse(localStorage.getItem(PENDING_PROFILE_KEY) || '{}');
  const profile = all[email];
  if (profile) {
    delete all[email];
    localStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify(all));
  }
  return profile || null;
}

// Clears the offline cache if it belongs to a DIFFERENT user than the
// one who just logged in, then records the current user as the cache
// owner. Safe/cheap to call on every successful login (online or
// offline-fallback) - a no-op for the common "same user logging back
// in on their own device" case, since lastCacheUserId will already
// match and nothing gets cleared.
async function ensureCacheOwnership(userId) {
  const lastCacheUserId = await offlineCache.getMeta(LAST_CACHE_USER_KEY);
  if (lastCacheUserId && lastCacheUserId !== userId) {
    await offlineCache.clearAll();
  }
  await offlineCache.setMeta(LAST_CACHE_USER_KEY, userId);
}

export async function signUp({ email, password, fullName, phone, role }) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;

  // No active session yet => email confirmation is required. Stash the
  // profile fields for now; ensureUserProfile() finishes the job after
  // the user confirms and logs in.
  if (!data.session) {
    stashPendingProfile(email, { fullName, phone, role });
    return { user: data.user, pendingConfirmation: true };
  }

  // Confirmation is OFF (or already auto-confirmed) — session exists now,
  // so auth.uid() matches and the RLS insert policy passes immediately.
  const { error: profileError } = await supabase.from('users').insert({
    id: data.user.id,
    full_name: fullName,
    phone,
    role,
  });
  if (profileError) throw profileError;

  return { user: data.user, pendingConfirmation: false };
}

export async function signIn({ email, password }) {
  // Straight offline attempt (e.g. app opened with no signal at all) -
  // don't even try the network call, go straight to the local check.
  if (!navigator.onLine) {
    const offlineMatch = await verifyOfflineCredential(email, password);
    if (offlineMatch) {
      await ensureCacheOwnership(offlineMatch.id);
      return { ...offlineMatch, offline: true };
    }
    throw new Error('No internet connection, and this device has no cached login for that email. Connect once to set up offline login.');
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    // Now that we have a real session, finish creating the users row if
    // this was a signup that was waiting on email confirmation.
    await ensureUserProfile(data.user, email);

    // Cache a salted/iterated credential for future offline logins.
    // Safe to await inline - this never blocks/fails the actual login,
    // storeOfflineCredential no-ops silently if anything goes wrong here.
    await storeOfflineCredential({ id: data.user.id, email, password }).catch(() => {});

    // Clear the offline cache if it's still holding a different user's
    // data (see ensureCacheOwnership above) - must run AFTER the auth
    // call succeeds (so we know the real user id) but before the caller
    // navigates into any screen that reads offlineCache.getAll().
    await ensureCacheOwnership(data.user.id);

    return data.user;
  } catch (err) {
    // Network dropped mid-request (e.g. wifi cut out right as this
    // fired) - fall back to the offline check rather than surfacing a
    // raw connection error for a login that should still be able to
    // succeed offline.
    if (isNetworkError(err)) {
      const offlineMatch = await verifyOfflineCredential(email, password);
      if (offlineMatch) {
        await ensureCacheOwnership(offlineMatch.id);
        return { ...offlineMatch, offline: true };
      }
    }
    throw err;
  }
}

/// Creates the public.users row if it doesn't exist yet. Uses whatever
/// profile fields were stashed at signup time if available; otherwise
/// falls back to a minimal row (name guessed from email, role 'farmer')
/// so a missing profile row can never block cattle/field creation with
/// a foreign key error. Safe to call every login/session check — it's
/// a no-op if the row already exists.
export async function ensureUserProfile(user, email) {
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();

  if (existing) return; // already created

  const pending = popPendingProfile(email);

  await supabase.from('users').insert({
    id: user.id,
    full_name: pending?.fullName || (email ? email.split('@')[0] : 'Farmer'),
    phone: pending?.phone || null,
    role: pending?.role || 'farmer',
  });
}

export async function signOut() {
  clearOfflineCredential();
  // Without this, a second account logging in on the same device
  // inherits the previous account's cached cattle/fields/bases - the
  // IndexedDB cache in offlineCache.js is one shared store for the
  // whole device, not scoped per user id. This was causing every
  // account to see the same stale cattle/base data after switching.
  await offlineCache.clearAll();
  await supabase.auth.signOut();
}

export async function getCurrentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/// Fetches the role/profile row for the current user, if any. Also
/// self-heals a missing row (see ensureUserProfile) so a session that
/// was already active (e.g. after a page refresh) can't hit the same
/// "missing users row" foreign key error that signIn() alone used to
/// leave a gap for.
export async function getCurrentProfile() {
  // getUser() (unlike getSession()) verifies with the server, and the
  // insert/select below hit the DB too - all doomed while offline.
  // ProfileScreen.jsx and App.jsx already fall back to their cached
  // localStorage copies when this returns null, so skipping straight
  // to that is faster than waiting out a network attempt that can't
  // succeed.
  if (!navigator.onLine) return null;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  await ensureUserProfile(user, user.email);

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', user.id)
    .single();

  if (error) return null;
  return data;
}

export function onAuthStateChange(callback) {
  const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return () => listener.subscription.unsubscribe();
}