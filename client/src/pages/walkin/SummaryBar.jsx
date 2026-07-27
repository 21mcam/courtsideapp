// Fixed bottom order-summary bar for the walk-in + manage flows.
//
// THE OCCLUSION RULE (from the funnel audit of the flow this
// replaces, where a fixed CTA permanently covered the bottom catalog
// rows and drove a −32% step drop): any fixed element must add equal
// compensating padding to the scroll container. Implementation: a
// ResizeObserver publishes this bar's REAL rendered height (content
// wrap, safe-area inset, font size — all included) to the
// --summary-bar-h CSS variable on <html>; the page's <main> pads
// bottom by that variable and html gets scroll-padding-bottom
// (index.css). Because the padding is driven by the same measurement,
// nothing can ever sit under the bar at max scroll. The variable
// resets to 0px on unmount.
//
// Layout: left column = what you're buying + the FINAL total (the
// same formatCents(dollar_price) string as the service row — one
// number, first screen to charge); right = the primary CTA.

import { useEffect, useRef } from 'react';

export default function SummaryBar({ line1, line2 = null, cta }) {
  const barRef = useRef(null);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return undefined;
    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty('--summary-bar-h', `${el.offsetHeight}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.setProperty('--summary-bar-h', '0px');
    };
  }, []);

  return (
    <div
      ref={barRef}
      data-testid="summary-bar"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-4px_12px_rgba(15,23,42,0.06)]"
    >
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900">
            {line1}
          </div>
          {line2 && (
            <div className="truncate text-xs text-slate-500">{line2}</div>
          )}
        </div>
        <div className="shrink-0">{cta}</div>
      </div>
    </div>
  );
}
