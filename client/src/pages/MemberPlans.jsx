// Member subscription chooser — Phase 5 slice 4a — plus one-time
// credit packs (credit-packs slice).
//
// Lists plans available for subscription; click "Subscribe" → POST
// /api/me/subscriptions/checkout, redirect to the Stripe-hosted
// Checkout page. After payment Stripe redirects back to /?subscribed=1
// (the success_url). The webhook is what actually creates our
// subscriptions row + grants credits, so on return the dashboard
// will reflect the new subscription within a couple seconds.
//
// Credit packs work the same way in mode='payment': "Buy" → POST
// /api/packs/:id/checkout → Stripe → back here with ?pack_success=1
// (success banner below); the webhook grants the credits. Purchased
// credits roll over week to week until spent — no subscription
// required.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  formatAllowedCategories,
  formatCents,
} from '../format.js';
import { Page, PageHeader, Card, Button, Badge } from '../components/ui/index.js';

export default function MemberPlans() {
  const { me } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [plans, setPlans] = useState(null);
  const [packs, setPacks] = useState(null);
  const [currentSub, setCurrentSub] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busyPlanId, setBusyPlanId] = useState(null);
  const [busyPackId, setBusyPackId] = useState(null);
  const [actionError, setActionError] = useState(null);
  // Sticky success state on return from pack Checkout — survives the
  // URL cleanup below.
  const [packSuccess] = useState(searchParams.get('pack_success') === '1');

  // Drop the ?pack_success=1 marker so a refresh doesn't re-announce.
  useEffect(() => {
    if (searchParams.get('pack_success') === '1') {
      const next = new URLSearchParams(searchParams);
      next.delete('pack_success');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  function load() {
    setLoadError(null);
    Promise.all([
      api('/api/me/plans').then(handle),
      api('/api/me/subscriptions').then(handle),
      api('/api/packs').then(handle),
    ])
      .then(([p, s, k]) => {
        setPlans(p.plans ?? []);
        setCurrentSub(s.subscription ?? null);
        setPacks(k.packs ?? []);
      })
      .catch((err) => setLoadError(err.message));
  }

  useEffect(load, []);

  async function buyPack(pack) {
    if (busyPackId) return;
    setBusyPackId(pack.id);
    setActionError(null);
    try {
      const here = window.location.origin;
      const res = await api(`/api/packs/${pack.id}/checkout`, {
        method: 'POST',
        body: JSON.stringify({
          success_url: `${here}/plans?pack_success=1`,
          cancel_url: `${here}/plans`,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      window.location.assign(body.url);
    } catch (err) {
      setActionError(err.message);
      setBusyPackId(null);
    }
  }

  async function subscribe(plan) {
    if (busyPlanId) return;
    setBusyPlanId(plan.id);
    setActionError(null);
    try {
      const here = window.location.origin;
      const res = await api('/api/me/subscriptions/checkout', {
        method: 'POST',
        body: JSON.stringify({
          plan_id: plan.id,
          success_url: `${here}/?subscribed=1`,
          cancel_url: `${here}/plans`,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      // Redirect to Stripe Checkout
      window.location.assign(body.url);
    } catch (err) {
      setActionError(err.message);
      setBusyPlanId(null);
    }
  }

  if (!me.memberships.member) {
    return (
      <Page width="default">
        <PageHeader title="Plans" />
        <p className="text-sm text-slate-700">
          Subscriptions require a member account.
        </p>
      </Page>
    );
  }

  return (
    <Page width="default">
      <PageHeader
        title="Plans"
        description="Pay monthly. Cancel any time. Credits drop into your account once your first payment clears."
      />

      {packSuccess && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          <strong>Payment received.</strong> Your credits will appear on
          your account within a few seconds — check your email for the
          receipt.
        </div>
      )}

      {currentSub && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          You're already subscribed to{' '}
          <strong>{currentSub.plan_name ?? 'a plan'}</strong>. Cancel
          it from the dashboard before subscribing to a different
          plan.
        </div>
      )}

      {loadError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {loadError}
        </div>
      )}
      {actionError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Subscribe failed: {actionError}
        </div>
      )}

      {plans === null ? (
        <p className="text-sm text-slate-400">loading…</p>
      ) : plans.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No plans available right now. Ask the facility to add one.
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((p) => {
            const isCurrent = currentSub?.plan_id === p.id;
            return (
              <li key={p.id}>
                <Card className="flex h-full flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold text-slate-900">{p.name}</div>
                    {isCurrent && <Badge tone="brand">Current plan</Badge>}
                  </div>
                  <div className="mt-2">
                    <span className="text-2xl font-semibold text-slate-900">
                      {formatCents(p.monthly_price_cents)}
                    </span>
                    <span className="ml-1 text-sm text-slate-500">/mo</span>
                  </div>
                  {p.description && (
                    <div className="mt-2 text-sm text-slate-500">
                      {p.description}
                    </div>
                  )}
                  <div className="mt-2 text-sm text-slate-500">
                    {p.credits_per_week} credit
                    {p.credits_per_week === 1 ? '' : 's'} per week ·{' '}
                    {formatAllowedCategories(p.allowed_categories)}
                  </div>
                  <div className="mt-auto pt-4">
                    <Button
                      variant="primary"
                      className="w-full"
                      onClick={() => subscribe(p)}
                      disabled={!!currentSub || busyPlanId === p.id}
                    >
                      {busyPlanId === p.id ? 'opening…' : 'Subscribe'}
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {/* One-time credit packs — no subscription required. Hidden
          entirely when the facility hasn't created any. */}
      {packs !== null && packs.length > 0 && (
        <>
          <div className="pt-2">
            <h2 className="text-lg font-semibold text-slate-900">
              Credit packs
            </h2>
            <p className="text-sm text-slate-500">
              One-time purchase, no subscription. Purchased credits roll
              over week to week until you use them.
            </p>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {packs.map((k) => (
              <li key={k.id}>
                <Card className="flex h-full flex-col">
                  <div className="font-semibold text-slate-900">{k.name}</div>
                  <div className="mt-2">
                    <span className="text-2xl font-semibold text-slate-900">
                      {formatCents(k.price_cents)}
                    </span>
                    <span className="ml-1 text-sm text-slate-500">
                      one-time
                    </span>
                  </div>
                  <div className="mt-2 text-sm text-slate-500">
                    {k.credits} credit{k.credits === 1 ? '' : 's'} · never
                    reset
                  </div>
                  <div className="mt-auto pt-4">
                    <Button
                      variant="secondary"
                      className="w-full"
                      onClick={() => buyPack(k)}
                      disabled={busyPackId === k.id}
                    >
                      {busyPackId === k.id ? 'opening…' : 'Buy'}
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
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
