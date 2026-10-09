// "Who's this for?" on the member booking pages (migration 034,
// docs/design/FAMILY_ACCOUNTS.md). Renders nothing unless the member has
// family members, so single members see no change. "Me" is always the
// first choice. Credits always come off the member's balance — the
// picker only records who attends.

import { useEffect, useState } from 'react';

import { api } from '../api.js';

// → [dependents | null(loading)]
export function useDependents() {
  const [list, setList] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api('/api/me/dependents')
      .then((r) => (r.ok ? r.json() : { dependents: [] }))
      .then((b) => !cancelled && setList(b.dependents ?? []))
      .catch(() => !cancelled && setList([]));
    return () => {
      cancelled = true;
    };
  }, []);
  return list;
}

// value: dependent id, or '' for the member themself.
export default function ParticipantPicker({ dependents, value, onChange }) {
  if (!dependents || dependents.length === 0) return null;
  const options = [{ id: '', label: 'Me' }, ...dependents.map((d) => ({ id: d.id, label: d.first_name }))];
  return (
    <div>
      <p className="text-sm font-medium text-slate-700">Who&apos;s this for?</p>
      <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Who's this for?">
        {options.map((o) => {
          const selected = value === o.id;
          return (
            <button
              key={o.id || 'me'}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(o.id)}
              className={`h-9 rounded-full px-4 text-sm font-medium ring-1 ring-inset transition-colors ${
                selected
                  ? 'bg-brand-600 text-white ring-brand-600'
                  : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-slate-500">Uses your credits either way.</p>
    </div>
  );
}

// Body fragment for the booking POSTs.
export function participantBody(dependentId) {
  return dependentId ? { dependent_id: dependentId } : {};
}
