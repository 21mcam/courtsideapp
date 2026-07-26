// Member subscription chooser — Phase 5 slice 4a — plus one-time
// credit packs (credit-packs slice).
//
// Page states (UI-declutter pass):
//   * Subscribed → "Your plan" card first (name, price, credits,
//     status, Manage via the Stripe billing portal — same path as
//     MemberHome). Any OTHER purchasable plans render below, dimmed,
//     with a per-card switching note. No other plans → nothing below.
//   * Not subscribed → the purchasable plan grid; if the facility has
//     none yet, a friendly "coming soon" note (members aren't the
//     ones who configure plans, so we never tell them to add one).
//
// Subscribe: click → POST /api/me/subscriptions/checkout, redirect to
// the Stripe-hosted Checkout page. After payment Stripe redirects back
// to /?subscribed=1 (the success_url). The webhook is what actually
// creates our subscriptions row + grants credits, so on return the
// member home will reflect the new subscription within a couple
// seconds.
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
  formatCategoryLabel,
  formatCents,
  formatDate,
  subscriptionStatusBadge,
} from '../format.js';
import { Page, PageHeader, Card, Button, Badge, cn } from '../components/ui/index.js';

// Member-friendly line for what a plan's credits can be spent on.
// Never shows raw category keys.
function planCreditsLine(plan) {
  const credits = `${plan.credits_per_week} credit${
    plan.credits_per_week === 1 ? '' : 's'
  } per week`;
  if (plan.allowed_categories == null) return `${credits} · use on anything`;
  const labels = plan.allowed_categories.map(formatCategoryLabel).join(', ');
  return labels ? `${credits} · for ${labels}` : credits;
}

export default function MemberPlans() {
  const { me } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [plans, setPlans] = useState(null);
  const [packs, setPacks] = useState(null);
  const [currentSub, setCurrentSub] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busyPlanId, setBusyPlanId] = useState(null);
  const [busyPackId, setBusyPackId] = useState(null);
  const [portalBusy, setPortalBusy] = useState(false);
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

  // Stripe billing portal — same self-serve path as MemberHome's
  // Manage button (update card, view invoices, cancel/reactivate).
  async function openPortal() {
    if (portalBusy) return;
    setPortalBusy(true);
    setActionError(null);
    try {
      const res = await api('/api/me/subscriptions/portal', {
        method: 'POST',
        body: JSON.stringify({ return_url: window.location.origin + '/plans' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      window.location.assign(body.url);
    } catch (err) {
      setActionError(err.message);
      setPortalBusy(false);
    }
  }

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

  // Plans the member could switch to (their own plan isn't a
  // "different plan" to subscribe to).
  const otherPlans =
    plans === null
      ? null
      : currentSub
        ? plans.filter((p) => p.id !== currentSub.plan_id)
        : plans;
  const subStatus = currentSub
    ? subscriptionStatusBadge(currentSub.status)
    : null;

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

      {loadError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {loadError}
        </div>
      )}
      {actionError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Something went wrong: {actionError}
        </div>
      )}

      {plans === null ? (
        <p className="text-sm text-slate-400">loading…</p>
      ) : (
        <>
          {/* The member's own plan, when they have one. */}
          {currentSub && (
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm text-slate-500">Your plan</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="text-lg font-semibold text-slate-900">
                      {currentSub.plan_name ?? 'Membership'}
                    </span>
                    <Badge tone={subStatus.tone}>{subStatus.label}</Badge>
                    {currentSub.cancel_at_period_end && (
                      <Badge tone="warning">
                        {currentSub.current_period_end
                          ? `Ends ${formatDate(currentSub.current_period_end, me.tenant.timezone)}`
                          : 'Ending soon'}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 text-sm text-slate-500">
                    {formatCents(currentSub.monthly_price_cents)}
                    /mo
                    {currentSub.credits_per_week != null && (
                      <>
                        {' · '}
                        {currentSub.credits_per_week} credit
                        {currentSub.credits_per_week === 1 ? '' : 's'} per week
                      </>
                    )}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={openPortal}
                  disabled={portalBusy}
                >
                  {portalBusy ? 'opening…' : 'Manage'}
                </Button>
              </div>
            </Card>
          )}

          {/* Purchasable plans. Subscribed members see the rest of the
              lineup dimmed with a per-card switching note; if there's
              nothing else to show, show nothing. Not-yet-subscribed
              members with no purchasable plans get a friendly
              coming-soon note. */}
          {currentSub ? (
            otherPlans.length > 0 && (
              <>
                <div className="pt-2">
                  <h2 className="text-lg font-semibold text-slate-900">
                    Other plans
                  </h2>
                </div>
                <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {otherPlans.map((p) => (
                    <li key={p.id}>
                      <PlanCard plan={p} dimmed>
                        <p className="text-xs text-slate-400">
                          Switching plans: cancel your current plan
                          first, then subscribe.
                        </p>
                      </PlanCard>
                    </li>
                  ))}
                </ul>
              </>
            )
          ) : otherPlans.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
              Membership plans are coming soon — check back or ask at
              the front desk.
            </div>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {otherPlans.map((p) => (
                <li key={p.id}>
                  <PlanCard plan={p}>
                    <Button
                      variant="primary"
                      className="w-full"
                      onClick={() => subscribe(p)}
                      disabled={busyPlanId === p.id}
                    >
                      {busyPlanId === p.id ? 'opening…' : 'Subscribe'}
                    </Button>
                  </PlanCard>
                </li>
              ))}
            </ul>
          )}
        </>
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

// One purchasable plan. `children` is the footer action area — the
// Subscribe button normally, or the switching note when the member is
// already subscribed elsewhere (dimmed).
function PlanCard({ plan, dimmed = false, children }) {
  return (
    <Card className={cn('flex h-full flex-col', dimmed && 'opacity-60')}>
      <div className="font-semibold text-slate-900">{plan.name}</div>
      <div className="mt-2">
        <span className="text-2xl font-semibold text-slate-900">
          {formatCents(plan.monthly_price_cents)}
        </span>
        <span className="ml-1 text-sm text-slate-500">/mo</span>
      </div>
      {plan.description && (
        <div className="mt-2 text-sm text-slate-500">{plan.description}</div>
      )}
      <div className="mt-2 text-sm text-slate-500">{planCreditsLine(plan)}</div>
      <div className="mt-auto pt-4">{children}</div>
    </Card>
  );
}

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
