// Admin home — the operating dashboard: what's happening today, the
// handful of numbers an operator checks daily, and quick paths to the
// three most common actions.
//
// Catalog management (resources / offerings / plans) lives on
// /admin/catalog; people on /admin/members and /admin/staff; hours
// and policies under Settings. This page deliberately shows none of
// that config (UI-declutter pass).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, UserPlus, Package } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Page, PageHeader, Card, Button, Badge } from '../components/ui/index.js';
import {
  bookingStatusBadge,
  formatCents,
  formatTimeLocal,
} from '../format.js';
import { addDays, todayLocalString, zonedDayStartIso } from '../lib/tz.js';

export default function AdminHome() {
  const { me, tenant } = useAuth();
  const tz = tenant.timezone;
  const [summary, setSummary] = useState(null);
  const [today, setToday] = useState(null);
  const [setupIncomplete, setSetupIncomplete] = useState(false);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    const todayStr = todayLocalString(tz);
    const from = zonedDayStartIso(todayStr, tz);
    const to = zonedDayStartIso(addDays(todayStr, 1), tz);
    Promise.all([
      api('/api/admin/reports/summary').then(handle),
      api(
        `/api/admin/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ).then(handle),
      // Only to decide whether to show the first-run setup banner.
      api('/api/admin/resources').then(handle),
    ])
      .then(([s, b, r]) => {
        setSummary(s);
        setToday(
          (b.bookings ?? []).filter((bk) => bk.status !== 'cancelled'),
        );
        setSetupIncomplete((r.resources ?? []).length === 0);
      })
      .catch((err) => setLoadError(err.message));
  }, [tz]);

  const dateLine = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  });

  return (
    <Page width="default">
      <PageHeader
        title={`Welcome back${me.user?.first_name ? `, ${me.user.first_name}` : ''}`}
        description={dateLine}
        actions={
          <Button as={Link} to="/admin/calendar">
            <CalendarDays className="h-4 w-4" /> Open calendar
          </Button>
        }
      />

      {setupIncomplete && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-brand-200 bg-brand-50 p-4">
          <div>
            <div className="font-semibold text-slate-900">
              Set up your facility
            </div>
            <div className="text-sm text-slate-600">
              Add your resources, offerings, and plans in five quick steps.
            </div>
          </div>
          <Button as={Link} to="/wizard">
            Start setup wizard
          </Button>
        </div>
      )}

      {loadError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Today"
          value={today === null ? '…' : today.length}
          detail="bookings"
        />
        <StatTile
          label="Next 7 days"
          value={summary?.upcomingBookings7d ?? '…'}
          detail="upcoming bookings"
        />
        <StatTile
          label="Active members"
          value={summary?.activeMembers ?? '…'}
          detail="with a subscription"
        />
        <StatTile
          label="Revenue this month"
          value={
            summary ? formatCents(summary.revenueThisMonthCents) : '…'
          }
          detail="walk-ins + packs"
        />
      </div>

      <Card padded={false} title="Today's schedule">
        {today === null ? (
          <p className="px-5 py-4 text-sm text-slate-400">loading…</p>
        ) : today.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-slate-500">
              Nothing booked today{setupIncomplete ? ' yet' : ''}.
            </p>
            <p className="mt-1 text-sm">
              <Link
                to="/admin/calendar"
                className="font-medium text-brand-600 hover:text-brand-500"
              >
                Open the calendar to add a booking →
              </Link>
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {today.map((b) => (
              <li key={b.id} className="flex items-center gap-4 px-5 py-3">
                <div className="w-20 shrink-0 text-sm font-semibold text-slate-900">
                  {formatTimeLocal(b.start_time, tz)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900">
                    {bookingName(b)}
                  </div>
                  <div className="truncate text-xs text-slate-500">
                    {b.offering_name} · {b.resource_name}
                  </div>
                </div>
                <StatusBadge status={b.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <QuickAction
          to="/admin/members"
          icon={UserPlus}
          title="Add a member"
          detail="Create an account and grant credits"
        />
        <QuickAction
          to="/admin/catalog"
          icon={Package}
          title="Manage catalog"
          detail="Resources, offerings, and plans"
        />
        <QuickAction
          to="/admin/reports"
          icon={CalendarDays}
          title="View reports"
          detail={
            summary
              ? `${summary.creditLiability} credits outstanding`
              : 'Revenue, bookings, exports'
          }
        />
      </div>
    </Page>
  );
}

function bookingName(b) {
  if (b.member_first_name) {
    return `${b.member_first_name} ${b.member_last_name ?? ''}`.trim();
  }
  if (b.customer_first_name) {
    return `${b.customer_first_name} ${b.customer_last_name ?? ''} (walk-in)`.trim();
  }
  return 'Walk-in';
}

function StatusBadge({ status }) {
  const { label, tone } = bookingStatusBadge(status);
  return <Badge tone={tone}>{label}</Badge>;
}

function StatTile({ label, value, detail }) {
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-3xl font-semibold text-slate-900">{value}</div>
      <div className="mt-0.5 text-xs text-slate-400">{detail}</div>
    </Card>
  );
}

function QuickAction({ to, icon: Icon, title, detail }) {
  return (
    <Link to={to}>
      <Card className="h-full transition-colors hover:border-brand-300">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-brand-50 p-2 text-brand-600">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">{title}</div>
            <div className="mt-0.5 text-xs text-slate-500">{detail}</div>
          </div>
        </div>
      </Card>
    </Link>
  );
}

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
