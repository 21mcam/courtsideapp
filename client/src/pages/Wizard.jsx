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
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  Page,
  PageHeader,
  Card,
  Button,
  Field,
  Input,
  cn,
} from '../components/ui/index.js';

const STORAGE_KEY = 'courtside_wizard_state';
const TOTAL_STEPS = 5;
const STEP_LABELS = ['Welcome', 'Resources', 'Offerings', 'Plans', 'Done'];

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
    <Page width="narrow">
      <PageHeader
        title="Setup wizard"
        description="Set up your resources, offerings, and plans in five quick steps."
      />

      <Progress current={step} total={TOTAL_STEPS} />

      <Card>
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
      </Card>
    </Page>
  );
}

function Progress({ current, total }) {
  return (
    <div className="flex items-start">
      {Array.from({ length: total }).map((_, i) => {
        const idx = i + 1;
        const done = idx < current;
        const active = idx === current;
        return (
          <div
            key={idx}
            className={cn('flex items-start', idx > 1 && 'flex-1')}
          >
            {idx > 1 && (
              <div
                className={cn(
                  'flex-1 h-px mx-2 mt-3.5',
                  done || active ? 'bg-brand-600' : 'bg-slate-200'
                )}
              />
            )}
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  'h-7 w-7 rounded-full text-xs font-semibold flex items-center justify-center',
                  done || active
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-200 text-slate-500'
                )}
              >
                {idx}
              </div>
              <span
                className={cn(
                  'text-xs',
                  active
                    ? 'font-medium text-slate-900'
                    : 'text-slate-500'
                )}
              >
                {STEP_LABELS[i]}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// Recap rows — simple bordered rows for created / confirmed items
// ============================================================

function RecapRows({ items }) {
  return (
    <div className="mt-6 divide-y divide-slate-100 rounded-lg border border-slate-200">
      {items.map(({ label, value, mono }) => (
        <div
          key={label}
          className="flex items-center justify-between px-4 py-2.5 text-sm"
        >
          <span className="text-slate-500">{label}</span>
          <span className={cn('text-slate-900', mono && 'font-mono')}>
            {value}
          </span>
        </div>
      ))}
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
      <h2 className="text-lg font-semibold text-slate-900">
        Welcome, {me.user.first_name}.
      </h2>
      <p className="mt-2 text-sm text-slate-600">
        We'll get {me.tenant.name} set up in five quick steps:
      </p>
      <ol className="mt-3 list-decimal pl-6 text-slate-700 text-sm space-y-1">
        <li>Confirm your facility info</li>
        <li>Add your first resource (cage, bay, room…)</li>
        <li>Create an offering members can book</li>
        <li>Create a subscription plan</li>
        <li>You're done — preview the catalog</li>
      </ol>
      <RecapRows
        items={[
          { label: 'Facility', value: me.tenant.name },
          { label: 'Subdomain', value: me.tenant.subdomain, mono: true },
          { label: 'Timezone', value: me.tenant.timezone, mono: true },
        ]}
      />
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
      <h2 className="text-lg font-semibold text-slate-900">
        Add your first resource
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        A resource is the physical thing being rented — a cage, court, sim
        bay, room, etc. You can add more later.
      </p>
      <div className="mt-6">
        <Field label="Resource name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Cage 1"
          />
        </Field>
      </div>
      {error && <ErrorBanner message={error} />}
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
          // cents on the wire — Math.round, because float math on
          // prices like 19.99 yields 1998.9999999999998 and the API's
          // integer check rejects it with an opaque 400. (The plan
          // step below already did this.)
          dollar_price: Math.round(Number(dollarPrice) * 100),
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
      <h2 className="text-lg font-semibold text-slate-900">
        Create your first offering
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        An offering is what members and walk-ins book — a 30-min cage, a
        90-min sim session, a class. Members spend credits; walk-ins pay
        the dollar price.
      </p>
      <div className="mt-6 space-y-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label="Category" hint="lowercase-hyphen">
          <Input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            required
            placeholder="cage-time"
            className="font-mono"
          />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Duration (min)">
            <Input
              type="number"
              min="1"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              required
            />
          </Field>
          <Field label="Credits">
            <Input
              type="number"
              min="0"
              value={creditCost}
              onChange={(e) => setCreditCost(e.target.value)}
              required
            />
          </Field>
          <Field label="Dollar price">
            <Input
              type="number"
              min="0"
              step="0.01"
              value={dollarPrice}
              onChange={(e) => setDollarPrice(e.target.value)}
              required
            />
          </Field>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
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
      <h2 className="text-lg font-semibold text-slate-900">
        Create your first plan
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        A plan is what members subscribe to. They pay monthly and get
        credits each week to spend on offerings.
      </p>
      <div className="mt-6 space-y-4">
        <Field label="Plan name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Monthly price">
            <Input
              type="number"
              min="0"
              step="0.01"
              value={monthlyPrice}
              onChange={(e) => setMonthlyPrice(e.target.value)}
              required
            />
          </Field>
          <Field label="Credits per week">
            <Input
              type="number"
              min="0"
              value={creditsPerWeek}
              onChange={(e) => setCreditsPerWeek(e.target.value)}
              required
            />
          </Field>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
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
      <h2 className="text-lg font-semibold text-slate-900">All set 🎯</h2>
      <p className="mt-2 text-sm text-slate-600">
        You created the first piece of your facility's catalog. Members
        can book it as soon as the resource has operating hours.
      </p>
      <RecapRows
        items={[
          { label: 'Resource', value: state.resourceName ?? '—' },
          { label: 'Offering', value: state.offeringName ?? '—' },
          { label: 'Plan', value: state.planName ?? '—' },
        ]}
      />
      <p className="mt-6 text-sm text-slate-500">
        Next up: give your new resource operating hours and review the
        cancellation policy — then it's bookable.
      </p>
      <div className="mt-8 flex gap-3">
        <Button as={Link} to="/" onClick={onReset}>
          Go to admin home
        </Button>
        <Button variant="secondary" onClick={onReset}>
          Run wizard again
        </Button>
      </div>
    </div>
  );
}

// ============================================================
// Shared error banner
// ============================================================

function ErrorBanner({ message }) {
  return (
    <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      {message}
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
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          disabled={busy}
        >
          Back
        </Button>
      ) : (
        <span />
      )}
      {onNext ? (
        <Button type="button" onClick={onNext} disabled={busy}>
          {nextLabel}
        </Button>
      ) : (
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : nextLabel}
        </Button>
      )}
    </div>
  );
}
