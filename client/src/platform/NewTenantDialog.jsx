// Create a facility + its owner login (replaces the old curl to
// POST /api/platform/signup-tenant). The owner gets a set-password
// email — the operator never chooses or sees their password.

import { useEffect, useState } from 'react';

import { Button, Field, Input, Select } from '../components/ui/index.js';
import { papi } from './api.js';

const TIMEZONES = [
  ['America/New_York', 'Eastern'],
  ['America/Chicago', 'Central'],
  ['America/Denver', 'Mountain'],
  ['America/Phoenix', 'Arizona'],
  ['America/Los_Angeles', 'Pacific'],
  ['America/Anchorage', 'Alaska'],
  ['Pacific/Honolulu', 'Hawaii'],
];

// "Sunset Park Baseball" → "sunset-park-baseball", trimmed to the
// subdomain CHECK's 32 chars.
function suggestSubdomain(name) {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

export default function NewTenantDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({
    name: '',
    subdomain: '',
    timezone: 'America/New_York',
    owner_first_name: '',
    owner_last_name: '',
    owner_email: '',
  });
  const [subdomainTouched, setSubdomainTouched] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (key) => (e) => {
    const value = e.target.value;
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (key === 'name' && !subdomainTouched) next.subdomain = suggestSubdomain(value);
      return next;
    });
  };

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await papi('/api/platform/signup-tenant', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const fieldErrors = body.details?.fieldErrors ?? {};
        const first = Object.entries(fieldErrors)[0];
        setError(
          res.status === 409
            ? 'That subdomain or owner email is already taken.'
            : first
              ? `${first[0].replace(/_/g, ' ')}: ${first[1][0]}`
              : body.error || 'Could not create the facility.',
        );
        return;
      }
      setCreated(body);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="New facility">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        {created ? (
          <div className="space-y-4">
            <h2 className="text-base font-semibold text-slate-900">Facility created</h2>
            <p className="text-sm text-slate-600">
              <strong>{form.name}</strong> is live at <strong>{created.subdomain}</strong>.{' '}
              {form.owner_first_name} has been emailed a link to set their password (valid 7
              days).
            </p>
            <div className="flex justify-end">
              <Button onClick={onCreated}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <h2 className="text-base font-semibold text-slate-900">New facility</h2>
            <Field label="Facility name">
              <Input required autoFocus value={form.name} onChange={set('name')} />
            </Field>
            <Field
              label="Subdomain"
              hint="Their address: subdomain + your app domain. Lowercase letters, numbers, hyphens."
            >
              <Input
                required
                pattern="[a-z0-9][a-z0-9\-]{1,30}[a-z0-9]"
                value={form.subdomain}
                onChange={(e) => {
                  setSubdomainTouched(true);
                  set('subdomain')(e);
                }}
              />
            </Field>
            <Field label="Time zone">
              <Select value={form.timezone} onChange={set('timezone')}>
                {TIMEZONES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Owner first name">
                <Input required value={form.owner_first_name} onChange={set('owner_first_name')} />
              </Field>
              <Field label="Owner last name">
                <Input required value={form.owner_last_name} onChange={set('owner_last_name')} />
              </Field>
            </div>
            <Field label="Owner email" hint="They'll get an email to set their own password.">
              <Input type="email" required value={form.owner_email} onChange={set('owner_email')} />
            </Field>
            {error && <p className="text-sm text-rose-600">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create facility'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
