// Admin Settings → Waivers. Read-only roster of waiver signatures:
// who signed, member vs walk-in, which version, and when. The
// "current version only" filter (default on) answers the operational
// question — "who is covered right now?" — while toggling it off
// shows the full append-only history.
//
// Waiver config (required toggle + text) lives on the Policies tab;
// editing the text there bumps the version and empties this list's
// current-version view until people re-sign.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import SettingsNav from '../components/SettingsNav.jsx';
import { formatSlotLocal } from '../format.js';
import { Badge, Card, Page, PageHeader } from '../components/ui/index.js';

export default function AdminWaivers() {
  const { me } = useAuth();
  const tz = me.tenant.timezone;

  const [currentOnly, setCurrentOnly] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api(`/api/admin/waiver-signatures?current_only=${currentOnly}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
      })
      .then((body) => {
        if (alive) setData(body);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [currentOnly]);

  return (
    <Page width="default">
      <PageHeader
        title="Settings"
        description="Who has signed the liability waiver."
      />
      <SettingsNav />

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-600">
            {data ? (
              data.waiver.required ? (
                <>
                  Waiver is <span className="font-medium">required</span> ·
                  current version{' '}
                  <span className="font-medium">{data.waiver.version}</span>
                </>
              ) : (
                <>
                  Waiver is not currently required — enable it under{' '}
                  <Link
                    to="/admin/settings/policies"
                    className="font-medium text-brand-600 hover:text-brand-700"
                  >
                    Policies
                  </Link>
                  .
                </>
              )
            ) : (
              'loading…'
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={currentOnly}
              onChange={(e) => setCurrentOnly(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            Current version only
          </label>
        </div>

        {data && data.signatures.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
            {currentOnly
              ? 'No one has signed the current waiver version yet.'
              : 'No waiver signatures yet.'}
          </div>
        ) : data ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4">Signer</th>
                  <th className="py-2 pr-4">Who</th>
                  <th className="py-2 pr-4">Version</th>
                  <th className="py-2">Signed</th>
                </tr>
              </thead>
              <tbody>
                {data.signatures.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-slate-100 last:border-0"
                  >
                    <td className="py-2.5 pr-4">
                      <div className="font-medium text-slate-900">
                        {s.signer_name}
                        {s.is_minor && (
                          <Badge tone="warning" className="ml-2">
                            minor
                          </Badge>
                        )}
                      </div>
                      {s.guardian_name && (
                        <div className="text-xs text-slate-500">
                          guardian: {s.guardian_name}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      {s.member_id ? (
                        <>
                          <Badge tone="brand">member</Badge>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {s.member_first_name} {s.member_last_name}
                            {s.member_email ? ` · ${s.member_email}` : ''}
                          </div>
                        </>
                      ) : (
                        <>
                          <Badge tone="neutral">walk-in</Badge>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {s.customer_email}
                          </div>
                        </>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      {data.waiver.version === s.waiver_version ? (
                        <Badge tone="success">v{s.waiver_version}</Badge>
                      ) : (
                        <Badge tone="neutral">v{s.waiver_version}</Badge>
                      )}
                    </td>
                    <td className="py-2.5 text-slate-600">
                      {formatSlotLocal(s.signed_at, tz)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-slate-400">loading…</p>
        )}
      </Card>
    </Page>
  );
}
