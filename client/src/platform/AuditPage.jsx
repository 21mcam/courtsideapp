import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Badge, Card, Page, PageHeader } from '../components/ui/index.js';
import { papiJson } from './api.js';
import { actionLabel, auditDetail, dateTime } from './format.js';

const TONES = {
  'auth.login_failed': 'danger',
  'support_session.open': 'warning',
  'tenant.billing_update': 'info',
  'tenant.create': 'success',
};

export default function AuditPage() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    papiJson('/api/platform/audit?limit=200')
      .then((b) => setEntries(b.entries))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <Page>
      <PageHeader
        title="Audit log"
        description="Every sign-in, facility view, view-as-owner session and billing change on the platform."
      />
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <Card padded={false}>
        {!entries && !error && <p className="p-5 text-sm text-slate-500">Loading…</p>}
        {entries?.length === 0 && <p className="p-5 text-sm text-slate-500">Nothing recorded yet.</p>}
        <ul className="divide-y divide-slate-100">
          {entries?.map((e) => (
            <li key={e.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TONES[e.action] ?? 'neutral'}>{actionLabel(e.action)}</Badge>
                  {e.tenant_id && e.tenant_subdomain && (
                    <Link
                      to={`/tenants/${e.tenant_id}`}
                      className="text-sm font-medium text-slate-900 hover:underline"
                    >
                      {e.tenant_subdomain}
                    </Link>
                  )}
                </div>
                {auditDetail(e) && <p className="mt-1 text-sm text-slate-600">{auditDetail(e)}</p>}
              </div>
              <div className="text-right text-xs text-slate-500">
                <p>{dateTime(e.created_at)}</p>
                <p>
                  {e.admin_email ?? 'API token'}
                  {e.ip ? ` · ${e.ip}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </Page>
  );
}
