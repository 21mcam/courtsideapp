// Member detail view (people-flows slice): profile, subscription
// status, credit balance with adjust modal, recent bookings, and the
// paginated credit ledger — all from GET /api/admin/members/:id.

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Page,
  PageHeader,
  Textarea,
} from '../components/ui/index.js';
import {
  bookingStatusBadge,
  formatCents,
  formatDate,
  formatSlotLocal,
} from '../format.js';

const LEDGER_PAGE_SIZE = 20;

const LEDGER_REASON_LABELS = {
  weekly_reset: 'weekly reset',
  admin_adjustment: 'admin adjustment',
  signup_bonus: 'signup bonus',
  booking_spend: 'booking',
  booking_refund: 'booking refund',
  plan_change: 'plan change',
  manual: 'manual',
  pack_purchase: 'credit pack',
  migration: 'imported',
};

export default function AdminMemberDetail() {
  const { id } = useParams();
  const { me } = useAuth();
  const tz = me.tenant.timezone;

  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [ledgerOffset, setLedgerOffset] = useState(0);
  const [adjusting, setAdjusting] = useState(false);

  const load = useCallback(
    async (offset) => {
      setLoadError(null);
      try {
        const res = await api(
          `/api/admin/members/${id}?ledger_limit=${LEDGER_PAGE_SIZE}&ledger_offset=${offset}`,
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        setDetail(body);
      } catch (err) {
        setLoadError(err.message);
      }
    },
    [id],
  );

  useEffect(() => {
    load(ledgerOffset);
  }, [load, ledgerOffset]);

  function adjusted() {
    setAdjusting(false);
    // Jump back to the newest ledger page — the new entry is there.
    if (ledgerOffset !== 0) setLedgerOffset(0);
    else load(0);
  }

  if (loadError) {
    return (
      <Page width="default">
        <BackLink />
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {loadError}
        </div>
      </Page>
    );
  }
  if (!detail) {
    return (
      <Page width="default">
        <BackLink />
        <p className="text-sm text-slate-400">loading…</p>
      </Page>
    );
  }

  const { member, subscription, bookings, ledger } = detail;

  return (
    <Page width="default">
      <BackLink />
      <PageHeader
        title={`${member.first_name} ${member.last_name}`}
        description={member.email}
        actions={
          <Button onClick={() => setAdjusting(true)}>Adjust credits</Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Profile">
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Phone</dt>
              <dd className="text-slate-900">{member.phone || '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Joined</dt>
              <dd className="text-slate-900">
                {formatDate(member.created_at, tz)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Login</dt>
              <dd>
                <Badge
                  tone={
                    member.login_active
                      ? 'success'
                      : member.user_id
                      ? 'warning'
                      : 'neutral'
                  }
                >
                  {member.login_active
                    ? 'has login'
                    : member.user_id
                    ? 'invite sent'
                    : 'no login'}
                </Badge>
              </dd>
            </div>
          </dl>
        </Card>

        <Card title="Credits">
          <div className="text-3xl font-semibold text-slate-900">
            {member.current_credits}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Current balance. Every change is recorded in the ledger below.
          </p>
        </Card>

        <Card title="Subscription">
          {subscription ? (
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Plan</dt>
                <dd className="font-medium text-slate-900">
                  {subscription.plan_name ?? '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Status</dt>
                <dd>
                  <Badge tone={subscriptionTone(subscription.status)}>
                    {subscription.status}
                    {subscription.cancel_at_period_end
                      ? ' · ends at period end'
                      : ''}
                  </Badge>
                </dd>
              </div>
              {subscription.monthly_price_cents != null && (
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Monthly</dt>
                  <dd className="text-slate-900">
                    {formatCents(subscription.monthly_price_cents)}
                  </dd>
                </div>
              )}
              {subscription.current_period_end && (
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Renews</dt>
                  <dd className="text-slate-900">
                    {formatDate(subscription.current_period_end, tz)}
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-sm text-slate-500">No active subscription.</p>
          )}
        </Card>
      </div>

      <Card padded={false} title={`Recent bookings (${bookings.length})`}>
        {bookings.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">
            No bookings yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Offering</th>
                  <th className="px-4 py-3">Resource</th>
                  <th className="px-4 py-3">Credits</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {bookings.map((b) => {
                  const badge = bookingStatusBadge(b.status);
                  return (
                    <tr key={b.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        {formatSlotLocal(b.start_time, tz)}
                      </td>
                      <td className="px-4 py-3">{b.offering_name}</td>
                      <td className="px-4 py-3">{b.resource_name}</td>
                      <td className="px-4 py-3">{b.credit_cost_charged}</td>
                      <td className="px-4 py-3">
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card padded={false} title={`Credit ledger (${ledger.total})`}>
        {ledger.entries.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">
            No credit activity yet.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3">Reason</th>
                    <th className="px-4 py-3">Note</th>
                    <th className="px-4 py-3 text-right">Change</th>
                    <th className="px-4 py-3 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ledger.entries.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        {formatSlotLocal(e.created_at, tz)}
                      </td>
                      <td className="px-4 py-3">
                        {LEDGER_REASON_LABELS[e.reason] ?? e.reason}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {e.note || '—'}
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-medium ${
                          e.amount > 0 ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        {e.amount > 0 ? `+${e.amount}` : e.amount}
                      </td>
                      <td className="px-4 py-3 text-right">{e.balance_after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
              <span>
                Showing {ledger.offset + 1}–
                {ledger.offset + ledger.entries.length} of {ledger.total}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={ledger.offset === 0}
                  onClick={() =>
                    setLedgerOffset(
                      Math.max(0, ledger.offset - LEDGER_PAGE_SIZE),
                    )
                  }
                >
                  Newer
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={ledger.offset + ledger.entries.length >= ledger.total}
                  onClick={() => setLedgerOffset(ledger.offset + LEDGER_PAGE_SIZE)}
                >
                  Older
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {adjusting && (
        <AdjustCreditsModal
          member={member}
          onClose={() => setAdjusting(false)}
          onAdjusted={adjusted}
        />
      )}
    </Page>
  );
}

function BackLink() {
  return (
    <Link
      to="/admin/members"
      className="text-sm font-medium text-brand-600 hover:text-brand-700"
    >
      ← All members
    </Link>
  );
}

function subscriptionTone(status) {
  switch (status) {
    case 'active':
      return 'success';
    case 'past_due':
      return 'warning';
    case 'pending':
    case 'incomplete':
      return 'info';
    default:
      return 'neutral';
  }
}

function AdjustCreditsModal({ member, onClose, onAdjusted }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const parsed = Number(amount);
    if (!Number.isInteger(parsed) || parsed === 0) {
      setError('Amount must be a non-zero whole number.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api(`/api/admin/members/${member.id}/credit-adjustments`, {
        method: 'POST',
        body: JSON.stringify({ amount: parsed, note: reason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onAdjusted();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/30"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative w-full max-w-lg rounded-lg bg-white shadow-xl border border-slate-200 p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-slate-900">
            Adjust credits
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          {member.first_name} {member.last_name} currently has{' '}
          {member.current_credits} credit
          {member.current_credits === 1 ? '' : 's'}. The adjustment is
          recorded in the ledger with your name on it.
        </p>
        <form onSubmit={submit}>
          <div className="space-y-4">
            <Field
              label="Amount"
              hint="Positive adds credits, negative deducts (e.g. -3)."
            >
              <Input
                type="number"
                required
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Reason">
              <Textarea
                required
                rows={2}
                placeholder="e.g. Goodwill credit for the rained-out session"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </div>
          {error && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}
          <div className="mt-6 flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Applying…' : 'Apply adjustment'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
