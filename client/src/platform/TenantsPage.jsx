import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Plus, Search } from 'lucide-react';

import { Badge, Button, Card, Input, Page, PageHeader } from '../components/ui/index.js';
import { papiJson } from './api.js';
import { billingLabel, relativeTime, stripeLabel } from './format.js';
import NewTenantDialog from './NewTenantDialog.jsx';

// A tenant needs a look when it can't (or soon won't be able to) take
// bookings: billing lapsed or failing, trial ending within a week, or
// Stripe not connected/finished.
function needsAttention(t) {
  const { tone } = billingLabel({
    status: t.billing_status,
    trial_ends_at: t.trial_ends_at,
    is_billing_ok: t.is_billing_ok,
  });
  return tone === 'danger' || tone === 'warning' || t.stripe_charges_enabled !== true;
}

export default function TenantsPage() {
  const [tenants, setTenants] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    papiJson('/api/platform/tenants')
      .then((b) => setTenants(b.tenants))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const filtered = useMemo(() => {
    if (!tenants) return [];
    const q = query.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter((t) =>
      [t.name, t.subdomain, t.owner_email].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [tenants, query]);

  const stats = useMemo(() => {
    if (!tenants) return null;
    return {
      total: tenants.length,
      paying: tenants.filter((t) => t.billing_status === 'active').length,
      attention: tenants.filter(needsAttention).length,
      bookings: tenants.reduce((n, t) => n + t.bookings_last_30d, 0),
    };
  }, [tenants]);

  return (
    <Page width="wide">
      <PageHeader
        title="Facilities"
        description="Every facility on the platform, and whether it can take bookings."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> New facility
          </Button>
        }
      />

      {error && <p className="text-sm text-rose-600">{error}</p>}

      {stats && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Facilities" value={stats.total} />
          <Stat label="Paying" value={stats.paying} />
          <Stat label="Need attention" value={stats.attention} warn={stats.attention > 0} />
          <Stat label="Bookings (30 days)" value={stats.bookings} />
        </div>
      )}

      <Card padded={false}>
        <div className="border-b border-slate-200 p-3">
          <label className="relative block max-w-sm">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <Input
              className="pl-9"
              placeholder="Search name, subdomain, owner email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>

        {!tenants && !error && <p className="p-5 text-sm text-slate-500">Loading…</p>}
        {tenants && filtered.length === 0 && (
          <p className="p-5 text-sm text-slate-500">
            {tenants.length === 0 ? 'No facilities yet.' : 'No facilities match that search.'}
          </p>
        )}

        <ul className="divide-y divide-slate-100">
          {filtered.map((t) => {
            const billing = billingLabel({
              status: t.billing_status,
              trial_ends_at: t.trial_ends_at,
              is_billing_ok: t.is_billing_ok,
            });
            const stripe = stripeLabel(t.stripe_charges_enabled);
            return (
              <li key={t.id}>
                <Link
                  to={`/tenants/${t.id}`}
                  className="flex items-center gap-4 px-5 py-4 hover:bg-slate-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">{t.name}</span>
                      <span className="text-sm text-slate-500">{t.subdomain}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <Badge tone={billing.tone} dot>
                        {billing.label}
                      </Badge>
                      <Badge tone={stripe.tone}>{stripe.label}</Badge>
                    </div>
                    <p className="mt-1.5 text-xs text-slate-500">
                      {t.member_count} members · {t.active_subscriptions} subscribed ·{' '}
                      {t.bookings_last_30d} bookings in 30 days · {t.upcoming_bookings} upcoming ·
                      last booking {relativeTime(t.last_booking_at)}
                    </p>
                  </div>
                  <ChevronRight size={18} className="shrink-0 text-slate-300" />
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>

      {creating && (
        <NewTenantDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </Page>
  );
}

function Stat({ label, value, warn = false }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${warn ? 'text-amber-600' : 'text-slate-900'}`}>
        {value}
      </p>
    </div>
  );
}
