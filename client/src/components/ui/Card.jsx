import { cn } from './cn.js';

export default function Card({ title, actions, padded = true, className, children }) {
  return (
    <section
      className={cn(
        'rounded-xl border border-slate-200 bg-white shadow-card',
        padded && 'p-5',
        className,
      )}
    >
      {(title || actions) && (
        <div
          className={cn(
            'flex items-center justify-between gap-3',
            padded ? 'mb-4' : 'border-b border-slate-200 px-5 py-4',
          )}
        >
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
