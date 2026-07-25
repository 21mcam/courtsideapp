// Member self-signup. Creates users + members rows via
// POST /api/auth/register-member, which returns a token — so a
// successful signup logs straight in and lands on the member home.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Button, Card, Field, Input } from '../components/ui/index.js';

export default function RegisterPage() {
  const { tenant, login } = useAuth();
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/auth/register-member', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.token) {
        await login(body.token);
        navigate('/');
      } else {
        setError(body.error || `signup failed (HTTP ${res.status})`);
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
          <p className="mt-1 text-sm text-slate-500">Create your account</p>
        </div>
        <Card className="mt-6">
          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name">
                <Input
                  required
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                />
              </Field>
              <Field label="Last name">
                <Input
                  required
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Email">
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Phone" hint="Optional.">
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
            <Field label="Password" hint="At least 8 characters.">
              <Input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {error}
                {/already registered/i.test(error) && (
                  <>
                    {' '}
                    <Link
                      to="/login"
                      className="font-medium text-rose-800 underline"
                    >
                      Sign in instead
                    </Link>
                  </>
                )}
              </div>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'creating account…' : 'Create account'}
            </Button>
          </form>
        </Card>
        <p className="mt-6 text-center text-sm text-slate-500">
          Already have an account?{' '}
          <Link
            to="/login"
            className="text-brand-600 hover:text-brand-700 font-medium"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
