// Public walk-in booking flow — no login required.
//
// Same linear picker as the member BookingPage (offering → resource →
// date → slot), with two deliberate differences:
//   * Prices are dollars (walk-ins pay by card), never credits.
//   * Clicking a slot doesn't book — it selects. The walk-in then
//     fills in contact info and is redirected to Stripe Checkout;
//     the booking confirms when the webhook sees the payment.
//
// Auth context: `me` is null here. Tenant name + timezone come from
// useAuth().tenant, which loads for everyone (GET /api/tenant is
// public). Offerings come from GET /api/customers/offerings and slots
// from GET /api/availability — both public endpoints.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatCents, formatSlotLocal, formatTimeLocal } from '../format.js';

// Tenant-local YYYY-MM-DD for "today" — same helper as BookingPage.
function tenantLocalDate(tz, daysFromNow = 0) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + daysFromNow);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

export default function WalkInPage() {
  const { tenant, me } = useAuth();
  const tz = tenant.timezone;
  const [searchParams] = useSearchParams();
  const paymentCancelled = searchParams.get('cancelled') === '1';

  const [offerings, setOfferings] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [selectedOfferingId, setSelectedOfferingId] = useState('');
  const [selectedResourceId, setSelectedResourceId] = useState('');
  const [date, setDate] = useState(() => tenantLocalDate(tz));
  const [selectedSlot, setSelectedSlot] = useState(null);

  const [slots, setSlots] = useState(null);
  const [slotsError, setSlotsError] = useState(null);
  const [slotsReason, setSlotsReason] = useState(null);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const [contact, setContact] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    api('/api/customers/offerings')
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => setOfferings(data.offerings ?? []))
      .catch((err) => setLoadError(err.message));
  }, []);

  const selectedOffering = useMemo(
    () => (offerings ?? []).find((o) => o.id === selectedOfferingId) ?? null,
    [offerings, selectedOfferingId],
  );

  useEffect(() => {
    if (!selectedOffering) {
      setSelectedResourceId('');
      return;
    }
    setSelectedResourceId(selectedOffering.resources[0]?.id ?? '');
  }, [selectedOfferingId, selectedOffering]);

  // Any change upstream of the slot invalidates the selected slot.
  useEffect(() => {
    setSelectedSlot(null);
    setSubmitError(null);
  }, [selectedOfferingId, selectedResourceId, date]);

  useEffect(() => {
    if (!selectedOfferingId || !selectedResourceId || !date) {
      setSlots(null);
      setSlotsReason(null);
      return;
    }
    let cancelled = false;
    setLoadingSlots(true);
    setSlotsError(null);
    setSlotsReason(null);
    api(
      `/api/availability?offering_id=${selectedOfferingId}&resource_id=${selectedResourceId}&date=${date}`,
    )
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setSlots(data.slots ?? []);
        setSlotsReason(data.reason ?? null);
      })
      .catch((err) => {
        if (!cancelled) setSlotsError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingSlots(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedOfferingId, selectedResourceId, date]);

  const contactComplete =
    contact.first_name.trim() &&
    contact.last_name.trim() &&
    contact.email.trim();

  async function submit(e) {
    e.preventDefault();
    if (submitting || !selectedSlot || !contactComplete) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api('/api/customers/bookings', {
        method: 'POST',
        body: JSON.stringify({
          offering_id: selectedOfferingId,
          resource_id: selectedResourceId,
          start_time: selectedSlot.start,
          customer: {
            first_name: contact.first_name.trim(),
            last_name: contact.last_name.trim(),
            email: contact.email.trim(),
            ...(contact.phone.trim() ? { phone: contact.phone.trim() } : {}),
          },
          success_url: `${window.location.origin}/walk-in/success`,
          cancel_url: `${window.location.origin}/walk-in?cancelled=1`,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      // Off to Stripe Checkout; the webhook confirms the booking.
      window.location.assign(body.checkout_url);
    } catch (err) {
      setSubmitError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
        <div className="font-semibold">{tenant.name}</div>
        <Link to={me ? '/' : '/login'} className="text-sm text-sky-700 hover:underline">
          {me ? 'Back to my account' : 'Member sign in'}
        </Link>
      </header>
      <main className="max-w-2xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Book a session</h1>
          <p className="text-sm text-slate-500">
            No account needed — pick a time, pay by card, and you're
            booked. Times shown in {tz}.
          </p>
        </div>

        {paymentCancelled && !selectedSlot && (
          <div className="rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            Payment was cancelled — no booking was made. Pick a time to
            try again.
          </div>
        )}

        {loadError && (
          <div className="rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800">
            {loadError}
          </div>
        )}

        {/* Offering picker */}
        <section>
          <label className="block text-sm font-medium text-slate-700">
            What would you like to book?
          </label>
          {offerings === null ? (
            <p className="mt-2 text-sm text-slate-400">loading…</p>
          ) : offerings.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              Online walk-in booking isn't available yet. Contact the
              front desk to book.
            </p>
          ) : (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {offerings.map((o) => (
                <button
                  key={o.id}
                  onClick={() => setSelectedOfferingId(o.id)}
                  className={`text-left rounded border px-3 py-2 transition ${
                    selectedOfferingId === o.id
                      ? 'border-sky-700 bg-sky-50'
                      : 'border-slate-200 bg-white hover:border-slate-400'
                  }`}
                >
                  <div className="font-medium">{o.name}</div>
                  <div className="text-xs text-slate-500">
                    {o.duration_minutes} min · {formatCents(o.dollar_price)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Resource picker — only if the offering has multiple resources */}
        {selectedOffering && selectedOffering.resources.length > 1 && (
          <section>
            <label className="block text-sm font-medium text-slate-700">
              Which {selectedOffering.name}?
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              {selectedOffering.resources.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedResourceId(r.id)}
                  className={`rounded border px-3 py-1 text-sm transition ${
                    selectedResourceId === r.id
                      ? 'border-sky-700 bg-sky-50'
                      : 'border-slate-200 bg-white hover:border-slate-400'
                  }`}
                >
                  {r.name}
                </button>
              ))}
            </div>
          </section>
        )}

        {selectedOffering && selectedOffering.resources.length === 0 && (
          <p className="text-sm text-slate-500">
            This offering isn't currently available to book online.
          </p>
        )}

        {/* Date picker */}
        {selectedOffering && selectedResourceId && (
          <section>
            <label
              htmlFor="walkin-date"
              className="block text-sm font-medium text-slate-700"
            >
              Date
            </label>
            <input
              id="walkin-date"
              type="date"
              value={date}
              min={tenantLocalDate(tz)}
              onChange={(e) => setDate(e.target.value)}
              className="mt-2 rounded border border-slate-300 px-3 py-1 text-sm"
            />
          </section>
        )}

        {/* Slots */}
        {selectedOffering && selectedResourceId && date && (
          <section>
            <h2 className="text-sm font-medium text-slate-700">
              Available times
            </h2>
            {loadingSlots ? (
              <p className="mt-2 text-sm text-slate-400">loading…</p>
            ) : slotsError ? (
              <p className="mt-2 text-sm text-rose-700">{slotsError}</p>
            ) : slots && slots.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">
                No open slots on this day.
                {slotsReason && (
                  <span className="ml-1 text-slate-400">({slotsReason})</span>
                )}
              </p>
            ) : slots ? (
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {slots.map((s) => (
                  <button
                    key={s.start}
                    onClick={() => setSelectedSlot(s)}
                    className={`rounded border px-2 py-2 text-sm transition ${
                      selectedSlot?.start === s.start
                        ? 'border-sky-700 bg-sky-50 font-medium'
                        : 'border-slate-300 bg-white hover:border-sky-700 hover:bg-sky-50'
                    }`}
                  >
                    {formatTimeLocal(s.start, tz)}
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        )}

        {/* Contact + pay */}
        {selectedSlot && selectedOffering && (
          <section className="rounded border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-medium text-slate-700">
              Your details
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {selectedOffering.name} ·{' '}
              {formatSlotLocal(selectedSlot.start, tz)} ·{' '}
              {formatCents(selectedOffering.dollar_price)}
            </p>
            <form onSubmit={submit} className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-slate-700">First name</span>
                  <input
                    required
                    value={contact.first_name}
                    onChange={(e) =>
                      setContact({ ...contact, first_name: e.target.value })
                    }
                    className="mt-1 w-full rounded border border-slate-300 px-3 py-1.5"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-slate-700">Last name</span>
                  <input
                    required
                    value={contact.last_name}
                    onChange={(e) =>
                      setContact({ ...contact, last_name: e.target.value })
                    }
                    className="mt-1 w-full rounded border border-slate-300 px-3 py-1.5"
                  />
                </label>
              </div>
              <label className="block text-sm">
                <span className="text-slate-700">Email</span>
                <input
                  required
                  type="email"
                  value={contact.email}
                  onChange={(e) =>
                    setContact({ ...contact, email: e.target.value })
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-1.5"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-700">
                  Phone <span className="text-slate-400">(optional)</span>
                </span>
                <input
                  type="tel"
                  value={contact.phone}
                  onChange={(e) =>
                    setContact({ ...contact, phone: e.target.value })
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-1.5"
                />
              </label>
              <button
                type="submit"
                disabled={submitting || !contactComplete}
                className="w-full rounded bg-sky-700 px-4 py-2 text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting
                  ? 'Redirecting to payment…'
                  : `Continue to payment · ${formatCents(selectedOffering.dollar_price)}`}
              </button>
              <p className="text-xs text-slate-400">
                Your slot is held for 15 minutes while you pay. Payment
                is handled securely by Stripe.
              </p>
            </form>
          </section>
        )}

        {submitError && (
          <div className="rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800">
            Booking failed: {submitError}
          </div>
        )}
      </main>
    </div>
  );
}
