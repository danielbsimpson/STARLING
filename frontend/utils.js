// frontend/utils.js
// Shared frontend helpers. Keep this module tiny and dependency-free.

/**
 * Escape a value for safe insertion into HTML text or attribute context.
 * Handles &, <, >, and " (the superset previously implemented across panels).
 * Null/undefined coerce to empty string.
 */
export function escapeHtml(value) {
  return (value ?? '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Fetch a URL and parse its body as JSON. Throws on non-2xx with
 * a message of the form "HTTP <status>".
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
