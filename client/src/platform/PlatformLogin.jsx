import { useState } from 'react';
import { Shield } from 'lucide-react';

import { Button, Field, Input } from '../components/ui/index.js';

export default function PlatformLogin({ onSignedIn, expired }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState(expired ? 'Your session ended. Sign in again.' : '');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/platform/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, code: code.replace(/\s/g, '') }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          res.status === 429
            ? 'Too many attempts. Wait a few minutes and try again.'
            : res.status === 401
              ? 'That email, password, or code is not right.'
              : body.error || 'Sign-in failed.',
        );
        setCode('');
        return;
      }
      await onSignedIn(body.token);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl bg-white p-6 shadow-xl"
      >
        <div className="flex items-center gap-2">
          <Shield size={20} className="text-emerald-600" />
          <h1 className="text-lg font-semibold text-slate-900">Courtside Platform</h1>
        </div>
        <Field label="Email">
          <Input
            type="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Authenticator code" hint="The 6-digit code from your authenticator app.">
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </main>
  );
}
