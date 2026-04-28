// Top-of-page header: tenant name + role/user + sign out.
// Pages embed this above their main content.

import { useAuth } from '../auth.jsx';

export default function Header() {
  const { me, logout } = useAuth();
  if (!me) return null;
  const role = me.memberships.admin
    ? `${me.memberships.admin.role}: ${me.user.first_name}`
    : `Member: ${me.user.first_name}`;
  return (
    <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
      <div className="font-semibold">{me.tenant.name}</div>
      <div className="flex items-center gap-3 text-sm text-slate-600">
        <span>{role}</span>
        <button
          onClick={logout}
          className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
