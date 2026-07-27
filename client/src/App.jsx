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

import { Suspense, lazy } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';

// Lazy like the pages: the sidebar shell (and its icon set) is
// authed-surface weight the public storefront must not download.
const AppShell = lazy(() => import('./components/AppShell.jsx'));

// Route-level code splitting: the public walk-in page is the
// storefront (~80% phones, parking-lot cell connections) and must
// not ship the whole admin SPA. React.lazy + one Suspense gives each
// page its own chunk; react/router/auth/ui stay in the shared entry.
//
// The walk-in flow itself is the exception: statically imported so
// the highest-value route costs zero extra chunk round trips on a
// cell connection (its weight is a few KB gzipped; the admin pages
// are the ones worth splitting away from it).
import WalkInPage from './pages/walkin/WalkInPage.jsx';

const LoginPage = lazy(() => import('./pages/LoginPage.jsx'));
const MemberHome = lazy(() => import('./pages/MemberHome.jsx'));
const AdminHome = lazy(() => import('./pages/AdminHome.jsx'));
const Wizard = lazy(() => import('./pages/Wizard.jsx'));
const BookingPage = lazy(() => import('./pages/BookingPage.jsx'));
const AdminBookings = lazy(() => import('./pages/AdminBookings.jsx'));
const ClassesPage = lazy(() => import('./pages/ClassesPage.jsx'));
const AdminClasses = lazy(() => import('./pages/AdminClasses.jsx'));
const AdminStripe = lazy(() => import('./pages/AdminStripe.jsx'));
const AdminCalendar = lazy(() => import('./pages/AdminCalendar.jsx'));
const MemberPlans = lazy(() => import('./pages/MemberPlans.jsx'));
const AdminSettings = lazy(() => import('./pages/AdminSettings.jsx'));
const AdminHours = lazy(() => import('./pages/AdminHours.jsx'));
const AdminBlackouts = lazy(() => import('./pages/AdminBlackouts.jsx'));
const AdminPolicies = lazy(() => import('./pages/AdminPolicies.jsx'));
const AdminWaivers = lazy(() => import('./pages/AdminWaivers.jsx'));
const WalkInSuccessPage = lazy(() => import('./pages/WalkInSuccessPage.jsx'));
const ManageBookingPage = lazy(() => import('./pages/walkin/ManageBookingPage.jsx'));
const RegisterPage = lazy(() => import('./pages/RegisterPage.jsx'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage.jsx'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage.jsx'));
const AdminMembers = lazy(() => import('./pages/AdminMembers.jsx'));
const AdminMemberDetail = lazy(() => import('./pages/AdminMemberDetail.jsx'));
const AdminStaff = lazy(() => import('./pages/AdminStaff.jsx'));
const AdminPacks = lazy(() => import('./pages/AdminPacks.jsx'));
const AdminReports = lazy(() => import('./pages/AdminReports.jsx'));
const AdminBilling = lazy(() => import('./pages/AdminBilling.jsx'));
const AdminCatalog = lazy(() => import('./pages/AdminCatalog.jsx'));

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<Loading />}>
          <Shell />
        </Suspense>
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
      {/* No-login manage/reschedule via the emailed capability link */}
      <Route path="/walk-in/manage" element={<ManageBookingPage />} />

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
          <Route path="/admin/catalog" element={<AdminCatalog />} />
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
