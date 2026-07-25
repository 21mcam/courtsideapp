// Admin Settings → Blackouts. Time ranges when something is NOT
// bookable — the whole facility (both targets null), one resource,
// or one offering (schema's three shapes).
//
// Datetime inputs are wall-clock values interpreted in the TENANT's
// timezone via zonedTimeToUtc (blackouts are timestamptz — absolute
// moments), matching AdminClasses' one-off instance form. Labels say
// so explicitly.

import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatSlotLocal } from '../format.js';
import { zonedTimeToUtc } from '../lib/tz.js';
import SettingsNav from '../components/SettingsNav.jsx';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Page,
  PageHeader,
  Select,
} from '../components/ui/index.js';

const SCOPES = [
  { value: 'facility', label: 'Whole facility' },
  { value: 'resource', label: 'One resource' },
  { value: 'offering', label: 'One offering' },
];

export default function AdminBlackouts() {
  const { tenant } = useAuth();
  const tz = tenant.timezone;
  const [blackouts, setBlackouts] = useState(null);
  const [resources, setResources] = useState([]);
  const [offerings, setOfferings] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const [bRes, rRes, oRes] = await Promise.all([
        api('/api/admin/blackouts'),
        api('/api/admin/resources'),
        api('/api/admin/offerings'),
      ]);
      for (const res of [bRes, rRes, oRes]) {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
      }
      setBlackouts((await bRes.json()).blackouts);
      setResources((await rRes.json()).resources);
      setOfferings((await oRes.json()).offerings);
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(id) {
    if (deletingId) return;
    setDeletingId(id);
    setNotice(null);
    try {
      const res = await api(`/api/admin/blackouts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setBlackouts((prev) => prev.filter((b) => b.id !== id));
    } catch (err) {
      setNotice({ tone: 'error', text: `Couldn't delete blackout: ${err.message}` });
    } finally {
      setDeletingId(null);
    }
  }

  const now = Date.now();
  const upcoming = (blackouts ?? []).filter(
    (b) => new Date(b.ends_at).getTime() >= now,
  );
  const past = (blackouts ?? [])
    .filter((b) => new Date(b.ends_at).getTime() < now)
    .reverse(); // most recently ended first

  return (
    <Page width="narrow">
      <PageHeader
        title="Settings"
        description="Block out times when booking is closed."
      />
      <SettingsNav />

      {loadError && <ErrorBanner message={loadError} />}
      {notice && <ErrorBanner message={notice.text} />}

      <CreateBlackoutCard
        tz={tz}
        resources={resources}
        offerings={offerings}
        onCreated={(b) => {
          setBlackouts((prev) => [...(prev ?? []), b]);
        }}
      />

      <Card title="Upcoming blackouts">
        <BlackoutList
          rows={upcoming}
          emptyText="No upcoming blackouts."
          tz={tz}
          resources={resources}
          offerings={offerings}
          onDelete={remove}
          deletingId={deletingId}
          loading={blackouts === null && !loadError}
        />
      </Card>

      {past.length > 0 && (
        <Card title="Past blackouts">
          <BlackoutList
            rows={past}
            emptyText=""
            tz={tz}
            resources={resources}
            offerings={offerings}
            onDelete={remove}
            deletingId={deletingId}
          />
        </Card>
      )}
    </Page>
  );
}

function targetBadge(blackout, resources, offerings) {
  if (blackout.resource_id) {
    const name =
      resources.find((r) => r.id === blackout.resource_id)?.name ?? 'resource';
    return <Badge tone="info">{name}</Badge>;
  }
  if (blackout.offering_id) {
    const name =
      offerings.find((o) => o.id === blackout.offering_id)?.name ?? 'offering';
    return <Badge tone="warning">{name}</Badge>;
  }
  return <Badge tone="brand">Whole facility</Badge>;
}

function BlackoutList({
  rows,
  emptyText,
  tz,
  resources,
  offerings,
  onDelete,
  deletingId,
  loading,
}) {
  if (loading) {
    return (
      <div className="py-6 text-center text-sm text-slate-400">loading…</div>
    );
  }
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">{emptyText}</p>;
  }
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((b) => (
        <li key={b.id} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-900">
              {targetBadge(b, resources, offerings)}
              <span>
                {formatSlotLocal(b.starts_at, tz)} →{' '}
                {formatSlotLocal(b.ends_at, tz)}
              </span>
            </div>
            {b.reason && (
              <div className="mt-0.5 truncate text-xs text-slate-500">
                {b.reason}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onDelete(b.id)}
            disabled={deletingId === b.id}
            aria-label="Delete blackout"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-rose-600 disabled:opacity-50"
          >
            <Trash2 size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function CreateBlackoutCard({ tz, resources, offerings, onCreated }) {
  const [scope, setScope] = useState('facility');
  const [resourceId, setResourceId] = useState('');
  const [offeringId, setOfferingId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // datetime-local gives a bare "YYYY-MM-DDTHH:MM" wall-clock
      // string — interpret it in the tenant's timezone, never the
      // browser's.
      const iso = (v) =>
        zonedTimeToUtc(v.slice(0, 10), v.slice(11, 16), tz).toISOString();
      const payload = {
        starts_at: iso(startsAt),
        ends_at: iso(endsAt),
        reason: reason.trim() || undefined,
      };
      if (scope === 'resource') payload.resource_id = resourceId;
      if (scope === 'offering') payload.offering_id = offeringId;

      const res = await api('/api/admin/blackouts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onCreated(body.blackout);
      setStartsAt('');
      setEndsAt('');
      setReason('');
      setSaved(true);
    } catch (err) {
      setError(`Couldn't create blackout: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="New blackout">
      <p className="mb-4 text-sm text-slate-500">
        Nothing can be booked inside a blackout window. Existing
        bookings are not cancelled automatically.
      </p>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Applies to">
            <Select value={scope} onChange={(e) => setScope(e.target.value)}>
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          {scope === 'resource' && (
            <Field label="Resource">
              <Select
                required
                value={resourceId}
                onChange={(e) => setResourceId(e.target.value)}
              >
                <option value="">— pick a resource —</option>
                {resources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {scope === 'offering' && (
            <Field label="Offering">
              <Select
                required
                value={offeringId}
                onChange={(e) => setOfferingId(e.target.value)}
              >
                <option value="">— pick an offering —</option>
                {offerings.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`Starts (${tz})`}>
            <Input
              required
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </Field>
          <Field label={`Ends (${tz})`}>
            <Input
              required
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Reason" hint="Optional — shown only to admins.">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Holiday closure, cage maintenance…"
          />
        </Field>
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="text-xs text-emerald-600">Created.</span>}
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create blackout'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ErrorBanner({ message }) {
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      {message}
    </div>
  );
}
