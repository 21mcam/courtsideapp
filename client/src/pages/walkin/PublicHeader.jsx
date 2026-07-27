// Shared header for the public (no-login) pages: walk-in flow,
// success page, manage/reschedule page. Tenant avatar + name, with an
// optional right-side slot (the walk-in page puts the subtle member
// sign-in link there — it must never become a wall in the funnel).

import { useAuth } from '../../auth.jsx';

export default function PublicHeader({ right = null }) {
  const { tenant } = useAuth();
  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-semibold text-white">
          {tenant.name?.charAt(0).toUpperCase()}
        </div>
        <div className="truncate font-semibold text-slate-900">
          {tenant.name}
        </div>
      </div>
      {right}
    </header>
  );
}
