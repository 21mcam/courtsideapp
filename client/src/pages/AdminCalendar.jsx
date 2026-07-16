// Admin calendar — multi-resource day view.
//
// Visual grid: one column per resource × hour rows. Bookings and
// class instances render as positioned cards. Click a card to open
// a detail panel with cancel / mark-no-show actions.
//
// No new backend endpoints — composes existing /api/admin/{resources,
// bookings,class-instances} responses. Date filtering is generous
// (±24h around the selected day) and the frontend filters by
// tenant-local date so DST and midnight boundaries are handled
// without tripping over UTC↔local conversion.
//
// Skipped for MVP: drag-to-move/resize, week view, real-time
// updates. The screen is purely a read+act surface for staff.
//
// Layout rules:
//   * Overlapping items on one resource split into side-by-side
//     lanes (lib/calendarLayout.js) — a double-booked slot must show
//     BOTH cards, never paint one over the other.
//   * The visible window defaults to 06:00–23:00 tenant-local but
//     expands to fit the day's data, so early/late bookings are
//     never silently off-grid. Cross-midnight bookings render to the
//     bottom of the day they start on.
//   * Cancelled bookings/classes are NOT on the grid (cancelling
//     frees the slot — same as the DB exclusion semantics). They're
//     reachable from the "Cancelled" list under the grid.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { bookingStatusBadge, formatTimeLocal } from '../format.js';
import {
  assignLanes,
  effectiveEndMin,
  gridBounds,
} from '../lib/calendarLayout.js';

const PX_PER_MIN = 1.0; // 1px per minute → ~1020px tall grid by default

