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
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { addDays, localDateString, todayLocalString, zonedDayStartIso } from '../lib/tz.js';
import { bookingStatusBadge, formatSlotLocal } from '../format.js';
import { Badge, Button, Card, Field, Input, Page, PageHeader } from '../components/ui/index.js';

const DEFAULT_STATUS_FILTERS = ['confirmed', 'pending_payment'];
const ALL_STATUSES = [
  'confirmed',
  'pending_payment',
  'completed',
  'no_show',
  'cancelled',
];


export default function AdminBookings() {
  const { me } = useAuth();
  const tz = me.tenant.timezone;

  // Default window: tenant-local today → +7 days. This must be
  // TENANT-local midnight, not the viewer's — setHours(0,...) on a
  // staff laptop in another timezone shifts the window by the zone
  // difference and drops/leaks bookings at the day boundaries.
  const [from, setFrom] = useState(() =>
    zonedDayStartIso(todayLocalString(tz), tz),
  );
  const [to, setTo] = useState(() =>
    zonedDayStartIso(addDays(todayLocalString(tz), 7), tz),
  );
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

  // Date input value <-> ISO conversion. The YYYY-MM-DD the admin
  // picks means a TENANT-local calendar day — the page header says
  // "Times shown in {tz}", so the window boundaries must agree.
  function setFromDate(yyyymmdd) {
    if (!yyyymmdd) return;
    setFrom(zonedDayStartIso(yyyymmdd, tz));
  }
  function setToDate(yyyymmdd) {
    if (!yyyymmdd) return;
    setTo(zonedDayStartIso(yyyymmdd, tz));
  }

  return (
    <Page width="default">
      <PageHeader
        title="Bookings"
        description={`Times shown in ${tz}. Up to 500 bookings per query.`}
      />

      {/* Filters */}
      <Card>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <DateField label="From" valueIso={from} tz={tz} onChange={setFromDate} />
            <DateField label="To" valueIso={to} tz={tz} onChange={setToDate} />
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_STATUSES.map((s) => {
              const active = statusFilters.includes(s);
              const { label } = bookingStatusBadge(s);
              return (
                <button
                  key={s}
                  onClick={() => toggleStatus(s)}
                  className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
                    active
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      {actionMessage && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700">
          {actionMessage}
        </div>
      )}

      {loadError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {loadError}
        </div>
      )}

      <BookingTable
        bookings={bookings}
        tz={tz}
        onCancel={cancel}
        onNoShow={markNoShow}
      />
    </Page>
  );
}

function DateField({ label, valueIso, tz, onChange }) {
  // Render the stored ISO as YYYY-MM-DD in the TENANT's zone so the
  // input round-trips with the tenant-local window boundaries.
  const yyyymmdd = localDateString(valueIso, tz);
  return (
    <Field label={label}>
      <Input
        type="date"
        value={yyyymmdd}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function BookingTable({ bookings, tz, onCancel, onNoShow }) {
  if (bookings === null) {
    return <p className="text-sm text-slate-400">loading…</p>;
  }
  if (bookings.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
        No bookings match the current filters.
      </div>
    );
  }
  const now = Date.now();
  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Offering</th>
              <th className="px-4 py-3">Resource</th>
              <th className="px-4 py-3">Who</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {bookings.map((b) => {
              const isPast = new Date(b.start_time).getTime() <= now;
              const badge = bookingStatusBadge(b.status);
              const who = b.member_id
                ? `${b.member_first_name ?? ''} ${b.member_last_name ?? ''}`.trim()
                : b.customer_first_name
                ? `${b.customer_first_name} ${b.customer_last_name ?? ''}`.trim()
                : '—';
              return (
                <tr key={b.id} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    {formatSlotLocal(b.start_time, tz)}
                  </td>
                  <td className="px-4 py-3 text-sm">{b.offering_name}</td>
                  <td className="px-4 py-3 text-sm">{b.resource_name}</td>
                  <td className="px-4 py-3 text-sm">
                    <div>{who || '—'}</div>
                    {b.member_email && (
                      <div className="font-mono text-xs text-slate-500">
                        {b.member_email}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    {b.status === 'confirmed' && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => onCancel(b)}>
                          Cancel
                        </Button>
                        {isPast && (
                          <Button size="sm" variant="danger" onClick={() => onNoShow(b)}>
                            No-show
                          </Button>
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
    </Card>
  );
}
