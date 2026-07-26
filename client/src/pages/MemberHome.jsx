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
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { bookingStatusBadge, formatSlotLocal } from '../format.js';
import {
  Page,
  PageHeader,
  Card,
  Button,
  Badge,
  ConfirmDialog,
} from '../components/ui/index.js';

const SUB_STATUS_TONES = {
  active: 'success',
  past_due: 'warning',
  cancelled: 'neutral',
  pending: 'info',
  incomplete: 'warning',
};

export default function MemberHome() {
  const { me, refresh } = useAuth();
  const [items, setItems] = useState(null); // unified list
  const [subscription, setSubscription] = useState(undefined);
  const [loadError, setLoadError] = useState(null);
  const [cancelMessage, setCancelMessage] = useState(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [cancelTarget, setCancelTarget] = useState(null); // item pending confirm

  async function openPortal() {
    if (portalBusy) return;
    setPortalBusy(true);
    try {
      const res = await api('/api/me/subscriptions/portal', {
        method: 'POST',
        body: JSON.stringify({ return_url: window.location.origin + '/' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      window.location.assign(body.url);
    } catch (err) {
      setCancelMessage(`Open portal failed: ${err.message}`);
      setPortalBusy(false);
    }
  }

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

  // Runs after the member confirms in the ConfirmDialog.
  async function cancel(item) {
    setCancelMessage(null);
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
    <Page width="default">
      <PageHeader
        title={`Welcome back, ${me.user.first_name}`}
        description="Your credits, subscription, and bookings at a glance."
        actions={
          <>
            <Button as={Link} to="/book" variant="primary">
              Book a session
            </Button>
            <Button as={Link} to="/classes" variant="secondary">
              Browse classes
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <div className="text-sm text-slate-500">Available credits</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">
            {credits}
          </div>
        </Card>
        <Card>
          <div className="text-sm text-slate-500">Subscription</div>
          {subscription ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold text-slate-900">
                {subscription.plan_name ?? '—'}
              </span>
              <Badge tone={SUB_STATUS_TONES[subscription.status] ?? 'neutral'}>
                {subscription.status}
              </Badge>
              {subscription.cancel_at_period_end && (
                <Badge tone="warning">ending at period end</Badge>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={openPortal}
                disabled={portalBusy}
              >
                {portalBusy ? 'opening…' : 'Manage'}
              </Button>
            </div>
          ) : (
            <div className="mt-1 text-sm text-slate-500">
              {subscription === undefined ? 'loading…' : 'No active plan'}
            </div>
          )}
        </Card>
      </div>

      {/* Subscribe CTA when not yet subscribed. undefined = still
          loading; null = loaded with no subscription. */}
      {subscription === null && (
        <Card className="border-brand-200 bg-brand-50">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium text-slate-900">
                Want weekly credits?
              </div>
              <div className="text-sm text-slate-600">
                Subscribe to a plan to get a fresh set of credits each week.
              </div>
            </div>
            <Button as={Link} to="/plans" variant="primary">
              View plans
            </Button>
          </div>
        </Card>
      )}

      {cancelMessage && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700">
          {cancelMessage}
        </div>
      )}

      <BookingList
        title="Upcoming"
        items={upcoming}
        error={loadError}
        empty="Nothing booked yet — pick a slot or class above."
        tz={me.tenant.timezone}
        onCancel={setCancelTarget}
        showCancel
      />

      {cancelTarget && (
        <ConfirmDialog
          title="Cancel booking?"
          message={`Cancel ${cancelTarget.offering_name} on ${formatSlotLocal(cancelTarget.start_time, me.tenant.timezone)}?`}
          confirmLabel="Cancel booking"
          cancelLabel="Keep booking"
          onConfirm={() => {
            const item = cancelTarget;
            setCancelTarget(null);
            cancel(item);
          }}
          onClose={() => setCancelTarget(null)}
        />
      )}

      <BookingList
        title="Past & cancelled"
        items={past}
        error={null}
        empty="No past bookings."
        tz={me.tenant.timezone}
        muted
      />
    </Page>
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
    <Card
      padded={false}
      title={
        <>
          {title}
          {items !== null && (
            <span className="ml-2 font-normal text-slate-400">
              ({items.length})
            </span>
          )}
        </>
      }
    >
      {error && <p className="px-5 py-4 text-sm text-rose-700">{error}</p>}
      {items === null ? (
        <p className="px-5 py-4 text-sm text-slate-400">loading…</p>
      ) : items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((b) => (
            <li
              key={`${b.kind}:${b.id}`}
              className={`flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50 ${muted ? 'opacity-70' : ''}`}
            >
              <div>
                <div className="font-medium text-slate-900">
                  {b.offering_name}
                  <span className="ml-2 text-sm font-normal text-slate-500">
                    {b.resource_name}
                  </span>
                  {b.kind === 'class' && (
                    <Badge tone="brand" className="ml-2">
                      class
                    </Badge>
                  )}
                </div>
                <div className="text-sm text-slate-500">
                  {formatSlotLocal(b.start_time, tz)} ·{' '}
                  {b.credit_cost_charged} credit
                  {b.credit_cost_charged === 1 ? '' : 's'}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={b.status} />
                {showCancel && b.status === 'confirmed' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onCancel(b)}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StatusBadge({ status }) {
  const { label, tone } = bookingStatusBadge(status);
  return <Badge tone={tone}>{label}</Badge>;
}