export default function AdminCalendar() {
  const { me } = useAuth();
  const tz = me.tenant.timezone;

  // YYYY-MM-DD string in tenant local. Init to today.
  const [dateStr, setDateStr] = useState(() => todayLocalString(tz));

  const [resources, setResources] = useState(null);
  const [bookings, setBookings] = useState(null);
  const [classInstances, setClassInstances] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadError, setLoadError] = useState(null);
  const [hiddenResourceIds, setHiddenResourceIds] = useState(() => new Set());
  const [actionMessage, setActionMessage] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null); // { kind, ...row }

  // Compute UTC bounds. Generous (±24h) so we don't miss anything
  // near midnight; frontend filters by tenant-local date next.
  const fromIso = useMemo(() => {
    const d = new Date(`${dateStr}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString();
  }, [dateStr]);
  const toIso = useMemo(() => {
    const d = new Date(`${dateStr}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 2);
    return d.toISOString();
  }, [dateStr]);

  // Fetch whenever the date window changes (or an action bumps
  // refreshKey). The cleanup aborts the in-flight request so rapid
  // prev/next clicks can't race — a slow earlier response must never
  // overwrite a newer day's data.
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      api('/api/admin/resources', { signal: controller.signal }).then(handle),
      api(
        `/api/admin/bookings?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
        { signal: controller.signal },
      ).then(handle),
      api(
        `/api/admin/class-instances?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
        { signal: controller.signal },
      ).then(handle),
    ])
      .then(([r, b, c]) => {
        if (!alive) return;
        setResources(r.resources ?? []);
        setBookings(b.bookings ?? []);
        setClassInstances(c.class_instances ?? []);
      })
      .catch((err) => {
        if (!alive || err.name === 'AbortError') return;
        setLoadError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [fromIso, toIso, refreshKey]);

  // Active resources only, optionally narrowed by hide toggles
  const visibleResources = useMemo(() => {
    return (resources ?? [])
      .filter((r) => r.active)
      .filter((r) => !hiddenResourceIds.has(r.id));
  }, [resources, hiddenResourceIds]);

  // Filter to items whose start_time lands on the selected local date
  const dayBookings = useMemo(
    () =>
      (bookings ?? []).filter(
        (b) => localDateString(b.start_time, tz) === dateStr,
      ),
    [bookings, dateStr, tz],
  );
  const dayClassInstances = useMemo(
    () =>
      (classInstances ?? []).filter(
        (ci) => localDateString(ci.start_time, tz) === dateStr,
      ),
    [classInstances, dateStr, tz],
  );

  // Cancelled items stay off the grid (a cancelled booking frees its
  // slot) but remain reachable from the list under it.
  const dayCancelledItems = useMemo(
    () =>
      [
        ...dayBookings
          .filter((b) => b.status === 'cancelled')
          .map((b) => ({ kind: 'booking', ...b })),
        ...dayClassInstances
          .filter((ci) => ci.cancelled_at)
          .map((ci) => ({ kind: 'class', ...ci })),
      ].sort((a, b) => new Date(a.start_time) - new Date(b.start_time)),
    [dayBookings, dayClassInstances],
  );

  // Group slot-occupying (non-cancelled) items by resource_id for
  // column rendering
  const itemsByResource = useMemo(() => {
    const m = new Map();
    for (const r of visibleResources) m.set(r.id, []);
    for (const b of dayBookings) {
      if (b.status === 'cancelled') continue;
      const list = m.get(b.resource_id);
      if (list) list.push({ kind: 'booking', ...b });
    }
    for (const ci of dayClassInstances) {
      if (ci.cancelled_at) continue;
      const list = m.get(ci.resource_id);
      if (list) list.push({ kind: 'class', ...ci });
    }
    return m;
  }, [visibleResources, dayBookings, dayClassInstances]);

  function shiftDate(days) {
    const d = new Date(`${dateStr}T12:00:00.000Z`); // noon to dodge DST issues
    d.setUTCDate(d.getUTCDate() + days);
    setDateStr(d.toISOString().slice(0, 10));
  }

  function toggleResource(id) {
    setHiddenResourceIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-[1600px] mx-auto p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <Link to="/" className="text-sm text-sky-700 hover:underline">
              ← Back
            </Link>
            <h1 className="mt-1 text-xl font-semibold">Calendar</h1>
            <div className="text-xs text-slate-500">
              All times in {tz}.
            </div>
          </div>
          <DateNav
            dateStr={dateStr}
            tz={tz}
            onPrev={() => shiftDate(-1)}
            onToday={() => setDateStr(todayLocalString(tz))}
            onNext={() => shiftDate(1)}
          />
        </div>

        {loadError && (
          <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {loadError}
          </div>
        )}
        {actionMessage && (
          <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {actionMessage}
          </div>
        )}

        <div className="flex gap-3">
          {/* Sidebar: resource toggles */}
          <aside className="w-48 shrink-0 rounded border border-slate-200 bg-white p-3 self-start">
            <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
              Resources ({(resources ?? []).filter((r) => r.active).length})
            </h2>
            <ul className="space-y-1">
              {(resources ?? [])
                .filter((r) => r.active)
                .map((r) => (
                  <li key={r.id} className="flex items-center gap-2">
                    <input
                      id={`r-${r.id}`}
                      type="checkbox"
                      checked={!hiddenResourceIds.has(r.id)}
                      onChange={() => toggleResource(r.id)}
                      className="rounded border-slate-300"
                    />
                    <label htmlFor={`r-${r.id}`} className="text-sm">
                      {r.name}
                    </label>
                  </li>
                ))}
            </ul>
            {(resources ?? []).filter((r) => !r.active).length > 0 && (
              <p className="mt-3 text-xs text-slate-400">
                {(resources ?? []).filter((r) => !r.active).length} inactive
                resource(s) hidden
              </p>
            )}
          </aside>

          {/* Calendar grid + cancelled list */}
          <div className="flex-1 min-w-0 space-y-3">
            <div className="overflow-x-auto rounded border border-slate-200 bg-white">
              <Grid
                tz={tz}
                loading={loading}
                resources={visibleResources}
                itemsByResource={itemsByResource}
                onItemClick={setSelectedItem}
              />
            </div>

            {dayCancelledItems.length > 0 && (
              <details className="rounded border border-slate-200 bg-white px-3 py-2">
                <summary className="cursor-pointer text-sm text-slate-600">
                  Cancelled on this day ({dayCancelledItems.length})
                </summary>
                <ul className="mt-2 divide-y divide-slate-100">
                  {dayCancelledItems.map((item) => (
                    <li key={`${item.kind}:${item.id}`}>
                      <button
                        onClick={() => setSelectedItem(item)}
                        className="flex w-full items-center gap-3 px-1 py-1.5 text-left text-sm hover:bg-slate-50"
                      >
                        <span className="tabular-nums text-xs text-slate-500">
                          {formatTimeLocal(item.start_time, tz)}
                        </span>
                        <span className="truncate text-slate-600 line-through">
                          {cancelledItemLabel(item)}
                        </span>
                        <span className="ml-auto shrink-0 text-xs text-slate-400">
                          {item.resource_name ?? ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      </main>

      {selectedItem && (
        <DetailPanel
          item={selectedItem}
          tz={tz}
          onClose={() => setSelectedItem(null)}
          onActionSuccess={(msg) => {
            setActionMessage(msg);
            setSelectedItem(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// Date navigation
// ============================================================

function DateNav({ dateStr, tz, onPrev, onToday, onNext }) {
  const isToday = dateStr === todayLocalString(tz);
  // dateStr is already the tenant-local calendar date. Format it as a
  // plain date (timeZone UTC matches the embedded T12:00Z) so the
  // header can't drift a day in browsers far from the tenant's zone.
  const display = new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onPrev}
        className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-50"
      >
        ←
      </button>
      <button
        onClick={onToday}
        disabled={isToday}
        className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Today
      </button>
      <button
        onClick={onNext}
        className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-50"
      >
        →
      </button>
      <span className="ml-3 text-sm font-medium text-slate-700">
        {display}
      </span>
    </div>
  );
}

// ============================================================
// Grid (resource columns × hour rows)
// ============================================================

function Grid({ tz, loading, resources, itemsByResource, onItemClick }) {
  // Normalize every visible item to tenant-local minutes once, then
  // derive the visible window (expanded to fit the data) and the
  // per-resource lane layout from that.
  const layout = useMemo(() => {
    const byResource = new Map();
    const all = [];
    for (const r of resources) {
      const norm = (itemsByResource.get(r.id) ?? []).map((item) => {
        const startMin = localMinutesOfDay(item.start_time, tz);
        const endMin = effectiveEndMin(
          startMin,
          localMinutesOfDay(item.end_time, tz),
        );
        return { key: `${item.kind}:${item.id}`, item, startMin, endMin };
      });
      byResource.set(r.id, { norm, lanes: assignLanes(norm) });
      all.push(...norm);
    }
    return { byResource, bounds: gridBounds(all) };
  }, [tz, resources, itemsByResource]);

  if (resources.length === 0) {
    return (
      <p className="p-6 text-sm text-slate-500">
        {loading
          ? 'Loading calendar…'
          : 'No active resources to display. Add resources via the wizard or unhide them in the sidebar.'}
      </p>
    );
  }

  const { startMin: gridStart, endMin: gridEnd } = layout.bounds;
  const totalHeight = (gridEnd - gridStart) * PX_PER_MIN;
  const hourLines = [];
  for (let m = gridStart; m <= gridEnd; m += 60) {
    hourLines.push(m);
  }

  return (
    <div className="flex" style={{ minWidth: `${120 + resources.length * 160}px` }}>
      {/* Time gutter */}
      <div className="w-16 shrink-0 border-r border-slate-200 relative" style={{ height: totalHeight + 30 }}>
        <div className="h-[30px] border-b border-slate-200 text-[10px] uppercase text-slate-400 flex items-center justify-end pr-2">
          {tz?.split('/')[1] ? tz.split('/')[1].slice(0, 3) : 'UTC'}
        </div>
        {hourLines.map((m) => (
          <div
            key={m}
            className="absolute right-2 text-xs text-slate-500"
            style={{ top: 30 + (m - gridStart) * PX_PER_MIN - 6 }}
          >
            {formatHourLabel(m)}
          </div>
        ))}
      </div>

      {/* Resource columns */}
      {resources.map((r) => {
        const { norm, lanes } = layout.byResource.get(r.id);
        return (
          <div
            key={r.id}
            className="flex-1 min-w-[160px] border-r border-slate-200 relative"
            style={{ height: totalHeight + 30 }}
          >
            {/* Header */}
            <div className="h-[30px] border-b border-slate-200 px-2 flex items-center text-sm font-medium text-slate-700 bg-slate-50">
              {r.name}
            </div>

            {/* Hour gridlines */}
            {hourLines.map((m) => (
              <div
                key={m}
                className="absolute left-0 right-0 border-t border-slate-100"
                style={{ top: 30 + (m - gridStart) * PX_PER_MIN }}
              />
            ))}

            {/* Booking + class cards */}
            {norm.map(({ key, item, startMin, endMin }) => {
              // gridBounds expanded the window to fit the data, so
              // clamping only trims cross-midnight tails at 24:00.
              const clampedStart = Math.max(startMin, gridStart);
              const clampedEnd = Math.min(endMin, gridEnd);
              if (clampedEnd <= clampedStart) return null;

              const top = 30 + (clampedStart - gridStart) * PX_PER_MIN;
              const height = Math.max(
                20,
                (clampedEnd - clampedStart) * PX_PER_MIN,
              );
              const { lane, laneCount } = lanes.get(key);

              return (
                <Card
                  key={key}
                  item={item}
                  tz={tz}
                  top={top}
                  height={height}
                  lane={lane}
                  laneCount={laneCount}
                  onClick={() => onItemClick(item)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function Card({ item, tz, top, height, lane, laneCount, onClick }) {
  const isClass = item.kind === 'class';

  // Color: classes purple-ish, member bookings sky-blue, walk-in
  // bookings emerald, pending_payment amber. (Cancelled items never
  // reach the grid — they live in the list under it.)
  let palette;
  if (isClass) palette = 'bg-violet-100 text-violet-900 border-violet-300';
  else if (item.status === 'pending_payment')
    palette = 'bg-amber-100 text-amber-900 border-amber-400';
  else if (item.status === 'no_show')
    palette = 'bg-rose-100 text-rose-900 border-rose-400';
  else if (item.member_id)
    palette = 'bg-sky-100 text-sky-900 border-sky-400';
  else palette = 'bg-emerald-100 text-emerald-900 border-emerald-400';

  // Card content
  let title;
  let subtitle;
  if (isClass) {
    title = item.offering_name;
    subtitle = `${item.roster_count ?? 0}/${item.capacity}`;
  } else {
    title = item.member_id
      ? `${item.member_first_name ?? ''} ${item.member_last_name ?? ''}`.trim() ||
        item.member_email ||
        'Member'
      : `${item.customer_first_name ?? ''} ${item.customer_last_name ?? ''}`.trim() ||
        item.customer_email ||
        'Walk-in';
    subtitle = item.offering_name ?? '';
  }

  // Overlapping items split the column into equal lanes; the small
  // pixel inset keeps a visible seam between adjacent cards.
  const left = `calc(${(lane / laneCount) * 100}% + 3px)`;
  const width = `calc(${100 / laneCount}% - 6px)`;

  return (
    <button
      onClick={onClick}
      className={`absolute rounded border-l-4 px-2 py-1 text-left text-xs hover:brightness-95 ${palette} overflow-hidden`}
      style={{ top, height, left, width }}
      title={`${title} · ${formatTimeLocal(item.start_time, tz)}`}
    >
      <div className="font-medium truncate">{title}</div>
      {subtitle && (
        <div className="truncate text-[11px] opacity-80">{subtitle}</div>
      )}
    </button>
  );
}

// ============================================================
// Detail panel (modal-ish — slide-over from the right)
// ============================================================

function DetailPanel({ item, tz, onClose, onActionSuccess }) {
  const [busy, setBusy] = useState(false);
  const isClass = item.kind === 'class';
  // Match AdminBookings: no-show only offered once the slot's start
  // time has passed — you can't no-show someone who isn't late yet.
  const isPast = new Date(item.start_time).getTime() <= Date.now();

  async function cancel() {
    if (busy) return;
    const reason = window.prompt('Cancel reason (optional):', '');
    if (reason === null) return;
    setBusy(true);
    try {
      let path;
      if (isClass) {
        path = `/api/admin/class-instances/${item.id}/cancel`;
      } else {
        path = `/api/bookings/${item.id}/cancel`;
      }
      const res = await api(path, {
        method: 'POST',
        body: JSON.stringify({ cancellation_reason: reason || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onActionSuccess(
        isClass
          ? `Class cancelled — ${body.roster_cancelled} roster row(s), ${body.members_refunded} refunded`
          : `Booking cancelled — ${body.refund_credits ?? 0} credit(s) refunded (${body.refund_percent ?? 0}%)`,
      );
    } catch (err) {
      onActionSuccess(`Cancel failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function markNoShow() {
    if (busy) return;
    if (!window.confirm('Mark this booking as no-show?')) return;
    setBusy(true);
    try {
      const res = await api(`/api/bookings/${item.id}/mark-no-show`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onActionSuccess('Marked no-show');
    } catch (err) {
      onActionSuccess(`Mark no-show failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  const startStr = new Date(item.start_time).toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const endStr = new Date(item.end_time).toLocaleString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div className="fixed inset-0 z-40 flex">
      <div
        className="flex-1 bg-slate-900/30"
        onClick={onClose}
        aria-label="Close"
      />
      <aside className="w-full sm:w-96 bg-white shadow-xl border-l border-slate-200 p-5 overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            {isClass ? 'Class instance' : 'Booking'}
          </h2>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
          {isClass ? (
            <>
              <dt className="text-slate-500">Class</dt>
              <dd className="col-span-2">{item.offering_name}</dd>
              <dt className="text-slate-500">Resource</dt>
              <dd className="col-span-2">{item.resource_name}</dd>
              <dt className="text-slate-500">When</dt>
              <dd className="col-span-2">
                {startStr} – {endStr}
              </dd>
              <dt className="text-slate-500">Roster</dt>
              <dd className="col-span-2">
                {item.roster_count ?? 0} / {item.capacity}
              </dd>
              {item.cancelled_at && (
                <>
                  <dt className="text-slate-500">Cancelled</dt>
                  <dd className="col-span-2 text-rose-700">
                    {new Date(item.cancelled_at).toLocaleString()}
                  </dd>
                </>
              )}
            </>
          ) : (
            <>
              <dt className="text-slate-500">Who</dt>
              <dd className="col-span-2">
                {item.member_id
                  ? `${item.member_first_name ?? ''} ${item.member_last_name ?? ''}`.trim()
                  : `${item.customer_first_name ?? ''} ${item.customer_last_name ?? ''}`.trim()}
                {item.member_id ? (
                  <span className="ml-2 text-xs rounded bg-sky-100 text-sky-900 px-1.5 py-0.5">
                    member
                  </span>
                ) : (
                  <span className="ml-2 text-xs rounded bg-emerald-100 text-emerald-900 px-1.5 py-0.5">
                    walk-in
                  </span>
                )}
              </dd>
              <dt className="text-slate-500">Email</dt>
              <dd className="col-span-2 font-mono text-xs">
                {item.member_email ?? item.customer_email ?? '—'}
              </dd>
              <dt className="text-slate-500">Offering</dt>
              <dd className="col-span-2">{item.offering_name}</dd>
              <dt className="text-slate-500">Resource</dt>
              <dd className="col-span-2">{item.resource_name}</dd>
              <dt className="text-slate-500">When</dt>
              <dd className="col-span-2">
                {startStr} – {endStr}
              </dd>
              <dt className="text-slate-500">Status</dt>
              <dd className="col-span-2">
                <StatusBadge status={item.status} />
              </dd>
              {item.credit_cost_charged > 0 && (
                <>
                  <dt className="text-slate-500">Credits</dt>
                  <dd className="col-span-2 tabular-nums">
                    {item.credit_cost_charged}
                  </dd>
                </>
              )}
              {item.amount_due_cents > 0 && (
                <>
                  <dt className="text-slate-500">Amount</dt>
                  <dd className="col-span-2 tabular-nums">
                    ${(item.amount_due_cents / 100).toFixed(2)} ·{' '}
                    {item.payment_status}
                  </dd>
                </>
              )}
            </>
          )}
        </dl>

        <div className="mt-5 flex flex-col gap-2">
          {!isClass && item.status === 'confirmed' && (
            <>
              <button
                onClick={cancel}
                disabled={busy}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
              >
                {busy ? 'cancelling…' : 'Cancel booking'}
              </button>
              {isPast && (
                <button
                  onClick={markNoShow}
                  disabled={busy}
                  className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                >
                  Mark no-show
                </button>
              )}
            </>
          )}
          {isClass && !item.cancelled_at && (
            <button
              onClick={cancel}
              disabled={busy}
              className="rounded border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm text-rose-800 hover:bg-rose-100 disabled:opacity-50"
            >
              {busy ? 'cancelling…' : 'Cancel class (refund roster)'}
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

function StatusBadge({ status }) {
  const { label, className } = bookingStatusBadge(status);
  return (
    <span className={`text-xs rounded px-2 py-0.5 ${className}`}>{label}</span>
  );
}

// ============================================================
// helpers
// ============================================================

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Label for the cancelled list — who/what, mirroring the grid cards.
function cancelledItemLabel(item) {
  if (item.kind === 'class') return item.offering_name ?? 'Class';
  return item.member_id
    ? `${item.member_first_name ?? ''} ${item.member_last_name ?? ''}`.trim() ||
        item.member_email ||
        'Member'
    : `${item.customer_first_name ?? ''} ${item.customer_last_name ?? ''}`.trim() ||
        item.customer_email ||
        'Walk-in';
}

// "today" in tenant local timezone, as YYYY-MM-DD
function todayLocalString(tz) {
  // Intl gives us the parts directly
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  // en-CA returns YYYY-MM-DD already
  return parts;
}

// Local YYYY-MM-DD for an ISO instant in the given timezone
function localDateString(iso, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

// Minutes since local midnight in tenant timezone (DST-aware via Intl)
function localMinutesOfDay(iso, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
  // "14:30" or "24:30" (Intl returns "24:00" for midnight in some locales)
  const [h, m] = fmt.split(':').map(Number);
  return (h % 24) * 60 + m;
}

function formatHourLabel(min) {
  const h = Math.floor(min / 60);
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}
