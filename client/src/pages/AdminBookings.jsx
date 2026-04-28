// Admin booking calendar.
//
// Shows the tenant's bookings in a date-windowed list with filter
// chips for status. Default window: today through 7 days out.
// Defaults to confirmed + pending_payment so the operator sees
// what's ahead without noise from completed/cancelled history.
//
// Actions per row:
//   * Cancel    (any confirmed booking) → POST /api/bookings/:id/cancel
//   * No-show   (confirmed + start_time in past) → POST .../mark-no-show
//
// Both mutate-then-reload. No optimistic update; the list is small
// enough that round-tripping is fine, and reload guarantees we see
// the final state after the policy/refund/audit logic runs.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { bookingStatusBadge, formatSlotLocal } from '../format.js';

const DEFAULT_STATUS_FILTERS = ['confirmed', 'pending_payment'];
const ALL_STATUSES = [
  'confirmed',
  'pending_payment',
  'completed',
  'no_show',
  'cancelled',
];

// Compute an ISO timestamp for "today at midnight, tenant-local" — used as
// the default `from` in the query. Falls back to start of UTC day if the
// browser doesn't support timeZone option (it does, but be safe).
function dayStartIso(daysFromNow = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString();
}

export default function AdminBookings() {
  const { me } = useAuth();
  const tz = me.tenant.timezone;

  const [from, setFrom] = useState(() => dayStartIso(0));
  const [to, setTo] = useState(() => dayStartIso(7));
  const [statusFilters, setStatusFilters] = useState(DEFAULT_STATUS_FILTERS);

  const [bookings, setBookings] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [actionMessage, setActionMessage] = useState(null);

  function load() {
    setLoadError(null);
    const qs = new URLSearchParams();
    qs.set('from', from);
    qs.set('to', to);
    statusFilters.forEach((s) => qs.append('status', s));
    api(`/api/admin/bookings?${qs.toString()}`)
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

  useEffect(load, [from, to, statusFilters]);

  function toggleStatus(s) {
    setStatusFilters((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }

  async function cancel(b) {
    setActionMessage(null);
    const reason = window.prompt(
      `Cancel "${b.offering_name}" on ${formatSlotLocal(b.start_time, tz)}?\nOptional reason:`,
      '',
    );
    if (reason === null) return; // user dismissed prompt
    try {
      const res = await api(`/api/bookings/${b.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ cancellation_reason: reason || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const refunded = body.refund_credits ?? 0;
      setActionMessage(
        refunded > 0
          ? `Cancelled. ${refunded} credit${refunded === 1 ? '' : 's'} refunded (${body.refund_percent}%).`
          : 'Cancelled. No refund per policy.',
      );
      load();
    } catch (err) {
      setActionMessage(`Cancel failed: ${err.message}`);
    }
  }

  async function markNoShow(b) {
    setActionMessage(null);
    if (
      !window.confirm(
        `Mark ${b.member_first_name ?? 'customer'} as no-show for "${b.offering_name}" at ${formatSlotLocal(b.start_time, tz)}?`,
      )
    ) {
      return;
    }
    try {
      const res = await api(`/api/bookings/${b.id}/mark-no-show`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const policyHint =
        body.policy_action === 'charge_fee' && body.policy_fee_cents
          ? ` Policy: charge fee of $${(body.policy_fee_cents / 100).toFixed(2)} (manual for now).`
          : body.policy_action && body.policy_action !== 'none'
          ? ` Policy: ${body.policy_action}.`
          : '';
      setActionMessage(`Marked no-show.${policyHint}`);
      load();
    } catch (err) {
      setActionMessage(`Mark no-show failed: ${err.message}`);
    }
  }

  // Date input value <-> ISO conversion. Native <input type="date">
  // gives YYYY-MM-DD in the browser's local zone; we convert to a
  // start-of-day ISO. Good enough for an internal admin tool.
  function setFromDate(yyyymmdd) {
    if (!yyyymmdd) return;
    const d = new Date(yyyymmdd + 'T00:00:00');
    setFrom(d.toISOString());
  }
  function setToDate(yyyymmdd) {
    if (!yyyymmdd) return;
    const d = new Date(yyyymmdd + 'T00:00:00');
    setTo(d.toISOString());
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <div>
          <Link to="/" className="text-sm text-sky-700 hover:underline">
            ← Back
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">Bookings</h1>
          <p className="text-sm text-slate-500">
            Times shown in {tz}. Up to 500 bookings per query.
          </p>
        </div>

        {/* Filters */}
        <section className="rounded border border-slate-200 bg-white p-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <DateField label="From" valueIso={from} onChange={setFromDate} />
            <DateField label="To" valueIso={to} onChange={setToDate} />
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_STATUSES.map((s) => {
              const active = statusFilters.includes(s);
              const { label } = bookingStatusBadge(s);
              return (
                <button
                  key={s}
                  onClick={() => toggleStatus(s)}
                  className={`text-xs rounded-full px-3 py-1 border transition ${
                    active
                      ? 'border-sky-700 bg-sky-50 text-sky-900'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-400'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </section>

        {actionMessage && (
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">
            {actionMessage}
          </div>
        )}

        {loadError && (
          <div className="rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800">
            {loadError}
          </div>
        )}

        <BookingTable
          bookings={bookings}
          tz={tz}
          onCancel={cancel}
          onNoShow={markNoShow}
        />
      </main>
    </div>
  );
}

function DateField({ label, valueIso, onChange }) {
  // Convert the stored ISO to YYYY-MM-DD in the browser's local zone
  // for the native input.
  const yyyymmdd = (() => {
    const d = new Date(valueIso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  })();
  return (
    <label className="block text-sm">
      <span className="text-slate-700">{label}</span>
      <input
        type="date"
        value={yyyymmdd}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block rounded border border-slate-300 px-2 py-1"
      />
    </label>
  );
}

function BookingTable({ bookings, tz, onCancel, onNoShow }) {
  if (bookings === null) {
    return <p className="text-sm text-slate-400">loading…</p>;
  }
  if (bookings.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No bookings match the current filters.
      </p>
    );
  }
  const now = Date.now();
  return (
    <div className="overflow-x-auto rounded border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="text-left text-slate-500 border-b border-slate-200">
          <tr>
            <th className="py-2 px-3 font-medium">When</th>
            <th className="py-2 px-3 font-medium">Offering</th>
            <th className="py-2 px-3 font-medium">Resource</th>
            <th className="py-2 px-3 font-medium">Who</th>
            <th className="py-2 px-3 font-medium">Status</th>
            <th className="py-2 px-3 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {bookings.map((b) => {
            const isPast = new Date(b.start_time).getTime() <= now;
            const { label, className } = bookingStatusBadge(b.status);
            const who = b.member_id
              ? `${b.member_first_name ?? ''} ${b.member_last_name ?? ''}`.trim()
              : b.customer_first_name
              ? `${b.customer_first_name} ${b.customer_last_name ?? ''}`.trim()
              : '—';
            return (
              <tr key={b.id} className="border-b border-slate-100 last:border-0">
                <td className="py-2 px-3 whitespace-nowrap">
                  {formatSlotLocal(b.start_time, tz)}
                </td>
                <td className="py-2 px-3">{b.offering_name}</td>
                <td className="py-2 px-3">{b.resource_name}</td>
                <td className="py-2 px-3">
                  <div>{who || '—'}</div>
                  {b.member_email && (
                    <div className="text-xs text-slate-500 font-mono">
                      {b.member_email}
                    </div>
                  )}
                </td>
                <td className="py-2 px-3">
                  <span className={`text-xs rounded px-2 py-0.5 ${className}`}>
                    {label}
                  </span>
                </td>
                <td className="py-2 px-3 whitespace-nowrap">
                  {b.status === 'confirmed' && (
                    <div className="flex gap-1">
                      <button
                        onClick={() => onCancel(b)}
                        className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                      {isPast && (
                        <button
                          onClick={() => onNoShow(b)}
                          className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900 hover:bg-amber-100"
                        >
                          No-show
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
