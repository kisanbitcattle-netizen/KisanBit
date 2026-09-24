// src/utils/sanitize.js
//
// Lightweight input sanitization for free-text form fields before they
// go to Supabase. React already escapes everything it renders (no
// dangerouslySetInnerHTML is used anywhere in this app), so this isn't
// closing an active XSS hole in *this* app's own UI — it's defense in
// depth against: (1) any future feature that renders this text as raw
// HTML (PDF export, share-card canvas text, a future admin/web view of
// the data), and (2) garbage/control characters and unreasonably long
// input hitting the DB.
//
// Usage: sanitizeText(name.trim()) right before building the payload
// passed to supabase.from(...).insert()/.update().

const MAX_TEXT_LEN = 500;

/**
 * Strips HTML angle brackets and control characters, collapses
 * excess whitespace, and caps length. Safe for names, notes,
 * descriptions, addresses, etc.
 */
export function sanitizeText(value, maxLen = MAX_TEXT_LEN) {
  if (value == null) return value;
  return String(value)
    .replace(/[<>]/g, '') // strip angle brackets - blocks raw tag injection
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '') // strip control chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** Keeps digits, +, spaces, and dashes only — for phone/WhatsApp fields. */
export function sanitizePhone(value) {
  if (value == null) return value;
  return String(value).replace(/[^\d+\-\s]/g, '').trim().slice(0, 20);
}

/** Clamps a value to a numeric range, returning null for non-numbers. */
export function sanitizeNumber(value, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** Whitelists a value against a fixed set of allowed options (dropdowns). */
export function sanitizeEnum(value, allowed, fallback = null) {
  return allowed.includes(value) ? value : fallback;
}