// Admin catalog — resources, offerings, and plans management.
//
// Moved off the dashboard (UI-declutter pass): the dashboard shows
// today's operations; configuring what's bookable lives here. Create
// flows stay in the wizard; edit + activate/deactivate use per-row
// Edit modals (CatalogEditModals.jsx).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { CopyButton } from '../components/CopyLink.jsx';
import { serviceBookingUrl } from '../lib/bookingLinks.js';
import {
  Page,
  PageHeader,
  Card,
  Button,
  Badge,
  Field,
  Input,
} from '../components/ui/index.js';
import {
  ResourceEditModal,
  OfferingEditModal,
  PlanEditModal,
} from './CatalogEditModals.jsx';
import {
  formatAllowedCategories,
  formatCategoryLabel,
  formatCents,
} from '../format.js';

// 'cage-time' → 'Cage time' — category keys are normalized lowercase
// hyphenated in the DB; display is a UI concern (CLAUDE.md glossary).
export function prettyCategory(key) {
  if (!key) return '';
  const s = key.replaceAll('-', ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function audienceLabel(o) {
  if (o.allow_member_booking && o.allow_public_booking) return 'Members + public';
  if (o.allow_member_booking) return 'Members';
  if (o.allow_public_booking) return 'Public';
  return '—';
}

export default function AdminCatalog() {
  const { tenant } = useAuth();
  const [resources, setResources] = useState(null);
  const [offerings, setOfferings] = useState(null);
  const [plans, setPlans] = useState(null);
  // { categories: [...overlay rows], categories_in_use: [...keys] }
  const [categoryDisplay, setCategoryDisplay] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [syncMessage, setSyncMessage] = useState(null);
  const [syncingPlanId, setSyncingPlanId] = useState(null);
  // Which catalog item is being edited: { type, item } or null.
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    load();
  }, []);

  function load() {
    setLoadError(null);
    Promise.all([
      api('/api/admin/resources').then(handle),
      api('/api/admin/offerings').then(handle),
      api('/api/admin/plans').then(handle),
      api('/api/admin/category-display').then(handle),
    ])
      .then(([r, o, p, c]) => {
        setResources(r.resources ?? []);
        setOfferings(o.offerings ?? []);
        setPlans(p.plans ?? []);
        setCategoryDisplay(c);
      })
      .catch((err) => setLoadError(err.message));
  }

  async function syncPlan(plan) {
    if (syncingPlanId) return;
    setSyncMessage(null);
    setSyncingPlanId(plan.id);
    try {
      const res = await api(`/api/admin/plans/${plan.id}/stripe-sync`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSyncMessage(
        body.synced
          ? `Synced "${plan.name}" to Stripe.`
          : `"${plan.name}" was already synced.`,
      );
      const r = await api('/api/admin/plans').then(handle);
      setPlans(r.plans ?? []);
    } catch (err) {
      setSyncMessage(`Sync failed: ${err.message}`);
    } finally {
      setSyncingPlanId(null);
    }
  }

  function editSaved() {
    setEditing(null);
    load();
  }

  function editColumn(type) {
    return {
      key: 'actions',
      label: '',
      render: (item) => (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setEditing({ type, item })}
        >
          Edit
        </Button>
      ),
    };
  }

  const catalogLoaded =
    resources !== null && offerings !== null && plans !== null;
  const setupIncomplete =
    catalogLoaded &&
    (resources.length === 0 || offerings.length === 0 || plans.length === 0);

  return (
    <Page width="default">
      <PageHeader
        title="Catalog"
        description="What your facility rents, sells, and offers — resources, offerings, and membership plans."
        actions={
          <Button as={Link} to="/wizard" variant="secondary">
            Setup wizard
          </Button>
        }
      />

      {setupIncomplete && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-brand-200 bg-brand-50 p-4">
          <div>
            <div className="font-semibold text-slate-900">
              Set up your facility
            </div>
            <div className="text-sm text-slate-600">
              Add your resources, offerings, and plans in five quick steps.
            </div>
          </div>
          <Button as={Link} to="/wizard">
            Start setup wizard
          </Button>
        </div>
      )}

      {syncMessage && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700">
          {syncMessage}
        </div>
      )}

      <ListSection
        title="Resources"
        rows={resources}
        error={loadError}
        empty="No resources yet. Add one via the setup wizard."
        columns={[
          { key: 'name', label: 'Name', render: (r) => r.name },
          {
            key: 'active',
            label: 'Status',
            render: (r) => <ActiveBadge active={r.active} />,
          },
          editColumn('resource'),
        ]}
      />

      <ListSection
        title="Offerings"
        rows={offerings}
        error={loadError}
        empty="No offerings yet."
        columns={[
          {
            key: 'name',
            label: 'Name',
            render: (o) => (
              <div>
                <div className="font-medium text-slate-900">{o.name}</div>
                <div className="text-xs text-slate-500">
                  {o.duration_minutes} min ·{' '}
                  {o.capacity > 1 ? `class of ${o.capacity}` : 'rental'} ·{' '}
                  {prettyCategory(o.category)}
                </div>
              </div>
            ),
          },
          {
            key: 'pricing',
            label: 'Pricing',
            render: (o) => (
              <div>
                <div>{formatCents(o.dollar_price)}</div>
                <div className="text-xs text-slate-500">
                  {o.credit_cost} credit{o.credit_cost === 1 ? '' : 's'}
                </div>
              </div>
            ),
          },
          {
            key: 'audience',
            label: 'Who can book',
            render: (o) => audienceLabel(o),
          },
          {
            key: 'active',
            label: 'Status',
            render: (o) => <ActiveBadge active={o.active} />,
          },
          {
            key: 'actions',
            label: '',
            render: (o) => (
              <div className="flex justify-end gap-2">
                {/* Direct link into this service's time picker. Only
                    for offerings the public page actually lists —
                    otherwise the link would dump the customer back on
                    the service list. The two columns to the left
                    already explain why it's missing. */}
                {o.active && o.allow_public_booking && (
                  <CopyButton
                    value={serviceBookingUrl(tenant, o.id)}
                    label="Copy link"
                  />
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditing({ type: 'offering', item: o })}
                >
                  Edit
                </Button>
              </div>
            ),
          },
        ]}
      />

      <ListSection
        title="Plans"
        rows={plans}
        error={loadError}
        empty="No plans yet."
        columns={[
          {
            key: 'name',
            label: 'Name',
            render: (p) => (
              <div>
                <div className="font-medium text-slate-900">{p.name}</div>
                <div className="text-xs text-slate-500">
                  {p.credits_per_week} credits/week ·{' '}
                  {formatAllowedCategories(p.allowed_categories)}
                </div>
              </div>
            ),
          },
          {
            key: 'price',
            label: 'Monthly',
            render: (p) => formatCents(p.monthly_price_cents),
          },
          {
            key: 'stripe',
            label: 'Stripe',
            render: (p) =>
              p.stripe_price_id ? (
                <Badge tone="success">linked</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => syncPlan(p)}
                  disabled={syncingPlanId === p.id || !p.active || p.monthly_price_cents === 0}
                  title={
                    !p.active
                      ? 'plan is inactive'
                      : p.monthly_price_cents === 0
                        ? 'free plan cannot be synced'
                        : 'create Stripe Product + Price on your connected account'
                  }
                >
                  {syncingPlanId === p.id ? 'syncing…' : 'Sync'}
                </Button>
              ),
          },
          {
            key: 'active',
            label: 'Status',
            render: (p) => <ActiveBadge active={p.active} />,
          },
          editColumn('plan'),
        ]}
      />

      <SectionsCard data={categoryDisplay} onChanged={load} />

      {/* Category-key suggestions for the offering edit modal — one
          existing key per option, so a typo can't quietly fork
          'cage-time' into 'cagetime'. */}
      <datalist id="offering-category-keys">
        {(categoryDisplay?.categories_in_use ?? []).map((key) => (
          <option key={key} value={key} />
        ))}
      </datalist>

      {editing?.type === 'resource' && (
        <ResourceEditModal
          resource={editing.item}
          onClose={() => setEditing(null)}
          onSaved={editSaved}
        />
      )}
      {editing?.type === 'offering' && (
        <OfferingEditModal
          offering={editing.item}
          resources={resources ?? []}
          onClose={() => setEditing(null)}
          onSaved={editSaved}
        />
      )}
      {editing?.type === 'plan' && (
        <PlanEditModal
          plan={editing.item}
          onClose={() => setEditing(null)}
          onSaved={editSaved}
        />
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

// Section labels + ordering for the public booking page. One row per
// category key in use; a saved label overrides the derived one
// ("hittrax" → "HitTrax – See Your Hitting Stats"), Reset reverts.
function SectionsCard({ data, onChanged }) {
  const [drafts, setDrafts] = useState({});
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState(null);

  if (!data) return null;
  const overlay = new Map(data.categories.map((c) => [c.category, c]));
  // Every key in use, plus orphan overlay rows (label saved for a key
  // no offering uses anymore — visible so it can be pruned).
  const keys = [
    ...new Set([
      ...data.categories_in_use,
      ...data.categories.map((c) => c.category),
    ]),
  ].sort();

  function draftFor(key) {
    const row = overlay.get(key);
    return (
      drafts[key] ?? {
        label: row?.label ?? '',
        display_order: row != null ? String(row.display_order) : '0',
      }
    );
  }

  async function save(key) {
    const d = draftFor(key);
    if (!d.label.trim()) return;
    setBusyKey(key);
    setError(null);
    try {
      const res = await api(
        `/api/admin/category-display/${encodeURIComponent(key)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            label: d.label.trim(),
            display_order: Number(d.display_order) || 0,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey(null);
    }
  }

  async function reset(key) {
    setBusyKey(key);
    setError(null);
    try {
      const res = await api(
        `/api/admin/category-display/${encodeURIComponent(key)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Card title="Booking page sections">
      <p className="mb-4 text-sm text-slate-500">
        How categories appear as section headers on your public booking
        page. Describe the product — "Cage + Pitching Machine" beats
        "SPECIALS". Lower order shows first; leave a label blank to use
        the automatic one.
      </p>
      {error && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}
      {keys.length === 0 ? (
        <p className="text-sm text-slate-500">
          No categories yet — they appear here once you add offerings.
        </p>
      ) : (
        <div className="space-y-3">
          {keys.map((key) => {
            const d = draftFor(key);
            const hasRow = overlay.has(key);
            const inUse = data.categories_in_use.includes(key);
            return (
              <div
                key={key}
                className="grid items-end gap-3 sm:grid-cols-[10rem_1fr_6rem_auto]"
              >
                <div className="pb-2 text-sm">
                  <span className="font-mono text-xs text-slate-500">
                    {key}
                  </span>
                  {!inUse && (
                    <span className="ml-1 text-xs text-amber-600">
                      (unused)
                    </span>
                  )}
                </div>
                <Field label="Section header">
                  <Input
                    placeholder={formatCategoryLabel(key)}
                    value={d.label}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [key]: { ...d, label: e.target.value },
                      }))
                    }
                  />
                </Field>
                <Field label="Order">
                  <Input
                    type="number"
                    min="0"
                    value={d.display_order}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [key]: { ...d, display_order: e.target.value },
                      }))
                    }
                  />
                </Field>
                <div className="flex gap-2 pb-0.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyKey === key || !d.label.trim()}
                    onClick={() => save(key)}
                  >
                    Save
                  </Button>
                  {hasRow && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyKey === key}
                      onClick={() => reset(key)}
                    >
                      Reset
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function ActiveBadge({ active }) {
  return (
    <Badge tone={active ? 'success' : 'neutral'}>
      {active ? 'active' : 'inactive'}
    </Badge>
  );
}

function ListSection({ title, rows, error, empty, columns }) {
  return (
    <Card
      padded={false}
      title={
        <>
          {title}{' '}
          {rows !== null && (
            <span className="font-normal text-slate-400">({rows.length})</span>
          )}
        </>
      }
    >
      {error && (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}
      {rows === null ? (
        <p className="px-5 py-4 text-sm text-slate-400">loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className="px-4 py-3">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-3 text-sm">
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
