// Five-step setup wizard for new tenants.
//
// Steps:
//   1. Welcome (read-only tenant confirmation)
//   2. Resources — create your first cage / bay / room
//   3. Offerings — bookable type with category, duration, pricing
//   4. Plans — at least one subscription tier
//   5. Done — recap + return to admin home
//
// Each step calls existing /api/admin/* endpoints. Wizard progress
// (current step + IDs of created entities) persists in localStorage
// so refresh / accidental navigation doesn't lose state.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

const STORAGE_KEY = 'courtside_wizard_state';
const TOTAL_STEPS = 5;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { step: 1 };
  } catch {
    return { step: 1 };
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clearState() {
  localStorage.removeItem(STORAGE_KEY);
}

export default function Wizard() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState(() => loadState());

  // Bounce non-admins.
  useEffect(() => {
    if (me && !me.memberships.admin) {
      navigate('/', { replace: true });
    }
  }, [me, navigate]);

  function update(patch) {
    setState((prev) => {
      const next = { ...prev, ...patch };
      saveState(next);
      return next;
    });
  }

  function goto(step) {
    update({ step });
  }

  function reset() {
    clearState();
    setState({ step: 1 });
  }

  const { step } = state;

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-2xl mx-auto p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Setup wizard</h1>
          <Link to="/" className="text-sm text-slate-500 hover:underline">
            ← Back to admin
          </Link>
        </div>

        <Progress current={step} total={TOTAL_STEPS} />

        <div className="mt-8 bg-white rounded border border-slate-200 p-6">
          {step === 1 && <StepWelcome onNext={() => goto(2)} />}
          {step === 2 && (
            <StepResources
              state={state}
              update={update}
              onNext={() => goto(3)}
              onBack={() => goto(1)}
            />
          )}
          {step === 3 && (
            <StepOffering
              state={state}
              update={update}
              onNext={() => goto(4)}
              onBack={() => goto(2)}
            />
          )}
          {step === 4 && (
            <StepPlan
              state={state}
              update={update}
              onNext={() => goto(5)}
              onBack={() => goto(3)}
            />
          )}
          {step === 5 && <StepDone state={state} onReset={reset} />}
        </div>
      </main>
    </div>
  );
}

function Progress({ current, total }) {
  return (
    <div className="mt-6">
      <div className="flex items-center gap-2">
        {Array.from({ length: total }).map((_, i) => {
          const idx = i + 1;
          const done = idx < current;
          const active = idx === current;
          return (
            <div
              key={idx}
              className={`flex-1 h-2 rounded ${
                done
                  ? 'bg-emerald-500'
                  : active
                    ? 'bg-amber-500'
                    : 'bg-slate-200'
              }`}
            />
          );
        })}
      </div>
      <div className="mt-2 text-xs text-slate-500">
        Step {current} of {total}
      </div>
    </div>
  );
}

// ============================================================
// Step 1 — Welcome
// ============================================================

function StepWelcome({ onNext }) {
  const { me } = useAuth();
  return (
    <div>
      <h2 className="text-lg font-semibold">Welcome, {me.user.first_name}.</h2>
      <p className="mt-2 text-slate-600">
        We'll get {me.tenant.name} set up in five quick steps:
      </p>
      <ol className="mt-3 list-decimal pl-6 text-slate-700 text-sm space-y-1">
        <li>Confirm your facility info</li>
        <li>Add your first resource (cage, bay, room…)</li>
        <li>Create an offering members can book</li>
        <li>Create a subscription plan</li>
        <li>You're done — preview the catalog</li>
      </ol>
      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-1 text-sm max-w-md">
        <dt className="text-slate-500">Facility</dt>
        <dd>{me.tenant.name}</dd>
        <dt className="text-slate-500">Subdomain</dt>
        <dd className="font-mono">{me.tenant.subdomain}</dd>
        <dt className="text-slate-500">Timezone</dt>
        <dd className="font-mono">{me.tenant.timezone}</dd>
      </dl>
      <NavButtons onNext={onNext} nextLabel="Let's go" />
    </div>
  );
}

