// Member class browser + booking.
//
// One screen, one decision: "I want a spot in that class." Lists
// upcoming class instances grouped by date, click to book. The
// member's own class bookings show on MemberHome alongside rentals;
// no need to dupe them here.
//
// Pagination / filters can come later. For phase 4 the default
// (next 60 days, all member-bookable offerings) covers the use
// case.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Header from '../components/Header.jsx';
import { formatTimeLocal } from '../format.js';

export default function ClassesPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const tz = me.tenant.timezone;

  const [instances, setInstances] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [submitting, setSubmitting] = useState(null); // class_instance_id while booking
  const [submitError, setSubmitError] = useState(null);

  function load() {
    setLoadError(null);
    api('/api/class-instances')
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => setInstances(data.class_instances ?? []))
      .catch((err) => setLoadError(err.message));
  }

  useEffect(load, []);

  // Group instances by their tenant-local date so the UI can render a
  // day-of-week heading per group.
  const grouped = useMemo(() => {
    if (!instances) return null;
    const m = new Map();
    for (const ci of instances) {
      const local = new Date(ci.start_time).toLocaleDateString('en-US', {
        timeZone: tz,
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      if (!m.has(local)) m.set(local, []);
      m.get(local).push(ci);
    }
    return Array.from(m.entries());
  }, [instances, tz]);

  async function bookInstance(ci) {
    if (submitting) return;
    setSubmitting(ci.id);
    setSubmitError(null);
    try {
      const res = await api('/api/class-bookings', {
        method: 'POST',
        body: JSON.stringify({ class_instance_id: ci.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await refresh(); // pull fresh credit balance
      navigate('/');
    } catch (err) {
      setSubmitError(err.message);
      setSubmitting(null);
    }
  }

  if (!me.memberships.member) {
    return (
      <div className="min-h-screen bg-slate-50">
        <Header />
        <main className="max-w-2xl mx-auto p-6">
          <p className="text-slate-700">
            Class booking requires a member account. Contact an admin
            to be added as a member.
          </p>
          <Link
            to="/"
            className="mt-4 inline-block text-sm text-sky-700 hover:underline"
          >
            ← Back home
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-3xl mx-auto p-6 space-y-6">
        <div>
          <Link to="/" className="text-sm text-sky-700 hover:underline">
            ← Back
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">Classes</h1>
          <p className="text-sm text-slate-500">
            Times shown in {tz}. Available credits:{' '}
            <span className="font-medium text-slate-800">
              {me.credits?.current_credits ?? 0}
            </span>
          </p>
        </div>

        {loadError && (
          <div className="rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800">
            {loadError}
          </div>
        )}

        {submitError && (
          <div className="rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800">
            Booking failed: {submitError}
          </div>
        )}

        {grouped === null ? (
          <p className="text-sm text-slate-400">loading…</p>
        ) : grouped.length === 0 ? (
          <p className="text-sm text-slate-500">
            No classes scheduled in the next 60 days.
          </p>
        ) : (
          <div className="space-y-5">
            {grouped.map(([dayLabel, list]) => (
              <section key={dayLabel}>
                <h2 className="text-sm font-medium text-slate-700 mb-2">
                  {dayLabel}
                </h2>
                <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
                  {list.map((ci) => {
                    const full = ci.spots_remaining <= 0;
                    return (
                      <li
                        key={ci.id}
                        className="flex items-center justify-between px-4 py-3"
                      >
                        <div>
                          <div className="font-medium">
                            {ci.offering_name}
                            <span className="ml-2 text-sm font-normal text-slate-500">
                              {ci.resource_name}
                            </span>
                          </div>
                          <div className="text-sm text-slate-600">
                            {formatTimeLocal(ci.start_time, tz)} ·{' '}
                            {ci.duration_minutes} min ·{' '}
                            {ci.credit_cost} credit
                            {ci.credit_cost === 1 ? '' : 's'}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-sm">
                          <span
                            className={`tabular-nums ${full ? 'text-rose-700' : 'text-slate-600'}`}
                          >
                            {full
                              ? 'full'
                              : `${ci.spots_remaining}/${ci.capacity} open`}
                          </span>
                          <button
                            onClick={() => bookInstance(ci)}
                            disabled={full || submitting === ci.id}
                            className="rounded bg-sky-700 px-3 py-1 text-xs font-medium text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {submitting === ci.id ? 'booking…' : 'Book'}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
