// Platform console root — served when the SPA loads on
// admin.{APP_HOSTNAME} (main.jsx picks this instead of the tenant
// App). Lazy-loaded there, so none of this ships to tenant pages.
//
// Routes:
//   /              → all facilities (tenant list)
//   /tenants/:id   → one facility
//   /audit         → platform audit log

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { LogOut, Shield } from 'lucide-react';

import {
  clearPlatformToken,
  getPlatformToken,
  papi,
  SESSION_EXPIRED_EVENT,
  setPlatformToken,
} from './api.js';
import PlatformLogin from './PlatformLogin.jsx';
import TenantsPage from './TenantsPage.jsx';
import TenantDetailPage from './TenantDetailPage.jsx';
import AuditPage from './AuditPage.jsx';

const PlatformAuthContext = createContext(null);

export function usePlatformAuth() {
  return useContext(PlatformAuthContext);
}

export default function PlatformApp() {
  const [admin, setAdmin] = useState(null);
  const [booting, setBooting] = useState(true);
  const [expired, setExpired] = useState(false);

  const loadMe = useCallback(async () => {
    if (!getPlatformToken()) {
      setAdmin(null);
      return;
    }
    const res = await papi('/api/platform/me');
    setAdmin(res.ok ? (await res.json()).admin : null);
  }, []);

  useEffect(() => {
    document.title = 'Courtside Platform';
    loadMe()
      .catch(() => setAdmin(null))
      .finally(() => setBooting(false));
  }, [loadMe]);

  useEffect(() => {
    const onExpired = () => {
      setAdmin(null);
      setExpired(true);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  async function signIn(token) {
    setPlatformToken(token);
    setExpired(false);
    await loadMe();
  }

  function signOut() {
    clearPlatformToken();
    setAdmin(null);
  }

  if (booting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-400">
        loading…
      </div>
    );
  }

  return (
    <PlatformAuthContext.Provider value={{ admin, signOut }}>
      {admin ? (
        <BrowserRouter>
          <ConsoleShell>
            <Routes>
              <Route path="/" element={<TenantsPage />} />
              <Route path="/tenants/:id" element={<TenantDetailPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ConsoleShell>
        </BrowserRouter>
      ) : (
        <PlatformLogin onSignedIn={signIn} expired={expired} />
      )}
    </PlatformAuthContext.Provider>
  );
}

function ConsoleShell({ children }) {
  const { admin, signOut } = usePlatformAuth();
  const link = ({ isActive }) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${
      isActive ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
    }`;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 bg-slate-900">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-2 text-white">
            <Shield size={18} className="text-emerald-400" />
            <span className="font-semibold">Courtside</span>
            <span className="hidden text-sm text-slate-400 sm:inline">Platform</span>
          </div>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={link}>
              Facilities
            </NavLink>
            <NavLink to="/audit" className={link}>
              Audit log
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-slate-400 md:inline">{admin.email}</span>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              <LogOut size={16} />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
