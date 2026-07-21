// Persistent app chrome for all authed pages: fixed left sidebar on
// desktop, top bar + slide-over drawer on mobile. Rendered as a
// layout route in App.jsx; pages render into <Outlet/>.
//
// Deliberately NOT an h-screen flex shell — the window stays the
// scroll container so AdminCalendar's sticky time labels and fixed
// slide-over keep working.

import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  BookOpenCheck,
  CalendarDays,
  CreditCard,
  Home,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Ticket,
  Users,
  Wand2,
  X,
} from 'lucide-react';
import { useAuth } from '../auth.jsx';

const ADMIN_NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/admin/bookings', label: 'Bookings', icon: BookOpenCheck },
  { to: '/admin/classes', label: 'Classes', icon: Users },
  { to: '/admin/stripe', label: 'Payments', icon: CreditCard },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
  { to: '/wizard', label: 'Setup wizard', icon: Wand2 },
];

const MEMBER_NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/book', label: 'Book', icon: CalendarDays },
  { to: '/classes', label: 'Classes', icon: Users },
  { to: '/plans', label: 'Plans', icon: Ticket },
];

export default function AppShell() {
  const { me } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setDrawerOpen(false), [pathname]);

  const nav = me.memberships.admin ? ADMIN_NAV : MEMBER_NAV;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-slate-200 bg-white md:flex">
        <SidebarContent nav={nav} />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 md:hidden">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"
        >
          <Menu size={20} />
        </button>
        <span className="font-semibold">{me.tenant.name}</span>
      </header>

      {/* Mobile drawer — z-50 so it overlays AdminCalendar's z-40 aside */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="relative flex w-64 flex-col bg-white shadow-xl">
            <SidebarContent nav={nav} onClose={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <main className="md:pl-60">
        <Outlet />
      </main>
    </div>
  );
}

function SidebarContent({ nav, onClose }) {
  const { me, logout } = useAuth();
  const first = me.user.first_name || '?';
  const roleLabel = me.memberships.admin ? me.memberships.admin.role : 'Member';

  return (
    <>
      {/* Tenant logo area */}
      <div className="flex h-14 items-center gap-2.5 border-b border-slate-200 px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
          {me.tenant.name.charAt(0).toUpperCase()}
        </div>
        <span className="truncate font-semibold">{me.tenant.name}</span>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="ml-auto rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {nav.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`
            }
          >
            <Icon size={18} className="shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* User section */}
      <div className="border-t border-slate-200 p-3">
        <div className="flex items-center gap-3 px-2 py-1.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-600">
            {first.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-slate-900">{first}</div>
            <div className="truncate text-xs capitalize text-slate-500">{roleLabel}</div>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            aria-label="Sign out"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </>
  );
}
