import { cn } from './cn.js';

// text-base below md, text-sm above: iOS Safari auto-zooms the page
// when a focused control's font-size is under 16px, which wrecks the
// phone create-booking flow (modal edges off-screen, page stuck
// zoomed). 16px on phones prevents the zoom without touching the
// viewport meta (zoom suppression would hurt a11y).
const CONTROL =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base md:text-sm shadow-sm ' +
  'placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 ' +
  'disabled:bg-slate-50 disabled:text-slate-500';

export function Field({ label, hint, error, className, children }) {
  return (
    <label className={cn('block', className)}>
      {label && <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>}
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-rose-600">{error}</span>}
    </label>
  );
}

export function Input({ className, ...props }) {
  return <input className={cn(CONTROL, className)} {...props} />;
}

export function Select({ className, ...props }) {
  return <select className={cn(CONTROL, className)} {...props} />;
}

export function Textarea({ className, ...props }) {
  return <textarea className={cn(CONTROL, className)} {...props} />;
}
