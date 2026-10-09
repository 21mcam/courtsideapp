// /walk-in/classes — book a spot in a class/clinic without an account
// (customer-side slice 4). Separate from the rental walk-in page on
// purpose: that page's funnel is measured and tuned (tap count,
// occlusion, one price) and classes are a different shape — no
// resource or slot picking, just "which session?".
//
// Two steps, URL-derived like the rental flow so refresh and hardware
// back work:
//   /walk-in/classes            → schedule, grouped by day
//   /walk-in/classes?class=<id> → details + pay
//
// Same rules as the rental checkout: one price (the listed price is
// the charge), three required fields, inline waiver when the tenant
// requires one, trust copy from the server's policy block, no fixed
// bars. Payment → Stripe Checkout → /walk-in/success (which looks the
// spot up by id + email).

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Users } from 'lucide-react';

import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { formatCents, formatTimeLocal } from '../../format.js';
import { initAnalytics } from '../../lib/analytics.js';
import { normalizeFullName } from '../../lib/walkinParams.js';
import { Badge, Button, Card, Field, Input } from '../../components/ui/index.js';
import PublicHeader from './PublicHeader.jsx';
import WaiverSection from './WaiverSection.jsx';

const EMPTY_WAIVER = { signer_name: '', is_minor: false, guardian_name: '', agreed: false };

function dayKey(iso, tz) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
}

