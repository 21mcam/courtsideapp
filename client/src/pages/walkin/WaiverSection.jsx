// Inline liability waiver block for the walk-in details form.
// Extracted unchanged from the old WalkInPage; rendered only when the
// tenant requires a waiver. The signature rides along with the
// booking create in the same transaction server-side.

import { Field, Input } from '../../components/ui/index.js';

export default function WaiverSection({ waiver, form, onChange }) {
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-4">
      <h3 className="text-sm font-semibold text-slate-900">
        Liability waiver
      </h3>
      <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
        {waiver.waiver_text || 'No waiver text has been provided.'}
      </div>
      <Field label="Full legal name (this is your signature)">
        <Input
          required
          autoComplete="name"
          autoCapitalize="words"
          value={form.signer_name}
          onChange={(e) => onChange({ ...form, signer_name: e.target.value })}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={form.is_minor}
          onChange={(e) => onChange({ ...form, is_minor: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
        I am signing on behalf of a minor
      </label>
      {form.is_minor && (
        <Field
          label="Parent / guardian full name"
          hint="The participant's name goes above; the signing adult's name goes here."
        >
          <Input
            required
            value={form.guardian_name}
            onChange={(e) =>
              onChange({ ...form, guardian_name: e.target.value })
            }
          />
        </Field>
      )}
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={form.agreed}
          onChange={(e) => onChange({ ...form, agreed: e.target.checked })}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
        I have read and agree to the waiver above.
      </label>
    </div>
  );
}
