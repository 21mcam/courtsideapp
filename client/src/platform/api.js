// Fetch wrapper for the platform console (admin.{APP_HOSTNAME}).
// Separate from ../api.js on purpose: no ?tenant= hint (there is no
// tenant here) and a different token key, so a console session and a
// tenant session can never be confused even on bare localhost.

export const PLATFORM_TOKEN_KEY = 'courtside_platform_token';

export function getPlatformToken() {
  try {
    return localStorage.getItem(PLATFORM_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setPlatformToken(token) {
  localStorage.setItem(PLATFORM_TOKEN_KEY, token);
}

export function clearPlatformToken() {
  try {
    localStorage.removeItem(PLATFORM_TOKEN_KEY);
  } catch {
    // storage unavailable — nothing to clear
  }
}

// Expired/revoked sessions surface as 401 on any call; the app
// listens for this event and drops back to the login screen.
export const SESSION_EXPIRED_EVENT = 'courtside-platform-session-expired';

export async function papi(path, options = {}) {
  const token = getPlatformToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 401 && token) {
    clearPlatformToken();
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
  return res;
}

// GET + JSON, throwing on non-2xx with the server's error message.
export async function papiJson(path, options) {
  const res = await papi(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}
