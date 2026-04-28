// Tiny fetch wrapper. Two responsibilities:
//   1. Carry the tenant context. In production we use real subdomains
//      (the Host header does the work), but in dev with bare
//      localhost we rely on a ?tenant= query param fallback. Once
//      captured at app load, we forward it on every subsequent
//      API call — react-router navigation drops the query string
//      from the URL, so we can't read it from window.location.search
//      after the first navigation.
//   2. Attach Authorization: Bearer if a token is in localStorage.
//
// Token storage is localStorage in Phase 1 — XSS-readable, fine for a
// dev/early-product context. Phase 5+ should graduate to httpOnly
// cookies + CSRF tokens when public exposure starts to matter.

export const TOKEN_KEY = 'courtside_token';

// Capture the ?tenant= hint once at module load. Only meaningful on
// bare localhost / 127.0.0.1; on real subdomains the backend's
// resolveTenant reads from the Host header.
let tenantHint = null;
if (typeof window !== 'undefined') {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('tenant');
    if (t) tenantHint = t;
  }
}

function withTenantQuery(path) {
  if (!tenantHint) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}tenant=${encodeURIComponent(tenantHint)}`;
}

export function api(path, options = {}) {
  const url = withTenantQuery(path);
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
