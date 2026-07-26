// Reset/set password — consumes the token link from the
// password-reset email (/reset?token=...) and from staff invites
// (/reset?token=...&invite=1, which only changes the copy: an invitee
// is SETTING a password, not resetting one).
//
// The route path must stay /reset — it's baked into sent emails
// (src/services/email.js tenantUrl(subdomain, '/reset?token=…')).

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Button, Card, Field, Input } from '../components/ui/index.js';

export default function ResetPasswordPage() {
  const { tenant } = useAuth();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const isInvite = searchParams.get('invite') === '1';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  const title = isInvite ? 'Set your password' : 'Reset your password';

  async function submit(e) {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, new_password: password }),
      });
      if (res.ok) {
        setDone(true);
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
          <h1 className="mt-3 text-2xl font-semibold text-slate-900">{title}</h1>
          {isInvite && (
            <p className="mt-1 text-center text-sm text-slate-500">
              Choose a password to activate your {tenant?.name} account.
            </p>
          )}
        </div>
        <Card className="mt-6">
          {!token ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                This link is missing its token. Open the link from your
                email again, or request a new one.
              </div>
              <Button as={Link} to="/forgot" variant="secondary" className="w-full">
                Request a new link
              </Button>
            </div>
          ) : done ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                Your password has been {isInvite ? 'set' : 'reset'}. You can
                sign in now.
              </div>
              <Button as={Link} to="/login" className="w-full">
                Go to sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <Field label="New password" hint="At least 8 characters.">
                <Input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field label="Confirm new password">
                <Input
                  type="password"
                  required
                  minLength={8}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </Field>
              {error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {error}
                  {/invalid or expired/i.test(error) && (
                    <>
                      {' '}
                      <Link
                        to="/forgot"
                        className="font-medium text-rose-800 underline"
                      >
                        Request a new link
                      </Link>
                    </>
                  )}
                </div>
              )}
              <Button type="submit" disabled={busy} className="w-full">
                {busy
                  ? 'saving…'
                  : isInvite
                    ? 'Set password'
                    : 'Reset password'}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
