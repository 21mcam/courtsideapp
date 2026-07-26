// Public walk-in booking flow — no login required.
//
// Same linear picker as the member BookingPage (offering → resource →
// date → slot), with two deliberate differences:
//   * Prices are dollars (walk-ins pay by card), never credits.
//   * Clicking a slot doesn't book — it selects. The walk-in then
//     fills in contact info and is redirected to Stripe Checkout;
//     the booking confirms when the webhook sees the payment.
//
// Resource selection mirrors BookingPage: "No preference" is the
// preselected default when the offering runs on several resources
// (slots shown are the union across resources; the concrete resource
// is picked at submit time, emptiest first — lib/availability.js),
// and the step is hidden entirely for single-resource offerings. On
// a 409 slot conflict the submit retries the same time on the next
// resource that had it. Safe here even with the hold + checkout
// lifecycle: a 409 response rolls the whole transaction back (no
// booking row, no hold), and each retry POST creates a fresh booking
// with its own hold_expires_at and Checkout session.
//
// Auth context: `me` is null here. Tenant name + timezone come from
// useAuth().tenant, which loads for everyone (GET /api/tenant is
// public). Offerings come from GET /api/customers/offerings and slots
// from GET /api/availability — both public endpoints.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  formatCents,
  formatNoSlotsReason,
  formatSlotLocal,
  formatTimeLocal,
  formatTimezoneLabel,
} from '../format.js';
import {
  ANY_RESOURCE,
  SLOT_TAKEN_MESSAGE,
  isRetryableConflict,
  mergeAvailability,
} from '../lib/availability.js';
import { Button, Card, Field, Input, cn } from '../components/ui/index.js';

// Tenant-local YYYY-MM-DD for "today" — same helper as BookingPage.
function tenantLocalDate(tz, daysFromNow = 0) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + daysFromNow);
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

