// Admin home — tenant card, members + admins (Phase 1 slice 4),
// catalog read views (Phase 3 prep), wizard entry point.
//
// Read-only views for everything the admin can configure. Edit /
// create flows for catalog items live in the wizard for now;
// inline CRUD lands when admins demand it (probably during Phase 3
// when ops staff need to tweak hours/policies frequently).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
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

  useEffect(() => {
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
  }, []);

  // Map of resource_id → name, for joining onto operating_hours.
  const resourceNameById = new Map((resources ?? []).map((r) => [r.id, r.name]));

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-4xl mx-auto p-6 space-y-8">
        <WizardCallout />
        <BookingsCallout />
        <ClassesCallout />
        <TenantCard tenant={me.tenant} />

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
                  <span className="text-xs text-emerald-700">linked</span>
                ) : (
                  <span className="text-xs text-slate-400">—</span>
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
            { key: 'created_at', label: 'Joined', render: (r) => formatDate(r.created_at) },
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
                <span
                  className={`text-xs rounded px-2 py-0.5 ${
                    r.role === 'owner'
                      ? 'bg-amber-100 text-amber-900'
                      : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  {r.role}
                </span>
              ),
            },
          ]}
        />
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

function WizardCallout() {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded p-4 flex items-center justify-between">
      <div>
        <div className="font-semibold text-amber-900">Set up your facility</div>
        <div className="text-sm text-amber-800">
          Add your resources, offerings, and plans in five quick steps.
        </div>
      </div>
      <Link
        to="/wizard"
        className="rounded bg-amber-900 text-white px-4 py-2 hover:bg-amber-800"
      >
        Start setup wizard
      </Link>
    </div>
  );
}

function BookingsCallout() {
  return (
    <div className="bg-sky-50 border border-sky-200 rounded p-4 flex items-center justify-between">
      <div>
        <div className="font-semibold text-sky-900">Bookings</div>
        <div className="text-sm text-sky-800">
          View, cancel, or mark no-show on bookings across the facility.
        </div>
      </div>
      <Link
        to="/admin/bookings"
        className="rounded bg-sky-700 text-white px-4 py-2 hover:bg-sky-800"
      >
        Open calendar
      </Link>
    </div>
  );
}

function ClassesCallout() {
  return (
    <div className="bg-violet-50 border border-violet-200 rounded p-4 flex items-center justify-between">
      <div>
        <div className="font-semibold text-violet-900">Classes</div>
        <div className="text-sm text-violet-800">
          Schedule recurring classes, create one-off instances, and manage rosters.
        </div>
      </div>
      <Link
        to="/admin/classes"
        className="rounded bg-violet-700 text-white px-4 py-2 hover:bg-violet-800"
      >
        Open classes
      </Link>
    </div>
  );
}

function TenantCard({ tenant }) {
  return (
    <section>
      <h2 className="text-xl font-semibold">Tenant</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm max-w-md">
        <dt className="text-slate-500">Name</dt>
        <dd>{tenant.name}</dd>
        <dt className="text-slate-500">Subdomain</dt>
        <dd className="font-mono">{tenant.subdomain}</dd>
        <dt className="text-slate-500">Timezone</dt>
        <dd className="font-mono">{tenant.timezone}</dd>
        <dt className="text-slate-500">ID</dt>
        <dd className="font-mono text-xs">{tenant.id}</dd>
      </dl>
    </section>
  );
}

function BookingPoliciesCard({ policies, error }) {
  return (
    <section>
      <h2 className="text-xl font-semibold">Booking policies</h2>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {policies === null ? (
        <p className="mt-2 text-sm text-slate-400">loading…</p>
      ) : (
        <>
          {!policies.exists && (
            <p className="mt-2 text-sm text-slate-500">
              No row yet — showing schema defaults. They'll be saved on
              first edit.
            </p>
          )}
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm max-w-md">
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
    </section>
  );
}

function ActiveBadge({ active }) {
  return (
    <span
      className={`text-xs rounded px-2 py-0.5 ${
        active
          ? 'bg-emerald-100 text-emerald-900'
          : 'bg-slate-200 text-slate-600'
      }`}
    >
      {active ? 'active' : 'inactive'}
    </span>
  );
}

function ListSection({ title, rows, error, empty, columns }) {
  return (
    <section>
      <h2 className="text-xl font-semibold">
        {title}{' '}
        {rows !== null && (
          <span className="text-slate-400 text-base">({rows.length})</span>
        )}
      </h2>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {rows === null ? (
        <p className="mt-2 text-sm text-slate-400">loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{empty}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500 border-b border-slate-200">
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className="pb-2 font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id ?? r.tenant_id ?? JSON.stringify(r)} className="border-b border-slate-100">
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`py-2 pr-4 ${c.mono ? 'font-mono text-xs' : ''}`}
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
    </section>
  );
}
