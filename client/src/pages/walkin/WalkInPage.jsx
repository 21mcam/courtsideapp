// Public walk-in booking flow — no login, ever. Rebuilt around the
// GA4 funnel data from the flow it replaces (21.9% completion; the
// two cliffs were an occluding fixed CTA on the service list and a
// login wall at checkout — neither exists here).
//
// Three URL-derived steps on one route (step is never stored; refresh
// restores, hardware back pops one step, no PII in URLs):
//   /walk-in                       → services (sectioned list + rating)
//   /walk-in?service=..            → time (day strip + slots)
//   /walk-in?..&slot=<ISO>         → details (3 fields + optional note)
//
// Tap path: service (1) → day (1, defaults to today) → slot (1) →
// 3 fields → Pay. Resource preference stays a defaulted chip row.
//
// The fixed SummaryBar shows the FINAL total from the first tap —
// the same formatCents(dollar_price) as the service row; there are
// no fees anywhere — and publishes its measured height so the page
// padding always compensates (see SummaryBar.jsx).
//
// Submit semantics are unchanged from the previous flow: each POST
// is a self-contained hold + Stripe Checkout session; 409
// slot_conflict retries the same time on the next candidate resource
// (emptiest first); waiver-version mismatch re-prompts. A cancelled
// payment returns to this page with all selections in the URL and
// contact fields restored from sessionStorage.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { formatCents, formatSlotLocal, formatTimeLocal } from '../../format.js';
import {
  ANY_RESOURCE,
  SLOT_TAKEN_MESSAGE,
  isRetryableConflict,
} from '../../lib/availability.js';
import {
  DEFAULT_HOLD_MINUTES,
  buildWalkInParams,
  normalizeFullName,
  parseWalkInParams,
} from '../../lib/walkinParams.js';
import { initAnalytics, track } from '../../lib/analytics.js';
import { Button, Card } from '../../components/ui/index.js';
import PublicHeader from './PublicHeader.jsx';
import RatingBadge from './RatingBadge.jsx';
import ServiceList from './ServiceList.jsx';
import TimeStep from './TimeStep.jsx';
import DetailsStep, { DETAILS_FORM_ID } from './DetailsStep.jsx';
import SummaryBar from './SummaryBar.jsx';
import { useSlots } from './useSlots.js';

const FORM_STORAGE_KEY = 'courtside_walkin_form';

const DEFAULT_POLICY = {
  hold_minutes: DEFAULT_HOLD_MINUTES,
  customer_reschedule_hours_before: 24,
  min_advance_booking_minutes: 0,
  max_advance_booking_days: 30,
};

function fetchCatalog() {
  return api('/api/customers/offerings').then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return {
      offerings: data.offerings ?? [],
      categories: data.categories ?? [],
      policy: { ...DEFAULT_POLICY, ...(data.policy ?? {}) },
    };
  });
}

function fetchWaiver() {
  return api('/api/waivers/current')
    .then(async (res) => (res.ok ? res.json() : null))
    .catch(() => null); // non-fatal: the booking endpoint enforces it
}

// LCP optimization: when the page loads directly on /walk-in (the
// storefront entry, ~80% phones on cell connections), start the
// catalog + waiver fetches at module-evaluation time so they run in
// PARALLEL with the auth provider's /api/tenant bootstrap instead of
// serially after first render. In-app navigations fetch on mount as
// usual.
const eagerCatalog =
  typeof window !== 'undefined' &&
  window.location.pathname.startsWith('/walk-in')
    ? { catalog: fetchCatalog(), waiver: fetchWaiver() }
    : null;
// Swallow eager rejections until the component attaches its handler.
if (eagerCatalog) eagerCatalog.catalog.catch(() => {});

