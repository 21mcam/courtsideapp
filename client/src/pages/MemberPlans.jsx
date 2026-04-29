// Member subscription chooser — Phase 5 slice 4a.
//
// Lists plans available for subscription; click "Subscribe" → POST
// /api/me/subscriptions/checkout, redirect to the Stripe-hosted
// Checkout page. After payment Stripe redirects back to /?subscribed=1
// (the success_url). The webhook is what actually creates our
// subscriptions row + grants credits, so on return the dashboard
// will reflect the new subscription within a couple seconds.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  formatAllowedCategories,
  formatCents,
} from '../format.js';

export default function MemberPlans() {
  const { me } = useAuth();
  const [plans, setPlans] = useState(null);
  const [currentSub, setCurrentSub] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busyPlanId, setBusyPlanId] = useState(null);
  const [actionError, setActionError] = useState(null);

  function load() {
    setLoadError(null);
    Promise.all([
      api('/api/me/plans').then(handle),
      api('/api/me/subscriptions').then(handle),
    ])
      .then(([p, s]) => {
        setPlans(p.plans ?? []);
        setCurrentSub(s.subscription ?? null);
      })
      .catch((err) => setLoadError(err.message));
  }

  useEffect(load, []);

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
      <div className="min-h-screen bg-slate-50">
        <Header />
        <main className="max-w-2xl mx-auto p-6">
          <p className="text-slate-700">Subscriptions require a member account.</p>
          <Link to="/" className="mt-4 inline-block text-sm text-sky-700 hover:underline">
            ← Back home
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-3xl mx-auto p-6 space-y-6">
        <div>
          <Link to="/" className="text-sm text-sky-700 hover:underline">
            ← Back
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">Subscribe to a plan</h1>
          <p className="text-sm text-slate-500">
            Pay monthly. Cancel any time. Credits drop into your account
            once your first payment clears.
          </p>
        </div>

        {currentSub && (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            You're already subscribed to{' '}
            <strong>{currentSub.plan_name ?? 'a plan'}</strong>. Cancel
            it from the dashboard before subscribing to a different
            plan.
          </div>
        )}

        {loadError && (
          <div className="rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800">
            {loadError}
          </div>
        )}
        {actionError && (
          <div className="rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800">
            Subscribe failed: {actionError}
          </div>
        )}

        {plans === null ? (
          <p className="text-sm text-slate-400">loading…</p>
        ) : plans.length === 0 ? (
          <p className="text-sm text-slate-500">
            No plans available right now. Ask the facility to add one.
          </p>
        ) : (
          <ul className="grid gap-3">
            {plans.map((p) => (
              <li
                key={p.id}
                className="rounded border border-slate-200 bg-white p-5 flex items-center justify-between"
              >
                <div>
                  <div className="text-lg font-semibold">{p.name}</div>
                  {p.description && (
                    <div className="text-sm text-slate-600 mt-1">
                      {p.description}
                    </div>
                  )}
                  <div className="mt-1 text-sm text-slate-700">
                    {formatCents(p.monthly_price_cents)} / mo ·{' '}
                    {p.credits_per_week} credit
                    {p.credits_per_week === 1 ? '' : 's'} per week ·{' '}
                    {formatAllowedCategories(p.allowed_categories)}
                  </div>
                </div>
                <button
                  onClick={() => subscribe(p)}
                  disabled={!!currentSub || busyPlanId === p.id}
                  className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busyPlanId === p.id ? 'opening…' : 'Subscribe'}
                </button>
              </li>
            ))}
          </ul>
        )}
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
