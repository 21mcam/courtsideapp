// Top-level router + auth provider.
//
// Routes:
//   /        → role-based home (Admin or Member)
//   /login   → login form (single, role-detected)
//   /wizard  → admin-only setup wizard (Phase 2 slice 5)
//   /book    → member booking flow (Phase 3 slice 5)
//   /classes → member class browser + booking (Phase 4 slice 4)
//   /admin/bookings → admin booking calendar (Phase 3 slice 6)
//   /admin/classes  → admin schedules + instances + roster (Phase 4 slice 4)
//
// Wrapping AuthProvider so any page can read tenant + me state.

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import LoginPage from './pages/LoginPage.jsx';
import MemberHome from './pages/MemberHome.jsx';
import AdminHome from './pages/AdminHome.jsx';
import Wizard from './pages/Wizard.jsx';
import BookingPage from './pages/BookingPage.jsx';
import AdminBookings from './pages/AdminBookings.jsx';
import ClassesPage from './pages/ClassesPage.jsx';
import AdminClasses from './pages/AdminClasses.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </BrowserRouter>
  );
}

function Shell() {
  const { tenant, tenantError, booting } = useAuth();

  if (tenantError) {
    return <ErrorView status={tenantError.status} body={tenantError.body} />;
  }
  if (!tenant || booting) {
    return <Loading />;
  }

  return (
    <Routes>
      <Route path="/login" element={<RouteLogin />} />
      <Route path="/wizard" element={<RouteAdminOnly><Wizard /></RouteAdminOnly>} />
      <Route path="/admin/bookings" element={<RouteAdminOnly><AdminBookings /></RouteAdminOnly>} />
      <Route path="/admin/classes" element={<RouteAdminOnly><AdminClasses /></RouteAdminOnly>} />
      <Route path="/book" element={<RouteAuthed><BookingPage /></RouteAuthed>} />
      <Route path="/classes" element={<RouteAuthed><ClassesPage /></RouteAuthed>} />
      <Route path="/" element={<RouteHome />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function RouteHome() {
  const { me } = useAuth();
  if (!me) return <Navigate to="/login" replace />;
  return me.memberships.admin ? <AdminHome /> : <MemberHome />;
}

function RouteLogin() {
  const { me } = useAuth();
  if (me) return <Navigate to="/" replace />;
  return <LoginPage />;
}

function RouteAdminOnly({ children }) {
  const { me } = useAuth();
  if (!me) return <Navigate to="/login" replace />;
  if (!me.memberships.admin) return <Navigate to="/" replace />;
  return children;
}

function RouteAuthed({ children }) {
  const { me } = useAuth();
  if (!me) return <Navigate to="/login" replace />;
  return children;
}

function Loading() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-slate-400">loading…</div>
    </main>
  );
}

function ErrorView({ status, body }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-900 p-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold text-rose-700">
          tenant resolution failed
        </h1>
        <p className="mt-2 text-slate-700">
          HTTP {status || '—'}: {body?.error || 'unknown error'}
        </p>
        <p className="mt-6 text-sm text-slate-400">
          Open via{' '}
          <code className="rounded bg-slate-200 px-1.5 py-0.5">
            {'{tenant}.localhost:5173'}
          </code>{' '}
          or{' '}
          <code className="rounded bg-slate-200 px-1.5 py-0.5">
            localhost:5173?tenant={'{name}'}
          </code>
          .
        </p>
      </div>
    </main>
  );
}
