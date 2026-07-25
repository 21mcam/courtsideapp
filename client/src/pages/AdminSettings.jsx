// Admin settings: appearance (tenant accent color) + facility info.
// The accent applies live on click, then persists via PUT
// /api/admin/theme (which needs migration 019 on the live DB).

import { useState } from 'react';
import { Check } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ACCENTS, DEFAULT_ACCENT } from '../theme.js';
import SettingsNav from '../components/SettingsNav.jsx';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Page,
  PageHeader,
} from '../components/ui/index.js';

export default function AdminSettings() {
  const { tenant, updateTenant } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [replyTo, setReplyTo] = useState(tenant.reply_to_email || '');
  const [replyToSaving, setReplyToSaving] = useState(false);
  const [replyToError, setReplyToError] = useState(null);
  const [replyToSaved, setReplyToSaved] = useState(false);

  const current = tenant.theme_accent || DEFAULT_ACCENT;

  async function saveReplyTo(e) {
    e.preventDefault();
    if (replyToSaving) return;
    setReplyToSaving(true);
    setReplyToError(null);
    setReplyToSaved(false);
    try {
      const res = await api('/api/admin/reply-to-email', {
        method: 'PUT',
        body: JSON.stringify({ reply_to_email: replyTo.trim() || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = await res.json();
      updateTenant({ reply_to_email: body.reply_to_email });
      setReplyTo(body.reply_to_email || '');
      setReplyToSaved(true);
    } catch (err) {
      setReplyToError(`Couldn't save reply-to address: ${err.message}`);
    } finally {
      setReplyToSaving(false);
    }
  }

  async function pickAccent(key) {
    if (key === current || saving) return;
    setSaving(true);
    setError(null);
    const previous = current;
    updateTenant({ theme_accent: key }); // live preview
    try {
      const res = await api('/api/admin/theme', {
        method: 'PUT',
        body: JSON.stringify({ accent: key }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      updateTenant({ theme_accent: previous }); // roll back preview
      setError(`Couldn't save accent color: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page width="narrow">
      <PageHeader
        title="Settings"
        description="Appearance and facility details."
      />
      <SettingsNav />

      <Card title="Appearance">
        <p className="mb-4 text-sm text-slate-500">
          Accent color for buttons, links, and your public booking page.
        </p>
        {error && (
          <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          {Object.entries(ACCENTS).map(([key, accent]) => {
            const selected = key === current;
            return (
              <button
                key={key}
                onClick={() => pickAccent(key)}
                disabled={saving}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  selected
                    ? 'border-brand-600 bg-brand-50 text-brand-700'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span
                  className="flex h-5 w-5 items-center justify-center rounded-full"
                  style={{ backgroundColor: accent.swatch }}
                >
                  {selected && <Check size={12} className="text-white" />}
                </span>
                {accent.label}
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="Facility">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-slate-500">Name</dt>
          <dd className="font-medium">{tenant.name}</dd>
          <dt className="text-slate-500">Subdomain</dt>
          <dd>
            <Badge tone="brand">{tenant.subdomain}</Badge>
          </dd>
          <dt className="text-slate-500">Timezone</dt>
          <dd className="font-mono text-xs">{tenant.timezone}</dd>
          <dt className="text-slate-500">ID</dt>
          <dd className="font-mono text-xs text-slate-500">{tenant.id}</dd>
        </dl>
      </Card>

      <Card title="Email">
        <p className="mb-4 text-sm text-slate-500">
          Replies to booking confirmations and other system emails go to
          this address. Leave blank for no reply-to.
        </p>
        {replyToError && (
          <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {replyToError}
          </div>
        )}
        <form onSubmit={saveReplyTo} className="flex items-end gap-3">
          <Field label="Reply-to address" className="grow">
            <Input
              type="email"
              placeholder="frontdesk@yourfacility.com"
              value={replyTo}
              onChange={(e) => {
                setReplyTo(e.target.value);
                setReplyToSaved(false);
              }}
            />
          </Field>
          <Button type="submit" disabled={replyToSaving}>
            {replyToSaving ? 'Saving…' : 'Save'}
          </Button>
        </form>
        {replyToSaved && (
          <p className="mt-2 text-xs text-emerald-600">Saved.</p>
        )}
      </Card>
    </Page>
  );
}
