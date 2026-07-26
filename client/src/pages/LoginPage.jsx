// Single login form for both members and admins. Server-side
// detects the role and the token reflects it; on submit we just
// hand the token to AuthProvider.login().

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Button, Card, Field, Input } from '../components/ui/index.js';

export default function LoginPage() {
  const { tenant, login } = useAuth();
  const navigate = useNavigate();
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
        await login(body.token);
        navigate('/');
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
    <main className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-xl font-semibold text-white">
            {tenant?.name?.charAt(0).toUpperCase() ?? '·'}
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-slate-900">
            {tenant?.name}
          </h1>
          <p className="mt-1 text-sm text-slate-500">Sign in to continue</p>
        </div>
        <Card className="mt-6">
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email">
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {error}
              </div>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'signing in…' : 'Sign in'}
            </Button>
            <p className="text-center text-sm">
              <Link
                to="/forgot"
                className="text-brand-600 hover:text-brand-700 font-medium"
              >
                Forgot your password?
              </Link>
            </p>
          </form>
        </Card>
        <p className="mt-6 text-center text-sm text-slate-500">
          New here?{' '}
          <Link
            to="/register"
            className="text-brand-600 hover:text-brand-700 font-medium"
          >
            Create an account
          </Link>
        </p>
        <p className="mt-2 text-center text-sm text-slate-500">
          Just visiting?{' '}
          <Link
            to="/walk-in"
            className="text-brand-600 hover:text-brand-700 font-medium"
          >
            Book a session without an account
          </Link>
        </p>
      </div>
    </main>
  );
}
