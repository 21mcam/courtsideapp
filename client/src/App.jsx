// Top-level router + auth provider.
//
// Routes:
//   /        → role-based home (Admin or Member)
//   /login   → login form (single, role-detected)
//   /register → PUBLIC member self-signup
//   /forgot  → PUBLIC forgot-password (email entry)
//   /reset   → PUBLIC reset/set password — path is baked into sent
//              emails (?token=..., &invite=1 for staff invites)
//   /wizard  → admin-only setup wizard (Phase 2 slice 5)
//   /book    → member booking flow (Phase 3 slice 5)
//   /walk-in → PUBLIC walk-in booking, no login (Phase 5 slice 7 UI)
//   /classes → member class browser + booking (Phase 4 slice 4)
//   /plans   → member subscription chooser (Phase 5 slice 4a)
//   /admin/bookings → admin booking calendar (Phase 3 slice 6)
//   /admin/classes  → admin schedules + instances + roster (Phase 4 slice 4)
//   /admin/stripe   → Stripe Connect onboarding + status (Phase 5 slice 1)
//   /admin/calendar → multi-resource day view (visual ops calendar)
//   /admin/members + /admin/members/:id → member management
//   /admin/staff    → staff roster + invites
//   /admin/reports  → summary stats + CSV exports
//
// Wrapping AuthProvider so any page can read tenant + me state.

import { BrowserRouter, Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import AppShell from './components/AppShell.jsx';
import LoginPage from './pages/LoginPage.jsx';
import MemberHome from './pages/MemberHome.jsx';
import AdminHome from './pages/AdminHome.jsx';
import Wizard from './pages/Wizard.jsx';
import BookingPage from './pages/BookingPage.jsx';
import AdminBookings from './pages/AdminBookings.jsx';
import ClassesPage from './pages/ClassesPage.jsx';
import AdminClasses from './pages/AdminClasses.jsx';
import AdminStripe from './pages/AdminStripe.jsx';
import AdminCalendar from './pages/AdminCalendar.jsx';
import MemberPlans from './pages/MemberPlans.jsx';
import AdminSettings from './pages/AdminSettings.jsx';
import AdminHours from './pages/AdminHours.jsx';
import AdminBlackouts from './pages/AdminBlackouts.jsx';
import AdminPolicies from './pages/AdminPolicies.jsx';
import AdminWaivers from './pages/AdminWaivers.jsx';
import WalkInPage from './pages/WalkInPage.jsx';
import WalkInSuccessPage from './pages/WalkInSuccessPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx';
import ResetPasswordPage from './pages/ResetPasswordPage.jsx';
import AdminMembers from './pages/AdminMembers.jsx';
import AdminMemberDetail from './pages/AdminMemberDetail.jsx';
import AdminStaff from './pages/AdminStaff.jsx';
import AdminPacks from './pages/AdminPacks.jsx';
import AdminReports from './pages/AdminReports.jsx';
import AdminBilling from './pages/AdminBilling.jsx';

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

  // Billing hold: the tenant's platform subscription has lapsed.
  // resolveTenant 402s everything except /api/tenant, /api/auth/*,
  // /api/me, and /api/admin/billing*, so only auth + the billing page
  // can work — route everything else to the hold screen. AdminBilling
  // renders standalone here (no AppShell — the sidebar's targets
  // would all fail).
  if (tenant.billing_blocked) {
    return (
      <Routes>
        <Route path="/login" element={<RouteLogin />} />
        <Route path="/forgot" element={<ForgotPasswordPage />} />
        <Route path="/reset" element={<ResetPasswordPage />} />
        <Route
          path="/admin/settings/billing"
          element={
            <RouteAdminOnly>
              <AdminBilling />
            </RouteAdminOnly>
          }
        />
        <Route path="*" element={<BillingHold />} />
      </Routes>
    );
  }

  return (
    <Routes>
      {/* Outside the shell: login/signup/password + public walk-in */}
      <Route path="/login" element={<RouteLogin />} />
      <Route path="/register" element={<RouteRegister />} />
      <Route path="/forgot" element={<ForgotPasswordPage />} />
      <Route path="/reset" element={<ResetPasswordPage />} />
      <Route path="/walk-in" element={<WalkInPage />} />
      <Route path="/walk-in/success" element={<WalkInSuccessPage />} />

      {/* Everything authed renders inside the sidebar shell */}
      <Route element={<RouteAuthed><AppShell /></RouteAuthed>}>
        <Route path="/" element={<RouteHome />} />
        <Route path="/book" element={<BookingPage />} />
        <Route path="/classes" element={<ClassesPage />} />
        <Route path="/plans" element={<MemberPlans />} />
        <Route element={<RouteAdminOnly />}>
          <Route path="/wizard" element={<Wizard />} />
          <Route path="/admin/bookings" element={<AdminBookings />} />
          <Route path="/admin/classes" element={<AdminClasses />} />
          <Route path="/admin/calendar" element={<AdminCalendar />} />
          <Route path="/admin/members" element={<AdminMembers />} />
          <Route path="/admin/members/:id" element={<AdminMemberDetail />} />
          <Route path="/admin/staff" element={<AdminStaff />} />
          <Route path="/admin/packs" element={<AdminPacks />} />
          <Route path="/admin/reports" element={<AdminReports />} />
          <Route path="/admin/stripe" element={<AdminStripe />} />
          <Route path="/admin/settings" element={<AdminSettings />} />
          <Route path="/admin/settings/hours" element={<AdminHours />} />
          <Route path="/admin/settings/blackouts" element={<AdminBlackouts />} />
          <Route path="/admin/settings/policies" element={<AdminPolicies />} />
          <Route path="/admin/settings/waivers" element={<AdminWaivers />} />
          <Route path="/admin/settings/billing" element={<AdminBilling />} />
        </Route>
      </Route>

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

function RouteRegister() {
  const { me } = useAuth();
  if (me) return <Navigate to="/" replace />;
  return <RegisterPage />;
}

// Guards work both as children-wrappers and as layout routes (via
// Outlet fallback).
function RouteAdminOnly({ children }) {
  const { me } = useAuth();
  if (!me) return <Navigate to="/login" replace />;
  if (!me.memberships.admin) return <Navigate to="/" replace />;
  return children ?? <Outlet />;
}

function RouteAuthed({ children }) {
  const { me } = useAuth();
  if (!me) return <Navigate to="/login" replace />;
  return children ?? <Outlet />;
}

function BillingHold() {
  const { tenant, me } = useAuth();
  const isAdmin = Boolean(me?.memberships?.admin);
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">
          {tenant.name} is temporarily unavailable
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Online booking is paused right now. Please check back soon, or
          contact the facility directly.
        </p>
        <p className="mt-6 text-sm">
          {/* Client-side Links, not anchors: a full page load on bare
              localhost drops the ?tenant= fallback param. */}
          {isAdmin ? (
            <Link
              to="/admin/settings/billing"
              className="font-medium text-brand-600 hover:text-brand-500"
            >
              Facility owner? Manage billing →
            </Link>
          ) : (
            <Link
              to="/login"
              className="font-medium text-slate-500 hover:text-slate-700"
            >
              Facility staff? Sign in
            </Link>
          )}
        </p>
      </div>
    </main>
  );
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
