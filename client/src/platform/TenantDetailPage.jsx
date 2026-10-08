import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Eye, ExternalLink, X } from 'lucide-react';

import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  InputDialog,
  Page,
  PageHeader,
} from '../components/ui/index.js';
import { formatCents, formatTimezoneLabel } from '../format.js';
import { papi, papiJson } from './api.js';
import {
  actionLabel,
  auditDetail,
  billingLabel,
  dateTime,
  relativeTime,
  stripeLabel,
} from './format.js';

export default function TenantDetailPage() {
  const { id } = useParams();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    papiJson(`/api/platform/tenants/${id}`)
      .then(setDoc)
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error) {
    return (
      <Page>
        <BackLink />
        <p className="text-sm text-rose-600">{error}</p>
      </Page>
    );
  }
  if (!doc) {
    return (
      <Page>
        <p className="text-sm text-slate-500">Loading…</p>
      </Page>
    );
  }

  const { tenant } = doc;
  return (
    <Page>
      <BackLink />
      <PageHeader
        title={tenant.name}
        description={`${tenant.subdomain} · ${formatTimezoneLabel(tenant.timezone)} · joined ${new Date(tenant.created_at).toLocaleDateString()}`}
        actions={
          <>
            <Button as="a" variant="secondary" href={doc.urls.booking} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> Booking page
            </Button>
            <ViewAsOwnerButton tenantId={tenant.id} />
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SetupCard doc={doc} />
        <BillingCard doc={doc} onChanged={load} />
        <ActivityCard doc={doc} />
        <StaffCard staff={doc.staff} />
        <ProfileCard tenant={tenant} />
        <AuditCard entries={doc.audit} />
      </div>
    </Page>
  );
}

function BackLink() {
  return (
    <Link to="/" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
      <ArrowLeft size={16} /> All facilities
    </Link>
  );
}

// Opens the tenant's admin as its owner, read-only, in a new tab. The
// tab is opened synchronously (inside the click) so popup blockers
// allow it, then pointed at the handoff URL once the API answers.
function ViewAsOwnerButton({ tenantId }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function open() {
    setError('');
    setBusy(true);
    const tab = window.open('about:blank', '_blank');
    try {
      const { url } = await papiJson(`/api/platform/tenants/${tenantId}/support-session`, {
        method: 'POST',
      });
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (e) {
      tab?.close();
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end">
      <Button onClick={open} disabled={busy} title="Opens their admin as the owner. You can look, not change anything. Logged.">
        <Eye size={16} /> {busy ? 'Opening…' : 'View as owner'}
      </Button>
      {error && <span className="mt-1 text-xs text-rose-600">{error}</span>}
    </div>
  );
}

function CheckRow({ ok, label, detail }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
          ok ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'
        }`}
      >
        {ok ? <Check size={13} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}
      </span>
      <span className="text-sm">
        <span className={ok ? 'text-slate-900' : 'text-slate-600'}>{label}</span>
        {detail && <span className="text-slate-500"> — {detail}</span>}
      </span>
    </li>
  );
}

function SetupCard({ doc }) {
  const { setup, stripe_connection: sc, staff } = doc;
  const ownerReady = staff.some((s) => s.role === 'owner' && s.has_password);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const items = [
    { ok: ownerReady, label: 'Owner has set a password', detail: ownerReady ? null : 'setup email not used yet' },
    { ok: setup.resources > 0, label: 'Spaces set up', detail: plural(setup.resources, 'space') },
    {
      ok: setup.public_offerings > 0,
      label: 'Services on the booking page',
      detail: `${setup.public_offerings} of ${plural(setup.offerings, 'service')}`,
    },
    { ok: setup.operating_hours > 0, label: 'Opening hours set' },
    {
      ok: sc?.charges_enabled === true,
      label: 'Card payments',
      detail: stripeLabel(sc ? sc.charges_enabled : null).label.toLowerCase(),
    },
    { ok: setup.has_address, label: 'Address on the booking page' },
    { ok: setup.has_reply_to, label: 'Reply-to email for customer emails' },
  ];
  const done = items.filter((i) => i.ok).length;

  return (
    <Card
      title="Ready to take bookings?"
      actions={<Badge tone={done === items.length ? 'success' : 'warning'}>{done}/{items.length}</Badge>}
    >
      <ul>
        {items.map((i) => (
          <CheckRow key={i.label} {...i} />
        ))}
      </ul>
      {setup.plans === 0 && (
        <p className="mt-3 text-xs text-slate-500">No membership plans yet — walk-in bookings only.</p>
      )}
    </Card>
  );
}

function BillingCard({ doc, onChanged }) {
  const { billing, tenant } = doc;
  const [dialog, setDialog] = useState(null); // 'extend' | 'comp' | 'suspend' | 'unsuspend'
  const [error, setError] = useState('');
  const label = billingLabel(billing);

  async function patch(body) {
    setDialog(null);
    setError('');
    const res = await papi(`/api/platform/tenants/${tenant.subdomain}/billing`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error || 'Could not update billing.');
      return;
    }
    onChanged();
  }

  const suspended = billing.status === 'suspended';

  return (
    <Card title="Platform billing" actions={<Badge tone={label.tone} dot>{label.label}</Badge>}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-slate-500">Trial ends</dt>
        <dd className="text-slate-900">
          {billing.trial_ends_at ? new Date(billing.trial_ends_at).toLocaleDateString() : 'No end date'}
        </dd>
        <dt className="text-slate-500">Paying by card</dt>
        <dd className="text-slate-900">{billing.has_subscription ? 'Yes' : 'No'}</dd>
        <dt className="text-slate-500">Can use the app</dt>
        <dd className={billing.is_billing_ok ? 'text-slate-900' : 'font-medium text-rose-600'}>
          {billing.is_billing_ok ? 'Yes' : 'No — locked out'}
        </dd>
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setDialog('extend')}>
          Set trial end
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setDialog('comp')}>
          Make free
        </Button>
        {suspended ? (
          <Button size="sm" variant="secondary" onClick={() => setDialog('unsuspend')}>
            Unsuspend
          </Button>
        ) : (
          <button
            type="button"
            onClick={() => setDialog('suspend')}
            className="h-8 rounded-lg px-3 text-xs font-medium text-rose-600 hover:bg-rose-50"
          >
            Suspend
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}

      {dialog === 'extend' && (
        <InputDialog
          title="Set trial end"
          message={`${tenant.name}'s trial will end this many days from today (replacing the current end date).`}
          label="Days from today"
          initialValue="14"
          confirmLabel="Save"
          onClose={() => setDialog(null)}
          onSubmit={(v) => {
            const days = Number.parseInt(v, 10);
            if (!Number.isFinite(days) || days < 1 || days > 365) {
              setDialog(null);
              setError('Enter a number of days between 1 and 365.');
              return;
            }
            patch({
              status: 'trial',
              trial_ends_at: new Date(Date.now() + days * 86400000).toISOString(),
            });
          }}
        />
      )}
      {dialog === 'comp' && (
        <ConfirmDialog
          variant="neutral"
          title="Make free?"
          message={`${tenant.name} keeps full access with no trial end and no charge, until you change it.`}
          confirmLabel="Make free"
          onClose={() => setDialog(null)}
          onConfirm={() => patch({ status: 'trial', trial_ends_at: null })}
        />
      )}
      {dialog === 'suspend' && (
        <ConfirmDialog
          title="Suspend facility?"
          message={`${tenant.name}'s staff, members and customers are locked out until you unsuspend. The owner can still sign in to see the billing screen.`}
          confirmLabel="Suspend"
          onClose={() => setDialog(null)}
          onConfirm={() => patch({ status: 'suspended' })}
        />
      )}
      {dialog === 'unsuspend' && (
        <ConfirmDialog
          variant="neutral"
          title="Unsuspend facility?"
          message={
            billing.has_subscription
              ? 'Restores access as a paying facility.'
              : 'Restores access on their trial. If the trial has already ended, extend it or make them free too.'
          }
          confirmLabel="Unsuspend"
          onClose={() => setDialog(null)}
          onConfirm={() => patch({ status: billing.has_subscription ? 'active' : 'trial' })}
        />
      )}
    </Card>
  );
}

