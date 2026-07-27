// Stripe Checkout success_url target for walk-in bookings.
//
// The server appends ?booking_id=<uuid> to the success_url when it
// creates the Checkout session, and WalkInPage stashes the walk-in's
// email in sessionStorage before redirecting. With both in hand this
// page calls POST /api/customers/bookings/lookup (public, but gated
// on knowing id + email) and shows a booking reference, the slot
// details, and the facility's contact line — no more dead-end.
//
// The webhook that flips the booking to confirmed usually lands
// within seconds of this page loading, so a still-pending_payment
// response is retried a few times before we settle for showing
// whatever state we have. If the email is missing (cleared storage,
// private mode, forwarded link) we ask for it — a wrong email gets
// the same 404 as an unknown id, so nothing can be enumerated.

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CircleCheck } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatCents, formatSlotLocal } from '../format.js';
import { firePurchaseOnce, initAnalytics } from '../lib/analytics.js';
import { Button, Card, Field, Input } from '../components/ui/index.js';
import PublicHeader from './walkin/PublicHeader.jsx';

function storedValue(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export default function WalkInSuccessPage() {
  const { tenant } = useAuth();
  const [searchParams] = useSearchParams();
  const bookingId =
    searchParams.get('booking_id') ||
    storedValue('courtside_walkin_booking_id');

  const [email, setEmail] = useState(
    () => storedValue('courtside_walkin_email') ?? '',
  );
  const [emailInput, setEmailInput] = useState('');
  // Bumped on every email (re)submit so retrying the same address
  // after a typo-induced 404 still re-runs the lookup effect.
  const [lookupNonce, setLookupNonce] = useState(0);

  const [booking, setBooking] = useState(null);
  const [lookupError, setLookupError] = useState(null);

  useEffect(() => {
    initAnalytics(tenant.ga4_measurement_id);
  }, [tenant.ga4_measurement_id]);

  useEffect(() => {
    if (!bookingId || !email) return;
    let cancelled = false;
    let attempts = 0;

    async function fetchBooking() {
      attempts += 1;
      try {
        const res = await api('/api/customers/bookings/lookup', {
          method: 'POST',
          body: JSON.stringify({ booking_id: bookingId, email }),
        });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        setBooking(body.booking);
        setLookupError(null);
        // Webhook race: right after Checkout the row can still be
        // pending_payment. Retry briefly, then show what we have.
        if (body.booking.status === 'pending_payment' && attempts < 5) {
          setTimeout(fetchBooking, 2000);
        } else if (body.booking.status !== 'pending_payment') {
          // GA4 purchase — the funnel's last step. Deduped per
          // booking id (localStorage), so polls and refreshes can't
          // double-count.
          firePurchaseOnce(body.booking);
        }
      } catch (err) {
        if (!cancelled) setLookupError(err.message);
      }
    }

    fetchBooking();
    return () => {
      cancelled = true;
    };
  }, [bookingId, email, lookupNonce]);

  const needsEmail = bookingId && !booking && (!email || lookupError);
  const contactLine = tenant.reply_to_email
    ? `Questions? Contact ${tenant.name} at ${tenant.reply_to_email}.`
    : `Questions? Contact the ${tenant.name} front desk.`;

  return (
    <div className="min-h-screen bg-slate-50">
      <PublicHeader />
      <main className="mx-auto max-w-md p-4 sm:p-6">
        <Card className="mt-12 text-center">
          <CircleCheck size={40} className="mx-auto text-emerald-500" />
          <h1 className="mt-4 text-xl font-semibold text-slate-900">
            Payment received — you're booked!
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Just give your name at the front desk when you arrive.
          </p>

          {booking && (
            <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4 text-left">
              <div className="text-center">
                <div className="text-xs uppercase tracking-wide text-slate-500">
                  Booking reference
                </div>
                <div className="mt-1 font-mono text-2xl font-semibold tracking-widest text-slate-900">
                  {booking.reference}
                </div>
              </div>
              <dl className="mt-4 space-y-1.5 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Session</dt>
                  <dd className="text-right font-medium text-slate-900">
                    {booking.offering_name}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Where</dt>
                  <dd className="text-right text-slate-900">
                    {booking.resource_name}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">When</dt>
                  <dd className="text-right text-slate-900">
                    {formatSlotLocal(booking.start_time, tenant.timezone)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Paid</dt>
                  <dd className="text-right text-slate-900">
                    {formatCents(booking.amount_due_cents)}
                  </dd>
                </div>
              </dl>
              {booking.status === 'pending_payment' && (
                <p className="mt-3 text-xs text-slate-500">
                  Payment confirmation is still processing — your slot is
                  held, and you'll get an email once it's confirmed.
                </p>
              )}
            </div>
          )}

          {bookingId && !booking && email && !lookupError && (
            <p className="mt-6 text-sm text-slate-400">
              Loading your booking details…
            </p>
          )}

          {needsEmail && (
            <form
              className="mt-6 text-left"
              onSubmit={(e) => {
                e.preventDefault();
                const value = emailInput.trim().toLowerCase();
                if (!value) return;
                setLookupError(null);
                setEmail(value);
                setLookupNonce((n) => n + 1);
              }}
            >
              {lookupError && (
                <p className="mb-2 text-sm text-rose-700">
                  We couldn't find a booking for that email — double-check
                  and try again.
                </p>
              )}
              <Field
                label="Email you booked with"
                hint="We'll show your booking reference and slot details."
              >
                <Input
                  type="email"
                  required
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                />
              </Field>
              <Button type="submit" variant="secondary" className="mt-3 w-full">
                Show my booking
              </Button>
            </form>
          )}

          <p className="mt-6 text-sm text-slate-500">
            Can't make it? Reschedule free — the link is in your
            confirmation email, no account needed.
          </p>

          <p className="mt-3 text-sm text-slate-500">{contactLine}</p>

          <Button as={Link} to="/walk-in" variant="secondary" className="mt-4">
            Book another session
          </Button>
        </Card>
      </main>
    </div>
  );
}