function dayLabel(iso, tz) {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

// From the instance itself — a session can run longer than the
// offering's default duration.
function minutes(c) {
  return Math.round((new Date(c.end_time) - new Date(c.start_time)) / 60000);
}

function spotsBadge(n) {
  if (n <= 0) return <Badge tone="neutral">Full</Badge>;
  if (n <= 3) return <Badge tone="warning">{n} spot{n === 1 ? '' : 's'} left</Badge>;
  return <Badge tone="success">{n} spots left</Badge>;
}

export default function WalkInClassesPage() {
  const { tenant } = useAuth();
  const tz = tenant.timezone;
  const [searchParams, setSearchParams] = useSearchParams();
  const classId = searchParams.get('class');

  const [data, setData] = useState(null); // { classes, policy }
  const [loadError, setLoadError] = useState(null);
  const [waiver, setWaiver] = useState(null);
  const [notice, setNotice] = useState(
    searchParams.get('cancelled') ? "Payment didn't go through — nothing was booked." : null,
  );

  const load = () =>
    api('/api/customers/classes')
      .then(async (r) => {
        if (!r.ok) throw new Error();
        setData(await r.json());
      })
      .catch(() => setLoadError('Could not load the class schedule. Please refresh.'));

  useEffect(() => {
    initAnalytics(tenant.ga4_measurement_id);
    load();
    api('/api/waivers/current')
      .then((r) => (r.ok ? r.json() : null))
      .then((w) => w && setWaiver(w))
      .catch(() => {});
  }, [tenant.ga4_measurement_id]);

  const selected = useMemo(
    () => data?.classes.find((c) => c.id === classId) ?? null,
    [data, classId],
  );

  const days = useMemo(() => {
    const groups = new Map();
    for (const c of data?.classes ?? []) {
      const k = dayKey(c.start_time, tz);
      if (!groups.has(k)) groups.set(k, { label: dayLabel(c.start_time, tz), items: [] });
      groups.get(k).items.push(c);
    }
    return [...groups.values()];
  }, [data, tz]);

  function choose(id) {
    setNotice(null);
    setSearchParams({ class: id });
    window.scrollTo(0, 0);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <PublicHeader
        right={
          <Link to="/login" className="shrink-0 text-sm font-medium text-slate-600 hover:text-slate-900">
            Member sign in
          </Link>
        }
      />
      <main className="mx-auto max-w-2xl space-y-5 p-4 pb-12 sm:p-6">
        {!selected && (
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Classes &amp; clinics</h1>
            <p className="mt-1.5 text-sm text-slate-500">
              Grab a spot, pay by card, done. No account needed.{' '}
              <Link to="/walk-in" className="font-medium text-brand-600 hover:text-brand-500">
                Book a cage or lane instead
              </Link>
            </p>
          </div>
        )}

        {notice && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {notice}
          </div>
        )}
        {loadError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {loadError}
          </div>
        )}
        {!data && !loadError && (
          <Card>
            <p className="text-sm text-slate-400">Loading classes…</p>
          </Card>
        )}

        {data && !classId && days.length === 0 && (
          <Card>
            <p className="text-sm text-slate-600">No classes are open for booking right now.</p>
            <Link to="/walk-in" className="mt-2 inline-block text-sm font-medium text-brand-600">
              Book a session instead →
            </Link>
          </Card>
        )}

        {data && !classId &&
          days.map((d) => (
            <section key={d.label}>
              <h2 className="mb-2 text-sm font-semibold text-slate-700">{d.label}</h2>
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
                {d.items.map((c) => {
                  const full = c.spots_remaining <= 0;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        disabled={full}
                        onClick={() => choose(c.id)}
                        className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-slate-900">{c.offering_name}</p>
                          <p className="text-sm text-slate-500">
                            {formatTimeLocal(c.start_time, tz)} · {minutes(c)} min
                          </p>
                          <div className="mt-1.5">{spotsBadge(c.spots_remaining)}</div>
                        </div>
                        <span className="shrink-0 font-semibold text-slate-900">
                          {formatCents(c.dollar_price)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

        {data && classId && !selected && (
          <Card>
            <p className="text-sm text-slate-600">That class isn't available any more.</p>
            <button
              type="button"
              onClick={() => setSearchParams({})}
              className="mt-2 text-sm font-medium text-brand-600"
            >
              See the schedule →
            </button>
          </Card>
        )}

        {selected && (
          <ClassCheckout
            key={selected.id}
            cls={selected}
            tz={tz}
            holdMinutes={data.policy?.hold_minutes}
            waiver={waiver}
            onWaiverRefresh={setWaiver}
            onBack={() => setSearchParams({})}
            onGone={(msg) => {
              setNotice(msg);
              setSearchParams({});
              load();
            }}
          />
        )}
      </main>
    </div>
  );
}

function ClassCheckout({ cls, tz, holdMinutes, waiver, onWaiverRefresh, onBack, onGone }) {
  const [contact, setContact] = useState({ full_name: '', phone: '', email: '' });
  const [waiverForm, setWaiverForm] = useState(EMPTY_WAIVER);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const waiverRequired = waiver?.waiver_required === true;
  const waiverComplete =
    !waiverRequired ||
    (waiverForm.agreed &&
      waiverForm.signer_name.trim() &&
      (!waiverForm.is_minor || waiverForm.guardian_name.trim()));
  const contactComplete =
    normalizeFullName(contact.full_name) && contact.phone.trim() && contact.email.trim();

  const set = (k) => (e) => {
    const value = e.target.value;
    setContact((c) => ({ ...c, [k]: value }));
    // Prefill the waiver signature from the name until they edit it.
    if (k === 'full_name') {
      setWaiverForm((w) => (w.touched ? w : { ...w, signer_name: normalizeFullName(value) }));
    }
  };

  async function submit(e) {
    e.preventDefault();
    if (submitting || !contactComplete || !waiverComplete) return;
    setSubmitting(true);
    setError(null);
    const payload = {
      class_instance_id: cls.id,
      customer: {
        full_name: normalizeFullName(contact.full_name),
        phone: contact.phone.trim(),
        email: contact.email.trim(),
      },
      ...(waiverRequired
        ? {
            waiver: {
              signer_name: waiverForm.signer_name.trim(),
              waiver_version: waiver?.waiver_version,
              ...(waiverForm.is_minor
                ? { is_minor: true, guardian_name: waiverForm.guardian_name.trim() }
                : {}),
            },
          }
        : {}),
      success_url: `${window.location.origin}/walk-in/success`,
      cancel_url: `${window.location.origin}/walk-in/classes?cancelled=1&class=${cls.id}`,
    };
    try {
      const res = await api('/api/customers/class-bookings', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        try {
          sessionStorage.setItem('courtside_walkin_email', payload.customer.email.toLowerCase());
          sessionStorage.setItem('courtside_walkin_booking_id', body.booking.id);
        } catch {
          // private mode — the success page asks for the email
        }
        window.location.assign(body.checkout_url);
        return;
      }
      if (body.code === 'class_full') {
        onGone('Sorry — that class just filled up. Pick another session.');
        return;
      }
      if (body.code === 'waiver_version_mismatch') {
        const fresh = await api('/api/waivers/current').then((r) => (r.ok ? r.json() : null));
        if (fresh) onWaiverRefresh(fresh);
        setWaiverForm((w) => ({ ...w, agreed: false }));
        setError('The waiver was updated — please review the new version and agree again.');
      } else {
        setError(body.error || 'Something went wrong. Please try again.');
      }
    } catch {
      setError('Could not reach the server. Please try again.');
    }
    setSubmitting(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft size={16} /> All classes
      </button>
      <Card title="Your spot">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-medium text-slate-900">{cls.offering_name}</p>
            <p className="text-sm text-slate-500">
              {dayLabel(cls.start_time, tz)} · {formatTimeLocal(cls.start_time, tz)} ·{' '}
              {minutes(cls)} min
            </p>
            <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
              <Users size={13} /> {cls.spots_remaining} of {cls.capacity} spots left
            </p>
            {cls.description && <p className="mt-2 text-sm text-slate-600">{cls.description}</p>}
          </div>
          <span data-testid="class-price" className="shrink-0 text-lg font-semibold text-slate-900">
            {formatCents(cls.dollar_price)}
          </span>
        </div>
      </Card>
      <Card title="Your details">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Full name">
            <Input required autoComplete="name" autoCapitalize="words" value={contact.full_name} onChange={set('full_name')} />
          </Field>
          <Field label="Mobile phone">
            <Input required type="tel" inputMode="tel" autoComplete="tel" value={contact.phone} onChange={set('phone')} />
          </Field>
          <Field label="Email" hint="Your confirmation lands here.">
            <Input
              required
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              value={contact.email}
              onChange={set('email')}
            />
          </Field>
          {waiverRequired && (
            <WaiverSection
              waiver={waiver}
              form={waiverForm}
              onChange={(f) => setWaiverForm({ ...f, touched: true })}
            />
          )}
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <Button
            type="submit"
            className="h-12 w-full text-base"
            disabled={submitting || !contactComplete || !waiverComplete}
          >
            {submitting ? 'Opening secure checkout…' : `Pay ${formatCents(cls.dollar_price)}`}
          </Button>
          {holdMinutes && (
            <p className="text-center text-xs text-slate-500">
              Your spot is held for {holdMinutes} minutes while you pay. Card payment by Stripe.
            </p>
          )}
        </form>
      </Card>
    </>
  );
}
