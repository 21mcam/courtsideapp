// /account — the signed-in person's own login: name/phone, password,
// and (members) where their credits came from and went.
//
// Members AND staff use it (staff just don't get phone or credit
// history — those live on the member record). Bookings and the
// subscription stay on the member Home; this page doesn't repeat them.
// Email change is intentionally absent until there's a verify-the-new-
// address flow; the copy points people to the facility instead.

import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { memberCreditLabel } from '../format.js';
import { Button, Card, Field, Input, Page, PageHeader } from '../components/ui/index.js';

export default function AccountPage() {
  const { me } = useAuth();
  const isMember = Boolean(me.memberships.member);
  return (
    <Page width="narrow">
      <PageHeader title="Account" description={`Your login for ${me.tenant.name}.`} />
      <ProfileCard />
      <PasswordCard />
      {isMember && <CreditsCard />}
    </Page>
  );
}

function errorText(body, fallback) {
  const fields = body?.details?.fieldErrors;
  const first = fields && Object.values(fields)[0]?.[0];
  return first || body?.error || fallback;
}

function ProfileCard() {
  const { me, refresh } = useAuth();
  const isMember = Boolean(me.memberships.member);
  const [form, setForm] = useState({
    first_name: me.user.first_name ?? '',
    last_name: me.user.last_name ?? '',
    phone: me.memberships.member?.phone ?? '',
  });
  const [status, setStatus] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const body = { first_name: form.first_name, last_name: form.last_name };
      if (isMember) body.phone = form.phone;
      const res = await api('/api/me/profile', { method: 'PATCH', body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ ok: false, text: errorText(out, 'Could not save.') });
        return;
      }
      await refresh();
      setStatus({ ok: true, text: 'Saved.' });
    } catch {
      setStatus({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Profile">
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name">
            <Input required value={form.first_name} onChange={set('first_name')} autoComplete="given-name" />
          </Field>
          <Field label="Last name">
            <Input required value={form.last_name} onChange={set('last_name')} autoComplete="family-name" />
          </Field>
        </div>
        {isMember && (
          <Field label="Mobile phone">
            <Input type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" />
          </Field>
        )}
        <Field
          label="Email"
          hint={`This is your sign-in. To change it, ask ${me.tenant.name}.`}
        >
          <Input value={me.user.email} disabled />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          {status && (
            <span className={`text-sm ${status.ok ? 'text-emerald-700' : 'text-rose-600'}`}>
              {status.text}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setStatus(null);
    if (form.next.length < 8) {
      setStatus({ ok: false, text: 'New password must be at least 8 characters.' });
      return;
    }
    if (form.next !== form.confirm) {
      setStatus({ ok: false, text: "New passwords don't match." });
      return;
    }
    setBusy(true);
    try {
      const res = await api('/api/me/password', {
        method: 'POST',
        body: JSON.stringify({ current_password: form.current, new_password: form.next }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const text =
          out.error === 'current password is incorrect'
            ? 'Your current password is not right.'
            : out.error === 'new password must be different'
              ? 'Pick a password you are not already using.'
              : errorText(out, 'Could not change your password.');
        setStatus({ ok: false, text });
        return;
      }
      setForm({ current: '', next: '', confirm: '' });
      setStatus({ ok: true, text: 'Password changed.' });
    } catch {
      setStatus({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Password">
      <form onSubmit={save} className="space-y-4">
        <Field label="Current password">
          <Input type="password" required value={form.current} onChange={set('current')} autoComplete="current-password" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New password" hint="At least 8 characters.">
            <Input type="password" required value={form.next} onChange={set('next')} autoComplete="new-password" />
          </Field>
          <Field label="Confirm new password">
            <Input type="password" required value={form.confirm} onChange={set('confirm')} autoComplete="new-password" />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? 'Changing…' : 'Change password'}
          </Button>
          {status && (
            <span className={`text-sm ${status.ok ? 'text-emerald-700' : 'text-rose-600'}`}>
              {status.text}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function CreditsCard() {
  const { me } = useAuth();
  const tz = me.tenant.timezone;
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (offset) => {
    setLoading(true);
    try {
      const res = await api(`/api/me/credits?offset=${offset}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setEntries((prev) => (offset === 0 ? body.entries : [...prev, ...body.entries]));
      setTotal(body.total);
    } catch {
      setError('Could not load your credit history.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(0);
  }, [load]);

  return (
    <Card
      title="Credit history"
      actions={
        me.credits && (
          <span className="text-sm text-slate-500">
            Balance <strong className="text-slate-900">{me.credits.current_credits}</strong>
          </span>
        )
      }
    >
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {total === 0 && <p className="text-sm text-slate-500">No credit activity yet.</p>}
      {entries.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start justify-between gap-4 py-2.5">
              <div className="min-w-0">
                <p className="text-sm text-slate-900">{memberCreditLabel(e, tz)}</p>
                <p className="text-xs text-slate-500">
                  {new Date(e.created_at).toLocaleDateString('en-US', {
                    timeZone: tz,
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}{' '}
                  · balance {e.balance_after}
                </p>
              </div>
              <span
                className={`shrink-0 text-sm font-semibold tabular-nums ${
                  e.amount > 0 ? 'text-emerald-700' : 'text-slate-700'
                }`}
              >
                {e.amount > 0 ? `+${e.amount}` : e.amount}
              </span>
            </li>
          ))}
        </ul>
      )}
      {total != null && entries.length < total && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          disabled={loading}
          onClick={() => load(entries.length)}
        >
          {loading ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </Card>
  );
}
