// Phase 0 frontend: fetch /api/tenant and render whatever comes back.
// Proves the full chain: browser → Vite proxy → Express → resolveTenant
// → tenant_lookup view → app_runtime privilege grant.
//
// In dev, hit this page via http://momentum.localhost:5173 to exercise
// the real subdomain resolver. http://localhost:5173?tenant=momentum is
// the fallback.

import { useEffect, useState } from 'react';

export default function App() {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    // Same-origin relative URL — Vite proxies /api/* to Express in dev,
    // and in prod the same Express process serves both the bundle and
    // the API, so this works in both modes.
    const url = '/api/tenant' + window.location.search;
    fetch(url)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          setState({ status: 'ok', tenant: body });
        } else {
          setState({ status: 'error', code: res.status, body });
        }
      })
      .catch((err) => {
        setState({ status: 'error', code: 0, body: { error: err.message } });
      });
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-900 p-6">
      {state.status === 'loading' && (
        <div className="text-slate-400">loading…</div>
      )}

      {state.status === 'ok' && (
        <div className="text-center">
          <h1 className="text-3xl font-semibold">Hello, {state.tenant.name}</h1>
          <dl className="mt-6 text-sm text-slate-500 space-y-1">
            <Row label="subdomain" value={state.tenant.subdomain} />
            <Row label="timezone" value={state.tenant.timezone} />
            <Row label="id" value={state.tenant.id} mono />
          </dl>
        </div>
      )}

      {state.status === 'error' && (
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold text-rose-700">
            tenant resolution failed
          </h1>
          <p className="mt-2 text-slate-700">
            HTTP {state.code || '—'}: {state.body?.error || 'unknown error'}
          </p>
          <p className="mt-6 text-sm text-slate-400">
            Open the page via{' '}
            <code className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-700">
              {'{tenant}.localhost:5173'}
            </code>{' '}
            or fall back to{' '}
            <code className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-700">
              localhost:5173?tenant={'{name}'}
            </code>
            .
          </p>
        </div>
      )}
    </main>
  );
}

function Row({ label, value, mono = false }) {
  return (
    <div>
      <dt className="inline text-slate-400">{label}:</dt>{' '}
      <dd
        className={`inline ${mono ? 'font-mono text-xs' : 'font-mono'} text-slate-700`}
      >
        {value}
      </dd>
    </div>
  );
}
