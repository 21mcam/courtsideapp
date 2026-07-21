import { cn } from './cn.js';

const WIDTHS = {
  narrow: 'max-w-2xl',
  default: 'max-w-5xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
};

// Standard page container inside the AppShell. Pages pick a width
// instead of hand-rolling `max-w-* mx-auto p-6` scaffolds.
export default function Page({ width = 'default', className, children }) {
  return (
    <div className={cn('mx-auto w-full p-4 sm:p-6 space-y-6', WIDTHS[width], className)}>
      {children}
    </div>
  );
}
