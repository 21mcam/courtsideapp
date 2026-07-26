// Tab nav for the admin Settings area. Five sub-pages share the
// sidebar's single "Settings" entry:
//   /admin/settings            General (appearance, facility, email)
//   /admin/settings/hours      Operating hours per resource
//   /admin/settings/blackouts  Blackout windows
//   /admin/settings/policies   Booking policies (incl. waiver config)
//   /admin/settings/waivers    Waiver signature roster
//
// Rendered by each settings page under its PageHeader.

import { NavLink } from 'react-router-dom';
import { cn } from './ui/index.js';

const TABS = [
  { to: '/admin/settings', label: 'General', end: true },
  { to: '/admin/settings/hours', label: 'Operating hours' },
  { to: '/admin/settings/blackouts', label: 'Blackouts' },
  { to: '/admin/settings/policies', label: 'Policies' },
  { to: '/admin/settings/waivers', label: 'Waivers' },
  { to: '/admin/settings/billing', label: 'Billing' },
];

export default function SettingsNav() {
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-slate-200">
      {TABS.map(({ to, label, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
            )
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
