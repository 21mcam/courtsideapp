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
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { zonedTimeToUtc } from '../lib/tz.js';
import {
  Page,
  PageHeader,
  Card,
  Button,
  Badge,
  ConfirmDialog,
  Field,
  Input,
  InputDialog,
  Select,
} from '../components/ui/index.js';
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
    <Page width="default">
      <PageHeader
        title="Classes"
        description={`Times shown in ${tz}. Schedules generate up to 90 days at a time; click "Generate more" to extend.`}
      />

      {actionMessage && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          {actionMessage}
        </div>
      )}

      {loadError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
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
    </Page>
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
    <Card
      padded={false}
      title={
        <>
          Schedules
          {schedules !== null && (
            <span className="ml-2 text-sm font-normal text-slate-400">
              ({schedules.length})
            </span>
          )}
        </>
      }
      actions={
        <Button size="sm" variant="secondary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'New schedule'}
        </Button>
      }
    >
      {showForm && (
        <div className="border-b border-slate-200 px-5 py-4">
          <ScheduleForm
            classOfferings={classOfferings}
            activeResources={activeResources}
            onSubmitted={(msg) => {
              setShowForm(false);
              onChanged(msg);
            }}
          />
        </div>
      )}

      {schedules === null ? (
        <p className="px-5 py-4 text-sm text-slate-400">loading…</p>
      ) : schedules.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">
          No schedules yet. Create one above to generate recurring class
          instances.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Offering</th>
                <th className="px-4 py-3">Resource</th>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Range</th>
                <th className="px-4 py-3">Generated</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
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
    </Card>
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
    <tr className="hover:bg-slate-50">
      <td className="px-4 py-3 text-sm">{schedule.offering_name}</td>
      <td className="px-4 py-3 text-sm">{schedule.resource_name}</td>
      <td className="px-4 py-3 text-sm">
        {dayOfWeekLabel(schedule.day_of_week)} {timeShort(schedule.start_time)}
      </td>
      <td className="px-4 py-3 text-xs">
        {String(schedule.start_date).slice(0, 10)} –{' '}
        {schedule.end_date
          ? String(schedule.end_date).slice(0, 10)
          : 'open-ended'}
      </td>
      <td className="px-4 py-3 text-xs">
        {schedule.generated_through
          ? String(schedule.generated_through).slice(0, 10)
          : '—'}{' '}
        <span className="text-slate-400">({schedule.active_instance_count})</span>
      </td>
      <td className="px-4 py-3 text-sm">
        <Badge tone={schedule.active ? 'success' : 'neutral'}>
          {schedule.active ? 'active' : 'inactive'}
        </Badge>
      </td>
      <td className="px-4 py-3 text-sm">
        <Button size="sm" variant="secondary" onClick={generateMore} disabled={busy}>
          {busy ? 'generating…' : 'Generate more'}
        </Button>
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
    <form onSubmit={submit} className="space-y-3">
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Offering">
          <Select
            required
            value={offering_id}
            onChange={(e) => setOfferingId(e.target.value)}
          >
            <option value="">— pick an offering —</option>
            {classOfferings.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} · cap {o.capacity}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Resource">
          <Select
            required
            value={resource_id}
            onChange={(e) => setResourceId(e.target.value)}
          >
            <option value="">— pick a resource —</option>
            {activeResources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Day of week">
          <Select
            value={day_of_week}
            onChange={(e) => setDow(Number(e.target.value))}
          >
            {DOW_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {dayOfWeekLabel(d)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Start time (24h)">
          <Input
            required
            type="time"
            value={start_time}
            onChange={(e) => setStartTime(e.target.value)}
          />
        </Field>
        <Field label="Start date" hint="Must match day of week">
          <Input
            required
            type="date"
            value={start_date}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </Field>
        <Field label="End date" hint="Optional, blank = open-ended">
          <Input
            type="date"
            value={end_date}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'creating…' : 'Create schedule'}
        </Button>
      </div>
    </form>
  );
}

// ============================================================
// Instances section (with inline roster expand)
// ============================================================

function InstancesSection({ instances, classOfferings, activeResources, tz, onChanged }) {
  const [expandedId, setExpandedId] = useState(null);
  const [showForm, setShowForm] = useState(false);

  return (
    <Card
      padded={false}
      title={
        <>
          Instances
          {instances !== null && (
            <span className="ml-2 text-sm font-normal text-slate-400">
              ({instances.length})
            </span>
          )}
        </>
      }
      actions={
        <Button size="sm" variant="secondary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'New one-off'}
        </Button>
      }
    >
      {showForm && (
        <div className="border-b border-slate-200 px-5 py-4">
          <OneoffForm
            classOfferings={classOfferings}
            activeResources={activeResources}
            tz={tz}
            onSubmitted={(msg) => {
              setShowForm(false);
              onChanged(msg);
            }}
          />
        </div>
      )}

      {instances === null ? (
        <p className="px-5 py-4 text-sm text-slate-400">loading…</p>
      ) : instances.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">
          No instances in the window.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Offering</th>
                <th className="px-4 py-3">Resource</th>
                <th className="px-4 py-3">Roster</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
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
    </Card>
  );
}

function InstanceRow({ instance, tz, expanded, onToggle, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // Runs after the admin submits the cancel InputDialog.
  async function cancelInstance(reason) {
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
      <tr className={expanded ? 'bg-slate-50' : 'hover:bg-slate-50'}>
        <td className="px-4 py-3 text-sm whitespace-nowrap">
          {formatSlotLocal(instance.start_time, tz)}
        </td>
        <td className="px-4 py-3 text-sm">{instance.offering_name}</td>
        <td className="px-4 py-3 text-sm">{instance.resource_name}</td>
        <td className="px-4 py-3 text-sm tabular-nums">
          {instance.roster_count ?? 0} / {instance.capacity}
        </td>
        <td className="px-4 py-3 text-sm whitespace-nowrap">
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={onToggle}>
              {expanded ? 'Hide roster' : 'View roster'}
            </Button>
            {!instance.cancelled_at && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => setConfirmingCancel(true)}
                disabled={busy}
              >
                Cancel class
              </Button>
            )}
          </div>
          {confirmingCancel && (
            <InputDialog
              title="Cancel class?"
              message={`Cancel "${instance.offering_name}" on ${formatSlotLocal(instance.start_time, tz)}? This cancels the entire roster and refunds members 100%.`}
              label="Reason (optional)"
              confirmLabel="Cancel class"
              cancelLabel="Keep class"
              variant="danger"
              onSubmit={(reason) => {
                setConfirmingCancel(false);
                cancelInstance(reason);
              }}
              onClose={() => setConfirmingCancel(false)}
            />
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} className="bg-slate-50 px-4 py-3">
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
  const [cancelTarget, setCancelTarget] = useState(null); // booking pending cancel
  const [noShowTarget, setNoShowTarget] = useState(null); // booking pending no-show

  function load() {
    setError(null);
    api(`/api/admin/class-instances/${instanceId}/roster`)
      .then(handle)
      .then((data) => setRoster(data.roster ?? []))
      .catch((err) => setError(err.message));
  }

  useEffect(load, [instanceId]);

  // Runs after the admin submits the cancel InputDialog.
  async function cancel(b, reason) {
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

  // Runs after the admin confirms in the no-show ConfirmDialog.
  async function markNoShow(b) {
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
    <>
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
      {roster.map((b) => {
        const name = b.member_id
          ? `${b.member_first_name ?? ''} ${b.member_last_name ?? ''}`.trim()
          : `${b.customer_first_name ?? ''} ${b.customer_last_name ?? ''}`.trim();
        const email = b.member_email ?? b.customer_email;
        const badge = bookingStatusBadge(b.status);
        return (
          <li key={b.id} className="flex items-center justify-between px-4 py-3">
            <div className="text-sm">
              <div className="text-slate-900">{name || '—'}</div>
              {email && (
                <div className="text-xs text-slate-500 font-mono">{email}</div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={badge.tone}>{badge.label}</Badge>
              {b.status === 'confirmed' && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setCancelTarget(b)}
                  >
                    Cancel
                  </Button>
                  {/* The server gates no-show on future-dated instances
                      (409). The button always shows for confirmed status;
                      premature clicks surface the error in onChanged. */}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setNoShowTarget(b)}
                  >
                    No-show
                  </Button>
                </>
              )}
            </div>
          </li>
        );
      })}
      </ul>
      {cancelTarget && (
        <InputDialog
          title="Cancel booking?"
          message="Cancel this booking? Members are refunded per the cancellation policy."
          label="Reason (optional)"
          confirmLabel="Cancel booking"
          cancelLabel="Keep booking"
          variant="danger"
          onSubmit={(reason) => {
            const b = cancelTarget;
            setCancelTarget(null);
            cancel(b, reason);
          }}
          onClose={() => setCancelTarget(null)}
        />
      )}
      {noShowTarget && (
        <ConfirmDialog
          title="Mark no-show?"
          message="Mark this booking as no-show?"
          confirmLabel="Mark no-show"
          onConfirm={() => {
            const b = noShowTarget;
            setNoShowTarget(null);
            markNoShow(b);
          }}
          onClose={() => setNoShowTarget(null)}
        />
      )}
    </>
  );
}

// ============================================================
// One-off instance form
// ============================================================

function OneoffForm({ classOfferings, activeResources, tz, onSubmitted }) {
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
      // start_time from <input type=datetime-local> is a bare
      // "YYYY-MM-DDTHH:MM" wall-clock value. The page banner promises
      // tenant time, so interpret it in the TENANT's zone — new
      // Date(start_time) would use the browser zone and silently
      // shift the instance for any remote admin (a Tokyo browser
      // typing 6:00 PM used to create a 5:00 AM class).
      const isoStart = zonedTimeToUtc(
        start_time.slice(0, 10),
        start_time.slice(11, 16),
        tz,
      ).toISOString();
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
    <form onSubmit={submit} className="space-y-3">
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Offering">
          <Select
            required
            value={offering_id}
            onChange={(e) => setOfferingId(e.target.value)}
          >
            <option value="">— pick a class offering —</option>
            {classOfferings.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} · cap {o.capacity}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Resource">
          <Select
            required
            value={resource_id}
            onChange={(e) => setResourceId(e.target.value)}
          >
            <option value="">— pick a resource —</option>
            {activeResources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Start time (${tz})`}>
          <Input
            required
            type="datetime-local"
            value={start_time}
            onChange={(e) => setStartTime(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'creating…' : 'Create instance'}
        </Button>
      </div>
    </form>
  );
}
