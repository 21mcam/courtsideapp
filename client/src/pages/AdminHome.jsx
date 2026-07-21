// Admin home — dashboard overview: stats, catalog read views,
// booking policies, members + admins (Phase 1 slice 4).
//
// Read-only views for everything the admin can configure. Edit /
// create flows for catalog items live in the wizard for now;
// inline CRUD lands when admins demand it (probably during Phase 3
// when ops staff need to tweak hours/policies frequently).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Page, PageHeader, Card, Button, Badge } from '../components/ui/index.js';
import {
  dayOfWeekLabel,
  formatAllowedCategories,
  formatCents,
  formatDate,
  formatNoShowAction,
  timeShort,
} from '../format.js';

export default function AdminHome() {
  const { me } = useAuth();
  const [members, setMembers] = useState(null);
  const [admins, setAdmins] = useState(null);
  const [resources, setResources] = useState(null);
  const [offerings, setOfferings] = useState(null);
  const [plans, setPlans] = useState(null);
  const [operatingHours, setOperatingHours] = useState(null);
  const [policies, setPolicies] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [syncMessage, setSyncMessage] = useState(null);
  const [syncingPlanId, setSyncingPlanId] = useState(null);

  useEffect(() => {
    load();
  }, []);

  // Map of resource_id → name, for joining onto operating_hours.
  const resourceNameById = new Map((resources ?? []).map((r) => [r.id, r.name]));

  function load() {
    setLoadError(null);
    Promise.all([
      api('/api/admin/members').then(handle),
      api('/api/admin/admins').then(handle),
      api('/api/admin/resources').then(handle),
      api('/api/admin/offerings').then(handle),
      api('/api/admin/plans').then(handle),
      api('/api/admin/operating-hours').then(handle),
      api('/api/admin/booking-policies').then(handle),
    ])
      .then(([m, a, r, o, p, h, bp]) => {
        setMembers(m.members ?? []);
        setAdmins(a.admins ?? []);
        setResources(r.resources ?? []);
        setOfferings(o.offerings ?? []);
        setPlans(p.plans ?? []);
        setOperatingHours(h.operating_hours ?? []);
        setPolicies(bp.booking_policies ?? null);
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
      // Refresh just the plans column.
      const r = await api('/api/admin/plans').then(handle);
      setPlans(r.plans ?? []);
    } catch (err) {
      setSyncMessage(`Sync failed: ${err.message}`);
    } finally {
      setSyncingPlanId(null);
    }
  }

  // Setup is incomplete until the catalog has at least one of each.
  const catalogLoaded =
    resources !== null && offerings !== null && plans !== null;
  const setupIncomplete =
    catalogLoaded &&
    (resources.length === 0 || offerings.length === 0 || plans.length === 0);

  return (
    <Page width="default">
      <PageHeader
        title="Dashboard"
        description={`${me.tenant.name} at a glance — catalog, policies, and people.`}
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

      {catalogLoaded && (
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Resources" value={resources.length} />
          <StatCard label="Offerings" value={offerings.length} />
          <StatCard label="Plans" value={plans.length} />
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
          { key: 'order', label: 'Order', render: (r) => r.display_order },
        ]}
      />

      <ListSection
        title="Offerings"
        rows={offerings}
        error={loadError}
        empty="No offerings yet."
        columns={[
          { key: 'name', label: 'Name', render: (o) => o.name },
          {
            key: 'category',
            label: 'Category',
            mono: true,
            render: (o) => o.category,
          },
          {
            key: 'capacity',
            label: 'Type',
            render: (o) => (o.capacity > 1 ? `class · ${o.capacity}` : 'rental'),
          },
          { key: 'duration', label: 'Duration', render: (o) => `${o.duration_minutes} min` },
          { key: 'credit', label: 'Credits', render: (o) => o.credit_cost },
          { key: 'price', label: 'Price', render: (o) => formatCents(o.dollar_price) },
          {
            key: 'audience',
            label: 'Audience',
            render: (o) => (
              <span className="text-xs text-slate-600">
                {o.allow_member_booking ? 'M' : '·'}
                {o.allow_public_booking ? 'P' : '·'}
              </span>
            ),
          },
          {
            key: 'active',
            label: 'Status',
            render: (o) => <ActiveBadge active={o.active} />,
          },
        ]}
      />

      <ListSection
        title="Plans"
        rows={plans}
        error={loadError}
        empty="No plans yet."
        columns={[
          { key: 'name', label: 'Name', render: (p) => p.name },
          {
            key: 'price',
            label: 'Monthly',
            render: (p) => formatCents(p.monthly_price_cents),
          },
          {
            key: 'credits',
            label: 'Credits/wk',
            render: (p) => p.credits_per_week,
          },
          {
            key: 'cats',
            label: 'Allowed',
            render: (p) => formatAllowedCategories(p.allowed_categories),
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
        ]}
      />

      <ListSection
        title="Operating hours"
        rows={operatingHours}
        error={loadError}
        empty="No operating hours set. Resources without hours are closed every day."
        columns={[
          {
            key: 'resource',
            label: 'Resource',
            render: (h) => resourceNameById.get(h.resource_id) ?? h.resource_id,
          },
          {
            key: 'day',
            label: 'Day',
            render: (h) => dayOfWeekLabel(h.day_of_week),
          },
          { key: 'open', label: 'Open', render: (h) => timeShort(h.open_time) },
          { key: 'close', label: 'Close', render: (h) => timeShort(h.close_time) },
        ]}
      />

      <BookingPoliciesCard policies={policies} error={loadError} />

      <ListSection
        title="Members"
        rows={members}
        error={loadError}
        empty="No members yet."
        columns={[
          {
            key: 'name',
            label: 'Name',
            render: (r) => `${r.first_name} ${r.last_name}`,
          },
          { key: 'email', label: 'Email', mono: true, render: (r) => r.email },
          {
            key: 'credits',
            label: 'Credits',
            render: (r) => r.current_credits ?? 0,
          },
          {
            key: 'created_at',
            label: 'Joined',
            render: (r) => formatDate(r.created_at, me.tenant.timezone),
          },
        ]}
      />

      <ListSection
        title="Admins"
        rows={admins}
        error={loadError}
        empty="No admins yet."
        columns={[
          {
            key: 'name',
            label: 'Name',
            render: (r) => `${r.first_name} ${r.last_name}`,
          },
          { key: 'email', label: 'Email', mono: true, render: (r) => r.email },
          {
            key: 'role',
            label: 'Role',
            render: (r) => (
              <Badge tone={r.role === 'owner' ? 'brand' : 'neutral'}>
                {r.role}
              </Badge>
            ),
          },
        ]}
      />
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

function StatCard({ label, value }) {
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-3xl font-semibold text-slate-900">{value}</div>
    </Card>
  );
}

function BookingPoliciesCard({ policies, error }) {
  return (
    <Card title="Booking policies">
      {error && (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}
      {policies === null ? (
        <p className="text-sm text-slate-400">loading…</p>
      ) : (
        <>
          {!policies.exists && (
            <p className="mb-3 text-sm text-slate-500">
              No row yet — showing schema defaults. They'll be saved on
              first edit.
            </p>
          )}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm max-w-md">
            <dt className="text-slate-500">Free cancel</dt>
            <dd>{policies.free_cancel_hours_before} hours before</dd>
            <dt className="text-slate-500">Partial refund</dt>
            <dd>
              {policies.partial_refund_hours_before == null
                ? '— not configured —'
                : `${policies.partial_refund_hours_before}h before, ${policies.partial_refund_percent}%`}
            </dd>
            <dt className="text-slate-500">No-show action</dt>
            <dd>
              {formatNoShowAction(policies.no_show_action)}
              {policies.no_show_action === 'charge_fee' &&
                policies.no_show_fee_cents != null && (
                  <> · {formatCents(policies.no_show_fee_cents)}</>
                )}
            </dd>
            <dt className="text-slate-500">Advance window</dt>
            <dd>
              {policies.min_advance_booking_minutes} min – {policies.max_advance_booking_days} days
            </dd>
            <dt className="text-slate-500">Self cancel</dt>
            <dd>
              members {policies.allow_member_self_cancel ? '✓' : '·'} · customers{' '}
              {policies.allow_customer_self_cancel ? '✓' : '·'}
            </dd>
          </dl>
        </>
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
                <tr key={r.id ?? r.tenant_id ?? JSON.stringify(r)} className="hover:bg-slate-50">
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-4 py-3 text-sm ${c.mono ? 'font-mono text-xs' : ''}`}
                    >
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
