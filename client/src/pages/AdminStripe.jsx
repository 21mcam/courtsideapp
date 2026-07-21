// Stripe Connect admin page — Phase 5 slice 1.
//
// Two states:
//   1. No connection → show "Connect your Stripe account" CTA.
//   2. Connected → show readiness flags (details / charges / payouts)
//      + a refresh button + a "Continue onboarding" link if not fully
//      onboarded yet.
//
// The connect/onboarding URLs come back from POST /api/admin/stripe/
// onboarding. We open them in a new tab so the admin can return to
// our page and click "Refresh status" to pick up new state without
// waiting for the (slice 2) webhook.

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Button, Card, Page, PageHeader } from '../components/ui/index.js';

export default function AdminStripe() {
  const [connection, setConnection] = useState(undefined); // undefined = loading, null = none
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  function load(refresh = false) {
    setError(null);
    api(`/api/admin/stripe/connection${refresh ? '?refresh=true' : ''}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => setConnection(data.connection))
      .catch((err) => setError(err.message));
  }

  useEffect(() => load(false), []);

  async function startOnboarding() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Send the admin back to this page so they can refresh.
      const here = window.location.origin + '/admin/stripe';
      const res = await api('/api/admin/stripe/onboarding', {
        method: 'POST',
        body: JSON.stringify({
          return_url: here,
          refresh_url: here,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      window.open(body.onboarding_url, '_blank', 'noopener,noreferrer');
      // Refetch connection so the new row appears in the UI.
      load(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page width="narrow">
      <PageHeader
        title="Payments"
        description="Connect your Stripe account to accept member subscriptions and walk-in payments. Onboarding happens on Stripe's site; we just store the account reference."
      />

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {connection === undefined ? (
        <p className="text-sm text-slate-400">loading…</p>
      ) : connection === null ? (
        <NotConnected onConnect={startOnboarding} busy={busy} />
      ) : (
        <Connected
          connection={connection}
          onContinue={startOnboarding}
          onRefresh={() => load(true)}
          busy={busy}
        />
      )}
    </Page>
  );
}

function NotConnected({ onConnect, busy }) {
  return (
    <Card title="No Stripe account connected">
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          We'll create a Stripe Standard account for your facility and
          send you to Stripe to complete onboarding.
        </p>
        <Button onClick={onConnect} disabled={busy}>
          {busy ? 'Opening…' : 'Connect Stripe'}
        </Button>
      </div>
    </Card>
  );
}

function Connected({ connection, onContinue, onRefresh, busy }) {
  const fully = connection.details_submitted && connection.charges_enabled;
  return (
    <div className="space-y-4">
      <Card
        title={
          <>
            Connected{' '}
            <span className="font-normal text-slate-500">
              · {connection.stripe_account_id}
            </span>
          </>
        }
        actions={
          <Button size="sm" variant="secondary" onClick={onRefresh} disabled={busy}>
            Refresh status
          </Button>
        }
      >
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Row label="Details submitted" ok={connection.details_submitted} />
            <Row label="Charges enabled" ok={connection.charges_enabled} />
            <Row label="Payouts enabled" ok={connection.payouts_enabled} />
          </dl>

          {!fully && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Onboarding incomplete. Continue with Stripe to enable charges.
            </div>
          )}
        </div>
      </Card>

      {!fully && (
        <Button onClick={onContinue} disabled={busy}>
          {busy ? 'Opening…' : 'Continue onboarding'}
        </Button>
      )}
    </div>
  );
}

function Row({ label, ok }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd>
        <Badge tone={ok ? 'success' : 'neutral'}>{ok ? 'yes' : 'no'}</Badge>
      </dd>
    </>
  );
}
