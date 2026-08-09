// Admin member management — list + add-member form (people-flows
// slice). Row "View" links to the member detail page
// (/admin/members/:id) for profile, subscription, credits + ledger.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Page,
  PageHeader,
} from '../components/ui/index.js';
import { formatDate } from '../format.js';

export default function AdminMembers() {
  const { me } = useAuth();
  const [members, setMembers] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoadError(null);
    try {
      const res = await api('/api/admin/members');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setMembers(body.members ?? []);
    } catch (err) {
      setLoadError(err.message);
    }
  }

  function memberAdded(member) {
    setAdding(false);
    setNotice(`Added ${member.first_name} ${member.last_name}. A welcome email is on its way to ${member.email}.`);
    load();
  }

  return (
    <Page width="default">
      <PageHeader
        title="Members"
        description="Everyone with a membership at your facility."
        actions={
          <Button onClick={() => setAdding(true)}>Add member</Button>
        }
      />

      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <Card padded={false}>
        {loadError && (
          <div className="border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {loadError}
          </div>
        )}
        {members === null ? (
          <p className="px-5 py-4 text-sm text-slate-400">loading…</p>
        ) : members.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">
            No members yet. Add one, or share your signup page.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Login</th>
                  <th className="px-4 py-3">Credits</th>
                  <th className="px-4 py-3">Joined</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {members.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {m.first_name} {m.last_name}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{m.email}</td>
                    <td className="px-4 py-3">
                      <Badge
                        tone={
                          m.login_active
                            ? 'success'
                            : m.user_id
                            ? 'warning'
                            : 'neutral'
                        }
                      >
                        {m.login_active
                          ? 'has login'
                          : m.user_id
                          ? 'invite sent'
                          : 'no login'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{m.current_credits ?? 0}</td>
                    <td className="px-4 py-3">
                      {formatDate(m.created_at, me.tenant.timezone)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        as={Link}
                        to={`/admin/members/${m.id}`}
                        size="sm"
                        variant="secondary"
                      >
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {adding && (
        <AddMemberModal
          onClose={() => setAdding(false)}
          onAdded={memberAdded}
        />
      )}
    </Page>
  );
}

function AddMemberModal({ onClose, onAdded }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/admin/members', {
        method: 'POST',
        body: JSON.stringify({
          email,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onAdded(body.member);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/30"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative w-full max-w-lg rounded-lg bg-white shadow-xl border border-slate-200 p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-slate-900">Add member</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          The member gets a welcome email with a link to set their
          password, so they can sign in to book sessions and manage
          their own account.
        </p>
        <form onSubmit={submit}>
          <div className="space-y-4">
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
          </div>
          {error && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}
          <div className="mt-6 flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add member'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
