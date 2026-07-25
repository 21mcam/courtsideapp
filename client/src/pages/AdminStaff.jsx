// Staff management — admin roster (GET /api/admin/admins) + invite
// form (POST /api/admin/admins, people-flows slice).
//
// Invites reuse the "one user, many roles" model: inviting an
// existing member's email attaches the staff role to their login;
// a brand-new email gets a set-password link.

import { useEffect, useState } from 'react';
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

export default function AdminStaff() {
  const { me } = useAuth();
  const [admins, setAdmins] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoadError(null);
    try {
      const res = await api('/api/admin/admins');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setAdmins(body.admins ?? []);
    } catch (err) {
      setLoadError(err.message);
    }
  }

  function invited({ admin, existing_user }) {
    setInviting(false);
    setNotice(
      existing_user
        ? `${admin.email} already had an account here — staff access attached. We've emailed them a sign-in link.`
        : `Invite sent to ${admin.email} with a link to set their password.`,
    );
    load();
  }

  return (
    <Page width="default">
      <PageHeader
        title="Staff"
        description="People who can manage bookings, members, and settings."
        actions={<Button onClick={() => setInviting(true)}>Invite staff</Button>}
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
        {admins === null ? (
          <p className="px-5 py-4 text-sm text-slate-400">loading…</p>
        ) : admins.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">
            No staff yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Added</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {admins.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {a.first_name} {a.last_name}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{a.email}</td>
                    <td className="px-4 py-3">
                      <Badge tone={a.role === 'owner' ? 'brand' : 'neutral'}>
                        {a.role}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {formatDate(a.created_at, me.tenant.timezone)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {inviting && (
        <InviteStaffModal
          onClose={() => setInviting(false)}
          onInvited={invited}
        />
      )}
    </Page>
  );
}

function InviteStaffModal({ onClose, onInvited }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/admin/admins', {
        method: 'POST',
        body: JSON.stringify({
          email,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onInvited(body);
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
          <h2 className="text-lg font-semibold text-slate-900">Invite staff</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          They&apos;ll get an email with a link to set a password. If they
          already have an account here (e.g. as a member), staff access is
          added to the same login.
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
              {busy ? 'Sending…' : 'Send invite'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
