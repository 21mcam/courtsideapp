// Member dashboard — Phase 4 update.
//
// Three things the signed-in member cares about:
//   1. How many credits do I have?
//   2. What bookings (rentals AND classes) do I have coming up?
//   3. How do I book another session?
//
// Rentals and class bookings are fetched separately (/api/bookings/me
// and /api/class-bookings/me) and merged into a single normalized list
// so the upcoming/past split treats them uniformly. The cancel call
// dispatches to the right endpoint based on `kind`.
//
// Cancel surfaces refund tier per booking_policies. Past + cancelled
// rows are listed but muted and don't get a cancel button.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { bookingStatusBadge, formatSlotLocal } from '../format.js';

export default function MemberHome() {
  const { me, refresh } = useAuth();
  const [items, setItems] = useState(null); // unified list
  const [subscription, setSubscription] = useState(undefined);
  const [loadError, setLoadError] = useState(null);
  const [cancelMessage, setCancelMessage] = useState(null);

  function load() {
    setLoadError(null);
    Promise.all([
      api('/api/bookings/me').then(handle),
      api('/api/class-bookings/me').then(handle),
      api('/api/me/subscriptions').then(handle),
    ])
      .then(([rentals, classes, sub]) => {
        setSubscription(sub.subscription ?? null);
        const norm = [
          ...(rentals.bookings ?? []).map((b) => ({
            kind: 'rental',
            id: b.id,
            offering_name: b.offering_name,
            resource_name: b.resource_name,
            start_time: b.start_time,
            status: b.status,
            credit_cost_charged: b.credit_cost_charged,
          })),
          ...(classes.class_bookings ?? []).map((cb) => ({
            kind: 'class',
            id: cb.id,
            offering_name: cb.offering_name,
            resource_name: cb.resource_name,
            start_time: cb.start_time,
            status: cb.status,
            credit_cost_charged: cb.credit_cost_charged,
          })),
        ];
        setItems(norm);
      })
      .catch((err) => setLoadError(err.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function cancel(item) {
    setCancelMessage(null);
    if (
      !window.confirm(
        `Cancel ${item.offering_name} on ${formatSlotLocal(item.start_time, me.tenant.timezone)}?`,
      )
    ) {
      return;
    }
    const path =
      item.kind === 'class'
        ? `/api/class-bookings/${item.id}/cancel`
        : `/api/bookings/${item.id}/cancel`;
    try {
      const res = await api(path, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const refunded = body.refund_credits ?? 0;
      setCancelMessage(
        refunded > 0
          ? `Cancelled. ${refunded} credit${refunded === 1 ? '' : 's'} refunded (${body.refund_percent}%).`
          : 'Cancelled. No refund per policy.',
      );
      await refresh();
      load();
    } catch (err) {
      setCancelMessage(`Cancel failed: ${err.message}`);
    }
  }

  const credits = me.credits?.current_credits ?? 0;

  // Sort merged list by start_time before splitting upcoming/past.
  const now = Date.now();
  const sorted =
    items === null
      ? null
      : [...items].sort(
          (a, b) =>
            new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
        );
  const upcoming =
    sorted?.filter(
      (b) => b.status !== 'cancelled' && new Date(b.start_time).getTime() > now,
    ) ?? null;
  const past =
    sorted?.filter(
      (b) => b.status === 'cancelled' || new Date(b.start_time).getTime() <= now,
    )
      // Past list reads more naturally newest-first.
      .reverse() ?? null;

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-3xl mx-auto p-6 space-y-8">
        <section className="rounded border border-slate-200 bg-white p-5 flex items-center justify-between">
          <div>
            <div className="text-sm text-slate-500">Available credits</div>
            <div className="text-3xl font-semibold tabular-nums">{credits}</div>
            {subscription && (
              <div className="mt-1 text-xs text-slate-500">
                Subscribed to{' '}
                <span className="font-medium text-slate-700">
                  {subscription.plan_name ?? '—'}
                </span>{' '}
                · {subscription.status}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Link
              to="/book"
              className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800"
            >
              Book a session
            </Link>
            <Link
              to="/classes"
              className="rounded border border-sky-700 px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50"
            >
              Browse classes
            </Link>
          </div>
        </section>

        {/* Subscribe CTA when not yet subscribed. undefined = still
            loading; null = loaded with no subscription. */}
        {subscription === null && (
          <section className="rounded border border-indigo-200 bg-indigo-50 px-5 py-4 flex items-center justify-between">
            <div>
              <div className="font-medium text-indigo-900">
                Want weekly credits?
              </div>
              <div className="text-sm text-indigo-800">
                Subscribe to a plan to get a fresh set of credits each week.
              </div>
            </div>
            <Link
              to="/plans"
              className="rounded bg-indigo-700 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-800"
            >
              View plans
            </Link>
          </section>
        )}

        {cancelMessage && (
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">
            {cancelMessage}
          </div>
        )}

        <BookingList
          title="Upcoming"
          items={upcoming}
          error={loadError}
          empty="Nothing booked yet — pick a slot or class above."
          tz={me.tenant.timezone}
          onCancel={cancel}
          showCancel
        />

        <BookingList
          title="Past & cancelled"
          items={past}
          error={null}
          empty="No past bookings."
          tz={me.tenant.timezone}
          muted
        />
      </main>
    </div>
  );
}

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function BookingList({
  title,
  items,
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
        {items !== null && (
          <span className="ml-2 text-slate-400 text-sm font-normal">
            ({items.length})
          </span>
        )}
      </h2>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {items === null ? (
        <p className="mt-2 text-sm text-slate-400">loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-200 rounded border border-slate-200 bg-white">
          {items.map((b) => (
            <li
              key={`${b.kind}:${b.id}`}
              className={`flex items-center justify-between px-4 py-3 ${muted ? 'opacity-70' : ''}`}
            >
              <div>
                <div className="font-medium">
                  {b.offering_name}
                  <span className="ml-2 text-sm font-normal text-slate-500">
                    {b.resource_name}
                  </span>
                  {b.kind === 'class' && (
                    <span className="ml-2 text-xs rounded bg-violet-100 text-violet-900 px-1.5 py-0.5">
                      class
                    </span>
                  )}
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
