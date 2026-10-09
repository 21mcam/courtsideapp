// The facility's public front door: what a logged-out visitor sees at
// {subdomain}.{APP_HOSTNAME}/. Before this, "/" bounced anonymous
// visitors to /login — a dead end for anyone arriving from Google or
// an Instagram bio.
//
// One job: get the visitor booking (→ /walk-in) or signed in. Same
// mobile-first public styling as the walk-in flow; no fixed bars (the
// walk-in occlusion rule applies here too). Everything renders from
// GET /api/tenant (already loaded) + GET /api/customers/offerings +
// GET /api/customers/home; sections with no data simply don't render,
// so a half-configured facility still gets a clean page.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, MapPin, Phone } from 'lucide-react';

import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatCents } from '../format.js';
import { initAnalytics } from '../lib/analytics.js';
import {
  dayName,
  formatIntervals,
  mondayFirst,
  openStatus,
  tenantClock,
} from '../lib/publicHome.js';
import { buildWalkInParams } from '../lib/walkinParams.js';
import PublicHeader from './walkin/PublicHeader.jsx';
import RatingBadge from './walkin/RatingBadge.jsx';
import ClassesTeaser from './walkin/ClassesTeaser.jsx';

const SERVICES_SHOWN = 6;

export default function PublicHomePage() {
  const { tenant } = useAuth();
  const [offerings, setOfferings] = useState(null);
  const [home, setHome] = useState(null);

  useEffect(() => {
    initAnalytics(tenant.ga4_measurement_id);
    let cancelled = false;
    api('/api/customers/offerings')
      .then((r) => (r.ok ? r.json() : { offerings: [] }))
      .then((b) => !cancelled && setOfferings(b.offerings ?? []))
      .catch(() => !cancelled && setOfferings([]));
    api('/api/customers/home')
      .then((r) => (r.ok ? r.json() : { hours: [], plans: [] }))
      .then((b) => !cancelled && setHome(b))
      .catch(() => !cancelled && setHome({ hours: [], plans: [] }));
    return () => {
      cancelled = true;
    };
  }, [tenant.ga4_measurement_id]);

  // Search/social preview text. The SPA sets it at runtime; Google
  // renders JS, link unfurlers mostly don't — good enough for v1.
  useEffect(() => {
    const city = tenant.address?.city;
    const text = `Book online at ${tenant.name}${city ? ` in ${city}` : ''}. See prices, hours and open times — no account needed.`;
    let tag = document.querySelector('meta[name="description"]');
    if (!tag) {
      tag = document.createElement('meta');
      tag.name = 'description';
      document.head.appendChild(tag);
    }
    tag.content = text;
  }, [tenant.name, tenant.address?.city]);

  const address = tenant.address ?? {};
  const addressLine = [
    address.street,
    address.city,
    [address.state, address.zip].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');

  const status = useMemo(
    () => (home ? openStatus(home.hours, tenant.timezone) : null),
    [home, tenant.timezone],
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <PublicHeader
        right={
          <Link to="/login" className="shrink-0 text-sm font-medium text-slate-600 hover:text-slate-900">
            Sign in
          </Link>
        }
      />

      <main className="mx-auto max-w-2xl space-y-6 px-4 py-6 sm:px-6 sm:py-10">
        {/* Hero */}
        <section>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            {tenant.name}
          </h1>
          <RatingBadge />
          {status && (
            <p className={`mt-2 text-sm font-medium ${status.open ? 'text-emerald-700' : 'text-slate-500'}`}>
              {status.label}
            </p>
          )}
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <Link
              to="/walk-in"
              className="inline-flex h-12 items-center justify-center rounded-xl bg-brand-600 px-6 text-base font-semibold text-white shadow-sm hover:bg-brand-500"
            >
              Book a session
            </Link>
            <Link
              to="/login"
              className="inline-flex h-12 items-center justify-center rounded-xl border border-slate-300 bg-white px-6 text-base font-medium text-slate-700 hover:bg-slate-50"
            >
              Member sign in
            </Link>
          </div>
        </section>

        <ServicesSection offerings={offerings} />
        {/* Renders only when walk-in classes have open spots. */}
        <ClassesTeaser />
        <HoursSection home={home} tz={tenant.timezone} />
        <PlansSection plans={home?.plans} />

        {(addressLine || tenant.business_phone) && (
          <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-5 text-sm">
            {addressLine && (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${tenant.name}, ${addressLine}`)}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-start gap-2 text-slate-700 hover:text-slate-900"
              >
                <MapPin size={16} className="mt-0.5 shrink-0 text-slate-400" />
                <span>{addressLine}</span>
              </a>
            )}
            {tenant.business_phone && (
              <a
                href={`tel:${tenant.business_phone.replace(/[^\d+]/g, '')}`}
                className="flex items-center gap-2 text-slate-700 hover:text-slate-900"
              >
                <Phone size={16} className="shrink-0 text-slate-400" />
                <span>{tenant.business_phone}</span>
              </a>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function SectionTitle({ children, action }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-base font-semibold text-slate-900">{children}</h2>
      {action}
    </div>
  );
}

function ServicesSection({ offerings }) {
  if (!offerings?.length) return null;
  const shown = offerings.slice(0, SERVICES_SHOWN);
  return (
    <section>
      <SectionTitle
        action={
          offerings.length > SERVICES_SHOWN && (
            <Link to="/walk-in" className="text-sm font-medium text-brand-600 hover:text-brand-500">
              See all {offerings.length}
            </Link>
          )
        }
      >
        Book online
      </SectionTitle>
      <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {shown.map((o) => (
          <li key={o.id}>
            <Link
              to={`/walk-in?${buildWalkInParams({ offeringId: o.id })}`}
              className="flex items-center justify-between gap-4 px-4 py-3.5 hover:bg-slate-50"
            >
              <div className="min-w-0">
                <p className="font-medium text-slate-900">{o.name}</p>
                <p className="text-sm text-slate-500">{o.duration_minutes} min</p>
              </div>
              <span className="shrink-0 font-semibold text-slate-900">
                {/* Same formatter + field as the walk-in ServiceList
                    (dollar_price is integer cents) — one price everywhere. */}
                {formatCents(o.dollar_price)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HoursSection({ home, tz }) {
  if (!home || !home.hours.some((d) => d.intervals.length)) return null;
  const today = tenantClock(tz).dow;
  return (
    <section>
      <SectionTitle>Hours</SectionTitle>
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <dl className="space-y-1.5 text-sm">
          {mondayFirst(home.hours).map((d) => {
            const isToday = d.day_of_week === today;
            return (
              <div key={d.day_of_week} className="flex justify-between gap-4">
                <dt className={isToday ? 'font-semibold text-slate-900' : 'text-slate-600'}>
                  {dayName(d.day_of_week)}
                </dt>
                <dd
                  className={`text-right ${
                    isToday ? 'font-semibold text-slate-900' : d.intervals.length ? 'text-slate-700' : 'text-slate-400'
                  }`}
                >
                  {formatIntervals(d.intervals)}
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
          <Clock size={13} /> Live availability is shown when you book.
        </p>
      </div>
    </section>
  );
}

function PlansSection({ plans }) {
  if (!plans?.length) return null;
  return (
    <section>
      <SectionTitle>Memberships</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        {plans.map((p) => (
          <div key={p.id} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4">
            <p className="font-semibold text-slate-900">{p.name}</p>
            <p className="mt-1 text-slate-900">
              <span className="text-xl font-semibold">{formatCents(p.monthly_price_cents)}</span>
              <span className="text-sm text-slate-500">/month</span>
            </p>
            <p className="text-sm text-slate-600">
              {p.credits_per_week} credit{p.credits_per_week === 1 ? '' : 's'} every week
            </p>
            {p.description && <p className="mt-2 text-sm text-slate-500">{p.description}</p>}
          </div>
        ))}
      </div>
      <Link
        to="/register"
        className="mt-3 inline-flex h-11 w-full items-center justify-center rounded-xl border border-brand-600 bg-white text-sm font-semibold text-brand-700 hover:bg-brand-50"
      >
        Become a member
      </Link>
    </section>
  );
}
