// Admin classes — Phase 4 slice 4.
//
// Three sections on one page:
//   1. Schedules — list of recurring schedules with "Generate more"
//      button to extend horizon. Inline "New schedule" form below.
//   2. Instances — calendar of upcoming class instances. Click a row
//      to expand its roster (members + customers + status). Cancel
//      instance button cascades to roster + refunds members.
//   3. (Roster) — inline expansion under each instance row, with
//      cancel + mark-no-show buttons per booking.
//
// One-off instance creation is also supported via a small form in
// the Instances section (offering, resource, start_time → POST to
// /api/admin/class-instances).

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  bookingStatusBadge,
  dayOfWeekLabel,
  formatSlotLocal,
  timeShort,
} from '../format.js';

const DOW_OPTIONS = [0, 1, 2, 3, 4, 5, 6];

export default function AdminClasses() {
  const { me } = useAuth();
  const tz = me.tenant.timezone;

  const [offerings, setOfferings] = useState(null);
  const [resources, setResources] = useState(null);
  const [schedules, setSchedules] = useState(null);
  const [instances, setInstances] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [actionMessage, setActionMessage] = useState(null);

  function load() {
    setLoadError(null);
    Promise.all([
      api('/api/admin/offerings').then(handle),
      api('/api/admin/resources').then(handle),
      api('/api/admin/class-schedules').then(handle),
      api('/api/admin/class-instances').then(handle),
    ])
      .then(([o, r, cs, ci]) => {
        setOfferings(o.offerings ?? []);
        setResources(r.resources ?? []);
        setSchedules(cs.class_schedules ?? []);
        setInstances(ci.class_instances ?? []);
      })
      .catch((err) => setLoadError(err.message));
  }

  useEffect(load, []);

  // Class offerings only (capacity > 1).
  const classOfferings = useMemo(
    () => (offerings ?? []).filter((o) => o.capacity > 1 && o.active),
    [offerings],
  );
  const activeResources = useMemo(
    () => (resources ?? []).filter((r) => r.active),
    [resources],
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-5xl mx-auto p-6 space-y-8">
        <div>
          <Link to="/" className="text-sm text-sky-700 hover:underline">
            ← Back
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">Classes</h1>
          <p className="text-sm text-slate-500">
            Times shown in {tz}. Schedules generate up to 90 days at a
            time; click "Generate more" to extend.
          </p>
        </div>

        {actionMessage && (
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">
            {actionMessage}
          </div>
        )}

        {loadError && (
          <div className="rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800">
            {loadError}
          </div>
        )}

        <SchedulesSection
          schedules={schedules}
          classOfferings={classOfferings}
          activeResources={activeResources}
          onChanged={(msg) => {
            if (msg) setActionMessage(msg);
            load();
          }}
        />

        <InstancesSection
          instances={instances}
          classOfferings={classOfferings}
          activeResources={activeResources}
          tz={tz}
          onChanged={(msg) => {
            if (msg) setActionMessage(msg);
            load();
          }}
        />
      </main>
    </div>
  );
}

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ============================================================
// Schedules section
// ============================================================

