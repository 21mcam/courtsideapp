// Edit modals for the admin catalog (resources, offerings, plans) —
// Tier-A sell-readiness slice.
//
// Each modal PATCHes its /api/admin/* endpoint with only the edited
// fields, and offers a deactivate/reactivate action with confirm
// copy explaining what deactivation does (hidden from booking/new
// signups; existing bookings and subscriptions untouched).
//
// Plan pricing note surfaced in the UI: re-pricing a Stripe-synced
// plan creates a new Stripe Price for new signups — existing members
// keep their current rate.

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Button,
  ConfirmDialog,
  Field,
  Input,
  Textarea,
} from '../components/ui/index.js';

async function patch(path, body) {
  const res = await api(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function ModalShell({ title, subtitle, onClose, children }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/30"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative w-full max-w-lg rounded-lg bg-white shadow-xl border border-slate-200 p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800 text-xl leading-none"
          >
            ×
          </button>
        </div>
        {subtitle && <p className="text-sm text-slate-500 mb-4">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

function ErrorBanner({ message }) {
  return (
    <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      {message}
    </div>
  );
}

// Footer with the deactivate/reactivate action. The styled
// ConfirmDialog (replacing the old window.confirm) lives here so all
// three modals get the same confirm flow; `onToggleActive` only fires
// after the admin confirms.
function ModalFooter({
  item,
  busy,
  onToggleActive,
  deactivateLabel,
  confirmTitle,
  confirmMessage,
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="mt-6 flex items-center justify-between border-t border-slate-100 pt-4">
      <Button
        type="button"
        size="sm"
        variant={item.active ? 'danger' : 'secondary'}
        onClick={() => setConfirming(true)}
        disabled={busy}
      >
        {item.active ? deactivateLabel : 'Reactivate'}
      </Button>
      <Button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save changes'}
      </Button>
      {confirming && (
        <ConfirmDialog
          title={confirmTitle}
          message={confirmMessage}
          confirmLabel={item.active ? 'Deactivate' : 'Reactivate'}
          variant={item.active ? 'danger' : 'neutral'}
          onConfirm={() => {
            setConfirming(false);
            onToggleActive();
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

// ============================================================
// Resource
// ============================================================

export function ResourceEditModal({ resource, onClose, onSaved }) {
  const [name, setName] = useState(resource.name);
  const [displayOrder, setDisplayOrder] = useState(resource.display_order);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/admin/resources/${resource.id}`, {
        name,
        display_order: Number(displayOrder),
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/admin/resources/${resource.id}`, {
        active: !resource.active,
      });
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title="Edit resource"
      subtitle={resource.active ? undefined : 'This resource is deactivated.'}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="space-y-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Display order" hint="Lower numbers list first.">
            <Input
              type="number"
              min="0"
              value={displayOrder}
              onChange={(e) => setDisplayOrder(e.target.value)}
              required
            />
          </Field>
        </div>
        {error && <ErrorBanner message={error} />}
        <ModalFooter
          item={resource}
          busy={busy}
          onToggleActive={toggleActive}
          deactivateLabel="Deactivate resource"
          confirmTitle={
            resource.active ? 'Deactivate resource?' : 'Reactivate resource?'
          }
          confirmMessage={
            resource.active
              ? `Deactivate "${resource.name}"? It will be hidden from booking and availability. Existing bookings are untouched. You can reactivate it anytime.`
              : `Reactivate "${resource.name}"? It will be bookable again wherever it has operating hours.`
          }
        />
      </form>
    </ModalShell>
  );
}

// ============================================================
// Offering
// ============================================================

export function OfferingEditModal({ offering, resources, onClose, onSaved }) {
  const [name, setName] = useState(offering.name);
  const [category, setCategory] = useState(offering.category);
  const [description, setDescription] = useState(offering.description ?? '');
  const [duration, setDuration] = useState(offering.duration_minutes);
  const [creditCost, setCreditCost] = useState(offering.credit_cost);
  const [dollarPrice, setDollarPrice] = useState(offering.dollar_price / 100);
  const [capacity, setCapacity] = useState(offering.capacity);
  const [allowMember, setAllowMember] = useState(offering.allow_member_booking);
  const [allowPublic, setAllowPublic] = useState(offering.allow_public_booking);
  const [linkedIds, setLinkedIds] = useState(null); // null = still loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api(`/api/admin/offerings/${offering.id}/resources`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (!cancelled) {
          setLinkedIds(
            new Set(
              (body.resources ?? [])
                .filter((l) => l.link_active)
                .map((l) => l.resource_id),
            ),
          );
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [offering.id]);

  function toggleResource(id) {
    setLinkedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name,
        category,
        description: description.trim() || null,
        duration_minutes: Number(duration),
        credit_cost: Number(creditCost),
        // Math.round: float dollars → integer cents (19.99 * 100
        // is 1998.9999999999998).
        dollar_price: Math.round(Number(dollarPrice) * 100),
        capacity: Number(capacity),
        allow_member_booking: allowMember,
        allow_public_booking: allowPublic,
      };
      if (linkedIds !== null) {
        body.resource_ids = Array.from(linkedIds);
      }
      await patch(`/api/admin/offerings/${offering.id}`, body);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/admin/offerings/${offering.id}`, {
        active: !offering.active,
      });
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title="Edit offering"
      subtitle={
        offering.active
          ? 'Price and credit changes affect new bookings only — existing bookings keep what they were charged.'
          : 'This offering is deactivated.'
      }
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="space-y-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Category" hint="lowercase-hyphen">
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              required
              className="font-mono"
              list="offering-category-keys"
            />
          </Field>
          <Field
            label="Description"
            hint="Shown to customers in the booking page's details expander. Keep the name short; explain here."
          >
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
            <Field label="Capacity" hint="1 = rental">
              <Input
                type="number"
                min="1"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                required
              />
            </Field>
          </div>
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Who can book
            </span>
            <div className="flex gap-5 text-sm text-slate-700">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allowMember}
                  onChange={(e) => setAllowMember(e.target.checked)}
                />
                Members
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allowPublic}
                  onChange={(e) => setAllowPublic(e.target.checked)}
                />
                Walk-ins (public)
              </label>
            </div>
          </div>
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Resources
            </span>
            {linkedIds === null ? (
              <p className="text-sm text-slate-400">loading…</p>
            ) : (resources ?? []).length === 0 ? (
              <p className="text-sm text-slate-500">No resources yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {resources.map((r) => (
                  <label
                    key={r.id}
                    className="flex items-center gap-2 text-sm text-slate-700"
                  >
                    <input
                      type="checkbox"
                      checked={linkedIds.has(r.id)}
                      onChange={() => toggleResource(r.id)}
                    />
                    {r.name}
                    {!r.active && (
                      <span className="text-xs text-slate-400">(inactive)</span>
                    )}
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-slate-500">
              Unchecking a resource stops new bookings there; existing
              bookings are untouched.
            </p>
          </div>
        </div>
        {error && <ErrorBanner message={error} />}
        <ModalFooter
          item={offering}
          busy={busy}
          onToggleActive={toggleActive}
          deactivateLabel="Deactivate offering"
          confirmTitle={
            offering.active ? 'Deactivate offering?' : 'Reactivate offering?'
          }
          confirmMessage={
            offering.active
              ? `Deactivate "${offering.name}"? Members and walk-ins won't be able to book it. Existing bookings keep their original price and credits. You can reactivate it anytime.`
              : `Reactivate "${offering.name}"? It will be bookable again on its linked resources.`
          }
        />
      </form>
    </ModalShell>
  );
}

// ============================================================
// Plan
// ============================================================

export function PlanEditModal({ plan, onClose, onSaved }) {
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description ?? '');
  const [monthlyPrice, setMonthlyPrice] = useState(plan.monthly_price_cents / 100);
  const [creditsPerWeek, setCreditsPerWeek] = useState(plan.credits_per_week);
  const [categories, setCategories] = useState(
    (plan.allowed_categories ?? []).join(', '),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const synced = Boolean(plan.stripe_price_id);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const cats = categories
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      await patch(`/api/admin/plans/${plan.id}`, {
        name,
        description: description.trim() === '' ? null : description,
        monthly_price_cents: Math.round(Number(monthlyPrice) * 100),
        credits_per_week: Number(creditsPerWeek),
        allowed_categories: cats.length > 0 ? cats : null,
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/admin/plans/${plan.id}`, { active: !plan.active });
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title="Edit plan"
      subtitle={plan.active ? undefined : 'This plan is deactivated.'}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="space-y-4">
          <Field label="Plan name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Description">
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Monthly price"
              hint={
                synced
                  ? 'Synced to Stripe — a price change applies to new signups only. Existing members keep their current rate.'
                  : undefined
              }
            >
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
          <Field
            label="Allowed categories"
            hint="Comma-separated (e.g. classes, cage-time). Leave blank to allow all categories."
          >
            <Input
              value={categories}
              onChange={(e) => setCategories(e.target.value)}
              placeholder="all categories"
              className="font-mono"
            />
          </Field>
        </div>
        {error && <ErrorBanner message={error} />}
        <ModalFooter
          item={plan}
          busy={busy}
          onToggleActive={toggleActive}
          deactivateLabel="Deactivate plan"
          confirmTitle={plan.active ? 'Deactivate plan?' : 'Reactivate plan?'}
          confirmMessage={
            plan.active
              ? `Deactivate "${plan.name}"? It will be hidden from new signups. Existing members keep their current subscription and rate. You can reactivate it anytime.`
              : `Reactivate "${plan.name}"? Members will be able to subscribe to it again.`
          }
        />
      </form>
    </ModalShell>
  );
}
