// Auth context: holds the resolved tenant + me, plus login/logout
// helpers. Pages read auth state via useAuth(); routing decisions
// (member vs admin home) happen at the route layer.

import { createContext, useContext, useEffect, useState } from 'react';
import { api, clearToken, setToken, TOKEN_KEY } from './api.js';
import { applyAccent } from './theme.js';

const AuthContext = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }) {
  const [tenant, setTenant] = useState(null);
  const [tenantError, setTenantError] = useState(null);
  const [me, setMe] = useState(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const tRes = await api('/api/tenant');
        if (tRes.ok) {
          const t = await tRes.json();
          setTenant(t);
          applyAccent(t.theme_accent);
          // Browser tab shows the facility's name on every surface
          // (admin, member, public booking). Falls back to the
          // platform name from index.html when the tenant has none.
          document.title = t.name || 'Courtside';
        } else {
          const body = await tRes.json().catch(() => ({}));
          setTenantError({ status: tRes.status, body });
          setBooting(false);
          return;
        }
      } catch (err) {
        setTenantError({ status: 0, body: { error: err.message } });
        setBooting(false);
        return;
      }

      // Tenant resolved. Now /api/me if a token exists.
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) {
        setBooting(false);
        return;
      }
      try {
        const meRes = await api('/api/me');
        if (meRes.ok) {
          setMe(await meRes.json());
        } else {
          clearToken();
        }
      } catch {
        clearToken();
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  async function login(token) {
    setToken(token);
    setBooting(true);
    try {
      const res = await api('/api/me');
      if (res.ok) {
        setMe(await res.json());
      } else {
        clearToken();
        setMe(null);
      }
    } finally {
      setBooting(false);
    }
  }

  function logout() {
    clearToken();
    setMe(null);
  }

  // Merge a partial update into the tenant (e.g. theme_accent from
  // the settings page) and re-apply the accent if it changed.
  function updateTenant(patch) {
    setTenant((prev) => {
      const next = { ...prev, ...patch };
      if (patch.theme_accent) applyAccent(patch.theme_accent);
      if (patch.name) document.title = patch.name;
      return next;
    });
  }

  return (
    <AuthContext.Provider
      value={{ tenant, tenantError, me, booting, login, logout, updateTenant, refresh: async () => {
        const res = await api('/api/me');
        if (res.ok) setMe(await res.json());
      } }}
    >
      {children}
    </AuthContext.Provider>
  );
}
