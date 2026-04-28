// Member dashboard.
//
// Three things the signed-in member cares about:
//   1. How many credits do I have?
//   2. What bookings do I have coming up (and which are past)?
//   3. How do I book another session?
//
// Cancel button hits POST /api/bookings/:id/cancel and refreshes the
// list. Refund tier comes from booking_policies + time-until-start
// — the response surfaces refund_credits and refund_percent so the
// UI can confirm what happened.
//
// Past bookings are still listed but get a muted style and no
// cancel button.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { bookingStatusBadge, formatSlotLocal } from '../format.js';

export default function MemberHome() {
  const { me, refresh } = useAuth();
  const [bookings, setBookings] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [cancelMessage, setCancelMessage] = useState(null);

  function load() {
    setLoadError(null);
    api('/api/bookings/me')
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => setBookings(data.bookings ?? []))
      .catch((err) => setLoadError(err.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function cancel(booking) {
    setCancelMessage(null);
    if (
      !window.confirm(
        `Cancel ${booking.offering_name} on ${formatSlotLocal(booking.start_time, me.tenant.timezone)}?`,
      )
    ) {
      return;
    }
    try {
      const res = await api(`/api/bookings/${booking.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const refunded = body.refund_credits ?? 0;
      setCancelMessage(
        refunded > 0
          ? `Cancelled. ${refunded} credit${refunded === 1 ? '' : 's'} refunded (${body.refund_percent}%).`
          : 'Cancelled. No refund per policy.',
      );
      await refresh(); // pull fresh credit balance
      load();
    } catch (err) {
      setCancelMessage(`Cancel failed: ${err.message}`);
    }
  }

  const credits = me.credits?.current_credits ?? 0;

  // Split into upcoming vs past so members see the relevant ones first.
  const now = Date.now();
  const upcoming =
    bookings?.filter(
      (b) => b.status !== 'cancelled' && new Date(b.start_time).getTime() > now,
    ) ?? null;
  const past =
    bookings?.filter(
      (b) => b.status === 'cancelled' || new Date(b.start_time).getTime() <= now,
    ) ?? null;

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-3xl mx-auto p-6 space-y-8">
        <section className="rounded border border-slate-200 bg-white p-5 flex items-center justify-between">
          <div>
            <div className="text-sm text-slate-500">Available credits</div>
            <div className="text-3xl font-semibold tabular-nums">{credits}</div>
          </div>
          <Link
            to="/book"
            className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800"
          >
            Book a session
          </Link>
        </section>

        {cancelMessage && (
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">
            {cancelMessage}
          </div>
        )}

        <BookingList
          title="Upcoming"
          bookings={upcoming}
          error={loadError}
          empty="Nothing booked yet — pick a slot above."
          tz={me.tenant.timezone}
          onCancel={cancel}
          showCancel
        />

        <BookingList
          title="Past & cancelled"
          bookings={past}
          error={null /* shown above already */}
          empty="No past bookings."
          tz={me.tenant.timezone}
          muted
        />
      </main>
    </div>
  );
}

function BookingList({
  title,
  bookings,
  error,
  empty,
  tz,
  onCancel,
  showCancel = false,
  muted = false,
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold">
        {title}
        {bookings !== null && (
          <span className="ml-2 text-slate-400 text-sm font-normal">
            ({bookings.length})
          </span>
        )}
      </h2>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {bookings === null ? (
        <p className="mt-2 text-sm text-slate-400">loading…</p>
      ) : bookings.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-200 rounded border border-slate-200 bg-white">
          {bookings.map((b) => (
            <li
              key={b.id}
              className={`flex items-center justify-between px-4 py-3 ${muted ? 'opacity-70' : ''}`}
            >
              <div>
                <div className="font-medium">
                  {b.offering_name}
                  <span className="ml-2 text-sm font-normal text-slate-500">
                    {b.resource_name}
                  </span>
                </div>
                <div className="text-sm text-slate-600">
                  {formatSlotLocal(b.start_time, tz)} ·{' '}
                  {b.credit_cost_charged} credit
                  {b.credit_cost_charged === 1 ? '' : 's'}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={b.status} />
                {showCancel && b.status === 'confirmed' && (
                  <button
                    onClick={() => onCancel(b)}
                    className="rounded border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusBadge({ status }) {
  const { label, className } = bookingStatusBadge(status);
  return (
    <span className={`text-xs rounded px-2 py-0.5 ${className}`}>{label}</span>
  );
}
