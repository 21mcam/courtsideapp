// Member booking flow.
//
// Single page, three sequential decisions:
//   1. Offering — what kind of session (cage, sim bay, etc.)
//   2. Resource — which physical thing to use (Cage 1 vs Cage 2)
//   3. Date + slot — pick a day, see available slots, click to book
//
// State machine is intentionally linear: changing the offering resets
// resource and slot, changing the resource resets the slot, changing
// the date refetches slots. No "back" button — picking a different
// option higher up just clears downstream state.
//
// All times rendered in the tenant's timezone (Header shows the
// tenant; we read tz from the auth context). Slots come from
// /api/availability as UTC ISO strings; we format with
// Intl.DateTimeFormat and the tenant's IANA tz.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Header from '../components/Header.jsx';
import { formatTimeLocal } from '../format.js';

// Returns the tenant-local YYYY-MM-DD for "today" (or +N days), so
// the date input defaults to a sensible day in the tenant's zone
// even if the browser is on a different one.
function tenantLocalDate(tz, daysFromNow = 0) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + daysFromNow);
  // Use Intl to get the parts in tenant tz, then assemble YYYY-MM-DD.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

export default function BookingPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const tz = me.tenant.timezone;

  const [offerings, setOfferings] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [selectedOfferingId, setSelectedOfferingId] = useState('');
  const [selectedResourceId, setSelectedResourceId] = useState('');
  const [date, setDate] = useState(() => tenantLocalDate(tz));

  const [slots, setSlots] = useState(null);
  const [slotsError, setSlotsError] = useState(null);
  const [slotsReason, setSlotsReason] = useState(null);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // Load offerings on mount.
  useEffect(() => {
    api('/api/bookings/offerings')
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => setOfferings(data.offerings ?? []))
      .catch((err) => setLoadError(err.message));
  }, []);

  const selectedOffering = useMemo(
    () => (offerings ?? []).find((o) => o.id === selectedOfferingId) ?? null,
    [offerings, selectedOfferingId],
  );

  // When the offering changes, default the resource to the first one
  // (or clear if the new offering has none). When it clears, slot
  // listing also clears.
  useEffect(() => {
    if (!selectedOffering) {
      setSelectedResourceId('');
      return;
    }
    const first = selectedOffering.resources[0]?.id ?? '';
    setSelectedResourceId(first);
    // selectedOffering is derived from selectedOfferingId via useMemo,
    // so depending on selectedOfferingId is sufficient.
  }, [selectedOfferingId, selectedOffering]);

  // Fetch slots whenever (offering, resource, date) is fully picked.
  useEffect(() => {
    if (!selectedOfferingId || !selectedResourceId || !date) {
      setSlots(null);
      setSlotsReason(null);
      return;
    }
    let cancelled = false;
    setLoadingSlots(true);
    setSlotsError(null);
    setSlotsReason(null);
    api(
      `/api/availability?offering_id=${selectedOfferingId}&resource_id=${selectedResourceId}&date=${date}`,
    )
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setSlots(data.slots ?? []);
        setSlotsReason(data.reason ?? null);
      })
      .catch((err) => {
        if (!cancelled) setSlotsError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingSlots(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedOfferingId, selectedResourceId, date]);

  async function bookSlot(slot) {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api('/api/bookings', {
        method: 'POST',
        body: JSON.stringify({
          offering_id: selectedOfferingId,
          resource_id: selectedResourceId,
          start_time: slot.start,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      // Refresh /api/me so the credit balance on the home page is
      // correct, then navigate back.
      await refresh();
      navigate('/');
    } catch (err) {
      setSubmitError(err.message);
      setSubmitting(false);
    }
  }

  if (!me.memberships.member) {
    return (
      <div className="min-h-screen bg-slate-50">
        <Header />
        <main className="max-w-2xl mx-auto p-6">
          <p className="text-slate-700">
            Booking requires a member account. Contact an admin to be
            added as a member.
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
      <main className="max-w-2xl mx-auto p-6 space-y-6">
        <div>
          <Link to="/" className="text-sm text-sky-700 hover:underline">
            ← Back
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">Book a session</h1>
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

        {/* Offering picker */}
        <section>
          <label className="block text-sm font-medium text-slate-700">
            What would you like to book?
          </label>
          {offerings === null ? (
            <p className="mt-2 text-sm text-slate-400">loading…</p>
          ) : offerings.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              No member-bookable offerings configured yet.
            </p>
          ) : (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {offerings.map((o) => (
                <button
                  key={o.id}
                  onClick={() => setSelectedOfferingId(o.id)}
                  className={`text-left rounded border px-3 py-2 transition ${
                    selectedOfferingId === o.id
                      ? 'border-sky-700 bg-sky-50'
                      : 'border-slate-200 bg-white hover:border-slate-400'
                  }`}
                >
                  <div className="font-medium">{o.name}</div>
                  <div className="text-xs text-slate-500">
                    {o.duration_minutes} min · {o.credit_cost} credit
                    {o.credit_cost === 1 ? '' : 's'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Resource picker — only if the offering has multiple resources */}
        {selectedOffering && selectedOffering.resources.length > 1 && (
          <section>
            <label className="block text-sm font-medium text-slate-700">
              Which {selectedOffering.name}?
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              {selectedOffering.resources.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedResourceId(r.id)}
                  className={`rounded border px-3 py-1 text-sm transition ${
                    selectedResourceId === r.id
                      ? 'border-sky-700 bg-sky-50'
                      : 'border-slate-200 bg-white hover:border-slate-400'
                  }`}
                >
                  {r.name}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Date picker */}
        {selectedOffering && selectedOffering.resources.length === 0 && (
          <p className="text-sm text-slate-500">
            This offering isn't currently linked to any active resources.
            Ask an admin to link one.
          </p>
        )}

        {selectedOffering && selectedResourceId && (
          <section>
            <label
              htmlFor="booking-date"
              className="block text-sm font-medium text-slate-700"
            >
              Date
            </label>
            <input
              id="booking-date"
              type="date"
              value={date}
              min={tenantLocalDate(tz)}
              onChange={(e) => setDate(e.target.value)}
              className="mt-2 rounded border border-slate-300 px-3 py-1 text-sm"
            />
          </section>
        )}

        {/* Slots */}
        {selectedOffering && selectedResourceId && date && (
          <section>
            <h2 className="text-sm font-medium text-slate-700">
              Available times
            </h2>
            {loadingSlots ? (
              <p className="mt-2 text-sm text-slate-400">loading…</p>
            ) : slotsError ? (
              <p className="mt-2 text-sm text-rose-700">{slotsError}</p>
            ) : slots && slots.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">
                No open slots on this day.
                {slotsReason && (
                  <span className="ml-1 text-slate-400">({slotsReason})</span>
                )}
              </p>
            ) : slots ? (
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {slots.map((s) => (
                  <button
                    key={s.start}
                    disabled={submitting}
                    onClick={() => bookSlot(s)}
                    className="rounded border border-slate-300 bg-white px-2 py-2 text-sm hover:border-sky-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {formatTimeLocal(s.start, tz)}
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        )}

        {submitError && (
          <div className="rounded border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800">
            Booking failed: {submitError}
          </div>
        )}
      </main>
    </div>
  );
}
