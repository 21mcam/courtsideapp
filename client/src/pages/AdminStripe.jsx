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
import { Link } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { api } from '../api.js';

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
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-2xl mx-auto p-6 space-y-6">
        <div>
          <Link to="/" className="text-sm text-sky-700 hover:underline">
            ← Back
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">Stripe Connect</h1>
          <p className="text-sm text-slate-500">
            Connect your Stripe account to accept member subscriptions
            and walk-in payments. Onboarding happens on Stripe's site;
            we just store the account reference.
          </p>
        </div>

        {error && (
          <div className="rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800">
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
      </main>
    </div>
  );
}

function NotConnected({ onConnect, busy }) {
  return (
    <div className="rounded border border-slate-200 bg-white p-5 space-y-3">
      <h2 className="font-semibold">No Stripe account connected</h2>
      <p className="text-sm text-slate-600">
        We'll create a Stripe Standard account for your facility and
        send you to Stripe to complete onboarding.
      </p>
      <button
        onClick={onConnect}
        disabled={busy}
        className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50"
      >
        {busy ? 'Opening…' : 'Connect Stripe'}
      </button>
    </div>
  );
}

function Connected({ connection, onContinue, onRefresh, busy }) {
  const fully = connection.details_submitted && connection.charges_enabled;
  return (
    <div className="space-y-4">
      <div className="rounded border border-slate-200 bg-white p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">
            Connected{' '}
            <span className="text-sm font-normal text-slate-500">
              · {connection.stripe_account_id}
            </span>
          </h2>
          <button
            onClick={onRefresh}
            disabled={busy}
            className="rounded border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
          >
            Refresh status
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <Row label="Details submitted" ok={connection.details_submitted} />
          <Row label="Charges enabled" ok={connection.charges_enabled} />
          <Row label="Payouts enabled" ok={connection.payouts_enabled} />
        </dl>

        {!fully && (
          <div className="rounded bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
            Onboarding incomplete. Continue with Stripe to enable charges.
          </div>
        )}
      </div>

      {!fully && (
        <button
          onClick={onContinue}
          disabled={busy}
          className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50"
        >
          {busy ? 'Opening…' : 'Continue onboarding'}
        </button>
      )}
    </div>
  );
}

function Row({ label, ok }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd>
        <span
          className={`text-xs rounded px-2 py-0.5 ${
            ok
              ? 'bg-emerald-100 text-emerald-900'
              : 'bg-slate-200 text-slate-600'
          }`}
        >
          {ok ? 'yes' : 'no'}
        </span>
      </dd>
    </>
  );
}
