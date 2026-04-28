// Single login form for both members and admins. Server-side
// detects the role and the token reflects it; on submit we just
// hand the token to AuthProvider.login().

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

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
    <main className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-900 p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-semibold text-center">{tenant?.name}</h1>
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
