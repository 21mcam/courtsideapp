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
// All times rendered in the tenant's timezone (the shell shows the
// tenant; we read tz from the auth context). Slots come from
// /api/availability as UTC ISO strings; we format with
// Intl.DateTimeFormat and the tenant's IANA tz.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  formatNoSlotsReason,
  formatTimeLocal,
  formatTimezoneLabel,
} from '../format.js';
import WaiverModal from '../components/WaiverModal.jsx';
import {
  Page,
  PageHeader,
  Card,
  Button,
  Badge,
  Field,
  Input,
  cn,
} from '../components/ui/index.js';

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

function StepLabel({ children }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </p>
  );
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

  const [selectedSlotStart, setSelectedSlotStart] = useState(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  // Slot held aside while the waiver modal is open — the booking is
  // retried automatically after signing.
  const [waiverSlot, setWaiverSlot] = useState(null);

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

  // The selected slot is only honored while it exists in the current
  // slot list — changing offering/resource/date refetches slots, so a
  // stale selection simply stops rendering as selected.
  const selectedSlot = useMemo(
    () => (slots ?? []).find((s) => s.start === selectedSlotStart) ?? null,
    [slots, selectedSlotStart],
  );

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
        // Waiver gate: open the signing modal instead of erroring;
        // the booking retries automatically once signed.
        if (res.status === 409 && body.code === 'waiver_signature_required') {
          setWaiverSlot(slot);
          setSubmitting(false);
          return;
        }
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
      <Page width="narrow">
        <PageHeader title="Book" />
        <Card>
          <p className="text-sm text-slate-600">
            Booking requires a member account. Ask at the front desk to
            get set up.
          </p>
        </Card>
      </Page>
    );
  }

  return (
    <Page width="narrow">
      <PageHeader
        title="Book"
        description={
          <>
            Times shown in {formatTimezoneLabel(tz)}. Available credits:{' '}
            <span className="font-medium text-slate-800">
              {me.credits?.current_credits ?? 0}
            </span>
          </>
        }
      />

      {loadError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {loadError}
        </div>
      )}

      {/* Offering picker */}
      <Card>
        <StepLabel>Step 1 · What would you like to book?</StepLabel>
        {offerings === null ? (
          <p className="mt-3 text-sm text-slate-400">loading…</p>
        ) : offerings.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
            Online booking isn't set up yet — check back soon or ask at
            the front desk.
          </div>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {offerings.map((o) => (
              <button
                key={o.id}
                onClick={() => setSelectedOfferingId(o.id)}
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-left transition',
                  selectedOfferingId === o.id
                    ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600'
                    : 'border-slate-200 bg-white hover:bg-slate-50',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-900">{o.name}</span>
                  <Badge tone="brand">
                    {o.credit_cost} credit
                    {o.credit_cost === 1 ? '' : 's'}
                  </Badge>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {o.duration_minutes} min
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* Resource picker — only if the offering has multiple resources */}
      {selectedOffering && selectedOffering.resources.length > 1 && (
        <Card>
          <StepLabel>Step 2 · Which {selectedOffering.name}?</StepLabel>
          <div className="mt-3 flex flex-wrap gap-2">
            {selectedOffering.resources.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedResourceId(r.id)}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-sm transition',
                  selectedResourceId === r.id
                    ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600'
                    : 'border-slate-200 bg-white hover:bg-slate-50',
                )}
              >
                {r.name}
              </button>
            ))}
          </div>
        </Card>
      )}

      {selectedOffering && selectedOffering.resources.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          This session type isn't available to book online right now —
          check back soon or ask at the front desk.
        </div>
      )}

      {/* Date + slots */}
      {selectedOffering && selectedResourceId && (
        <Card>
          <StepLabel>
            Step {selectedOffering.resources.length > 1 ? 3 : 2} · Pick a time
          </StepLabel>
          <div className="mt-3 max-w-xs">
            <Field label="Date">
              <Input
                id="booking-date"
                type="date"
                value={date}
                min={tenantLocalDate(tz)}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </div>

          {date && (
            <div className="mt-4">
              <h3 className="text-sm font-medium text-slate-700">
                Available times
              </h3>
              {loadingSlots ? (
                <p className="mt-2 text-sm text-slate-400">loading…</p>
              ) : slotsError ? (
                <p className="mt-2 text-sm text-rose-700">{slotsError}</p>
              ) : slots && slots.length === 0 ? (
                <div className="mt-2 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
                  No open slots on this day.
                  {formatNoSlotsReason(slotsReason) && (
                    <span className="ml-1 text-slate-400">
                      {formatNoSlotsReason(slotsReason)}
                    </span>
                  )}
                </div>
              ) : slots ? (
                <>
                  <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {slots.map((s) => (
                      <button
                        key={s.start}
                        disabled={submitting}
                        onClick={() => setSelectedSlotStart(s.start)}
                        className={cn(
                          'rounded-full border px-2 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-50',
                          selectedSlot?.start === s.start
                            ? 'border-brand-600 bg-brand-600 text-white'
                            : 'border-slate-300 bg-white hover:bg-slate-50',
                        )}
                      >
                        {formatTimeLocal(s.start, tz)}
                      </button>
                    ))}
                  </div>
                  {selectedSlot && (
                    <div className="mt-4">
                      <Button
                        disabled={submitting}
                        onClick={() => bookSlot(selectedSlot)}
                      >
                        {submitting
                          ? 'Booking…'
                          : `Confirm ${formatTimeLocal(selectedSlot.start, tz)}`}
                      </Button>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          )}
        </Card>
      )}

      {submitError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Booking failed: {submitError}
        </div>
      )}

      {waiverSlot && (
        <WaiverModal
          onClose={() => setWaiverSlot(null)}
          onSigned={() => {
            const slot = waiverSlot;
            setWaiverSlot(null);
            bookSlot(slot);
          }}
        />
      )}
    </Page>
  );
}
