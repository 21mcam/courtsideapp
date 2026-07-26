// Admin → Reports (Tier-A sell-readiness slice).
//
// Stat tiles from GET /api/admin/reports/summary, a revenue
// breakdown that's honest about which streams are tracked (nulls
// render as "not tracked" instead of a lying zero), and CSV
// downloads for the member roster and bookings.
//
// CSV downloads go through the api() wrapper (auth header + tenant
// query fallback) and a temporary object-URL anchor — a plain
// <a href> can't carry the Bearer token.

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatCents } from '../format.js';
import {
  Button,
  Card,
  Field,
  Input,
  Page,
  PageHeader,
} from '../components/ui/index.js';
import { addDays, todayLocalString } from '../lib/tz.js';

export default function AdminReports() {
  const { me } = useAuth();
  const tz = me.tenant.timezone;
  const [summary, setSummary] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [downloadError, setDownloadError] = useState(null);
  const [downloading, setDownloading] = useState(null); // 'members' | 'bookings'
  // Bookings export range — tenant-local dates, default last 90 days.
  const [from, setFrom] = useState(() => addDays(todayLocalString(tz), -90));
  const [to, setTo] = useState(() => todayLocalString(tz));

  useEffect(() => {
    api('/api/admin/reports/summary')
      .then(handle)
      .then(setSummary)
      .catch((err) => setLoadError(err.message));
  }, []);

  async function download(kind, path, filename) {
    setDownloadError(null);
    setDownloading(kind);
    try {
      const res = await api(path);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err.message);
    } finally {
      setDownloading(null);
    }
  }

  const today = todayLocalString(tz);

  return (
    <Page width="default">
      <PageHeader
        title="Reports"
        description="Bookings, membership, and revenue at a glance — plus CSV exports for your spreadsheet."
      />

      {loadError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile
          label="Active members"
          value={summary?.activeMembers}
          sub="with a subscription"
        />
        <StatTile
          label="Bookings this week"
          value={summary?.bookingsThisWeek}
          sub="Mon–Sun, excl. cancelled"
        />
        <StatTile label="Bookings last week" value={summary?.bookingsLastWeek} />
        <StatTile
          label="Upcoming"
          value={summary?.upcomingBookings7d}
          sub="next 7 days"
        />
        <StatTile
          label="Credit liability"
          value={summary?.creditLiability}
          sub="outstanding credits"
        />
      </div>

      <Card title="Revenue this month">
        {summary === null ? (
          <p className="text-sm text-slate-400">loading…</p>
        ) : (
          <>
            <div className="text-3xl font-semibold text-slate-900">
              {formatCents(summary.revenueThisMonthCents)}
            </div>
            <p className="mt-1 text-sm text-slate-500">
              Tracked payments recorded since the 1st ({tz} time). Streams
              marked "not tracked" move money on Stripe but aren't recorded
              here yet, so the true total is at least this much.
            </p>
            <dl className="mt-4 grid max-w-md grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <dt className="text-slate-500">Walk-in payments</dt>
              <dd>{streamValue(summary.revenueBreakdown.walkIns)}</dd>
              <dt className="text-slate-500">Credit packs</dt>
              <dd>{streamValue(summary.revenueBreakdown.packs)}</dd>
              <dt className="text-slate-500">Subscriptions</dt>
              <dd>{streamValue(summary.revenueBreakdown.subscriptions)}</dd>
            </dl>
          </>
        )}
      </Card>

      <Card title="Exports">
        {downloadError && (
          <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {downloadError}
          </div>
        )}

        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-900">
                Member roster
              </div>
              <div className="text-sm text-slate-500">
                All members with credits, subscription status, and plan.
              </div>
            </div>
            <Button
              variant="secondary"
              disabled={downloading !== null}
              onClick={() =>
                download(
                  'members',
                  '/api/admin/reports/members.csv',
                  `members-${today}.csv`,
                )
              }
            >
              <Download size={16} />
              {downloading === 'members' ? 'downloading…' : 'Members CSV'}
            </Button>
          </div>

          <div className="border-t border-slate-100 pt-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <div className="text-sm font-medium text-slate-900">
                    Bookings
                  </div>
                  <div className="text-sm text-slate-500">
                    One row per booking in the date range.
                  </div>
                </div>
                <Field label="From" className="w-40">
                  <Input
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </Field>
                <Field label="To" className="w-40">
                  <Input
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </Field>
              </div>
              <Button
                variant="secondary"
                disabled={downloading !== null || !from || !to || from > to}
                onClick={() =>
                  download(
                    'bookings',
                    `/api/admin/reports/bookings.csv?from=${from}&to=${to}`,
                    `bookings-${from}-to-${to}.csv`,
                  )
                }
              >
                <Download size={16} />
                {downloading === 'bookings' ? 'downloading…' : 'Bookings CSV'}
              </Button>
            </div>
            {from && to && from > to && (
              <p className="mt-2 text-sm text-rose-600">
                "From" must not be after "To".
              </p>
            )}
          </div>
        </div>
      </Card>
    </Page>
  );
}

function streamValue(cents) {
  if (cents == null) {
    return <span className="text-slate-400">not tracked yet</span>;
  }
  return formatCents(cents);
}

function StatTile({ label, value, sub }) {
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-3xl font-semibold text-slate-900">
        {value ?? '—'}
      </div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </Card>
  );
}

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
