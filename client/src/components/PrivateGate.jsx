// Private facilities (tenants.visibility = 'private', migration 035) are
// being set up. Wraps the public pages (home, walk-in booking, classes,
// sign-up):
//   * visitors see a "coming soon" page (the API refuses bookings and
//     sign-ups anyway — this is the friendly front for it);
//   * signed-in staff see the real page with a preview banner, so they
//     can check their setup before launch.

import { Link } from 'react-router-dom';

import { useAuth } from '../auth.jsx';

export default function PrivateGate({ children }) {
  const { tenant, me } = useAuth();
  if (tenant.visibility !== 'private') return children;

  if (me?.memberships?.admin) {
    return (
      <>
        <div className="sticky top-0 z-50 bg-slate-900 px-4 py-2 text-center text-xs font-medium text-white">
          Preview — {tenant.name} isn&apos;t public yet. Customers see a “coming soon” page.
        </div>
        {children}
      </>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-lg font-semibold text-white">
          {tenant.name?.charAt(0).toUpperCase()}
        </div>
        <h1 className="mt-4 text-xl font-semibold text-slate-900">{tenant.name}</h1>
        <p className="mt-2 text-sm text-slate-600">Online booking is coming soon.</p>
        <Link to="/login" className="mt-6 inline-block text-sm font-medium text-slate-500 hover:text-slate-800">
          Staff sign in
        </Link>
      </div>
    </main>
  );
}
