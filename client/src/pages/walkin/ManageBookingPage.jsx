// No-login booking manage/reschedule page — the target of the
// capability link in walk-in confirmation emails
// (/walk-in/manage?token=...). Possession of the link is the auth;
// there is no account and no password anywhere on this path.
//
// Shows the booking, and (when the policy cutoff allows) the same
// day-strip + slot grid as checkout, constrained to the booking's
// offering — same price, no money moves. Confirm → POST reschedule.
// 409 slot_conflict retries the next candidate resource exactly like
// checkout does.

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CircleCheck } from 'lucide-react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { formatSlotLocal } from '../../format.js';
import {
  ANY_RESOURCE,
  SLOT_TAKEN_MESSAGE,
  isRetryableConflict,
} from '../../lib/availability.js';
import { tenantLocalDate } from '../../lib/walkinParams.js';
import { Button, Card } from '../../components/ui/index.js';
import PublicHeader from './PublicHeader.jsx';
import TimeStep from './TimeStep.jsx';
import SummaryBar from './SummaryBar.jsx';
import { useSlots } from './useSlots.js';

export default function ManageBookingPage() {
  const { tenant } = useAuth();
  const tz = tenant.timezone;
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [data, setData] = useState(null); // GET manage response
  const [loadError, setLoadError] = useState(null);

  const [picking, setPicking] = useState(false);
  const [date, setDate] = useState(() => tenantLocalDate(tz));
  const [resourceId, setResourceId] = useState('');
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [slotsNonce, setSlotsNonce] = useState(0);
  const [slotNotice, setSlotNotice] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [rescheduled, setRescheduled] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError('missing_token');
      return;
    }
    api(`/api/customers/bookings/manage/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'not_found' : 'error');
        return res.json();
      })
      .then((body) => {
        setData(body);
        setResourceId(
          body.offering.resources.length > 1
            ? ANY_RESOURCE
            : (body.offering.resources[0]?.id ?? ''),
        );
      })
      .catch((err) => setLoadError(err.message));
  }, [token]);

  const offeringForPicker = useMemo(
    () => (data ? { ...data.offering } : null),
    [data],
  );

  const slotsState = useSlots({
    offeringId: picking ? data?.offering.id : null,
    resources: data?.offering.resources,
    resourceId,
    date,
    nonce: slotsNonce,
  });

  useEffect(() => {
    setSelectedSlot(null);
  }, [date, resourceId]);

  async function confirmReschedule() {
    if (!selectedSlot || submitting) return;
    const noPreference = resourceId === ANY_RESOURCE;
    const candidates = noPreference
      ? (slotsState.resourceIdsBySlot[selectedSlot.start] ?? [])
      : [resourceId];
    if (candidates.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      for (let i = 0; i < candidates.length; i += 1) {
        const res = await api(
          `/api/customers/bookings/manage/${encodeURIComponent(token)}/reschedule`,
          {
            method: 'POST',
            body: JSON.stringify({
              start_time: selectedSlot.start,
              resource_id: candidates[i],
            }),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          setData((d) => ({ ...d, booking: body.booking, reschedule: body.reschedule }));
          setRescheduled(true);
          setPicking(false);
          setSelectedSlot(null);
          setSubmitting(false);
          window.scrollTo(0, 0);
          return;
        }
        if (isRetryableConflict(res.status, body)) {
          if (i < candidates.length - 1) continue;
          setSlotNotice(SLOT_TAKEN_MESSAGE);
          setSelectedSlot(null);
          setSlotsNonce((n) => n + 1);
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

  const contactLine = tenant.reply_to_email
    ? `Questions? Contact ${tenant.name} at ${tenant.reply_to_email}.`
    : `Questions? Contact the ${tenant.name} front desk.`;

  if (loadError) {
    return (
      <div className="min-h-screen bg-slate-50">
        <PublicHeader />
        <main className="mx-auto max-w-md p-4 sm:p-6">
          <Card className="mt-12 text-center">
            <h1 className="text-lg font-semibold text-slate-900">
              This link isn't valid anymore
            </h1>
            <p className="mt-2 text-sm text-slate-500">
              It may have been for a booking that's already done or
              cancelled. {contactLine}
            </p>
          </Card>
        </main>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-slate-50">
        <PublicHeader />
        <main className="mx-auto max-w-md p-4 sm:p-6">
          <Card className="mt-12">
            <p className="text-sm text-slate-400">Loading your booking…</p>
          </Card>
        </main>
      </div>
    );
  }

  const { booking, reschedule } = data;
  const canReschedule = reschedule.allowed;

  return (
    <div className="min-h-screen bg-slate-50">
      <PublicHeader />
      <main className="mx-auto max-w-2xl space-y-5 p-4 pb-[calc(var(--summary-bar-h)+24px)] sm:p-6 sm:pb-[calc(var(--summary-bar-h)+24px)]">
        <h1 className="text-2xl font-semibold text-slate-900">Your booking</h1>

        {rescheduled && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <CircleCheck size={18} />
            Done — see you {formatSlotLocal(booking.start_time, tz)}. A
            confirmation email is on its way.
          </div>
        )}

        <Card>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Reference</dt>
              <dd className="font-mono font-semibold tracking-wider text-slate-900">
                {booking.reference}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Session</dt>
              <dd className="text-right font-medium text-slate-900">
                {booking.offering_name}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Where</dt>
              <dd className="text-right text-slate-900">
                {booking.resource_name}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">When</dt>
              <dd className="text-right font-medium text-slate-900">
                {formatSlotLocal(booking.start_time, tz)}
              </dd>
            </div>
          </dl>
        </Card>

        {canReschedule && !picking && (
          <Button variant="secondary" onClick={() => setPicking(true)}>
            Pick a new time
          </Button>
        )}

        {!canReschedule && (
          <p className="text-sm text-slate-500">
            {reschedule.reason === 'cutoff_passed'
              ? `Reschedules close ${reschedule.hours_before}h before your session.`
              : booking.status !== 'confirmed'
                ? `This booking is ${booking.status.replace('_', ' ')} and can't be changed.`
                : null}
          </p>
        )}

        {canReschedule && picking && (
          <>
            <h2 className="text-sm font-semibold text-slate-900">
              Pick a new time — same session, nothing more to pay.
            </h2>
            <TimeStep
              tz={tz}
              offering={offeringForPicker}
              date={date}
              resourceId={resourceId}
              maxAdvanceDays={reschedule.max_advance_booking_days}
              slotsState={slotsState}
              selectedSlotStart={selectedSlot?.start ?? null}
              notice={slotNotice}
              onDateChange={setDate}
              onResourceChange={setResourceId}
              onSelectSlot={(s) => {
                setSlotNotice(null);
                setSelectedSlot(s);
              }}
            />
          </>
        )}

        {submitError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            Reschedule failed: {submitError}
          </div>
        )}

        <p className="text-sm text-slate-500">{contactLine}</p>
      </main>

      {picking && selectedSlot && (
        <SummaryBar
          line1={
            <>
              New time:{' '}
              <span className="font-semibold">
                {formatSlotLocal(selectedSlot.start, tz)}
              </span>
            </>
          }
          line2="$0 to pay — your payment moves with the booking."
          cta={
            <Button onClick={confirmReschedule} disabled={submitting}>
              {submitting ? 'Moving it…' : 'Confirm new time'}
            </Button>
          }
        />
      )}
    </div>
  );
}
