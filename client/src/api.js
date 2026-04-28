// Tiny fetch wrapper. Two responsibilities:
//   1. Forward window.location.search so /api/* requests carry the
//      ?tenant= fallback when the browser is on bare localhost (in
//      dev). On a real subdomain (momentum.localhost), the Host
//      header does the work and the search string is no-op.
//   2. Attach Authorization: Bearer if a token is in localStorage.
//
// Token storage is localStorage in Phase 1 — XSS-readable, fine for a
// dev/early-product context. Phase 5+ should graduate to httpOnly
// cookies + CSRF tokens when public exposure starts to matter.

export const TOKEN_KEY = 'courtside_token';

export function api(path, options = {}) {
  const url = path + window.location.search;
  const token = localStorage.getItem(TOKEN_KEY);
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}
