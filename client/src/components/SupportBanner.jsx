// Shown on every screen while a platform operator is viewing this
// facility as its owner (read-only support session). The API refuses
// all changes in this mode; the banner is so nobody — including the
// operator — mistakes it for a real owner session.

import { Eye } from 'lucide-react';

import { useAuth } from '../auth.jsx';

export default function SupportBanner() {
  const { me, logout } = useAuth();
  const session = me?.support_session;
  if (!session) return null;

  const until = new Date(session.expires_at).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-full bg-amber-500 py-2 pl-4 pr-2 text-sm font-medium text-white shadow-lg"
      >
        <Eye size={16} />
        <span>
          Viewing as owner · read-only <span className="hidden sm:inline">· until {until}</span>
        </span>
        <button
          onClick={logout}
          className="rounded-full bg-white/20 px-3 py-1 text-xs font-semibold hover:bg-white/30"
        >
          End
        </button>
      </div>
    </div>
  );
}
