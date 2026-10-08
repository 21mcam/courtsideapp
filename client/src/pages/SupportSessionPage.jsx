// /support-session#token=… — landing page for the platform console's
// "View as owner". Trades the 60-second handoff in the URL fragment for
// a read-only session (POST /api/auth/support-session), then drops
// into the normal admin home. The fragment is scrubbed from the
// address bar before anything else so it doesn't linger in history.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

export default function SupportSessionPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    // StrictMode double-invokes effects in dev; the handoff is
    // one-shot, so only ever send it once.
    if (started.current) return;
    started.current = true;

    const params = new URLSearchParams(window.location.hash.slice(1));
    const handoff = params.get('token');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);

    if (!handoff) {
      setError('This link is missing its access token.');
      return;
    }

    (async () => {
      try {
        const res = await api('/api/auth/support-session', {
          method: 'POST',
          body: JSON.stringify({ token: handoff }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(body.error || 'Could not open this session.');
          return;
        }
        await login(body.token);
        navigate('/', { replace: true });
      } catch {
        setError('Could not reach the server.');
      }
    })();
  }, [login, navigate]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="max-w-sm text-center text-sm">
        {error ? (
          <>
            <p className="font-medium text-slate-900">{error}</p>
            <p className="mt-2 text-slate-500">
              Links expire after a minute. Go back to the platform console and click
              “View as owner” again.
            </p>
          </>
        ) : (
          <p className="text-slate-500">Opening read-only view…</p>
        )}
      </div>
    </main>
  );
}
