// Step 3: the details form. Exactly three required fields + one
// optional note — every extra mobile field costs completions (the
// flow this replaces asked for Address/City/State/ZIP to rent a cage
// for an hour). Single column, correct autocomplete + inputmode so
// phone keyboards and autofill do the typing.
//
// The primary CTA lives in the fixed SummaryBar, outside this form —
// it submits via form="walkin-details-form".

import { formatCents, formatSlotLocal } from '../../format.js';
import { Card, Field, Input, Textarea } from '../../components/ui/index.js';
import WaiverSection from './WaiverSection.jsx';

export const DETAILS_FORM_ID = 'walkin-details-form';

export default function DetailsStep({
  tz,
  offering,
  slotStart,
  contact,
  onContactChange,
  waiver, // GET /api/waivers/current body (or null)
  waiverForm,
  onWaiverChange,
  policy, // { hold_minutes, customer_reschedule_hours_before, ... }
  onSubmit,
}) {
  const waiverRequired = waiver?.waiver_required === true;
  return (
    <Card title="Your details">
      <p className="text-sm text-slate-500">
        {offering.name} · {formatSlotLocal(slotStart, tz)} ·{' '}
        <span
          data-testid="details-price"
          className="font-semibold text-slate-900"
        >
          {formatCents(offering.dollar_price)}
        </span>
      </p>
      <form id={DETAILS_FORM_ID} onSubmit={onSubmit} className="mt-4 space-y-4">
        <Field label="Full name">
          <Input
            required
            autoComplete="name"
            autoCapitalize="words"
            value={contact.full_name}
            onChange={(e) =>
              onContactChange({ ...contact, full_name: e.target.value })
            }
          />
        </Field>
        <Field label="Mobile phone">
          <Input
            required
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={contact.phone}
            onChange={(e) =>
              onContactChange({ ...contact, phone: e.target.value })
            }
          />
        </Field>
        <Field label="Email" hint="Your confirmation and reschedule link land here.">
          <Input
            required
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            value={contact.email}
            onChange={(e) =>
              onContactChange({ ...contact, email: e.target.value })
            }
          />
        </Field>
        <Field label="Anything we should know?" hint="Optional">
          <Textarea
            rows={2}
            maxLength={1000}
            value={contact.note}
            onChange={(e) =>
              onContactChange({ ...contact, note: e.target.value })
            }
          />
        </Field>

        {waiverRequired && (
          <WaiverSection
            waiver={waiver}
            form={waiverForm}
            onChange={onWaiverChange}
          />
        )}

        <div className="space-y-1 text-xs text-slate-500">
          <p>
            Can't make it? Reschedule free up to{' '}
            {policy.customer_reschedule_hours_before}h before — the link
            comes with your confirmation email.
          </p>
          <p>
            We hold your time for {policy.hold_minutes} minutes while you
            pay. Stripe handles the card — we never see it.
          </p>
        </div>
      </form>
    </Card>
  );
}
