// Admin Settings → Operating hours. Per-resource weekly editor over
// operating_hours rows.
//
// The whole week for one resource is edited in memory, then saved in
// one shot via PUT /api/admin/resources/:id/operating-hours (bulk
// replace — atomic, so narrowing/moving a window never trips the
// schema's non-overlap exclusion against the row being replaced).
// Times are tenant-local `time` values (DST-stable) — no timezone
// conversion here, only on blackouts.
//
// "Copy to other resources" mirrors the wizard's duplicate-across-
// resources convenience: it PUTs the current editor's schedule to
// each selected resource.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Plus, X } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { dayOfWeekLabel, timeShort } from '../format.js';
import SettingsNav from '../components/SettingsNav.jsx';
import {
  Button,
  Card,
  Field,
  Input,
  Page,
  PageHeader,
  Select,
  cn,
} from '../components/ui/index.js';

// Display Monday-first; day_of_week stays 0=Sun..6=Sat (schema).
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const DEFAULT_WINDOW = { open_time: '09:00', close_time: '17:00' };

// rows (API shape) → { [day_of_week]: [{open_time, close_time}] }
function rowsToWeek(rows) {
  const week = {};
  for (const d of DAY_ORDER) week[d] = [];
  for (const r of rows) {
    week[r.day_of_week].push({
      open_time: timeShort(r.open_time),
      close_time: timeShort(r.close_time),
    });
  }
  for (const d of DAY_ORDER) {
    week[d].sort((a, b) => (a.open_time < b.open_time ? -1 : 1));
  }
  return week;
}

function weekToPayload(week) {
  const hours = [];
  for (const d of DAY_ORDER) {
    for (const w of week[d]) {
      hours.push({
        day_of_week: d,
        open_time: w.open_time,
        close_time: w.close_time,
      });
    }
  }
  return { hours };
}

