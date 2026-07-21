import { cn } from './cn.js';

const VARIANTS = {
  primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-500',
  secondary: 'bg-white text-slate-700 border border-slate-300 shadow-sm hover:bg-slate-50',
  danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-500',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
};

const SIZES = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
};

// `as` lets callers render a Link (or anchor) with button styling:
//   <Button as={Link} to="/book">Book</Button>
export default function Button({
  as: Component = 'button',
  variant = 'primary',
  size = 'md',
  className,
  ...props
}) {
  return (
    <Component
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
