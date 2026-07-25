// Admin Settings → Booking policies. Form over the singleton
// booking_policies row: cancellation window (+ optional partial
// refund tier), no-show rule, and the advance booking window.
//
// GET returns schema defaults with exists:false for tenants that
// predate the wizard-created row; PUT UPSERTs. The PUT endpoint
// fills any omitted field with schema defaults, so we always send
// the complete policy object.

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import SettingsNav from '../components/SettingsNav.jsx';
import {
  Button,
  Card,
  Field,
  Input,
  Page,
  PageHeader,
  Select,
} from '../components/ui/index.js';

const NO_SHOW_OPTIONS = [
  { value: 'none', label: 'Do nothing' },
  { value: 'forfeit_credits', label: 'Forfeit the spent credits' },
  { value: 'charge_fee', label: 'Charge a fee' },
  { value: 'block_member', label: 'Block the member from booking' },
];

export default function AdminPolicies() {
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api('/api/admin/booking-policies');
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        if (!alive) return;
        const p = body.booking_policies;
        setForm({
          free_cancel_hours_before: String(p.free_cancel_hours_before),
          partial_refund_enabled: p.partial_refund_hours_before != null,
          partial_refund_hours_before:
            p.partial_refund_hours_before != null
              ? String(p.partial_refund_hours_before)
              : '',
          partial_refund_percent:
            p.partial_refund_percent != null
              ? String(p.partial_refund_percent)
              : '',
          no_show_action: p.no_show_action,
          no_show_fee_dollars:
            p.no_show_fee_cents != null
              ? String(p.no_show_fee_cents / 100)
              : '',
          min_advance_booking_minutes: String(p.min_advance_booking_minutes),
          max_advance_booking_days: String(p.max_advance_booking_days),
          allow_member_self_cancel: p.allow_member_self_cancel,
          allow_customer_self_cancel: p.allow_customer_self_cancel,
        });
      } catch (err) {
        if (alive) setLoadError(err.message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function set(patch) {
    setForm((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  }

  async function submit(e) {
    e.preventDefault();
    if (saving || !form) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const payload = {
        free_cancel_hours_before: Number(form.free_cancel_hours_before),
        partial_refund_hours_before: form.partial_refund_enabled
          ? Number(form.partial_refund_hours_before)
          : null,
        partial_refund_percent: form.partial_refund_enabled
          ? Number(form.partial_refund_percent)
          : null,
        no_show_action: form.no_show_action,
        no_show_fee_cents:
          form.no_show_action === 'charge_fee'
            ? Math.round(Number(form.no_show_fee_dollars) * 100)
            : null,
        min_advance_booking_minutes: Number(form.min_advance_booking_minutes),
        max_advance_booking_days: Number(form.max_advance_booking_days),
        allow_member_self_cancel: form.allow_member_self_cancel,
        allow_customer_self_cancel: form.allow_customer_self_cancel,
      };
      const res = await api('/api/admin/booking-policies', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSaved(true);
    } catch (err) {
      setSaveError(`Couldn't save policies: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page width="narrow">
      <PageHeader
        title="Settings"
        description="Cancellation, no-show, and booking-window rules."
      />
      <SettingsNav />

      {loadError && <ErrorBanner message={loadError} />}

      {!form && !loadError && (
        <Card>
          <div className="py-6 text-center text-sm text-slate-400">
            loading…
          </div>
        </Card>
      )}

      {form && (
        <form onSubmit={submit} className="space-y-6">
          <Card title="Cancellation">
            <div className="space-y-4">
              <Field
                label="Free cancellation window (hours before start)"
                hint="Cancelling earlier than this refunds in full (credits or payment)."
                className="max-w-xs"
              >
                <Input
                  required
                  type="number"
                  min="0"
                  value={form.free_cancel_hours_before}
                  onChange={(e) =>
                    set({ free_cancel_hours_before: e.target.value })
                  }
                />
              </Field>
              <Checkbox
                checked={form.partial_refund_enabled}
                onChange={(v) => set({ partial_refund_enabled: v })}
                label="Offer a partial refund for later cancellations"
              />
              {form.partial_refund_enabled && (
                <div className="grid max-w-md gap-3 sm:grid-cols-2">
                  <Field
                    label="Partial window (hours before)"
                    hint="Must be within the free window."
                  >
                    <Input
                      required
                      type="number"
                      min="0"
                      value={form.partial_refund_hours_before}
                      onChange={(e) =>
                        set({ partial_refund_hours_before: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Refund percent">
                    <Input
                      required
                      type="number"
                      min="0"
                      max="100"
                      value={form.partial_refund_percent}
                      onChange={(e) =>
                        set({ partial_refund_percent: e.target.value })
                      }
                    />
                  </Field>
                </div>
              )}
              <div className="space-y-2 pt-1">
                <Checkbox
                  checked={form.allow_member_self_cancel}
                  onChange={(v) => set({ allow_member_self_cancel: v })}
                  label="Members can cancel their own bookings"
                />
                <Checkbox
                  checked={form.allow_customer_self_cancel}
                  onChange={(v) => set({ allow_customer_self_cancel: v })}
                  label="Walk-in customers can cancel their own bookings"
                />
              </div>
            </div>
          </Card>

          <Card title="No-shows">
            <div className="grid max-w-md gap-3 sm:grid-cols-2">
              <Field label="When someone doesn't show">
                <Select
                  value={form.no_show_action}
                  onChange={(e) => set({ no_show_action: e.target.value })}
                >
                  {NO_SHOW_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {form.no_show_action === 'charge_fee' && (
                <Field label="No-show fee ($)">
                  <Input
                    required
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={form.no_show_fee_dollars}
                    onChange={(e) =>
                      set({ no_show_fee_dollars: e.target.value })
                    }
                  />
                </Field>
              )}
            </div>
          </Card>

          <Card title="Booking window">
            <div className="grid max-w-md gap-3 sm:grid-cols-2">
              <Field
                label="Minimum notice (minutes)"
                hint="0 = up to the start time."
              >
                <Input
                  required
                  type="number"
                  min="0"
                  value={form.min_advance_booking_minutes}
                  onChange={(e) =>
                    set({ min_advance_booking_minutes: e.target.value })
                  }
                />
              </Field>
              <Field
                label="How far ahead (days)"
                hint="Bookings open this many days out."
              >
                <Input
                  required
                  type="number"
                  min="1"
                  value={form.max_advance_booking_days}
                  onChange={(e) =>
                    set({ max_advance_booking_days: e.target.value })
                  }
                />
              </Field>
            </div>
          </Card>

          {saveError && <ErrorBanner message={saveError} />}

          <div className="flex items-center justify-end gap-3">
            {saved && <span className="text-xs text-emerald-600">Saved.</span>}
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save policies'}
            </Button>
          </div>
        </form>
      )}
    </Page>
  );
}

function Checkbox({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
      />
      {label}
    </label>
  );
}

function ErrorBanner({ message }) {
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      {message}
    </div>
  );
}
