// Stripe Checkout success_url target for walk-in bookings.
//
// Deliberately does not claim "confirmed": confirmation happens when
// the checkout.session.completed webhook lands, usually within
// seconds of this page loading. No booking-status polling in v1 —
// the walk-in has no credential to look their booking up with.

import { Link } from 'react-router-dom';
import { CircleCheck } from 'lucide-react';
import { useAuth } from '../auth.jsx';
import { Button, Card } from '../components/ui/index.js';

export default function WalkInSuccessPage() {
  const { tenant } = useAuth();
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-semibold text-white">
            {tenant.name?.charAt(0).toUpperCase()}
          </div>
          <div className="font-semibold text-slate-900">{tenant.name}</div>
        </div>
      </header>
      <main className="mx-auto max-w-md p-4 sm:p-6">
        <Card className="mt-12 text-center">
          <CircleCheck size={40} className="mx-auto text-emerald-500" />
          <h1 className="mt-4 text-xl font-semibold text-slate-900">
            Payment received — you're booked!
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Your session is locked in. Just give your name at the front
            desk when you arrive.
          </p>
          <Button as={Link} to="/walk-in" variant="secondary" className="mt-6">
            Book another session
          </Button>
        </Card>
      </main>
    </div>
  );
}
