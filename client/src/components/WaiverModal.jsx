// Liability waiver signing modal — member booking flows.
//
// Opened by BookingPage / ClassesPage when a booking attempt comes
// back 409 with code 'waiver_signature_required'. Fetches the current
// waiver text (GET /api/waivers/current), renders it scrollably, and
// records the signature (POST /api/waivers/sign) with a typed full
// name plus an optional minor/guardian section. On success calls
// onSigned() so the caller can retry the booking automatically.

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button, Field, Input } from './ui/index.js';

export default function WaiverModal({ onClose, onSigned }) {
  const [waiver, setWaiver] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [signerName, setSignerName] = useState('');
  const [isMinor, setIsMinor] = useState(false);
  const [guardianName, setGuardianName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api('/api/waivers/current')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
      })
      .then((body) => {
        if (alive) setWaiver(body);
      })
      .catch((err) => {
        if (alive) setLoadError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (busy || !agreed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api('/api/waivers/sign', {
        method: 'POST',
        body: JSON.stringify({
          signer_name: signerName.trim(),
          ...(isMinor
            ? { is_minor: true, guardian_name: guardianName.trim() }
            : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onSigned();
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
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-slate-900">
            Liability waiver
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          This facility requires a signed waiver before booking. Read
          it, then sign with your full legal name.
        </p>

        {loadError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {loadError}
          </div>
        )}

        {!waiver && !loadError && (
          <p className="py-6 text-center text-sm text-slate-400">loading…</p>
        )}

        {waiver && (
          <form onSubmit={submit} className="space-y-4">
            <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {waiver.waiver_text || 'No waiver text has been provided.'}
            </div>

            <Field label="Full legal name (this is your signature)">
              <Input
                required
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="e.g. Jordan Alvarez"
              />
            </Field>

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={isMinor}
                onChange={(e) => setIsMinor(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              I am signing on behalf of a minor
            </label>

            {isMinor && (
              <Field
                label="Parent / guardian full name"
                hint="The participant's name goes above; the signing adult's name goes here."
              >
                <Input
                  required
                  value={guardianName}
                  onChange={(e) => setGuardianName(e.target.value)}
                />
              </Field>
            )}

            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              I have read and agree to the waiver above.
            </label>

            {error && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || !agreed || !signerName.trim()}
              >
                {busy ? 'Signing…' : 'Sign and continue'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