function loadStoredForm() {
  try {
    const raw = sessionStorage.getItem(FORM_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function WalkInPage() {
  const { tenant, me } = useAuth();
  const tz = tenant.timezone;
  const [searchParams, setSearchParams] = useSearchParams();
  const paymentCancelled = searchParams.get('cancelled') === '1';

  const [catalog, setCatalog] = useState(null); // {offerings, categories, policy}
  const [loadError, setLoadError] = useState(null);
  const [waiver, setWaiver] = useState(null);

  const stored = useMemo(loadStoredForm, []);
  const [contact, setContact] = useState(
    stored?.contact ?? { full_name: '', phone: '', email: '', note: '' },
  );
  const [waiverForm, setWaiverForm] = useState(
    stored?.waiverForm ?? {
      signer_name: '',
      is_minor: false,
      guardian_name: '',
      agreed: false,
    },
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [slotNotice, setSlotNotice] = useState(null);
  const [slotsNonce, setSlotsNonce] = useState(0);

  useEffect(() => {
    initAnalytics(tenant.ga4_measurement_id);
  }, [tenant.ga4_measurement_id]);

  useEffect(() => {
    const src = eagerCatalog ?? { catalog: fetchCatalog(), waiver: fetchWaiver() };
    src.catalog.then(setCatalog).catch((err) => setLoadError(err.message));
    src.waiver.then((data) => {
      if (data) setWaiver(data);
    });
  }, []);

  // Mirror the form to sessionStorage so a Stripe-cancel round trip
  // (or accidental refresh) doesn't cost the customer their typing.
  useEffect(() => {
    try {
      sessionStorage.setItem(
        FORM_STORAGE_KEY,
        JSON.stringify({ contact, waiverForm }),
      );
    } catch {
      // Private mode — nothing to restore later, fine.
    }
  }, [contact, waiverForm]);

  const derived = useMemo(
    () =>
      catalog
        ? parseWalkInParams(searchParams, catalog.offerings, tz)
        : null,
    [catalog, searchParams, tz],
  );
  const policy = catalog?.policy ?? DEFAULT_POLICY;
  const offering = derived?.offering ?? null;

  const slotsState = useSlots({
    offeringId: offering?.id,
    resources: offering?.resources,
    resourceId: derived?.resourceId,
    date: derived?.date,
    nonce: slotsNonce,
  });

  // Funnel events. view_services fires once per page load after the
  // list renders; begin_checkout once per slot selection reaching the
  // details form.
  const viewTracked = useRef(false);
  useEffect(() => {
    if (catalog && !viewTracked.current) {
      viewTracked.current = true;
      track('view_services', { item_count: catalog.offerings.length });
    }
  }, [catalog]);

  const checkoutTracked = useRef(null);
  useEffect(() => {
    if (!derived || !offering) return;
    if (derived.step !== 'details' || !derived.slotStart) return;
    if (checkoutTracked.current === derived.slotStart) return;
    checkoutTracked.current = derived.slotStart;
    const value = offering.dollar_price / 100;
    track('begin_checkout', {
      value,
      currency: 'USD',
      items: [{ item_id: offering.id, item_name: offering.name, price: value }],
    });
  }, [derived, offering]);

  // A restored ?slot= that no longer exists (someone took it while
  // the customer was away) drops back to the time step with a notice.
  useEffect(() => {
    if (!derived?.slotStart || !slotsState.slots) return;
    const stillOpen = slotsState.slots.some(
      (s) => s.start === derived.slotStart,
    );
    if (!stillOpen) {
      setSlotNotice(SLOT_TAKEN_MESSAGE);
      setSearchParams(
        buildWalkInParams({
          offeringId: offering?.id,
          date: derived.date,
          resourceId: derived.resourceId,
        }),
        { replace: true },
      );
    }
  }, [derived?.slotStart, slotsState.slots]);

  function selectService(o) {
    setSlotNotice(null);
    setSubmitError(null);
    track('select_service', {
      item_id: o.id,
      item_name: o.name,
      price: o.dollar_price / 100,
      currency: 'USD',
    });
    // Push: hardware back returns to the full list.
    setSearchParams(buildWalkInParams({ offeringId: o.id }));
    window.scrollTo(0, 0);
  }

  function changeDate(d) {
    setSlotNotice(null);
    setSearchParams(
      buildWalkInParams({
        offeringId: offering.id,
        date: d,
        resourceId: derived.resourceId,
      }),
      { replace: true },
    );
  }

  function changeResource(rid) {
    setSlotNotice(null);
    setSearchParams(
      buildWalkInParams({
        offeringId: offering.id,
        date: derived.date,
        resourceId: rid,
      }),
      { replace: true },
    );
  }

  function selectSlot(slot) {
    setSlotNotice(null);
    setSubmitError(null);
    track('select_slot', {
      item_id: offering.id,
      slot_start: slot.start,
      date: derived.date,
    });
    // Prefill the waiver signature from the name once, never
    // overwriting the customer's own edit.
    setWaiverForm((f) =>
      f.signer_name ? f : { ...f, signer_name: normalizeFullName(contact.full_name) },
    );
    // Push: hardware back returns to the slot grid.
    setSearchParams(
      buildWalkInParams({
        offeringId: offering.id,
        date: derived.date,
        resourceId: derived.resourceId,
        slotStart: slot.start,
      }),
    );
    window.scrollTo(0, 0);
  }

  const waiverRequired = waiver?.waiver_required === true;
  const waiverComplete =
    !waiverRequired ||
    (waiverForm.agreed &&
      waiverForm.signer_name.trim() &&
      (!waiverForm.is_minor || waiverForm.guardian_name.trim()));
  const contactComplete =
    normalizeFullName(contact.full_name) &&
    contact.phone.trim() &&
    contact.email.trim();

  async function submit(e) {
    e.preventDefault();
    if (submitting || !derived?.slotStart || !contactComplete || !waiverComplete)
      return;
    const noPreference = derived.resourceId === ANY_RESOURCE;
    const candidates = noPreference
      ? (slotsState.resourceIdsBySlot[derived.slotStart] ?? [])
      : [derived.resourceId];
    if (candidates.length === 0) return; // stale selection mid-refetch
    setSubmitting(true);
    setSubmitError(null);
    const currentParams = buildWalkInParams({
      offeringId: offering.id,
      date: derived.date,
      resourceId: derived.resourceId,
      slotStart: derived.slotStart,
    });
    const payload = {
      offering_id: offering.id,
      start_time: derived.slotStart,
      customer: {
        full_name: normalizeFullName(contact.full_name),
        phone: contact.phone.trim(),
        email: contact.email.trim(),
      },
      ...(contact.note.trim() ? { note: contact.note.trim() } : {}),
      ...(waiverRequired
        ? {
            waiver: {
              signer_name: waiverForm.signer_name.trim(),
              // Echo the version whose text the form rendered — the
              // server 409s (waiver_version_mismatch) if the waiver
              // changed after the page loaded.
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
      // Cancel returns to a fully restored details step: selections
      // ride the URL, contact fields ride sessionStorage.
      cancel_url: `${window.location.origin}/walk-in?cancelled=1&${currentParams.toString()}`,
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
          // the Checkout success_url; the email needed for the lookup
          // rides in sessionStorage so it never appears in a URL.
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
          window.location.assign(body.checkout_url);
          return;
        }
        if (body.code === 'waiver_version_mismatch') {
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
          if (i < candidates.length - 1) continue;
          // Every candidate just filled up. Back to the slot grid
          // with a fresh list; contact + waiver entries are kept.
          setSlotNotice(SLOT_TAKEN_MESSAGE);
          setSlotsNonce((n) => n + 1);
          setSearchParams(
            buildWalkInParams({
              offeringId: offering.id,
              date: derived.date,
              resourceId: derived.resourceId,
            }),
            { replace: true },
          );
          setSubmitting(false);
          return;
        }
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setSubmitError(err.message);
      setSubmitting(false);
    }
  }

  // ---------- render ----------

  const step = derived?.step ?? 'services';
  const priceLabel = offering ? formatCents(offering.dollar_price) : '';

  let barCta = null;
  let barLine1 = null;
  let barLine2 = null;
  if (offering) {
    barLine1 = (
      <>
        {offering.name} · <span className="font-semibold">{priceLabel}</span>
      </>
    );
    if (step === 'details' && derived.slotStart) {
      barLine2 = `${formatSlotLocal(derived.slotStart, tz)}`;
      barCta = (
        <Button
          type="submit"
          form={DETAILS_FORM_ID}
          data-testid="pay-cta"
          disabled={submitting || !contactComplete || !waiverComplete}
        >
          {submitting ? 'Heading to payment…' : `Pay ${priceLabel}`}
        </Button>
      );
    } else {
      barLine2 = `${offering.duration_minutes} min`;
      barCta = (
        <Button disabled data-testid="pay-cta-disabled">
          {slotsState.loading ? 'Loading times…' : 'Pick a time'}
        </Button>
      );
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <PublicHeader
        right={
          <Link
            to={me ? '/' : '/login'}
            className="shrink-0 text-sm font-medium text-slate-500 hover:text-slate-700"
          >
            {me ? 'Back to my account' : 'Member sign in'}
          </Link>
        }
      />
      <main className="mx-auto max-w-2xl space-y-5 p-4 pb-[calc(var(--summary-bar-h)+24px)] sm:p-6 sm:pb-[calc(var(--summary-bar-h)+24px)]">
        {step === 'services' && (
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">
              Book a session
            </h1>
            <RatingBadge />
            <p className="mt-1.5 text-sm text-slate-500">
              Pick a time, pay by card, done. No account needed.
            </p>
          </div>
        )}

        {paymentCancelled && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Payment didn't go through — nothing was booked. Your picks
            are saved below.
          </div>
        )}

        {loadError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {loadError}
          </div>
        )}

        {!catalog && !loadError && (
          <Card>
            <p className="text-sm text-slate-400">Loading sessions…</p>
          </Card>
        )}

        {catalog && step === 'services' && (
          <ServiceList
            offerings={catalog.offerings}
            categories={catalog.categories}
            selectedOfferingId={null}
            onSelect={selectService}
          />
        )}

        {catalog && offering && step === 'time' && (
          <>
            <button
              type="button"
              onClick={() => {
                setSearchParams(new URLSearchParams(), { replace: false });
                window.scrollTo(0, 0);
              }}
              className="text-sm font-medium text-brand-700 hover:text-brand-600"
            >
              ← All sessions
            </button>
            {offering.resources.length === 0 ? (
              <Card>
                <p className="text-sm text-slate-500">
                  This session type isn't bookable online right now —
                  check back soon or ask at the front desk.
                </p>
              </Card>
            ) : (
              <TimeStep
                tz={tz}
                offering={offering}
                date={derived.date}
                resourceId={derived.resourceId}
                maxAdvanceDays={policy.max_advance_booking_days}
                slotsState={slotsState}
                selectedSlotStart={null}
                notice={slotNotice}
                onDateChange={changeDate}
                onResourceChange={changeResource}
                onSelectSlot={selectSlot}
              />
            )}
          </>
        )}

        {catalog && offering && step === 'details' && (
          <>
            <button
              type="button"
              onClick={() => {
                setSearchParams(
                  buildWalkInParams({
                    offeringId: offering.id,
                    date: derived.date,
                    resourceId: derived.resourceId,
                  }),
                  { replace: false },
                );
                window.scrollTo(0, 0);
              }}
              className="text-sm font-medium text-brand-700 hover:text-brand-600"
            >
              ← Pick a different time
            </button>
            <DetailsStep
              tz={tz}
              offering={offering}
              slotStart={derived.slotStart}
              contact={contact}
              onContactChange={setContact}
              waiver={waiver}
              waiverForm={waiverForm}
              onWaiverChange={setWaiverForm}
              policy={policy}
              onSubmit={submit}
            />
          </>
        )}

        {submitError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            Booking failed: {submitError}
          </div>
        )}
      </main>

      {offering && (
        <SummaryBar
          line1={barLine1}
          line2={
            step === 'details' && derived.slotStart
              ? barLine2
              : step === 'time' && slotsState.slots?.length
                ? `${barLine2} · ${slotsState.slots.length} times ${formatTimeLocal(slotsState.slots[0].start, tz)}+`
                : barLine2
          }
          cta={barCta}
        />
      )}
    </div>
  );
}