export default function WalkInPage() {
  const { tenant, me } = useAuth();
  const tz = tenant.timezone;
  const [searchParams] = useSearchParams();
  const paymentCancelled = searchParams.get('cancelled') === '1';

  const [offerings, setOfferings] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [selectedOfferingId, setSelectedOfferingId] = useState('');
  const [selectedResourceId, setSelectedResourceId] = useState('');
  const [date, setDate] = useState(() => tenantLocalDate(tz));
  const [selectedSlot, setSelectedSlot] = useState(null);

  const [slots, setSlots] = useState(null);
  const [slotsError, setSlotsError] = useState(null);
  const [slotsReason, setSlotsReason] = useState(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  // "No preference" bookkeeping: start ISO → resource ids that had
  // that slot, ordered by booking preference (lib/availability.js).
  const [slotResourceIds, setSlotResourceIds] = useState({});
  // Bumped to force a slot refetch after a submit-time conflict, so
  // the just-taken time drops out of the list.
  const [slotsNonce, setSlotsNonce] = useState(0);

  const [contact, setContact] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // Liability waiver (when the facility requires one, the form shows
  // it inline and the signature rides along with the booking create).
  const [waiver, setWaiver] = useState(null); // GET /api/waivers/current body
  const [waiverForm, setWaiverForm] = useState({
    signer_name: '',
    is_minor: false,
    guardian_name: '',
    agreed: false,
  });

  useEffect(() => {
    api('/api/customers/offerings')
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => setOfferings(data.offerings ?? []))
      .catch((err) => setLoadError(err.message));
    api('/api/waivers/current')
      .then(async (res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setWaiver(data);
      })
      .catch(() => {
        // Non-fatal: the booking endpoint enforces the waiver anyway.
      });
  }, []);

  const selectedOffering = useMemo(
    () => (offerings ?? []).find((o) => o.id === selectedOfferingId) ?? null,
    [offerings, selectedOfferingId],
  );

  // Default the resource: "No preference" when there's a real
  // choice, the lone resource when there isn't (the picker card is
  // hidden then), or clear if the offering has none.
  useEffect(() => {
    if (!selectedOffering) {
      setSelectedResourceId('');
      return;
    }
    setSelectedResourceId(
      selectedOffering.resources.length > 1
        ? ANY_RESOURCE
        : (selectedOffering.resources[0]?.id ?? ''),
    );
  }, [selectedOfferingId, selectedOffering]);

  // Any change upstream of the slot invalidates the selected slot.
  useEffect(() => {
    setSelectedSlot(null);
    setSubmitError(null);
  }, [selectedOfferingId, selectedResourceId, date]);

  // Fetch slots. "No preference" queries every resource of the
  // offering in parallel and shows the merged union of start times.
  useEffect(() => {
    if (!selectedOfferingId || !selectedResourceId || !date) {
      setSlots(null);
      setSlotsReason(null);
      setSlotResourceIds({});
      return;
    }
    const resourceIds =
      selectedResourceId === ANY_RESOURCE
        ? (selectedOffering?.resources ?? []).map((r) => r.id)
        : [selectedResourceId];
    let cancelled = false;
    setLoadingSlots(true);
    setSlotsError(null);
    setSlotsReason(null);
    Promise.all(
      resourceIds.map((resourceId) =>
        api(
          `/api/availability?offering_id=${selectedOfferingId}&resource_id=${resourceId}&date=${date}`,
        ).then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
          }
          return res.json();
        }),
      ),
    )
      .then((results) => {
        if (cancelled) return;
        const merged = mergeAvailability(resourceIds, results);
        setSlots(merged.slots);
        setSlotsReason(merged.reason);
        setSlotResourceIds(merged.resourceIdsBySlot);
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
  }, [selectedOfferingId, selectedResourceId, selectedOffering, date, slotsNonce]);

  const waiverRequired = waiver?.waiver_required === true;
  const waiverComplete =
    !waiverRequired ||
    (waiverForm.agreed &&
      waiverForm.signer_name.trim() &&
      (!waiverForm.is_minor || waiverForm.guardian_name.trim()));

  const contactComplete =
    contact.first_name.trim() &&
    contact.last_name.trim() &&
    contact.email.trim();

  async function submit(e) {
    e.preventDefault();
    if (submitting || !selectedSlot || !contactComplete || !waiverComplete)
      return;
    // The booking POST needs a concrete resource. With "No
    // preference" the candidates are every resource that had this
    // slot, emptiest first (lib/availability.js); an explicit pick
    // is its own single candidate. Each POST is a self-contained
    // hold + Checkout session, and a 409 rolls back holding nothing,
    // so retrying the next candidate is safe.
    const noPreference = selectedResourceId === ANY_RESOURCE;
    const candidates = noPreference
      ? (slotResourceIds[selectedSlot.start] ?? [])
      : [selectedResourceId];
    if (candidates.length === 0) return; // stale selection mid-refetch
    setSubmitting(true);
    setSubmitError(null);
    const payload = {
      offering_id: selectedOfferingId,
      start_time: selectedSlot.start,
      customer: {
        first_name: contact.first_name.trim(),
        last_name: contact.last_name.trim(),
        email: contact.email.trim(),
        ...(contact.phone.trim() ? { phone: contact.phone.trim() } : {}),
      },
      ...(waiverRequired
        ? {
            waiver: {
              signer_name: waiverForm.signer_name.trim(),
              // Echo the version whose text the form rendered —
              // the server 409s (waiver_version_mismatch) if the
              // waiver changed after the page loaded.
              waiver_version: waiver?.waiver_version,
              ...(waiverForm.is_minor
                ? {
                    is_minor: true,
                    guardian_name: waiverForm.guardian_name.trim(),
                  }
                : {}),
            },
          }
        : {}),
      success_url: `${window.location.origin}/walk-in/success`,
      cancel_url: `${window.location.origin}/walk-in?cancelled=1`,
    };
    try {
      for (let i = 0; i < candidates.length; i += 1) {
        const res = await api('/api/customers/bookings', {
          method: 'POST',
          body: JSON.stringify({ ...payload, resource_id: candidates[i] }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          // Success-page context: the server appends booking_id to
          // the Checkout success_url; the email needed for the
          // lookup rides in sessionStorage so it never appears in a
          // URL. Same tab through Stripe and back, so sessionStorage
          // survives.
          try {
            sessionStorage.setItem(
              'courtside_walkin_email',
              contact.email.trim().toLowerCase(),
            );
            sessionStorage.setItem(
              'courtside_walkin_booking_id',
              body.booking.id,
            );
          } catch {
            // Storage unavailable (private mode) — the success page
            // asks for the email instead.
          }
          // Off to Stripe Checkout; the webhook confirms the booking.
          window.location.assign(body.checkout_url);
          return;
        }
        if (body.code === 'waiver_version_mismatch') {
          // Admin updated the waiver text after the page loaded —
          // reload the new text, clear the agreement, re-prompt.
          const fresh = await api('/api/waivers/current')
            .then(async (r) => (r.ok ? r.json() : null))
            .catch(() => null);
          if (fresh) setWaiver(fresh);
          setWaiverForm((f) => ({ ...f, agreed: false }));
          throw new Error(
            'The waiver was updated — please review the new version and agree again.',
          );
        }
        if (isRetryableConflict(res.status, body)) {
          // Someone grabbed this time on this resource between
          // listing and submitting — try the same time on the next
          // candidate before giving up.
          if (i < candidates.length - 1) continue;
          // Every candidate (or the explicitly picked resource) just
          // became unavailable. Refetch so the stale time drops out
          // of the list, then ask for another pick (contact + waiver
          // entries are kept).
          setSelectedSlot(null);
          setSlotsNonce((n) => n + 1);
          throw new Error(SLOT_TAKEN_MESSAGE);
        }
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setSubmitError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-semibold text-white">
            {tenant.name?.charAt(0).toUpperCase()}
          </div>
          <div className="font-semibold text-slate-900">{tenant.name}</div>
        </div>
        <Link
          to={me ? '/' : '/login'}
          className="text-sm text-brand-600 hover:text-brand-700 font-medium"
        >
          {me ? 'Back to my account' : 'Member sign in'}
        </Link>
      </header>
      <main className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            Book a session
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            No account needed — pick a time, pay by card, and you're
            booked. Times shown in {formatTimezoneLabel(tz)}.
          </p>
        </div>

        {paymentCancelled && !selectedSlot && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Payment was cancelled — no booking was made. Pick a time to
            try again.
          </div>
        )}

        {loadError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {loadError}
          </div>
        )}

        {/* Offering picker */}
        <Card title="What would you like to book?">
          {offerings === null ? (
            <p className="text-sm text-slate-400">loading…</p>
          ) : offerings.length === 0 ? (
            <p className="text-sm text-slate-500">
              Online walk-in booking isn't available yet. Contact the
              front desk to book.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {offerings.map((o) => (
                <button
                  key={o.id}
                  onClick={() => setSelectedOfferingId(o.id)}
                  className={cn(
                    'rounded-lg border px-4 py-3 text-left transition',
                    selectedOfferingId === o.id
                      ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600'
                      : 'border-slate-200 bg-white hover:border-slate-300',
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-slate-900">
                      {o.name}
                    </span>
                    <span className="font-semibold text-slate-900">
                      {formatCents(o.dollar_price)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {o.duration_minutes} min
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* Resource picker — only if the offering has multiple
            resources (a single resource is auto-selected and the
            step hidden). "No preference" is preselected; picking a
            specific resource stays one tap away. */}
        {selectedOffering && selectedOffering.resources.length > 1 && (
          <Card title="Any preference?">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setSelectedResourceId(ANY_RESOURCE)}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-sm transition',
                  selectedResourceId === ANY_RESOURCE
                    ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600 font-medium text-slate-900'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300',
                )}
              >
                No preference
              </button>
              {selectedOffering.resources.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedResourceId(r.id)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-sm transition',
                    selectedResourceId === r.id
                      ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600 font-medium text-slate-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300',
                  )}
                >
                  {r.name}
                </button>
              ))}
            </div>
          </Card>
        )}

        {selectedOffering && selectedOffering.resources.length === 0 && (
          <p className="text-sm text-slate-500">
            This session type isn't available to book online right now
            — check back soon or ask at the front desk.
          </p>
        )}

        {/* Date picker */}
        {selectedOffering && selectedResourceId && (
          <Card title="Date">
            <Field>
              <Input
                id="walkin-date"
                type="date"
                value={date}
                min={tenantLocalDate(tz)}
                onChange={(e) => setDate(e.target.value)}
                className="sm:max-w-xs"
              />
            </Field>
          </Card>
        )}

        {/* Slots */}
        {selectedOffering && selectedResourceId && date && (
          <Card title="Available times">
            {loadingSlots ? (
              <p className="text-sm text-slate-400">loading…</p>
            ) : slotsError ? (
              <p className="text-sm text-rose-700">{slotsError}</p>
            ) : slots && slots.length === 0 ? (
              <p className="text-sm text-slate-500">
                No open slots on this day.
                {formatNoSlotsReason(slotsReason) && (
                  <span className="ml-1 text-slate-400">
                    {formatNoSlotsReason(slotsReason)}
                  </span>
                )}
              </p>
            ) : slots ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {slots.map((s) => (
                  <button
                    key={s.start}
                    onClick={() => setSelectedSlot(s)}
                    className={cn(
                      'rounded-lg border px-2 py-2 text-sm transition',
                      selectedSlot?.start === s.start
                        ? 'border-brand-600 bg-brand-600 font-medium text-white'
                        : 'border-slate-300 bg-white text-slate-700 hover:border-brand-600 hover:bg-brand-50',
                    )}
                  >
                    {formatTimeLocal(s.start, tz)}
                  </button>
                ))}
              </div>
            ) : null}
          </Card>
        )}

        {/* Contact + pay */}
        {selectedSlot && selectedOffering && (
          <Card title="Your details">
            <p className="text-sm text-slate-500">
              {selectedOffering.name} ·{' '}
              {formatSlotLocal(selectedSlot.start, tz)} ·{' '}
              <span className="font-semibold text-slate-900">
                {formatCents(selectedOffering.dollar_price)}
              </span>
            </p>
            <form onSubmit={submit} className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="First name">
                  <Input
                    required
                    value={contact.first_name}
                    onChange={(e) =>
                      setContact({ ...contact, first_name: e.target.value })
                    }
                  />
                </Field>
                <Field label="Last name">
                  <Input
                    required
                    value={contact.last_name}
                    onChange={(e) =>
                      setContact({ ...contact, last_name: e.target.value })
                    }
                  />
                </Field>
              </div>
              <Field label="Email">
                <Input
                  required
                  type="email"
                  value={contact.email}
                  onChange={(e) =>
                    setContact({ ...contact, email: e.target.value })
                  }
                />
              </Field>
              <Field label="Phone" hint="Optional">
                <Input
                  type="tel"
                  value={contact.phone}
                  onChange={(e) =>
                    setContact({ ...contact, phone: e.target.value })
                  }
                />
              </Field>

              {waiverRequired && (
                <div className="space-y-3 rounded-lg border border-slate-200 p-4">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Liability waiver
                  </h3>
                  <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                    {waiver.waiver_text ||
                      'No waiver text has been provided.'}
                  </div>
                  <Field label="Full legal name (this is your signature)">
                    <Input
                      required
                      value={waiverForm.signer_name}
                      onChange={(e) =>
                        setWaiverForm({
                          ...waiverForm,
                          signer_name: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={waiverForm.is_minor}
                      onChange={(e) =>
                        setWaiverForm({
                          ...waiverForm,
                          is_minor: e.target.checked,
                        })
                      }
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    I am signing on behalf of a minor
                  </label>
                  {waiverForm.is_minor && (
                    <Field
                      label="Parent / guardian full name"
                      hint="The participant's name goes above; the signing adult's name goes here."
                    >
                      <Input
                        required
                        value={waiverForm.guardian_name}
                        onChange={(e) =>
                          setWaiverForm({
                            ...waiverForm,
                            guardian_name: e.target.value,
                          })
                        }
                      />
                    </Field>
                  )}
                  <label className="flex items-start gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={waiverForm.agreed}
                      onChange={(e) =>
                        setWaiverForm({
                          ...waiverForm,
                          agreed: e.target.checked,
                        })
                      }
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    I have read and agree to the waiver above.
                  </label>
                </div>
              )}

              <Button
                type="submit"
                disabled={submitting || !contactComplete || !waiverComplete}
                className="w-full"
              >
                {submitting
                  ? 'Redirecting to payment…'
                  : `Continue to payment · ${formatCents(selectedOffering.dollar_price)}`}
              </Button>
              <p className="text-xs text-slate-400">
                Your slot is held for 15 minutes while you pay. Payment
                is handled securely by Stripe.
              </p>
            </form>
          </Card>
        )}

        {submitError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            Booking failed: {submitError}
          </div>
        )}
      </main>
    </div>
  );
}
