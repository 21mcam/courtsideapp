import { cn } from './cn.js';

const TONES = {
  neutral: 'bg-slate-50 text-slate-600 ring-slate-500/20',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  warning: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  danger: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  info: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  brand: 'bg-brand-50 text-brand-700 ring-brand-600/20',
};

export default function Badge({ tone = 'neutral', dot = false, className, children }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[tone] || TONES.neutral,
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