function ActivityCard({ doc }) {
  const a = doc.activity;
  const rows = [
    ['Members', a.members],
    ['Subscribed members', a.active_subscriptions],
    ['Bookings (30 days)', `${a.bookings_last_30d} (${a.walkin_bookings_last_30d} walk-in)`],
    ['Upcoming bookings', a.upcoming_bookings],
    ['Card payments (30 days)', formatCents(a.paid_cents_last_30d)],
    ['Last booking', relativeTime(a.last_booking_at)],
    ['Last weekly credit reset', relativeTime(doc.tenant.last_weekly_reset_at)],
  ];
  return (
    <Card title="Activity">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-slate-900">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function StaffCard({ staff }) {
  return (
    <Card title="Staff">
      {staff.length === 0 ? (
        <p className="text-sm text-slate-500">No staff accounts.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {staff.map((s) => (
            <li key={s.email} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">
                  {s.first_name} {s.last_name}
                </p>
                <p className="truncate text-xs text-slate-500">{s.email}</p>
              </div>
              <div className="flex gap-1.5">
                <Badge tone={s.role === 'owner' ? 'brand' : 'neutral'}>
                  {s.role === 'owner' ? 'Owner' : 'Staff'}
                </Badge>
                {!s.has_password && <Badge tone="warning">Invite pending</Badge>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ProfileCard({ tenant }) {
  const address = [
    tenant.address_street,
    tenant.address_city,
    [tenant.address_state, tenant.address_zip].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');
  const rows = [
    ['Address', address || '—'],
    ['Phone', tenant.business_phone || '—'],
    ['Reply-to email', tenant.reply_to_email || '—'],
    [
      'Google rating',
      tenant.google_rating != null
        ? `${tenant.google_rating} (${tenant.google_review_count ?? 0} reviews)`
        : '—',
    ],
    ['Google Analytics', tenant.ga4_measurement_id || 'Not set'],
  ];
  return (
    <Card title="Facility profile">
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="break-words text-slate-900">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function AuditCard({ entries }) {
  return (
    <Card
      title="Platform activity"
      actions={
        <Link to="/audit" className="text-xs font-medium text-slate-500 hover:text-slate-900">
          Full log
        </Link>
      }
    >
      {entries.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing yet.</p>
      ) : (
        <ul className="space-y-2">
          {entries.slice(0, 8).map((e) => (
            <li key={e.id} className="text-sm">
              <span className="text-slate-900">{actionLabel(e.action)}</span>
              {auditDetail(e) && <span className="text-slate-500"> · {auditDetail(e)}</span>}
              <span className="block text-xs text-slate-400">
                {dateTime(e.created_at)} · {e.admin_email ?? 'API token'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
