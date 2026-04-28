// Phase 1 slice 4: login + role-aware home.
//
// Auth state lives in this top-level component. Token in localStorage
// (see api.js note on lifecycle). Conditional rendering on auth state
// + role; no router yet — when we have more pages this will graduate
// to react-router.

import { useEffect, useState } from 'react';
import { api, setToken, clearToken } from './api.js';

export default function App() {
  const [tenant, setTenant] = useState(null);
  const [tenantError, setTenantError] = useState(null);
  const [me, setMe] = useState(null);
  const [bootingMe, setBootingMe] = useState(true);

  useEffect(() => {
    api('/api/tenant')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (res.ok) setTenant(body);
        else setTenantError({ status: res.status, body });
      })
      .catch((err) =>
        setTenantError({ status: 0, body: { error: err.message } }),
      );
  }, []);

  useEffect(() => {
    void refreshMe();
  }, []);

  async function refreshMe() {
    setBootingMe(true);
    try {
      const res = await api('/api/me');
      if (res.ok) {
        setMe(await res.json());
      } else {
        // 401 (no token) or 401/403 (stale token) — treat as logged out.
        clearToken();
        setMe(null);
      }
    } catch {
      clearToken();
      setMe(null);
    } finally {
      setBootingMe(false);
    }
  }

  function handleLogin(token) {
    setToken(token);
    void refreshMe();
  }

  function handleLogout() {
    clearToken();
    setMe(null);
  }

  if (tenantError) {
    return <ErrorView status={tenantError.status} body={tenantError.body} />;
  }
  if (!tenant || bootingMe) {
    return <Loading />;
  }
  if (!me) {
    return <LoginPage tenant={tenant} onLogin={handleLogin} />;
  }
  if (me.memberships.admin) {
    return <AdminHome me={me} onLogout={handleLogout} />;
  }
  return <MemberHome me={me} onLogout={handleLogout} />;
}

function Loading() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-slate-400">loading…</div>
    </main>
  );
}

function ErrorView({ status, body }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-900 p-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold text-rose-700">
          tenant resolution failed
        </h1>
        <p className="mt-2 text-slate-700">
          HTTP {status || '—'}: {body?.error || 'unknown error'}
        </p>
        <p className="mt-6 text-sm text-slate-400">
          Open via{' '}
          <code className="rounded bg-slate-200 px-1.5 py-0.5">
            {'{tenant}.localhost:5173'}
          </code>{' '}
          or{' '}
          <code className="rounded bg-slate-200 px-1.5 py-0.5">
            localhost:5173?tenant={'{name}'}
          </code>
          .
        </p>
      </div>
    </main>
  );
}

function LoginPage({ tenant, onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.token) {
        onLogin(body.token);
      } else {
        setError(body.error || `login failed (HTTP ${res.status})`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-900 p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-semibold text-center">{tenant.name}</h1>
        <p className="mt-1 text-center text-sm text-slate-500">
          Sign in to continue
        </p>
        <form onSubmit={submit} className="mt-8 space-y-4">
          <Field label="Email" type="email" value={email} onChange={setEmail} />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
          />
          {error && <p className="text-sm text-rose-700">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-slate-900 text-white py-2 hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? 'signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}

function Field({ label, type, value, onChange }) {
  return (
    <div>
      <label className="block text-sm text-slate-600 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className="w-full rounded border border-slate-300 px-3 py-2 outline-none focus:border-slate-500"
      />
    </div>
  );
}

function Header({ me, onLogout }) {
  return (
    <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
      <div className="font-semibold">{me.tenant.name}</div>
      <div className="flex items-center gap-3 text-sm text-slate-600">
        <span>
          {me.memberships.admin
            ? `${me.memberships.admin.role}: ${me.user.first_name}`
            : `Member: ${me.user.first_name}`}
        </span>
        <button
          onClick={onLogout}
          className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

function MemberHome({ me, onLogout }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <Header me={me} onLogout={onLogout} />
      <main className="max-w-2xl mx-auto p-6">
        <h2 className="text-xl font-semibold">
          Welcome, {me.user.first_name}
        </h2>
        <p className="mt-2 text-slate-600">
          You're signed in to {me.tenant.name} as a member. Booking + credits
          ship in upcoming phases.
        </p>
      </main>
    </div>
  );
}

function AdminHome({ me, onLogout }) {
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
      <Header me={me} onLogout={onLogout} />
      <main className="max-w-4xl mx-auto p-6 space-y-8">
        <TenantCard tenant={me.tenant} />
        <ListSection
          title="Members"
          rows={members}
          error={loadError}
          empty="No members yet."
          columns={[
            { key: 'name', label: 'Name', render: (r) => `${r.first_name} ${r.last_name}` },
            { key: 'email', label: 'Email', mono: true, render: (r) => r.email },
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
        {title} {rows !== null && <span className="text-slate-400 text-base">({rows.length})</span>}
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
