// Step 2: pick a day (one tap on the strip), optionally a resource
// preference (defaults to "No preference", hidden when there's no
// real choice), then a time slot (one tap — advances directly).
// Purely presentational: the orchestrator owns fetching (useSlots)
// and URL state.

import { useState } from 'react';
import {
  formatNoSlotsReason,
  formatTimeLocal,
  formatTimezoneLabel,
} from '../../format.js';
import { ANY_RESOURCE } from '../../lib/availability.js';
import { dayStripDates, tenantLocalDate } from '../../lib/walkinParams.js';
import { Card, Field, Input, cn } from '../../components/ui/index.js';

function DayStrip({ tz, date, maxAdvanceDays, onChange }) {
  const [showPicker, setShowPicker] = useState(false);
  const days = dayStripDates(tz, maxAdvanceDays);
  const today = days[0];
  const inStrip = days.includes(date);

  // "Sat 1" from YYYY-MM-DD without timezone surprises: noon UTC on
  // that calendar date renders the same weekday in any zone.
  const chipLabel = (d) => {
    if (d === today) return 'Today';
    const dt = new Date(`${d}T12:00:00Z`);
    return dt.toLocaleDateString('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
    });
  };

  return (
    <div>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {days.slice(0, 14).map((d) => (
          <button
            key={d}
            type="button"
            data-testid="day-chip"
            onClick={() => onChange(d)}
            className={cn(
              'min-h-[44px] shrink-0 rounded-lg border px-3.5 py-2 text-sm transition',
              date === d
                ? 'border-brand-600 bg-brand-600 font-medium text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:border-brand-600',
            )}
          >
            {chipLabel(d)}
          </button>
        ))}
        {days.length > 14 && (
          <button
            type="button"
            onClick={() => setShowPicker((v) => !v)}
            className={cn(
              'min-h-[44px] shrink-0 rounded-lg border px-3.5 py-2 text-sm transition',
              showPicker || (!inStrip && date)
                ? 'border-brand-600 bg-brand-50 font-medium text-slate-900'
                : 'border-slate-300 bg-white text-slate-700 hover:border-brand-600',
            )}
          >
            More dates
          </button>
        )}
      </div>
      {(showPicker || (!inStrip && date)) && (
        <Field className="mt-2">
          <Input
            type="date"
            value={date}
            min={tenantLocalDate(tz)}
            max={days[days.length - 1]}
            onChange={(e) => e.target.value && onChange(e.target.value)}
            className="sm:max-w-xs"
          />
        </Field>
      )}
    </div>
  );
}

export default function TimeStep({
  tz,
  offering,
  date,
  resourceId,
  maxAdvanceDays,
  slotsState, // from useSlots
  selectedSlotStart,
  notice = null,
  onDateChange,
  onResourceChange,
  onSelectSlot,
}) {
  const { slots, reason, error, loading } = slotsState;
  const multiResource = offering.resources.length > 1;

  return (
    <div className="space-y-4">
      <Card title="Pick a day">
        <DayStrip
          tz={tz}
          date={date}
          maxAdvanceDays={maxAdvanceDays}
          onChange={onDateChange}
        />
      </Card>

      {multiResource && (
        <Card title={`Any preference? (${offering.resources.length} available)`}>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onResourceChange(ANY_RESOURCE)}
              className={cn(
                'min-h-[44px] rounded-lg border px-3.5 py-2 text-sm transition',
                resourceId === ANY_RESOURCE
                  ? 'border-brand-600 bg-brand-50 font-medium text-slate-900 ring-1 ring-brand-600'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300',
              )}
            >
              No preference
            </button>
            {offering.resources.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onResourceChange(r.id)}
                className={cn(
                  'min-h-[44px] rounded-lg border px-3.5 py-2 text-sm transition',
                  resourceId === r.id
                    ? 'border-brand-600 bg-brand-50 font-medium text-slate-900 ring-1 ring-brand-600'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300',
                )}
              >
                {r.name}
              </button>
            ))}
          </div>
        </Card>
      )}

      <Card title={`Open times (${formatTimezoneLabel(tz)})`}>
        {notice && (
          <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {notice}
          </p>
        )}
        {loading ? (
          <p className="text-sm text-slate-400">Checking open times…</p>
        ) : error ? (
          <p className="text-sm text-rose-700">{error}</p>
        ) : slots && slots.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing open this day — try the next one.
            {formatNoSlotsReason(reason) && (
              <span className="ml-1 text-slate-400">
                {formatNoSlotsReason(reason)}
              </span>
            )}
          </p>
        ) : slots ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {slots.map((s) => (
              <button
                key={s.start}
                type="button"
                data-testid="slot-button"
                onClick={() => onSelectSlot(s)}
                className={cn(
                  'min-h-[44px] rounded-lg border px-2 py-2 text-sm transition',
                  selectedSlotStart === s.start
                    ? 'border-brand-600 bg-brand-600 font-medium text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:border-brand-600 hover:bg-brand-50',
                )}
              >
                {formatTimeLocal(s.start, tz)}
              </button>
            ))}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
