// Admin home — tenant card, members, admins, plus a "Setup wizard"
// link. Phase 2 slice 5 added the wizard entry point; future slices
// will add inline catalog management here.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

export default function AdminHome() {
  const { me } = useAuth();
  const [members, setMembers] = useState(null);
  const [admins, setAdmins] = useState(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    Promise.all([
      api('/api/admin/members').then(handle),
      api('/api/admin/admins').then(handle),
    ])
      .then(([m, a]) => {
        setMembers(m.members ?? []);
        setAdmins(a.admins ?? []);
      })
      .catch((err) => setLoadError(err.message));
  }, []);

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-4xl mx-auto p-6 space-y-8">
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

        <TenantCard tenant={me.tenant} />
        <ListSection
          title="Members"
          rows={members}
          error={loadError}
          empty="No members yet."
          columns={[
            { key: 'name', label: 'Name', render: (r) => `${r.first_name} ${r.last_name}` },
            { key: 'email', label: 'Email', mono: true, render: (r) => r.email },
            { key: 'credits', label: 'Credits', render: (r) => r.current_credits ?? 0 },
            {
              key: 'created_at',
              label: 'Joined',
              render: (r) => new Date(r.created_at).toLocaleDateString(),
            },
          ]}
        />
        <ListSection
          title="Admins"
          rows={admins}
          error={loadError}
          empty="No admins yet."
          columns={[
            { key: 'name', label: 'Name', render: (r) => `${r.first_name} ${r.last_name}` },
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
        <table className="mt-3 w-full text-sm">
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
              <tr key={r.id} className="border-b border-slate-100">
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`py-2 ${c.mono ? 'font-mono text-xs' : ''}`}
                  >
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
