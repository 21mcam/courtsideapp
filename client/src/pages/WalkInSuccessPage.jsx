// Stripe Checkout success_url target for walk-in bookings.
//
// Deliberately does not claim "confirmed": confirmation happens when
// the checkout.session.completed webhook lands, usually within
// seconds of this page loading. No booking-status polling in v1 —
// the walk-in has no credential to look their booking up with.

import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

export default function WalkInSuccessPage() {
  const { tenant } = useAuth();
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-3">
        <div className="font-semibold">{tenant.name}</div>
      </header>
      <main className="max-w-md mx-auto p-6 text-center">
        <div className="mt-12 rounded border border-emerald-200 bg-emerald-50 p-6">
          <h1 className="text-xl font-semibold text-emerald-900">
            Payment received — you're booked!
          </h1>
          <p className="mt-2 text-sm text-emerald-900">
            Your session is locked in. Just give your name at the front
            desk when you arrive.
          </p>
        </div>
        <Link
          to="/walk-in"
          className="mt-6 inline-block text-sm text-sky-700 hover:underline"
        >
          Book another session
        </Link>
      </main>
    </div>
  );
}
