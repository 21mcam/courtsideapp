// Forgot-password: email entry → POST /api/auth/forgot-password.
//
// The backend always answers 200 whether or not the email exists
// (anti-enumeration), so the success state here is deliberately
// generic — "if an account exists, a link is on its way."

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Button, Card, Field, Input } from '../components/ui/index.js';

export default function ForgotPasswordPage() {
  const { tenant } = useAuth();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setSent(true);
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `request failed (HTTP ${res.status})`);
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
            Forgot your password?
          </h1>
          <p className="mt-1 text-center text-sm text-slate-500">
            Enter your email and we&apos;ll send you a reset link.
          </p>
        </div>
        <Card className="mt-6">
          {sent ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                If an account exists for <strong>{email}</strong>, a
                password-reset link is on its way. The link expires in 1
                hour.
              </div>
              <Button as={Link} to="/login" variant="secondary" className="w-full">
                Back to sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <Field label="Email">
                <Input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              {error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {error}
                </div>
              )}
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? 'sending…' : 'Send reset link'}
              </Button>
            </form>
          )}
        </Card>
        {!sent && (
          <p className="mt-6 text-center text-sm text-slate-500">
            Remembered it?{' '}
            <Link
              to="/login"
              className="text-brand-600 hover:text-brand-700 font-medium"
            >
              Sign in
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
