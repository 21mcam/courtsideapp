// Admin calendar — multi-resource day view.
//
// Visual grid: one column per resource × hour rows. Bookings and
// class instances render as positioned cards. Click a card to open
// a detail panel with cancel / mark-no-show actions. Click or drag
// on an open area to create a booking (15-min snap; drag defines a
// custom-length window).
//
// Date filtering is generous (±24h around the selected day) and the
// frontend filters by tenant-local date so DST and midnight
// boundaries are handled without tripping over UTC↔local conversion.
//
// Skipped for MVP: drag-to-move/resize, week view, real-time
// updates.
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

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Page,
  PageHeader,
  Button,
  Badge,
  Field,
  Input,
  Select,
} from '../components/ui/index.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  bookingStatusBadge,
  formatCents,
  formatSlotLocal,
  formatTimeLocal,
} from '../format.js';
import {
  assignLanes,
  effectiveEndMin,
  gridBounds,
} from '../lib/calendarLayout.js';
import { zonedTimeToUtc } from '../lib/tz.js';

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
  // Click/drag creation draft: { resourceId, resourceName, startMin,
  // endMin, dragged }. `dragged` distinguishes an explicit custom
  // window (kept as-is) from a plain click (end snaps to the chosen
  // offering's duration).
  const [createDraft, setCreateDraft] = useState(null);

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
    <>
      <Page width="full">
        <div className="max-w-[1600px] mx-auto space-y-3">
        <PageHeader
          title="Calendar"
          description={`All times in ${tz}. Click or drag on an open area to create a booking.`}
          actions={
            <DateNav
              dateStr={dateStr}
              tz={tz}
              onPrev={() => shiftDate(-1)}
              onToday={() => setDateStr(todayLocalString(tz))}
              onNext={() => shiftDate(1)}
            />
          }
        />

        {loadError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {loadError}
          </div>
        )}
        {actionMessage && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
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
                onSelectRange={setCreateDraft}
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
        </div>
      </Page>

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

      {createDraft && (
        <CreateBookingModal
          draft={createDraft}
          dateStr={dateStr}
          tz={tz}
          onClose={() => setCreateDraft(null)}
          onCreated={(msg) => {
            setActionMessage(msg);
            setCreateDraft(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </>
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
      <Button variant="secondary" size="sm" onClick={onPrev}>
        ←
      </Button>
      <Button variant="secondary" size="sm" onClick={onToday} disabled={isToday}>
        Today
      </Button>
      <Button variant="secondary" size="sm" onClick={onNext}>
        →
      </Button>
      <span className="ml-3 text-sm font-medium text-slate-700">
        {display}
      </span>
    </div>
  );
}

// ============================================================
// Grid (resource columns × hour rows)
// ============================================================

const SNAP_MIN = 15;
const snapDown = (m) => Math.floor(m / SNAP_MIN) * SNAP_MIN;
const snapUp = (m) => Math.ceil(m / SNAP_MIN) * SNAP_MIN;

function Grid({ tz, loading, resources, itemsByResource, onItemClick, onSelectRange }) {
  // Click/drag-to-create. `drag` drives the ghost overlay; dragRef
  // mirrors it so the window-level mouseup handler reads the latest
  // value without re-subscribing on every mousemove.
  const [drag, setDrag] = useState(null); // { resourceId, resourceName, anchorMin, currentMin }
  const dragRef = useRef(null);
  const colRectRef = useRef(null);
  const boundsRef = useRef({ startMin: 0, endMin: 1440 });

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

  const { startMin: gridStart, endMin: gridEnd } = layout.bounds;
  boundsRef.current = layout.bounds;

  // Y pixel → tenant-local minute-of-day, clamped to the visible grid.
  function minuteFromY(clientY) {
    const rect = colRectRef.current;
    const { startMin, endMin } = boundsRef.current;
    const raw = (clientY - rect.top - 30) / PX_PER_MIN + startMin;
    return Math.max(startMin, Math.min(endMin, raw));
  }

  function beginDrag(e, resource) {
    if (e.button !== 0) return;
    // Presses on a booking/class card open the detail panel, not a draft.
    if (e.target.closest('button')) return;
    e.preventDefault(); // suppress text selection while dragging
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientY - rect.top < 30) return; // resource-name header row
    colRectRef.current = rect;
    const m = minuteFromY(e.clientY);
    const next = {
      resourceId: resource.id,
      resourceName: resource.name,
      anchorMin: m,
      currentMin: m,
    };
    dragRef.current = next;
    setDrag(next);
  }

  useEffect(() => {
    if (!drag) return undefined;
    function onMove(e) {
      if (!dragRef.current) return;
      const next = { ...dragRef.current, currentMin: minuteFromY(e.clientY) };
      dragRef.current = next;
      setDrag(next);
    }
    function onUp() {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      const a = Math.min(d.anchorMin, d.currentMin);
      const b = Math.max(d.anchorMin, d.currentMin);
      const dragged = b - a >= 8; // under ~8 minutes of travel = a click
      const startMin = snapDown(a);
      const endMin = dragged
        ? Math.min(Math.max(snapUp(b), startMin + SNAP_MIN), 1440)
        : Math.min(startMin + 60, 1440);
      if (startMin >= endMin) return;
      onSelectRange({
        resourceId: d.resourceId,
        resourceName: d.resourceName,
        startMin,
        endMin,
        dragged,
      });
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // Subscribe once per drag gesture; handlers read dragRef for the
    // latest position.
  }, [drag !== null]);

  if (resources.length === 0) {
    return (
      <p className="p-6 text-sm text-slate-500">
        {loading
          ? 'Loading calendar…'
          : 'No active resources to display. Add resources via the wizard or unhide them in the sidebar.'}
      </p>
    );
  }

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
            onMouseDown={(e) => beginDrag(e, r)}
            className="flex-1 min-w-[160px] border-r border-slate-200 relative cursor-crosshair select-none"
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

            {/* Drag-selection ghost */}
            {drag && drag.resourceId === r.id && (() => {
              const a = snapDown(Math.min(drag.anchorMin, drag.currentMin));
              const b = Math.max(
                snapUp(Math.max(drag.anchorMin, drag.currentMin)),
                a + SNAP_MIN,
              );
              return (
                <div
                  className="absolute left-0.5 right-0.5 z-10 rounded border-2 border-dashed border-sky-400 bg-sky-100/60 pointer-events-none"
                  style={{
                    top: 30 + (a - gridStart) * PX_PER_MIN,
                    height: (Math.min(b, gridEnd) - a) * PX_PER_MIN,
                  }}
                />
              );
            })()}
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
                    {/* Tenant tz, like every other time on this page —
                        bare toLocaleString() renders the VIEWER's zone. */}
                    {formatSlotLocal(item.cancelled_at, tz)}
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
                  <span className="ml-2">
                    <Badge tone="info">member</Badge>
                  </span>
                ) : (
                  <span className="ml-2">
                    <Badge tone="success">walk-in</Badge>
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
              <Button variant="secondary" onClick={cancel} disabled={busy}>
                {busy ? 'cancelling…' : 'Cancel booking'}
              </Button>
              {isPast && (
                <Button variant="danger" onClick={markNoShow} disabled={busy}>
                  Mark no-show
                </Button>
              )}
            </>
          )}
          {isClass && !item.cancelled_at && (
            <Button variant="danger" onClick={cancel} disabled={busy}>
              {busy ? 'cancelling…' : 'Cancel class (refund roster)'}
            </Button>
          )}
        </div>
      </aside>
    </div>
  );
}

function StatusBadge({ status }) {
  const { label, tone } = bookingStatusBadge(status);
  return <Badge tone={tone}>{label}</Badge>;
}

// ============================================================
// Create-booking modal (calendar click/drag target)
// ============================================================

function CreateBookingModal({ draft, dateStr, tz, onClose, onCreated }) {
  const [offerings, setOfferings] = useState(null);
  const [members, setMembers] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [offeringId, setOfferingId] = useState('');
  const [startMin, setStartMin] = useState(draft.startMin);
  const [endMin, setEndMin] = useState(draft.endMin);
  // A dragged window is an explicit choice — picking an offering must
  // not overwrite it. A clicked start keeps following the offering's
  // duration until the admin touches the end time herself.
  const [endTouched, setEndTouched] = useState(draft.dragged);
  const [who, setWho] = useState('member');
  const [memberQuery, setMemberQuery] = useState('');
  const [memberId, setMemberId] = useState('');
  const [customer, setCustomer] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api('/api/admin/offerings').then(handle),
      api('/api/admin/members').then(handle),
    ])
      .then(([o, m]) => {
        if (!alive) return;
        setOfferings(o.offerings ?? []);
        setMembers(m.members ?? []);
      })
      .catch((err) => {
        if (alive) setLoadError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rentals = useMemo(
    () => (offerings ?? []).filter((o) => o.active && o.capacity === 1),
    [offerings],
  );
  const selectedOffering = useMemo(
    () => rentals.find((o) => o.id === offeringId) ?? null,
    [rentals, offeringId],
  );

  // Clicked (not dragged) drafts: end follows the offering duration.
  useEffect(() => {
    if (!selectedOffering || endTouched) return;
    setEndMin(Math.min(startMin + selectedOffering.duration_minutes, 1440));
  }, [selectedOffering, startMin, endTouched]);

  const filteredMembers = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    const all = members ?? [];
    const matches = q
      ? all.filter((m) =>
          `${m.first_name} ${m.last_name} ${m.email}`.toLowerCase().includes(q),
        )
      : all;
    return matches.slice(0, 8);
  }, [members, memberQuery]);
  const selectedMember = (members ?? []).find((m) => m.id === memberId) ?? null;

  const durationMin = endMin - startMin;
  const isCustomLength =
    selectedOffering && durationMin !== selectedOffering.duration_minutes;
  const ready =
    offeringId &&
    (who === 'member'
      ? memberId
      : customer.first_name.trim() &&
        customer.last_name.trim() &&
        customer.email.trim());

  function shiftStart(newStart) {
    const len = endMin - startMin;
    setStartMin(newStart);
    setEndMin(Math.min(newStart + len, 1440));
  }

  async function submit(e) {
    e.preventDefault();
    if (submitting || !ready) return;
    setSubmitting(true);
    setError(null);
    try {
      const start_time = zonedTimeToUtc(dateStr, minToHHMM(startMin), tz).toISOString();
      const end_time =
        endMin === 1440
          ? zonedTimeToUtc(nextDateStr(dateStr), '00:00', tz).toISOString()
          : zonedTimeToUtc(dateStr, minToHHMM(endMin), tz).toISOString();
      const body = {
        offering_id: offeringId,
        resource_id: draft.resourceId,
        start_time,
        end_time,
        ...(who === 'member'
          ? { member_id: memberId }
          : {
              customer: {
                first_name: customer.first_name.trim(),
                last_name: customer.last_name.trim(),
                email: customer.email.trim(),
                ...(customer.phone.trim() ? { phone: customer.phone.trim() } : {}),
              },
            }),
      };
      const res = await api('/api/admin/bookings', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const resBody = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(resBody.error || `HTTP ${res.status}`);
      const whoLabel =
        who === 'member'
          ? `${selectedMember.first_name} ${selectedMember.last_name} (${resBody.balance_after ?? '—'} credits left)`
          : `${customer.first_name.trim()} ${customer.last_name.trim()} — ${formatCents(selectedOffering.dollar_price)} due on arrival`;
      onCreated(
        `Booked ${selectedOffering.name} on ${draft.resourceName}, ${minuteLabel(startMin)}–${minuteLabel(endMin)} for ${whoLabel}`,
      );
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  const startOptions = [];
  for (let m = 0; m <= 1440 - SNAP_MIN; m += SNAP_MIN) startOptions.push(m);
  const endOptions = [];
  for (let m = startMin + SNAP_MIN; m <= 1440; m += SNAP_MIN) endOptions.push(m);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/30"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative w-full max-w-lg rounded-lg bg-white shadow-xl border border-slate-200 p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold">New booking</h2>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          {draft.resourceName} · {calendarDayLabel(dateStr)}
        </p>

        {loadError && (
          <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {loadError}
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          {/* Time window */}
          <div className="flex items-end gap-2">
            <Field label="Start">
              <Select
                value={startMin}
                onChange={(e) => shiftStart(Number(e.target.value))}
              >
                {startOptions.map((m) => (
                  <option key={m} value={m}>
                    {minuteLabel(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <span className="pb-2 text-slate-400">–</span>
            <Field label="End">
              <Select
                value={endMin}
                onChange={(e) => {
                  setEndTouched(true);
                  setEndMin(Number(e.target.value));
                }}
              >
                {endOptions.map((m) => (
                  <option key={m} value={m}>
                    {minuteLabel(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <span className="pb-2 text-xs text-slate-500">
              {durationMin} min
            </span>
          </div>

          {/* Offering */}
          <Field label="Offering">
            <Select
              value={offeringId}
              onChange={(e) => setOfferingId(e.target.value)}
              required
            >
              <option value="">
                {offerings === null ? 'loading…' : 'Select an offering…'}
              </option>
              {rentals.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {o.duration_minutes} min · {o.credit_cost} cr /{' '}
                  {formatCents(o.dollar_price)}
                </option>
              ))}
            </Select>
          </Field>
          {isCustomLength && (
            <p className="text-xs text-amber-700">
              Custom length: {durationMin} min instead of the offering's{' '}
              {selectedOffering.duration_minutes} min. Price/credits stay
              flat.
            </p>
          )}

          {/* Who */}
          <div>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={who === 'member'}
                  onChange={() => setWho('member')}
                />
                Member
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={who === 'walkin'}
                  onChange={() => setWho('walkin')}
                />
                Walk-in
              </label>
            </div>

            {who === 'member' ? (
              <div className="mt-2 space-y-1.5">
                <Input
                  type="search"
                  placeholder="Search members by name or email…"
                  value={memberQuery}
                  onChange={(e) => setMemberQuery(e.target.value)}
                />
                <div className="max-h-40 overflow-y-auto rounded border border-slate-200 divide-y divide-slate-100">
                  {members === null ? (
                    <p className="px-3 py-2 text-sm text-slate-400">loading…</p>
                  ) : filteredMembers.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-slate-500">
                      No members match.
                    </p>
                  ) : (
                    filteredMembers.map((m) => (
                      <label
                        key={m.id}
                        className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer ${
                          memberId === m.id ? 'bg-slate-100' : 'hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="radio"
                          checked={memberId === m.id}
                          onChange={() => setMemberId(m.id)}
                        />
                        <span className="truncate">
                          {m.first_name} {m.last_name}
                          <span className="ml-1 text-xs text-slate-400">
                            {m.email}
                          </span>
                        </span>
                        <span className="ml-auto shrink-0 text-xs text-slate-500 tabular-nums">
                          {m.current_credits} cr
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Input
                  placeholder="First name"
                  value={customer.first_name}
                  onChange={(e) =>
                    setCustomer({ ...customer, first_name: e.target.value })
                  }
                />
                <Input
                  placeholder="Last name"
                  value={customer.last_name}
                  onChange={(e) =>
                    setCustomer({ ...customer, last_name: e.target.value })
                  }
                />
                <Input
                  type="email"
                  placeholder="Email"
                  value={customer.email}
                  onChange={(e) =>
                    setCustomer({ ...customer, email: e.target.value })
                  }
                />
                <Input
                  type="tel"
                  placeholder="Phone (optional)"
                  value={customer.phone}
                  onChange={(e) =>
                    setCustomer({ ...customer, phone: e.target.value })
                  }
                />
              </div>
            )}
          </div>

          {/* Price summary */}
          {selectedOffering && (
            <p className="text-sm text-slate-600">
              {who === 'member' ? (
                selectedMember ? (
                  <>
                    Will charge{' '}
                    <span className="font-medium">
                      {selectedOffering.credit_cost} credit
                      {selectedOffering.credit_cost === 1 ? '' : 's'}
                    </span>{' '}
                    ({selectedMember.first_name} has{' '}
                    {selectedMember.current_credits})
                  </>
                ) : (
                  <>Select a member to charge {selectedOffering.credit_cost} credits.</>
                )
              ) : (
                <>
                  <span className="font-medium">
                    {formatCents(selectedOffering.dollar_price)}
                  </span>{' '}
                  due — cash on arrival
                </>
              )}
            </p>
          )}

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              Booking failed: {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || submitting}>
              {submitting ? 'Booking…' : 'Create booking'}
            </Button>
          </div>
        </form>
      </div>
    </div>
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

// Minute-of-day → "2:15 PM". 1440 renders as "12:00 AM" (midnight at
// the end of the day — only reachable as an end time).
function minuteLabel(min) {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

// Minute-of-day → "HH:MM" for zonedTimeToUtc.
function minToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// YYYY-MM-DD + 1 day, in pure UTC math (no local-zone drift).
function nextDateStr(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// "Sat, Jul 18" for the modal subtitle. dateStr is already the
// tenant-local calendar date; format at noon UTC so it can't drift.
function calendarDayLabel(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
