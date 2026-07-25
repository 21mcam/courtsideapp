// Admin → Credit packs (credit-packs slice).
//
// One-time purchasable credit bundles — "10-pack, $90, no
// subscription". Create, edit, and deactivate/reactivate. Members
// buy active packs from the Plans page; the Stripe webhook grants
// the credits (reason 'pack_purchase'), and purchased credits
// survive the Monday weekly reset until spent.
//
// Price is entered in dollars, sent as integer cents — same
// convention as the plan/offering forms.

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatCents } from '../format.js';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Page,
  PageHeader,
} from '../components/ui/index.js';

export default function AdminPacks() {
  const [packs, setPacks] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [editing, setEditing] = useState(null);

  function load() {
    setLoadError(null);
    api('/api/admin/packs')
      .then(handle)
      .then((body) => setPacks(body.packs ?? []))
      .catch((err) => setLoadError(err.message));
  }

  useEffect(load, []);

  return (
    <Page width="narrow">
      <PageHeader
        title="Credit packs"
        description="One-time credit bundles members can buy without a subscription. Purchased credits roll over week to week until they're used."
      />

      {loadError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {loadError}
        </div>
      )}

      <CreatePackCard onCreated={load} />

      <Card title="Your packs">
        {packs === null ? (
          <p className="text-sm text-slate-400">loading…</p>
        ) : packs.length === 0 ? (
          <p className="text-sm text-slate-500">
            No packs yet. Create one above — a 10-pack is the classic
            on-ramp for new members.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Credits</th>
                  <th className="py-2 pr-4">Price</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {packs.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100">
                    <td className="py-2 pr-4 font-medium text-slate-900">
                      {p.name}
                    </td>
                    <td className="py-2 pr-4">{p.credits}</td>
                    <td className="py-2 pr-4">{formatCents(p.price_cents)}</td>
                    <td className="py-2 pr-4">
                      {p.active ? (
                        <Badge tone="success">active</Badge>
                      ) : (
                        <Badge tone="neutral">inactive</Badge>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditing(p)}
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <PackEditModal
          pack={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </Page>
  );
}

function CreatePackCard({ onCreated }) {
  const [name, setName] = useState('');
  const [credits, setCredits] = useState(10);
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/admin/packs', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          credits: Number(credits),
          price_cents: Math.round(Number(price) * 100),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setName('');
      setCredits(10);
      setPrice('');
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="New pack">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="10-Pack"
              required
            />
          </Field>
          <Field label="Credits">
            <Input
              type="number"
              min="1"
              step="1"
              value={credits}
              onChange={(e) => setCredits(e.target.value)}
              required
            />
          </Field>
          <Field label="Price (USD)">
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="90.00"
              required
            />
          </Field>
        </div>
        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}
        <div className="flex justify-end">
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create pack'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PackEditModal({ pack, onClose, onSaved }) {
  const [name, setName] = useState(pack.name);
  const [credits, setCredits] = useState(pack.credits);
  const [price, setPrice] = useState(pack.price_cents / 100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function patch(body) {
    const res = await api(`/api/admin/packs/${pack.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await patch({
        name: name.trim(),
        credits: Number(credits),
        price_cents: Math.round(Number(price) * 100),
      });
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function toggleActive() {
    const confirmText = pack.active
      ? `Deactivate "${pack.name}"? Members won't be able to buy it. Credits already purchased are untouched. You can reactivate it anytime.`
      : `Reactivate "${pack.name}"? Members will be able to buy it again.`;
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      await patch({ active: !pack.active });
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/30"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative w-full max-w-lg rounded-lg bg-white shadow-xl border border-slate-200 p-5 max-h-[90vh] overflow-y-auto">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Edit pack</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xl leading-none text-slate-500 hover:text-slate-800"
          >
            ×
          </button>
        </div>
        {!pack.active && (
          <p className="mb-4 text-sm text-slate-500">This pack is deactivated.</p>
        )}
        <form onSubmit={submit}>
          <div className="space-y-4">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Credits"
                hint="Applies to new purchases only — past purchases keep what was granted."
              >
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={credits}
                  onChange={(e) => setCredits(e.target.value)}
                  required
                />
              </Field>
              <Field label="Price (USD)">
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  required
                />
              </Field>
            </div>
          </div>
          {error && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}
          <div className="mt-6 flex items-center justify-between border-t border-slate-100 pt-4">
            <Button
              type="button"
              size="sm"
              variant={pack.active ? 'danger' : 'secondary'}
              onClick={toggleActive}
              disabled={busy}
            >
              {pack.active ? 'Deactivate pack' : 'Reactivate'}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
