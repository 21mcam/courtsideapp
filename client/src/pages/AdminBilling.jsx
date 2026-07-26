// Admin settings → Billing: what this facility pays Courtside.
//
// Two rendering modes:
//   * Normal: a tab under Settings like the rest of the settings area.
//   * Billing hold (tenant.billing_blocked): the ONLY reachable admin
//     page — resolveTenant 402s everything except auth + billing, so
//     the tab nav is hidden (its targets would all fail) and a
//     reactivation banner explains the situation.
//
// Subscribe goes through Stripe Checkout on the PLATFORM's account
// (this is the one payment in the product that isn't Stripe Connect);
// card/cancel/invoice management goes through the Stripe Billing
// Portal. Status changes land via the platform webhook, so after a
// successful checkout the page polls /api/admin/billing briefly until
// the webhook flips the status.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import SettingsNav from '../components/SettingsNav.jsx';
import {
  Badge,
  Button,
  Card,
  Page,
  PageHeader,
} from '../components/ui/index.js';

const STATUS_META = {
  trial: { label: 'Trial', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  past_due: { label: 'Past due', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
  suspended: { label: 'Suspended', tone: 'danger' },
};

function formatDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatPrice(cents) {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export default function AdminBilling() {
  const { tenant } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);
  const pollRef = useRef(null);

  const justSubscribed = searchParams.get('billing') === 'success';
  const onHold = tenant.billing_blocked === true;

  const load = useCallback(async () => {
    const res = await api('/api/admin/billing');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const body = await res.json();
    setBilling(body);
    return body;
  }, []);

  useEffect(() => {
    load().catch((err) => setError(`Couldn't load billing: ${err.message}`));
  }, [load]);

  // After returning from a successful checkout, the webhook may land a
  // beat after the redirect — poll a few times until status flips.
  useEffect(() => {
    if (!justSubscribed) return undefined;
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts += 1;
      try {
        const b = await load();
        if (b.status === 'active' || attempts >= 10) {
          clearInterval(pollRef.current);
          // A reactivated tenant needs a full reload so the app
          // re-bootstraps without the billing hold. reload() (not a
          // path assign) keeps the ?tenant= fallback param in dev.
          if (b.status === 'active' && onHold) window.location.reload();
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [justSubscribed, load, onHold]);

  async function startCheckout() {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      const base = `${window.location.origin}/admin/settings/billing`;
      const res = await api('/api/admin/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({
          success_url: `${base}?billing=success`,
          cancel_url: `${base}?billing=cancelled`,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const { checkout_url } = await res.json();
      window.location.assign(checkout_url);
    } catch (err) {
      setError(`Couldn't start checkout: ${err.message}`);
      setWorking(false);
    }
  }

  async function openPortal() {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      const res = await api('/api/admin/billing/portal', {
        method: 'POST',
        body: JSON.stringify({
          return_url: `${window.location.origin}/admin/settings/billing`,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const { portal_url } = await res.json();
      window.location.assign(portal_url);
    } catch (err) {
      setError(`Couldn't open the billing portal: ${err.message}`);
      setWorking(false);
    }
  }

  const meta = billing ? (STATUS_META[billing.status] ?? STATUS_META.trial) : null;
  const trialEnds = billing ? formatDate(billing.trial_ends_at) : null;
  const canManage = billing?.has_subscription;

  // In hold mode this page renders standalone (no AppShell), so it
  // must bring the shell's light background itself.
  const Wrapper = onHold
    ? ({ children }) => (
        <main className="min-h-screen bg-slate-50">{children}</main>
      )
    : ({ children }) => children;

  return (
    <Wrapper>
    <Page>
      <PageHeader
        title="Settings"
        description="Your Courtside subscription — the plan this facility pays for."
      />
      {onHold ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span className="font-semibold">Your booking site is paused.</span>{' '}
          Members and walk-ins can't book until billing is restored.
          Subscribe below to reactivate immediately.
        </div>
      ) : (
        <SettingsNav />
      )}

      {searchParams.get('billing') === 'cancelled' && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          Checkout was cancelled — no changes were made.
          <button
            className="ml-2 font-medium text-slate-500 underline"
            onClick={() => setSearchParams({}, { replace: true })}
          >
            Dismiss
          </button>
        </div>
      )}
      {justSubscribed && billing?.status !== 'active' && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Payment received — finishing activation…
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {billing && (
        <div className="mt-6 max-w-xl space-y-4">
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-500">
                    Subscription status
                  </span>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </div>
                <p className="mt-2 text-sm text-slate-600">
                  {billing.status === 'trial' &&
                    (trialEnds
                      ? `Free trial — ends ${trialEnds}.`
                      : 'Free trial — no end date.')}
                  {billing.status === 'active' &&
                    'Your Courtside subscription is active.'}
                  {billing.status === 'past_due' &&
                    'The last payment failed. Stripe is retrying — update your card to fix it now. Your booking site stays online during retries.'}
                  {billing.status === 'cancelled' &&
                    'Your subscription has ended.'}
                  {billing.status === 'suspended' &&
                    'Your subscription is paused. Contact Courtside or resubscribe.'}
                </p>
                {billing.monthly_price_cents && (
                  <p className="mt-1 text-sm text-slate-500">
                    Plan: {formatPrice(billing.monthly_price_cents)}/month —
                    every feature included, cancel anytime.
                  </p>
                )}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {billing.billing_configured ? (
                <>
                  {(billing.status !== 'active' || !billing.has_subscription) && (
                    <Button onClick={startCheckout} disabled={working}>
                      {billing.status === 'trial' ? 'Subscribe' : 'Reactivate subscription'}
                    </Button>
                  )}
                  {canManage && (
                    <Button variant="secondary" onClick={openPortal} disabled={working}>
                      Manage billing
                    </Button>
                  )}
                </>
              ) : (
                <p className="text-sm text-slate-500">
                  Online billing isn't set up yet — contact Courtside to
                  arrange payment.
                </p>
              )}
            </div>
          </Card>
          <p className="text-xs text-slate-400">
            Payments are processed by Stripe. Card details never touch
            Courtside servers. This is separate from your facility's own
            Stripe account — member and walk-in payments always go
            directly to you.
          </p>
        </div>
      )}
    </Page>
    </Wrapper>
  );
}
