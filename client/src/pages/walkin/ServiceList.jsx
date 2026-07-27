// Step 1: the sectioned service list. Scannable rows (name one line,
// duration + price right-aligned) grouped under human section headers
// from the category_display overlay; per-row chevron expands the
// description. Tapping the row selects and advances — one tap.
//
// The price on the row IS the price charged — every other surface
// (summary bar, CTA, details recap) renders the same
// formatCents(dollar_price) from the same offerings object. No fees
// exist anywhere in the flow.

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatCents } from '../../format.js';
import { buildSections } from '../../lib/walkinParams.js';
import { Card, cn } from '../../components/ui/index.js';

function ServiceRow({ offering, selected, onSelect }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li>
      <div
        className={cn(
          'flex items-stretch',
          selected && 'bg-brand-50',
        )}
      >
        <button
          type="button"
          data-testid="service-row"
          onClick={() => onSelect(offering)}
          className="flex min-h-[44px] min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
        >
          {/* Name gets the row width (one line at 390px); duration
              sits under it so long names don't fight the price. */}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-slate-900">
              {offering.name}
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              {offering.duration_minutes} min
            </span>
          </span>
          <span
            data-testid="service-price"
            className="shrink-0 whitespace-nowrap font-semibold text-slate-900"
          >
            {formatCents(offering.dollar_price)}
          </span>
        </button>
        {offering.description && (
          <button
            type="button"
            aria-label={`About ${offering.name}`}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="flex min-w-[44px] items-center justify-center px-2 text-slate-400 transition hover:text-slate-600"
          >
            <ChevronDown
              size={18}
              className={cn('transition-transform', expanded && 'rotate-180')}
            />
          </button>
        )}
      </div>
      {expanded && offering.description && (
        <p className="whitespace-pre-wrap px-4 pb-3 text-sm text-slate-500">
          {offering.description}
        </p>
      )}
    </li>
  );
}

export default function ServiceList({
  offerings,
  categories,
  selectedOfferingId,
  onSelect,
}) {
  if (offerings.length === 0) {
    return (
      <Card>
        <p className="text-sm text-slate-500">
          Online booking isn't available yet. Contact the front desk to
          book.
        </p>
      </Card>
    );
  }
  const sections = buildSections(offerings, categories);
  return (
    <div className="space-y-5">
      {sections.map((section) => (
        <section key={section.key}>
          <h2 className="mb-2 px-1 text-sm font-semibold text-slate-900">
            {section.label}
          </h2>
          <Card padded={false}>
            <ul className="divide-y divide-slate-100">
              {section.offerings.map((o) => (
                <ServiceRow
                  key={o.id}
                  offering={o}
                  selected={o.id === selectedOfferingId}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  );
}