// ============================================================
// Step 2 — Resources
// ============================================================

function StepResources({ state, update, onNext, onBack }) {
  const [name, setName] = useState(state.resourceName ?? 'Cage 1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/admin/resources', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        update({ resourceId: body.resource.id, resourceName: name });
        onNext();
      } else {
        setError(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2 className="text-lg font-semibold">Add your first resource</h2>
      <p className="mt-1 text-sm text-slate-600">
        A resource is the physical thing being rented — a cage, court, sim
        bay, room, etc. You can add more later.
      </p>
      <div className="mt-6">
        <label className="block text-sm text-slate-600 mb-1">Resource name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="Cage 1"
          className="w-full rounded border border-slate-300 px-3 py-2 outline-none focus:border-slate-500"
        />
      </div>
      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
      <NavButtons onBack={onBack} busy={busy} nextLabel="Continue" />
    </form>
  );
}

// ============================================================
// Step 3 — Offering (with category) — auto-links to step 2's resource
// ============================================================

function StepOffering({ state, update, onNext, onBack }) {
  const [name, setName] = useState(state.offeringName ?? '30-min cage');
  const [category, setCategory] = useState(state.offeringCategory ?? 'cage-time');
  const [duration, setDuration] = useState(state.offeringDuration ?? 30);
  const [creditCost, setCreditCost] = useState(state.offeringCreditCost ?? 3);
  const [dollarPrice, setDollarPrice] = useState(state.offeringDollarPrice ?? 30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const offRes = await api('/api/admin/offerings', {
        method: 'POST',
        body: JSON.stringify({
          name,
          category,
          duration_minutes: Number(duration),
          credit_cost: Number(creditCost),
          dollar_price: Number(dollarPrice) * 100, // cents on the wire
          allow_member_booking: true,
          allow_public_booking: true,
        }),
      });
      const offBody = await offRes.json().catch(() => ({}));
      if (!offRes.ok) {
        setError(offBody.error || `HTTP ${offRes.status}`);
        return;
      }
      const offering = offBody.offering;

      // Auto-link to the step-2 resource (if we have one)
      if (state.resourceId) {
        const linkRes = await api(`/api/admin/offerings/${offering.id}/resources`, {
          method: 'POST',
          body: JSON.stringify({ resource_id: state.resourceId }),
        });
        if (!linkRes.ok) {
          const linkBody = await linkRes.json().catch(() => ({}));
          setError(`offering created but link failed: ${linkBody.error || linkRes.status}`);
          return;
        }
      }

      update({
        offeringId: offering.id,
        offeringName: name,
        offeringCategory: category,
        offeringDuration: duration,
        offeringCreditCost: creditCost,
        offeringDollarPrice: dollarPrice,
      });
      onNext();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2 className="text-lg font-semibold">Create your first offering</h2>
      <p className="mt-1 text-sm text-slate-600">
        An offering is what members and walk-ins book — a 30-min cage, a
        90-min sim session, a class. Members spend credits; walk-ins pay
        the dollar price.
      </p>
      <div className="mt-6 space-y-4">
        <div>
          <label className="block text-sm text-slate-600 mb-1">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full rounded border border-slate-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-600 mb-1">
            Category{' '}
            <span className="text-slate-400">(lowercase-hyphen)</span>
          </label>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            required
            placeholder="cage-time"
            className="w-full rounded border border-slate-300 px-3 py-2 font-mono"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-sm text-slate-600 mb-1">Duration (min)</label>
            <input
              type="number"
              min="1"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              required
              className="w-full rounded border border-slate-300 px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1">Credits</label>
            <input
              type="number"
              min="0"
              value={creditCost}
              onChange={(e) => setCreditCost(e.target.value)}
              required
              className="w-full rounded border border-slate-300 px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1">Dollar price</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={dollarPrice}
              onChange={(e) => setDollarPrice(e.target.value)}
              required
              className="w-full rounded border border-slate-300 px-3 py-2"
            />
          </div>
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
      <NavButtons onBack={onBack} busy={busy} nextLabel="Continue" />
    </form>
  );
}

// ============================================================
// Step 4 — Plan
// ============================================================

function StepPlan({ state, update, onNext, onBack }) {
  const [name, setName] = useState(state.planName ?? 'Pro');
  const [monthlyPrice, setMonthlyPrice] = useState(state.planMonthlyPrice ?? 269);
  const [creditsPerWeek, setCreditsPerWeek] = useState(state.planCreditsPerWeek ?? 20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/admin/plans', {
        method: 'POST',
        body: JSON.stringify({
          name,
          monthly_price_cents: Math.round(Number(monthlyPrice) * 100),
          credits_per_week: Number(creditsPerWeek),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        update({
          planId: body.plan.id,
          planName: name,
          planMonthlyPrice: monthlyPrice,
          planCreditsPerWeek: creditsPerWeek,
        });
        onNext();
      } else {
        setError(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2 className="text-lg font-semibold">Create your first plan</h2>
      <p className="mt-1 text-sm text-slate-600">
        A plan is what members subscribe to. They pay monthly and get
        credits each week to spend on offerings.
      </p>
      <div className="mt-6 space-y-4">
        <div>
          <label className="block text-sm text-slate-600 mb-1">Plan name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full rounded border border-slate-300 px-3 py-2"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-slate-600 mb-1">Monthly price</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={monthlyPrice}
              onChange={(e) => setMonthlyPrice(e.target.value)}
              required
              className="w-full rounded border border-slate-300 px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1">Credits per week</label>
            <input
              type="number"
              min="0"
              value={creditsPerWeek}
              onChange={(e) => setCreditsPerWeek(e.target.value)}
              required
              className="w-full rounded border border-slate-300 px-3 py-2"
            />
          </div>
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
      <NavButtons onBack={onBack} busy={busy} nextLabel="Continue" />
    </form>
  );
}

// ============================================================
// Step 5 — Done
// ============================================================

function StepDone({ state, onReset }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">All set 🎯</h2>
      <p className="mt-2 text-slate-600">
        You created the first piece of your facility's catalog. Members
        will see this when the booking flow launches.
      </p>
      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <dt className="text-slate-500">Resource</dt>
        <dd>{state.resourceName ?? '—'}</dd>
        <dt className="text-slate-500">Offering</dt>
        <dd>{state.offeringName ?? '—'}</dd>
        <dt className="text-slate-500">Plan</dt>
        <dd>{state.planName ?? '—'}</dd>
      </dl>
      <p className="mt-6 text-sm text-slate-500">
        Next up (after Phase 3 ships): set operating hours and cancellation
        policy, then turn on bookings.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          to="/"
          onClick={onReset}
          className="rounded bg-slate-900 text-white px-4 py-2 hover:bg-slate-800"
        >
          Go to admin home
        </Link>
        <button
          onClick={onReset}
          className="rounded border border-slate-300 px-4 py-2 hover:bg-slate-50"
        >
          Run wizard again
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Shared bottom nav
// ============================================================

function NavButtons({ onBack, onNext, busy, nextLabel = 'Next' }) {
  return (
    <div className="mt-8 flex items-center justify-between">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="text-sm text-slate-500 hover:underline disabled:opacity-50"
        >
          ← Back
        </button>
      ) : (
        <span />
      )}
      {onNext ? (
        <button
          type="button"
          onClick={onNext}
          disabled={busy}
          className="rounded bg-slate-900 text-white px-4 py-2 hover:bg-slate-800 disabled:opacity-50"
        >
          {nextLabel}
        </button>
      ) : (
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-slate-900 text-white px-4 py-2 hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? 'saving…' : nextLabel}
        </button>
      )}
    </div>
  );
}