export default function AdminHours() {
  const { tenant } = useAuth();
  const [resources, setResources] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [week, setWeek] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Load resources once.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api('/api/admin/resources');
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (!alive) return;
        setResources(body.resources);
        if (body.resources.length > 0) setSelectedId(body.resources[0].id);
      } catch (err) {
        if (alive) setLoadError(err.message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Load the selected resource's week.
  const loadWeek = useCallback(async (resourceId) => {
    setWeek(null);
    setDirty(false);
    setSaveError(null);
    setSavedFlash(false);
    try {
      const res = await api(
        `/api/admin/operating-hours?resource_id=${resourceId}`,
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setWeek(rowsToWeek(body.operating_hours));
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    if (selectedId) loadWeek(selectedId);
  }, [selectedId, loadWeek]);

  function switchResource(id) {
    if (
      dirty &&
      !window.confirm('Discard unsaved changes to this schedule?')
    ) {
      return;
    }
    setSelectedId(id);
  }

  function updateWindow(day, idx, patch) {
    setWeek((prev) => {
      const next = { ...prev, [day]: prev[day].slice() };
      next[day][idx] = { ...next[day][idx], ...patch };
      return next;
    });
    setDirty(true);
    setSavedFlash(false);
  }

  function addWindow(day) {
    setWeek((prev) => {
      const windows = prev[day];
      // Second shift default: start after the last close.
      const seed =
        windows.length > 0
          ? { open_time: windows[windows.length - 1].close_time, close_time: '21:00' }
          : DEFAULT_WINDOW;
      return { ...prev, [day]: [...windows, { ...seed }] };
    });
    setDirty(true);
    setSavedFlash(false);
  }

  function removeWindow(day, idx) {
    setWeek((prev) => ({
      ...prev,
      [day]: prev[day].filter((_, i) => i !== idx),
    }));
    setDirty(true);
    setSavedFlash(false);
  }

  function validate(w) {
    for (const d of DAY_ORDER) {
      for (const win of w[d]) {
        if (!win.open_time || !win.close_time) {
          return `${dayOfWeekLabel(d)}: both open and close times are required.`;
        }
        if (win.close_time <= win.open_time) {
          return `${dayOfWeekLabel(d)}: close time must be after open time.`;
        }
      }
    }
    return null;
  }

  async function save() {
    if (saving || !week) return;
    const problem = validate(week);
    if (problem) {
      setSaveError(problem);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api(
        `/api/admin/resources/${selectedId}/operating-hours`,
        { method: 'PUT', body: JSON.stringify(weekToPayload(week)) },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setWeek(rowsToWeek(body.operating_hours));
      setDirty(false);
      setSavedFlash(true);
    } catch (err) {
      setSaveError(`Couldn't save hours: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  const selected = resources?.find((r) => r.id === selectedId);

  return (
    <Page width="narrow">
      <PageHeader
        title="Settings"
        description="When each resource is open for booking."
      />
      <SettingsNav />

      {loadError && <ErrorBanner message={loadError} />}

      {resources && resources.length === 0 && (
        <Card>
          <p className="text-sm text-slate-600">
            No resources yet. Create one in the{' '}
            <Link to="/wizard" className="font-medium text-brand-700 hover:underline">
              setup wizard
            </Link>{' '}
            first, then come back to set its hours.
          </p>
        </Card>
      )}

      {resources && resources.length > 0 && (
        <>
          <Card title="Operating hours">
            <p className="mb-4 text-sm text-slate-500">
              Times are local to your facility ({tenant.timezone}). Days
              with no hours are closed. Add a second window to a day for
              split shifts.
            </p>
            <div className="mb-5 max-w-xs">
              <Field label="Resource">
                <Select
                  value={selectedId}
                  onChange={(e) => switchResource(e.target.value)}
                >
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {r.active ? '' : ' (inactive)'}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {!week && !loadError && (
              <div className="py-8 text-center text-sm text-slate-400">
                loading…
              </div>
            )}

            {week && (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {DAY_ORDER.map((day) => (
                  <DayRow
                    key={day}
                    day={day}
                    windows={week[day]}
                    onAdd={() => addWindow(day)}
                    onRemove={(idx) => removeWindow(day, idx)}
                    onChange={(idx, patch) => updateWindow(day, idx, patch)}
                  />
                ))}
              </div>
            )}

            {saveError && <ErrorBanner message={saveError} />}

            <div className="mt-5 flex items-center justify-end gap-3">
              {savedFlash && (
                <span className="text-xs text-emerald-600">Saved.</span>
              )}
              {dirty && !savedFlash && (
                <span className="text-xs text-amber-600">Unsaved changes</span>
              )}
              <Button onClick={save} disabled={saving || !week || !dirty}>
                {saving ? 'Saving…' : `Save ${selected?.name ?? ''}`}
              </Button>
            </div>
          </Card>

          {week && resources.length > 1 && (
            <CopyHoursCard
              resources={resources}
              selectedId={selectedId}
              week={week}
              dirty={dirty}
            />
          )}
        </>
      )}
    </Page>
  );
}

function DayRow({ day, windows, onAdd, onRemove, onChange }) {
  const closed = windows.length === 0;
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
      <div className="w-12 shrink-0 pt-1.5 text-sm font-medium text-slate-700">
        {dayOfWeekLabel(day)}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {closed && (
          <div className="pt-1.5 text-sm text-slate-400">Closed</div>
        )}
        {windows.map((w, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <Input
              type="time"
              value={w.open_time}
              onChange={(e) => onChange(idx, { open_time: e.target.value })}
              className="w-32"
              aria-label={`${dayOfWeekLabel(day)} open time`}
            />
            <span className="text-sm text-slate-400">–</span>
            <Input
              type="time"
              value={w.close_time}
              onChange={(e) => onChange(idx, { close_time: e.target.value })}
              className="w-32"
              aria-label={`${dayOfWeekLabel(day)} close time`}
            />
            <button
              type="button"
              onClick={() => onRemove(idx)}
              aria-label={`Remove ${dayOfWeekLabel(day)} window`}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-rose-600"
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onAdd}
        className={cn(
          'mt-1 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium',
          'text-brand-700 hover:bg-brand-50',
        )}
      >
        <Plus size={14} />
        {closed ? 'Add hours' : 'Add window'}
      </button>
    </div>
  );
}

// Duplicate the on-screen schedule onto other resources — one bulk
// PUT per target. Warns that targets' existing hours are replaced.
function CopyHoursCard({ resources, selectedId, week, dirty }) {
  const [targets, setTargets] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const others = resources.filter((r) => r.id !== selectedId);

  // Reset picks when the source resource changes.
  useEffect(() => {
    setTargets(new Set());
    setDone(null);
    setError(null);
  }, [selectedId]);

  function toggle(id) {
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDone(null);
  }

  async function copy() {
    if (busy || targets.size === 0) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const payload = JSON.stringify(weekToPayload(week));
    try {
      for (const id of targets) {
        const res = await api(`/api/admin/resources/${id}/operating-hours`, {
          method: 'PUT',
          body: payload,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const name = resources.find((r) => r.id === id)?.name ?? id;
          throw new Error(`${name}: ${body.error || `HTTP ${res.status}`}`);
        }
      }
      setDone(targets.size);
      setTargets(new Set());
    } catch (err) {
      setError(`Copy failed — ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  const sourceName = resources.find((r) => r.id === selectedId)?.name;

  return (
    <Card title="Copy hours to other resources">
      <p className="mb-4 text-sm text-slate-500">
        Apply {sourceName}'s schedule
        {dirty ? ' (as shown above, including unsaved edits)' : ''} to
        other resources. This replaces their existing hours.
      </p>
      {error && <ErrorBanner message={error} />}
      <div className="flex flex-wrap gap-2">
        {others.map((r) => {
          const on = targets.has(r.id);
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => toggle(r.id)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                on
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              {r.name}
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {done != null && (
          <span className="text-xs text-emerald-600">
            Copied to {done} resource{done === 1 ? '' : 's'}.
          </span>
        )}
        <Button
          variant="secondary"
          onClick={copy}
          disabled={busy || targets.size === 0}
        >
          <Copy size={14} />
          {busy ? 'Copying…' : 'Copy hours'}
        </Button>
      </div>
    </Card>
  );
}

function ErrorBanner({ message }) {
  return (
    <div className="my-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      {message}
    </div>
  );
}
