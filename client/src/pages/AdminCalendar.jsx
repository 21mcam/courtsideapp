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

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { bookingStatusBadge, formatTimeLocal } from '../format.js';

// Y-axis range: 06:00 to 23:00 local. Outside this range, anything
// in the data shows clipped to the edge. If a tenant runs 24h ops
// later we make this configurable.
const DAY_START_MIN = 6 * 60;
const DAY_END_MIN = 23 * 60;
const TOTAL_MIN = DAY_END_MIN - DAY_START_MIN;
const PX_PER_MIN = 1.0; // 1px per minute → 1020px tall grid (roughly)

export default function AdminCalendar() {
  const { me } = useAuth();
  const tz = me.tenant.timezone;

  // YYYY-MM-DD string in tenant local. Init to today.
  const [dateStr, setDateStr] = useState(() => todayLocalString(tz));

  const [resources, setResources] = useState(null);
  const [bookings, setBookings] = useState(null);
  const [classInstances, setClassInstances] = useState(null);
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

  function load() {
    setLoadError(null);
    Promise.all([
      api('/api/admin/resources').then(handle),
      api(
        `/api/admin/bookings?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
      ).then(handle),
      api(
        `/api/admin/class-instances?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
      ).then(handle),
    ])
      .then(([r, b, c]) => {
        setResources(r.resources ?? []);
        setBookings(b.bookings ?? []);
        setClassInstances(c.class_instances ?? []);
      })
      .catch((err) => setLoadError(err.message));
  }

  // Reload whenever the date window changes. `load` closes over
  // setState setters which are stable per React semantics; deps
  // only need to track the inputs that change the fetched data.
  useEffect(() => {
    load();
    // load is intentionally not in deps — it's a stable closure
    // over setState setters, and re-creating it every render would
    // refetch on every re-render.
  }, [fromIso, toIso]);

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

  // Group items by resource_id for column rendering
  const itemsByResource = useMemo(() => {
    const m = new Map();
    for (const r of visibleResources) m.set(r.id, []);
    for (const b of dayBookings) {
      const list = m.get(b.resource_id);
      if (list) list.push({ kind: 'booking', ...b });
    }
    for (const ci of dayClassInstances) {
      const list = m.get(ci.resource_id);
      if (list)
        list.push({
          kind: 'class',
          ...ci,
          // Normalize so card render uses .display_name
          display_name: ci.offering_name,
          subtitle: `${ci.roster_count}/${ci.capacity}`,
        });
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

          {/* Calendar grid */}
          <div className="flex-1 overflow-x-auto rounded border border-slate-200 bg-white">
            <Grid
              tz={tz}
              resources={visibleResources}
              itemsByResource={itemsByResource}
              onItemClick={setSelectedItem}
            />
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
            load();
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
  const display = new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
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

function Grid({ tz, resources, itemsByResource, onItemClick }) {
  if (resources.length === 0) {
    return (
      <p className="p-6 text-sm text-slate-500">
        No active resources to display. Add resources via the wizard or
        unhide them in the sidebar.
      </p>
    );
  }

  const totalHeight = TOTAL_MIN * PX_PER_MIN;
  const hourLines = [];
  for (let m = DAY_START_MIN; m <= DAY_END_MIN; m += 60) {
    hourLines.push(m);
  }

  return (
    <div className="flex" style={{ minWidth: `${120 + resources.length * 160}px` }}>
      {/* Time gutter */}
      <div className="w-16 shrink-0 border-r border-slate-200 relative" style={{ height: totalHeight + 30 }}>
        <div className="h-[30px] border-b border-slate-200 text-[10px] uppercase text-slate-400 flex items-center justify-end pr-2">
          {tz.split('/')[1] ? tz.split('/')[1].slice(0, 3) : 'UTC'}
        </div>
        {hourLines.map((m) => (
          <div
            key={m}
            className="absolute right-2 text-xs text-slate-500"
            style={{ top: 30 + (m - DAY_START_MIN) * PX_PER_MIN - 6 }}
          >
            {formatHourLabel(m)}
          </div>
        ))}
      </div>

      {/* Resource columns */}
      {resources.map((r) => (
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
              style={{ top: 30 + (m - DAY_START_MIN) * PX_PER_MIN }}
            />
          ))}

          {/* Booking + class cards */}
          {(itemsByResource.get(r.id) ?? []).map((item) => {
            const startMin = localMinutesOfDay(item.start_time, tz);
            const endMin = localMinutesOfDay(item.end_time, tz);
            const top = 30 + (startMin - DAY_START_MIN) * PX_PER_MIN;
            const height = Math.max(20, (endMin - startMin) * PX_PER_MIN);

            // Skip items entirely outside the visible range
            if (endMin < DAY_START_MIN || startMin > DAY_END_MIN) return null;

            return (
              <Card
                key={`${item.kind}:${item.id}`}
                item={item}
                tz={tz}
                top={top}
                height={height}
                onClick={() => onItemClick(item)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Card({ item, tz, top, height, onClick }) {
  const isClass = item.kind === 'class';
  const isCancelled = isClass ? !!item.cancelled_at : item.status === 'cancelled';

  // Color: classes purple-ish, member bookings sky-blue, walk-in
  // bookings emerald, pending_payment amber, cancelled muted.
  let palette;
  if (isCancelled) palette = 'bg-slate-100 text-slate-500 border-slate-300 line-through';
  else if (isClass) palette = 'bg-violet-100 text-violet-900 border-violet-300';
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

  return (
    <button
      onClick={onClick}
      className={`absolute left-1 right-1 rounded border-l-4 px-2 py-1 text-left text-xs hover:brightness-95 ${palette} overflow-hidden`}
      style={{ top, height }}
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
              <button
                onClick={markNoShow}
                disabled={busy}
                className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                Mark no-show
              </button>
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
