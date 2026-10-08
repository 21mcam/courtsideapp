// "Classes & clinics" entry point under the rental service list.
// Fetched lazily AFTER the service list renders (never blocks the
// funnel's first paint) and renders nothing unless the facility has
// classes open for walk-ins — no dead link for rental-only tenants.
// In normal flow at the end of the list: no fixed positioning, so the
// walk-in occlusion rule is untouched.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Users } from 'lucide-react';

import { api } from '../../api.js';

export default function ClassesTeaser() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api('/api/customers/classes')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!cancelled && b?.classes) {
          setCount(b.classes.filter((c) => c.spots_remaining > 0).length);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (count === 0) return null;
  return (
    <Link
      to="/walk-in/classes"
      className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3.5 hover:bg-slate-50"
    >
      <Users size={18} className="shrink-0 text-brand-600" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-slate-900">Classes &amp; clinics</p>
        <p className="text-sm text-slate-500">
          {count} upcoming session{count === 1 ? '' : 's'} with open spots
        </p>
      </div>
      <ChevronRight size={18} className="shrink-0 text-slate-300" />
    </Link>
  );
}