function SchedulesSection({ schedules, classOfferings, activeResources, onChanged }) {
  const [showForm, setShowForm] = useState(false);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">
          Schedules
          {schedules !== null && (
            <span className="ml-2 text-slate-400 text-sm font-normal">
              ({schedules.length})
            </span>
          )}
        </h2>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
        >
          {showForm ? 'Cancel' : 'New schedule'}
        </button>
      </div>

      {showForm && (
        <ScheduleForm
          classOfferings={classOfferings}
          activeResources={activeResources}
          onSubmitted={(msg) => {
            setShowForm(false);
            onChanged(msg);
          }}
        />
      )}

      {schedules === null ? (
        <p className="text-sm text-slate-400">loading…</p>
      ) : schedules.length === 0 ? (
        <p className="text-sm text-slate-500">
          No schedules yet. Create one above to generate recurring class
          instances.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500 border-b border-slate-200">
              <tr>
                <th className="py-2 px-3 font-medium">Offering</th>
                <th className="py-2 px-3 font-medium">Resource</th>
                <th className="py-2 px-3 font-medium">When</th>
                <th className="py-2 px-3 font-medium">Range</th>
                <th className="py-2 px-3 font-medium">Generated</th>
                <th className="py-2 px-3 font-medium">Active</th>
                <th className="py-2 px-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <ScheduleRow
                  key={s.id}
                  schedule={s}
                  onChanged={onChanged}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ScheduleRow({ schedule, onChanged }) {
  const [busy, setBusy] = useState(false);

  async function generateMore() {
    setBusy(true);
    try {
      const res = await api(
        `/api/admin/class-schedules/${schedule.id}/generate`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onChanged(
        `Generated ${body.generated} new · skipped ${body.skipped} · conflicts ${body.conflicted}.`,
      );
    } catch (err) {
      onChanged(`Generate failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 px-3">{schedule.offering_name}</td>
      <td className="py-2 px-3">{schedule.resource_name}</td>
      <td className="py-2 px-3">
        {dayOfWeekLabel(schedule.day_of_week)} {timeShort(schedule.start_time)}
      </td>
      <td className="py-2 px-3 text-xs">
        {String(schedule.start_date).slice(0, 10)} –{' '}
        {schedule.end_date
          ? String(schedule.end_date).slice(0, 10)
          : 'open-ended'}
      </td>
      <td className="py-2 px-3 text-xs">
        {schedule.generated_through
          ? String(schedule.generated_through).slice(0, 10)
          : '—'}{' '}
        <span className="text-slate-400">({schedule.active_instance_count})</span>
      </td>
      <td className="py-2 px-3">
        <span
          className={`text-xs rounded px-2 py-0.5 ${
            schedule.active
              ? 'bg-emerald-100 text-emerald-900'
              : 'bg-slate-200 text-slate-600'
          }`}
        >
          {schedule.active ? 'active' : 'inactive'}
        </span>
      </td>
      <td className="py-2 px-3">
        <button
          onClick={generateMore}
          disabled={busy}
          className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-50"
        >
          {busy ? 'generating…' : 'Generate more'}
        </button>
      </td>
    </tr>
  );
}

function ScheduleForm({ classOfferings, activeResources, onSubmitted }) {
  const [offering_id, setOfferingId] = useState('');
  const [resource_id, setResourceId] = useState('');
  const [day_of_week, setDow] = useState(2);
  const [start_time, setStartTime] = useState('18:00');
  const [start_date, setStartDate] = useState('');
  const [end_date, setEndDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const body = {
        offering_id,
        resource_id,
        day_of_week,
        start_time,
        start_date,
      };
      if (end_date) body.end_date = end_date;
      const res = await api('/api/admin/class-schedules', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const respBody = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(respBody.error || `HTTP ${res.status}`);
      onSubmitted(
        `Schedule created. Generated ${respBody.generated} initial instances.`,
      );
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded border border-slate-200 bg-white p-4 mb-4 space-y-3"
    >
      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 px-3 py-1 text-sm text-rose-800">
          {error}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Offering">
          <select
            required
            value={offering_id}
            onChange={(e) => setOfferingId(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">— pick an offering —</option>
            {classOfferings.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} · cap {o.capacity}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Resource">
          <select
            required
            value={resource_id}
            onChange={(e) => setResourceId(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">— pick a resource —</option>
            {activeResources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Day of week">
          <select
            value={day_of_week}
            onChange={(e) => setDow(Number(e.target.value))}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            {DOW_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {dayOfWeekLabel(d)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Start time (24h)">
          <input
            required
            type="time"
            value={start_time}
            onChange={(e) => setStartTime(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Field>
        <Field label="Start date (must match day of week)">
          <input
            required
            type="date"
            value={start_date}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Field>
        <Field label="End date (optional, blank = open-ended)">
          <input
            type="date"
            value={end_date}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-sky-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50"
        >
          {submitting ? 'creating…' : 'Create schedule'}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }) {
  return (
    <label className="block text-sm">
      <span className="text-slate-700">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

// ============================================================
// Instances section (with inline roster expand)
// ============================================================

function InstancesSection({ instances, classOfferings, activeResources, tz, onChanged }) {
  const [expandedId, setExpandedId] = useState(null);
  const [showForm, setShowForm] = useState(false);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">
          Instances
          {instances !== null && (
            <span className="ml-2 text-slate-400 text-sm font-normal">
              ({instances.length})
            </span>
          )}
        </h2>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
        >
          {showForm ? 'Cancel' : 'New one-off'}
        </button>
      </div>

      {showForm && (
        <OneoffForm
          classOfferings={classOfferings}
          activeResources={activeResources}
          onSubmitted={(msg) => {
            setShowForm(false);
            onChanged(msg);
          }}
        />
      )}

      {instances === null ? (
        <p className="text-sm text-slate-400">loading…</p>
      ) : instances.length === 0 ? (
        <p className="text-sm text-slate-500">No instances in the window.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500 border-b border-slate-200">
              <tr>
                <th className="py-2 px-3 font-medium">When</th>
                <th className="py-2 px-3 font-medium">Offering</th>
                <th className="py-2 px-3 font-medium">Resource</th>
                <th className="py-2 px-3 font-medium">Roster</th>
                <th className="py-2 px-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((ci) => (
                <InstanceRow
                  key={ci.id}
                  instance={ci}
                  tz={tz}
                  expanded={expandedId === ci.id}
                  onToggle={() => {
                    setExpandedId((cur) => (cur === ci.id ? null : ci.id));
                  }}
                  onChanged={onChanged}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function InstanceRow({ instance, tz, expanded, onToggle, onChanged }) {
  const [busy, setBusy] = useState(false);

  async function cancelInstance() {
    const reason = window.prompt(
      `Cancel "${instance.offering_name}" on ${formatSlotLocal(instance.start_time, tz)}?\nThis cancels the entire roster and refunds members 100%.\nOptional reason:`,
      '',
    );
    if (reason === null) return;
    setBusy(true);
    try {
      const res = await api(
        `/api/admin/class-instances/${instance.id}/cancel`,
        {
          method: 'POST',
          body: JSON.stringify({ cancellation_reason: reason || null }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onChanged(
        `Class cancelled. ${body.roster_cancelled} roster row${body.roster_cancelled === 1 ? '' : 's'} cancelled · ${body.members_refunded} member${body.members_refunded === 1 ? '' : 's'} refunded.`,
      );
    } catch (err) {
      onChanged(`Cancel failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr
        className={`border-b border-slate-100 last:border-0 ${expanded ? 'bg-slate-50' : ''}`}
      >
        <td className="py-2 px-3 whitespace-nowrap">
          {formatSlotLocal(instance.start_time, tz)}
        </td>
        <td className="py-2 px-3">{instance.offering_name}</td>
        <td className="py-2 px-3">{instance.resource_name}</td>
        <td className="py-2 px-3 tabular-nums">
          {instance.roster_count ?? 0} / {instance.capacity}
        </td>
        <td className="py-2 px-3 whitespace-nowrap">
          <div className="flex gap-1">
            <button
              onClick={onToggle}
              className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50"
            >
              {expanded ? 'Hide roster' : 'View roster'}
            </button>
            {!instance.cancelled_at && (
              <button
                onClick={cancelInstance}
                disabled={busy}
                className="rounded border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs text-rose-800 hover:bg-rose-100 disabled:opacity-50"
              >
                Cancel class
              </button>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} className="px-3 py-3 bg-slate-50 border-b border-slate-100">
            <RosterPanel instanceId={instance.id} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function RosterPanel({ instanceId, onChanged }) {
  const [roster, setRoster] = useState(null);
  const [error, setError] = useState(null);

  function load() {
    setError(null);
    api(`/api/admin/class-instances/${instanceId}/roster`)
      .then(handle)
      .then((data) => setRoster(data.roster ?? []))
      .catch((err) => setError(err.message));
  }

  useEffect(load, [instanceId]);

  async function cancel(b) {
    const reason = window.prompt(
      `Cancel this booking? Optional reason:`,
      '',
    );
    if (reason === null) return;
    try {
      const res = await api(`/api/class-bookings/${b.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ cancellation_reason: reason || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const refunded = body.refund_credits ?? 0;
      onChanged(
        refunded > 0
          ? `Cancelled. ${refunded} credit${refunded === 1 ? '' : 's'} refunded (${body.refund_percent}%).`
          : 'Cancelled. No refund per policy.',
      );
      load();
    } catch (err) {
      onChanged(`Cancel failed: ${err.message}`);
    }
  }

  async function markNoShow(b) {
    if (!window.confirm(`Mark this booking as no-show?`)) return;
    try {
      const res = await api(`/api/class-bookings/${b.id}/mark-no-show`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onChanged(`Marked no-show.`);
      load();
    } catch (err) {
      onChanged(`Mark no-show failed: ${err.message}`);
    }
  }

  if (error) {
    return <p className="text-sm text-rose-700">{error}</p>;
  }
  if (roster === null) {
    return <p className="text-sm text-slate-400">loading roster…</p>;
  }
  if (roster.length === 0) {
    return <p className="text-sm text-slate-500">No one signed up yet.</p>;
  }

  return (
    <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
      {roster.map((b) => {
        const name = b.member_id
          ? `${b.member_first_name ?? ''} ${b.member_last_name ?? ''}`.trim()
          : `${b.customer_first_name ?? ''} ${b.customer_last_name ?? ''}`.trim();
        const email = b.member_email ?? b.customer_email;
        const { label, className } = bookingStatusBadge(b.status);
        return (
          <li key={b.id} className="flex items-center justify-between px-3 py-2">
            <div className="text-sm">
              <div>{name || '—'}</div>
              {email && (
                <div className="text-xs text-slate-500 font-mono">{email}</div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs rounded px-2 py-0.5 ${className}`}>
                {label}
              </span>
              {b.status === 'confirmed' && (
                <>
                  <button
                    onClick={() => cancel(b)}
                    className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  {/* The server gates no-show on future-dated instances
                      (409). The button always shows for confirmed status;
                      premature clicks surface the error in onChanged. */}
                  <button
                    onClick={() => markNoShow(b)}
                    className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900 hover:bg-amber-100"
                  >
                    No-show
                  </button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ============================================================
// One-off instance form
// ============================================================

function OneoffForm({ classOfferings, activeResources, onSubmitted }) {
  const [offering_id, setOfferingId] = useState('');
  const [resource_id, setResourceId] = useState('');
  const [start_time, setStartTime] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // start_time as datetime-local is "YYYY-MM-DDTHH:MM" in the
      // browser's local zone. Convert to ISO for the API.
      const isoStart = new Date(start_time).toISOString();
      const res = await api('/api/admin/class-instances', {
        method: 'POST',
        body: JSON.stringify({
          offering_id,
          resource_id,
          start_time: isoStart,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onSubmitted('One-off instance created.');
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded border border-slate-200 bg-white p-4 mb-4 space-y-3"
    >
      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 px-3 py-1 text-sm text-rose-800">
          {error}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Offering">
          <select
            required
            value={offering_id}
            onChange={(e) => setOfferingId(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">— pick a class offering —</option>
            {classOfferings.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} · cap {o.capacity}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Resource">
          <select
            required
            value={resource_id}
            onChange={(e) => setResourceId(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">— pick a resource —</option>
            {activeResources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Start time (your local zone)">
          <input
            required
            type="datetime-local"
            value={start_time}
            onChange={(e) => setStartTime(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-sky-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50"
        >
          {submitting ? 'creating…' : 'Create instance'}
        </button>
      </div>
    </form>
  );
}
