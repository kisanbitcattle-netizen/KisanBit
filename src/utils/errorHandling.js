// src/utils/errorHandling.js
//
// Supabase/Postgres errors often contain internal details (constraint
// names, column names, RLS policy names, raw SQL fragments) that are
// fine in the console for debugging but shouldn't be shown directly to
// a farmer in the UI. This logs the full error (message/details/hint/
// code) to the console for developers, and returns a short, safe,
// user-facing string.

const FRIENDLY_FALLBACK = 'Something went wrong. Please try again.';

// A few common Postgres/PostgREST error codes worth a nicer message.
const CODE_MESSAGES = {
  '23505': 'That entry already exists.',
  '23503': 'This action references something that no longer exists.',
  '42501': "You don't have permission to do that.",
  PGRST301: 'Your session expired — please log in again.',
};

export function toUserMessage(err, fallback = FRIENDLY_FALLBACK) {
  if (!err) return fallback;

  // Log the real error for developers - never swallow it silently.
  console.error('[KisanBit]', err.message, err.details, err.hint, err.code);

  if (err.code && CODE_MESSAGES[err.code]) return CODE_MESSAGES[err.code];

  // Network-level failures are safe and useful to show verbatim-ish.
  if (err.message && /network|fetch|offline/i.test(err.message)) {
    return 'Network error — check your connection and try again.';
  }

  return fallback;
}