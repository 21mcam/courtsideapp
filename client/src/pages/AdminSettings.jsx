// Admin settings: appearance (tenant accent color) + facility info.
// The accent applies live on click, then persists via PUT
// /api/admin/theme (which needs migration 019 on the live DB).

import { useState } from 'react';
import { Check } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ACCENTS, DEFAULT_ACCENT } from '../theme.js';
import { US_STATES } from '../lib/usStates.js';
import SettingsNav from '../components/SettingsNav.jsx';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Page,
  PageHeader,
  Select,
} from '../components/ui/index.js';

export default function AdminSettings() {
  const { tenant, updateTenant } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [replyTo, setReplyTo] = useState(tenant.reply_to_email || '');
  const [replyToSaving, setReplyToSaving] = useState(false);
  const [replyToError, setReplyToError] = useState(null);
  const [replyToSaved, setReplyToSaved] = useState(false);

  const [biz, setBiz] = useState({
    address_street: tenant.address?.street || '',
    address_city: tenant.address?.city || '',
    address_state: tenant.address?.state || '',
    address_zip: tenant.address?.zip || '',
    business_phone: tenant.business_phone || '',
    google_rating: tenant.google_rating != null ? String(tenant.google_rating) : '',
    google_review_count:
      tenant.google_review_count != null ? String(tenant.google_review_count) : '',
    google_reviews_url: tenant.google_reviews_url || '',
    ga4_measurement_id: tenant.ga4_measurement_id || '',
  });
  const [bizSaving, setBizSaving] = useState(false);
  const [bizError, setBizError] = useState(null);
  const [bizSaved, setBizSaved] = useState(false);

  const current = tenant.theme_accent || DEFAULT_ACCENT;

  function setBizField(field, value) {
    setBiz((b) => ({ ...b, [field]: value }));
    setBizSaved(false);
  }

  async function saveBusinessInfo(e) {
    e.preventDefault();
    if (bizSaving) return;
    setBizSaving(true);
    setBizError(null);
    setBizSaved(false);
    try {
      const payload = {
        address_street: biz.address_street.trim() || null,
        address_city: biz.address_city.trim() || null,
        address_state: biz.address_state || null,
        address_zip: biz.address_zip.trim() || null,
        business_phone: biz.business_phone.trim() || null,
        google_rating: biz.google_rating === '' ? null : Number(biz.google_rating),
        google_review_count:
          biz.google_review_count === '' ? null : Number(biz.google_review_count),
        google_reviews_url: biz.google_reviews_url.trim() || null,
        ga4_measurement_id: biz.ga4_measurement_id.trim().toUpperCase() || null,
      };
      const res = await api('/api/admin/business-info', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      updateTenant({
        address: {
          street: payload.address_street,
          city: payload.address_city,
          state: payload.address_state,
          zip: payload.address_zip,
        },
        business_phone: payload.business_phone,
        google_rating: payload.google_rating,
        google_review_count: payload.google_review_count,
        google_reviews_url: payload.google_reviews_url,
        ga4_measurement_id: payload.ga4_measurement_id,
      });
      setBizSaved(true);
    } catch (err) {
      setBizError(`Couldn't save business info: ${err.message}`);
    } finally {
      setBizSaving(false);
    }
  }

  async function saveReplyTo(e) {
    e.preventDefault();
    if (replyToSaving) return;
    setReplyToSaving(true);
    setReplyToError(null);
    setReplyToSaved(false);
    try {
      const res = await api('/api/admin/reply-to-email', {
        method: 'PUT',
        body: JSON.stringify({ reply_to_email: replyTo.trim() || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = await res.json();
      updateTenant({ reply_to_email: body.reply_to_email });
      setReplyTo(body.reply_to_email || '');
      setReplyToSaved(true);
    } catch (err) {
      setReplyToError(`Couldn't save reply-to address: ${err.message}`);
    } finally {
      setReplyToSaving(false);
    }
  }

  async function pickAccent(key) {
    if (key === current || saving) return;
    setSaving(true);
    setError(null);
    const previous = current;
    updateTenant({ theme_accent: key }); // live preview
    try {
      const res = await api('/api/admin/theme', {
        method: 'PUT',
        body: JSON.stringify({ accent: key }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      updateTenant({ theme_accent: previous }); // roll back preview
      setError(`Couldn't save accent color: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page width="narrow">
      <PageHeader
        title="Settings"
        description="Appearance and facility details."
      />
      <SettingsNav />

      <Card title="Appearance">
        <p className="mb-4 text-sm text-slate-500">
          Accent color for buttons, links, and your public booking page.
        </p>
        {error && (
          <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          {Object.entries(ACCENTS).map(([key, accent]) => {
            const selected = key === current;
            return (
              <button
                key={key}
                onClick={() => pickAccent(key)}
                disabled={saving}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  selected
                    ? 'border-brand-600 bg-brand-50 text-brand-700'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span
                  className="flex h-5 w-5 items-center justify-center rounded-full"
                  style={{ backgroundColor: accent.swatch }}
                >
                  {selected && <Check size={12} className="text-white" />}
                </span>
                {accent.label}
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="Facility">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-slate-500">Name</dt>
          <dd className="font-medium">{tenant.name}</dd>
          <dt className="text-slate-500">Subdomain</dt>
          <dd>
            <Badge tone="brand">{tenant.subdomain}</Badge>
          </dd>
          <dt className="text-slate-500">Timezone</dt>
          <dd className="font-mono text-xs">{tenant.timezone}</dd>
          <dt className="text-slate-500">ID</dt>
          <dd className="font-mono text-xs text-slate-500">{tenant.id}</dd>
        </dl>
      </Card>

      <Card title="Business info">
        <p className="mb-4 text-sm text-slate-500">
          Shown on your public booking page. The rating and review count
          appear next to your name — copy them from your Google Business
          profile.
        </p>
        {bizError && (
          <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {bizError}
          </div>
        )}
        <form onSubmit={saveBusinessInfo} className="space-y-4">
          <Field label="Street address">
            <Input
              autoComplete="street-address"
              value={biz.address_street}
              onChange={(e) => setBizField('address_street', e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem_8rem]">
            <Field label="City">
              <Input
                value={biz.address_city}
                onChange={(e) => setBizField('address_city', e.target.value)}
              />
            </Field>
            <Field label="State">
              <Select
                value={biz.address_state}
                onChange={(e) => setBizField('address_state', e.target.value)}
              >
                <option value="">—</option>
                {US_STATES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {code} — {name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="ZIP">
              <Input
                inputMode="numeric"
                placeholder="10307"
                value={biz.address_zip}
                onChange={(e) => setBizField('address_zip', e.target.value)}
              />
            </Field>
          </div>
          <Field label="Phone">
            <Input
              type="tel"
              autoComplete="tel"
              value={biz.business_phone}
              onChange={(e) => setBizField('business_phone', e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Google rating" hint="0–5, e.g. 5.0">
              <Input
                type="number"
                min="0"
                max="5"
                step="0.1"
                value={biz.google_rating}
                onChange={(e) => setBizField('google_rating', e.target.value)}
              />
            </Field>
            <Field label="Review count">
              <Input
                type="number"
                min="0"
                step="1"
                value={biz.google_review_count}
                onChange={(e) =>
                  setBizField('google_review_count', e.target.value)
                }
              />
            </Field>
          </div>
          <Field
            label="Google reviews link"
            hint="Where the rating badge links — your Google reviews page."
          >
            <Input
              type="url"
              placeholder="https://g.page/..."
              value={biz.google_reviews_url}
              onChange={(e) => setBizField('google_reviews_url', e.target.value)}
            />
          </Field>
          <Field
            label="GA4 measurement ID"
            hint="G-XXXXXXXXXX — leave blank to disable analytics on your booking page."
          >
            <Input
              placeholder="G-XXXXXXXXXX"
              value={biz.ga4_measurement_id}
              onChange={(e) => setBizField('ga4_measurement_id', e.target.value)}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={bizSaving}>
              {bizSaving ? 'Saving…' : 'Save business info'}
            </Button>
            {bizSaved && <span className="text-xs text-emerald-600">Saved.</span>}
          </div>
        </form>
      </Card>

      <Card title="Email">
        <p className="mb-4 text-sm text-slate-500">
          Replies to booking confirmations and other system emails go to
          this address. Leave blank for no reply-to.
        </p>
        {replyToError && (
          <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {replyToError}
          </div>
        )}
        <form onSubmit={saveReplyTo} className="flex items-end gap-3">
          <Field label="Reply-to address" className="grow">
            <Input
              type="email"
              placeholder="frontdesk@yourfacility.com"
              value={replyTo}
              onChange={(e) => {
                setReplyTo(e.target.value);
                setReplyToSaved(false);
              }}
            />
          </Field>
          <Button type="submit" disabled={replyToSaving}>
            {replyToSaving ? 'Saving…' : 'Save'}
          </Button>
        </form>
        {replyToSaved && (
          <p className="mt-2 text-xs text-emerald-600">Saved.</p>
        )}
      </Card>
    </Page>
  );
}
